'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shareHost } = require('../lib_node_share_host');
const node = { panel_url: 'http://local-3xui:2053', id: 1 };
const env = { NEXUS_LOCAL_XUI_PUBLIC_HOST: '77.239.105.224' };

test('managed Docker API host never becomes the public VPN address', () => {
  assert.equal(shareHost(node, {}, env), '77.239.105.224');
  assert.equal(node.panel_url, 'http://local-3xui:2053');
  assert.throws(() => shareHost(node, {}, {}), /публичный VPN-адрес/);
});
test('explicit inbound sharing settings retain priority', () => {
  assert.equal(shareHost(node, { shareAddrStrategy: 'custom', shareAddr: 'vpn.example.com' }, env), 'vpn.example.com');
  assert.equal(shareHost(node, { shareAddrStrategy: 'listen', listen: '203.0.113.1' }, env), '203.0.113.1');
  assert.equal(shareHost(node, { shareAddrStrategy: 'listen', listen: '0.0.0.0' }, env), '77.239.105.224');
});
test('remote nodes remain independent of the local endpoint', () => {
  assert.equal(shareHost({ panel_url: 'https://remote.example.com:2053' }, {}, env), 'remote.example.com');
});
test('IPv6 share links are bracketed, malformed managed addresses rejected', () => {
  assert.equal(shareHost(node, {}, { NEXUS_LOCAL_XUI_PUBLIC_HOST: '2001:db8::1' }), '[2001:db8::1]');
  assert.throws(() => shareHost(node, {}, { NEXUS_LOCAL_XUI_PUBLIC_HOST: 'https://vpn.example.com/path' }), /без протокола/);
});
test('real VLESS builder uses public address and preserves inbound port and Reality', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
  const fn = source.split('function buildVlessRealityLink(')[1].split('\nfunction buildTrojanLink(')[0];
  const context = vm.createContext({ URL, URLSearchParams, Buffer,
    safeParseJsonField: value => typeof value === 'string' ? JSON.parse(value) : (value || {}),
    getInboundShareHost: (n, i) => shareHost(n, i, env),
    getRedirectReplacementHost: (_, host) => host,
    normalizeInboundNetwork: () => 'tcp', toClientLinkNetwork: () => 'tcp',
    getVlessEncryption: () => 'none', getEffectiveNodeSni: () => 'example.org',
    isH1Cloud3xuiNode: () => false, getClientFromInboundSettings: () => ({}),
    deriveRealitySpiderX: () => '',
    appendTransportQuery: () => {}, canUseVlessVision: () => true,
    buildHappServerDescription: () => '', getNodePublicName: () => 'Test'
  });
  vm.runInContext('function buildVlessRealityLink(' + fn, context);
  const inbound = { port: 28140, settings: { clients: [] }, streamSettings: { security: 'reality', realitySettings: { publicKey: 'public-key', shortIds: ['ab12'] } } };
  const link = new URL(context.buildVlessRealityLink(node, inbound, 'test-id', 'Test', 'Test'));
  assert.equal(link.hostname, '77.239.105.224');
  assert.equal(link.port, '28140');
  assert.equal(link.searchParams.get('security'), 'reality');
  assert.equal(link.searchParams.get('sni'), 'example.org');
});
