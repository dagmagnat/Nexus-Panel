'use strict';

window.initRoutingDnsPickers = function(root = document) {
  root.querySelectorAll('[data-dns-picker]').forEach(picker => {
    if (picker.dataset.dnsReady) return;
    picker.dataset.dnsReady = '1';
    const inputs = [...picker.querySelectorAll('[data-dns-option]')];
    const sync = () => {
      let previous;
      try { previous = JSON.parse(picker.dataset.dnsOrder); } catch (_) { previous = []; }
      if (!Array.isArray(previous)) previous = [];
      const checked = inputs.filter(input => input.checked);
      const keys = checked.map(input => input.value);
      const order = [...new Set([...previous.filter(key => keys.includes(key)), ...keys])];
      picker.dataset.dnsOrder = JSON.stringify(order);
      const hidden = picker.querySelector('[data-dns-picker-value]');
      if (hidden) hidden.value = JSON.stringify(order);
      picker.querySelector('[data-dns-picker-summary]').textContent = order
        .map(key => inputs.find(input => input.value === key).dataset.dnsLabel).join(', ') || 'Выбрать DNS';
      inputs.forEach(input => {
        const position = order.indexOf(input.value);
        input.closest('label').querySelector('[data-dns-priority]').textContent = position < 0 ? '' : String(position + 1);
      });
    };
    picker.addEventListener('change', sync);
    sync();
  });
};
window.initRoutingDnsPickers();
