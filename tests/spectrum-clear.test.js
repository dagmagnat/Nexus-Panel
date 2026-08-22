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
  assert.deepEqual(stylesheets, ['/css/spectrum-clear.css?v=270']);
  for (const legacy of ['style.css', 'redesign.css', 'nexus-ui.css', 'branding.css', 'stage87.css', 'stage90.css']) {
    assert.equal(header.includes(legacy), false, `legacy stylesheet must not be loaded: ${legacy}`);
  }
});

test('login and public subscription pages use the same design system', () => {
  for (const file of ['views/login.ejs', 'views/open_sub.ejs']) {
    const source = read(file);
    assert.match(source, /\/css\/spectrum-clear\.css\?v=270/);
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

test('shared shell exposes the simplified primary product routes', () => {
  const header = read('views/partials_header.ejs');
  for (const route of ['/dashboard', '/nodes', '/clients', '/routing', '/redirects', '/diagnostics', '/telegram-bot', '/settings', '/more']) {
    assert.ok(header.includes(`href="${route}"`), `missing navigation route ${route}`);
  }
  assert.doesNotMatch(header, /href="\/vpn"/);
});

test('simplified interface removes retired and duplicate sections without deleting data code', () => {
  const dashboard = read('views/dashboard.ejs');
  const clients = read('views/clients.ejs');
  const settings = read('views/settings.ejs');
  const more = read('views/more.ejs');
  assert.doesNotMatch(dashboard, /data-tab-target="nodes"|Потребление по узлам/);
  assert.doesNotMatch(clients, /href="\/clients\?type=(?:wireguard|amneziawg|outline)"/);
  assert.doesNotMatch(settings, /<h2><span class="section-icon"[^>]*>✈️<\/span>Telegram<\/h2>/);
  assert.doesNotMatch(settings, /data-settings-key="telegram"/);
  assert.doesNotMatch(more, /href="\/vpn"/);
  const app = read('app.js');
  assert.match(app, /app\.get\('\/vpn',[\s\S]{0,100}res\.redirect\('\/clients'\)/);
  assert.match(app, /const clientType = 'xray'/);
  assert.match(app, /const vpnData = \{ clients: \[\], services: \[\], aggregatorClients: \[\], protocolLabels: \{\} \}/);
});

test('known alignment regressions have structural layout fixes', () => {
  const css = read('public/css/spectrum-clear.css');
  assert.match(css, /:where\([\s\S]*?button:not\(\.spectrum-icon-button\)/);
  assert.match(css, /\.routing-form \{ display: grid; grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /\.nodes-mobile-tabs \{ display: none; \}/);
  assert.match(css, /\.mobile-filter-empty \{ display: none; \}/);
  assert.match(css, /\.redirect-node-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(read('views/routing.ejs'), /class="grid routing-page-grid"/);
  assert.match(read('views/routing.ejs'), /\.routing-form \{ display:flex !important;/);
  assert.match(read('views/routing.ejs'), /grid-template-columns:repeat\(2,minmax\(0,1fr\)\) !important/);
  assert.match(read('views/redirects.ejs'), /class="grid redirect-page-grid"/);
  assert.match(read('views/settings.ejs'), /class="card span-6 settings-sni-card"/);
});

test('Spectrum stylesheet bypasses stale browser and reverse-proxy caches', () => {
  const app = read('app.js');
  assert.match(app, /app\.use\(\['\/css\/spectrum-clear\.css', '\/site\.webmanifest'\],[\s\S]{0,500}Cache-Control'[\s\S]{0,200}no-store/);
});

test('redesign does not replace client identity or subscription fields', () => {
  const app = read('app.js');
  assert.match(app, /CREATE TABLE IF NOT EXISTS clients/);
  assert.match(app, /uuid TEXT NOT NULL/);
  assert.match(app, /sub_slug TEXT UNIQUE NOT NULL/);
  assert.match(app, /app\.get\('\/sub\/:slug'/);
  assert.match(app, /app\.get\('\/json\/:slug'/);
});

test('daily monitoring, 3x-ui traffic fallback and responsive actions stay configurable', () => {
  const app = read('app.js');
  const settings = read('views/settings.ejs');
  const nodes = read('views/nodes.ejs');
  const clients = read('views/clients.ejs');
  const nodeEdit = read('views/node_edit.ejs');
  const css = read('public/css/spectrum-clear.css');
  assert.match(app, /node_auto_refresh_seconds/);
  assert.match(app, /client_auto_refresh_seconds/);
  assert.match(app, /inbound\.clientStats/);
  assert.match(settings, /Автопроверка узлов/);
  assert.match(settings, /Показывать расход ГБ и срок в подписках/);
  assert.match(nodes, /dashboard\/node-status\.json\?details=1/);
  assert.match(clients, />Продлить<\/button>/);
  assert.match(nodeEdit, /class="node-delete-form"[\s\S]{0,180}confirm\('/);
  assert.match(css, /\.node-edit-primary-actions/);
  assert.match(css, /\.project-update-progress/);
});

test('routing offers current Russia geodata source and manual catalog refresh', () => {
  const app = read('app.js');
  const routing = read('views/routing.ejs');
  assert.match(app, /runetfreedom\/russia-v2ray-rules-dat\/release\/geosite\.dat/);
  assert.match(app, /'ru-blocked-community'/);
  assert.match(app, /'ru-whitelist'/);
  assert.match(routing, /option value="russia"/);
  assert.match(routing, /loadGeodataCatalog\(true\)/);
});

test('2.5.1 client bulk metadata and helper restart controls remain wired end to end', () => {
  const app = read('app.js');
  const clients = read('views/clients.ejs');
  const redirects = read('views/redirects.ejs');
  const forwarder = read('scripts/forwarder.sh');
  const installer = read('install.sh');
  const css = read('public/css/spectrum-clear.css');
  assert.match(clients, /name="group_id"[\s\S]{0,500}name="tag_ids"/);
  assert.match(clients, /Группа \/ метки/);
  assert.match(clients, /class="modern-term/);
  assert.doesNotMatch(clients, /secondaryText[\s\S]{0,180}client\.sub_slug/);
  assert.match(app, /app\.post\('\/clients\/apply-to-node'[\s\S]{0,2500}client_tag_assignments/);
  assert.match(app, /app\.post\('\/redirects\/helper\/restart\.json'/);
  assert.match(redirects, /id="redirectRestartHelper"/);
  assert.match(forwarder, /redirect_helper_restart\.request/);
  assert.match(installer, /PathExists=.*redirect_helper_restart\.request/);
  assert.match(css, /2\.5\.1 final cascade/);
});

test('2.6.0 HWID device registry and subscription notices are wired into the UI', () => {
  const app = read('app.js');
  const clients = read('views/clients.ejs');
  const settings = read('views/settings.ejs');
  const openSub = read('views/open_sub.ejs');
  const css = read('public/css/spectrum-clear.css');
  assert.match(app, /CREATE TABLE IF NOT EXISTS subscription_devices/);
  assert.match(app, /limit_ip INTEGER NOT NULL DEFAULT 0/);
  assert.match(app, /device_limit INTEGER NOT NULL DEFAULT 1/);
  assert.match(app, /buildSubscriptionEntriesForRequest/);
  assert.match(app, /x-hwid-max-devices-reached/);
  assert.match(clients, /Устройства клиента/);
  assert.match(clients, /client-device-count-link/);
  assert.match(settings, /Блокировать устройства сверх лимита/);
  assert.match(settings, /Заменять узлы после окончания подписки/);
  assert.match(openSub, /<h3>INCY<\/h3>/);
  assert.match(openSub, /incy:\/\/import\//);
  assert.match(openSub, /<h3>v2RayTun<\/h3>/);
  assert.match(css, /subscription HWID device registry/);
});

test('2.7.1 separates IP and device limits, exposes devices and wires grace/support nodes', () => {
  const app = read('app.js');
  const clients = read('views/clients.ejs');
  const settings = read('views/settings.ejs');
  const css = read('public/css/spectrum-clear.css');
  const transfer = read('scripts/client-transfer.py');

  assert.match(app, /subscription_device_limits_separated_v3/);
  assert.match(app, /IP limiting from subscription HWID slots/);
  assert.match(app, /subscription_expired_grace_days/);
  assert.match(app, /subscription_expired_grace_node_ids/);
  assert.match(app, /subscription_device_limit_node_ids/);
  assert.match(app, /slot > limit/);
  assert.match(app, /onlyNodeIds: grace\.nodeIds/);
  assert.match(app, /subscriptionExpiryOverride: grace\.active \? grace\.graceExpiryTime : 0/);
  assert.match(app, /onlyNodeIds: allowedNodeIds/);
  assert.match(app, /excludeNodeIds: uniqueList/);
  assert.match(app, /ensureSubscriptionPolicyNodesForClient/);
  assert.match(app, /limitIp: 0[\s\S]{0,120}trafficGb: 0/);
  assert.match(app, /Subscription policy node provision failed/);
  assert.match(app, /subscription_policy_only INTEGER NOT NULL DEFAULT 0/);
  assert.match(app, /excludePolicyOnly: true/);

  assert.match(clients, /<label>Лимит IP<\/label>/);
  assert.match(clients, /<label>Лимит устройств<\/label>/);
  assert.match(clients, /name="device_limit"/);
  assert.match(clients, /Ссылка подписки/);
  assert.match(clients, /↗ Открыть/);
  assert.match(clients, /device-slot-badge/);
  assert.match(clients, /сверх лимита/);
  assert.match(clients, /Показать устройства клиента/);

  assert.match(settings, /Узлы, доступные при превышении лимита устройств/);
  assert.match(settings, /Служебный доступ после окончания/);
  assert.match(settings, /option value="3"/);
  assert.match(settings, /option value="7"/);
  assert.match(settings, /Узлы, доступные после окончания подписки/);
  assert.match(settings, /name="json_<%= key %>_node_ids"/);
  assert.match(settings, /\['sniffing', jsonSniffingEnabled, jsonSniffingNodeIds/);
  assert.match(settings, /\['mux', jsonMuxEnabled, jsonMuxNodeIds/);
  assert.match(settings, /data-json-node-picker/);

  assert.match(css, /2\.7 subscription policies/);
  assert.match(css, /grid-template-columns: repeat\(8, minmax\(0, 1fr\)\)/);
  assert.match(css, /device-details-row\.is-over-limit/);
  assert.match(css, /\.page-clients \.mobile-client-tabs/);
  assert.match(transfer, /"limitIp": clamp_int\(row_value\(row, "limit_ip"\), 0\)/);
  assert.match(transfer, /"deviceLimit": clamp_int\(row_value\(row, "device_limit"\), 1\)/);
});
