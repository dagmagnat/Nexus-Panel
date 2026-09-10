'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateLocalInboundPort: check } = require('../lib_local_inbound_port');
const node = { panel_url: 'http://local-3xui:2053', inbound_id: 1 };
test('takes the exact inbound port; rejects unpublished port without mutating it', () => {
  const inbound = { id: 1, port: 28140, protocol: 'vless', streamSettings: '{"network":"tcp"}' };
  assert.throws(() => check(node, inbound, { NEXUS_LOCAL_XUI_VPN_PORTS: '32669/tcp' }), /28140\/tcp.*32669\/tcp/);
  assert.equal(inbound.port, 28140);
  check(node, inbound, { NEXUS_LOCAL_XUI_VPN_PORTS: '28140/tcp' });
});
test('transport protocol must be published, not only its port number', () => {
  const inbound = { port: 28140, streamSettings: { network: 'kcp' } };
  assert.throws(() => check(node, inbound, { NEXUS_LOCAL_XUI_VPN_PORTS: '28140/tcp' }), /28140\/udp/);
  check(node, inbound, { NEXUS_LOCAL_XUI_VPN_PORTS: '28140/udp' });
});
test('remote panels do not inherit local Docker restrictions', () => {
  check({ panel_url: 'https://remote.example.com' }, { port: 28140 }, {});
});
test('missing publication metadata and invalid inbound port fail explicitly', () => {
  assert.throws(() => check(node, { port: 28140 }, {}), /обновите Nexus/);
  assert.throws(() => check(node, { port: 0 }, {}), /допустимого VPN-порта/);
});
test('both node creation and editing validate the fetched inbound', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
  for (const variable of ['importedInbound', 'preflightInbound']) {
    assert.ok(source.includes(`validateLocalInboundPort(pendingNode, ${variable})`));
  }
});
