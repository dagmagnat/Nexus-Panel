'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { encrypt } = require('../lib_crypto');

const projectRoot = path.resolve(__dirname, '..');
const appSecret = 'device-test-app-secret-0123456789abcdef0123456789';
const sessionSecret = 'device-test-session-secret-0123456789abcdef012345';

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

function seedClients(dataDir) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    db.prepare("UPDATE app_settings SET value = '0' WHERE key = 'subscription_live_usage'").run();
    db.prepare("UPDATE app_settings SET value = '1' WHERE key = 'subscription_device_tracking_enabled'").run();
    db.prepare("UPDATE app_settings SET value = '1' WHERE key = 'subscription_device_limit_enforced'").run();
    db.prepare("UPDATE app_settings SET value = '1' WHERE key = 'subscription_expired_notice_enabled'").run();

    const uuid = '11111111-2222-4333-8444-555555555555';
    const node = db.prepare(`
      INSERT INTO nodes (
        name, node_type, panel_url, panel_path, username, password_enc,
        api_auth_mode, api_token_enc, inbound_id, enabled, last_status,
        country_code, country_name_ru, country_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'Device test node', '3xui', 'http://127.0.0.1:9', '', '', encrypt('', appSecret),
      'token', encrypt('unused-token', appSecret), 1, 1, 'online', 'DE', 'Германия', '🇩🇪'
    );
    const active = db.prepare(`
      INSERT INTO clients (
        login, display_name, uuid, sub_slug, duration_days, traffic_gb,
        limit_ip, device_limit, expiry_time, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('device-user', 'Device User', uuid, 'device-user', 30, 0, 5, 2, Date.now() + 30 * 86400000, 1);
    db.prepare(`
      INSERT INTO client_nodes (
        client_id, node_id, remote_email, remote_uuid, traffic_gb, limit_ip, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(active.lastInsertRowid, node.lastInsertRowid, 'device-user', uuid, 0, 5, 1);
    const inbound = {
      id: 1,
      port: 2053,
      protocol: 'vless',
      settings: JSON.stringify({ decryption: 'none', clients: [{ id: uuid, email: 'device-user', enable: true }] }),
      streamSettings: JSON.stringify({ network: 'tcp', security: 'none' })
    };
    db.prepare('INSERT INTO node_inbound_cache (node_id, inbound_id, inbound_json) VALUES (?, ?, ?)')
      .run(node.lastInsertRowid, 1, JSON.stringify(inbound));

    db.prepare(`
      INSERT INTO clients (
        login, display_name, uuid, sub_slug, duration_days, traffic_gb,
        limit_ip, device_limit, expiry_time, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'expired-user', 'Expired User', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'expired-user',
      30, 0, 5, 2, Date.now() - 86400000, 1
    );
  } finally {
    db.close();
  }
}

function subscriptionHeaders(hwid, app = 'Happ/3.0') {
  return {
    Accept: '*/*',
    'User-Agent': app,
    'X-HWID': hwid,
    'X-Device-OS': 'iOS',
    'X-Ver-OS': '18.6',
    'X-Device-Model': 'iPhone 15 Pro'
  };
}

async function fetchRaw(port, slug, hwid, app) {
  return fetch(`http://127.0.0.1:${port}/sub/${slug}?raw=1`, {
    headers: subscriptionHeaders(hwid, app)
  });
}

test('Nexus tracks HWID devices, reuses known slots, blocks the extra device and serves an expiry notice', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(projectRoot, '.tmp-device-registry-'));
  let app = null;
  t.after(async () => {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  app = await startApp(dataDir);
  seedClients(dataDir);

  const firstHwid = 'HAPPDEVICE000001';
  const secondHwid = 'INCYDEVICE000002';
  const extraHwid = 'V2RAYDEVICE00003';

  let response = await fetchRaw(app.port, 'device-user', firstHwid, 'Happ/3.0 iOS');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-hwid-active'), 'true');
  assert.equal(response.headers.get('x-hwid-max-devices-reached'), null);
  let body = await response.text();
  assert.match(body, /vless:\/\//);
  assert.doesNotMatch(decodeURIComponent(body), /Превышен лимит устройств/);

  response = await fetchRaw(app.port, 'device-user', firstHwid, 'Happ/3.1 iOS');
  assert.equal(response.status, 200);
  await response.text();

  response = await fetchRaw(app.port, 'device-user', secondHwid, 'INCY/1.2 iOS');
  assert.equal(response.status, 200);
  body = await response.text();
  assert.doesNotMatch(decodeURIComponent(body), /Превышен лимит устройств/);

  let db = new Database(path.join(dataDir, 'app.db'));
  let devices = db.prepare(`
    SELECT hwid_hash, hwid_hint, os_name, os_version, device_model, app_name, request_count
    FROM subscription_devices
    WHERE client_id = (SELECT id FROM clients WHERE sub_slug = 'device-user')
    ORDER BY id
  `).all();
  assert.equal(devices.length, 2);
  assert.equal(devices[0].request_count, 2);
  assert.equal(devices[0].device_model, 'iPhone 15 Pro');
  assert.equal(devices[0].os_name, 'iOS');
  assert.equal(devices[0].app_name, 'Happ');
  assert.equal(devices[1].app_name, 'INCY');
  assert.ok(devices.every(device => !device.hwid_hash.includes('DEVICE')), 'raw HWID must not be stored in the hash column');
  db.close();

  response = await fetchRaw(app.port, 'device-user', extraHwid, 'v2RayTun/2.3.5 iOS');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-hwid-max-devices-reached'), 'true');
  assert.equal(response.headers.get('x-hwid-limit'), 'true');
  body = decodeURIComponent(await response.text());
  assert.match(body, /⚠️ Превышен лимит устройств/);
  assert.doesNotMatch(body, /Device test node|Германия/);

  response = await fetch(`http://127.0.0.1:${app.port}/json/device-user`, {
    headers: subscriptionHeaders(extraHwid, 'v2RayTun/2.3.5 iOS')
  });
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.ok(Array.isArray(json));
  assert.equal(json.length, 1);
  assert.match(String(json[0].name || json[0].remarks || ''), /Превышен лимит устройств/);

  db = new Database(path.join(dataDir, 'app.db'));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM subscription_devices WHERE client_id = (SELECT id FROM clients WHERE sub_slug='device-user')").get().c, 2);
  db.close();

  response = await fetchRaw(app.port, 'expired-user', 'EXPIREDDEVICE001', 'Happ/3.0 iOS');
  assert.equal(response.status, 200);
  body = decodeURIComponent(await response.text());
  assert.match(body, /⛔ Продлите подписку/);

  db = new Database(path.join(dataDir, 'app.db'));
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM subscription_devices WHERE client_id = (SELECT id FROM clients WHERE sub_slug='expired-user')").get().c, 0, 'expired refresh must not consume a new device slot');
  db.close();
});
