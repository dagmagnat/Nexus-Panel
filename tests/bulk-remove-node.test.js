'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { encrypt } = require('../lib_crypto');

const projectRoot = path.resolve(__dirname, '..');
const appSecret = 'test-app-secret-0123456789abcdef0123456789abcdef';
const sessionSecret = 'test-session-secret-0123456789abcdef0123456789abcdef';

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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function startMock3xui() {
  const bulkBodies = [];
  const unexpectedPaths = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/panel/api/server/status') {
      res.end(JSON.stringify({ success: true, obj: { version: '3.4.0' } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/panel/api/clients/bulkDetach') {
      const body = await readJsonBody(req);
      bulkBodies.push(body);
      const emails = Array.isArray(body.emails) ? body.emails : [];
      // `skipped` means the desired relation is already absent and must also
      // remove the stale local mapping.
      res.end(JSON.stringify({
        success: true,
        obj: {
          detached: emails.slice(1),
          skipped: emails.slice(0, 1),
          errors: []
        }
      }));
      return;
    }

    unexpectedPaths.push(`${req.method} ${req.url}`);
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, msg: 'endpoint not found' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    port: server.address().port,
    bulkBodies,
    unexpectedPaths
  };
}

function seedBulkFixture(dataDir, remotePort, clientCount) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    const node = db.prepare(`
      INSERT INTO nodes (
        name, node_type, panel_url, panel_path, username, password_enc,
        api_auth_mode, api_token_enc, inbound_id, enabled, last_status,
        country_code, country_name_ru, country_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Bulk node',
      '3xui',
      `http://127.0.0.1:${remotePort}`,
      '',
      '',
      encrypt('', appSecret),
      'token',
      encrypt('test-api-token', appSecret),
      77,
      1,
      'online',
      'EU',
      'Европейский союз',
      '🇪🇺'
    );
    const otherNode = db.prepare(`
      INSERT INTO nodes (
        name, node_type, panel_url, panel_path, username, password_enc,
        api_auth_mode, api_token_enc, inbound_id, enabled, last_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Other node',
      '3xui',
      `http://127.0.0.1:${remotePort}`,
      '',
      '',
      encrypt('', appSecret),
      'token',
      encrypt('test-api-token', appSecret),
      88,
      1,
      'online'
    );

    const insertClient = db.prepare(`
      INSERT INTO clients (
        login, display_name, uuid, sub_slug, duration_days, traffic_gb,
        limit_ip, expiry_time, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertMapping = db.prepare(`
      INSERT INTO client_nodes (
        client_id, node_id, remote_email, remote_uuid, traffic_gb,
        limit_ip, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const clientIds = [];
    db.transaction(() => {
      for (let index = 1; index <= clientCount; index += 1) {
        const login = `bulk-user-${String(index).padStart(4, '0')}`;
        const uuid = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        const client = insertClient.run(login, login, uuid, `bulk-detach-${index}`, 0, 10, 0, 0, 1);
        clientIds.push(Number(client.lastInsertRowid));
        insertMapping.run(client.lastInsertRowid, node.lastInsertRowid, login, uuid, 10, 0, 1);
        insertMapping.run(client.lastInsertRowid, otherNode.lastInsertRowid, login, uuid, 10, 0, 1);
      }
    })();
    return { nodeId: Number(node.lastInsertRowid), otherNodeId: Number(otherNode.lastInsertRowid), clientIds };
  } finally {
    db.close();
  }
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
  assert.equal(response.headers.get('location'), '/dashboard');
  return jar;
}

test('selected-node mass removal uses linear 3x-ui bulkDetach and keeps the app alive', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-bulk-detach-'));
  const mock = await startMock3xui();
  let appInstance = null;
  t.after(async () => {
    await stopApp(appInstance);
    await new Promise(resolve => mock.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  appInstance = await startApp(dataDir);
  const fixture = seedBulkFixture(dataDir, mock.port, 225);
  const jar = await loginAsAdmin(appInstance.port);

  let response = await fetchWithJar(jar, `http://127.0.0.1:${appInstance.port}/clients`, { redirect: 'manual' });
  assert.equal(response.status, 200);
  const csrf = extractCsrf(await response.text());
  const form = new URLSearchParams({
    _csrf: csrf,
    bulk_confirmation: 'CONFIRMED',
    bulk_node_id: String(fixture.nodeId),
    bulk_filter_node_id: String(fixture.nodeId)
  });
  for (const id of fixture.clientIds) form.append('client_ids', String(id));

  response = await fetchWithJar(jar, `http://127.0.0.1:${appInstance.port}/clients/bulk-remove-node`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString()
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const progressPage = await response.text();
  assert.match(progressPage, /Готово\. Возвращаю в панель/);
  assert.equal(appInstance.child.exitCode, null, appInstance.getOutput());

  assert.equal(mock.bulkBodies.length, 2, '225 clients must be sent in bounded bulk chunks');
  assert.deepEqual(mock.bulkBodies.map(body => body.emails.length), [200, 25]);
  assert.ok(mock.bulkBodies.every(body => JSON.stringify(body.inboundIds) === '[77]'));
  assert.equal(mock.unexpectedPaths.length, 0, `unexpected API calls: ${mock.unexpectedPaths.join(', ')}`);

  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE node_id = ?').get(fixture.nodeId).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE node_id = ?').get(fixture.otherNodeId).n, 225, 'mappings to other nodes must remain');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 225, 'node-scoped removal must keep aggregator clients');
  } finally {
    db.close();
  }
});
