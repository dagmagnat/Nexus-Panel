'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowsUdp443, udp443FormValue, nodeVisionFlow, applyNodeUdp443 } = require('../lib_node_udp443');
const { nodeCloneValues } = require('../lib_node_clone');

const on = { node_type: '3xui', allow_udp443: 1 };
const off = { node_type: '3xui', allow_udp443: 0 };
const vision = 'xtls-rprx-vision', permitted = vision + '-udp443';
const fixture = () => ({ tag: 'proxy', protocol: 'vless',
  settings: { vnext: [{ address: 'vpn.example.test', port: 443, users: [{ id: 'uuid', encryption: 'none', flow: vision }] }] },
  streamSettings: { network: 'tcp', security: 'reality', realitySettings: { publicKey: 'pbk', serverName: 'example.test' } } });

test('UDP443 defaults on, old edit forms preserve values and new unchecked forms disable it', () => {
  assert.equal(allowsUdp443({}), true);
  assert.equal(udp443FormValue({}), 1);
  assert.equal(udp443FormValue({}, off), 0);
  assert.equal(udp443FormValue({ udp443_controls: '1' }, on), 0);
  assert.equal(udp443FormValue({ udp443_controls: '1', allow_udp443: '1' }, off), 1);
  assert.equal(nodeCloneValues(off, 4).allow_udp443, 0);
  assert.equal(nodeCloneValues(on, 5).allow_udp443, 1);
});

test('Vision client suffix changes both ways without changing keys, transport or enabling mux', () => {
  const cfg = fixture(), original = structuredClone(cfg);
  applyNodeUdp443(cfg, on);
  assert.equal(cfg.settings.vnext[0].users[0].flow, permitted);
  assert.equal(cfg.mux, undefined);
  applyNodeUdp443(cfg, on); // idempotent
  applyNodeUdp443(cfg, off);
  assert.deepEqual(cfg, original);
  for (const network of ['raw', 'tcp']) for (const security of ['tls', 'reality']) {
    assert.equal(nodeVisionFlow(vision, on, network, security), permitted);
    assert.equal(nodeVisionFlow(permitted, off, network, security), vision);
  }
});

test('no new flow for other transports, security modes, flows or protocols', () => {
  for (const network of ['xhttp', 'ws', 'grpc']) assert.equal(nodeVisionFlow(vision, on, network, 'reality'), vision);
  assert.equal(nodeVisionFlow(vision, on, 'tcp', 'none'), vision);
  for (const flow of ['', undefined, 'other-flow']) assert.equal(nodeVisionFlow(flow, on, 'tcp', 'reality'), flow);
  const cfg = fixture(); delete cfg.settings.vnext[0].users[0].flow;
  const before = structuredClone(cfg); applyNodeUdp443(cfg, on); assert.deepEqual(cfg, before);
  cfg.streamSettings.security = 'tls'; applyNodeUdp443(cfg, on, vision);
  assert.equal(cfg.settings.vnext[0].users[0].flow, permitted, 'preserve source TLS Vision as well as REALITY');
  delete cfg.settings.vnext[0].users[0].flow; cfg.streamSettings.network = 'xhttp';
  applyNodeUdp443(cfg, on, vision); assert.equal(cfg.settings.vnext[0].users[0].flow, undefined);
  cfg.protocol = 'trojan'; const trojan = structuredClone(cfg); applyNodeUdp443(cfg, off); assert.deepEqual(cfg, trojan);
});

test('existing mux policy is overridden only for ordinary 3x-ui, without changing enabled or concurrency', () => {
  for (const enabled of [true, false]) {
    const cfg = fixture(); cfg.mux = { enabled, concurrency: -1, xudpConcurrency: 16, xudpProxyUDP443: 'reject', other: 'keep' };
    applyNodeUdp443(cfg, on);
    assert.deepEqual(cfg.mux, { enabled, concurrency: -1, xudpConcurrency: 16, xudpProxyUDP443: 'skip', other: 'keep' });
    applyNodeUdp443(cfg, off); assert.equal(cfg.mux.xudpProxyUDP443, 'reject');
  }
  for (const node_type of ['remnawave', 'h1cloud', 'h1cloud_3xui', 'notice']) {
    const cfg = fixture(); cfg.mux = { enabled: true, xudpProxyUDP443: 'reject' };
    const before = structuredClone(cfg);
    applyNodeUdp443(cfg, { node_type, allow_udp443: 1 }); assert.deepEqual(cfg, before);
    assert.equal(nodeVisionFlow(vision, { node_type, allow_udp443: 1 }, 'tcp', 'reality'), vision);
  }
  const cfg = fixture(), before = structuredClone(cfg); applyNodeUdp443(cfg, undefined); assert.deepEqual(cfg, before);
});
