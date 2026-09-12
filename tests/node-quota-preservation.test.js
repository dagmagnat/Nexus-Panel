'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const source = fs.readFileSync(process.env.NEXUS_QUOTA_TEST_SOURCE || path.join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE client_nodes(id INTEGER PRIMARY KEY,client_id INTEGER,node_id INTEGER,
    remote_email TEXT,remote_uuid TEXT,remote_sub_url TEXT,traffic_gb REAL,limit_ip INTEGER,
    upload_bytes INTEGER,download_bytes INTEGER,used_bytes INTEGER,enabled INTEGER)`);
  const users = new Map(), writes = [];
  const ctx = vm.createContext({ db, console, Date, Number, String, Math, Object,
    FETCH_TIMEOUT_MS:1000, isClientActivationPending:() => false,
    requireRemnawaveSquadUuid:node => 'squad-'+node.id,
    normalizeRemnawaveUsername: name => name, remnawaveExpiryState:() => ({expired:false,iso:'2030-01-01T00:00:00.000Z'}),
    getRemnawaveUserSquadUuids:u => u?.activeInternalSquads || [], sameText:(a,b) => a===b,
    uniqueList:items => [...new Set(items)], toTotalGbBytes:gb => gb*1024**3,
    trafficGbFromRemoteValue:bytes => bytes/1024**3, isUuidText:() => true,
    buildRemnawaveUserIdentityPayload:u => ({uuid:u.uuid}),
    getRemnawaveUserByUuid:async node => users.get(node.id) || null,
    getRemnawaveUserByUsername:async node => users.get(node.id) || null,
    getRemnawaveUserRemoteId:u => typeof u === 'string' ? u : u?.uuid,
    getRemnawaveUsedTrafficBytes:() => 42, normalizeRemnawaveSubscriptionUrl:(node,url) => url,
    extractRemnawaveUser:data => data.response,
    remnawaveApiPost:async (node,url,payload) => {
      const user={...payload,uuid:'remote-'+node.id,subscriptionUrl:'https://example.invalid/sub/'+node.id};
      writes.push({node:node.id,payload:{...payload}}); users.set(node.id,user); return {response:user};
    },
    remnawaveApiPatch:async (node,url,payload) => {
      const user={...users.get(node.id),...payload}; writes.push({node:node.id,payload:{...payload}}); users.set(node.id,user); return {response:user};
    }
  });
  for(const name of ['getClientNodeEffectiveTrafficGb','buildRemnawaveUserPayload','ensureRemnawaveUserOnNode','updateRemnawaveUserOnNode']) vm.runInContext(extract(name),ctx);
  const client={id:1,login:'person',uuid:'client-uuid',traffic_gb:0,enabled:1,device_limit:2,expiry_time:0};
  const map = node => db.prepare('SELECT * FROM client_nodes WHERE node_id=?').get(node);
  return {ctx,client,users,writes,map,db};
}
test('Remnawave keeps per-node quotas after create, edit, sync and extend; explicit zero stays unlimited',async t => {
  const h=harness(t), limited={id:1}, unlimited={id:2};
  await h.ctx.ensureRemnawaveUserOnNode(limited,h.client,{traffic_gb:50});
  await h.ctx.ensureRemnawaveUserOnNode(unlimited,h.client,{traffic_gb:0});
  assert.equal(h.map(1).traffic_gb,50); assert.equal(h.map(2).traffic_gb,0);
  await h.ctx.ensureRemnawaveUserOnNode(limited,h.client);
  assert.equal(h.map(1).traffic_gb,50); assert.equal(h.users.get(1).trafficLimitBytes,50*1024**3);
  await h.ctx.updateRemnawaveUserOnNode(limited,h.map(1),h.client,{expiry_time:Date.now()+86400000});
  assert.equal(h.map(1).traffic_gb,50);
  h.client.traffic_gb=100;
  await h.ctx.updateRemnawaveUserOnNode(unlimited,h.map(2),h.client,{comment:'Comment only'});
  assert.equal(h.map(2).traffic_gb,0); assert.equal(h.users.get(2).trafficLimitBytes,0);
  await h.ctx.updateRemnawaveUserOnNode(limited,h.map(1),h.client,{traffic_gb:12.5});
  assert.equal(h.users.get(1).trafficLimitBytes,12.5*1024**3);
  await h.ctx.updateRemnawaveUserOnNode(limited,h.map(1),h.client,{traffic_gb:0});
  assert.equal(h.map(1).traffic_gb,0); assert.equal(h.users.get(1).trafficLimitBytes,0);
});
test('create-missing keeps existing Remnawave quota instead of saving a global default',async t => {
  const h=harness(t), node={id:1};
  await h.ctx.ensureRemnawaveUserOnNode(node,h.client,{traffic_gb:50});
  const count=h.writes.length;
  await h.ctx.ensureRemnawaveUserOnNode(node,h.client,{traffic_gb:0,skip_existing:true});
  assert.equal(h.writes.length,count); assert.equal(h.map(1).traffic_gb,50);
});
test('quota form preserves omitted values and distinguishes empty, zero and invalid input for all providers',() => {
  const ctx=vm.createContext({});
  for(const name of ['getClientNodeEffectiveTrafficGb','clientNodeTrafficGbFromForm','validateClientQuotaForm']) vm.runInContext(extract(name),ctx);
  const parse=ctx.clientNodeTrafficGbFromForm;
  assert.equal(parse(undefined,0,{traffic_gb:50}),50);
  assert.equal(parse(undefined,100,{traffic_gb:0}),0);
  assert.equal(parse('',100,{traffic_gb:50}),100);
  assert.equal(parse('0',100,{traffic_gb:50}),0);
  assert.equal(parse('12.5',0),12.5);
  for(const value of ['NaN','Infinity','-1', ['2','3'], '1e20']) assert.throws(()=>parse(value,0));
  assert.throws(()=>ctx.validateClientQuotaForm({node_traffic_gb_1:'bad'}));
  const view=fs.readFileSync(path.join(__dirname,'../views/clients.ejs'),'utf8');
  assert.ok(view.includes("row.traffic_gb ?? ''"));
});
test('info-template help lists exactly the variables supported by the renderer',() => {
  const supported=[...extract('buildHappInfoText').matchAll(/^    ([a-z_]+):/gm)].map(m=>m[1]).sort();
  const settings=fs.readFileSync(path.join(__dirname,'../views/settings.ejs'),'utf8');
  const start=settings.indexOf('<details class="happ-template-tokens">');
  const list=settings.slice(start,settings.indexOf('</details>',start));
  const listed=[...list.matchAll(/\['([a-z_]+)'/g)].map(m=>m[1]).sort();
  assert.equal(supported.length,11); assert.deepEqual(listed,supported);
  const ctx=vm.createContext({}); vm.runInContext(extract('renderTemplate'),ctx);
  assert.equal(ctx.renderTemplate('{login} {unknown}',{login:'demo'}),'demo {unknown}');
});
