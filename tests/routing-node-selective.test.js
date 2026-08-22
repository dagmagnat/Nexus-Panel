'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views', 'routing.ejs'), 'utf8');

test('per-node routing assignments store independent modes and create a dedicated outbound', () => {
  assert.match(app, /mode: routingMode,/);
  assert.match(app, /modeAssignments,/);
  assert.match(app, /assignmentExplicit: true/);
  assert.match(app, /proxyNodeId,/);
  assert.match(app, /routing-node-\$\{Number\(cfg\.proxyNodeId\)\}/);
  assert.match(app, /mode === 'node-selective'/);
  assert.match(app, /rules: getEffectiveJsonRoutingRules\(selectiveOutboundTag, routingMode\)/);
  assert.match(app, /selectiveProxyLine/);
  assert.match(app, /Один узел нельзя использовать одновременно в нескольких режимах/);
  assert.match(app, /outboundTag \}\);\n    if \(ips\.length\)/);
});

test('routing form exposes checkbox modes, mutually exclusive node lists and node selector', () => {
  assert.match(view, /\['node-selective', 'Выбранное через отдельный узел'/);
  assert.match(view, /name="routing_modes"/);
  assert.match(view, /data-routing-node-option/);
  assert.match(view, /is-unavailable/);
  assert.match(view, /name="routing_proxy_node_id"/);
  assert.match(view, /Все доступные/);
});
