'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('2.7.1 mobile traffic, compact nodes and desktop density are wired', () => {
  const dashboard = read('views/dashboard.ejs');
  const nodes = read('views/nodes.ejs');
  const nodeEdit = read('views/node_edit.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(dashboard, /id="topUsageDetailModal"/);
  assert.match(css, /#topUsageDetailModal > \.top-usage-detail-modal/);
  assert.match(nodes, /data-node-enabled-indicator/);
  assert.match(nodes, /data-node-live-indicator/);
  assert.match(nodes, /initMobileNodeLongPressOrder/);
  assert.match(css, /\.node-list-row\.is-expanded \.node-mobile-quick-actions/);
  assert.match(css, /100dvh - 84px/);
  assert.match(nodeEdit, /class="field full xhttp-settings-box"/);
  assert.match(css, /\.inline-select-grid/);
});

test('2.7.1 separates client information from editing and aligns client actions', () => {
  const dashboard = read('views/dashboard.ejs');
  const clients = read('views/clients.ejs');
  const footer = read('views/partials_footer.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(dashboard, /dashboard-expiry-devices/);
  assert.match(footer, /Редактировать клиента/);
  assert.match(footer, /client-quick-devices-grid/);
  assert.doesNotMatch(footer, /const localEditor = document\.getElementById\('clientEditor-' \+ id\)/);
  assert.match(clients, /client-summary-links-card/);
  assert.match(clients, /client-summary-qr-card/);
  assert.match(css, /\.client-summary-action-card/);
});

test('2.7.1 applies JSON controls and routing modes to explicit non-overlapping nodes', () => {
  const app = read('app.js');
  const settings = read('views/settings.ejs');
  const routing = read('views/routing.ejs');

  assert.match(app, /isJsonMuxEnabledForNode/);
  assert.match(app, /isJsonSniffingEnabledForNode/);
  assert.match(app, /json_mux_node_ids/);
  assert.match(app, /json_sniffing_node_ids/);
  assert.match(settings, /data-json-node-picker/);
  assert.doesNotMatch(settings, /flagHtml\(/);
  assert.match(settings, /countryFlagText\(/);
  assert.match(app, /modeAssignments/);
  assert.match(app, /getRoutingModeForNode/);
  assert.match(app, /Один узел нельзя использовать одновременно в нескольких режимах/);
  assert.match(routing, /data-routing-mode-card/);
  assert.match(routing, /data-routing-select-all/);
});
