'use strict';

function validateLocalInboundPort(node, inbound, env = process.env) {
  let host;
  try { host = new URL(node.panel_url).hostname; } catch (_) { return; }
  if (host !== 'local-3xui') return;
  const port = Number(inbound.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Выбранный inbound 3x-ui не содержит допустимого VPN-порта. Укажите порт в самой 3x-ui.');
  }
  let stream = inbound.streamSettings || {};
  if (typeof stream === 'string') stream = JSON.parse(stream);
  const udp = ['kcp', 'mkcp', 'quic', 'hysteria', 'hysteria2'].includes(String(stream.network || '').toLowerCase())
    || ['wireguard', 'hysteria', 'hysteria2'].includes(String(inbound.protocol || '').toLowerCase());
  const binding = `${port}/${udp ? 'udp' : 'tcp'}`;
  const published = String(env.NEXUS_LOCAL_XUI_VPN_PORTS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (!published.includes(binding)) {
    throw new Error(`Выбран inbound ID ${Number(inbound.id || node.inbound_id)}: порт ${binding}. `
      + (published.length ? `Docker публикует: ${published.join(', ')}. ` : 'Список опубликованных VPN-портов отсутствует: обновите Nexus через agg. ')
      + `Узел не сохранён. На сервере выполните x-ui ports и добавьте ${binding}, затем повторите сохранение. Порт inbound и порт панели 2053 автоматически не меняются.`);
  }
}

module.exports = { validateLocalInboundPort };
