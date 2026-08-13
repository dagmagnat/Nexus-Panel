'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Spectrum Clear is the only stylesheet loaded by authenticated pages', () => {
  const header = read('views/partials_header.ejs');
  const stylesheets = Array.from(header.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+)/g), match => match[1]);
  assert.deepEqual(stylesheets, ['/css/spectrum-clear.css?v=1']);
  for (const legacy of ['style.css', 'redesign.css', 'nexus-ui.css', 'branding.css', 'stage87.css', 'stage90.css']) {
    assert.equal(header.includes(legacy), false, `legacy stylesheet must not be loaded: ${legacy}`);
  }
});

test('login and public subscription pages use the same design system', () => {
  for (const file of ['views/login.ejs', 'views/open_sub.ejs']) {
    const source = read(file);
    assert.match(source, /\/css\/spectrum-clear\.css\?v=1/);
    assert.match(source, /class="[^"]*nexus-spectrum/);
    assert.doesNotMatch(source, /\/css\/(?:style|redesign|nexus-ui|branding|stage\d+)\.css/);
  }
});

test('all application screens share the Spectrum shell', () => {
  const screens = [
    'dashboard', 'nodes', 'clients', 'client_detail', 'node_edit', 'vpn',
    'routing', 'redirects', 'diagnostics', 'telegram_bot', 'settings', 'more'
  ];
  for (const screen of screens) {
    const source = read(`views/${screen}.ejs`);
    assert.match(source, /include\('partials_header'/, `${screen} must include the shared header`);
    assert.match(source, /include\('partials_footer'\)/, `${screen} must include the shared footer`);
  }
});

test('design system contains both themes and responsive structural layouts', () => {
  const css = read('public/css/spectrum-clear.css');
  for (const token of [
    '--brand-gradient', 'html[data-color-mode="light"]', '.spectrum-shell', '.spectrum-sidebar',
    '.nodes-modern-layout', '.client-overview-strip', '.clients-modern-table', '.settings-tabs',
    '.modal-backdrop, .modal', '.login-page, .public-page', '@media (max-width: 900px)',
    '.mobile-nav-bottom .spectrum-bottom-nav', '.mobile-client-cards'
  ]) {
    assert.ok(css.includes(token), `missing Spectrum Clear rule: ${token}`);
  }
  assert.ok(css.split(/\r?\n/).length > 1200, 'design system must cover the whole product, not be a small color override');
});

test('shared shell exposes every primary product route', () => {
  const header = read('views/partials_header.ejs');
  for (const route of ['/dashboard', '/nodes', '/clients', '/vpn', '/routing', '/redirects', '/diagnostics', '/telegram-bot', '/settings', '/more']) {
    assert.ok(header.includes(`href="${route}"`), `missing navigation route ${route}`);
  }
});

test('redesign does not replace client identity or subscription fields', () => {
  const app = read('app.js');
  assert.match(app, /CREATE TABLE IF NOT EXISTS clients/);
  assert.match(app, /uuid TEXT NOT NULL/);
  assert.match(app, /sub_slug TEXT UNIQUE NOT NULL/);
  assert.match(app, /app\.get\('\/sub\/:slug'/);
  assert.match(app, /app\.get\('\/json\/:slug'/);
});
