(() => {
  const root = document.documentElement;
  if (root.dataset.interfaceTheme !== 'coreui') return;

  const railToggle = document.querySelector('[data-coreui-rail-toggle]');
  if (railToggle) {
    const storageKey = 'nexus.coreui.sidebar.collapsed';
    function setRail(collapsed) {
      root.toggleAttribute('data-coreui-rail-collapsed', collapsed);
      railToggle.setAttribute('aria-expanded', String(!collapsed));
      railToggle.setAttribute('aria-label', collapsed ? 'Развернуть боковое меню' : 'Свернуть боковое меню');
    }
    try { setRail(localStorage.getItem(storageKey) === '1'); } catch (_) {}
    railToggle.addEventListener('click', () => {
      const collapsed = !root.hasAttribute('data-coreui-rail-collapsed');
      setRail(collapsed);
      try { localStorage.setItem(storageKey, collapsed ? '1' : '0'); } catch (_) {}
    });
    for (const link of document.querySelectorAll('#panelSidebar .spectrum-nav a')) {
      link.title = link.textContent.trim();
    }
  }

  for (const toggle of document.querySelectorAll('[data-coreui-group-toggle]')) {
    const group = toggle.parentElement;
    toggle.addEventListener('click', () => {
      const collapsed = group.toggleAttribute('data-coreui-group-closed');
      toggle.setAttribute('aria-expanded', String(!collapsed));
    });
  }

  const account = document.querySelector('[data-coreui-account]');
  const search = document.querySelector('[data-coreui-search]');
  const scrollBox = document.querySelector('#coreuiOnline #onlineClientsList');
  document.addEventListener('pointerdown', event => {
    if (account?.open && !account.contains(event.target)) account.open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && account?.open) {
      account.open = false;
      account.querySelector('summary').focus();
    }
    if (event.key === '/' && (event.ctrlKey || event.metaKey) && search?.offsetWidth) {
      event.preventDefault();
      search.focus();
    }
  });
  if (scrollBox) scrollBox.tabIndex = 0;

  const chart = document.querySelector('[data-coreui-traffic]');
  if (!chart) return;
  const select = chart.querySelector('[data-traffic-days]');
  const total = chart.querySelector('[data-traffic-total]');
  const status = chart.querySelector('[data-traffic-status]');
  const plot = chart.querySelector('[data-traffic-plot]');
  const scale = chart.querySelector('[data-traffic-scale]');
  const bars = chart.querySelector('[data-traffic-bars]');
  const dates = chart.querySelector('[data-traffic-dates]');
  const amount = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });
  let pending;

  function shortDate(date) {
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.slice(-2) + '.' + date.slice(5, 7) : '—';
  }

  function render(data) {
    const rows = data.series.map(point => ({
      date: shortDate(String(point.d || '')),
      gb: Number.isFinite(Number(point.gb)) ? Math.max(0, Number(point.gb)) : 0
    }));
    const max = Math.max(0, ...rows.map(row => row.gb));
    total.textContent = data.totalText || '—';
    if (!max) {
      status.textContent = 'За этот период нет записанного трафика.';
      return;
    }

    const unit = 10 ** Math.floor(Math.log10(max));
    const ceiling = Math.ceil(max / unit) * unit;
    scale.replaceChildren(...[1, 0.75, 0.5, 0.25, 0].map(tick => {
      const label = document.createElement('span');
      label.textContent = amount.format(tick * ceiling);
      return label;
    }));
    const prompt = 'Выберите столбец, чтобы увидеть объём за день.';
    status.textContent = prompt;
    bars.replaceChildren(...rows.map(row => {
      const button = document.createElement('button');
      const label = row.date + ' · ' + amount.format(row.gb) + ' ГБ';
      button.type = 'button';
      button.title = label;
      button.setAttribute('aria-label', label);
      button.style.setProperty('--traffic-bar-height', 100 * row.gb / ceiling + '%');
      button.addEventListener('focus', () => { status.textContent = label; });
      button.addEventListener('click', () => { status.textContent = label; });
      return button;
    }));
    dates.replaceChildren(...[0, Math.floor((rows.length - 1) / 2), rows.length - 1].map(index => {
      const label = document.createElement('span');
      label.textContent = rows[index].date;
      return label;
    }));
    plot.hidden = false;
  }

  async function loadTraffic() {
    pending?.abort();
    const request = new AbortController();
    pending = request;
    plot.hidden = true;
    total.textContent = '—';
    status.textContent = 'Загружаю график…';
    try {
      const query = new URLSearchParams({ days: select.value });
      const response = await fetch('/dashboard/traffic-series.json?' + query, {
        headers: { Accept: 'application/json' }, signal: request.signal
      });
      const data = await response.json();
      if (!response.ok || !data.ok || !Array.isArray(data.series)) throw new Error('Traffic data unavailable');
      if (!request.signal.aborted) render(data);
    } catch (_) {
      if (!request.signal.aborted) status.textContent = 'График временно недоступен.';
    }
  }
  select.addEventListener('change', loadTraffic);
  loadTraffic();
})();
