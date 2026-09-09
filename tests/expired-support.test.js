'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { supportAccess, parseSupportDays, initSupportSchema } = require('../lib_expired_support');
const { createHash } = require('node:crypto');
let Database;
try { Database = require('node:sqlite').DatabaseSync; } catch { Database = require('better-sqlite3'); }
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name); return source.slice(start, source.indexOf('\n}', start) + 2);
}
const DAY = 86400000, now = Date.now(), client = { id: 1, enabled: 1, expiry_time: now - DAY };
test('support is invisible before expiry, available for 7 days and expires exactly at deadline', () => {
  assert.equal(supportAccess({ ...client, expiry_time: now + DAY }, null, 7, now).active, false);
  assert.equal(supportAccess(client, null, 7, now).active, true);
  assert.equal(supportAccess(client, null, 7, client.expiry_time + 7 * DAY).active, false);
  assert.equal(supportAccess({ ...client, expiry_time: 0 }, null, 7, now).active, false);
});
test('disabled and activation-pending clients never get support, including unlimited grants', () => {
  for (const c of [{ ...client, enabled: 0 }, { ...client, start_on_activation: 1, activation_started_at: 0 }]) {
    assert.equal(supportAccess(c, { days: 0 }, 7, now).active, false);
  }
});
test('per-node custom and unlimited grants remain independent', () => {
  assert.equal(supportAccess(client, { days: 30, base_expiry: client.expiry_time, until_ms: now + 30 * DAY }, 3, now + 10 * DAY).active, true);
  assert.equal(supportAccess(client, null, 3, now + 10 * DAY).active, false);
  assert.equal(supportAccess(client, { days: 0 }, 3, now + 10000 * DAY).active, true);
});
test('renewed main subscription hides support; next expiry uses individual duration, not old renewal deadline', () => {
  const grant = { days: 30, base_expiry: client.expiry_time, until_ms: now + 30 * DAY };
  const renewed = { ...client, expiry_time: now + 100 * DAY };
  assert.equal(supportAccess(renewed, grant, 7, now).active, false);
  assert.equal(supportAccess(renewed, grant, 7, now).expiryTime, renewed.expiry_time + 30 * DAY);
});
test('day input is strict and unlimited requires explicit selection', () => {
  for (const value of ['0', '-1', 'NaN', '1.5', '9999999', '']) assert.throws(() => parseSupportDays('custom', value, 7));
  assert.equal(parseSupportDays('custom', '30', 7), 30);
  assert.equal(parseSupportDays('unlimited', '', 7), 0);
  assert.equal(parseSupportDays('reset', '', 7), null);
});
function harness(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  initSupportSchema(db); initSupportSchema(db);
  db.exec(`CREATE TABLE clients(id INTEGER PRIMARY KEY, enabled INTEGER, expiry_time INTEGER, uuid TEXT, login TEXT);
    CREATE TABLE nodes(id INTEGER PRIMARY KEY, enabled INTEGER, panel_url TEXT, panel_path TEXT, inbound_id INTEGER, node_type TEXT);
    CREATE TABLE client_nodes(id INTEGER PRIMARY KEY, client_id INTEGER, node_id INTEGER, subscription_policy_only INTEGER DEFAULT 0);
    INSERT INTO clients VALUES(1,1,${client.expiry_time},'id-1','one'),(2,1,${now+DAY},'id-2','two');
    INSERT INTO nodes VALUES(10,1,'https://panel.invalid','',1,'3xui'),(11,1,'https://panel.invalid','',2,'3xui');`);
  if (!db.transaction) db.transaction = fn => () => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  const calls = []; let fail = false;
  const ctx = vm.createContext({ db, createHash, supportAccess, parseSupportDays,
    getSubscriptionExpiredGraceDays: () => 7, getSubscriptionExpiredGraceNodeIds: () => [10,11],
    scheduleSupportReconcile: () => {}, validateSupportIsolation: () => {},
    ensureAggregatorClientOnNode: async (n,c,opts) => { if (fail) throw new Error('offline'); calls.push(opts); db.prepare('INSERT INTO client_nodes(client_id,node_id) VALUES(?,?)').run(c.id,n.id); },
    updateClientOnNode: async (n,m,c,opts) => { if (fail) throw new Error('offline'); calls.push(opts); }
  });
  for (const name of ['assignSupportDays','performSupportPairSync','getExpiredGraceState']) vm.runInContext(extract(name), ctx);
  return { db, ctx, calls, setFail: value => { fail = value; } };
}
test('bulk grant stores selected pairs only, survives reinitialization and never changes main expiry', t => {
  const h = harness(t);
  assert.equal(h.ctx.assignSupportDays([1], [10], 'custom', '30'), 1);
  initSupportSchema(h.db);
  const grant = h.db.prepare('SELECT * FROM client_support_grants').get();
  assert.equal(grant.days, 30); assert.equal(grant.client_id, 1); assert.equal(grant.node_id, 10);
  assert.equal(h.db.prepare('SELECT expiry_time FROM clients WHERE id=1').get().expiry_time, client.expiry_time);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM client_support_grants').get().n, 1);
  h.ctx.assignSupportDays([1], [10], 'reset'); assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM client_support_grants').get().n, 0);
  assert.throws(() => h.ctx.assignSupportDays([1], [999], 'unlimited'));
});
test('background creates disabled support for active clients and keeps durable failure for retry', async t => {
  const h = harness(t), node = h.db.prepare('SELECT * FROM nodes WHERE id=10').get();
  const active = h.db.prepare('SELECT * FROM clients WHERE id=2').get();
  await h.ctx.performSupportPairSync(node, active, true);
  assert.equal(h.calls[0].enabled, false);
  assert.equal(h.db.prepare('SELECT subscription_policy_only FROM client_nodes').get().subscription_policy_only, 1);
  h.setFail(true); const expired = h.db.prepare('SELECT * FROM clients WHERE id=1').get();
  await assert.rejects(h.ctx.performSupportPairSync(node, expired, true), /offline/);
  assert.equal(h.db.prepare('SELECT error FROM client_support_sync WHERE client_id=1').get().error, 'offline');
  h.setFail(false); await h.ctx.performSupportPairSync(node, expired, true);
  assert.equal(h.calls.at(-1).enabled, true);
  assert.equal(h.calls.at(-1).expiry_time, client.expiry_time + 7 * DAY);
  assert.equal(h.db.prepare('SELECT error FROM client_support_sync WHERE client_id=1').get().error, '');
});
test('unmarking a support node disables its remote mapping', async t => {
  const h = harness(t), n = h.db.prepare('SELECT * FROM nodes WHERE id=10').get(), c = h.db.prepare('SELECT * FROM clients WHERE id=1').get();
  await h.ctx.performSupportPairSync(n, c, true);
  await h.ctx.performSupportPairSync(n, c, false);
  assert.equal(h.calls.at(-1).enabled, false); assert.equal(h.calls.at(-1).node_enabled, false);
});

test('retired role does not disable a new ordinary mapping on the same Nexus node', async t => {
  const h = harness(t), n = h.db.prepare('SELECT * FROM nodes WHERE id=10').get(), c = h.db.prepare('SELECT * FROM clients WHERE id=1').get();
  h.db.prepare('INSERT INTO client_nodes(client_id,node_id,subscription_policy_only) VALUES(?,?,0)').run(c.id,n.id);
  await h.ctx.performSupportPairSync(n,c,false);
  assert.equal(h.calls.length,0);
});

test('support refuses shared panel identities even with different inbound, path, scheme casing or default port', t => {
  const h = harness(t);
  h.ctx.URL = URL;
  vm.runInContext(extract('validateSupportIsolation'),h.ctx);
  const n = h.db.prepare('SELECT * FROM nodes WHERE id=10').get();
  assert.throws(() => h.ctx.validateSupportIsolation(n), /отдельная панель/);
  assert.throws(() => h.ctx.validateSupportIsolation({...n,panel_url:'HTTPS://PANEL.INVALID:443/another-path'}), /отдельная панель/);
  assert.doesNotThrow(() => h.ctx.validateSupportIsolation({...n,panel_url:'https://support-panel.invalid'}));
  h.ctx.getSubscriptionExpiredGraceNodeIds = () => [];
  assert.doesNotThrow(() => h.ctx.validateSupportIsolation(n));
  assert.throws(() => h.ctx.validateSupportIsolation({...n,expired_support:true}), /отдельная панель/);
  h.db.prepare('UPDATE nodes SET enabled=0 WHERE id=11').run();
  assert.doesNotThrow(() => h.ctx.validateSupportIsolation({...n,expired_support:true}));
  h.db.prepare('INSERT INTO client_nodes(client_id,node_id) VALUES(1,11)').run();
  assert.throws(() => h.ctx.validateSupportIsolation({...n,expired_support:true}), /отдельная панель/);
});

test('provider guard ignores an ordinary enable request and uses current main state and support deadline', t => {
  const h = harness(t), n = h.db.prepare('SELECT * FROM nodes WHERE id=10').get();
  vm.runInContext(extract('supportOptionsForNode'),h.ctx);
  const active = h.db.prepare('SELECT * FROM clients WHERE id=2').get();
  const blocked = h.ctx.supportOptionsForNode(n, active, { enabled:true, expiry_time:0 });
  assert.equal(blocked.enabled,false);
  const expired = h.db.prepare('SELECT * FROM clients WHERE id=1').get();
  const allowed = h.ctx.supportOptionsForNode(n, expired, { enabled:false, traffic_gb:1 });
  assert.equal(allowed.enabled,true); assert.equal(allowed.traffic_gb,0);
  assert.equal(allowed.expiry_time,expired.expiry_time+7*DAY);
  h.db.prepare('UPDATE clients SET enabled=0 WHERE id=1').run();
  assert.equal(h.ctx.supportOptionsForNode(n,expired,{enabled:true}).enabled,false);
});
test('expired JSON cannot prepend normal auto-select profiles; empty successful support set cannot match every node', () => {
  assert.match(source, /const resultConfigs = isClientExpired\(client\) \? \[\]/);
  assert.match(extract('buildSubscriptionEntriesForRequest'), /grace\.active && readyGraceNodeIds\.length/);
});

test('real subscription policy returns notice first and support only; active subscription excludes reserved nodes', async t => {
  const h = harness(t), builds = [];
  Object.assign(h.ctx, {
    isClientActivationPending: () => false, isClientExpired: c => c.expiry_time > 0 && c.expiry_time <= Date.now(),
    registerSubscriptionDevice: () => ({ allowed: true }), applySubscriptionDeviceHeaders: () => {},
    isExpiredSubscriptionNoticeEnabled: () => true, getSubscriptionPolicyNodesByIds: ids => ids.map(id => h.db.prepare('SELECT * FROM nodes WHERE id=?').get(id)),
    syncSupportPair: async () => {}, enforceExpiredClientRemoteState: async () => {},
    buildSubscriptionNoticeEntry: type => ({ nodeType: 'notice', type }),
    buildSubscriptionEntries: async (c, offline, options) => { builds.push({ c, options }); return (options.onlyNodeIds || [99]).map(id => ({ nodeId: id })); },
    getSubscriptionReservedNodeIds: () => [10,11], normalizeSubscriptionPolicyNodeIds: v => v || [], uniqueList: v => [...new Set(v)]
  });
  vm.runInContext(extract('buildSubscriptionEntriesForRequest'), h.ctx);
  const expired = h.db.prepare('SELECT * FROM clients WHERE id=1').get();
  const result = await h.ctx.buildSubscriptionEntriesForRequest({ method: 'GET', get: () => '' }, {}, expired);
  assert.equal(result.entries[0].type, 'expired');
  assert.deepEqual(Array.from(result.entries.slice(1), e => e.nodeId), [10,11]);
  assert.equal(builds[0].c.traffic_gb, 0);
  assert.equal(expired.expiry_time, client.expiry_time);
  const active = h.db.prepare('SELECT * FROM clients WHERE id=2').get();
  await h.ctx.buildSubscriptionEntriesForRequest({ method: 'GET', get: () => '' }, {}, active);
  assert.deepEqual(Array.from(builds.at(-1).options.excludeNodeIds), [10,11]);
  h.ctx.syncSupportPair = async (n,c) => { h.db.prepare('INSERT OR REPLACE INTO client_support_sync(client_id,node_id,error) VALUES(?,?,?)').run(c.id,n.id,'offline'); };
  const failed = await h.ctx.buildSubscriptionEntriesForRequest({ method:'GET',get:()=>'' },{},expired);
  assert.equal(failed.entries.length,1); assert.equal(failed.entries[0].type,'expired');
});
test('support metadata removes old global traffic cap; unlimited omits expiry even if a finite support node exists', () => {
  const ctx = vm.createContext({ shouldSendSubscriptionUserInfo: () => true,
    buildSubscriptionUsageSummary: (entries,c) => ({ uploadBytes:0, downloadBytes:0, totalBytes:c.traffic_gb, expiryTimeMs:c.expiry_time || now }), toEpochSeconds:n=>Math.floor(n/1000) });
  vm.runInContext(extract('buildSubscriptionUserInfo'),ctx);
  const ordinary = { traffic_gb: 5, expiry_time: client.expiry_time };
  const unlimited = ctx.buildSubscriptionUserInfo([], ordinary, { expiryTime:-1 });
  assert.doesNotMatch(unlimited,/total=|expire=/);
  const finite = ctx.buildSubscriptionUserInfo([], ordinary, { expiryTime:now+DAY });
  assert.match(finite,/expire=/); assert.doesNotMatch(finite,/total=/);
  assert.equal(ordinary.traffic_gb,5);
});
