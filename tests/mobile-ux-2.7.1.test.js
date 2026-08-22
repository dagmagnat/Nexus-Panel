'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('PWA manifest uses separate opaque regular and maskable Nexus icons', () => {
  const manifest = JSON.parse(read('public/site.webmanifest'));
  assert.equal(manifest.background_color, '#071126');
  assert.equal(manifest.theme_color, '#071126');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'any' && icon.src === '/img/nexus-icon-512.png'));
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable' && icon.src === '/img/nexus-icon-maskable-512.png'));
  for (const icon of manifest.icons) {
    assert.ok(fs.existsSync(path.join(root, 'public', icon.src.replace(/^\//, '').replace(/^img\//, 'img/'))));
  }
});

test('dashboard has period traffic endpoint, client detail modal and working expiry horizon', () => {
  const app = read('app.js');
  const dashboard = read('views/dashboard.ejs');
  assert.match(app, /TOP_CLIENT_USAGE_PERIODS/);
  assert.match(app, /\/dashboard\/top-client-usage\.json/);
  assert.match(app, /buildTopClientPeriodUsageReport/);
  assert.match(dashboard, /value="three_days"/);
  assert.match(dashboard, /id="topUsageDetailModal"/);
  assert.match(dashboard, /dayValue >= 0 && dayValue <= rangeDays/);
});

test('mobile node, client editor, online list and XHTTP controls have dedicated layouts', () => {
  const nodes = read('views/nodes.ejs');
  const clients = read('views/clients.ejs');
  const dashboard = read('views/dashboard.ejs');
  const nodeEdit = read('views/node_edit.ejs');
  const css = read('public/css/spectrum-clear.css');
  assert.match(nodes, /node-mobile-quick-actions/);
  assert.match(nodes, />Проверить</);
  assert.match(nodes, /\/toggle/);
  assert.match(clients, /client-editor-header/);
  assert.match(clients, /data-tag-multiselect/);
  assert.match(dashboard, /online-client-expiry-v4[^<]*>до/);
  assert.match(css, /height:\s*100dvh/);
  assert.match(nodeEdit, /xhttp-settings-grid/);
});

test('Happ built-in info includes global traffic usage', () => {
  const app = read('app.js');
  assert.match(app, /📊 Трафик: \{traffic_usage\}/);
  assert.match(app, /repairHappTrafficInfoTemplate\(\)/);
});
