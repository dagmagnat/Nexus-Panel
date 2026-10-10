'use strict';

const PAGE_SIZES = [20, 50, 100, 150, 200];
const SORTS = ['newest','oldest','name-asc','name-desc','expiring','expired','disabled','active','online','traffic-desc','traffic-asc','limited','exhausted'];
const normalize = value => String(value ?? '').toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const idFilter = value => value === 'none' ? 'none' : /^[1-9]\d*$/.test(String(value || '')) ? String(value) : '';

function directoryOptions(query = {}) {
  const rawSize = String(query.page_size || '');
  const size = rawSize === 'all' ? 'all' : PAGE_SIZES.includes(Number(rawSize)) ? Number(rawSize) : 20;
  const rawPage = Number(query.page);
  return { size, page: Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1,
    q: normalize(query.q).slice(0, 300), node: idFilter(query.node_id), group: idFilter(query.group_id), tag: idFilter(query.tag_id),
    sort: SORTS.includes(query.sort) ? query.sort : 'newest' };
}

function initClientDirectory(db) {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_directory_devices ON subscription_devices(client_id,last_seen_at);
    CREATE INDEX IF NOT EXISTS idx_directory_tags ON client_tag_assignments(client_id,tag_id);`);
  // SQLite's builtin LOWER is ASCII-only. Search must also handle Cyrillic/ё.
  db.function('directory_text', { deterministic: true }, normalize);
}

function queryClientDirectory(db, query = {}, { now = Date.now(), onlineIds = [] } = {}) {
  const options = directoryOptions(query), conditions = [], params = [];
  const where = (sql, ...values) => { conditions.push(sql); params.push(...values); };
  if (options.q) {
    const term = '%' + options.q.replace(/[\\%_]/g, '\\$&') + '%';
    where(`(directory_text(COALESCE(c.id,'') || ' ' || COALESCE(c.login,'') || ' ' || COALESCE(c.display_name,'') || ' ' || COALESCE(c.comment,'') || ' ' || COALESCE(c.uuid,'') || ' ' || COALESCE(c.sub_slug,'') || ' ' || COALESCE(cg.name,'')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM client_tag_assignments a JOIN client_tags t ON t.id=a.tag_id WHERE a.client_id=c.id AND directory_text(t.name) LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM subscription_devices d WHERE d.client_id=c.id AND directory_text(COALESCE(d.os_name,'') || ' ' || COALESCE(d.device_model,'') || ' ' || COALESCE(d.app_name,'') || ' ' || COALESCE(d.hwid_hint,'')) LIKE ? ESCAPE '\\'))`, term, term, term);
  }
  if (options.node && options.node !== 'none') where('EXISTS (SELECT 1 FROM client_nodes cn WHERE cn.client_id=c.id AND cn.node_id=?)', Number(options.node));
  if (options.group === 'none') where('c.group_id IS NULL');
  else if (options.group) where('c.group_id=?', Number(options.group));
  if (options.tag === 'none') where('NOT EXISTS (SELECT 1 FROM client_tag_assignments a WHERE a.client_id=c.id)');
  else if (options.tag) where('EXISTS (SELECT 1 FROM client_tag_assignments a WHERE a.client_id=c.id AND a.tag_id=?)', Number(options.tag));
  const pending = '(c.start_on_activation=1 AND COALESCE(c.activation_started_at,0)<=0 AND c.duration_days>0)';
  const expiry = `CASE WHEN ${pending} THEN 0 ELSE c.expiry_time END`;
  if (options.sort === 'disabled') where('c.enabled=0');
  if (options.sort === 'expired') where(`c.enabled<>0 AND ${expiry}>0 AND ${expiry}<=?`, now);
  if (options.sort === 'expiring') where(`c.enabled<>0 AND ${expiry}>? AND ${expiry}<=?`, now, now + 7*86400000);
  if (options.sort === 'active') where(`c.enabled<>0 AND (${expiry}=0 OR ${expiry}>?)`, now);
  if (options.sort === 'online') {
    // These IDs come from the same live online endpoint used by the page.
    const ids = [...new Set(onlineIds.map(Number).filter(Number.isSafeInteger))];
    where(ids.length ? 'c.id IN (SELECT value FROM json_each(?))' : '0', ...(ids.length ? [JSON.stringify(ids)] : []));
  }
  // Match the live usage-directory summary: a disabled mapping keeps its
  // spent quota visible and must not disappear from the exhausted filter.
  const enabledMappings = 'cn.client_id=c.id';
  const totalUsage = `(SELECT COALESCE(SUM(cn.used_bytes),0) FROM client_nodes cn WHERE ${enabledMappings})`;
  const scopedUsage = options.node && options.node !== 'none'
    ? `(SELECT COALESCE(SUM(cn.used_bytes),0) FROM client_nodes cn WHERE ${enabledMappings} AND cn.node_id=${Number(options.node)})` : totalUsage;
  const nodeClause = options.node && options.node !== 'none' ? ` AND cn.node_id=${Number(options.node)}` : '';
  const limited = `EXISTS (SELECT 1 FROM client_nodes cn WHERE ${enabledMappings}${nodeClause} AND cn.traffic_gb>0)`;
  const exhausted = `EXISTS (SELECT 1 FROM client_nodes cn WHERE ${enabledMappings}${nodeClause} AND cn.traffic_gb>0 AND cn.used_bytes>=cn.traffic_gb*1073741824)`;
  if (options.sort === 'limited') where(`(c.traffic_gb>0 OR ${limited})`);
  if (options.sort === 'exhausted') where(`((c.traffic_gb>0 AND ${totalUsage}>=c.traffic_gb*1073741824) OR ${exhausted})`);
  const from = 'FROM clients c LEFT JOIN client_groups cg ON cg.id=c.group_id';
  const filter = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
  const total = Number(db.prepare(`SELECT COUNT(*) AS n ${from}${filter}`).get(...params).n);
  const pages = options.size === 'all' ? 1 : Math.max(1, Math.ceil(total/options.size));
  const page = Math.min(options.page,pages), offset = options.size === 'all' ? 0 : (page-1)*options.size;
  const orders = { oldest:'c.id ASC', 'name-asc':"directory_text(COALESCE(NULLIF(c.display_name,''),c.login)) ASC,c.id DESC",
    'name-desc':"directory_text(COALESCE(NULLIF(c.display_name,''),c.login)) DESC,c.id DESC",
    expiring:`${expiry} ASC,c.id DESC`, expired:`${expiry} DESC,c.id DESC`,
    'traffic-desc':`${scopedUsage} DESC,c.id DESC`, 'traffic-asc':`${scopedUsage} ASC,c.id DESC` };
  const limit = options.size === 'all' ? '' : ' LIMIT ? OFFSET ?';
  const clients = db.prepare(`SELECT c.*,cg.name AS group_name,cg.color AS group_color,
    (SELECT cn.remote_sub_url FROM client_nodes cn WHERE cn.client_id=c.id AND cn.remote_sub_url LIKE 'http%' ORDER BY cn.id LIMIT 1) AS source_sub_url
    ${from}${filter} ORDER BY ${orders[options.sort] || 'c.id DESC'}${limit}`).all(...params,...(limit ? [options.size,offset] : []));
  const stats = db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN c.enabled=0 THEN 1 ELSE 0 END) AS disabled,
    SUM(CASE WHEN c.enabled<>0 AND ${expiry}>0 AND ${expiry}<=? THEN 1 ELSE 0 END) AS expired,
    SUM(CASE WHEN c.enabled<>0 AND ${expiry}>? AND ${expiry}<=? THEN 1 ELSE 0 END) AS expiring,
    SUM(CASE WHEN c.enabled<>0 AND (${expiry}=0 OR ${expiry}>?) THEN 1 ELSE 0 END) AS active FROM clients c`).get(now,now,now+7*86400000,now);
  return { clients, stats, pagination:{page,pages,size:options.size,total,from:total ? offset+1 : 0,to:offset+clients.length}, options };
}

module.exports = { PAGE_SIZES, directoryOptions, initClientDirectory, queryClientDirectory };
