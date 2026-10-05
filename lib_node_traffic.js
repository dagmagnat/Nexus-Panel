'use strict';

// Remnawave 3.3.x and 3.4.x: node-scoped daily series, never userTraffic.
const DAY = 86400000;
const bytes = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > Number.MAX_SAFE_INTEGER) throw new Error('Некорректный счётчик трафика API.');
  return Math.floor(n);
};
const day = ms => new Date(ms).toISOString().slice(0, 10);
function dateRange(from, to, now = Date.now()) {
  from = String(from || day(now - 6 * DAY)); to = String(to || day(now));
  const parse = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && day(Date.parse(value + 'T00:00:00Z')) === value ? Date.parse(value + 'T00:00:00Z') : NaN;
  let start, end;
  try { start = parse(from); end = parse(to); } catch (_) { throw new Error('Некорректная календарная дата.'); }
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start >= 370 * DAY || end > Date.parse(day(now))) throw new Error('Выберите корректный период до 370 дней, без будущих дат.');
  return { from, to, start, end: end + DAY };
}
function parseSeries(data, uuid) {
  const root = data?.response ?? data;
  if (!root || !Array.isArray(root.categories) || !Array.isArray(root.series)) throw new Error('API Remnawave не вернул статистику по нодам; общий счётчик не используется.');
  if (!root.categories.length) throw new Error('API Remnawave вернул пустую историю; расход не подменён нулём.');
  if (new Set(root.categories).size !== root.categories.length) throw new Error('API вернул повторяющиеся даты.');
  const matches = root.series.filter(row => String(row.uuid).toLowerCase() === String(uuid).toLowerCase());
  if (matches.length > 1) throw new Error('API вернул повторяющуюся физическую ноду.');
  const row = matches[0];
  if (row && (!Array.isArray(row.data) || row.data.length !== root.categories.length)) throw new Error('Несовместимый формат дневной статистики Remnawave.');
  return root.categories.map((d, i) => {
    dateRange(d, d);
    return { day: d, bytes: row ? bytes(row.data[i]) : 0 };
  });
}

function initNodeTrafficSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_usage_daily (
      client_id INTEGER NOT NULL, node_id INTEGER NOT NULL, day TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
      PRIMARY KEY(client_id,node_id,day));
    CREATE TABLE IF NOT EXISTS node_usage_state (
      client_id INTEGER NOT NULL, node_id INTEGER NOT NULL, scope_key TEXT NOT NULL DEFAULT '',
      reset_base INTEGER NOT NULL DEFAULT 0, last_counter INTEGER,
      updated_at INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
      error TEXT NOT NULL DEFAULT '', PRIMARY KEY(client_id,node_id));
    CREATE INDEX IF NOT EXISTS idx_node_daily_range ON node_usage_daily(node_id,day,client_id);
    CREATE TABLE IF NOT EXISTS node_usage_legacy_archive (
      client_id INTEGER, node_id INTEGER, upload_bytes INTEGER, download_bytes INTEGER, used_bytes INTEGER,
      archived_at INTEGER, PRIMARY KEY(client_id,node_id));
    CREATE TABLE IF NOT EXISTS node_usage_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
  `);
  if (!db.prepare('PRAGMA table_info(node_usage_state)').all().some(c=>c.name==='api_version')) db.exec("ALTER TABLE node_usage_state ADD COLUMN api_version TEXT NOT NULL DEFAULT ''");
  // Archive the known-invalid panel-wide values once, not as historical usage.
  db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM node_usage_meta WHERE key='legacy-snapshots-archived'").get()) {
      for (const table of ['client_traffic_snapshots','node_traffic_snapshots']) {
        if (!db.prepare('SELECT 1 FROM sqlite_master WHERE type=\'table\' AND name=?').get(table)) continue;
        // Keep recoverable copies; old aggregate snapshots must not produce
        // a fake download spike when the first scoped value arrives.
        const archive='node_usage_legacy_'+table;
        db.exec(`CREATE TABLE IF NOT EXISTS ${archive} AS SELECT * FROM ${table} WHERE 0;
          INSERT INTO ${archive} SELECT * FROM ${table} WHERE node_id IN (SELECT id FROM nodes WHERE node_type='remnawave');
          DELETE FROM ${table} WHERE node_id IN (SELECT id FROM nodes WHERE node_type='remnawave');`);
      }
      db.prepare('INSERT INTO node_usage_meta VALUES(?,?)').run('legacy-snapshots-archived',String(Date.now()));
    }
    const rows = db.prepare(`SELECT cn.* FROM client_nodes cn JOIN nodes n ON n.id=cn.node_id
      WHERE n.node_type='remnawave' AND NOT EXISTS (SELECT 1 FROM node_usage_state s WHERE s.client_id=cn.client_id AND s.node_id=cn.node_id)`).all();
    for (const r of rows) {
      db.prepare('INSERT OR IGNORE INTO node_usage_legacy_archive VALUES(?,?,?,?,?,?)').run(r.client_id, r.node_id, r.upload_bytes || 0, r.download_bytes || 0, r.used_bytes || 0, Date.now());
      db.prepare(`INSERT INTO node_usage_state(client_id,node_id,error) VALUES(?,?,'Ожидается статистика физической ноды')`).run(r.client_id, r.node_id);
      db.prepare('UPDATE client_nodes SET upload_bytes=0,download_bytes=0,used_bytes=0 WHERE id=?').run(r.id);
    }
  })();
}

function createNodeTraffic({ db, get, patch, baseUrl, getUser, getIdentity, title = n => n.name }) {
  initNodeTrafficSchema(db);
  const cache = new Map(), locks = new Map();
  const total = (clientId, nodeId) => Number(db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM node_usage_daily WHERE client_id=? AND node_id=?').get(clientId,nodeId).n);
  const state = (c, n) => db.prepare('SELECT * FROM node_usage_state WHERE client_id=? AND node_id=?').get(c,n);
  function ensure(c,n) { db.prepare('INSERT OR IGNORE INTO node_usage_state(client_id,node_id) VALUES(?,?)').run(c,n); }
  function markError(c,n,error) { ensure(c,n);db.prepare('UPDATE node_usage_state SET error=? WHERE client_id=? AND node_id=?').run(String(error),c,n); }
  async function locked(key, fn) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(fn); locks.set(key,next);
    try { return await next; } finally { if (locks.get(key) === next) locks.delete(key); }
  }
  async function cached(key, fn, force = false) {
    const old = cache.get(key);
    if (old?.pending || (!force && old?.until > Date.now())) return old.promise;
    const entry = { pending:true, until:Date.now()+30000 };
    entry.promise = Promise.resolve().then(fn); cache.set(key,entry);
    try { return await entry.promise; } catch(e) { cache.delete(key); throw e; } finally { entry.pending=false; }
  }
  async function scope(node) {
    const base = baseUrl(node.panel_url);
    let uuid = String(node.remnawave_node_uuid || '').trim();
    if (!uuid) {
      const squad = String(node.remnawave_internal_squad_uuid || '');
      const data = await cached(`${base}|squad:${squad}`, () => get(node,`/api/internal-squads/${encodeURIComponent(squad)}/accessible-nodes`));
      const nodes = (data.response ?? data)?.accessibleNodes;
      if (!Array.isArray(nodes) || nodes.length !== 1) throw new Error('Выберите Remnawave Node UUID в настройках узла: сквад ведёт к нескольким нодам или привязка отсутствует.');
      uuid = String(nodes[0].uuid || '');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(uuid)) throw new Error('Некорректный Remnawave Node UUID.');
    const duplicates = db.prepare("SELECT id,panel_url,remnawave_node_uuid FROM nodes WHERE node_type='remnawave'").all();
    if (duplicates.some(n => Number(n.id)!==Number(node.id || node.node_id) && baseUrl(n.panel_url)===base && String(n.remnawave_node_uuid).toLowerCase()===uuid.toLowerCase())) throw new Error('Одна физическая нода добавлена в Nexus несколько раз. Её трафик нельзя разделить по CDN-методам: используйте одну запись узла.');
    if (!node.remnawave_node_uuid) db.prepare("UPDATE nodes SET remnawave_node_uuid=? WHERE id=? AND COALESCE(remnawave_node_uuid,'')=''").run(uuid,node.id);
    return `${base}|${uuid.toLowerCase()}`;
  }
  async function read(node, user, force = false) {
    const key = await scope(node), uuid = key.split('|').pop();
    const apiId = String(user?.id || '');
    if (!/^[1-9]\d*$/.test(apiId)) throw new Error('Remnawave не вернул числовой ID пользователя для node-scoped статистики.');
    const today = day(Date.now()), start = day(Date.now()-369*DAY), base = baseUrl(node.panel_url);
    const nodesData = await cached(`${base}|nodes`, () => get(node,'/api/nodes'));
    const root = nodesData.response ?? nodesData;
    const physicalNodes = Array.isArray(root) ? root : root?.nodes;
    if (!Array.isArray(physicalNodes)) throw new Error('API не вернул список физических нод.');
    if (!physicalNodes.some(n=>String(n.uuid).toLowerCase()===uuid)) throw new Error('Выбранная физическая нода отсутствует в Remnawave.');
    const response = await cached(`${base}|${apiId}|${today}|series`, async () => {
      const metadata = await cached(`${base}|metadata`, async () => {
        try { const d = await get(node,'/api/system/metadata'); return String((d.response ?? d)?.version || 'авто'); }
        catch (_) { return 'авто · проверка возможностей API'; }
      });
      const qs = new URLSearchParams({start,end:today,topNodesLimit:String(Math.max(physicalNodes.length,1))});
      return { data:await get(node,`/api/bandwidth-stats/users/${apiId}?${qs}`), version:metadata };
    }, force);
    return { key:key+'|user:'+apiId, rows:parseSeries(response.data,uuid), version:response.version };
  }
  function save(map, result) {
    db.transaction(() => {
      ensure(map.client_id,map.node_id);
      const old = state(map.client_id,map.node_id);
      if (old.scope_key && old.scope_key !== result.key) throw new Error('Изменился источник статистики. Создайте отдельный узел Nexus, чтобы не смешивать историю разных серверов.');
      const upsert = db.prepare(`INSERT INTO node_usage_daily(client_id,node_id,day,bytes,source) VALUES(?,?,?,?,?)
        ON CONFLICT(client_id,node_id,day) DO UPDATE SET bytes=excluded.bytes WHERE excluded.bytes>node_usage_daily.bytes`);
      for (const r of result.rows) upsert.run(map.client_id,map.node_id,r.day,r.bytes,'remnawave-node-series');
      db.prepare(`UPDATE node_usage_state SET scope_key=?,updated_at=?,api_version=?,error='' WHERE client_id=? AND node_id=?`).run(result.key,Date.now(),result.version,map.client_id,map.node_id);
      const used = Math.max(0,total(map.client_id,map.node_id)-old.reset_base);
      db.prepare('UPDATE client_nodes SET upload_bytes=0,download_bytes=?,used_bytes=? WHERE id=?').run(used,used,map.id);
    })();
    return db.prepare('SELECT * FROM client_nodes WHERE id=?').get(map.id);
  }
  async function reconcile(node, user, map) {
    const c = db.prepare('SELECT * FROM clients WHERE id=?').get(map.client_id);
    if (!c) return;
    const s = state(map.client_id,map.node_id);
    const limit = Math.max(0,Number(map.traffic_gb || 0))*1024**3;
    const exhausted = limit > 0 && Number(map.used_bytes)>=limit;
    const squad = String(node.remnawave_internal_squad_uuid || '');
    const base = baseUrl(node.panel_url);
    const siblings = db.prepare(`SELECT cn.*,n.remnawave_internal_squad_uuid,n.panel_url FROM client_nodes cn JOIN nodes n ON n.id=cn.node_id
      WHERE cn.client_id=? AND n.node_type='remnawave'`).all(c.id);
    const sharedSquad = siblings.some(r => Number(r.node_id)!==Number(map.node_id) && baseUrl(r.panel_url)===base && String(r.remnawave_internal_squad_uuid)===squad);
    const data = await cached(`${base}|squad:${squad}`, () => get(node,`/api/internal-squads/${encodeURIComponent(squad)}/accessible-nodes`));
    const accessible = (data.response ?? data)?.accessibleNodes;
    const physical = s.scope_key.split('|')[1];
    if ((limit > 0 || s.blocked) && (sharedSquad || !Array.isArray(accessible) || accessible.length!==1 || String(accessible[0].uuid).toLowerCase()!==physical)) {
      throw new Error('Расход раздельный, но независимое ограничение требует сквад, доступный только выбранной физической ноде. Общий сквад не отключён.');
    }
    const fresh = await getUser(node,getIdentity(user));
    if (!fresh) throw new Error('Пользователь исчез из Remnawave.');
    const currentSquads = (fresh.activeInternalSquads || []).map(x => String(x.uuid || x));
    const pending = Number(c.start_on_activation)===1 && Number(c.activation_started_at || 0)<=0 && Number(c.duration_days || 0)>0;
    const allowed = !exhausted && Number(node.enabled)!==0 && Number(map.enabled)!==0 && Number(c.enabled)!==0 && (!c.expiry_time || Number(c.expiry_time)>Date.now()) && !pending;
    const nextSquads = allowed ? [...new Set([...currentSquads,squad])] : currentSquads.filter(x=>x!==squad);
    // Only the account-wide Nexus allowance may be sent to the shared remote user.
    const globalLimit = Math.max(0,Number(c.traffic_gb || 0))*1024**3;
    const identity = getIdentity(fresh);
    const payload = {...(/^\d+$/.test(identity) ? {id:Number(identity)} : {uuid:identity}),trafficLimitBytes:globalLimit,trafficLimitStrategy:'NO_RESET'};
    if (limit > 0 || s.blocked) payload.activeInternalSquads=nextSquads;
    const remoteUsed = Number(fresh.userTraffic?.usedTrafficBytes ?? fresh.usedTrafficBytes ?? 0);
    if (fresh.status==='LIMITED' && (globalLimit===0 || remoteUsed<globalLimit) && Number(c.enabled)!==0 && !pending && (!c.expiry_time || Number(c.expiry_time)>Date.now())) payload.status='ACTIVE';
    if (Number(fresh.trafficLimitBytes)!==globalLimit || payload.status || (payload.activeInternalSquads && JSON.stringify(currentSquads)!==JSON.stringify(nextSquads))) await patch(node,'/api/users',payload);
    db.prepare('UPDATE node_usage_state SET blocked=? WHERE client_id=? AND node_id=?').run(exhausted ? 1 : 0,c.id,node.id);
  }
  async function syncMapping(node,user,map,{force=false}={}) {
    node = {...node,id:map.node_id};
    return locked(`${baseUrl(node.panel_url)}|${getIdentity(user)}`, async () => {
      try {
        const freshMap = save(map,await read(node,user,force));
        await reconcile(node,user,freshMap);
        return freshMap;
      } catch(e) {
        ensure(map.client_id,map.node_id);
        db.prepare('UPDATE node_usage_state SET error=? WHERE client_id=? AND node_id=?').run(String(e.message),map.client_id,map.node_id);
        throw e;
      }
    });
  }
  async function resetMapping(node,user,map,{resetNative}={}) {
    node = {...node,id:map.node_id};
    return locked(`${baseUrl(node.panel_url)}|${getIdentity(user)}`, async () => {
      save(map,await read(node,user,true));
      if (resetNative) await resetNative();
      db.transaction(() => {
        db.prepare('UPDATE node_usage_state SET reset_base=? WHERE client_id=? AND node_id=?').run(total(map.client_id,map.node_id),map.client_id,map.node_id);
        db.prepare('UPDATE client_nodes SET upload_bytes=0,download_bytes=0,used_bytes=0 WHERE id=?').run(map.id);
      })();
      try {
        await reconcile(node,user,{...map,used_bytes:0});
      } catch(e) {
        const warning = 'Счётчик Nexus обнулён, но доступ на узле не восстановлен: '+e.message;
        db.prepare('UPDATE node_usage_state SET error=? WHERE client_id=? AND node_id=?').run(warning,map.client_id,map.node_id);
        throw new Error(warning);
      }
    });
  }
  function recordCounter(c,n,usage) {
    const current = bytes(usage.usedBytes || 0); ensure(c,n);
    db.transaction(() => {
      const s = state(c,n);
      if (s.last_counter!==null) {
        const delta = current>=s.last_counter ? current-s.last_counter : current;
        db.prepare(`INSERT INTO node_usage_daily VALUES(?,?,?,?,?) ON CONFLICT(client_id,node_id,day) DO UPDATE SET bytes=bytes+excluded.bytes`).run(c,n,day(Date.now()),delta,'xui-counter-delta');
      } else db.prepare('INSERT OR IGNORE INTO node_usage_daily VALUES(?,?,?,?,?)').run(c,n,day(Date.now()),0,'xui-counter-delta');
      db.prepare('UPDATE node_usage_state SET last_counter=?,updated_at=?,error=\'\' WHERE client_id=? AND node_id=?').run(current,Date.now(),c,n);
    })();
  }
  function report(range, nodeId = null) {
    const nodes = db.prepare('SELECT * FROM nodes ORDER BY COALESCE(sort_order,id),id').all().filter(n=>!nodeId || n.id===nodeId);
    return nodes.map(node => {
      const rows = db.prepare(`SELECT c.id,c.login,c.display_name,cn.used_bytes,cn.traffic_gb,cn.enabled,
        s.updated_at,s.error,s.blocked,s.api_version,MIN(d.day) AS first_day,
        COALESCE(SUM(CASE WHEN d.day>=? AND d.day<=? THEN d.bytes ELSE 0 END),0) AS period_bytes,
        COALESCE(SUM(d.bytes),0) AS observed_bytes
        FROM client_nodes cn JOIN clients c ON c.id=cn.client_id
        LEFT JOIN node_usage_state s ON s.client_id=c.id AND s.node_id=cn.node_id
        LEFT JOIN node_usage_daily d ON d.client_id=c.id AND d.node_id=cn.node_id
        WHERE cn.node_id=? GROUP BY c.id ORDER BY period_bytes DESC,c.id`).all(range.from,range.to,node.id);
      const physical = String(node.remnawave_node_uuid || '');
      // Never expose panel credentials through the reporting endpoint.
      return {id:node.id,name:title(node),node_type:node.node_type,physicalUuid:physical,clients:rows,totalBytes:rows.reduce((sum,r)=>sum+r.period_bytes,0),observedBytes:rows.reduce((sum,r)=>sum+r.observed_bytes,0)};
    });
  }
  return {scope,read,syncMapping,resetMapping,recordCounter,report,state,total,cache,markError};
}
module.exports = {DAY,bytes,dateRange,parseSeries,initNodeTrafficSchema,createNodeTraffic};
