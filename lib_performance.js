'use strict';

// Process-local read-only caches: never cache authorization or quota decisions.
function createAsyncReadCache({ ttlMs = 5000, maxEntries = 16, now = Date.now } = {}) {
  const entries = new Map();
  return function read(key, load) {
    const old = entries.get(key);
    if (old && (old.pending || old.until > now())) return old.promise;
    entries.delete(key);
    for (const [name, entry] of entries) {
      if (!entry.pending && entry.until <= now()) entries.delete(name);
    }
    if (entries.size >= maxEntries) {
      const victim = [...entries].find(([, entry]) => !entry.pending);
      if (victim) entries.delete(victim[0]);
    }
    const entry = { pending: true, until: 0 };
    entry.promise = Promise.resolve().then(load).then(value => {
      entry.until = now() + ttlMs;
      return value;
    }).catch(error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    }).finally(() => { entry.pending = false; });
    // Bound retained entries even during a burst of distinct keys.
    if (entries.size < maxEntries) entries.set(key, entry);
    return entry.promise;
  };
}

const yieldToRequests = () => new Promise(resolve => setImmediate(resolve));
async function cooperativeMap(items, map, batchSize = 10) {
  const result = [];
  await yieldToRequests();
  for (let index = 0; index < items.length; index++) {
    result.push(map(items[index], index));
    if ((index + 1) % batchSize === 0) await yieldToRequests();
  }
  return result;
}

module.exports = { createAsyncReadCache, cooperativeMap, yieldToRequests };
