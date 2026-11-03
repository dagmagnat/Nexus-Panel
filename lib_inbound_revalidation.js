'use strict';
// Refresh connection parameters, never authorization/traffic decisions.
function connectionKey(node) {
  return JSON.stringify(['id','inbound_id','panel_url','panel_path','api_auth_mode','username','password_enc','api_token_enc'].map(k => node[k] ?? ''));
}
function createInboundRevalidator({ read, load, now = Date.now, ttlMs = 60000, retryMs = 15000, maxConcurrent = 8, onError = () => {} }) {
  const jobs = new Map(), retries = new Map();
  return async node => {
    const cached = read(node), key = connectionKey(node), time = now();
    if (cached?.inbound && Number.isFinite(cached.updatedAt) && time >= cached.updatedAt && time-cached.updatedAt < ttlMs) return cached.inbound;
    if (jobs.has(key)) return jobs.get(key);
    if ((retries.get(key) || 0) > time && cached?.inbound) return cached.inbound;
    if (jobs.size >= maxConcurrent) {
      if (cached?.inbound) return cached.inbound;
      throw Error('Too many inbound refreshes; retry shortly');
    }
    for (const [k, until] of retries) if (until <= time) retries.delete(k);
    const job = Promise.resolve().then(() => load(node)).catch(err => {
      // A confirmed deleted/replaced inbound is not a usable fallback.
      if (['INBOUND_NOT_FOUND','INBOUND_ID_MISMATCH','INBOUND_RESPONSE_INCOMPLETE','NODE_CONNECTION_CHANGED'].includes(err?.code)) throw err;
      onError(node, err);
      if (retries.size < 512) retries.set(key, now()+retryMs);
      if (cached?.inbound) return cached.inbound;
      throw err;
    }).finally(() => jobs.delete(key));
    jobs.set(key, job);
    return job;
  };
}
module.exports = { connectionKey, createInboundRevalidator };
