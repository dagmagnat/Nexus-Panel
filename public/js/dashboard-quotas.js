(() => {
  'use strict';
  let clients = [], pending = false, timer, consecutiveErrors = 0, page = 1, visible = false;
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
    const size = el('quotaPageSize')?.value === 'all' ? Math.max(1, rows.length) : Number(el('quotaPageSize')?.value || 20);
    const pages = Math.max(1, Math.ceil(rows.length / size)); page = Math.min(page, pages);
    if (el('quotaPageInfo')) el('quotaPageInfo').textContent = `${page} / ${pages} · клиентов: ${rows.length}`;
    if (el('quotaPrev')) el('quotaPrev').disabled = page <= 1;
    if (el('quotaNext')) el('quotaNext').disabled = page >= pages;
    list.replaceChildren();
    for (const { client, summary } of rows.slice((page - 1) * size, page * size)) {
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
    if (pending || !visible || document.hidden) return;
    pending = true; clearTimeout(timer);
    try {
      const response = await fetch('/clients/usage.json', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error('Нет свежих данных');
      const data = await response.json(); clients = data.clients || [];
      consecutiveErrors = 0; // Reset error counter on success
      const select = el('quotaNode'), selected = select.value;
      const nodes = new Map(); clients.forEach(client => (client.nodes || []).forEach(node => nodes.set(String(node.id), node.name)));
      select.replaceChildren(new Option('Все узлы', ''));
      nodes.forEach((name, id) => select.add(new Option(name, id)));
      if (nodes.has(selected)) select.value = selected;
      render();
      el('quotaStatus').textContent = `${data.refreshing ? 'Обновляю ГБ…' : 'Снимок: ' + (data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString('ru') : 'кэш')}${data.errors?.length ? ' · часть узлов недоступна; их данные сохранены' : ''}`;
      el('quotaStatus').title = (data.errors || []).join(' | ');
      // Smart refresh interval: faster when refreshing, slower when stable
      const interval = data.refreshing ? 3000 : 30000;
      timer = setTimeout(() => { if (!document.hidden) refresh(); }, interval);
    } catch (_) { 
      consecutiveErrors++;
      el('quotaStatus').textContent = 'Не удалось обновить ГБ. Показаны прежние данные.'; 
      // Exponential backoff on errors: 30s, 60s, 120s, max 300s (5 minutes)
      const backoffInterval = Math.min(30000 * Math.pow(2, consecutiveErrors - 1), 300000);
      timer = setTimeout(() => { if (!document.hidden) refresh(); }, backoffInterval);
    }
    finally { pending = false; }
  }
  ['quotaNode', 'quotaFilter', 'quotaSort', 'quotaPageSize'].forEach(id => el(id)?.addEventListener('change', () => { page = 1; render(); }));
  el('quotaSearch').addEventListener('input', () => { page = 1; render(); });
  el('quotaPrev')?.addEventListener('click', () => { page = Math.max(1, page - 1); render(); });
  el('quotaNext')?.addEventListener('click', () => { page++; render(); });
  el('quotaRefresh').addEventListener('click', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && visible) refresh(); });
  const card = el('quotaList')?.closest('section');
  if (card && 'IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting);
      if (visible) refresh(); else clearTimeout(timer);
    }).observe(card);
  } else { visible = true; refresh(); }
})();
