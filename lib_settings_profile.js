'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FORMAT = 'nexus-preferences';
const labels = {
  show_sub_links: 'Показывать SUB-ссылки', show_json_links: 'Показывать JSON-ссылки', show_happ_links: 'Показывать Happ-ссылки',
  subscription_show_limits: 'Показывать лимиты в подписке', subscription_userinfo_header: 'Передавать трафик и срок в заголовках',
  subscription_live_usage: 'Обновлять расход трафика подписки', subscription_client_auto_update_enabled: 'Автообновление подписки',
  subscription_show_empty_limits: 'Показывать пустые лимиты', subscription_happ_info_enabled: 'Информация о клиенте в Happ',
  subscription_happ_info_announce_fallback_enabled: 'Резервное объявление информации в Happ', subscription_happ_server_description_enabled: 'Описание сервера в Happ',
  subscription_device_tracking_enabled: 'Учитывать устройства', subscription_device_limit_enforced: 'Применять лимит устройств', subscription_device_require_hwid: 'Требовать идентификатор устройства (HWID)',
  subscription_expired_notice_enabled: 'Уведомление об истечении подписки', subscription_expired_grace_days: 'Служебный доступ после истечения, дней',
  subscription_update_interval_hours: 'Обновление подписки, часов', node_auto_refresh_seconds: 'Обновление списка узлов, секунд', client_auto_refresh_seconds: 'Обновление клиентов, секунд',
  json_mux_enabled: 'Mux в JSON', json_sniffing_enabled: 'Sniffing в JSON', ios_safe_routing_enabled: 'Совместимая маршрутизация для iOS',
  happ_app_controls_enabled: 'Передавать настройки приложения Happ', happ_ping_tcp: 'TCP-проверка в Happ', happ_ping_result_icon: 'Значок результата проверки Happ',
  happ_fragmentation_enabled: 'Фрагментация Happ', happ_noises_enabled: 'Noises в Happ', happ_mux_enabled: 'Mux в Happ',
  happ_subscription_auto_update_enabled: 'Автообновление Happ', happ_update_on_open_enabled: 'Обновлять при открытии Happ', happ_ping_on_open_enabled: 'Проверять соединение при открытии Happ',
  happ_subscriptions_collapse_enabled: 'Сворачивать подписки Happ', happ_expand_now_enabled: 'Разворачивать текущую подписку Happ', happ_check_url_via_proxy_enabled: 'Проверять URL через прокси в Happ',
  happ_sniffing_enabled: 'Sniffing Happ', happ_force_apply_on_update_enabled: 'Применять настройки при обновлении Happ',
  panel_interface_theme: 'Режим интерфейса', clients_view_mode: 'Вид списка клиентов', panel_mobile_nav_mode: 'Мобильная навигация', panel_mobile_ui_scale: 'Размер мобильного интерфейса', panel_mobile_client_compact: 'Компактные карточки клиентов'
};
const rules = {};
for (const key of `show_sub_links show_json_links show_happ_links subscription_show_limits subscription_userinfo_header subscription_live_usage subscription_client_auto_update_enabled subscription_show_empty_limits subscription_happ_info_enabled subscription_happ_info_announce_fallback_enabled subscription_happ_server_description_enabled subscription_device_tracking_enabled subscription_device_limit_enforced subscription_device_require_hwid subscription_expired_notice_enabled json_mux_enabled json_sniffing_enabled ios_safe_routing_enabled happ_app_controls_enabled happ_ping_tcp happ_ping_result_icon happ_fragmentation_enabled happ_noises_enabled happ_mux_enabled happ_subscription_auto_update_enabled happ_update_on_open_enabled happ_ping_on_open_enabled happ_subscriptions_collapse_enabled happ_expand_now_enabled happ_check_url_via_proxy_enabled happ_sniffing_enabled happ_force_apply_on_update_enabled panel_mobile_client_compact client_default_start_on_activation`.split(' ')) rules[key] = { values: ['0', '1'], fallback: '0' };
Object.assign(rules, {
  subscription_update_interval_hours: { min: 1, max: 168, fallback: '1' },
  subscription_expired_grace_days: { values: ['3', '7'], fallback: '7' },
  node_auto_refresh_seconds: { values: ['0', '10', '30', '60'], fallback: '10' },
  client_auto_refresh_seconds: { values: ['0', '10', '30', '60'], fallback: '10' },
  panel_interface_theme: { values: ['classic', 'mobile_lite'], fallback: 'classic' },
  clients_view_mode: { values: ['classic', 'modern'], fallback: 'modern' },
  panel_mobile_nav_mode: { values: ['bottom', 'side'], fallback: 'bottom' },
  panel_mobile_ui_scale: { values: ['compact', 'normal', 'large'], fallback: 'compact' },
  client_default_duration_days: { min: 0, max: 36500, fallback: '30' },
  client_default_limit_ip: { min: 0, max: 100000, fallback: '0' },
  client_default_device_limit: { min: 0, max: 100000, fallback: '1' },
  client_default_traffic_gb: { min: 0, max: 10000000, decimal: true, fallback: '0' }
});
function validate(key, value) {
  const rule = Object.hasOwn(rules, key) ? rules[key] : null;
  if (!rule) throw new Error(`Параметр не разрешён для переноса: ${key}`);
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Недопустимое значение: ${key}`);
  const text = String(value);
  if (rule.values ? !rule.values.includes(text) : (!text.trim() || !Number.isFinite(Number(text)) || Number(text) < rule.min || Number(text) > rule.max || (!rule.decimal && !Number.isInteger(Number(text))))) throw new Error(`Недопустимое значение: ${key}`);
  return text;
}
function parse(bundle) {
  if (!bundle || bundle.format !== FORMAT || bundle.version !== 1 || !bundle.settings || Array.isArray(bundle.settings) || typeof bundle.settings !== 'object') throw new Error('Нужен профиль .nxpreferences версии 1, не полный backup панели.');
  if (JSON.stringify(bundle).length > 65536) throw new Error('Профиль слишком большой');
  return Object.fromEntries(Object.entries(bundle.settings).map(([key, value]) => [key, validate(key, value)]));
}
function exportProfile(db) {
  const settings = {};
  for (const row of db.prepare('SELECT key, value FROM app_settings').all()) {
    if (Object.hasOwn(rules, row.key)) {
      try { settings[row.key] = validate(row.key, row.value); } catch (_) { /* incompatible old setting is not transferable */ }
    }
  }
  for (const key of Object.keys(rules).filter(k => k.startsWith('client_default_'))) if (!(key in settings)) settings[key] = rules[key].fallback;
  return { format: FORMAT, version: 1, settings };
}
function preview(db, bundle) {
  return Object.entries(parse(bundle)).map(([key, value]) => ({ key, before: db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? rules[key].fallback, after: value }));
}
async function apply(db, dataDir, bundle) {
  const values = parse(bundle);
  const backupDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  // Only preferences, not a full database containing clients and API secrets.
  const before = exportProfile(db);
  const backup = `preferences-before-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.nxpreferences`;
  fs.writeFileSync(path.join(backupDir, backup), JSON.stringify(before), { flag: 'wx', mode: 0o600 });
  db.transaction(() => {
    const stmt = db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    for (const [key, value] of Object.entries(values)) stmt.run(key, value);
    stmt.run('subscription_revision', String(Date.now()));
  })();
  return { updated: Object.keys(values).length, backup };
}
module.exports = { FORMAT, rules, labels, validate, parse, exportProfile, preview, apply };
