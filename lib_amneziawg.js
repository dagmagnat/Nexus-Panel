'use strict';

// 3x-ui stores tunnel identities in each inbound, independently of its global
// client row. Never fall back to a different peer or to the server private key.
const isAmneziaWG = inbound => String(inbound?.protocol || '').toLowerCase() === 'amneziawg';
function parse(value) { return typeof value === 'string' ? JSON.parse(value) : value || {}; }
function scalar(value, field) {
  const text = String(value ?? '').trim();
  if (/[\x00-\x1f\x7f]/.test(text)) throw new Error(`AmneziaWG: недопустимое значение ${field}`);
  return text;
}
function key(value, field) {
  const text = scalar(value, field);
  if (!/^(?:[A-Za-z0-9+/]{43}=|[a-fA-F0-9]{64})$/.test(text)) {
    throw new Error(`AmneziaWG: отсутствует или некорректен ${field}`);
  }
  return text;
}
function validateServer(inbound) {
  const server = parse(inbound.settings).server;
  if (!server || typeof server !== 'object') throw new Error('AmneziaWG: 3x-ui не вернула settings.server');
  key(server.publicKey, 'PublicKey сервера');
  if (server.headerProtectionKey) key(server.headerProtectionKey, 'HeaderProtectionKey');
  for (const field of ['jc','jmin','jmax','s1','s2','s3','s4']) if (server[field] !== undefined) validateRange(server[field], field, 65535, false);
  for (const field of ['h1','h2','h3','h4']) if (server[field] !== undefined) validateRange(server[field], field, 4294967295);
  for (const field of ['contentPaddingAddition','rekeyAfterTime','rekeyTimeout','rejectAfterTime','keepaliveTimeout','maxHandshakeAttempts'])
    if (server[field] !== undefined && server[field] !== '') validateRange(server[field], field, 65535);
  if (server.jmin !== undefined && server.jmax !== undefined && Number(server.jmin) > Number(server.jmax)) throw new Error('AmneziaWG: Jmin больше Jmax');
  for (const field of ['randomTrailers','disableCookies']) if (server[field] !== undefined) booleanConfig(server[field], field);
  return server;
}
function validateRange(value, field, maximum, range = true) {
  const text = scalar(value, field);
  if (!(range ? /^\d+(?:-\d+)?$/ : /^\d+$/).test(text)) throw new Error('AmneziaWG: некорректный ' + field);
  const [lo, hi = lo] = text.split('-').map(Number);
  if (hi < lo || hi > maximum) throw new Error('AmneziaWG: некорректный диапазон ' + field);
}
function booleanConfig(value, field) {
  const text = scalar(value, field).toLowerCase();
  if (['true','on','1'].includes(text)) return 'on';
  if (['false','off','0'].includes(text)) return 'off';
  throw new Error('AmneziaWG: некорректный ' + field);
}
function publicServerValues(inbound) {
  const server = validateServer(inbound);
  return Object.fromEntries(Object.entries(server).filter(([k]) => !['privateKey','headerProtectionKey'].includes(k))
    .map(([k,v]) => [k, /^i[1-5]$/.test(k) ? 'задан (' + String(v).length + ' символов)' : v]));
}
function clientConfig(inbound, uuid, email, host, port, name) {
  const settings = parse(inbound.settings), server = validateServer(inbound);
  const clients = Array.isArray(settings.clients) ? settings.clients : [];
  const cleanEmail = String(email || '').trim().toLowerCase();
  // An email identifies the per-inbound peer even when a global UUID is shared.
  const peer = cleanEmail ? clients.find(c => String(c.email || '').trim().toLowerCase() === cleanEmail)
    : clients.find(c => uuid && String(c.id || c.uuid || '') === String(uuid));
  if (!peer) throw new Error('AmneziaWG: клиент отсутствует в выбранном inbound; синхронизируйте узел');
  if (peer.enable === false || peer.enable === 0) return '';
  const addresses = (Array.isArray(peer.allowedIPs) ? peer.allowedIPs : String(peer.allowedIPs || '').split(','))
    .map(v => scalar(v, 'Address')).filter(Boolean);
  if (!addresses.length) throw new Error('AmneziaWG: 3x-ui не выдала адрес клиента');
  const endpointHost = scalar(host, 'Endpoint').replace(/^\[|\]$/g, '');
  if (!endpointHost || ['0.0.0.0', '::'].includes(endpointHost) || /[\s/#?]/.test(endpointHost)
      || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('AmneziaWG: укажите публичный адрес и UDP-порт узла');
  }
  const lines = [`# Name = ${scalar(name, 'Name')}`, '[Interface]',
    `PrivateKey = ${key(peer.privateKey, 'PrivateKey клиента')}`, `Address = ${addresses.join(', ')}`];
  const dns = [server.primaryDns, server.secondaryDns].map(v => scalar(v, 'DNS')).filter(Boolean);
  if (dns.length) lines.push(`DNS = ${dns.join(', ')}`);
  const mtu = Number(server.mtu) || Math.max(1420 - Math.max(Number(server.s4) || 0, 0), 1280);
  if (!Number.isInteger(mtu) || mtu < 576 || mtu > 65535) throw new Error('AmneziaWG: некорректный MTU');
  lines.push(`MTU = ${mtu}`);
  for (const field of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4',
    'I1', 'I2', 'I3', 'I4', 'I5', 'HeaderProtectionKey', 'ContentPaddingAddition',
    'RekeyAfterTime', 'RekeyTimeout', 'RejectAfterTime', 'KeepaliveTimeout', 'MaxHandshakeAttempts',
    'RandomTrailers', 'DisableCookies']) {
    const property = field[0].toLowerCase() + field.slice(1);
    const value = ['RandomTrailers','DisableCookies'].includes(field) && server[property] !== undefined ? booleanConfig(server[property], field) : server[property];
    if (value !== undefined && value !== null && value !== '') lines.push(`${field} = ${scalar(value, field)}`);
  }
  lines.push('', '[Peer]', `PublicKey = ${key(server.publicKey, 'PublicKey сервера')}`);
  if (peer.preSharedKey) lines.push(`PresharedKey = ${key(peer.preSharedKey, 'PresharedKey')}`);
  lines.push('AllowedIPs = 0.0.0.0/0, ::/0',
    `Endpoint = ${endpointHost.includes(':') ? `[${endpointHost}]` : endpointHost}:${Number(port)}`);
  if (peer.keepAlive !== undefined && peer.keepAlive !== null && peer.keepAlive !== '') {
    lines.push(`PersistentKeepalive = ${normalizeKeepAlive(peer.keepAlive)}`);
  }
  return lines.join('\n');
}
function normalizeKeepAlive(value) {
  const text = scalar(value, 'PersistentKeepalive');
  if (!/^\d+(?:-\d+)?$/.test(text)) throw new Error('AmneziaWG: некорректный PersistentKeepalive');
  const [lo, hi = lo] = text.split('-').map(Number);
  if (hi < lo || hi > 4294967295) throw new Error('AmneziaWG: некорректный диапазон PersistentKeepalive');
  return text.includes('-') ? text : Number(text);
}
function shareLink(inbound, uuid, email, host, port, name) {
  const conf = clientConfig(inbound, uuid, email, host, port, name);
  return conf ? `amneziawg://${Buffer.from(conf, 'utf8').toString('base64url')}#${encodeURIComponent(name)}` : '';
}
function jsonContainer(entry) {
  const match = String(entry.line || '').match(/^(?:amneziawg|awg):\/\/([A-Za-z0-9_-]+)(?:#.*)?$/);
  if (!match) return null;
  return { type: 'amneziawg', version: 1, servers: [{ name: entry.nodeName || '', config: match[1] }] };
}

module.exports = { isAmneziaWG, validateServer, clientConfig, shareLink, jsonContainer, normalizeKeepAlive, booleanConfig, publicServerValues };
