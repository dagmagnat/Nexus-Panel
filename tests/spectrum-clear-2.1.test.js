'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('dashboard prioritizes online clients and expiry without the large node-state block', () => {
  const dashboard = read('views/dashboard.ejs');
  assert.match(dashboard, /id="dashboardOnlineNowCount"/);
  assert.match(dashboard, /id="dashboardNodesOnlineCount"/);
  assert.match(dashboard, /id="dashboardNodesOfflineCount"/);
  assert.match(dashboard, /id="expiryRangeDays"[\s\S]*value="7"[\s\S]*value="14"[\s\S]*value="30"/);
  assert.match(dashboard, /id="onlineAutoRefresh"[\s\S]*id="onlineRefreshInterval"/);
  assert.match(dashboard, /\[10, 30, 60\]\.includes/);
  assert.match(dashboard, /onlineNodePreviewHtml/);
  assert.match(dashboard, /Последний раз в сети/);
  assert.doesNotMatch(dashboard, /id="aggPulseCard"/);
});

test('client directory refreshes only online state and keeps bulk actions compact', () => {
  const clients = read('views/clients.ejs');
  assert.match(clients, /class="bulk-node-action-row"/);
  assert.match(clients, /class="bulk-row compact-bulk-row"/);
  assert.match(clients, /id="clientOnlineAutoRefresh"/);
  assert.match(clients, /id="clientOnlineRefreshInterval"/);
  assert.match(clients, /id="clientOnlineRefreshNow"/);
  assert.match(clients, /data-client-quick/);
  assert.match(clients, /data-client-edit-card/);
  assert.match(clients, /onclick="openClientEditor/);
  assert.doesNotMatch(clients, /refreshClientSpeedSummary/);
  assert.doesNotMatch(clients, /class="modern-speed-cell"/);
});

test('nodes show per-inbound traffic, progress and refresh availability every minute', () => {
  const nodes = read('views/nodes.ejs');
  assert.match(nodes, /id="nodeAddProgressPercent"/);
  assert.match(nodes, /id="nodeAddEta"/);
  assert.match(nodes, /name="create_existing_clients_on_node"/);
  assert.match(nodes, /setInterval\(refreshNodeStatuses, 60000\)/);
  assert.match(nodes, /Потрачено в Inbound/);
  assert.match(nodes, /скачано \/ отдано/);
});

test('routing layout cannot overlap its summary on desktop or mobile', () => {
  const routing = read('views/routing.ejs');
  const css = read('public/css/spectrum-clear.css');
  assert.match(routing, /\.routing-page-grid \{ display:grid !important;[^}]*grid-template-columns:minmax\(0,3fr\) minmax\(360px,2fr\) !important/);
  assert.match(routing, /\.routing-page-grid > \.routing-summary-card \{ grid-column:auto !important; min-width:0; \}/);
  assert.match(css, /\.routing-summary-card \{ position: static; top: auto; \}/);
  assert.match(css, /\.routing-page-grid > \.routing-editor-card[\s\S]*position: static !important/);
});

test('online aggregation is concurrent and never cached', () => {
  const app = read('app.js');
  assert.match(app, /async function getOnlineClientsForDashboard\(\)[\s\S]*runWithConcurrency\(nodes, 4/);
  assert.match(app, /app\.get\('\/dashboard\/online-clients\.json'[\s\S]{0,300}Cache-Control', 'no-store'/);
});

test('mobile bottom navigation removes its duplicate hamburger and uses compact cards', () => {
  const css = read('public/css/spectrum-clear.css');
  assert.match(css, /\.mobile-nav-bottom \.mobile-menu-toggle \{ display: none; \}/);
  assert.match(css, /\.mobile-client-card \{ padding: 10px/);
  assert.match(css, /\.mobile-client-edit-link \{ display: inline-flex/);
  assert.match(css, /\.bulk-node-action-row, \.compact-bulk-row \{ grid-template-columns: minmax\(0, 1fr\) 112px/);
});
