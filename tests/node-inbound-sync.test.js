'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const appSecret = 'test-app-secret-0123456789abcdef0123456789abcdef';
const sessionSecret = 'test-session-secret-0123456789abcdef0123456789abcdef';
const gib = 1024 * 1024 * 1024;

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startApp(dataDir) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: appSecret,
      SESSION_SECRET: sessionSecret,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'test-password-strong',
      PANEL_ACCESS_KEY: '',
      PANEL_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
      BASE_URL: `http://127.0.0.1:${port}`,
      SESSION_SECURE: '0',
      TRUST_PROXY: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`App startup timed out:\n${output}`)), 15000);
    const collect = chunk => {
      output += chunk.toString();
      if (output.includes(`3xui-aggregator started on :${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`App exited with code ${code}:\n${output}`));
    });
  });

  return { child, port, getOutput: () => output };
}

async function stopApp(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  let timeoutId;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
      resolve();
    }, 5000);
  });
  await Promise.race([once(instance.child, 'exit'), timeout]);
  clearTimeout(timeoutId);
}

async function startMock3xui() {
  const requestedPaths = [];
  const updatePayloads = [];
  const selectedInbound = {
    id: 1,
    up: 3 * gib,
    down: 7 * gib,
    total: 20 * gib,
    remark: 'Selected xHTTP inbound',
    port: 2053,
    protocol: 'vless',
    settings: JSON.stringify({ clients: [], decryption: 'none' }),
    streamSettings: JSON.stringify({
      network: 'xhttp',
      security: 'none',
      xhttpSettings: {
        host: 'media.example.test',
        path: '/content/media/stream/',
        mode: 'packet-up',
        scMaxConcurrentPosts: 10,
        scMaxEachPostBytes: 1000000,
        scMinPostsIntervalMs: 30
      }
    }),
    sniffing: JSON.stringify({ enabled: true, destOverride: ['http', 'tls'] })
  };

  const server = http.createServer((req, res) => {
    requestedPaths.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/panel/api/server/status') {
      res.end(JSON.stringify({ success: true, obj: { version: '3.5.0' } }));
      return;
    }
    if (req.method === 'GET' && req.url === '/panel/api/inbounds/get/1') {
      res.end(JSON.stringify({ success: true, obj: selectedInbound }));
      return;
    }
    if (req.method === 'GET' && req.url === '/panel/api/inbounds/get/999') {
      res.end(JSON.stringify({ success: false, msg: 'not found', obj: null }));
      return;
    }
    if (req.method === 'GET' && req.url === '/panel/api/inbounds/list') {
      res.end(JSON.stringify({ success: true, obj: [selectedInbound] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/panel/api/inbounds/list/slim') {
      res.end(JSON.stringify({ success: true, obj: [{ id: 1, protocol: 'trojan', port: 9999 }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/panel/api/inbounds/update/1') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        updatePayloads.push(Object.fromEntries(new URLSearchParams(body)));
        res.end(JSON.stringify({ success: true, obj: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, msg: 'endpoint not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, requestedPaths, selectedInbound, updatePayloads };
}

function updateCookieJar(jar, response) {
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  for (const value of values) {
    const pair = String(value || '').split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

async function fetchWithJar(jar, url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (jar.size) headers.set('Cookie', Array.from(jar, ([key, value]) => `${key}=${value}`).join('; '));
  const response = await fetch(url, { ...options, headers });
  updateCookieJar(jar, response);
  return response;
}

function extractCsrf(html) {
  const match = String(html || '').match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/i);
  assert.ok(match, 'page must expose a CSRF token');
  return match[1];
}

async function loginAsAdmin(port) {
  const jar = new Map();
  let response = await fetchWithJar(jar, `http://127.0.0.1:${port}/login`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  const csrf = extractCsrf(await response.text());
  response = await fetchWithJar(jar, `http://127.0.0.1:${port}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: csrf,
      username: 'admin',
      password: 'test-password-strong'
    }).toString()
  });
  assert.equal(response.status, 302);
  return jar;
}

async function getPage(jar, appPort, pathname) {
  const response = await fetchWithJar(jar, `http://127.0.0.1:${appPort}${pathname}`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  const html = await response.text();
  return { html, csrf: extractCsrf(html) };
}

function addNodeBody(csrf, mockPort, inboundId) {
  return new URLSearchParams({
    _csrf: csrf,
    node_type: '3xui',
    panel_url: `http://127.0.0.1:${mockPort}`,
    panel_path: '',
    api_auth_mode: 'token',
    api_token: 'test-api-token',
    inbound_id: String(inboundId),
    country_code: 'DE',
    label_suffix: 'Exact inbound',
    sni_mode: 'inbound'
  }).toString();
}

test('node add imports the exact full inbound, isolates its fields and shows inbound traffic', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(projectRoot, '.tmp-nexus-inbound-sync-'));
  const mock = await startMock3xui();
  let appInstance = null;
  t.after(async () => {
    await stopApp(appInstance);
    await new Promise(resolve => mock.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  appInstance = await startApp(dataDir);
  const jar = await loginAsAdmin(appInstance.port);
  const addPage = await getPage(jar, appInstance.port, '/nodes?tab=add');

  let response = await fetchWithJar(jar, `http://127.0.0.1:${appInstance.port}/nodes`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: addNodeBody(addPage.csrf, mock.port, 1)
  });
  assert.equal(response.status, 302);
  let redirectUrl = new URL(response.headers.get('location') || '/', `http://127.0.0.1:${appInstance.port}`);
  assert.match(redirectUrl.searchParams.get('message') || '', /Inbound #1 загружен: VLESS \/ xHTTP \/ NONE \/ packet-up/);

  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  let node;
  try {
    node = db.prepare('SELECT * FROM nodes WHERE inbound_id = 1').get();
    assert.ok(node, 'valid node must be stored');
    const cached = db.prepare('SELECT * FROM node_inbound_cache WHERE node_id = ?').get(node.id);
    assert.equal(cached.inbound_id, 1);
    assert.deepEqual(JSON.parse(cached.inbound_json), mock.selectedInbound);
  } finally {
    db.close();
  }

  const nodesPage = await getPage(jar, appInstance.port, '/nodes?tab=list');
  assert.match(nodesPage.html, /VLESS \/ xHTTP \/ NONE \/ packet-up/);
  assert.match(nodesPage.html, /Потрачено в Inbound #1/);
  assert.match(nodesPage.html, />10 ГБ</);
  assert.match(nodesPage.html, /7 ГБ \/ 3 ГБ/);

  const editPage = await getPage(jar, appInstance.port, `/nodes/${node.id}/edit`);
  assert.match(editPage.html, /Параметры Inbound #1/);
  assert.match(editPage.html, /name="inbound_path" value="\/content\/media\/stream\/"/);
  assert.match(editPage.html, /name="inbound_xhttp_mode" value="packet-up"/);
  assert.doesNotMatch(editPage.html, /name="inbound_service_name"/);
  assert.doesNotMatch(editPage.html, /name="inbound_kcp_seed"/);
  assert.doesNotMatch(editPage.html, /name="inbound_target"/);
  assert.doesNotMatch(editPage.html, /name="inbound_short_id"/);
  assert.match(editPage.html, /Все настройки inbound/);
  assert.match(editPage.html, /name="inbound_advanced_json"/);
  assert.equal(mock.requestedPaths.includes('GET /panel/api/inbounds/list/slim'), false);

  const advancedInbound = {
    ...mock.selectedInbound,
    remark: 'Advanced exact payload',
    allocate: { strategy: 'always', refresh: 9, concurrency: 3 },
    streamSettings: JSON.parse(mock.selectedInbound.streamSettings),
    sniffing: JSON.parse(mock.selectedInbound.sniffing),
    customFutureField: { enabled: true, mode: 'next' }
  };
  response = await fetchWithJar(jar, `http://127.0.0.1:${appInstance.port}/nodes/${node.id}/edit`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _csrf: editPage.csrf,
      node_type: '3xui',
      panel_url: `http://127.0.0.1:${mock.port}`,
      panel_path: '',
      api_auth_mode: 'token',
      api_token: '',
      inbound_id: '1',
      country_code: 'DE',
      label_suffix: 'Exact inbound',
      sni_mode: 'inbound',
      apply_inbound_advanced_json: '1',
      inbound_advanced_json: JSON.stringify(advancedInbound)
    }).toString()
  });
  assert.equal(response.status, 302);
  assert.equal(mock.updatePayloads.length, 1);
  assert.equal(mock.updatePayloads[0].id, '1');
  assert.equal(mock.updatePayloads[0].remark, 'Advanced exact payload');
  assert.equal(mock.updatePayloads[0]['allocate[strategy]'], 'always');
  assert.equal(mock.updatePayloads[0]['allocate[refresh]'], '9');
  assert.equal(mock.updatePayloads[0]['customFutureField[enabled]'], 'true');
  assert.equal(mock.updatePayloads[0]['customFutureField[mode]'], 'next');
  assert.equal(mock.updatePayloads[0]['settings[decryption]'], 'none');
  assert.equal(mock.updatePayloads[0]['settings[clients]'], '');
  assert.equal(mock.updatePayloads[0]['streamSettings[xhttpSettings][mode]'], 'packet-up');

  const beforeInvalid = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  const beforeCount = beforeInvalid.prepare('SELECT COUNT(*) AS count FROM nodes').get().count;
  beforeInvalid.close();

  response = await fetchWithJar(jar, `http://127.0.0.1:${appInstance.port}/nodes`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: addNodeBody(nodesPage.csrf, mock.port, 999)
  });
  assert.equal(response.status, 302);
  redirectUrl = new URL(response.headers.get('location') || '/', `http://127.0.0.1:${appInstance.port}`);
  assert.match(redirectUrl.searchParams.get('error') || '', /Inbound ID 999 не найден/);

  const afterInvalid = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  try {
    assert.equal(afterInvalid.prepare('SELECT COUNT(*) AS count FROM nodes').get().count, beforeCount);
  } finally {
    afterInvalid.close();
  }
});
