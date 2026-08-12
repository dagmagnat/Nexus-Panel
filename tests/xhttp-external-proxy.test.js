'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
      PANEL_ACCESS_KEY: 'test-panel-access-key-1234',
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

function seedExternalProxyFixture(dataDir) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    const clientUuid = 'fa65a2e6-20a9-4da5-8c4e-40be5de9047b';
    const node = db.prepare(`
      INSERT INTO nodes (
        name, node_type, panel_url, panel_path, username, password_enc,
        api_auth_mode, api_token_enc, inbound_id, enabled, last_status,
        country_code, country_name_ru, country_flag
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'LTE / БПЛА',
      '3xui',
      'https://pnl220.cdn.amored.ru',
      '/a4086fc9db954cdd',
      '',
      encrypt('', appSecret),
      'token',
      encrypt('test-api-token', appSecret),
      1,
      1,
      'offline',
      'EU',
      'LTE / БПЛА',
      '🇪🇺'
    );

    const client = db.prepare(`
      INSERT INTO clients (
        login, display_name, uuid, sub_slug, duration_days, traffic_gb,
        limit_ip, expiry_time, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('MyPhone', 'MyPhone', clientUuid, 'external-proxy-test', 0, 10, 0, 0, 1);

    db.prepare(`
      INSERT INTO client_nodes (
        client_id, node_id, remote_email, remote_uuid, traffic_gb,
        limit_ip, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(client.lastInsertRowid, node.lastInsertRowid, 'MyPhone', clientUuid, 10, 0, 1);

    const inbound = {
      id: 1,
      port: 2053,
      protocol: 'vless',
      settings: JSON.stringify({
        decryption: 'none',
        clients: [{ id: clientUuid, email: 'MyPhone', enable: true }]
      }),
      streamSettings: JSON.stringify({
        network: 'xhttp',
        security: 'none',
        externalProxy: [{
          dest: 'la57l.cdn.amored.ru',
          port: 443,
          forceTls: 'tls',
          sni: ''
        }],
        xhttpSettings: {
          host: '',
          mode: 'packet-up',
          path: '/content/media/stream/',
          scMaxEachPostBytes: '500000-1000000',
          scMinPostsIntervalMs: '50-150',
          uplinkDataPlacement: 'body',
          uplinkHTTPMethod: 'GET',
          xPaddingBytes: '100-1000',
          xPaddingHeader: 'X-Client-Version',
          xPaddingKey: 'hash',
          xPaddingMethod: 'tokenish',
          xPaddingObfsMode: true,
          xPaddingPlacement: 'queryInHeader',
          xmux: {
            cMaxReuseTimes: 1000,
            hKeepAlivePeriod: 20000,
            hMaxRequestTimes: '600-900',
            hMaxReusableSecs: '100',
            maxConcurrency: '16-32',
            maxConnections: 0
          }
        }
      })
    };

    db.prepare(`
      INSERT INTO node_inbound_cache (node_id, inbound_id, inbound_json)
      VALUES (?, ?, ?)
    `).run(node.lastInsertRowid, 1, JSON.stringify(inbound));
  } finally {
    db.close();
  }
}

test('ordinary 3x-ui JSON uses externalProxy public host, port and TLS', { timeout: 45000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-xhttp-proxy-'));
  let appInstance = null;
  t.after(async () => {
    await stopApp(appInstance);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  appInstance = await startApp(dataDir);
  seedExternalProxyFixture(dataDir);

  const response = await fetch(`http://127.0.0.1:${appInstance.port}/json/external-proxy-test?format=single`);
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get('profile-web-page-url'),
    `http://127.0.0.1:${appInstance.port}/open/external-proxy-test`
  );
  const config = await response.json();
  const proxy = config.outbounds.find(outbound => outbound.tag === 'proxy');

  assert.ok(proxy, 'proxy outbound must exist');
  assert.equal(proxy.settings.vnext[0].address, 'la57l.cdn.amored.ru');
  assert.equal(proxy.settings.vnext[0].port, 443);
  assert.equal(proxy.streamSettings.network, 'xhttp');
  assert.equal(proxy.streamSettings.security, 'tls');
  assert.equal(proxy.streamSettings.tlsSettings.serverName, 'la57l.cdn.amored.ru');
  assert.equal(proxy.streamSettings.xhttpSettings.path, '/content/media/stream/');
  assert.equal(proxy.streamSettings.xhttpSettings.mode, 'packet-up');
  assert.equal(proxy.streamSettings.xhttpSettings.extra.xPaddingObfsMode, true);
  assert.notEqual(proxy.settings.vnext[0].address, 'pnl220.cdn.amored.ru');
  assert.notEqual(proxy.settings.vnext[0].port, 2053);
  assert.equal(config.brand.name, 'Nexus Panel');
  assert.equal(config.logoUrl, `http://127.0.0.1:${appInstance.port}/img/nexus-logo-512.png`);
  assert.equal(config.meta.logoUrl, config.logoUrl);
  assert.equal(config.subscription.logoUrl, config.logoUrl);
  assert.equal(config.webPageUrl, `http://127.0.0.1:${appInstance.port}/open/external-proxy-test`);
});
