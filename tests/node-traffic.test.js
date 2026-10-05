'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {createNodeTraffic,dateRange,parseSeries}=require('../lib_node_traffic');
const GB=1024**3, today=new Date().toISOString().slice(0,10);
const uuids=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'];
function fixture(t,version='3.3.0'){
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE nodes(id INTEGER PRIMARY KEY,name TEXT,node_type TEXT,panel_url TEXT,remnawave_node_uuid TEXT,remnawave_internal_squad_uuid TEXT,sort_order INTEGER);
    CREATE TABLE clients(id INTEGER PRIMARY KEY,login TEXT,display_name TEXT,enabled INTEGER,traffic_gb REAL,expiry_time INTEGER,start_on_activation INTEGER,activation_started_at INTEGER,duration_days INTEGER);
    CREATE TABLE client_nodes(id INTEGER PRIMARY KEY,client_id INTEGER,node_id INTEGER,upload_bytes INTEGER,download_bytes INTEGER,used_bytes INTEGER,traffic_gb REAL,enabled INTEGER);
    INSERT INTO clients VALUES(1,'phone','My phone',1,0,0,0,0,30);`);
  const nodes=uuids.map((uuid,i)=>({id:i+1,name:i?'Финляндия':'Германия',node_type:'remnawave',panel_url:'https://panel.invalid',remnawave_node_uuid:uuid,remnawave_internal_squad_uuid:'squad-'+(i+1)}));
  for(const n of nodes){db.prepare('INSERT INTO nodes VALUES(?,?,?,?,?,?,?)').run(n.id,n.name,n.node_type,n.panel_url,n.remnawave_node_uuid,n.remnawave_internal_squad_uuid,n.id);db.prepare('INSERT INTO client_nodes VALUES(?,?,?,0,?,?,50,1)').run(n.id,1,n.id,32*GB,32*GB);}
  let counts=[30*GB,2*GB],broken=false,shared=false;
  const calls=[],writes=[],user={id:17,uuid:'20000000-0000-4000-8000-000000000017',activeInternalSquads:['squad-1','squad-2'],status:'ACTIVE',trafficLimitBytes:0,userTraffic:{usedTrafficBytes:32*GB}};
  const get=async(n,route)=>{
    calls.push(route);
    if(route==='/api/nodes')return {response:{nodes:uuids.map(uuid=>({uuid}))}};
    if(route==='/api/system/metadata')return {response:{version}};
    if(route.includes('/accessible-nodes'))return {response:{accessibleNodes:(shared?uuids:[uuids[n.id-1]]).map(uuid=>({uuid}))}};
    if(route.includes('/api/bandwidth-stats/users/17?')){const qs=new URL('https://panel.invalid'+route).searchParams;assert.equal(qs.get('topNodesLimit'),'2');return broken?{response:{usedTrafficBytes:99*GB}}:{response:{categories:[today],series:uuids.map((uuid,i)=>({uuid,data:[counts[i]]}))}};}
    throw new Error('Unexpected '+route);
  };
  const api=createNodeTraffic({db,get,patch:async(n,route,payload)=>{writes.push({...payload});Object.assign(user,payload);},getUser:async()=>({...user}),getIdentity:u=>u.uuid,baseUrl:u=>u,title:n=>n.name});
  const map=id=>db.prepare('SELECT * FROM client_nodes WHERE id=?').get(id);
  return {db,nodes,api,user,map,calls,writes,set counts(v){counts=v;},set broken(v){broken=v;},set shared(v){shared=v;},sync:async id=>api.syncMapping(nodes[id-1],user,map(id),{force:true})};
}
for(const version of ['3.3.0','3.4.4','future-compatible'])test(`node series ${version}: Germany 30, Finland 2, not shared 32`,async t=>{
  const f=fixture(t,version);await f.sync(1);await f.sync(2);
  assert.equal(f.map(1).used_bytes,30*GB);assert.equal(f.map(2).used_bytes,2*GB);assert.equal(f.writes.length,0);
  const report=f.api.report(dateRange(today,today));assert.equal(report[0].totalBytes,30*GB);assert.equal(report[1].totalBytes,2*GB);assert.equal(report[0].clients[0].api_version,version);
});
test('reset only Germany; Finland and 32 GB native account untouched; historical range preserved',async t=>{
  const f=fixture(t);await f.sync(1);await f.sync(2);await f.api.resetMapping(f.nodes[0],f.user,f.map(1));
  assert.equal(f.map(1).used_bytes,0);assert.equal(f.map(2).used_bytes,2*GB);assert.equal(f.user.userTraffic.usedTrafficBytes,32*GB);
  assert.equal(f.api.report(dateRange(today,today))[0].totalBytes,30*GB);
  f.counts=[31*GB,3*GB];await f.sync(1);await f.sync(2);await f.sync(1);
  assert.equal(f.map(1).used_bytes,GB);assert.equal(f.map(2).used_bytes,3*GB);assert.equal(f.api.total(1,1),31*GB);
});
test('exhausted exclusive squad removed; reset restores only that squad, no native node quota',async t=>{
  const f=fixture(t);f.db.prepare('UPDATE client_nodes SET traffic_gb=5 WHERE id=1').run();await f.sync(1);
  assert.deepEqual(f.user.activeInternalSquads,['squad-2']);assert.equal(f.user.trafficLimitBytes,0);assert.equal(f.api.state(1,1).blocked,1);
  await f.api.resetMapping(f.nodes[0],f.user,f.map(1));assert.deepEqual(f.user.activeInternalSquads,['squad-2','squad-1']);assert.equal(f.api.state(1,1).blocked,0);
});
test('shared squad never disables another node; scoped statistics still saved with warning',async t=>{
  const f=fixture(t);f.shared=true;f.db.prepare('UPDATE client_nodes SET traffic_gb=5 WHERE id=1').run();
  await assert.rejects(f.sync(1),/Общий сквад не отключён/);assert.equal(f.map(1).used_bytes,30*GB);assert.equal(f.writes.length,0);assert.match(f.api.state(1,1).error,/независимое/);
});
test('unsupported stats fail closed; known counts retained, no aggregate fallback or quota patch',async t=>{
  const f=fixture(t);await f.sync(1);f.broken=true;await assert.rejects(f.sync(1),/общий счётчик не используется/);
  assert.equal(f.map(1).used_bytes,30*GB);assert.equal(f.writes.length,0);await assert.rejects(f.api.resetMapping(f.nodes[0],f.user,f.map(1)));assert.equal(f.map(1).used_bytes,30*GB);
});
test('numeric stats ID required even when account UUID exists',async t=>{const f=fixture(t);delete f.user.id;await assert.rejects(f.sync(1),/числовой ID/);});
test('infer exactly one physical node from squad and save the binding',async t=>{const f=fixture(t);f.nodes[0].remnawave_node_uuid='';f.db.prepare("UPDATE nodes SET remnawave_node_uuid='' WHERE id=1").run();await f.sync(1);assert.equal(f.db.prepare('SELECT remnawave_node_uuid FROM nodes WHERE id=1').get().remnawave_node_uuid,uuids[0]);});
test('scope changes and duplicate physical node entries cannot mix history',async t=>{
  const f=fixture(t);await f.sync(1);f.nodes[0].remnawave_node_uuid=uuids[1];await assert.rejects(f.sync(1),/несколько раз/);
  f.db.prepare('DELETE FROM nodes WHERE id=2').run();await assert.rejects(f.sync(1),/Изменился источник/);assert.equal(f.map(1).used_bytes,30*GB);
});
test('migration archives known-bad aggregates only once',async t=>{
  const f=fixture(t);assert.equal(f.map(1).used_bytes,0);assert.equal(f.db.prepare('SELECT used_bytes FROM node_usage_legacy_archive WHERE node_id=1').get().used_bytes,32*GB);await f.sync(1);
  require('../lib_node_traffic').initNodeTrafficSchema(f.db);assert.equal(f.map(1).used_bytes,30*GB);
});
test('legacy node/client snapshots are recoverable; XUI and fresh snapshots are preserved',t=>{
  const f=fixture(t);f.db.exec(`CREATE TABLE client_traffic_snapshots(id INTEGER PRIMARY KEY,node_id INTEGER,client_id INTEGER,used_bytes INTEGER);
    CREATE TABLE node_traffic_snapshots(id INTEGER PRIMARY KEY,node_id INTEGER,used_bytes INTEGER);
    INSERT INTO nodes VALUES(3,'XUI','3xui','','','',3);
    INSERT INTO client_traffic_snapshots VALUES(1,1,1,100),(2,3,1,200);
    INSERT INTO node_traffic_snapshots VALUES(1,1,100),(2,3,200);
    DELETE FROM node_usage_meta WHERE key='legacy-snapshots-archived';`);
  require('../lib_node_traffic').initNodeTrafficSchema(f.db);
  for(const table of ['client_traffic_snapshots','node_traffic_snapshots']){
    assert.equal(f.db.prepare(`SELECT used_bytes FROM node_usage_legacy_${table}`).get().used_bytes,100);
    assert.equal(f.db.prepare(`SELECT used_bytes FROM ${table}`).get().used_bytes,200);
  }
  f.db.exec('INSERT INTO node_traffic_snapshots VALUES(3,1,30)');require('../lib_node_traffic').initNodeTrafficSchema(f.db);assert.equal(f.db.prepare('SELECT used_bytes FROM node_traffic_snapshots WHERE id=3').get().used_bytes,30);
});
test('active start-on-activation client can regain access after reset; pending client cannot',async t=>{
  const f=fixture(t);f.db.prepare('UPDATE clients SET start_on_activation=1,activation_started_at=? WHERE id=1').run(Date.now());f.db.prepare('UPDATE client_nodes SET traffic_gb=5 WHERE id=1').run();await f.sync(1);await f.api.resetMapping(f.nodes[0],f.user,f.map(1));assert.ok(f.user.activeInternalSquads.includes('squad-1'));
  f.db.prepare('UPDATE clients SET activation_started_at=0 WHERE id=1').run();await f.sync(1);assert.ok(!f.user.activeInternalSquads.includes('squad-1'));
});
test('XUI delta ledger survives native reset without erasing prior day traffic',t=>{
  const f=fixture(t);f.api.recordCounter(1,2,{usedBytes:100});f.api.recordCounter(1,2,{usedBytes:180});f.api.recordCounter(1,2,{usedBytes:0});f.api.recordCounter(1,2,{usedBytes:20});assert.equal(f.api.total(1,2),100);
});
test('date validation, invalid bytes, category/series shape and absent zero series',()=>{
  for(const pair of [['2026-02-30',today],[today,'2999-01-01'],['2020-01-01',today],[today,'2020-01-01']])assert.throws(()=>dateRange(...pair));
  assert.throws(()=>parseSeries({categories:[today],series:[{uuid:uuids[0],data:[-1]}]},uuids[0]));
  assert.throws(()=>parseSeries({categories:[today],series:[{uuid:uuids[0],data:[]}]},uuids[0]));
  assert.deepEqual(parseSeries({categories:[today],series:[]},uuids[0]),[{day:today,bytes:0}]);
});
