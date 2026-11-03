'use strict';
const { isIP } = require('node:net');
const { domainToASCII } = require('node:url');

function parseEndpoint(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const match = raw.match(/^(\[[^\]]+\]|[^:\s/\\?#@]+):(\d{1,5})$/);
  const invalid = () => { throw new Error('Endpoint: укажите домен:порт, IPv4:порт или [IPv6]:порт без https://, пути и ключей'); };
  if (!match || raw.length > 320) return invalid();
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return invalid();
  let host = match[1];
  if (host.startsWith('[')) {
    host = host.slice(1, -1);
    if (isIP(host) !== 6 || host === '::') return invalid();
    host = '[' + host.toLowerCase() + ']';
  } else if (isIP(host) === 4) {
    if (host === '0.0.0.0') return invalid();
  } else {
    host = domainToASCII(host).toLowerCase();
    if (!host || host.length > 253 || /^\d+(?:\.\d+){3}$/.test(host) ||
        !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return invalid();
  }
  return { host, port, value: host + ':' + port };
}
function endpointFormValue(body, existing = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, 'subscription_endpoint')) return existing.subscription_endpoint || '';
  return parseEndpoint(body.subscription_endpoint)?.value || '';
}
function applySubscriptionEndpoint(line, endpoint) {
  const parsed = parseEndpoint(endpoint);
  if (!parsed) return line;
  const awg = String(line).match(/^((?:amneziawg|awg):\/\/)([A-Za-z0-9_-]+)(#.*)?$/);
  if (awg) {
    const conf = Buffer.from(awg[2], 'base64url').toString('utf8');
    const endpoints = conf.match(/^Endpoint\s*=.*$/gm) || [];
    if (endpoints.length !== 1) throw new Error('AmneziaWG: ожидался один Endpoint в конфигурации');
    const next = conf.replace(/^Endpoint\s*=.*$/m, 'Endpoint = ' + parsed.value);
    return awg[1] + Buffer.from(next, 'utf8').toString('base64url') + (awg[3] || '');
  }
  const uri = new URL(line);
  if (!['vless:', 'trojan:', 'ss:'].includes(uri.protocol)) return line;
  uri.hostname = parsed.host; uri.port = String(parsed.port);
  return uri.toString();
}
module.exports = { parseEndpoint, endpointFormValue, applySubscriptionEndpoint };
