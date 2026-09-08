'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}
function harness({ user = { userTraffic: { usedTrafficBytes: 2 * 1024 ** 3 } }, fail = false, live = true } = {}) {
  const writes = []; let reads = 0;
  const ctx = vm.createContext({
    Number, String, Math, Object, console: { error() {} },
    FETCH_TIMEOUT_MS: 12000, SUBSCRIPTION_STATS_TIMEOUT_MS: 3500, NODE_TYPE_REMNAWAVE: 'remnawave',
    clampByteNumber: n => Math.floor(Math.max(0, Number(n) || 0)), toTotalGbBytes: n => n * 1024 ** 3,
    normalizeEpochMillis: n => Number(n) || 0,
    shouldRefreshSubscriptionUsage: () => live,
    getRemnawaveUserByUuid: async () => { reads++; if (fail) throw new Error('offline'); return user; },
    normalizeRemnawaveSubscriptionUrl: (node, url) => url,
    db: { prepare: () => ({ run: (...args) => writes.push(args) }) },
    getNodePublicName: () => 'Анти-глушилка',
    buildNodeLimitRemark: (name, info) => `${name} · ${info.usedBytes / 1024 ** 3}/${info.totalBytes / 1024 ** 3}`,
    fetchSubscriptionLines: async () => ['vless://synthetic@example.invalid:443'],
    parseRemnawaveShareCandidate: line => ({ line, remark: '' }),
    filterRemnawaveCandidatesByText: lines => lines,
    normalizeRemnawaveLinkMode: () => 'first', uniqueRemnawaveCandidates: lines => lines,
    normalizeRemnawaveRemarkMode: () => 'aggregator', relabelRemoteShareLink: (line, name) => `${line}#${name}`
  });
  for (const name of ['getRemnawaveUsedTrafficBytes', 'buildRemnawaveSubscriptionInfo', 'buildRemnawaveSubscriptionEntries']) vm.runInContext(extract(name), ctx);
  const row = { node_id: 24, node_enabled: 1, client_node_enabled: 1, client_node_id: 7, remote_uuid: 'remote-user', remote_sub_url: 'https://example.invalid/sub', used_bytes: Math.floor(0.3 * 1024 ** 3), client_node_traffic_gb: 50 };
  const client = { enabled: 1, expiry_time: 0 };
  return { row, writes, get reads() { return reads; }, run: () => ctx.buildRemnawaveSubscriptionEntries(row, client) };
}
test('saved subscription URL still refreshes current usage and the SAME response name', async () => {
  const h = harness(); const entries = await h.run();
  assert.equal(h.reads, 1); assert.equal(entries[0].subscriptionInfo.usedBytes, 2 * 1024 ** 3);
  assert.match(entries[0].nodeName, /2\/50$/); assert.equal(h.writes.length, 1);
  assert.equal(h.row.upload_bytes, 0); assert.equal(h.writes[0][1], 2 * 1024 ** 3);
});
test('remote reset to zero replaces nonzero cached traffic', async () => {
  const h = harness({ user: { userTraffic: { usedTrafficBytes: 0 } } });
  assert.equal((await h.run())[0].subscriptionInfo.usedBytes, 0);
});
test('API failure retains cached usage and still returns working links', async () => {
  const h = harness({ fail: true }); const entries = await h.run();
  assert.equal(entries.length, 1); assert.equal(entries[0].subscriptionInfo.usedBytes, h.row.used_bytes);
  assert.equal(h.writes.length, 0);
});
test('missing remote user retains saved URL and cached usage', async () => {
  const h = harness({ user: null }); assert.equal((await h.run()).length, 1); assert.equal(h.writes.length, 0);
});
test('live usage switch is respected; missing URL is still resolved', async () => {
  const h = harness({ live: false }); await h.run(); assert.equal(h.reads, 0);
  const missing = harness({ live: false, user: { subscriptionUrl: 'https://example.invalid/new', usedTrafficBytes: 42 } });
  missing.row.remote_sub_url = ''; await missing.run(); assert.equal(missing.reads, 1); assert.equal(missing.row.used_bytes, 42);
});
test('lifetime counter is not mistaken for quota-period usage', async () => {
  const h = harness({ user: { lifetimeUsedTrafficBytes: 900 * 1024 ** 3 } });
  assert.equal((await h.run())[0].subscriptionInfo.usedBytes, Math.floor(0.3 * 1024 ** 3));
});
