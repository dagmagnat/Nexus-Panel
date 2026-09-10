'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePanelRoot, connectionHint } = require('../lib_node_api_address');

test('full 3x-ui URL and separately copied Panel Path are not doubled', () => {
  assert.equal(normalizePanelRoot('https://panel.example.com:2053/secret/', '/secret/'), 'https://panel.example.com:2053/secret');
  assert.equal(normalizePanelRoot('http://local-3xui:2053', 'secret/'), 'http://local-3xui:2053/secret');
});
test('URL normalization preserves nested paths, IPv6 and deliberate transport', () => {
  assert.equal(normalizePanelRoot('https://[2001:db8::1]:2053/base', '/panel'), 'https://[2001:db8::1]:2053/base/panel');
  assert.equal(normalizePanelRoot('https://panel.example.com/path?raw=1#top', ''), 'https://panel.example.com/path');
  assert.equal(normalizePanelRoot('', ''), '');
});
test('HTTP sent to HTTPS port has a specific hint without reflecting raw body', () => {
  const hint = connectionHint(400, { raw: 'Client sent an HTTP request to an HTTPS server. secret-token' });
  assert.match(hint, /HTTP отправлен на HTTPS/);
  assert.doesNotMatch(hint, /secret-token/);
});
test('unknown 400 remains diagnostic, not a fake success or token failure', () => {
  assert.match(connectionHint(400, {}), /не доказывает/);
  assert.equal(connectionHint(401, {}), '');
  assert.match(connectionHint(200, { raw: '<html>login</html>' }), /Вместо JSON/);
});

test('real apiGet rejects non-JSON and 400 responses, accepts a valid status', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
  const apiGet = source.split('async function apiGet(')[1].split('\nasync function apiPost(')[0];
  let response;
  const context = vm.createContext({
    NODE_API_TIMEOUT_MS: 1000,
    buildNodeApiAuth: async () => ({ rootUrl: 'http://local-3xui:2053/path', headers: {} }),
    fetchWithTimeout: async () => response,
    safeJson: async res => res.data,
    explainNodeApiAuthError: (_node, res, data) => connectionHint(res.status, data) || 'API error'
  });
  vm.runInContext('async function apiGet(' + apiGet, context);
  response = { ok: false, status: 400, data: { raw: 'Client sent an HTTP request to an HTTPS server.' } };
  await assert.rejects(context.apiGet({}, '/panel/api/server/status'), /HTTP отправлен на HTTPS/);
  response = { ok: true, status: 200, data: { raw: '<html>login</html>' } };
  await assert.rejects(context.apiGet({}, '/panel/api/server/status'), /Вместо JSON/);
  response = { ok: true, status: 200, data: { success: false } };
  await assert.rejects(context.apiGet({}, '/panel/api/server/status'), /API error/);
  response = { ok: true, status: 200, data: { success: true, obj: { version: '3.7.0' } } };
  assert.equal((await context.apiGet({}, '/panel/api/server/status')).obj.version, '3.7.0');
});
