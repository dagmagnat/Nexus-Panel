'use strict';

function shareHost(node, inbound, env = process.env) {
  const strategy = String(inbound?.shareAddrStrategy || inbound?.share_addr_strategy || 'node').trim().toLowerCase();
  const custom = String(inbound?.shareAddr || inbound?.share_addr || '').trim();
  const listen = String(inbound?.listen || '').trim();
  if (strategy === 'custom' && custom) return custom;
  if (strategy === 'listen' && !['', '0.0.0.0', '::', '[::]', '*'].includes(listen)) return listen.replace(/^\[|\]$/g, '');

  let host = '';
  try { host = new URL(node.panel_url).hostname; } catch (_) {}
  if (host !== 'local-3xui') return host;
  // Management DNS stays inside Docker. Do not infer a VPN endpoint from the
  // Nexus domain (it can use a CDN) or from the container's private address.
  const publicHost = String(env.NEXUS_LOCAL_XUI_PUBLIC_HOST || '').trim();
  if (!publicHost || publicHost === 'local-3xui') {
    throw new Error('Не задан публичный VPN-адрес локальной 3x-ui. Обновите конфигурацию Nexus или задайте в inbound Share address: Custom с IP сервера. Адрес API local-3xui нельзя выдавать клиентам.');
  }
  const bare = publicHost.replace(/^\[|\]$/g, '');
  const ipVersion = require('node:net').isIP(bare);
  if (ipVersion === 6) return `[${bare}]`;
  if (ipVersion === 4) return bare;
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(bare) || !bare.includes('.')) {
    throw new Error('Публичный VPN-адрес должен быть IP или DNS-именем, без протокола, порта и пути.');
  }
  return bare;
}

module.exports = { shareHost };
