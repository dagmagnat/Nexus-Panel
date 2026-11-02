'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const awg = require('../lib_amneziawg');
const { validateLocalInboundPort } = require('../lib_local_inbound_port');
const key = n => Buffer.alloc(32, n).toString('base64');
function fixture() {
  return { id: 42, protocol: 'amneziawg', port: 51820, settings: {
    server: { publicKey: key(1), privateKey: key(2), primaryDns: '1.1.1.1', secondaryDns: '2606:4700:4700::1111',
      jc: 4, jmin: 40, jmax: 90, s1: 73, s2: 65, s3: 48, s4: 24,
      h1: '1-100', h2: '101-200', h3: '201-300', h4: '301-400', i1: '<r 48>', i5: '<b 0x1234>',
      headerProtectionKey: key(3), contentPaddingAddition: '16-52', rekeyAfterTime: '114-132',
      rekeyTimeout: '4-8', rejectAfterTime: '164-214', keepaliveTimeout: '8-15', maxHandshakeAttempts: '20-40',
      randomTrailers: true, disableCookies: true },
    clients: [{ id: 'uuid-a', email: 'alice', privateKey: key(4), publicKey: key(5), preSharedKey: key(6),
      allowedIPs: ['10.8.1.2/32', 'fd00::2/128'], keepAlive: '15-25', enable: true },
    { id: 'uuid-b', email: 'bob', privateKey: key(7), allowedIPs: ['10.8.1.3/32'], keepAlive: 0 }]
  } };
}
test('AWG 3.1 preserves inbound identity, ranges, DNS, IPv6, MTU and every obfuscation field', () => {
  const inbound = fixture();
  inbound.settings = JSON.stringify(inbound.settings);
  const name = '🇩🇪 Германия AWG';
  const line = awg.shareLink(inbound, 'global-uuid', 'ALICE', '2001:db8::1', 51820, name);
  const container = awg.jsonContainer({ line, nodeName: name });
  assert.equal(container.type, 'amneziawg');
  assert.equal(container.servers[0].name, name);
  const conf = Buffer.from(container.servers[0].config, 'base64url').toString();
  for (const text of [`PrivateKey = ${key(4)}`, `PublicKey = ${key(1)}`, `PresharedKey = ${key(6)}`,
    'Address = 10.8.1.2/32, fd00::2/128', 'MTU = 1396', 'DNS = 1.1.1.1, 2606:4700:4700::1111',
    'H1 = 1-100', 'I5 = <b 0x1234>', `HeaderProtectionKey = ${key(3)}`, 'ContentPaddingAddition = 16-52',
    'RekeyAfterTime = 114-132', 'RekeyTimeout = 4-8', 'RejectAfterTime = 164-214', 'KeepaliveTimeout = 8-15',
    'MaxHandshakeAttempts = 20-40', 'RandomTrailers = true', 'DisableCookies = true',
    'Endpoint = [2001:db8::1]:51820', 'PersistentKeepalive = 15-25', 'AllowedIPs = 0.0.0.0/0, ::/0']) assert.ok(conf.includes(text), text);
  assert.ok(!conf.includes(key(2)), 'server private key must never be exported');
  assert.ok(!conf.includes(key(7)), 'another peer must never be exported');
  assert.equal(decodeURIComponent(line.split('#')[1]), name);
});
test('missing identity and config injection fail closed; disabled peers are omitted', () => {
  const inbound = fixture();
  const conf = (email, host = 'vpn.example') => awg.clientConfig(inbound, 'uuid-a', email, host, 51820, 'AWG');
  assert.throws(() => conf('missing'), /клиент отсутствует/);
  delete inbound.settings.clients[0].privateKey;
  assert.throws(() => conf('alice'), /PrivateKey/);
  inbound.settings.clients[0].privateKey = key(4);
  inbound.settings.server.i1 = '<r 48>\nPostUp = bad';
  assert.throws(() => conf('alice'), /недопустимое/);
  delete inbound.settings.server.i1;
  assert.throws(() => conf('alice', '0.0.0.0'), /публичный/);
  inbound.settings.clients[0].enable = false;
  assert.equal(conf('alice'), '');
  assert.throws(() => awg.normalizeKeepAlive('25-15'), /диапазон/);
  assert.equal(awg.normalizeKeepAlive(0), 0);
});
test('local Docker AmneziaWG requires a published UDP port', () => {
  const node = { panel_url: 'http://local-3xui:2053', inbound_id: 42 };
  assert.throws(() => validateLocalInboundPort(node, fixture(), { NEXUS_LOCAL_XUI_VPN_PORTS: '51820/tcp' }), /51820\/udp/);
  validateLocalInboundPort(node, fixture(), { NEXUS_LOCAL_XUI_VPN_PORTS: '51820/udp' });
});
