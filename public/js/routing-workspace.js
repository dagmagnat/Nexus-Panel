'use strict';

(() => {
  const workspace = document.querySelector('.routing-workspace');
  if (!workspace) return;
  const tabs = [...workspace.querySelectorAll('[data-routing-tab]')];
  const panels = [...workspace.querySelectorAll('[data-routing-panel]')];
  let catalogLoaded = false;
  const activate = (key, remember = true) => {
    if (!tabs.some(tab => tab.dataset.routingTab === key)) key = 'rules';
    panels.forEach(panel => { panel.hidden = panel.dataset.routingPanel !== key; });
    tabs.forEach(tab => {
      const active = tab.dataset.routingTab === key;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    const selected = tabs.find(tab => tab.dataset.routingTab === key);
    const nav = selected.parentElement;
    if (matchMedia('(max-width:1040px)').matches) {
      nav.scrollLeft = selected.offsetLeft - (nav.clientWidth - selected.clientWidth) / 2;
    }
    if (remember) history.replaceState(null, '', '#routing-' + key);
    if (key === 'sources' && !catalogLoaded) {
      catalogLoaded = true;
      loadGeodataCatalog(false);
    }
  };
  window.activateRoutingPanel = activate;
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab.dataset.routingTab));
    tab.addEventListener('keydown', event => {
      const step = ['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? -1 : 0;
      if (!step && !['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + step + tabs.length) % tabs.length;
      activate(tabs[next].dataset.routingTab);
      tabs[next].focus();
    });
  });
  workspace.querySelector('form').addEventListener('invalid', event => {
    const panel = event.target.closest('[data-routing-panel]');
    if (panel) activate(panel.dataset.routingPanel);
  }, true);
  window.addEventListener('hashchange', () => activate(location.hash.replace('#routing-', ''), false));
  activate(location.hash.replace('#routing-', ''), false);
})();
