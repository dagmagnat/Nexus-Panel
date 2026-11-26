'use strict';

const { createHmac, timingSafeEqual } = require('node:crypto');

const tokenPattern = /^(karing|router|sub)-(\d+)-([a-f0-9]{48})$/;
const supportedProtocols = new Set([
  'vless', 'vmess', 'trojan', 'ss', 'shadowsocks', 'ssr', 'hysteria',
  'hysteria2', 'hy2', 'tuic', 'wireguard', 'anytls', 'socks'
]);

function supportsKaringProtocol(protocol) {
  return supportedProtocols.has(String(protocol || '').toLowerCase());
}

function supportsKaringLink(line) {
  return supportsKaringProtocol(String(line || '').split('://', 1)[0])
    && String(line).includes('://');
}

function createKaringLinks({ db, secret, baseUrl, name }) {
  const findClient = db.prepare('SELECT id, sub_slug, uuid FROM clients WHERE id = ?');
  const sign = (app, client) => createHmac('sha256', secret)
    .update(JSON.stringify([app + '-v1', client.id, client.sub_slug, client.uuid])).digest('hex').slice(0, 48);

  function subscriptionUrl(app, client) {
    return baseUrl().replace(/\/$/, '') + '/sub-plain/' + app + '-' + client.id + '-' + sign(app, client);
  }

  function links(client) {
    const url = subscriptionUrl('karing', client);
    const params = new URLSearchParams({ url, name: name(), 'x-hwid': 'true' });
    return { url, open: 'karing://install-config?' + params.toString() };
  }

  function rewrite(req, res, next) {
    const path = req.path.match(/^\/sub-plain\/((?:karing|router|sub)-\d+-[^/]+)$/);
    if (!path) return next();
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const match = path[1].match(tokenPattern);
    const id = Number(match?.[2]);
    const client = Number.isSafeInteger(id) ? findClient.get(id) : null;
    if (!client || !timingSafeEqual(Buffer.from(match[3]), Buffer.from(sign(match[1], client)))) return res.sendStatus(404);
    req.nexusKaring = match[1] === 'karing';
    req.nexusRouter = match[1] === 'router';
    req.nexusPlainApp = match[1] === 'sub';
    req.nexusPrivateSubscription = { clientId: client.id };
    req.url = '/sub-plain/' + encodeURIComponent(client.sub_slug);
    next();
  }

  return { links, routerUrl: client => subscriptionUrl('router', client),
    plainUrl: client => subscriptionUrl('sub', client), rewrite };
}

module.exports = { createKaringLinks, supportsKaringLink, supportsKaringProtocol };
