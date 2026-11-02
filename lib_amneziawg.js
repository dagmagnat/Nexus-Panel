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
  return server;
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
    const value = server[property];
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

module.exports = { isAmneziaWG, validateServer, clientConfig, shareLink, jsonContainer, normalizeKeepAlive };
