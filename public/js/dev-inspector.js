(function () {
  'use strict';

  const pageTemplates = [
    [/^\/dashboard/, 'views/dashboard.ejs'],
    [/^\/clients\/[^/]+/, 'views/client_detail.ejs'],
    [/^\/clients/, 'views/clients.ejs'],
    [/^\/nodes\/[^/]+\/edit/, 'views/node_edit.ejs'],
    [/^\/nodes/, 'views/nodes.ejs'],
    [/^\/vpn/, 'views/vpn.ejs'],
    [/^\/routing/, 'views/routing.ejs'],
    [/^\/redirects/, 'views/redirects.ejs'],
    [/^\/diagnostics/, 'views/diagnostics.ejs'],
    [/^\/telegram-bot/, 'views/telegram_bot.ejs'],
    [/^\/settings/, 'views/settings.ejs'],
    [/^\/more/, 'views/more.ejs'],
    [/^\/login/, 'views/login.ejs']
  ];

  function templateForPath(pathname) {
    const found = pageTemplates.find(function (entry) { return entry[0].test(pathname); });
    return found ? found[1] : 'views/partials_header.ejs / views/partials_footer.ejs';
  }

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function usefulClasses(element) {
    const ignored = new Set(['active', 'is-active', 'hidden', 'open', 'selected', 'loading', 'disabled']);
    return Array.from(element.classList || [])
      .filter(function (name) { return name && !ignored.has(name) && !/^js-/.test(name); })
      .slice(0, 3);
  }

  function segmentFor(element) {
    if (element.id) return '#' + cssEscape(element.id);
    let segment = element.tagName.toLowerCase();
    const classes = usefulClasses(element);
    if (classes.length) segment += '.' + classes.map(cssEscape).join('.');

    const parent = element.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(function (item) {
        return item.tagName === element.tagName && usefulClasses(item).join(' ') === classes.join(' ');
      });
      if (siblings.length > 1) segment += ':nth-of-type(' + (siblings.indexOf(element) + 1) + ')';
    }
    return segment;
  }

  function selectorFor(element) {
    const parts = [];
    let current = element;
    while (current && current !== document.body && parts.length < 5) {
      const segment = segmentFor(current);
      parts.unshift(segment);
      if (segment.startsWith('#')) break;
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  function compactText(element) {
    return String(element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);
  }

  function copyText(text, textarea) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    textarea.value = text;
    textarea.focus();
    textarea.select();
    document.execCommand('copy');
    return Promise.resolve();
  }

  function boot() {
    const style = document.createElement('style');
    style.textContent = [
      '.dev-inspector-launch{position:fixed;right:16px;bottom:16px;z-index:2147483000;border:0;border-radius:999px;padding:10px 14px;background:#111827;color:#fff;font:600 13px/1.2 system-ui;box-shadow:0 8px 30px rgba(0,0,0,.25);cursor:pointer}',
      '.dev-inspector-launch.is-on{background:#dc2626}',
      '.dev-inspector-panel{position:fixed;right:16px;bottom:64px;z-index:2147483001;width:min(430px,calc(100vw - 32px));max-height:70vh;overflow:auto;background:#fff;color:#111827;border:1px solid #d1d5db;border-radius:14px;padding:14px;box-shadow:0 18px 50px rgba(0,0,0,.28);font:13px/1.45 system-ui}',
      '.dev-inspector-panel[hidden]{display:none}',
      '.dev-inspector-panel strong{display:block;margin-bottom:8px}',
      '.dev-inspector-panel label{display:block;margin-top:9px;font-weight:600}',
      '.dev-inspector-panel code,.dev-inspector-panel textarea{display:block;width:100%;box-sizing:border-box;margin-top:4px;padding:8px;border:1px solid #d1d5db;border-radius:8px;background:#f9fafb;color:#111827;overflow-wrap:anywhere;white-space:pre-wrap}',
      '.dev-inspector-panel textarea{min-height:120px;resize:vertical;font:12px/1.4 ui-monospace,monospace}',
      '.dev-inspector-actions{display:flex;gap:8px;margin-top:10px}',
      '.dev-inspector-actions button{border:0;border-radius:8px;padding:8px 10px;cursor:pointer;background:#2563eb;color:#fff}',
      '.dev-inspector-actions button:last-child{background:#e5e7eb;color:#111827}',
      '.dev-inspector-target{outline:3px solid #ef4444!important;outline-offset:2px!important;cursor:crosshair!important}'
    ].join('\n');
    document.head.appendChild(style);

    const launch = document.createElement('button');
    launch.type = 'button';
    launch.className = 'dev-inspector-launch';
    launch.textContent = '◎ UI inspector';
    launch.title = 'Dev-only: выбрать элемент интерфейса';

    const panel = document.createElement('section');
    panel.className = 'dev-inspector-panel';
    panel.hidden = true;
    panel.innerHTML = '<strong>Точка изменения UI</strong>' +
      '<label>Шаблон</label><code data-dev-template></code>' +
      '<label>CSS-селектор</label><code data-dev-selector></code>' +
      '<label>Готовая задача</label><textarea data-dev-task></textarea>' +
      '<div class="dev-inspector-actions"><button type="button" data-dev-copy>Копировать задачу</button><button type="button" data-dev-close>Закрыть</button></div>';

    document.body.appendChild(launch);
    document.body.appendChild(panel);

    let inspecting = false;
    let hovered = null;

    function setInspecting(value) {
      inspecting = value;
      launch.classList.toggle('is-on', value);
      launch.textContent = value ? '× Отменить выбор' : '◎ UI inspector';
      if (!value && hovered) {
        hovered.classList.remove('dev-inspector-target');
        hovered = null;
      }
    }

    launch.addEventListener('click', function () { setInspecting(!inspecting); });
    panel.querySelector('[data-dev-close]').addEventListener('click', function () { panel.hidden = true; });

    document.addEventListener('mouseover', function (event) {
      if (!inspecting) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || panel.contains(target) || launch.contains(target)) return;
      if (hovered && hovered !== target) hovered.classList.remove('dev-inspector-target');
      hovered = target;
      hovered.classList.add('dev-inspector-target');
    }, true);

    document.addEventListener('click', function (event) {
      if (!inspecting) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || panel.contains(target) || launch.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();

      const pathname = window.location.pathname;
      const template = templateForPath(pathname);
      const selector = selectorFor(target);
      const text = compactText(target);
      const task = [
        'Экран: ' + pathname,
        'Шаблон: ' + template,
        'Селектор: ' + selector,
        text ? 'Текст элемента: ' + text : '',
        'Нужно изменить: '
      ].filter(Boolean).join('\n');

      panel.querySelector('[data-dev-template]').textContent = template;
      panel.querySelector('[data-dev-selector]').textContent = selector;
      panel.querySelector('[data-dev-task]').value = task;
      panel.hidden = false;
      setInspecting(false);
    }, true);

    panel.querySelector('[data-dev-copy]').addEventListener('click', function () {
      const textarea = panel.querySelector('[data-dev-task]');
      copyText(textarea.value, textarea).then(function () {
        const button = panel.querySelector('[data-dev-copy]');
        const old = button.textContent;
        button.textContent = 'Скопировано';
        setTimeout(function () { button.textContent = old; }, 1200);
      }).catch(function () {});
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
