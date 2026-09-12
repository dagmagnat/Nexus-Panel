(function () {
  'use strict';

  const meta = document.querySelector('meta[name="csrf-token"]');
  const token = meta ? String(meta.getAttribute('content') || '') : '';
  const workspace = document.querySelector('meta[name="nexus-workspace"]')?.content || 'main';
  const accessChecksEnabled = Boolean(document.querySelector('meta[name="nexus-workspace"]'));
  if (!token) return;

  function isUnsafeMethod(method) {
    return !['GET', 'HEAD', 'OPTIONS'].includes(String(method || 'GET').toUpperCase());
  }

  function isSameOrigin(input) {
    try {
      const raw = typeof input === 'string' ? input : (input && input.url) || '';
      return new URL(raw, window.location.href).origin === window.location.origin;
    } catch (_) {
      return true;
    }
  }

  const originalFetch = window.fetch.bind(window);
  let accessDialog;
  let previousFocus;
  function showAccessMessage(message) {
    if (!accessDialog) {
      accessDialog = document.createElement('dialog');
      accessDialog.setAttribute('aria-labelledby', 'nexus-access-title');
      accessDialog.style.cssText = 'box-sizing:border-box;width:min(520px,92vw);padding:32px;border:1px solid #56627e;border-radius:20px;background:#142038;color:#f5f7ff;text-align:center;box-shadow:0 24px 90px #0009;font-family:system-ui;z-index:2147483647';
      accessDialog.innerHTML = '<h2 id="nexus-access-title" style="font-size:26px;margin:0 0 16px">Недостаточно прав</h2><p style="font-size:18px;line-height:1.6;margin:0 0 24px"></p><button type="button" style="font-size:17px;padding:12px 32px;border:0;border-radius:10px;background:#5064ee;color:white;cursor:pointer">Понятно</button>';
      document.body.appendChild(accessDialog);
      accessDialog.querySelector('button').addEventListener('click', () => accessDialog.close());
      accessDialog.addEventListener('close', () => previousFocus?.focus?.());
    }
    accessDialog.querySelector('p').textContent = message || 'У вас нет прав для этого действия. Обратитесь к главному администратору.';
    if (!accessDialog.open) { previousFocus = document.activeElement; accessDialog.showModal(); }
  }
  async function checkAccess(url, method) {
    try {
      const query = new URLSearchParams({path:url.pathname, method:String(method || 'GET').toUpperCase(), workspace});
      const response = await originalFetch('/access/check?' + query, {headers:{Accept:'application/json'}, cache:'no-store'});
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('session');
      const result = await response.json();
      if (result.allowed) return true;
      showAccessMessage(result.stale ? 'Пространство изменено в другой вкладке. Обновите страницу перед продолжением.' : undefined);
    } catch (_) { showAccessMessage('Не удалось проверить права. Проверьте соединение и обновите страницу.'); }
    return false;
  }
  window.fetch = function csrfFetch(input, init) {
    const options = Object.assign({}, init || {});
    const requestMethod = options.method || (input && input.method) || 'GET';

    if (isUnsafeMethod(requestMethod) && isSameOrigin(input)) {
      const headers = new Headers(options.headers || (input && input.headers) || undefined);
      if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
      headers.set('X-Nexus-Workspace', workspace);
      options.headers = headers;
    }

    return originalFetch(input, options).then(response => {
      if (isSameOrigin(input) && response.status === 403 && response.headers.get('X-Nexus-Access-Denied') === '1') showAccessMessage();
      return response;
    });
  };

  function prepareForm(form) {
    if (!(form instanceof HTMLFormElement)) return;
    if (!isUnsafeMethod(form.method)) return;

    let action;
    try { action = new URL(form.action || window.location.href, window.location.href); }
    catch (_) { return; }
    if (action.origin !== window.location.origin) return;

    let field = form.querySelector('input[name="_csrf"]');
    if (!field) {
      field = document.createElement('input');
      field.type = 'hidden';
      field.name = '_csrf';
      form.appendChild(field);
    }
    field.value = token;
    let workspaceField = form.querySelector('input[name="_workspace"]');
    if (!workspaceField) {
      workspaceField = document.createElement('input');
      workspaceField.type = 'hidden';
      workspaceField.name = '_workspace';
      form.appendChild(workspaceField);
    }
    workspaceField.value = workspace;
  }

  const replayForms = new WeakSet();
  const pending = new WeakSet();
  document.addEventListener('submit', function (event) {
    prepareForm(event.target);
    if (!accessChecksEnabled) return;
    const form = event.target;
    if (replayForms.has(form)) return;
    const submitter = event.submitter;
    const url = new URL(submitter?.getAttribute('formaction') || form.action || location.href, location.href);
    if (url.origin !== location.origin || url.pathname === '/logout') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending.has(form)) return;
    pending.add(form);
    checkAccess(url, submitter?.getAttribute('formmethod') || form.method).then(allowed => {
      pending.delete(form);
      if (!allowed || !form.isConnected) return;
      replayForms.add(form);
      try { form.requestSubmit(submitter || undefined); } finally { replayForms.delete(form); }
    });
  }, true);

  const replayLinks = new WeakSet();
  document.addEventListener('click', function (event) {
    if (!accessChecksEnabled) return;
    const link = event.target.closest?.('a[href]');
    if (!link || replayLinks.has(link) || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || (link.target && link.target !== '_self')) return;
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || !['http:','https:'].includes(url.protocol) || link.getAttribute('href').startsWith('#') || /^\/(?:access|sub|sub-plain|json|open|happ|hiddify|qr|img|css|js)(?:\/|$)/.test(url.pathname)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (pending.has(link)) return;
    pending.add(link);
    checkAccess(url, 'GET').then(allowed => {
      pending.delete(link);
      if (!allowed || !link.isConnected) return;
      replayLinks.add(link);
      try { link.click(); } finally { replayLinks.delete(link); }
    });
  }, true);

  // Native form.submit() bypasses submit events. A few legacy UI helpers use it,
  // so patch it once to preserve CSRF protection for those flows too.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function secureSubmit() {
    prepareForm(this);
    if (!accessChecksEnabled) return nativeSubmit.call(this);
    const form = this;
    const url = new URL(form.action || location.href, location.href);
    if (url.origin !== location.origin || url.pathname === '/logout' || replayForms.has(form)) return nativeSubmit.call(form);
    if (pending.has(form)) return;
    pending.add(form);
    checkAccess(url, form.method).then(allowed => {
      pending.delete(form);
      if (allowed && form.isConnected) nativeSubmit.call(form);
    });
  };
})();
