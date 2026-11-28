'use strict';

const { isIP } = require('node:net');
const DIRECT_DNS_TAG = 'nexus-dns-direct';
const PROXY_DNS_TAG = 'nexus-dns-proxy';
const LIST_DNS_TAG = 'nexus-dns-list';
const RULE_DNS_GROUPS = Object.freeze([
  {
    label: 'DNS по HTTPS · DoH',
    options: [
      { value: 'doh_yandex', label: 'Яндекс · DoH', addresses: ['https://common.dot.dns.yandex.net/dns-query'] },
      { value: 'doh_cloudflare', label: 'Cloudflare · DoH', addresses: ['https://cloudflare-dns.com/dns-query'] },
      { value: 'doh_google', label: 'Google · DoH', addresses: ['https://dns.google/dns-query'] },
      { value: 'doh_quad9', label: 'Quad9 · DoH с защитой от угроз', addresses: ['https://dns.quad9.net/dns-query'] },
      { value: 'doh_adguard', label: 'AdGuard · DoH с фильтрацией рекламы и трекеров', addresses: ['https://dns.adguard-dns.com/dns-query'] }
    ]
  },
  {
    label: 'Обычный DNS · UDP/53',
    options: [
      { value: 'yandex', label: 'Яндекс · UDP/53', addresses: ['77.88.8.8', '77.88.8.1'] },
      { value: 'cloudflare', label: 'Cloudflare · UDP/53', addresses: ['1.1.1.1', '1.0.0.1'] },
      { value: 'google', label: 'Google · UDP/53', addresses: ['8.8.8.8', '8.8.4.4'] },
      { value: 'quad9', label: 'Quad9 · UDP/53 с защитой от угроз', addresses: ['9.9.9.9', '149.112.112.112'] }
    ]
  }
]);
const DIRECT_DNS_PRESETS = Object.freeze({
  ...Object.fromEntries(RULE_DNS_GROUPS.flatMap(group => group.options.map(({ value, addresses }) => [value, addresses]))),
  personal: [],
  doh_personal: [],
  manual: []
});

const DOH_BOOTSTRAP_IPS = Object.freeze({
  'cloudflare-dns.com': '1.1.1.1',
  'dns.google': '8.8.8.8',
  'common.dot.dns.yandex.net': '77.88.8.8',
  'dns.quad9.net': '9.9.9.9',
  'dns.adguard-dns.com': '94.140.14.14'
});

function personalDnsSettings(value = {}) {
  const address = String(value.address || '').trim();
  const dohUrl = String(value.dohUrl || '').trim();
  if (address && !isIP(address)) throw new Error('Свой DNS: укажите IPv4 или IPv6 без порта.');
  if (dohUrl) {
    let url;
    try { url = new URL(dohUrl); } catch (_) {}
    if (!url || url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
      throw new Error('Свой DNS: укажите HTTPS-адрес DoH без логина и пароля.');
    }
  }
  return { address, dohUrl };
}

function personalDnsGroups(value = {}) {
  const dns = personalDnsSettings(value);
  const options = [];
  if (dns.address) options.push({ value: 'personal', label: 'Свой DNS · ' + dns.address, addresses: [dns.address] });
  if (dns.dohUrl) options.push({ value: 'doh_personal', label: 'Свой DNS · DoH', addresses: [dns.dohUrl] });
  return options.length ? [{ label: 'Свой DNS', options }] : [];
}

function prepareIncyAutoSelectDns(dns) {
  if (!Array.isArray(dns?.servers)) return;
  const googleDoh = {
    '8.8.8.8': 'https://dns.google/dns-query',
    '8.8.4.4': 'https://cloudflare-dns.com/dns-query'
  };
  dns.servers = dns.servers.map(server => {
    if (server?.tag !== LIST_DNS_TAG || !Object.hasOwn(googleDoh, server.address)
      || (server.port != null && Number(server.port) !== 53)) return server;
    // INCY prepends direct routes for DNS server IPs to full configs with Observatory.
    // Named DoH keeps the flagged resolver traffic on the selected VPN outbound.
    const { port, ...settings } = server;
    return { ...settings, address: googleDoh[server.address] };
  });
  prepareJsonDns(dns);
}

function prepareJsonDns(dns, { fastFallback = false, personalDns = {} } = {}) {
  if (!Array.isArray(dns?.servers)) return;
  const bootstrap = { ...DOH_BOOTSTRAP_IPS };
  if (personalDns.address && personalDns.dohUrl) {
    try { bootstrap[new URL(personalDns.dohUrl).hostname] = personalDns.address; } catch (_) {}
  }
  for (const server of dns.servers) {
    const address = typeof server === 'string' ? server : server?.address;
    if (!/^https(?:\+local)?:\/\//i.test(address || '')) continue;
    let hostname;
    try { hostname = new URL(address.replace(/^https\+local:/i, 'https:')).hostname; }
    catch (_) { continue; }
    if (!Object.hasOwn(bootstrap, hostname)) continue;
    dns.hosts ??= {};
    if (!Object.hasOwn(dns.hosts, 'full:' + hostname)) dns.hosts[hostname] ??= bootstrap[hostname];
  }
  if (!fastFallback) return;

  // Give a backup resolver an earlier chance only within the same scope.
  // Keep the full timeout for the sole or final resolver in each scope.
  dns.servers = dns.servers.map((server, index) => {
    const next = dns.servers[index + 1];
    if (!server || !next || server.timeoutMs != null || server.finalQuery === true) return server;
    if (server.tag !== next.tag || server.skipFallback !== next.skipFallback
        || JSON.stringify(server.domains) !== JSON.stringify(next.domains)) return server;
    const address = typeof server === 'string' ? server : server.address;
    if (!(isIP(address || '') || /^https(?:\+local)?:\/\//i.test(address || ''))) return server;
    return typeof server === 'string' ? { address, timeoutMs: 2000 } : { ...server, timeoutMs: 2000 };
  });
}

function directDnsSettings(value = {}) {
  return {
    directDnsEnabled: value.directDnsEnabled === true,
    directDnsMode: ['system-all', 'system-default'].includes(value.directDnsMode) ? value.directDnsMode : 'custom',
    directDnsPreset: Object.hasOwn(DIRECT_DNS_PRESETS, value.directDnsPreset) ? value.directDnsPreset : 'doh_yandex',
    directDnsCustom: typeof value.directDnsCustom === 'string' ? value.directDnsCustom : '',
    sniffingRouteOnly: value.sniffingRouteOnly === true
  };
}

function parseDirectDnsServers(preset, custom, personalDns = {}) {
  if (!Object.hasOwn(DIRECT_DNS_PRESETS, preset)) throw new Error('Неизвестный набор DNS для direct.');
  if (String(custom || '').length > 4096) throw new Error('Список DNS для direct слишком большой.');
  const lines = String(custom || '').split(/[\n,;]+/).map(x => x.trim()).filter(Boolean);
  if (lines.length > 8) throw new Error('Укажи не более 8 ручных DNS для direct.');
  const own = personalDnsGroups(personalDns).flatMap(group => group.options).find(option => option.value === preset);
  if (['personal', 'doh_personal'].includes(preset) && !own) throw new Error('Сначала заполните адрес своего DNS.');
  const values = [...new Set([...(own?.addresses || DIRECT_DNS_PRESETS[preset]), ...lines])];
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

function applyJsonRoutingDns(config, routing, { active = false, mode = '', directDomains = [], proxyDomains = [], listProxyDomains = [] } = {}) {
  if (!config || typeof config !== 'object' || !active || routing?.enabled === false) return config;
  const options = directDnsSettings(routing);
  for (const inbound of config.inbounds || []) {
    if (inbound?.sniffing?.enabled === true) inbound.sniffing.routeOnly = options.sniffingRouteOnly;
  }
  if (!config.routing) return config;
  if (options.directDnsEnabled && options.directDnsMode !== 'custom') {
    // localhost delegates to the device OS. Its actual resolver depends on the
    // client's VPN/TUN integration; do not substitute a public DNS IP for it.
    config.dns ??= {};
    config.dns.servers = ['localhost'];
    config.dns.disableFallbackIfMatch = true;
    const scopedTags = [DIRECT_DNS_TAG, PROXY_DNS_TAG, LIST_DNS_TAG];
    config.routing.rules = (config.routing.rules || []).filter(rule =>
      !(rule.inboundTag?.length === 1 && scopedTags.includes(rule.inboundTag[0])));
    if (options.directDnsMode === 'system-all') return config;
    // Matching list domains must not fall back to the OS resolver on failure.
    // The existing rule mode still determines whether list DNS goes via VPN.
  }
  if (mode === 'node-selective') {
    // Resolve ordinary domains directly even when the main resolver IP also
    // matches a GeoIP rule in the VPN list. Separate list DNS is tagged below.
    const tag = config.dns?.tag;
    if (tag) {
      const rules = (config.routing.rules || []).filter(rule => !(rule.inboundTag?.length === 1 && rule.inboundTag[0] === tag));
      config.routing.rules = [{ type: 'field', inboundTag: [tag], outboundTag: 'direct' }, ...rules];
    }
    if (!options.directDnsEnabled || !listProxyDomains.length) return config;
    let servers;
    try { servers = parseDirectDnsServers(options.directDnsPreset, options.directDnsCustom, routing.personalDns); }
    catch (_) { return config; }
    const domains = [...new Set(listProxyDomains)];
    const base = (config.dns?.servers || []).filter(server => server?.tag !== LIST_DNS_TAG);
    config.dns.servers = [
      ...servers.map(server => ({ ...server, address: server.address.replace(/^https\+local:/, 'https:'), domains, tag: LIST_DNS_TAG, skipFallback: true })),
      ...base
    ];
    config.routing.rules = [
      { type: 'field', inboundTag: [LIST_DNS_TAG], outboundTag: 'proxy' },
      ...(config.routing.rules || []).filter(rule => !(rule.inboundTag?.length === 1 && rule.inboundTag[0] === LIST_DNS_TAG))
    ];
    return config;
  }
  if (mode !== 'proxy-except' || !options.directDnsEnabled || !directDomains.length) return config;
  let direct;
  try { direct = parseDirectDnsServers(options.directDnsPreset, options.directDnsCustom, routing.personalDns); }
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

module.exports = {
  RULE_DNS_GROUPS, personalDnsSettings, personalDnsGroups, directDnsSettings, parseDirectDnsServers, applyJsonRoutingDns,
  prepareJsonDns, prepareIncyAutoSelectDns, DIRECT_DNS_TAG, PROXY_DNS_TAG
};
