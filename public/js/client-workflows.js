(() => {
  'use strict';

  for (const dialog of document.querySelectorAll('.client-workflow-dialog')) {
    dialog.querySelectorAll('[data-close-dialog]').forEach(button => button.addEventListener('click', () => dialog.close()));
  }

  const bulk = document.getElementById('clientBulkDialog');
  if (bulk) {
    const form = document.getElementById('clientBulkForm');
    const fields = form.elements;
    const allNodes = document.getElementById('bulkAllNodes');
    const picked = document.getElementById('bulkPickedNodes');
    const submit = document.getElementById('bulkSubmit');
    const routes = {
      edit: ['/clients/bulk-change', 'Применить'],
      disable: ['/clients/bulk-change', 'Отключить'],
      reset: ['/clients/traffic/reset-selected', 'Сбросить трафик'],
      remove: ['/clients/bulk-remove-node', 'Убрать из узлов'],
      delete: ['/clients/bulk-delete', 'Удалить клиентов'],
      support: ['/clients/bulk-change', 'Применить'],
    };
    function syncBulkForm() {
      const mode = fields.bulk_action.value;
      const scope = fields.bulk_scope.value;
      const [path, label] = routes[mode];
      form.action = path;
      submit.textContent = label;
      submit.classList.toggle('danger', mode === 'delete' || mode === 'remove');
      fields.node_scope.value = allNodes.checked ? 'all' : 'picked';
      picked.hidden = allNodes.checked;
      picked.open = !allNodes.checked;
      for (const el of form.querySelectorAll('[data-bulk-scope]')) el.hidden = !el.dataset.bulkScope.split(' ').includes(scope);
      for (const el of form.querySelectorAll('[data-bulk-modes]')) el.hidden = !el.dataset.bulkModes.split(' ').includes(mode);
      form.querySelector('[data-custom-support]').hidden = fields.support_mode.value !== 'custom';
      for (const input of form.querySelectorAll('.client-workflow-body :is(input,select)')) input.disabled = Boolean(input.closest('[hidden]'));
      document.getElementById('bulkScopeHint').textContent = {
        all: 'Будут обработаны все клиенты из базы Nexus.',
        group: 'Будут обработаны все клиенты выбранной группы.',
        tag: 'Будут обработаны все клиенты с выбранной меткой.',
        'group-tag': 'Будут обработаны клиенты, которые входят в группу и имеют выбранную метку.',
        selected: 'Отмечено на странице: ' + getUniqueClientSelection().size,
      }[scope];
      document.getElementById('bulkDisableHint').textContent = allNodes.checked
        ? 'Подписки клиентов будут выключены целиком.'
        : 'Доступ будет снят только на отмеченных узлах.';
    }
    document.getElementById('openClientBulkDialog').addEventListener('click', () => {
      form.reset();
      if (getUniqueClientSelection().size) fields.bulk_scope.value = 'selected';
      syncBulkForm();
      bulk.showModal();
    });
    form.addEventListener('change', syncBulkForm);
    form.addEventListener('submit', event => {
      form.querySelectorAll('[data-selected-id]').forEach(input => input.remove());
      const ids = fields.bulk_scope.value === 'selected' ? getUniqueClientSelection() : null;
      const nodeScope = fields.node_scope;
      const needsNodes = fields.bulk_action.value !== 'edit' || fields.traffic_gb.value !== '' || fields.assign_nodes.checked;
      let error = '';
      if (ids && !ids.size) error = 'Отметьте клиентов или выберите другую область.';
      else if (!nodeScope.disabled && nodeScope.value === 'picked' && needsNodes && !form.querySelector('[name="node_ids"]:checked')) {
        error = 'Отметьте хотя бы один узел.';
      }
      if (error) {
        event.preventDefault();
        document.getElementById('bulkScopeHint').textContent = error;
        return;
      }
      for (const id of ids || []) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'client_ids';
        input.value = id;
        input.dataset.selectedId = '1';
        form.append(input);
      }
      if (fields.bulk_action.value === 'disable' || fields.bulk_action.value === 'reset') {
        if (!window.confirm(submit.textContent + '? ' + document.getElementById('bulkScopeHint').textContent)) event.preventDefault();
      }
    });
  }

  const createForm = document.getElementById('createNexusClientForm');
  if (createForm) {
    const profile = createForm.elements.router_profile;
    const activation = createForm.elements.start_on_activation;
    const rows = [...createForm.querySelectorAll('[data-create-node-protocol]')];
    let protocolRequest;
    function applyRouterFilter() {
      activation.disabled = profile.checked;
      for (const row of rows) {
        const protocol = row.dataset.createNodeProtocol.toLowerCase();
        const hide = profile.checked && protocol && protocol !== 'vless';
        row.hidden = Boolean(hide);
        for (const input of row.querySelectorAll('input')) {
          input.disabled = Boolean(hide);
          if (hide && input.type === 'checkbox') input.checked = false;
        }
      }
    }
    profile.addEventListener('change', async () => {
      applyRouterFilter();
      if (!profile.checked || !rows.some(row => !row.dataset.createNodeProtocol)) return;
      protocolRequest ||= fetch('/clients/node-protocols.json').then(response => {
        if (!response.ok) throw Error('Node protocols unavailable');
        return response.json();
      }).catch(() => { protocolRequest = null; });
      const result = await protocolRequest;
      if (!result) return;
      const byId = new Map(result.nodes.map(node => [String(node.id), node]));
      for (const row of rows) {
        const node = byId.get(row.dataset.createNodeId);
        if (!node?.protocol) continue;
        row.dataset.createNodeProtocol = node.protocol;
        row.querySelector('[data-create-node-protocol-label]').textContent = node.label;
      }
      applyRouterFilter();
    });
  }

  const dialog = document.getElementById('clientAppDialog');
  if (!dialog) return;
  const apps = { happ: 'Happ', incy: 'INCY', karing: 'Karing', router: 'Роутер', sub: 'Обычная SUB' };
  const choices = document.getElementById('clientAppChoices');
  const buttons = choices.querySelectorAll('[data-sub-app]');
  const status = document.getElementById('clientAppStatus');
  const image = document.getElementById('clientAppQr');
  const copy = document.getElementById('clientAppCopy');
  const routerDetails = document.getElementById('clientRouterNodes');
  const routerStatus = document.getElementById('clientRouterNodesStatus');
  const routerField = document.getElementById('clientRouterNodeField');
  const routerNode = document.getElementById('clientRouterNode');
  const copyNode = document.getElementById('clientRouterNodeCopy');
  let clientId, pending, nodeRequest, currentLink, nodeLinks = [];
  function clearPreview(message) {
    if (pending) pending.abort();
    if (nodeRequest) nodeRequest.abort();
    currentLink = '';
    nodeLinks = [];
    routerDetails.hidden = true;
    routerDetails.open = false;
    routerField.hidden = copyNode.hidden = true;
    image.hidden = true;
    image.removeAttribute('src');
    status.textContent = message;
    copy.disabled = true;
    copy.textContent = 'Копировать ссылку';
  }
  function openAppLinks(trigger) {
    clientId = trigger.dataset.clientAppLinks;
    clearPreview(trigger.hasAttribute('data-copy-first') ? 'Выберите, какую ссылку скопировать' : 'Выберите приложение');
    buttons.forEach(button => button.setAttribute('aria-pressed', 'false'));
    document.getElementById('clientAppTitle').textContent = 'Подписка · ' + trigger.dataset.clientTitle;
    dialog.showModal();
  }
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-client-app-links]');
    if (trigger) openAppLinks(trigger);
  });
  dialog.addEventListener('close', () => clearPreview(''));
  choices.addEventListener('click', async event => {
    const button = event.target.closest('[data-sub-app]');
    if (!button) return;
    const app = button.dataset.subApp;
    const name = apps[app];
    clearPreview('Подготавливаю ссылку ' + name + '…');
    buttons.forEach(choice => choice.setAttribute('aria-pressed', String(choice === button)));
    const controller = new AbortController();
    pending = controller;
    try {
      const response = await fetch('/clients/' + encodeURIComponent(clientId) + '/app-subscription', {
        method: 'POST',
        body: new URLSearchParams({ app }),
        signal: controller.signal,
      });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(result.error || 'Ссылка недоступна.');
      currentLink = result.importUrl || result.link;
      status.textContent = {
        router: 'HTTPS-подписка VLESS для RouteWolf и Forkop. Для Podkop выберите отдельный узел ниже.',
        sub: 'Обычная HTTPS-подписка для Hiddify, Forkop и совместимых приложений.',
        karing: 'Сканируйте в Karing. При подтверждении импорта включите X-HWID.',
      }[app] || 'QR-код для ' + name;
      if (result.qr) {
        image.alt = 'QR-код для ' + name;
        image.src = result.qr;
        image.hidden = false;
      }
      routerDetails.hidden = app !== 'router';
      copy.textContent = app === 'router' || app === 'sub' ? 'Копировать подписку' : 'Копировать ссылку ' + name;
      copy.disabled = false;
      copyImport.hidden = !currentImportUrl;
    } catch (error) {
      if (!controller.signal.aborted) status.textContent = error instanceof SyntaxError ? 'Ссылка недоступна. Обновите страницу.' : error.message;
    }
  });
  routerDetails.addEventListener('toggle', async () => {
    if (!routerDetails.open || routerDetails.hidden || nodeLinks.length) return;
    if (nodeRequest) nodeRequest.abort();
    const controller = new AbortController();
    nodeRequest = controller;
    routerStatus.textContent = 'Загружаю ссылки узлов…';
    try {
      const response = await fetch('/clients/' + encodeURIComponent(clientId) + '/app-subscription', {
        method: 'POST', body: new URLSearchParams({ app: 'router', detail: 'nodes' }), signal: controller.signal,
      });
      const result = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw Error(result.error || 'Ссылки узлов недоступны.');
      nodeLinks = result.nodes;
      routerNode.replaceChildren(...nodeLinks.map((item, index) => new Option(item.label, String(index))));
      routerField.hidden = copyNode.hidden = !nodeLinks.length;
      routerStatus.textContent = nodeLinks.length ? '' : 'Нет доступных узлов VLESS или Shadowsocks.';
    } catch (error) {
      if (!controller.signal.aborted) routerStatus.textContent = error.message;
    }
  });
  async function copyLink(value) {
    if (!value) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const field = document.createElement('textarea');
        field.value = value;
        field.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
        dialog.append(field);
        field.select();
        try {
          if (!document.execCommand('copy')) throw Error('Clipboard unavailable');
        } finally {
          field.remove();
        }
      }
      status.textContent = 'Ссылка скопирована';
    } catch {
      status.textContent = 'Не удалось скопировать ссылку';
    }
  }
  copy.addEventListener('click', () => copyLink(currentLink));
  copyNode.addEventListener('click', () => copyLink(nodeLinks[Number(routerNode.value)]?.link));

  const params = new URLSearchParams(location.search);
  const routerClient = params.get('router_client');
  if (/^\d+$/.test(routerClient || '')) {
    const trigger = document.querySelector('[data-client-app-links="' + routerClient + '"]');
    if (trigger) {
      openAppLinks(trigger);
      choices.querySelector('[data-sub-app="router"]').click();
    }
    params.delete('router_client');
    history.replaceState(null, '', location.pathname + (params.size ? '?' + params.toString() : ''));
  }
})();
