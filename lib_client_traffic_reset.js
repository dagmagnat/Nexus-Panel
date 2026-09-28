'use strict';

function buildClientTrafficResetRequest({ node, map, client, remnawave = false, h1cloud = false, modern3xui = false } = {}) {
  if (!node || !map || !client) throw new Error('Для сброса не найдена связь клиента с узлом.');
  if (h1cloud) throw new Error('Сброс счётчика через API для этого типа H1Cloud не поддерживается.');

  if (remnawave) {
    const userUuid = String(map.remote_uuid || client.uuid || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userUuid)) {
      throw new Error('Для Remnawave не найден UUID удалённого пользователя.');
    }
    return { kind: 'remnawave', method: 'POST', path: `/api/users/${encodeURIComponent(userUuid)}/actions/reset-traffic` };
  }

  const email = String(map.remote_email || client.login || '').trim();
  if (!email) throw new Error('Для узла не найден удалённый логин пользователя.');
  if (modern3xui) {
    return { kind: '3x-ui', method: 'POST', path: `/panel/api/clients/resetTraffic/${encodeURIComponent(email)}` };
  }

  const inboundId = Number(node.inbound_id || 0);
  if (!Number.isInteger(inboundId) || inboundId <= 0) throw new Error('Для 3x-ui не задан inbound ID.');
  return { kind: '3x-ui', method: 'POST', path: `/panel/api/inbounds/${inboundId}/resetClientTraffic/${encodeURIComponent(email)}` };
}

module.exports = { buildClientTrafficResetRequest };
