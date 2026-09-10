'use strict';

function normalizePanelRoot(panelUrl, panelPath) {
  const raw = String(panelUrl || '').trim().replace(/\/+$/, '');
  let suffix = String(panelPath || '').trim().replace(/\/+$/, '');
  if (suffix && !suffix.startsWith('/')) suffix = '/' + suffix;
  if (!raw) return suffix;
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return raw + suffix;
    // Pasting the full login link and also filling Panel Path must not double it.
    const current = url.pathname.replace(/\/+$/, '');
    url.pathname = current.endsWith(suffix) ? current : current + suffix;
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_) {
    return (raw + suffix).replace(/\/+$/, '');
  }
}

function connectionHint(status, data) {
  // Inspect error text for known signatures but never echo arbitrary upstream
  // bodies (they can contain HTML, reflected tokens, or other private data).
  const raw = String(data?.raw || data?.msg || data?.message || '').toLowerCase();
  if (status === 400 && /http request.{0,30}https|plain http.{0,60}https/.test(raw)) {
    return 'HTTP 400: обычный HTTP отправлен на HTTPS-порт. Для внешнего адреса 3x-ui укажите https://IP:порт. На том же VPS используйте внутренний http://local-3xui:2053 и правильный Panel Path. Не отключайте проверку сертификата.';
  }
  if (status === 400) {
    return '3x-ui или её прокси отклонили запрос (HTTP 400). Проверьте схему http/https, порт и Panel Path. Внутри общего Docker: http://local-3xui:2053; снаружи — HTTPS-адрес панели. Эта ошибка сама по себе не доказывает проблему токена или сертификата.';
  }
  if (status >= 200 && status < 300 && data?.raw !== undefined) {
    return 'Вместо JSON API получена веб-страница или текст. Проверьте Panel Path: нужен базовый путь 3x-ui, без /panel и /login.';
  }
  return '';
}

module.exports = { normalizePanelRoot, connectionHint };
