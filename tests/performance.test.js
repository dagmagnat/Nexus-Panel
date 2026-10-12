'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { createAsyncReadCache, cooperativeMap } = require('../lib_performance');
const { createNodeTraffic, DAY } = require('../lib_node_traffic');

test('read cache single-flight, TTL from completion, retry and key isolation', async () => {
  let clock = 100, calls = 0, release;
  const cached = createAsyncReadCache({ ttlMs: 50, maxEntries: 2, now: () => clock });
  const load = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const a = cached('one', load), b = cached('one', load); assert.equal(a, b);
  await Promise.resolve(); clock = 1000; release('result'); assert.equal(await a, 'result');
  assert.equal(await cached('one', load), 'result'); assert.equal(calls, 1);
  assert.equal(await cached('two', () => 'other'), 'other');
  clock = 1051; assert.equal(await cached('one', () => 'new'), 'new');
  await assert.rejects(cached('broken', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await cached('broken', () => 'recovered'), 'recovered');
});

test('long local reports yield to other requests without changing order', async () => {
  let interrupted = false;
  setImmediate(() => { interrupted = true; });
  const values = await cooperativeMap(Array.from({length: 100}, (_, i) => i), i => {
    assert.ok(interrupted); return i * 2;
  });
  assert.deepEqual(values, Array.from({length: 100}, (_, i) => i * 2));
});

test('Remnawave bootstrap, incremental days, daily reconciliation, reset and failed API retain history', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  const uuid = '10000000-0000-4000-8000-000000000001';
  let clock = Date.now() - 5 * DAY;
  const date = ms => new Date(ms).toISOString().slice(0, 10);
  const oldDay = date(clock - 10 * DAY), today = date(clock);
  db.exec(`CREATE TABLE nodes(id INTEGER PRIMARY KEY,name TEXT,node_type TEXT,panel_url TEXT,remnawave_node_uuid TEXT,remnawave_internal_squad_uuid TEXT,sort_order INTEGER);
    CREATE TABLE clients(id INTEGER PRIMARY KEY,login TEXT,display_name TEXT,enabled INTEGER,traffic_gb REAL,expiry_time INTEGER,start_on_activation INTEGER,activation_started_at INTEGER,duration_days INTEGER);
    CREATE TABLE client_nodes(id INTEGER PRIMARY KEY,client_id INTEGER,node_id INTEGER,upload_bytes INTEGER,download_bytes INTEGER,used_bytes INTEGER,traffic_gb REAL,enabled INTEGER);
    INSERT INTO clients VALUES(1,'phone','Phone',1,0,0,0,0,0);
    INSERT INTO nodes VALUES(1,'Germany','remnawave','https://panel.invalid','${uuid}','squad',1);
    INSERT INTO client_nodes VALUES(1,1,1,0,0,0,0,1);`);
  const node = db.prepare('SELECT * FROM nodes').get(), user = { id: 17, status: 'ACTIVE', trafficLimitBytes: 0, activeInternalSquads: ['squad'] };
  const queries = []; let fail = false, oldCount = 100, newCount = 20;
  const api = createNodeTraffic({ db, now: () => clock, baseUrl: u => u, getIdentity: u => String(u.id), getUser: async () => user, patch: async () => {},
    get: async (_, route) => {
      if (route === '/api/nodes') return {nodes: [{uuid}]};
      if (route === '/api/system/metadata') return {version:'3.3.0'};
      if (route.includes('accessible-nodes')) return {accessibleNodes:[{uuid}]};
      const query = new URL('https://panel.invalid' + route).searchParams; queries.push(query);
      if (fail) throw new Error('API offline');
      const categories = [oldDay, today].filter(d => d >= query.get('start') && d <= query.get('end'));
      return {categories, series:[{uuid, data:categories.map(d => d === oldDay ? oldCount : newCount)}]};
    } });
  const map = () => db.prepare('SELECT * FROM client_nodes').get();
  await api.syncMapping(node, user, map()); assert.equal(map().used_bytes, 120);
  assert.equal(queries[0].get('start'), date(clock - 369 * DAY));
  const fullAt = api.state(1,1).full_synced_at;
  clock += 60000; newCount = 30;
  await api.syncMapping(node, user, map()); assert.equal(map().used_bytes, 130);
  assert.equal(queries.at(-1).get('start'), date(clock - 2 * DAY));
  assert.equal(api.state(1,1).full_synced_at, fullAt);
  // Explicit force and reset must refetch full history, not just recent days.
  oldCount = 150;
  await api.resetMapping(node, user, map()); assert.equal(map().used_bytes, 0);
  assert.equal(api.total(1,1), 180); assert.equal(queries.at(-1).get('start'), date(clock - 369 * DAY));
  clock += DAY + 1; oldCount = 170;
  await api.syncMapping(node, user, map()); assert.equal(map().used_bytes, 20);
  assert.equal(queries.at(-1).get('start'), date(clock - 369 * DAY));
  assert.ok(api.cache.size <= 5, 'expired per-day series must not accumulate forever');
  const checkpoint = api.state(1,1).full_synced_at; fail = true;
  await assert.rejects(api.syncMapping(node, user, map(), {force:true}), /offline/);
  assert.equal(map().used_bytes, 20); assert.equal(api.state(1,1).full_synced_at, checkpoint);
});

test('landing HTML never scans traffic history, polls nodes or writes snapshots', () => {
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const route = source.slice(source.indexOf("app.get('/dashboard',"), source.indexOf("app.get('/routing/geodata-index'"));
  for (const name of ['buildTopClientPeriodUsageReport(', 'buildTrafficReport(', 'buildLiveClientTrafficReport(', 'buildNodeTrafficReport(', 'recordTrafficSnapshot(', 'await getOnlineClientsForDashboard(']) assert.ok(!route.includes(name), name);
  assert.match(route, /deferred: true/);
  const login = source.slice(source.indexOf("app.post('/login',"), source.indexOf("app.post('/logout',"));
  assert.match(login, /await bcrypt.compare/); assert.doesNotMatch(login, /compareSync/);
});

test('cooperative top report keeps counter-reset and incomplete-baseline semantics', async t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE clients(id INTEGER,login TEXT,display_name TEXT,comment TEXT,enabled INTEGER);
    CREATE TABLE nodes(id INTEGER,name TEXT,node_type TEXT,country_code TEXT,country_name_ru TEXT,country_flag TEXT,label_suffix TEXT,sort_order INTEGER);
    CREATE TABLE client_nodes(client_id INTEGER,node_id INTEGER,upload_bytes INTEGER,download_bytes INTEGER,used_bytes INTEGER);
    CREATE TABLE client_traffic_snapshots(client_id INTEGER,node_id INTEGER,upload_bytes INTEGER,download_bytes INTEGER,used_bytes INTEGER,created_at_ms INTEGER);
    INSERT INTO clients VALUES(1,'one','One','',1),(2,'two','Two','',1);
    INSERT INTO nodes VALUES(1,'Node','3xui','','','','',1);
    INSERT INTO client_nodes VALUES(1,1,0,20,20),(2,1,0,10,10);`);
  const clock = Date.now(), start = clock - 7*DAY;
  const add = db.prepare('INSERT INTO client_traffic_snapshots VALUES(1,1,0,?,?,?)');
  add.run(100,100,start-1); add.run(150,150,start+1); add.run(0,0,start+2);
  const source = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
  const extract = name => { const i = source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m')); return source.slice(i,source.indexOf('\n}',i)+2); };
  const context = vm.createContext({ db, cooperativeMap, TOP_CLIENT_USAGE_PERIODS:{week:{days:7,label:'week'}}, Date:{now:()=>clock},
    clampByteNumber:n=>Math.max(0,Number(n)||0), formatTrafficBytes:String, getNodeDisplayName:n=>n.name, getNodeFlag:()=>'', nodeOrderSql:()=> 'n.id' });
  // Keep Date construction for the report timestamp, but fix Date.now.
  context.Date = class extends Date { static now() { return clock; } };
  vm.runInContext(extract('getTopClientUsagePeriod')+'\n'+extract('summarizeClientCounterSeries')+'\n'+extract('buildTopClientPeriodUsageReport'),context);
  const result = await context.buildTopClientPeriodUsageReport('week');
  assert.equal(result.rows[0].clientId,1); assert.equal(result.rows[0].usedBytes,70);
  assert.equal(result.rows[0].complete,true); assert.equal(result.rows[1].complete,false); assert.equal(result.rows[1].usedBytes,0);
});
