'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { directDnsSettings, parseDirectDnsServers, applyJsonRoutingDns, DIRECT_DNS_TAG, PROXY_DNS_TAG } = require('../lib_json_routing_dns');

const options = { active: true, mode: 'proxy-except', directDomains: ['geosite:category-ru', 'domain:qip.ru'], proxyDomains: ['domain:mail.ru'] };
const settings = { enabled: true, directDnsEnabled: true, directDnsPreset: 'doh_yandex', sniffingRouteOnly: true };
function config() {
  return { dns: { queryStrategy: 'UseIPv4', tag: 'dns_out', servers: [{ address: '8.8.8.8', port: 53, skipFallback: false }] },
    inbounds: [{ tag: 'socks', sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'] } }],
    outbounds: [{ tag: 'proxy', protocol: 'vless', settings: { flow: 'xtls-rprx-vision' }, streamSettings: { network: 'tcp', security: 'reality' } }, { tag: 'direct', protocol: 'freedom' }],
    routing: { domainStrategy: 'IPOnDemand', rules: [{ domain: ['domain:mail.ru'], outboundTag: 'proxy' }, { domain: options.directDomains, outboundTag: 'direct' }, { network: 'tcp,udp', outboundTag: 'proxy' }] } };
}
test('new routing opt-ins default off, including legacy settings', () => {
  assert.deepEqual(directDnsSettings({}), { directDnsEnabled: false, directDnsPreset: 'doh_yandex', directDnsCustom: '', sniffingRouteOnly: false });
  const cfg = config(); const before = structuredClone(cfg);
  applyJsonRoutingDns(cfg, {}, options);
  assert.deepEqual(cfg.dns, before.dns); assert.deepEqual(cfg.routing, before.routing);
  assert.equal(cfg.inbounds[0].sniffing.routeOnly, false);
});
test('direct DoH follows domain exceptions; priority proxy DNS and actual UDP routing stay explicit', () => {
  const cfg = config(), before = structuredClone(cfg.outbounds);
  applyJsonRoutingDns(cfg, settings, options);
  assert.equal(cfg.dns.servers[0].tag, PROXY_DNS_TAG);
  assert.deepEqual(cfg.dns.servers[0].domains, ['domain:mail.ru']);
  const direct = cfg.dns.servers.find(x => x.tag === DIRECT_DNS_TAG);
  assert.equal(direct.address, 'https+local://common.dot.dns.yandex.net/dns-query');
  assert.equal(direct.skipFallback, true); assert.deepEqual(direct.domains, options.directDomains);
  assert.deepEqual(cfg.routing.rules.slice(0, 2), [
    { type: 'field', inboundTag: [DIRECT_DNS_TAG], outboundTag: 'direct' },
    { type: 'field', inboundTag: [PROXY_DNS_TAG], outboundTag: 'proxy' }
  ]);
  assert.equal(cfg.inbounds[0].sniffing.routeOnly, true);
  assert.deepEqual(cfg.outbounds, before, 'transport, credentials, mux and UDP/443 policy must not change');
  assert.equal(cfg.routing.domainStrategy, 'IPOnDemand');
  const once = structuredClone(cfg); applyJsonRoutingDns(cfg, settings, options); assert.deepEqual(cfg, once);
});
test('UDP direct DNS is tagged direct, with only address syntax accepted', () => {
  const cfg = applyJsonRoutingDns(config(), { ...settings, directDnsPreset: 'yandex' }, options);
  const direct = cfg.dns.servers.filter(x => x.tag === DIRECT_DNS_TAG);
  assert.deepEqual(direct.map(x => [x.address, x.port]), [['77.88.8.8', 53], ['77.88.8.1', 53]]);
  assert.equal(parseDirectDnsServers('manual', '2001:4860:4860::8888\nhttps://1.1.1.1/dns-query').length, 2);
  for (const value of ['', '999.1.1.1', 'tls://dns.google', 'http://dns.example/query', 'https://user:pass@dns.example/query', 'file:///etc/passwd', 'https://dns.example/query#fragment', 'geoip:ru']) {
    assert.throws(() => parseDirectDnsServers('manual', value), undefined, value);
  }
  assert.throws(() => parseDirectDnsServers('no-such-preset', '1.1.1.1'));
});
test('routing off and unassigned nodes keep original DNS/sniffing; node-selective does not gain direct DNS', () => {
  for (const flags of [{ active: false }, { mode: 'node-selective' }, { directDomains: [] }]) {
    const cfg = config(); const dns = structuredClone(cfg.dns);
    applyJsonRoutingDns(cfg, settings, { ...options, ...flags }); assert.deepEqual(cfg.dns, dns);
    if (flags.active === false) assert.equal(cfg.inbounds[0].sniffing.routeOnly, undefined);
  }
  const cfg = config(), before = structuredClone(cfg);
  applyJsonRoutingDns(cfg, { ...settings, enabled: false }, options); assert.deepEqual(cfg, before);
});
test('routeOnly can be tested independently of DNS and does not enable disabled sniffing', () => {
  const cfg = config(); cfg.inbounds.push({ sniffing: { enabled: false } });
  applyJsonRoutingDns(cfg, { ...settings, directDnsEnabled: false }, options);
  assert.equal(cfg.inbounds[0].sniffing.routeOnly, true); assert.equal(cfg.inbounds[1].sniffing.routeOnly, undefined);
  applyJsonRoutingDns(cfg, { sniffingRouteOnly: false }, options); assert.equal(cfg.inbounds[0].sniffing.routeOnly, false);
});
test('damaged imported direct DNS never prevents JSON issuance', () => {
  const cfg = config(), dns = structuredClone(cfg.dns);
  assert.doesNotThrow(() => applyJsonRoutingDns(cfg, { ...settings, directDnsPreset: 'manual', directDnsCustom: 'broken' }, options));
  assert.deepEqual(cfg.dns, dns);
});
