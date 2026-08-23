'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views', 'routing.ejs'), 'utf8');
const settings = fs.readFileSync(path.join(root, 'views', 'settings.ejs'), 'utf8');

function loadRoutingRuleBuilder() {
  const start = app.indexOf('function buildRoutingRules(');
  const end = app.indexOf('\nfunction isRoutingEnabledForNode(', start);
  const source = app.slice(start, end);
  return new Function(
    'getRoutingConfig', 'getRoutingBlockDomains', 'getRoutingBlockIps',
    'getRoutingProxyDomains', 'getRoutingProxyIps', 'getRoutingDirectDomains', 'getRoutingDirectIps',
    `${source}; return buildRoutingRules;`
  )(
    () => ({ enabled: true, mode: 'proxy-except' }),
    () => [], () => [],
    () => ['domain:foreign.example'], () => ['8.8.8.8'],
    () => ['geosite:category-ru', 'regexp:\\.(ru|su|xn--p1ai)$', 'domain:2ip.ru', 'domain:2ip.io', 'domain:2ip.me'], () => ['geoip:ru']
  );
}

test('per-node routing assignments keep direct exceptions and use the selected config itself', () => {
  assert.match(app, /mode: routingMode,/);
  assert.match(app, /modeAssignments,/);
  assert.match(app, /assignmentExplicit: true/);
  assert.match(app, /const allowedModes = \['proxy-except', 'node-selective'\]/);
  assert.match(app, /mode === 'node-selective'/);
  assert.match(app, /rules: getEffectiveJsonRoutingRules\(selectiveOutboundTag, routingMode\)/);
  assert.match(app, /const outboundTag = 'proxy'/);
  assert.match(app, /if \(directDomains\.length\) rules\.push\(\{ type: 'field', domain: directDomains, outboundTag: 'direct' \}\)/);
  assert.match(app, /rules\.push\(\{ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' \}\)/);
  assert.doesNotMatch(app, /routing-node-\$\{Number\(cfg\.proxyNodeId\)\}/);
  assert.match(app, /Один узел нельзя использовать одновременно в нескольких режимах/);
  assert.match(app, /outboundTag \}\);\n    if \(ips\.length\)/);
});

test('routing form exposes two visual rule scopes without a redundant node selector', () => {
  assert.match(view, /\['node-selective', 'Выбранное через proxy, остальное напрямую'/);
  assert.doesNotMatch(view, /\['proxy-selected'/);
  assert.match(view, /name="routing_modes"/);
  assert.match(view, /data-routing-node-option/);
  assert.match(view, /is-unavailable/);
  assert.doesNotMatch(view, /name="routing_proxy_node_id"/);
  assert.match(view, /routing-mode-rules-direct/);
  assert.match(view, /routing-mode-rules-proxy/);
  assert.match(view, /name="except_domains"/);
  assert.match(view, /name="custom_domains"/);
  assert.match(view, /Все доступные/);
  assert.match(view, /Выбранный через proxy кроме\.\.\./);
  assert.doesNotMatch(view, /Happ routing-профиль включается автоматически/);
  assert.doesNotMatch(view, /name="happ_routing_profile_enabled"/);
  assert.match(settings, /name="happ_routing_profile_enabled"/);
  assert.match(settings, /Отдельная функция · по умолчанию выключена/);
  assert.match(app, /function isHappAutoRoutingEnabled\(\)[\s\S]{0,520}cfg\.happRoutingProfileEnabled === true/);
});

test('proxy-except sends RU rules direct and all remaining traffic through the checked node', () => {
  const buildRoutingRules = loadRoutingRuleBuilder();
  const rules = buildRoutingRules('', 'proxy-except');
  assert.deepEqual(rules.slice(-3), [
    { type: 'field', domain: ['geosite:category-ru', 'regexp:\\.(ru|su|xn--p1ai)$', 'domain:2ip.ru', 'domain:2ip.io', 'domain:2ip.me'], outboundTag: 'direct' },
    { type: 'field', ip: ['geoip:ru'], outboundTag: 'direct' },
    { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }
  ]);
});

test('node-selective sends only chosen rules through the checked node and everything else direct', () => {
  const buildRoutingRules = loadRoutingRuleBuilder();
  const rules = buildRoutingRules('', 'node-selective');
  assert.deepEqual(rules, [
    { type: 'field', domain: ['domain:foreign.example'], outboundTag: 'proxy' },
    { type: 'field', ip: ['8.8.8.8'], outboundTag: 'proxy' },
    { type: 'field', network: 'tcp,udp', outboundTag: 'direct' }
  ]);
});
