'use strict';

function getDisplayOrder(db) {
  const nodes = db.prepare('SELECT id FROM nodes ORDER BY COALESCE(sort_order,id),id').all().map(r => String(r.id));
  const autos = db.prepare('SELECT id FROM auto_select_profiles ORDER BY COALESCE(sort_order,id),id').all().map(r => `auto-${r.id}`);
  const fallback = [...autos, ...nodes];
  let saved = [];
  try { saved = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='node_display_order'").get()?.value || '[]'); } catch (_) {}
  if (!Array.isArray(saved)) saved = [];
  const known = new Set(fallback);
  return [...new Set([...saved.map(String).filter(k => known.has(k)), ...fallback])];
}

function saveDisplayOrder(db, requested) {
  if (!Array.isArray(requested) || !requested.length) throw new RangeError('Пустой порядок узлов');
  const order = requested.map(String), base = getDisplayOrder(db), known = new Set(base);
  if (new Set(order).size !== order.length || order.some(k => !known.has(k))) throw new RangeError('В списке есть неизвестные или повторяющиеся узлы');
  // Old clients may submit only physical nodes: preserve the virtual slots.
  const selected = new Set(order); let index = 0;
  const merged = base.map(k => selected.has(k) ? order[index++] : k);
  db.transaction(() => {
    const node = db.prepare('UPDATE nodes SET sort_order=? WHERE id=?');
    const auto = db.prepare('UPDATE auto_select_profiles SET sort_order=? WHERE id=?');
    merged.forEach((key, i) => key.startsWith('auto-') ? auto.run(i + 1, Number(key.slice(5))) : node.run(i + 1, Number(key)));
    db.prepare("INSERT OR REPLACE INTO app_settings(key,value) VALUES('node_display_order',?)").run(JSON.stringify(merged));
  })();
  return merged;
}

function orderConfigs(db, configs, keyFor) {
  const ranks = new Map(getDisplayOrder(db).map((key, i) => [key, i]));
  return configs.map((config, i) => ({config, i, rank:ranks.get(String(keyFor(config))) ?? Number.MAX_SAFE_INTEGER}))
    .sort((a,b) => a.rank - b.rank || a.i - b.i).map(x => x.config);
}
module.exports = {getDisplayOrder, saveDisplayOrder, orderConfigs};
