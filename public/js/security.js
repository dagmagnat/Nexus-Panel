(function () {
  'use strict';

  const meta = document.querySelector('meta[name="csrf-token"]');
  const token = meta ? String(meta.getAttribute('content') || '') : '';
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
  window.fetch = function csrfFetch(input, init) {
    const options = Object.assign({}, init || {});
    const requestMethod = options.method || (input && input.method) || 'GET';

    if (isUnsafeMethod(requestMethod) && isSameOrigin(input)) {
      const headers = new Headers(options.headers || (input && input.headers) || undefined);
      if (!headers.has('X-CSRF-Token')) headers.set('X-CSRF-Token', token);
      options.headers = headers;
    }

    return originalFetch(input, options);
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
  }

  document.addEventListener('submit', function (event) {
    prepareForm(event.target);
  }, true);

  // Native form.submit() bypasses submit events. A few legacy UI helpers use it,
  // so patch it once to preserve CSRF protection for those flows too.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = function secureSubmit() {
    prepareForm(this);
    return nativeSubmit.call(this);
  };
})();
