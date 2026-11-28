'use strict';

const { directDnsSettings, parseDirectDnsServers } = require('./lib_json_routing_dns');

const MODES = ['node-selective', 'proxy-except'];
const MAX_GROUPS = 30;

function parseRoutingGroups(raw, allowedNodeIds, parseLines, personalDns) {
  let input;
  try { input = JSON.parse(raw); }
  catch (_) { throw new Error('Не удалось прочитать правила маршрутизации. Обновите страницу и повторите.'); }
  if (!Array.isArray(input) || input.length > MAX_GROUPS) throw new Error('Допускается до 30 правил маршрутизации.');
  const assigned = new Set();
  return input.map((value, index) => {
    const label = `Правило ${index + 1}`;
    if (!value || !MODES.includes(value.mode)) throw new Error(`${label}: выберите режим.`);
    const nodeIds = [...new Set((Array.isArray(value.nodeIds) ? value.nodeIds : []).map(Number))];
    if (!nodeIds.length || nodeIds.some(id => !allowedNodeIds.has(id))) throw new Error(`${label}: выберите доступные узлы.`);
    for (const id of nodeIds) {
      if (assigned.has(id)) throw new Error(`${label}: этот узел уже выбран в другом правиле.`);
      assigned.add(id);
    }
    const domains = parseLines(String(value.domains || ''), 'domain');
    const ips = parseLines(String(value.ips || ''), 'ip');
    if (domains.errors.length || ips.errors.length) throw new Error(`${label}: ${[...domains.errors, ...ips.errors].join(' | ')}`);
    const dns = directDnsSettings(value);
    if (dns.directDnsEnabled && dns.directDnsMode !== 'system-all') {
      if (!domains.values.length) throw new Error(`${label}: для отдельного DNS добавьте домен или GeoSite.`);
      try { parseDirectDnsServers(dns.directDnsPreset, dns.directDnsCustom, personalDns); }
      catch (error) { throw new Error(label + ': ' + error.message); }
    }
    delete dns.sniffingRouteOnly;
    return { mode: value.mode, nodeIds, domains: domains.values, ips: ips.values, ...dns };
  });
}

function assignmentsFromGroups(groups) {
  return Object.fromEntries(MODES.map(mode => [mode, groups.filter(rule => rule.mode === mode).flatMap(rule => rule.nodeIds)]));
}

function policyForGroup(config, rule) {
  if (!rule) return config;
  return {
    ...config, mode: rule.mode,
    exceptDomains: rule.mode === 'proxy-except' ? rule.domains : [],
    exceptIps: rule.mode === 'proxy-except' ? rule.ips : [],
    listProxyDomains: rule.mode === 'node-selective' ? rule.domains : [],
    listProxyIps: rule.mode === 'node-selective' ? rule.ips : [],
    directDnsEnabled: rule.directDnsEnabled,
    directDnsMode: rule.directDnsMode,
    directDnsPreset: rule.directDnsPreset,
    directDnsCustom: rule.directDnsCustom
  };
}

module.exports = { parseRoutingGroups, assignmentsFromGroups, policyForGroup };
