(function () {
  'use strict';
  function boot() {
    const form = document.getElementById('nodeEditForm');
    const title = document.querySelector('[data-node-preview-name]');
    const type = document.querySelector('[data-node-preview-type]');
    if (!form || !title || !type) return;
    const value = name => String(form.elements.namedItem(name)?.value || '').trim();
    function refresh() {
      const select = form.elements.namedItem('country_code');
      const code = value('country_code');
      const custom = code === 'ZZ';
      const country = custom ? (value('custom_country_name_ru') || 'Свой регион') : String(select?.selectedOptions[0]?.textContent || '').trim();
      const flag = custom ? value('custom_country_flag') : (/^[A-Z]{2}$/.test(code) ? Array.from(code, char => String.fromCodePoint(127397 + char.charCodeAt(0))).join('') : '');
      const suffix = value('label_suffix');
      const name = suffix ? (/^\d+$/.test(suffix) ? `${country}-${suffix}` : `${country} ${suffix}`) : country;
      title.textContent = [flag, name].filter(Boolean).join(' ');
      type.textContent = value('node_type') === 'remnawave' ? 'Remnawave · имя провайдера может зависеть от режима подписи' : '3x-ui · ' + (value('inbound_network') || 'транспорт из inbound');
    }
    form.addEventListener('input', refresh);
    form.addEventListener('change', refresh);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
