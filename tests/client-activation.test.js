'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
// Real SQLite and real application functions, with only the network providers
// replaced. Node 22.13+ includes SQLite; older supported installations can use
// the project's better-sqlite3 dependency.
let Database;
try { Database = require('node:sqlite').DatabaseSync; } catch { Database = require('better-sqlite3'); }
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  return source.slice(start, end + 2);
}
function harness(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE clients (
    id INTEGER PRIMARY KEY, login TEXT, display_name TEXT, uuid TEXT, sub_slug TEXT,
    duration_days INTEGER DEFAULT 3, traffic_gb INTEGER DEFAULT 0, limit_ip INTEGER DEFAULT 0,
    device_limit INTEGER DEFAULT 1, expiry_time INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
    comment TEXT DEFAULT '', group_id INTEGER, last_online_at TEXT DEFAULT ''
  ); CREATE TABLE subscription_devices (
    id INTEGER PRIMARY KEY, client_id INTEGER, hwid_hash TEXT, hwid_hint TEXT,
    os_name TEXT, os_version TEXT, device_model TEXT, app_name TEXT, request_count INTEGER,
    first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP, last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(client_id, hwid_hash)
  ); CREATE TABLE client_nodes (id INTEGER PRIMARY KEY, client_id INTEGER, node_id INTEGER, enabled INTEGER DEFAULT 1);
  CREATE TABLE nodes (id INTEGER PRIMARY KEY); INSERT INTO nodes VALUES (1);`);
  if (!db.transaction) db.transaction = fn => (...args) => {
    db.exec('BEGIN'); try { const value = fn(...args); db.exec('COMMIT'); return value; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const calls = [];
  const ctx = vm.createContext({
    db, Date, console: { error() {} }, Buffer, ...crypto,
    addColumnIfMissing(table, name, type) {
      if (!db.prepare(`PRAGMA table_info(${table})`).all().some(r => r.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    },
    isSubscriptionDeviceTrackingEnabled: () => false,
    isSubscriptionDeviceLimitEnforced: () => true,
    isSubscriptionDeviceHwidRequired: () => false,
    getClientDeviceLimit: c => c.device_limit,
    getSubscriptionNoticeTitle: k => k,
    getSubscriptionReservedNodeIds: () => [], normalizeSubscriptionPolicyNodeIds: x => x,
    uniqueList: x => [...new Set(x)],
    buildSubscriptionEntries: async c => [{ line: `vless://${c.uuid}`, expiry: c.expiry_time }],
    updateClientOnNode: async (n, m, c, o) => { calls.push({ client: { ...c }, opts: o }); if (ctx.remoteFails) throw Error('offline'); },
    enforceExpiredClientRemoteState: async () => {}, isExpiredSubscriptionNoticeEnabled: () => false,
    remoteFails: false
  });
  const migrations = source.split('\n').filter(l => /addColumnIfMissing\('clients', '(start_on_activation|activation_started_at|activation_sync_pending)'/.test(l)).join('\n');
  vm.runInContext(migrations + '\n' + migrations, ctx); // also checks idempotence
  const names = ['normalizeEpochMillis', 'isClientExpiredAt', 'isClientExpired', 'isClientActivationPending',
    'expiryAfterActivationDays', 'expiryAtMidnightAfterDays', 'clientTermForEdit', 'countSubscriptionDevices',
    'sanitizeSubscriptionDeviceText', 'normalizeSubscriptionHwid', 'subscriptionDeviceHash', 'detectSubscriptionAppName',
    'getSubscriptionDeviceFromRequest', 'registerSubscriptionDevice', 'applySubscriptionDeviceHeaders',
    'buildSubscriptionNoticeEntry', 'activateClientOnFirstDevice', 'updateClientEverywhere', 'syncActivatedClient',
    'buildSubscriptionEntriesForRequest'];
  vm.runInContext('const activationSyncJobs = new Map();\n' + names.map(extract).join('\n'), ctx);
  db.prepare(`INSERT INTO clients (id, login, uuid, sub_slug, start_on_activation) VALUES (1, 'trial', 'test-uuid', 'trial', 1)`).run();
  db.prepare('INSERT INTO client_nodes (client_id, node_id) VALUES (1, 1)').run();
  const row = () => db.prepare('SELECT * FROM clients WHERE id = 1').get();
  const request = async (headers = {}, method = 'GET') => {
    const req = { method, get: name => headers[name.toLowerCase()] || '' };
    const res = { code: 200, setHeader() {}, status(n) { this.code = n; return this; } };
    const result = await ctx.buildSubscriptionEntriesForRequest(req, res, row());
    return { ...result, code: res.code };
  };
  return { db, ctx, row, request, calls };
}
const appHeaders = { 'x-hwid': 'device000000001', 'user-agent': 'Happ/1', accept: '*/*' };

test('browser, HEAD, missing/invalid HWID never consume the trial or a device slot', async t => {
  const h = harness(t);
  for (const [headers, method] of [[{}, 'GET'], [{ 'x-hwid': 'bad' }, 'GET'], [appHeaders, 'HEAD'], [{ ...appHeaders, accept: 'text/html' }, 'GET']]) {
    assert.equal((await h.request(headers, method)).accessState, 'activation-pending');
    assert.equal(h.row().activation_started_at, 0);
    assert.equal(h.row().expiry_time, 0);
    assert.equal(h.ctx.countSubscriptionDevices(1), 0);
  }
});
test('first registered device starts exactly 72 hours, concurrent refreshes and device reset do not restart it', async t => {
  const h = harness(t);
  const before = Date.now();
  await Promise.all([h.request(appHeaders), h.request(appHeaders)]);
  const activated = h.row();
  assert.ok(activated.activation_started_at >= before);
  assert.equal(activated.expiry_time - activated.activation_started_at, 72 * 3600000);
  assert.equal(h.ctx.countSubscriptionDevices(1), 1);
  assert.equal(h.calls[0].opts.expiry_time, activated.expiry_time);
  h.db.exec('DELETE FROM subscription_devices');
  await h.request(appHeaders);
  assert.equal(h.row().expiry_time, activated.expiry_time);
});
test('offline node returns retryable response; durable retry uses original deadline', async t => {
  const h = harness(t);
  h.ctx.remoteFails = true;
  assert.equal((await h.request(appHeaders)).code, 503);
  const expiry = h.row().expiry_time;
  assert.equal(h.row().activation_sync_pending, 1);
  h.ctx.remoteFails = false;
  assert.equal((await h.request(appHeaders)).code, 200);
  assert.equal(h.row().activation_sync_pending, 0);
  assert.equal(h.row().expiry_time, expiry);
  assert.equal(h.calls.at(-1).opts.expiry_time, expiry);
});
test('disabled clients and rejected device slots cannot start a trial', async t => {
  const h = harness(t);
  h.db.exec('UPDATE clients SET enabled = 0');
  await h.request(appHeaders);
  assert.equal(h.row().activation_started_at, 0);
  h.db.exec('UPDATE clients SET enabled = 1');
  h.ctx.registerSubscriptionDevice({ get: k => appHeaders[k] || '' }, h.row(), { forceTracking: true });
  await h.request({ ...appHeaders, 'x-hwid': 'device000000002' });
  assert.equal(h.row().activation_started_at, 0);
});
test('edit preserves waiting period, unchecking starts it, active trials cannot be rearmed', t => {
  const h = harness(t);
  const now = Date.now();
  const edit = body => h.ctx.clientTermForEdit(h.row(), body, 0, now);
  assert.equal(edit({ duration_days: '7' }).expiry, 0);
  assert.equal(edit({ duration_days: '7' }).days, 7);
  assert.equal(edit({ activation_option_present: '1' }).expiry, now + 3 * 86400000);
  assert.equal(edit({ duration_days: '0' }).startOnActivation, 0);
  assert.throws(() => edit({ duration_days: 'NaN' }));
  h.db.prepare('UPDATE clients SET activation_started_at = ?, expiry_time = ?').run(now, now + 3 * 86400000);
  assert.equal(edit({ activation_option_present: '1', start_on_activation: '1' }).expiry, now + 3 * 86400000);
  h.db.exec('UPDATE clients SET start_on_activation = 0');
  assert.throws(() => edit({ activation_option_present: '1', start_on_activation: '1' }));
});
test('provider entry points force pending credentials disabled even when called with enabled true', async t => {
  const h = harness(t);
  const provider = vm.createContext({
    supportOptionsForNode: (node, client, opts) => opts,
    isClientActivationPending: h.ctx.isClientActivationPending,
    isRemnawaveNode: () => true,
    ensureRemnawaveUserOnNode: async (n, c, opts) => opts,
    updateRemnawaveUserOnNode: async (n, m, c, opts) => opts
  });
  vm.runInContext(extract('ensureAggregatorClientOnNode') + '\n' + extract('updateClientOnNode'), provider);
  assert.equal((await provider.ensureAggregatorClientOnNode({}, h.row(), { enabled: true })).enabled, false);
  assert.equal((await provider.updateClientOnNode({}, {}, h.row(), { enabled: true })).enabled, false);
});

test('actual create form handler defaults to immediate expiry and saves checked trial without a deadline', async t => {
  const h = harness(t);
  let handler;
  Object.assign(h.ctx, {
    app: { post(route, auth, fn) { handler = fn; } }, requireAuth() {},
    collectRemoteLoginsForNodes: async () => ({ emails: [], records: [] }),
    findCaseInsensitiveClientOwner: () => null, normalizeClientGroupId: () => null,
    toTotalGbBytes: () => 0, replaceClientTags() {},
    ensureAggregatorClientOnNode: async (node, client, opts) => { h.calls.push({ client, opts }); }
  });
  const start = source.indexOf("app.post('/clients', requireAuth");
  vm.runInContext(['getClientNodeEffectiveTrafficGb', 'clientNodeTrafficGbFromForm', 'validateClientQuotaForm'].map(extract).join('\n'), h.ctx);
  vm.runInContext(source.slice(start, source.indexOf('\n});', start) + 4), h.ctx);
  for (const waiting of [false, true]) {
    let location;
    await handler({ body: { login: waiting ? 'waiting' : 'immediate', node_ids: ['1'], duration_days: '3', start_on_activation: waiting ? '1' : undefined } }, { redirect(url) { location = url; } });
    assert.ok(!location.includes('error='), decodeURIComponent(location));
    const saved = h.db.prepare('SELECT * FROM clients WHERE login = ?').get(waiting ? 'waiting' : 'immediate');
    assert.equal(saved.start_on_activation, waiting ? 1 : 0);
    assert.equal(saved.expiry_time === 0, waiting);
    assert.equal(h.calls.at(-1).opts.enabled, !waiting);
  }
});
