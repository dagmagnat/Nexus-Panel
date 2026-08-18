'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('desktop client workspace and dashboard use dense aligned layouts', () => {
  const css = read('public/css/spectrum-clear.css');
  const header = read('views/partials_header.ejs');

  assert.doesNotMatch(header, /currentPath === 'clients'[\s\S]{0,180}Создать клиента/);
  assert.match(css, /\.page-clients \.client-directory-toolbar \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.expiry-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.top-usage-grid \{[\s\S]{0,120}grid-template-columns: repeat\(4, max-content\)/);
  assert.match(css, /\.client-quick-actions\.modern \{[\s\S]{0,120}grid-template-columns: repeat\(3/);
});

test('client editor, QR and routing avoid the marked overlap regressions', () => {
  const clients = read('views/clients.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(css, /\.existing-client-editor-modal \{[\s\S]{0,140}scrollbar-gutter: stable/);
  assert.match(css, /\.client-editor-form \.node-bulk-head \{[\s\S]{0,160}justify-content: space-between/);
  assert.match(clients, /class="qr-format-badge is-json"/);
  assert.doesNotMatch(clients, /class="qr-format-badge json"/);
  assert.match(css, /\.qr-pair-card-head > div \{ display: grid/);
  assert.match(css, /\.routing-form \.preset-card > span \{ display: grid/);
});

test('node add form pairs primary fields and keeps API token content vertical', () => {
  const nodes = read('views/nodes.ejs');
  const footer = read('views/partials_footer.ejs');

  assert.match(nodes, /<div class="field half">\s*<label>Страна<\/label>/);
  assert.match(nodes, /id="add-node-auth-fields" class="auth-mode-fields field half"/);
  assert.doesNotMatch(footer, /auth-token-fields[\s\S]{0,160}hide \? 'none' : 'flex'/);
  assert.match(footer, /auth-token-fields[\s\S]{0,180}hide \? 'none' : 'grid'/);
});
