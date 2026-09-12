'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createHash, createHmac, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..');

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
      ...process.env, NODE_ENV: 'development', PORT: String(port), DATA_DIR: dataDir, NEXUS_NODE_ENABLED: '1',
      APP_SECRET: 'test-app-secret-0123456789abcdef0123456789abcdef',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'test-password-strong', SESSION_SECURE: '0', TRUST_PROXY: '0'
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`App startup timed out:\n${output}`)), 15000);
    const collect = chunk => { output += chunk; if (output.includes(`3xui-aggregator started on :${port}`)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`App exited (${code}):\n${output}`)); });
  });
  return { child, port };
}

async function stopApp(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  await Promise.race([once(instance.child, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
  if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
}

function csrfFrom(html) {
  const match = String(html).match(/name="csrf-token" content="([a-f0-9]+)"/i);
  assert.ok(match, 'CSRF token is present');
  return match[1];
}

function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function signedHeaders(nodeId, secret, endpoint, body, nonce = randomUUID().replace(/-/g, '')) {
  const timestamp = Date.now();
  const canonical = `POST\n${endpoint}\n${timestamp}\n${nonce}\n${sha256(JSON.stringify(body))}`;
  return {
    'content-type': 'application/json', 'x-nexus-node-id': nodeId,
    'x-nexus-timestamp': String(timestamp), 'x-nexus-nonce': nonce,
    'x-nexus-signature': createHmac('sha256', secret).update(canonical).digest('hex')
  };
}

test('Nexus Node enrolls once, verifies signed requests and completes a queued health operation', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-node-control-'));
  let appInstance;
  t.after(async () => { await stopApp(appInstance); fs.rmSync(dataDir, { recursive: true, force: true }); });
  appInstance = await startApp(dataDir);
  const base = `http://127.0.0.1:${appInstance.port}`;

  let response = await fetch(`${base}/login`, { redirect: 'manual' });
  const firstCookie = response.headers.get('set-cookie').split(';')[0];
  const loginCsrf = csrfFrom(await response.text());
  response = await fetch(`${base}/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie: firstCookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'test-password-strong', _csrf: loginCsrf })
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.get('set-cookie').split(';')[0];
  response = await fetch(`${base}/nexus-nodes`, { headers: { cookie } });
  const csrf = csrfFrom(await response.text());

  response = await fetch(`${base}/api/nexus-nodes/enrollments`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'x-nexus-workspace': 'main', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'test-node', expiresMinutes: 15 })
  });
  assert.equal(response.status, 201);
  const enrollment = await response.json();
  assert.match(enrollment.enrollmentToken, /^nxenr_/);

  response = await fetch(`${base}/api/nexus-node/v1/enroll`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enrollmentToken: enrollment.enrollmentToken, name: 'test-node', agentVersion: 'test', capabilities: { xray: false } })
  });
  assert.equal(response.status, 201);
  const node = await response.json();
  assert.match(node.nodeId, /^[0-9a-f-]{36}$/i);

  const heartbeat = { agentVersion: 'test', capabilities: { xray: false } };
  const nonce = randomUUID().replace(/-/g, '');
  const headers = signedHeaders(node.nodeId, node.sharedSecret, '/api/nexus-node/v1/heartbeat', heartbeat, nonce);
  response = await fetch(`${base}/api/nexus-node/v1/heartbeat`, { method: 'POST', headers, body: JSON.stringify(heartbeat) });
  assert.equal(response.status, 200);
  response = await fetch(`${base}/api/nexus-node/v1/heartbeat`, { method: 'POST', headers, body: JSON.stringify(heartbeat) });
  assert.equal(response.status, 409, 'the same signed request cannot be replayed');

  response = await fetch(`${base}/api/nexus-nodes/${node.nodeId}/operations`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'x-nexus-workspace': 'main', 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'health.check', payload: {} })
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  const pollBody = { agentVersion: 'test', capabilities: { xray: false } };
  response = await fetch(`${base}/api/nexus-node/v1/poll`, {
    method: 'POST', headers: signedHeaders(node.nodeId, node.sharedSecret, '/api/nexus-node/v1/poll', pollBody), body: JSON.stringify(pollBody)
  });
  const poll = await response.json();
  assert.equal(poll.operation.id, created.operationId);
  const result = { agentVersion: 'test', capabilities: { xray: false }, ok: true, result: { hostname: 'test' }, error: '' };
  response = await fetch(`${base}/api/nexus-node/v1/operations/${created.operationId}/result`, {
    method: 'POST', headers: signedHeaders(node.nodeId, node.sharedSecret, `/api/nexus-node/v1/operations/${created.operationId}/result`, result), body: JSON.stringify(result)
  });
  assert.equal(response.status, 200);
});
