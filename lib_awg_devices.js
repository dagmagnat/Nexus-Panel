'use strict';
const {randomUUID}=require('node:crypto');
const awg=require('./lib_amneziawg');
function init(db) {
  db.exec([
    "CREATE TABLE IF NOT EXISTS awg_device_owners(client_id INTEGER,node_id INTEGER,context_json TEXT NOT NULL,legacy_email TEXT NOT NULL,legacy_uuid TEXT NOT NULL,detached INTEGER NOT NULL DEFAULT 0,base_bytes INTEGER NOT NULL DEFAULT 0,reset_bytes INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',PRIMARY KEY(client_id,node_id))",
    "CREATE TABLE IF NOT EXISTS awg_device_peers(id TEXT PRIMARY KEY,client_id INTEGER NOT NULL,node_id INTEGER NOT NULL,device_id INTEGER NOT NULL,slot INTEGER NOT NULL,email TEXT NOT NULL UNIQUE,uuid TEXT NOT NULL,context_json TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,removed INTEGER NOT NULL DEFAULT 0,up INTEGER NOT NULL DEFAULT 0,down INTEGER NOT NULL DEFAULT 0,raw_up INTEGER NOT NULL DEFAULT 0,raw_down INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',UNIQUE(client_id,node_id,device_id))",
    "CREATE TABLE IF NOT EXISTS awg_manual_links(device_id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL,token_hash TEXT NOT NULL UNIQUE,token_enc TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS awg_peers_node_active ON awg_device_peers(node_id,revoked,removed)",
    "CREATE INDEX IF NOT EXISTS awg_owners_node ON awg_device_owners(node_id)",
    "CREATE TRIGGER IF NOT EXISTS awg_revoke_device AFTER DELETE ON subscription_devices BEGIN UPDATE awg_device_peers SET revoked=1 WHERE client_id=OLD.client_id AND device_id=OLD.id; DELETE FROM awg_manual_links WHERE device_id=OLD.id AND client_id=OLD.client_id; END",
    "CREATE TRIGGER IF NOT EXISTS awg_revoke_mapping AFTER DELETE ON client_nodes BEGIN UPDATE awg_device_peers SET revoked=1 WHERE client_id=OLD.client_id AND node_id=OLD.node_id; END",
    "CREATE TRIGGER IF NOT EXISTS awg_revoke_client AFTER DELETE ON clients BEGIN UPDATE awg_device_peers SET revoked=1 WHERE client_id=OLD.id; END",
    "CREATE TRIGGER IF NOT EXISTS awg_revoke_node AFTER DELETE ON nodes BEGIN UPDATE awg_device_peers SET revoked=1 WHERE node_id=OLD.id; END"
  ].join(';'));
  db.exec("CREATE TRIGGER IF NOT EXISTS awg_reset_counter AFTER UPDATE OF used_bytes ON client_nodes WHEN NEW.used_bytes=0 AND OLD.used_bytes>0 BEGIN UPDATE awg_device_owners SET reset_bytes=base_bytes+COALESCE((SELECT SUM(up+down) FROM awg_device_peers WHERE client_id=NEW.client_id AND node_id=NEW.node_id),0) WHERE client_id=NEW.client_id AND node_id=NEW.node_id; END");
  if(!db.prepare('PRAGMA table_info(awg_device_peers)').all().some(c=>c.name==='applied_json'))db.exec("ALTER TABLE awg_device_peers ADD COLUMN applied_json TEXT NOT NULL DEFAULT ''");
}
function createManager({db,enabled,readInbound,add,update,remove,detachLegacy,restoreLegacy,usage,policy,onUsage=()=>{}}) {
  init(db);
  const locks=new Map();
  const flights=new Map();
  let sweeping=null;
  function lock(key,fn) {
    const prior=locks.get(key)||Promise.resolve();
    const work=prior.catch(()=>{}).then(fn);
    locks.set(key,work);
    work.finally(()=>{if(locks.get(key)===work)locks.delete(key);}).catch(()=>{});
    return work;
  }
  const peerFrom=(inbound,email)=> {
    const settings=typeof inbound.settings==='string'?JSON.parse(inbound.settings):inbound.settings;
    return settings?.clients?.find(p=>String(p.email||'').toLowerCase()===email.toLowerCase());
  };
  const networkIdentity=n=>JSON.stringify([n.panel_url,n.panel_path||'',n.api_connect_ip||'',n.inbound_id]);
  const peerEmail=(client,slot)=>'nxawg_'+(String(client.login||'client').replace(/[^A-Za-z0-9_-]/g,'_').slice(0,20)||'client')+'_d'+slot+'_'+randomUUID().replace(/-/g,'').slice(0,12);
  function total(clientId,nodeId) {
    const owner=db.prepare('SELECT * FROM awg_device_owners WHERE client_id=? AND node_id=?').get(clientId,nodeId);
    if(!owner)return null;
    const sum=db.prepare('SELECT COALESCE(SUM(up),0) up,COALESCE(SUM(down),0) down FROM awg_device_peers WHERE client_id=? AND node_id=?').get(clientId,nodeId);
    const used=Math.max(0,owner.base_bytes+sum.up+sum.down-owner.reset_bytes);
    return {uploadBytes:0,downloadBytes:used,usedBytes:used,totalRaw:owner.base_bytes+sum.up+sum.down};
  }
  function reset(clientId,nodeId) {
    const value=total(clientId,nodeId);
    if(value)db.prepare('UPDATE awg_device_owners SET reset_bytes=? WHERE client_id=? AND node_id=?').run(value.totalRaw,clientId,nodeId);
  }
  function observe(p,stat) {
    if(!stat)return;
    const up=Math.max(0,Number(stat.uploadBytes)||0),down=Math.max(0,Number(stat.downloadBytes)||0);
    // Monotonic local totals retain consumed bytes when remote counters reset.
    db.prepare('UPDATE awg_device_peers SET up=up+?,down=down+?,raw_up=?,raw_down=? WHERE id=?')
      .run(up>=p.raw_up?up-p.raw_up:up,down>=p.raw_down?down-p.raw_down:down,up,down,p.id);
  }
  async function collect(node,inbound) {
    const rows=db.prepare('SELECT * FROM awg_device_peers WHERE node_id=? AND removed=0').all(node.id);
    for(const p of rows) observe(p,await usage(node,p,inbound));
  }
  async function apply(node,p,state,inbound) {
    const signature=JSON.stringify(state),remote=peerFrom(inbound,p.email);
    const drift=remote && (remote.enable!==undefined && !!remote.enable!==!!state.enable ||
      remote.expiryTime!==undefined && Number(remote.expiryTime)!==Number(state.expiryTime) ||
      remote.totalGB!==undefined && Number(remote.totalGB)!==Number(state.totalGB));
    if(p.applied_json===signature && !drift)return;
    await update(node,p,state);
    db.prepare("UPDATE awg_device_peers SET applied_json=?,error='' WHERE id=?").run(signature,p.id);
  }
  function admitted(client,deviceId) {
    if(!client)return false;
    const device=db.prepare('SELECT id FROM subscription_devices WHERE client_id=? AND id=?').get(client.id,deviceId);
    if(!device)return false;
    const limit=Math.max(0,Number(client.device_limit)||0);
    const slot=db.prepare('SELECT COUNT(*) n FROM subscription_devices WHERE client_id=? AND id<=?').get(client.id,deviceId).n;
    return !limit || slot<=limit;
  }
  function share(client,nodeId,remaining) {
    const peers=db.prepare('SELECT device_id FROM awg_device_peers WHERE client_id=? AND node_id=? AND revoked=0 AND removed=0').all(client.id,nodeId);
    const count=peers.filter(p=>admitted(client,p.device_id)).length;
    return Math.floor(Math.max(0,remaining)/Math.max(1,count));
  }
  async function removePending(nodeId) {
    for(const p of db.prepare('SELECT * FROM awg_device_peers WHERE node_id=? AND revoked=1 AND removed=0').all(nodeId)) {
      try {
        let context=JSON.parse(p.context_json);
        const current=db.prepare('SELECT * FROM nodes WHERE id=?').get(p.node_id);
        if(current && networkIdentity(context)===networkIdentity(current))context=current;
        await remove(context,p);
        db.prepare("UPDATE awg_device_peers SET removed=1,error='' WHERE id=?").run(p.id);
      } catch(e) {
        db.prepare('UPDATE awg_device_peers SET error=? WHERE id=?').run(String(e.message||e).slice(0,400),p.id);
        throw Error('AWG: отзыв прежнего устройства ещё не подтверждён; повторите позже.');
      }
    }
  }
  async function prepare(node,client,map,inbound) {
    let owner=db.prepare('SELECT * FROM awg_device_owners WHERE client_id=? AND node_id=?').get(client.id,node.id);
    if(!owner) {
      db.prepare('INSERT INTO awg_device_owners(client_id,node_id,context_json,legacy_email,legacy_uuid,base_bytes) VALUES(?,?,?,?,?,?)')
        .run(client.id,node.id,JSON.stringify(node),map.remote_email||client.login,map.remote_uuid||client.uuid,Number(map.used_bytes)||0);
      owner=db.prepare('SELECT * FROM awg_device_owners WHERE client_id=? AND node_id=?').get(client.id,node.id);
    }
    // Context changes cannot silently strand working keys on the former server.
    if(owner.context_json!==JSON.stringify(node)) {
      const old=JSON.parse(owner.context_json);
      if(networkIdentity(old)!==networkIdentity(node)) {
        db.prepare('UPDATE awg_device_peers SET revoked=1 WHERE client_id=? AND node_id=? AND removed=0').run(client.id,node.id);
        await removePending(node.id);
        db.prepare('UPDATE awg_device_owners SET context_json=?,detached=0 WHERE client_id=? AND node_id=?').run(JSON.stringify(node),client.id,node.id);
        owner.detached=0;
      }
    }
    const legacyEmail=map.remote_email||client.login,legacyUuid=map.remote_uuid||client.uuid;
    if(owner.legacy_email!==legacyEmail || owner.legacy_uuid!==legacyUuid) {
      if(peerFrom(inbound,owner.legacy_email)) {await detachLegacy(node,owner);inbound=await readInbound(node);}
      if(peerFrom(inbound,owner.legacy_email))throw Error('AWG: прежняя общая привязка ещё не отозвана.');
      db.prepare('UPDATE awg_device_owners SET legacy_email=?,legacy_uuid=?,detached=0 WHERE client_id=? AND node_id=?').run(legacyEmail,legacyUuid,client.id,node.id);
      owner={...owner,legacy_email:legacyEmail,legacy_uuid:legacyUuid,detached:0};
    }
    if(!owner.detached || peerFrom(inbound,owner.legacy_email)) {
      await detachLegacy(node,owner);
      inbound=await readInbound(node);
      if(peerFrom(inbound,owner.legacy_email))throw Error('AWG: общий конфиг клиента не отозван; персональный пока не выдаётся.');
      db.prepare("UPDATE awg_device_owners SET detached=1,error='' WHERE client_id=? AND node_id=?").run(client.id,node.id);
    }
    return inbound;
  }
  async function syncNode(node) {
    await removePending(node.id);
    let inbound=await readInbound(node);
    if(!awg.isAmneziaWG(inbound))return inbound;
    await collect(node,inbound);
    const changes=[];
    for(const p of db.prepare('SELECT * FROM awg_device_peers WHERE node_id=? AND revoked=0 AND removed=0').all(node.id)) {
      if(!peerFrom(inbound,p.email))continue;
      const client=db.prepare('SELECT * FROM clients WHERE id=?').get(p.client_id);
      const map=db.prepare('SELECT * FROM client_nodes WHERE client_id=? AND node_id=?').get(p.client_id,node.id);
      if(!client || !map || !admitted(client,p.device_id) && !db.prepare('SELECT id FROM subscription_devices WHERE id=? AND client_id=?').get(p.device_id,p.client_id)) {
        db.prepare('UPDATE awg_device_peers SET revoked=1 WHERE id=?').run(p.id);continue;
      }
      const rule=policy(node,client,map),count=total(client.id,node.id);
      const budget=rule.limitBytes?share(client,node.id,rule.limitBytes-count.usedBytes):0;
      const enable=enabled() && rule.enabled && admitted(client,p.device_id) && (!rule.limitBytes || budget>0);
      const ownUsed=p.raw_up+p.raw_down;
      const state={enable,expiryTime:rule.expiryTimeMs||0,totalGB:rule.limitBytes?ownUsed+budget:0};
      const previous=peerFrom(inbound,p.email);
      changes.push({p,state,order:!enable?0:state.totalGB>0&&(!previous.totalGB||state.totalGB<Number(previous.totalGB))?1:2});
    }
    // Release budgets before assigning them elsewhere. Do not multiply a
    // client's whole quota by its number of independent remote peers.
    changes.sort((a,b)=>a.order-b.order);
    for(const change of changes)await apply(node,change.p,change.state,inbound);
    await removePending(node.id);
    for(const owner of db.prepare('SELECT * FROM awg_device_owners WHERE node_id=?').all(node.id)) {
      const count=total(owner.client_id,node.id);if(count)onUsage(owner.client_id,node.id,count);
    }
    return inbound;
  }
  async function ensureLocked(node,client,deviceId) {
    return lock(node.id,async()=>{
      await removePending(node.id);
      const current=db.prepare('SELECT * FROM clients WHERE id=?').get(client.id);
      const map=db.prepare('SELECT * FROM client_nodes WHERE client_id=? AND node_id=?').get(client.id,node.id);
      if(!enabled() || !current || !map || !admitted(current,deviceId))return null;
      const rule=policy(node,current,map);if(!rule.enabled)return null;
      let inbound=await readInbound(node);
      inbound=await prepare(node,current,map,inbound);
      await collect(node,inbound);
      const count=total(client.id,node.id);
      onUsage(client.id,node.id,count);
      if(rule.limitBytes && count.usedBytes>=rule.limitBytes) {await syncNode(node);return null;}
      let p=db.prepare('SELECT * FROM awg_device_peers WHERE client_id=? AND node_id=? AND device_id=?').get(client.id,node.id,deviceId);
      if(p?.revoked) {
        if(!p.removed)throw Error('AWG: прежний ключ ещё не отозван.');
        db.prepare("UPDATE awg_device_peers SET uuid=?,email=?,context_json=?,revoked=0,removed=0,raw_up=0,raw_down=0,applied_json='' WHERE id=?")
          .run(randomUUID(),peerEmail(current,p.slot),JSON.stringify(node),p.id);
        p=db.prepare('SELECT * FROM awg_device_peers WHERE id=?').get(p.id);
      }
      if(!p) {
        const id=randomUUID(),uuid=randomUUID();
        const priorSlot=db.prepare('SELECT slot FROM awg_device_peers WHERE client_id=? AND device_id=? LIMIT 1').get(client.id,deviceId);
        const slot=priorSlot?.slot || db.prepare('SELECT COALESCE(MAX(slot),0)+1 n FROM awg_device_peers WHERE client_id=?').get(client.id).n;
        const email=peerEmail(current,slot);
        db.prepare('INSERT INTO awg_device_peers(id,client_id,node_id,device_id,slot,email,uuid,context_json) VALUES(?,?,?,?,?,?,?,?)')
          .run(id,client.id,node.id,deviceId,slot,email,uuid,JSON.stringify(node));
        p=db.prepare('SELECT * FROM awg_device_peers WHERE id=?').get(id);
      }
      if(!peerFrom(inbound,p.email)) {
        await syncNode(node);
        const latest=total(client.id,node.id);
        if(rule.limitBytes && latest.usedBytes>=rule.limitBytes)return null;
        const budget=rule.limitBytes?share(current,node.id,rule.limitBytes-latest.usedBytes):0;
        if(rule.limitBytes && budget<=0)return null;
        await add(node,p,{enable:true,expiryTime:rule.expiryTimeMs||0,totalGB:budget});
        inbound=await readInbound(node);
      }
      if(!peerFrom(inbound,p.email))throw Error('AWG: API не вернул ключи персонального устройства.');
      const actual=peerFrom(inbound,p.email);
      const settings=typeof inbound.settings==='string'?JSON.parse(inbound.settings):inbound.settings;
      const ips=value=>(Array.isArray(value)?value:String(value||'').split(',')).map(s=>String(s).trim()).filter(Boolean);
      const duplicate=settings.clients.some(other=>other.email!==p.email &&
        (actual.privateKey && other.privateKey===actual.privateKey || ips(actual.allowedIPs).some(ip=>ips(other.allowedIPs).includes(ip))));
      if(duplicate) {
        db.prepare("UPDATE awg_device_peers SET revoked=1,error='API выдал повторяющиеся ключи или IP устройства' WHERE id=?").run(p.id);
        await removePending(node.id);
        throw Error('AWG: API выдал повторяющиеся ключи или IP устройства. Персональный конфиг не выдан.');
      }
      // The slot may have been revoked while the API request was in flight.
      if(!admitted(db.prepare('SELECT * FROM clients WHERE id=?').get(client.id),deviceId) ||
         db.prepare('SELECT revoked FROM awg_device_peers WHERE id=?').get(p.id)?.revoked) {
        db.prepare('UPDATE awg_device_peers SET revoked=1 WHERE id=?').run(p.id);
        await removePending(node.id);return null;
      }
      const finalClient=db.prepare('SELECT * FROM clients WHERE id=?').get(client.id);
      const finalMap=db.prepare('SELECT * FROM client_nodes WHERE client_id=? AND node_id=?').get(client.id,node.id);
      const finalRule=finalClient&&finalMap?policy(node,finalClient,finalMap):{enabled:false};
      const finalUsage=total(client.id,node.id);
      const finalBudget=finalRule.limitBytes?share(finalClient,node.id,finalRule.limitBytes-finalUsage.usedBytes):0;
      const finalEnabled=!!finalRule.enabled && (!finalRule.limitBytes || finalBudget>0);
      await apply(node,p,{enable:finalEnabled,expiryTime:finalRule.expiryTimeMs||0,totalGB:finalRule.limitBytes?p.raw_up+p.raw_down+finalBudget:0},inbound);
      if(!finalEnabled)return null;
      inbound=await readInbound(node);
      const lastClient=db.prepare('SELECT * FROM clients WHERE id=?').get(client.id);
      const lastMap=db.prepare('SELECT * FROM client_nodes WHERE client_id=? AND node_id=?').get(client.id,node.id);
      if(!lastClient || !lastMap || !admitted(lastClient,deviceId) ||
        db.prepare('SELECT revoked FROM awg_device_peers WHERE id=?').get(p.id)?.revoked) {
        db.prepare('UPDATE awg_device_peers SET revoked=1 WHERE id=?').run(p.id);
        await removePending(node.id);return null;
      }
      if(!policy(node,lastClient,lastMap).enabled) {await apply(node,p,{enable:false,expiryTime:lastClient.expiry_time||0,totalGB:0},inbound);return null;}
      return {inbound,peer:p,usage:count};
    });
  }
  function ensure(node,client,deviceId) {
    const key=[node.id,client.id,deviceId].join(':');
    if(flights.has(key))return flights.get(key);
    const promise=ensureLocked(node,client,deviceId).finally(()=>flights.delete(key));
    flights.set(key,promise);return promise;
  }
  async function sweep() {
    if(sweeping)return sweeping;
    sweeping=(async()=>{
      const ids=new Set(db.prepare('SELECT DISTINCT node_id FROM awg_device_peers WHERE removed=0 UNION SELECT node_id FROM awg_device_owners WHERE detached=1').all().map(r=>r.node_id));
      if(enabled())for(const node of db.prepare("SELECT * FROM nodes WHERE node_type='3xui'").all()) {
        const cached=db.prepare('SELECT inbound_json FROM node_inbound_cache WHERE node_id=?').get(node.id);
        if(cached && awg.isAmneziaWG(JSON.parse(cached.inbound_json)))ids.add(node.id);
      }
      const errors=[];
      for(const id of ids) try {await lock(id,async()=>{
        const node=db.prepare('SELECT * FROM nodes WHERE id=?').get(id);
        await removePending(id);
        if(!node)return;
        const inbound=await syncNode(node);
        if(enabled() && awg.isAmneziaWG(inbound))for(const map of db.prepare('SELECT * FROM client_nodes WHERE node_id=?').all(id)) {
          const client=db.prepare('SELECT * FROM clients WHERE id=?').get(map.client_id);
          if(client)await prepare(node,client,map,inbound);
        }
        if(!enabled())for(const owner of db.prepare('SELECT * FROM awg_device_owners WHERE node_id=? AND detached=1').all(id)) {
          const client=db.prepare('SELECT * FROM clients WHERE id=?').get(owner.client_id);
          const map=client && db.prepare('SELECT * FROM client_nodes WHERE client_id=? AND node_id=?').get(client.id,id);
          if(map) {
            const currentOwner={...owner,legacy_email:map.remote_email||client.login,legacy_uuid:map.remote_uuid||client.uuid};
            await restoreLegacy(node,currentOwner,client,map);
            db.prepare('UPDATE awg_device_owners SET detached=0,legacy_email=?,legacy_uuid=? WHERE client_id=? AND node_id=?').run(currentOwner.legacy_email,currentOwner.legacy_uuid,owner.client_id,id);
          }
        }
      });} catch(e) {errors.push({nodeId:id,error:String(e.message||e).slice(0,400)});}
      return errors;
    })().finally(()=>{sweeping=null;});
    return sweeping;
  }
  async function flush(clientId) {
    const errors=[];
    for(const row of db.prepare('SELECT DISTINCT node_id FROM awg_device_peers WHERE client_id=? AND revoked=1 AND removed=0').all(clientId))
      try {await lock(row.node_id,()=>removePending(row.node_id));} catch(e){errors.push(String(e.message||e));}
    return errors;
  }
  return {ensure,sweep,flush,total,reset,hasOwner:(clientId,nodeId)=>!!db.prepare('SELECT 1 FROM awg_device_owners WHERE client_id=? AND node_id=?').get(clientId,nodeId)};
}
module.exports={init,createManager};

