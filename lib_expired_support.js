'use strict';
const DAY = 86400000;
function supportAccess(client, grant, defaultDays, now = Date.now()) {
  const expiry = Math.max(0, Number(client.expiry_time) || 0);
  const days = grant ? Number(grant.days) : Number(defaultDays);
  // A renewal is tied to this particular expiry, never to a later subscription.
  const until = days === 0 ? 0 : grant && Number(grant.base_expiry) === expiry
    ? Number(grant.until_ms) : expiry + days * DAY;
  const pending = Number(client.start_on_activation) === 1 && Number(client.activation_started_at || 0) <= 0;
  const eligible = Number(client.enabled) !== 0 && expiry > 0 && expiry <= now && !pending;
  return { active: eligible && (days === 0 || until > now), expiryTime: until, days, unlimited: days === 0 };
}
function parseSupportDays(mode, value, defaultDays) {
  if (mode === 'unlimited') return 0;
  if (mode === 'renew') return defaultDays;
  if (mode === 'reset') return null;
  if (mode !== 'custom') throw new Error('Выберите срок служебного доступа');
  const text = String(value || '').trim();
  const days = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(days) || days < 1 || days > 36500) throw new Error('Введите число дней от 1 до 36500');
  return days;
}
function initSupportSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS client_support_grants (
    client_id INTEGER NOT NULL, node_id INTEGER NOT NULL, days INTEGER NOT NULL,
    until_ms INTEGER NOT NULL, base_expiry INTEGER NOT NULL, PRIMARY KEY(client_id,node_id));
    CREATE TABLE IF NOT EXISTS client_support_sync (
    client_id INTEGER NOT NULL, node_id INTEGER NOT NULL, signature TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', PRIMARY KEY(client_id,node_id));`);
}
module.exports = { supportAccess, parseSupportDays, initSupportSchema };
