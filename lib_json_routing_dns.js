'use strict';

const { isIP } = require('node:net');
const DIRECT_DNS_TAG = 'nexus-dns-direct';
const PROXY_DNS_TAG = 'nexus-dns-proxy';
const DIRECT_DNS_PRESETS = Object.freeze({
  doh_yandex: ['https://common.dot.dns.yandex.net/dns-query'],
  yandex: ['77.88.8.8', '77.88.8.1'],
  cloudflare: ['1.1.1.1', '1.0.0.1'],
  google: ['8.8.8.8', '8.8.4.4'],
  manual: []
});

function directDnsSettings(value = {}) {
  return {
    directDnsEnabled: value.directDnsEnabled === true,
    directDnsPreset: Object.hasOwn(DIRECT_DNS_PRESETS, value.directDnsPreset) ? value.directDnsPreset : 'doh_yandex',
    directDnsCustom: typeof value.directDnsCustom === 'string' ? value.directDnsCustom : '',
    sniffingRouteOnly: value.sniffingRouteOnly === true
  };
}

function parseDirectDnsServers(preset, custom) {
  if (!Object.hasOwn(DIRECT_DNS_PRESETS, preset)) throw new Error('Неизвестный набор DNS для direct.');
  if (String(custom || '').length > 4096) throw new Error('Список DNS для direct слишком большой.');
  const lines = String(custom || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  if (lines.length > 8) throw new Error('Укажи не более 8 ручных DNS для direct.');
  const values = [...new Set([...DIRECT_DNS_PRESETS[preset], ...lines])];
  if (!values.length) throw new Error('Для ручного DNS direct укажи хотя бы один IP или HTTPS DoH URL.');
  return values.map(value => {
    if (isIP(value)) return { address: value, port: 53 };
    let url;
    try { url = new URL(value.replace(/^https\+local:/i, 'https:')); } catch (_) { /* invalid below */ }
    if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('DNS для direct: нужен IPv4/IPv6 без порта или HTTPS DoH URL без логина/пароля.');
    }
    // Local DoH does not re-enter Xray routing. Its hostname is bootstrapped
    // by the device OS resolver, avoiding a recursive built-in DNS lookup.
    return { address: url.href.replace(/^https:/, 'https+local:') };
  });
}

function applyJsonRoutingDns(config, routing, { active = false, mode = '', directDomains = [], proxyDomains = [] } = {}) {
  if (!config || typeof config !== 'object' || !active || routing?.enabled === false) return config;
  const options = directDnsSettings(routing);
  for (const inbound of config.inbounds || []) {
    if (inbound?.sniffing?.enabled === true) inbound.sniffing.routeOnly = options.sniffingRouteOnly;
  }
  // This switch belongs to the explicit direct exceptions of proxy-except,
  // not to all traffic/other node modes or to the upstream server profile.
  if (!options.directDnsEnabled || mode !== 'proxy-except' || !directDomains.length || !config.routing) return config;
  let direct;
  try { direct = parseDirectDnsServers(options.directDnsPreset, options.directDnsCustom); }
  catch (_) { return config; } // A damaged imported setting must not turn JSON issuance into HTTP 500.
  const domains = [...new Set(directDomains)];
  const forced = [...new Set(proxyDomains)];
  const base = (config.dns?.servers || []).filter(server => server?.tag !== DIRECT_DNS_TAG && !(server?.tag === PROXY_DNS_TAG && server.domains?.length));
  if (!base.length) return config;
  const asServer = server => typeof server === 'string' ? { address: server } : { ...server };
  // A forced-proxy domain can overlap a broad RU category. Give its normal
  // resolver first priority, just as traffic rules give proxy first priority.
  // On DNS errors Xray retains its ordinary sequential fallback behavior.
  const priority = forced.length ? base.map(server => ({ ...asServer(server), domains: forced, tag: PROXY_DNS_TAG, skipFallback: true })) : [];
  config.dns.servers = [
    ...priority,
    ...direct.map(server => ({ ...server, domains, tag: DIRECT_DNS_TAG, skipFallback: true })),
    ...base.map(server => ({ ...asServer(server), tag: PROXY_DNS_TAG }))
  ];
  // Tagged UDP resolvers really go direct. A local DoH request bypasses the
  // router already; the same tag rule is harmless and keeps the intent clear.
  config.routing.rules = [
    { type: 'field', inboundTag: [DIRECT_DNS_TAG], outboundTag: 'direct' },
    { type: 'field', inboundTag: [PROXY_DNS_TAG], outboundTag: 'proxy' },
    ...(config.routing.rules || []).filter(rule => !(rule.inboundTag?.length === 1 && [DIRECT_DNS_TAG, PROXY_DNS_TAG].includes(rule.inboundTag[0])))
  ];
  return config;
}

module.exports = { directDnsSettings, parseDirectDnsServers, applyJsonRoutingDns, DIRECT_DNS_TAG, PROXY_DNS_TAG };
