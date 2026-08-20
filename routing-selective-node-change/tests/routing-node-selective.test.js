'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const view = fs.readFileSync(path.join(root, 'views', 'routing.ejs'), 'utf8');

test('selective node routing stores a node and creates a dedicated outbound', () => {
  assert.match(app, /mode: routingMode,/);
  assert.match(app, /proxyNodeId,/);
  assert.match(app, /routing-node-\$\{Number\(cfg\.proxyNodeId\)\}/);
  assert.match(app, /mode === 'node-selective'/);
  assert.match(app, /rules: getEffectiveJsonRoutingRules\(selectiveOutboundTag\)/);
  assert.match(app, /selectiveProxyLine/);
  assert.match(app, /outboundTag \}\);\n    if \(ips\.length\)/);
});

test('routing form exposes the selective node mode and node selector', () => {
  assert.match(view, /value="node-selective"/);
  assert.match(view, /name="routing_proxy_node_id"/);
  assert.match(view, /geosite:telegram/);
  assert.match(view, /geoip:telegram/);
});