'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('mobile client selection reveals compact actions only after a selection', () => {
  const clients = read('views/clients.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(clients, /id="bulkActionsToggle"[\s\S]{0,180}hidden>Действия<\/button>/);
  assert.match(clients, /id="bulkActionDetails" hidden/);
  assert.match(clients, /function toggleBulkActions\(\)/);
  assert.match(clients, /toggle\.hidden = !hasSelection/);
  assert.match(css, /\.bulk-action-details\[hidden\], \.bulk-actions-toggle\[hidden\]/);
  assert.match(css, /\.bulk-node-action-row, \.compact-bulk-row \{ grid-template-columns: minmax\(0, 1fr\) 104px/);
});

test('phone client list keeps one search, four fitted filters and status rails', () => {
  const clients = read('views/clients.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(css, /\.page-clients \.mobile-client-search-card,[\s\S]{0,100}\.page-clients \.client-overview-strip \{ display: none !important; \}/);
  assert.match(css, /\.mobile-client-tabs \{[\s\S]{0,180}grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(clients, /class="mobile-client-card status-<%= clientStatus\.key %>"/);
  assert.match(css, /\.mobile-client-card::before/);
  assert.match(css, /\.mobile-client-card\.status-warning::before/);
  assert.match(css, /\.mobile-client-card\.status-expired::before,[\s\S]{0,100}\.mobile-client-card\.status-offline::before/);
});

test('mobile client editor separates labels and values and centers node selection', () => {
  const clients = read('views/clients.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(clients, /<span>Узлов<\/span><strong><%= clientAssignedNodes\(client\)\.length %><\/strong>/);
  assert.match(clients, /class="client-summary-uuid"/);
  assert.match(css, /\.client-editor-summary > \* \{ display: flex;[\s\S]{0,130}flex-direction: column/);
  assert.match(css, /\.client-editor-form \.node-select-actions \{[\s\S]{0,150}justify-content: center/);
  assert.match(css, /\.client-editor-form \.node-bulk-head p \{ display: none; \}/);
});

test('phone SNI and panel settings use stable cards instead of narrow columns', () => {
  const settings = read('views/settings.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(settings, /<td data-label="SNI"><code>/);
  assert.match(settings, /class="<%= profile\.is_builtin \? 'sni-action-empty' : '' %>"/);
  assert.match(css, /\.settings-sni-card \.compact-table tr \{ display: grid;[\s\S]{0,120}grid-template-columns: repeat\(2/);
  assert.match(css, /\.settings-sni-card \.compact-table \.sni-action-empty \{ display: none; \}/);
  assert.match(css, /\.panel-settings-card form > \.actions > button \{ width: min\(270px, 100%\)/);
});

test('phone More and Nodes layouts stay compact and node chips omit traffic totals', () => {
  const nodes = read('views/nodes.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(css, /\.stage11-more-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.stage11-more-card small \{ display: none; \}/);
  assert.match(css, /\.page-nodes \.nodes-modern-head \{[\s\S]{0,220}height: auto !important;[\s\S]{0,220}align-content: start !important/);
  assert.match(nodes, /function compactTransportLabel\(label\)/);
  assert.match(nodes, /replace\(\/\^\\s\*\\d\+/);
  assert.match(nodes, /const transportCompact = compactTransportLabel\(transportLabel\)/);
});
