'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const usage = require('../public/js/client-usage');
const { nodeCloneValues } = require('../lib_node_clone');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
const GB = 1024 ** 3;
const sample = { limitGb: 0, nodes: [{ id: 1, name: 'A', limitGb: 5, usedBytes: 5 * GB, enabled: 0 }, { id: 2, name: 'B', limitGb: 10, usedBytes: GB }] };
test('exhausted includes a disabled mapping; one exhausted node is sufficient', () => {
  const s = usage.summarize(sample);
  assert.equal(s.exhausted, true); assert.equal(s.usedBytes, 6 * GB);
  assert.equal(s.exhaustedNodes.length, 1); assert.match(usage.text(s), /исчерпан/);
});
test('node filter scopes counters and exhausted flags', () => {
  const s = usage.summarize(sample, 2);
  assert.equal(s.exhausted, false); assert.equal(s.usedBytes, GB);
});
test('unlimited zero is not exhausted, zero reset clears exhausted', () => {
  assert.equal(usage.summarize({ nodes: [{ limitGb: 0, usedBytes: 10 * GB }] }).exhausted, false);
  assert.equal(usage.summarize({ nodes: [{ limitGb: 5, usedBytes: 0 }] }).exhausted, false);
});
test('global quota remains global under node filtering', () => {
  const s = usage.summarize({ ...sample, limitGb: 6 }, 2);
  assert.equal(s.globalExhausted, true); assert.equal(s.totalUsedBytes, 6 * GB);
  assert.equal(s.usedBytes, GB);
});
test('safe clone preserves connection credentials but not identities, cache or counters', () => {
  const source = { id: 1, name: 'A', node_type: 'remnawave', password_enc: 'encrypted', api_token_enc: 'encrypted-token', panel_url: 'https://example.invalid', inbound_id: 2, remnawave_internal_squad_uuid: 'squad', remnawave_node_uuid: 'physical', remnawave_host_uuid: 'host', source_sub_json_mux: 'old cache', used_bytes: 100, created_at: 'old', enabled: 1 };
  const copy = nodeCloneValues(source, 8);
  assert.equal(copy.enabled, 0); assert.equal(copy.sort_order, 8);
  assert.equal(copy.api_token_enc, source.api_token_enc); assert.equal(copy.inbound_id, 2);
  for (const key of ['id', 'remnawave_node_uuid', 'remnawave_host_uuid', 'created_at', 'used_bytes', 'source_sub_json_mux']) assert.equal(copy[key], undefined);
  assert.equal(source.enabled, 1);
});
test('Remnawave activity is fresh, node-scoped and supports old and new response shapes', () => {
  const ctx = vm.createContext({}); vm.runInContext(extract('isRemnawaveUserRecentlyOnline'), ctx);
  const now = Date.now(), node = { remnawave_node_uuid: 'a' };
  const fresh = { onlineAt: new Date(now - 30000).toISOString(), lastConnectedNodeUuid: 'a' };
  assert.equal(ctx.isRemnawaveUserRecentlyOnline({ userTraffic: fresh }, node, now), true);
  assert.equal(ctx.isRemnawaveUserRecentlyOnline(fresh, node, now), true);
  assert.equal(ctx.isRemnawaveUserRecentlyOnline({ userTraffic: fresh }, { remnawave_node_uuid: 'b' }, now), false);
  assert.equal(ctx.isRemnawaveUserRecentlyOnline({ onlineAt: new Date(now - 121000).toISOString() }, {}, now), false);
  assert.equal(ctx.isRemnawaveUserRecentlyOnline({}, {}, now), false);
});
test('autoselect probes ALL candidates through HTTPS and cannot fallback to dead first node', () => {
  const ctx = vm.createContext({ AUTO_SELECT_DEFAULT_PROBE_URL: 'https://example.invalid/generate_204', getRoutingConfig: () => ({ enabled: true }),
    buildHappJsonConfig: () => ({ outbounds: [{ tag: 'proxy', protocol: 'vless' }, { tag: 'proxy-2', protocol: 'vless' }, { tag: 'direct', protocol: 'freedom' }], routing: { rules: [{ outboundTag: 'proxy', network: 'tcp,udp' }, { outboundTag: 'direct', domain: ['local'] }] } }) });
  vm.runInContext(extract('autoSelectRuleForBalancer') + '\n' + extract('buildAutoSelectJsonConfig'), ctx);
  const c = ctx.buildAutoSelectJsonConfig({ id: 3, title: 'Auto', probeUrl: 'http://insecure.invalid', probeIntervalSeconds: 10 }, {}, [{ line: 'vless://a' }, { line: 'vless://b' }], 'Sub');
  assert.equal(c.routing.balancers[0].fallbackTag, 'auto-3-unavailable');
  assert.equal(c.outbounds.find(o => o.tag === 'auto-3-unavailable').protocol, 'blackhole');
  assert.equal(c.observatory.probeURL, 'https://example.invalid/generate_204');
  assert.equal(c.routing.rules[0].outboundTag, undefined);
  assert.equal(c.routing.rules[0].balancerTag, c.routing.balancers[0].tag);
  assert.equal(c.routing.rules[1].outboundTag, 'direct');
  assert.equal(c.autoSelect.candidates, 2);
});
test('usage refresh is single flight across clients and dashboard requests', async () => {
  let calls = 0, finish;
  const ctx = vm.createContext({ collectAllClientUsageFromNodes: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  vm.runInContext('let usageRefreshPending = null, usageRefreshFinishedAt = 0, usageRefreshErrors = [];\n' + extract('refreshAllClientUsageFromNodes'), ctx);
  const a = ctx.refreshAllClientUsageFromNodes(), b = ctx.refreshAllClientUsageFromNodes();
  assert.equal(a, b); assert.equal(calls, 1); finish({ errors: [] }); await a;
  const c = ctx.refreshAllClientUsageFromNodes(); assert.equal(calls, 2); finish({ errors: [] }); await c;
});
test('online lookup is constrained to node mappings and no longer uses display-name identity', () => {
  const fn = extract('getOnlineClientsForDashboard');
  assert.match(fn, /cn\.node_id = \?/); assert.doesNotMatch(fn, /LOWER\(c\.display_name\)/);
});

test('bulk refresh persists Remnawave reset and retains 3x-ui counters without fresh stats', async () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE nodes (id INTEGER, node_type TEXT, name TEXT);
      CREATE TABLE clients (id INTEGER, uuid TEXT, login TEXT);
      CREATE TABLE client_nodes (id INTEGER, client_id INTEGER, node_id INTEGER, remote_uuid TEXT, remote_email TEXT, remote_sub_url TEXT, used_bytes INTEGER, upload_bytes INTEGER, download_bytes INTEGER);
      INSERT INTO nodes VALUES (1, 'remnawave', 'Remna'), (2, '3xui', 'XUI');
      INSERT INTO clients VALUES (1, 'vless', 'user');
      INSERT INTO client_nodes VALUES (1,1,1,'remote','user','https://example.invalid',999,0,999),(2,1,2,'vless','user','',777,0,777);`);
    const ctx = vm.createContext({ db, nodeOrderSql: () => 'id', isRemnawaveNode: n => n.node_type === 'remnawave', isH1CloudNode: () => false,
      listRemnawaveUsers: async () => [{ uuid: 'remote', username: 'user', userTraffic: { usedTrafficBytes: 0 } }],
      getRemnawaveUserRemoteId: u => u.uuid, normalizeRemnawaveSubscriptionUrl: (n, url) => url,
      clampByteNumber: n => Math.max(0, Number(n) || 0), getNodePublicName: n => n.name,
      recordClientTrafficSnapshot: () => {}, getInbound: async () => ({ settings: '{}' }), getInboundClientTrafficsFromApi: async () => [],
      findClientStat: () => null, pickTrafficFromList: () => null, getCurrentTrafficTotals: () => ({}),
      runWithConcurrency: (items, limit, worker) => Promise.allSettled(items.map(worker)) });
    vm.runInContext(extract('getRemnawaveUsedTrafficBytes') + '\n' + extract('collectAllClientUsageFromNodes'), ctx);
    const result = await ctx.collectAllClientUsageFromNodes();
    assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE id=1').get().used_bytes, 0);
    assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE id=2').get().used_bytes, 777);
    assert.equal(result.errors.length, 1);
    ctx.listRemnawaveUsers = async () => { throw new Error('offline'); };
    db.exec('UPDATE client_nodes SET used_bytes=888 WHERE id=1');
    await ctx.collectAllClientUsageFromNodes();
    assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE id=1').get().used_bytes, 888);
  } finally { db.close(); }
});
