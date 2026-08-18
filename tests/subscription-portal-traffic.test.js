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
const { encrypt } = require('../lib_crypto');

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

  return { child, port };
}

async function stopApp(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  await Promise.race([
    once(instance.child, 'exit'),
    new Promise(resolve => setTimeout(() => {
      if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
      resolve();
    }, 5000))
  ]);
}

async function startMock3xui() {
  const requestedPaths = [];
  const server = http.createServer((req, res) => {
    requestedPaths.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/panel/api/clients/traffic/portal-user') {
      // A real 3x-ui compatibility failure often arrives as HTTP 200.
      res.end(JSON.stringify({ success: false, msg: 'unsupported endpoint', obj: null }));
      return;
    }
    if (req.method === 'GET' && req.url === '/panel/api/inbounds/getClientTraffics/portal-user') {
      res.end(JSON.stringify({
        success: true,
        obj: { email: 'portal-user', up: gib, down: 2 * gib, total: 0, enable: true }
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ success: false, msg: 'not found', obj: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, port: server.address().port, requestedPaths };
}

function seedSubscription(dataDir, mockPort) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    const uuid = '11111111-2222-4333-8444-555555555555';
    const nodeResult = db.prepare(`
      INSERT INTO nodes (
        name, node_type, panel_url, panel_path, username, password_enc,
        api_auth_mode, api_token_enc, inbound_id, enabled, last_status,
        country_code, country_name_ru, country_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Test node', '3xui', `http://127.0.0.1:${mockPort}`, '', '', encrypt('', appSecret),
      'token', encrypt('test-api-token', appSecret), 1, 1, 'online', 'DE', 'Германия', '🇩🇪'
    );
    const clientResult = db.prepare(`
      INSERT INTO clients (
        login, display_name, uuid, sub_slug, duration_days, traffic_gb,
        limit_ip, expiry_time, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('portal-user', 'Portal User', uuid, 'portal-user', 30, 5, 2, Date.now() + 30 * 86400000, 1);
    db.prepare(`
      INSERT INTO client_nodes (
        client_id, node_id, remote_email, remote_uuid, traffic_gb,
        limit_ip, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(clientResult.lastInsertRowid, nodeResult.lastInsertRowid, 'portal-user', uuid, 0, 2, 1);

    const inbound = {
      id: 1,
      port: 2053,
      protocol: 'vless',
      settings: JSON.stringify({ decryption: 'none', clients: [{ id: uuid, email: 'portal-user', enable: true }] }),
      streamSettings: JSON.stringify({
        network: 'xhttp',
        security: 'none',
        externalProxy: [
          { dest: 'edge-a.example.test', port: 443, forceTls: 'tls' },
          { dest: 'edge-b.example.test', port: 443, forceTls: 'tls' }
        ],
        xhttpSettings: { host: '', mode: 'packet-up', path: '/content/media/stream/' }
      })
    };
    db.prepare('INSERT INTO node_inbound_cache (node_id, inbound_id, inbound_json) VALUES (?, ?, ?)')
      .run(nodeResult.lastInsertRowid, 1, JSON.stringify(inbound));
    db.prepare("UPDATE app_settings SET value = 'Sulak Test' WHERE key = 'subscription_name'").run();
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('subscription_brand_tagline', 'Кавказ на связи')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run();
  } finally {
    db.close();
  }
}

function parseUserInfo(value) {
  return Object.fromEntries(String(value || '').split(';').map(part => {
    const [key, raw] = part.trim().split('=');
    return [key, Number(raw)];
  }));
}

test('subscription sums unlimited-node traffic once and exposes a branded browser portal plus Hiddify SUB', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(projectRoot, '.tmp-subscription-portal-'));
  const mock = await startMock3xui();
  let app = null;
  t.after(async () => {
    await stopApp(app);
    await new Promise(resolve => mock.server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  app = await startApp(dataDir);
  seedSubscription(dataDir, mock.port);

  let response = await fetch(`http://127.0.0.1:${app.port}/sub/portal-user?raw=1`, {
    headers: { Accept: '*/*' }
  });
  assert.equal(response.status, 200);
  const userInfo = parseUserInfo(response.headers.get('subscription-userinfo'));
  assert.equal(userInfo.upload, gib);
  assert.equal(userInfo.download, 2 * gib);
  assert.equal(userInfo.total, 5 * gib);
  assert.ok((await response.text()).includes('vless://'));

  response = await fetch(`http://127.0.0.1:${app.port}/sub/portal-user`, {
    redirect: 'manual',
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `http://127.0.0.1:${app.port}/open/portal-user`);

  response = await fetch(`http://127.0.0.1:${app.port}/hiddify/portal-user`);
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes('vless://'));
  assert.equal(parseUserInfo(response.headers.get('subscription-userinfo')).total, 5 * gib);

  response = await fetch(`http://127.0.0.1:${app.port}/open/portal-user`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Sulak Test/);
  assert.match(html, /Кавказ на связи/);
  assert.match(html, /3 ГБ/);
  assert.match(html, /5 ГБ/);
  assert.match(html, /v2RayTun/);
  assert.match(html, /Hiddify/);

  response = await fetch(`http://127.0.0.1:${app.port}/open/portal-user/status`, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.subscription.usedBytes, 3 * gib);
  assert.equal(status.subscription.totalBytes, 5 * gib);
  assert.equal(status.subscription.nodes.length, 1, 'two share links from one node must not double traffic');

  assert.ok(mock.requestedPaths.includes('GET /panel/api/clients/traffic/portal-user'));
  assert.ok(mock.requestedPaths.includes('GET /panel/api/inbounds/getClientTraffics/portal-user'));
});
