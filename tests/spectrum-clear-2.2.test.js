'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('mobile node cards open the real editor and refresh sequentially once a minute', () => {
  const app = read('app.js');
  const nodes = read('views/nodes.ejs');
  assert.match(nodes, /data-node-edit-url="\/nodes\/<%= node\.id %>\/edit"/);
  assert.match(nodes, /window\.location\.assign\(editUrl\)/);
  assert.match(nodes, /setInterval\(refreshNodeStatuses, 60000\)/);
  assert.match(app, /async function runDashboardHealthSweep\(\)[\s\S]*for \(const node of nodes\)/);
  assert.doesNotMatch(app, /runDashboardHealthSweep\([\s\S]{0,3000}runWithConcurrency/);
});

test('mobile client cards open the local editor and compact its real form', () => {
  const clients = read('views/clients.ejs');
  const footer = read('views/partials_footer.ejs');
  const css = read('public/css/spectrum-clear.css');
  assert.match(clients, /data-client-edit-card="<%= client\.id %>"/);
  assert.match(clients, /class="mobile-client-name" onclick="openClientEditor/);
  assert.match(clients, /class="[^"]*client-editor-shell/);
  assert.match(footer, /const localEditor = document\.getElementById\('clientEditor-' \+ id\)/);
  assert.match(css, /\.client-editor-fields \{ display: grid; grid-template-columns: repeat\(2/);
  assert.match(css, /\.mobile-client-metrics \{ display: none; \}/);
});

test('dashboard leads with online and expiry and exposes health failures in place', () => {
  const dashboard = read('views/dashboard.ejs');
  assert.match(dashboard, /id="openOnlineClientsFromStat"/);
  assert.match(dashboard, /id="openExpiryFromStat"/);
  assert.match(dashboard, /id="dashboardNodesHealth"/);
  assert.match(dashboard, /id="dashboardRedirectHealth"/);
  assert.match(dashboard, /id="dashboardNodeIssues"/);
  assert.match(dashboard, /window\.setInterval\(refreshDashboardNodeCounts, 60000\)/);
  assert.match(dashboard, /notifyDashboardHealthOnce/);
});

test('operational errors are translated and displayed prominently', () => {
  const app = read('app.js');
  const footer = read('views/partials_footer.ejs');
  const css = read('public/css/spectrum-clear.css');
  assert.match(app, /function humanizeOperationalError/);
  assert.match(app, /самоподписанный TLS-сертификат/);
  assert.match(footer, /window\.nexusHumanizeError/);
  assert.match(footer, /window\.showNexusNotice/);
  assert.match(css, /\.agg-toast-stack[\s\S]{0,180}left: 50%/);
  assert.match(css, /\.agg-toast-stack \.alert\.err/);
});

test('client identity and subscription URLs remain untouched by the UI patch', () => {
  const app = read('app.js');
  assert.match(app, /uuid TEXT NOT NULL/);
  assert.match(app, /sub_slug TEXT UNIQUE NOT NULL/);
  assert.match(app, /app\.get\('\/sub\/:slug'/);
  assert.match(app, /app\.get\('\/json\/:slug'/);
});
