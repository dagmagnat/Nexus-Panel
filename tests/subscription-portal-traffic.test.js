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

async function startMock3xui(options = {}) {
  const requestedPaths = [];
  const uploadBytes = Number(options.uploadBytes ?? gib);
  const downloadBytes = Number(options.downloadBytes ?? (2 * gib));
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
        obj: { email: 'portal-user', up: uploadBytes, down: downloadBytes, total: 0, enable: true }
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

function addSubscriptionNode(db, { mockPort, name, countryCode, countryName, clientId, uuid, trafficGb }) {
  const nodeResult = db.prepare(`
    INSERT INTO nodes (
      name, node_type, panel_url, panel_path, username, password_enc,
      api_auth_mode, api_token_enc, inbound_id, enabled, last_status,
      country_code, country_name_ru, country_flag
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    name, '3xui', `http://127.0.0.1:${mockPort}`, '', '', encrypt('', appSecret),
    'token', encrypt('test-api-token', appSecret), 1, 1, 'online', countryCode, countryName, ''
  );
  db.prepare(`
    INSERT INTO client_nodes (
      client_id, node_id, remote_email, remote_uuid, traffic_gb,
      limit_ip, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(clientId, nodeResult.lastInsertRowid, 'portal-user', uuid, trafficGb, 2, 1);
  const inbound = {
    id: 1,
    port: 2053,
    protocol: 'vless',
    settings: JSON.stringify({ decryption: 'none', clients: [{ id: uuid, email: 'portal-user', enable: true }] }),
    streamSettings: JSON.stringify({ network: 'tcp', security: 'none' })
  };
  db.prepare('INSERT INTO node_inbound_cache (node_id, inbound_id, inbound_json) VALUES (?, ?, ?)')
    .run(nodeResult.lastInsertRowid, 1, JSON.stringify(inbound));
  return Number(nodeResult.lastInsertRowid);
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
    db.prepare(`
      INSERT INTO app_settings (key, value) VALUES ('routing_config', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(JSON.stringify({
      enabled: true,
      mode: 'proxy-except',
      modeAssignments: { 'proxy-except': [Number(nodeResult.lastInsertRowid)], 'node-selective': [] },
      assignmentExplicit: true,
      exceptDomains: ['geosite:category-ru'],
      exceptIps: ['geoip:ru'],
      customDomains: [],
      customIps: [],
      presets: [],
      adBlockEnabled: false,
      adBlockDomains: [],
      adBlockIps: [],
      geodataSource: 'loyalsoldier',
      dnsPreset: 'cloudflare',
      // Ordinary JSON routing remains active while Happ's separate profile is
      // deliberately disabled.
      happRoutingProfileEnabled: false,
      happRoutingExplicit: true,
      defaultsVersion: 7
    }));
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

  response = await fetch(`http://127.0.0.1:${app.port}/json/portal-user?raw=1`, {
    redirect: 'manual',
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `http://127.0.0.1:${app.port}/open/portal-user`);

  response = await fetch(`http://127.0.0.1:${app.port}/json/portal-user`, {
    headers: { Accept: 'application/json' }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);
  const jsonConfigs = await response.json();
  assert.ok(Array.isArray(jsonConfigs) && jsonConfigs.length >= 1);
  const rules = jsonConfigs[0].routing.rules;
  assert.equal(jsonConfigs[0].routing.domainStrategy, 'IPOnDemand');
  assert.deepEqual(rules.slice(-3), [
    { type: 'field', domain: ['geosite:category-ru', 'regexp:\\.(ru|su|xn--p1ai)$', 'domain:2ip.ru', 'domain:2ip.io', 'domain:2ip.me'], outboundTag: 'direct' },
    { type: 'field', ip: ['geoip:ru'], outboundTag: 'direct' },
    { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }
  ]);

  const selectiveDb = new Database(path.join(dataDir, 'app.db'));
  const selectiveRow = selectiveDb.prepare("SELECT value FROM app_settings WHERE key = 'routing_config'").get();
  const selectiveConfig = JSON.parse(selectiveRow.value);
  selectiveConfig.mode = 'node-selective';
  selectiveConfig.modeAssignments = {
    'proxy-except': [],
    'node-selective': [Number(selectiveConfig.modeAssignments['proxy-except'][0])]
  };
  selectiveConfig.customDomains = ['geosite:telegram'];
  selectiveDb.prepare("UPDATE app_settings SET value = ? WHERE key = 'routing_config'").run(JSON.stringify(selectiveConfig));
  selectiveDb.close();

  response = await fetch(`http://127.0.0.1:${app.port}/json/portal-user`, {
    headers: { Accept: 'application/json' }
  });
  assert.equal(response.status, 200);
  const selectiveJson = await response.json();
  assert.deepEqual(selectiveJson[0].routing.rules.slice(-2), [
    { type: 'field', domain: ['geosite:telegram'], outboundTag: 'proxy' },
    { type: 'field', network: 'tcp,udp', outboundTag: 'direct' }
  ]);

  const restoreDb = new Database(path.join(dataDir, 'app.db'));
  selectiveConfig.mode = 'proxy-except';
  selectiveConfig.modeAssignments = {
    'proxy-except': [Number(selectiveConfig.modeAssignments['node-selective'][0])],
    'node-selective': []
  };
  selectiveConfig.customDomains = [];
  restoreDb.prepare("UPDATE app_settings SET value = ? WHERE key = 'routing_config'").run(JSON.stringify(selectiveConfig));
  restoreDb.close();

  response = await fetch(`http://127.0.0.1:${app.port}/happ/portal-user`, {
    headers: { Accept: '*/*' }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('routing'), null, 'separate Happ routing must stay disabled');
  assert.doesNotMatch(await response.text(), /happ:\/\/routing\/onadd\//);

  response = await fetch(`http://127.0.0.1:${app.port}/happ-routing-json/portal-user`);
  assert.equal(response.status, 404);

  const routingDb = new Database(path.join(dataDir, 'app.db'));
  const routingRow = routingDb.prepare("SELECT value FROM app_settings WHERE key = 'routing_config'").get();
  const routingConfig = JSON.parse(routingRow.value);
  routingConfig.happRoutingProfileEnabled = true;
  routingConfig.happRoutingExplicit = true;
  routingConfig.defaultsVersion = 7;
  routingDb.prepare("UPDATE app_settings SET value = ? WHERE key = 'routing_config'").run(JSON.stringify(routingConfig));
  routingDb.close();

  response = await fetch(`http://127.0.0.1:${app.port}/happ/portal-user`, {
    headers: { Accept: '*/*' }
  });
  assert.equal(response.status, 200);
  const routingHeader = String(response.headers.get('routing') || '');
  assert.match(routingHeader, /^happ:\/\/routing\/onadd\//);
  const routingProfile = JSON.parse(Buffer.from(routingHeader.split('/').pop(), 'base64').toString('utf8'));
  assert.equal(routingProfile.GlobalProxy, 'true');
  assert.ok(routingProfile.DirectSites.includes('geosite:category-ru'));
  assert.ok(routingProfile.DirectIp.includes('geoip:ru'));
  assert.match(await response.text(), /happ:\/\/routing\/onadd\//);

  response = await fetch(`http://127.0.0.1:${app.port}/json/portal-user?download=1`, {
    headers: { Accept: 'text/html,application/xhtml+xml' }
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /application\/json/);

  response = await fetch(`http://127.0.0.1:${app.port}/open/portal-user/status`, { headers: { Accept: 'application/json' } });
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.subscription.usedBytes, 3 * gib);
  assert.equal(status.subscription.totalBytes, 5 * gib);
  assert.equal(status.subscription.nodes.length, 1, 'two share links from one node must not double traffic');

  assert.ok(mock.requestedPaths.includes('GET /panel/api/clients/traffic/portal-user'));
  assert.ok(mock.requestedPaths.includes('GET /panel/api/inbounds/getClientTraffics/portal-user'));
});

test('per-node quota never includes traffic spent on another node', { timeout: 60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(projectRoot, '.tmp-subscription-node-quota-'));
  const primary = await startMock3xui({ uploadBytes: 8 * gib, downloadBytes: 10 * gib });
  const lte = await startMock3xui({ uploadBytes: 2 * gib, downloadBytes: 5 * gib });
  let app = null;
  t.after(async () => {
    await stopApp(app);
    await Promise.all([
      new Promise(resolve => primary.server.close(resolve)),
      new Promise(resolve => lte.server.close(resolve))
    ]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  app = await startApp(dataDir);
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    const uuid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const client = db.prepare(`
      INSERT INTO clients (
        login, display_name, uuid, sub_slug, duration_days, traffic_gb,
        limit_ip, expiry_time, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('portal-user', 'LTE Client', uuid, 'lte-client', 30, 0, 2, Date.now() + 30 * 86400000, 1);
    const primaryNodeId = addSubscriptionNode(db, {
      mockPort: primary.port, name: 'Primary', countryCode: 'DE', countryName: 'Основной',
      clientId: client.lastInsertRowid, uuid, trafficGb: 0
    });
    const lteNodeId = addSubscriptionNode(db, {
      mockPort: lte.port, name: 'LTE', countryCode: 'FI', countryName: 'LTE',
      clientId: client.lastInsertRowid, uuid, trafficGb: 50
    });
    db.prepare(`
      INSERT INTO auto_select_profiles (
        name, icon, node_ids, probe_url, probe_interval_seconds, enabled, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('Самый быстрый', '⚡', JSON.stringify([primaryNodeId, lteNodeId]), 'https://cp.cloudflare.com/generate_204', 30, 1, 1);
  } finally {
    db.close();
  }

  let response = await fetch(`http://127.0.0.1:${app.port}/sub/lte-client?raw=1`);
  assert.equal(response.status, 200);
  const header = parseUserInfo(response.headers.get('subscription-userinfo'));
  assert.equal(header.upload, 10 * gib);
  assert.equal(header.download, 15 * gib);
  assert.equal(header.total, undefined, 'per-node quota must not become a global Subscription-Userinfo total');
  const links = decodeURIComponent(await response.text());
  assert.match(links, /LTE[^\r\n#]*7\/50 ГБ/);
  assert.doesNotMatch(links, /25\/50 ГБ/);

  response = await fetch(`http://127.0.0.1:${app.port}/json/lte-client`, {
    headers: { Accept: 'application/json' }
  });
  assert.equal(response.status, 200);
  const jsonConfigs = await response.json();
  assert.ok(Array.isArray(jsonConfigs));
  assert.equal(jsonConfigs[0].title, '⚡ Самый быстрый');
  assert.equal(jsonConfigs[0].autoSelect.strategy, 'leastPing');
  assert.equal(jsonConfigs[0].autoSelect.connectivityCheck, true);
  assert.equal(jsonConfigs[0].autoSelect.candidates, 2);
  assert.deepEqual(jsonConfigs[0].observatory, {
    subjectSelector: ['auto-1-node-'],
    probeURL: 'https://cp.cloudflare.com/generate_204',
    probeInterval: '30s',
    enableConcurrency: true
  });
  assert.deepEqual(jsonConfigs[0].routing.balancers, [{
    tag: 'auto-1-balancer',
    selector: ['auto-1-node-'],
    strategy: { type: 'leastPing' },
    fallbackTag: 'auto-1-node-1'
  }]);
  const candidateTags = jsonConfigs[0].outbounds
    .filter(outbound => String(outbound.tag || '').startsWith('auto-1-node-'))
    .map(outbound => outbound.tag);
  assert.deepEqual(candidateTags, ['auto-1-node-1', 'auto-1-node-2']);
  const finalRule = jsonConfigs[0].routing.rules.at(-1);
  assert.equal(finalRule.balancerTag, 'auto-1-balancer');
  assert.equal(finalRule.outboundTag, undefined);
  assert.equal(jsonConfigs.length, 3, 'auto-select profile must be prepended without hiding physical regions');

  response = await fetch(`http://127.0.0.1:${app.port}/open/lte-client/status`);
  assert.equal(response.status, 200);
  const status = await response.json();
  assert.equal(status.subscription.quotaMode, 'per-node');
  assert.equal(status.subscription.totalBytes, 0);
  assert.equal(status.subscription.limitedNodeCount, 1);
  const lteNode = status.subscription.nodes.find(node => node.name.includes('LTE'));
  assert.ok(lteNode);
  assert.equal(lteNode.usedBytes, 7 * gib);
  assert.equal(lteNode.totalBytes, 50 * gib);
});
