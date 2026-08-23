'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const nodeEdit = fs.readFileSync(path.join(root, 'views', 'node_edit.ejs'), 'utf8');
const nodesView = fs.readFileSync(path.join(root, 'views', 'nodes.ejs'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public', 'css', 'spectrum-clear.css'), 'utf8');

function loadSourceParsers() {
  const start = app.indexOf('function parse3xuiSubscriptionJsonSetting(');
  const end = app.indexOf('\nasync function fetch3xuiSubscriptionSource(', start);
  const source = app.slice(start, end);
  return new Function(`${source}; return { parse3xuiSubscriptionJsonSetting, has3xuiFinalMaskType, summarize3xuiSubscriptionSource };`)();
}

test('3x-ui subscription source recognises exact mux, fragment and noise settings', () => {
  const { parse3xuiSubscriptionJsonSetting, summarize3xuiSubscriptionSource } = loadSourceParsers();
  const source = {
    mux: '{"enabled":true,"concurrency":8}',
    finalmask: '{"tcp":[{"type":"fragment","settings":{"packets":"tlshello"}}],"udp":[{"type":"noise","settings":{"noise":[{"type":"rand"}]}}]}'
  };
  assert.deepEqual(parse3xuiSubscriptionJsonSetting(source.mux), { enabled: true, concurrency: 8 });
  assert.deepEqual(summarize3xuiSubscriptionSource(source), {
    muxAvailable: true,
    fragmentAvailable: true,
    noisesAvailable: true
  });
  assert.equal(parse3xuiSubscriptionJsonSetting('not-json'), null);
});

test('per-node source settings are cached and only selected controls are applied', () => {
  for (const column of [
    'inherit_3xui_mux', 'inherit_3xui_fragment', 'inherit_3xui_noises',
    'source_sub_json_mux', 'source_sub_json_finalmask', 'source_sub_settings_error'
  ]) {
    assert.match(app, new RegExp(column));
  }
  assert.match(app, /apiPost\(node, '\/panel\/api\/setting\/all'/);
  assert.match(app, /outbound\.mux = inherited\.mux/);
  assert.match(app, /outbound\.streamSettings\.finalmask = mergeInherited3xuiFinalmask/);
  assert.match(nodeEdit, /name="inherit_3xui_mux"/);
  assert.match(nodeEdit, /name="inherit_3xui_fragment"/);
  assert.match(nodeEdit, /name="inherit_3xui_noises"/);
});

test('node editor and list keep compact stable layouts', () => {
  assert.match(nodeEdit, /class="switch-row compact xhttp-fragment-toggle"/);
  assert.doesNotMatch(nodeEdit, /<div class="field full">\s*<label class="switch-row compact">\s*<input type="checkbox" name="inbound_xhttp_fragment"/);
  assert.match(css, /\.xhttp-fragment-toggle[^}]*grid-template-columns:\s*20px minmax\(0, 1fr\)/);
  assert.match(css, /\.page-nodes \{ height: 100dvh; overflow: hidden; \}/);
  assert.ok(nodesView.indexOf('node-detail-actions node-detail-actions-top') < nodesView.indexOf('<div class="node-detail-kv">'));
  assert.match(css, /node-mobile-quick-actions[^}]*padding:\s*0 84px 8px 8px/);
});
