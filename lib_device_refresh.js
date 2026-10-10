'use strict';
const MODES = ['manual', 'replace-stale', 'reset-on-refresh'];
function deviceRefreshPolicy(mode, hours) {
  const n = Number(hours);
  return { mode: MODES.includes(mode) ? mode : 'manual', staleHours: Number.isFinite(n) && n>=1 && n<=720 ? Math.floor(n) : 72 };
}
// Must run inside the registration transaction. last_seen means a subscription
// request, not an active tunnel; absence is never proof an app was uninstalled.
function applyDeviceRefreshPolicy(db, clientId, hash, options = {}) {
  const policy = deviceRefreshPolicy(options.mode, options.staleHours);
  if (!hash || options.allowNew === false || policy.mode === 'manual') return 0;
  if (policy.mode === 'reset-on-refresh') {
    // Keep the requesting app's row/metadata; release the other slots only.
    return db.prepare('DELETE FROM subscription_devices WHERE client_id=? AND hwid_hash<>?').run(clientId,hash).changes;
  }
  if (!options.enforced || !(options.limit>0)) return 0;
  if (db.prepare('SELECT id FROM subscription_devices WHERE client_id=? AND hwid_hash=?').get(clientId,hash)) return 0;
  const count = db.prepare('SELECT COUNT(*) AS n FROM subscription_devices WHERE client_id=?').get(clientId).n;
  // Never evict a row unless doing so can actually admit this new app. A
  // legacy registry above its limit still needs an explicit operator reset.
  if (count !== options.limit) return 0;
  const cutoff = new Date((options.now ?? Date.now()) - policy.staleHours*3600000).toISOString();
  const stale = db.prepare('SELECT id FROM subscription_devices WHERE client_id=? AND julianday(last_seen_at)<=julianday(?) ORDER BY julianday(last_seen_at),id LIMIT 1').get(clientId,cutoff);
  return stale ? db.prepare('DELETE FROM subscription_devices WHERE id=? AND client_id=?').run(stale.id,clientId).changes : 0;
}
module.exports = { MODES, deviceRefreshPolicy, applyDeviceRefreshPolicy };
