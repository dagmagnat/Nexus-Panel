(function (root) {
  'use strict';
  const bytes = value => Math.max(0, Number(value) || 0);
  function summarize(client, nodeId = '') {
    const all = (client.nodes || []).map(node => ({ ...node, usedBytes: bytes(node.usedBytes), limitBytes: bytes(node.limitGb) * 1024 ** 3 }));
    const nodes = nodeId ? all.filter(node => String(node.id) === String(nodeId)) : all;
    const totalUsedBytes = all.reduce((sum, node) => sum + node.usedBytes, 0);
    const usedBytes = nodes.reduce((sum, node) => sum + node.usedBytes, 0);
    const globalLimitBytes = bytes(client.limitGb) * 1024 ** 3;
    const limited = nodes.filter(node => node.limitBytes > 0);
    const exhaustedNodes = limited.filter(node => node.usedBytes >= node.limitBytes);
    const globalExhausted = globalLimitBytes > 0 && totalUsedBytes >= globalLimitBytes;
    return { nodes, limited, exhaustedNodes, usedBytes, totalUsedBytes, globalLimitBytes, globalExhausted,
      hasLimit: globalLimitBytes > 0 || limited.length > 0, exhausted: globalExhausted || exhaustedNodes.length > 0 };
  }
  function text(summary) {
    const gb = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n / 1024 ** 3);
    const parts = [];
    if (summary.globalLimitBytes) parts.push(`Общий: ${gb(summary.totalUsedBytes)} / ${gb(summary.globalLimitBytes)} ГБ${summary.globalExhausted ? ' — исчерпан' : ''}`);
    summary.limited.forEach(node => parts.push(`${node.name || 'Узел'}: ${gb(node.usedBytes)} / ${gb(node.limitBytes)} ГБ${node.usedBytes >= node.limitBytes ? ' — исчерпан' : ''}`));
    return parts.length ? parts.join('\n') : `${gb(summary.usedBytes)} ГБ · без лимита`;
  }
  function headline(summary) {
    const gb = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n / 1024 ** 3);
    const first = summary.globalLimitBytes ? `${gb(summary.totalUsedBytes)} / ${gb(summary.globalLimitBytes)} ГБ`
      : summary.limited.length === 1 ? `${gb(summary.limited[0].usedBytes)} / ${gb(summary.limited[0].limitBytes)} ГБ`
      : `${gb(summary.usedBytes)} ГБ`;
    const second = summary.exhausted ? (summary.globalExhausted ? 'Общий лимит исчерпан' : `Исчерпано лимитов: ${summary.exhaustedNodes.length}`)
      : summary.limited.length > 1 ? `Лимитов по узлам: ${summary.limited.length}` : summary.hasLimit ? 'Лимит не исчерпан' : 'Без лимита';
    return first + '\n' + second;
  }
  const api = { summarize, text, headline };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NexusUsage = api;
})(typeof window !== 'undefined' ? window : globalThis);
