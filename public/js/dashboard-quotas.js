(() => {
  'use strict';
  let clients = [], pending = false, timer;
  const el = id => document.getElementById(id);
  function render() {
    const query = el('quotaSearch').value.trim().toLocaleLowerCase('ru');
    const nodeId = el('quotaNode').value;
    const mode = el('quotaFilter').value;
    const rows = clients.map(client => ({ client, summary: NexusUsage.summarize(client, nodeId) }))
      .filter(({ client, summary }) => (!nodeId || summary.nodes.length) && (mode === 'exhausted' ? summary.exhausted : summary.hasLimit)
        && (!query || `${client.name} ${client.login} ${client.id}`.toLocaleLowerCase('ru').includes(query)))
      .sort((a, b) => el('quotaSort').value === 'name' ? a.client.name.localeCompare(b.client.name, 'ru', { numeric: true })
        : (el('quotaSort').value === 'asc' ? 1 : -1) * (a.summary.usedBytes - b.summary.usedBytes) || a.client.id - b.client.id);
    const list = el('quotaList');
    list.replaceChildren();
    for (const { client, summary } of rows) {
      const link = document.createElement('a');
      link.className = 'quota-client-row' + (summary.exhausted ? ' is-limit-exhausted' : '');
      link.href = `/clients?edit=${encodeURIComponent(client.id)}`;
      const name = document.createElement('strong'); name.textContent = client.name || client.login;
      const usage = document.createElement('span'); usage.textContent = NexusUsage.text(summary);
      link.append(name, usage); list.append(link);
    }
    if (!rows.length) list.textContent = 'Нет клиентов по выбранным условиям.';
  }
  async function refresh() {
    if (pending) return;
    pending = true; clearTimeout(timer);
    try {
      const response = await fetch('/clients/usage.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Нет свежих данных');
      const data = await response.json(); clients = data.clients || [];
      const select = el('quotaNode'), selected = select.value;
      const nodes = new Map(); clients.forEach(client => (client.nodes || []).forEach(node => nodes.set(String(node.id), node.name)));
      select.replaceChildren(new Option('Все узлы', ''));
      nodes.forEach((name, id) => select.add(new Option(name, id)));
      if (nodes.has(selected)) select.value = selected;
      render();
      el('quotaStatus').textContent = `${data.refreshing ? 'Обновляю ГБ…' : 'Снимок: ' + (data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('ru') : 'кэш')}${data.errors?.length ? ' · часть узлов недоступна; их данные сохранены' : ''}`;
      el('quotaStatus').title = (data.errors || []).join(' | ');
      timer = setTimeout(() => { if (!document.hidden) refresh(); }, data.refreshing ? 3000 : 30000);
    } catch (_) { el('quotaStatus').textContent = 'Не удалось обновить ГБ. Показаны прежние данные.'; }
    finally { pending = false; }
  }
  ['quotaNode', 'quotaFilter', 'quotaSort'].forEach(id => el(id).addEventListener('change', render));
  el('quotaSearch').addEventListener('input', render);
  el('quotaRefresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  refresh();
})();
