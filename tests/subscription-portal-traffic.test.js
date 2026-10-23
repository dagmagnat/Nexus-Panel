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

async function startApp(dataDir, nodeEnv = 'development') {
  const port = await reservePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: nodeEnv,
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
    if (options.inbound) {
      const send = obj => res.end(JSON.stringify({ success: true, obj }));
      if (req.url === '/panel/api/server/status') return send({ version: '3.4.0' });
      if (/^\/panel\/api\/inbounds\/get\/\d+$/.test(req.url)) return send(options.inbound(Number(req.url.split('/').at(-1))));
      if (req.url === '/panel/api/setting/all') return send({ subJsonMux: JSON.stringify(options.mux || {}), subJsonFinalMask: '' });
    }
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
    selector: ['auto-1-node-1', 'auto-1-node-2'],
    strategy: { type: 'leastPing' },
    fallbackTag: 'auto-1-unavailable'
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

test('clean JSON and SUB routes return the existing subscription without redirects or losing device checks', { timeout:45000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(projectRoot, '.tmp-clean-links-'));
  const mock = await startMock3xui(); let app, db;
  t.after(async () => { await stopApp(app); db?.close(); await new Promise(r=>mock.server.close(r)); fs.rmSync(dataDir,{recursive:true,force:true}); });
  app = await startApp(dataDir); seedSubscription(dataDir,mock.port);
  db = new Database(path.join(dataDir,'app.db'));
  const slug = 'clean-client-12345678';
  db.prepare('UPDATE clients SET sub_slug=?').run(slug);
  const get = (route, options={}) => fetch(`http://127.0.0.1:${app.port}${route}`, { redirect:'manual', ...options });
  const modern = await get('/' + slug), legacy = await get('/json/' + slug);
  assert.equal(modern.status,200); assert.equal(modern.headers.get('location'),null);
  assert.match(modern.headers.get('content-type'),/application\/json/);
  assert.match(modern.headers.get('cache-control'),/no-store/);
  assert.deepEqual((await modern.json()).map(c=>c.outbounds),(await legacy.json()).map(c=>c.outbounds));
  const plain = await get('/' + slug + '?format=sub&raw=1');
  assert.equal(plain.status,200); assert.match(plain.headers.get('content-type'),/text\/plain/);
  assert.equal(await plain.text(),await (await get('/sub/'+slug+'?raw=1')).text());
  const single = await (await get('/'+slug+'?format=single')).json(); assert.ok(single.outbounds);
  const head = await get('/'+slug,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(await head.text(),'');
  const browser = await get('/'+slug,{headers:{Accept:'text/html'}});
  assert.equal(browser.status,302); assert.ok(browser.headers.get('location').includes('/open/'+slug));
  assert.equal((await get('/'+slug+'?format=bad')).status,400);
  assert.equal((await get('/'+slug+'?format=sub&format=json')).status,400);
  assert.equal((await get('/unknown-client-12345678')).status,404);
  assert.equal((await get('/'+slug,{method:'POST'})).status,403,'existing CSRF guard remains active');
  assert.equal((await get('/clients')).status,302,'admin endpoint is still protected');
  for (const [key,value] of Object.entries({subscription_device_tracking_enabled:'1',subscription_device_limit_enforced:'1',subscription_device_require_hwid:'1'})) {
    db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);
  }
  db.prepare('UPDATE clients SET limit_ip=1,device_limit=1').run();
  db.prepare('DELETE FROM subscription_devices').run();
  const hwidRequest = hwid => get('/'+slug,{headers:{'X-HWID':hwid,'User-Agent':'Happ/clean-link-test'}});
  const allowed = await (await hwidRequest('device-A-12345678')).text(); assert.ok(allowed.includes('edge-a.example.test'),allowed.slice(0,1200));
  const blocked = await (await hwidRequest('device-B-12345678')).text(); assert.ok(!blocked.includes('edge-a.example.test'),'clean URL must not bypass HWID limit');
  const status = await (await get('/open/'+slug+'/status')).json();
  assert.ok(status.subscription);
  const portal = await (await get('/open/'+slug)).text();
  assert.ok(portal.includes('/'+slug), 'public account links remain usable');
  assert.ok(!portal.includes('/json/'+slug), 'newly displayed JSON link has no format path');
  db.prepare('UPDATE clients SET enabled=0').run(); assert.equal((await get('/'+slug)).status,404);
  db.prepare('UPDATE clients SET enabled=1').run();
  await stopApp(app); app = await startApp(dataDir);
  assert.equal((await hwidRequest('device-A-12345678')).status,200);
});

test('clean URL setting saves on/off, controls all client links, preserves routes and survives restart', { timeout:60000 }, async t => {
  const dataDir=fs.mkdtempSync(path.join(projectRoot,'.tmp-link-settings-'));
  const mock=await startMock3xui();let app,db;
  t.after(async()=>{await stopApp(app);db?.close();await new Promise(r=>mock.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});});
  // Production omits the dev-only inspector that overlays mobile save actions.
  app=await startApp(dataDir,'production');seedSubscription(dataDir,mock.port);
  db=new Database(path.join(dataDir,'app.db'));
  const slug='settings-client-12345678';db.prepare('UPDATE clients SET sub_slug=?').run(slug);
  const id=db.prepare('SELECT id FROM clients').get().id;
  const setting=key=>db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value;
  assert.equal(setting('subscription_clean_urls'),'1','upgrade/fresh default preserves 2.7.17');
  const cookies=new Map();let csrf='';
  async function request(route,body){
    const headers={'X-Nexus-Workspace':'main'};
    if(cookies.size)headers.Cookie=[...cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    if(body)headers['Content-Type']='application/x-www-form-urlencoded';
    const r=await fetch(`http://127.0.0.1:${app.port}${route}`,{method:body?'POST':'GET',headers,body:body?new URLSearchParams(body):undefined,redirect:'manual'});
    for(const value of r.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
    const text=await r.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;
    return {status:r.status,text,location:r.headers.get('location')};
  }
  await request('/login');assert.equal((await request('/login',{_csrf:csrf,username:'admin',password:'test-password-strong'})).status,302);
  const form=()=>({_csrf:csrf,subscription_name:setting('subscription_name'),subscription_brand_tagline:setting('subscription_brand_tagline'),
    show_sub_links:'1',show_json_links:'1',subscription_show_limits:'1',sub_url_mode:'custom',
    panel_public_url:`http://127.0.0.1:${app.port}`,sub_public_url:`http://127.0.0.1:${app.port}`});
  async function checkLinks(clean){
    const json=clean?`/${slug}`:`/json/${slug}`,sub=clean?`/${slug}?format=sub`:`/sub/${slug}`;
    const page=await request('/clients?edit='+id);
    assert.equal(page.status,200);assert.ok(!page.text.includes('Страница не смогла отрисоваться'));
    assert.ok(page.text.includes(`data-json-url="http://127.0.0.1:${app.port}${json}"`),json);
    assert.ok(page.text.includes(`data-sub-url="http://127.0.0.1:${app.port}${sub}"`),sub);
    const summary=JSON.parse((await request(`/clients/${id}/summary.json`)).text);
    assert.equal(summary.client.links.json,`http://127.0.0.1:${app.port}${json}`);
    assert.equal(summary.client.links.sub,`http://127.0.0.1:${app.port}${sub}`);
    const portal=await request('/open/'+slug);assert.equal(portal.status,200);
    assert.ok(portal.text.includes(`http://127.0.0.1:${app.port}${json}`));
    assert.ok(portal.text.includes(`http://127.0.0.1:${app.port}${sub}`));
    const settings=await request('/settings');assert.equal(settings.status,200);
    const control=settings.text.match(/<input[^>]+name="subscription_clean_urls"[^>]*>/)?.[0];assert.ok(control);
    assert.equal(control.includes('checked'),clean);
    assert.ok(settings.text.includes(json.replace(slug,'&lt;ключ-клиента&gt;')));
    for(const url of [`/${slug}`,`/json/${slug}`,`/${slug}?format=sub`,`/sub/${slug}`]){
      const r=await request(url);assert.equal(r.status,200,url);assert.equal(r.location,null);
      if(url.includes('sub'))assert.match(r.text,/vless:\/\//);else assert.ok(JSON.parse(r.text)[0].outbounds);
    }
  }
  await checkLinks(true);
  const rev=setting('subscription_revision');
  const off=await request('/settings',{...form(),subscription_link_controls:'1'});assert.equal(off.status,302);assert.ok(!off.location.includes('error='),off.location);
  assert.equal(setting('subscription_clean_urls'),'0');assert.notEqual(setting('subscription_revision'),rev);
  await checkLinks(false);
  const revOff=setting('subscription_revision');
  await request('/settings',form());assert.equal(setting('subscription_clean_urls'),'0','old open form must not reset the switch');
  assert.equal(setting('subscription_revision'),revOff);
  const denied=await request('/settings',{...form(),_csrf:'wrong',subscription_link_controls:'1',subscription_clean_urls:'1'});
  assert.equal(denied.status,403);assert.equal(setting('subscription_clean_urls'),'0');
  const on=await request('/settings',{...form(),subscription_link_controls:'1',subscription_clean_urls:'1'});assert.ok(!on.location.includes('error='));
  assert.equal(setting('subscription_clean_urls'),'1');await checkLinks(true);
  if(process.env.NEXUS_PLAYWRIGHT_MODULE){
    const {chromium}=require(process.env.NEXUS_PLAYWRIGHT_MODULE);const browser=await chromium.launch({headless:true,channel:'msedge'});
    try{
      const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await page.goto(`http://127.0.0.1:${app.port}/login`);await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill('test-password-strong');
      await Promise.all([page.waitForURL('**/dashboard'),page.locator('button[type=submit]').click()]);
      for(const [width,enabled] of [[1440,false],[390,true]]){
        await page.setViewportSize({width,height:920});await page.goto(`http://127.0.0.1:${app.port}/settings?settings_tab=settings-tab-general`);
        const control=page.locator('[name=subscription_clean_urls]');await control.setChecked(enabled);
        await control.scrollIntoViewIfNeeded();assert.equal(await control.isChecked(),enabled);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        if(process.env.NEXUS_UI_SCREENSHOT_DIR)await control.locator('..').screenshot({path:path.join(process.env.NEXUS_UI_SCREENSHOT_DIR,`subscription-link-switch-${width}.png`)});
        const settingsForm=page.locator('form[action="/settings"]');
        // On mobile the existing sticky save bar overlays the form footer.
        const floatingSave=page.locator('.global-floating-save.is-visible').getByRole('button',{name:'Сохранить',exact:true});
        const save=await floatingSave.isVisible()?floatingSave:settingsForm.getByRole('button',{name:'Сохранить',exact:true});
        try {
          await Promise.all([page.waitForURL(url=>url.searchParams.has('message'),{timeout:10000}),save.click({timeout:5000})]);
        } catch(error) {
          const details=await page.evaluate(()=>({url:location.href,alerts:[...document.querySelectorAll('.alert')].map(e=>e.innerText),invalid:[...document.querySelectorAll('form[action="/settings"] :invalid')].map(e=>({name:e.name,message:e.validationMessage}))}));
          throw Error(error.message+'\n'+JSON.stringify(details));
        }
        assert.equal(setting('subscription_clean_urls'),enabled?'1':'0');
      }
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  }
  await request('/settings',{...form(),subscription_link_controls:'1'});
  await stopApp(app);app=await startApp(dataDir,'production');
  assert.equal(setting('subscription_clean_urls'),'0','disabled preference survives restart');
  const portal=await(await fetch(`http://127.0.0.1:${app.port}/open/${slug}`)).text();assert.ok(portal.includes('/json/'+slug));
  assert.equal((await fetch(`http://127.0.0.1:${app.port}/${slug}`)).status,200,'clean URL still works after disabling and restarting');
});

test('ordinary 3x-ui UDP443 migrates, saves per node and survives JSON, SUB, auto pools and restart', { timeout:60000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(projectRoot, '.tmp-node-udp443-'));
  const uuid = '11111111-2222-4333-8444-555555555555';
  const sourceMux = { enabled: true, concurrency: 8, xudpConcurrency: 16, xudpProxyUDP443: 'reject' };
  const inbound = id => ({ id, port: 2052 + id, protocol: 'vless', enable: true,
    settings: JSON.stringify({ decryption: 'none', clients: [{ id: uuid, email: 'portal-user', enable: true, flow: 'xtls-rprx-vision' }] }),
    streamSettings: JSON.stringify({ network: 'tcp', security: 'reality', realitySettings: { publicKey: 'test-key', serverNames: ['example.test'], shortIds: ['abcd'] } }),
    sniffing: '{}' });
  const mock = await startMock3xui({ inbound, mux: sourceMux });
  let app, db;
  t.after(async () => { await stopApp(app); db?.close(); await new Promise(r => mock.server.close(r)); fs.rmSync(dataDir, { recursive: true, force: true }); });
  app = await startApp(dataDir); seedSubscription(dataDir, mock.port);
  await stopApp(app);
  db = new Database(path.join(dataDir, 'app.db'));
  // Simulate a 2.7.15 database with existing subscriptions, then run the real migration.
  db.prepare('ALTER TABLE nodes DROP COLUMN allow_udp443').run();
  app = await startApp(dataDir);
  const node1 = db.prepare('SELECT * FROM nodes').get();
  assert.equal(node1.allow_udp443, 1);
  db.prepare('UPDATE node_inbound_cache SET inbound_json=? WHERE node_id=?').run(JSON.stringify(inbound(1)), node1.id);
  const c = db.prepare('SELECT * FROM clients').get();
  const node2 = addSubscriptionNode(db, { mockPort: mock.port, name: 'Finland', countryCode: 'FI', countryName: 'Финляндия', clientId: c.id, uuid, trafficGb: 0 });
  db.prepare('UPDATE nodes SET sort_order=1 WHERE id=?').run(node1.id);
  db.prepare('UPDATE nodes SET sort_order=2 WHERE id=?').run(node2);
  db.prepare('UPDATE node_inbound_cache SET inbound_json=? WHERE node_id=?').run(JSON.stringify(inbound(1)), node2);
  db.prepare('UPDATE nodes SET allow_udp443=0 WHERE id=?').run(node2);

  const cookies = new Map();
  async function request(route, options = {}) {
    const headers = new Headers(options.headers || {}); headers.set('X-Nexus-Workspace', 'main');
    if (cookies.size) headers.set('Cookie', [...cookies].map(([k,v]) => `${k}=${v}`).join('; '));
    const r = await fetch(`http://127.0.0.1:${app.port}${route}`, { ...options, headers, redirect: 'manual' });
    for (const value of r.headers.getSetCookie()) { const pair=value.split(';')[0], i=pair.indexOf('='); cookies.set(pair.slice(0,i),pair.slice(i+1)); }
    return r;
  }
  const csrfFrom = html => { const m=html.match(/name="csrf-token" content="([^"]+)"/); assert.ok(m); return m[1]; };
  const post = (route, body) => request(route, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body instanceof URLSearchParams ? body : new URLSearchParams(body) });
  const loginToken = csrfFrom(await (await request('/login')).text());
  assert.equal((await post('/login', { _csrf: loginToken, username: 'admin', password: 'test-password-strong' })).headers.get('location'), '/dashboard');
  const html = await (await request(`/nodes/${node1.id}/edit`)).text();
  assert.match(html, /name="allow_udp443" value="1" checked/);
  const csrf = csrfFrom(html);
  const baseForm = { _csrf: csrf, node_type: '3xui', panel_url: `http://127.0.0.1:${mock.port}`, panel_path: '', api_auth_mode: 'token', api_token: 'test-api-token', inbound_id: '1', country_code: 'DE', sni_mode: 'inbound' };
  async function save(body) {
    const r = await post(`/nodes/${node1.id}/edit`, { ...baseForm, ...body });
    assert.equal(r.status, 302); assert.ok(!r.headers.get('location').includes('error='), decodeURIComponent(r.headers.get('location')));
  }
  const configs = async () => { const r = await request('/json/portal-user?download=1'); assert.equal(r.status, 200); return r.json(); };
  const flows = configs => configs.filter(c => !c.autoSelect).map(c => c.outbounds.find(o => o.protocol === 'vless').settings.vnext[0].users[0].flow);
  assert.deepEqual(flows(await configs()), ['xtls-rprx-vision-udp443', 'xtls-rprx-vision']);
  const rawSub = async () => { const s = await (await request('/sub/portal-user?raw=1')).text(); return s.includes('vless://') ? s : Buffer.from(s, 'base64').toString(); };
  assert.ok((await rawSub()).includes('flow=xtls-rprx-vision-udp443'));
  const rev = () => db.prepare("SELECT value FROM app_settings WHERE key='subscription_revision'").get().value;
  const beforeRev = rev();
  await save({ udp443_controls: '1' });
  assert.notEqual(rev(), beforeRev);
  assert.equal(db.prepare('SELECT allow_udp443 FROM nodes WHERE id=?').get(node1.id).allow_udp443, 0);
  assert.deepEqual(flows(await configs()), ['xtls-rprx-vision', 'xtls-rprx-vision']);
  assert.ok(!(await rawSub()).includes('flow=xtls-rprx-vision-udp443'));
  await save({}); // stale form must not silently enable the flag
  assert.equal(db.prepare('SELECT allow_udp443 FROM nodes WHERE id=?').get(node1.id).allow_udp443, 0);
  assert.equal((await post(`/nodes/${node1.id}/edit`, { ...baseForm, _csrf: '', udp443_controls: '1', allow_udp443: '1' })).status, 403);
  await save({ udp443_controls: '1', allow_udp443: '1', inherit_3xui_mux: '1' });
  const cfg = (await configs())[0], out = cfg.outbounds.find(o => o.protocol === 'vless');
  assert.equal(out.settings.vnext[0].users[0].flow, 'xtls-rprx-vision-udp443');
  assert.deepEqual(out.mux, { ...sourceMux, xudpProxyUDP443: 'skip' });
  assert.deepEqual(JSON.parse(db.prepare('SELECT source_sub_json_mux FROM nodes WHERE id=?').get(node1.id).source_sub_json_mux), sourceMux);
  assert.equal(JSON.parse(db.prepare('SELECT inbound_json FROM node_inbound_cache WHERE node_id=?').get(node1.id).inbound_json).settings, inbound(1).settings, 'server flow remains unchanged');
  await save({ udp443_controls: '1', inherit_3xui_mux: '1' });
  assert.equal((await configs())[0].outbounds[0].mux.xudpProxyUDP443, 'reject');
  await save({ udp443_controls: '1', allow_udp443: '1' });
  assert.equal((await configs())[0].outbounds[0].mux, undefined, 'UDP443 does not enable Mux');

  for (const [id, controls, expected] of [[2, { udp443_controls: '1' }, 0], [3, {}, 1]]) {
    const r = await post('/nodes', { ...baseForm, inbound_id: String(id), ...controls });
    assert.ok(!r.headers.get('location').includes('error='), decodeURIComponent(r.headers.get('location')));
    assert.equal(db.prepare('SELECT allow_udp443 FROM nodes WHERE inbound_id=? ORDER BY id DESC LIMIT 1').get(id).allow_udp443, expected);
  }
  const autoForm = new URLSearchParams({ _csrf: csrf, node_type: 'auto_select', auto_select_name: 'UDP pool', auto_select_icon: '⚡', auto_select_probe_interval_seconds: '30', auto_select_probe_url: 'https://cp.cloudflare.com/generate_204' });
  for (const id of [node1.id, node2]) autoForm.append('auto_select_node_ids', String(id));
  const autoSaved = await post('/nodes', autoForm); assert.ok(!autoSaved.headers.get('location').includes('error='));
  const auto = (await configs()).find(c => c.autoSelect);
  assert.ok(auto);
  assert.deepEqual(auto.outbounds.filter(o => o.protocol === 'vless').map(o => o.settings.vnext[0].users[0].flow), ['xtls-rprx-vision-udp443', 'xtls-rprx-vision']);
  const backup = await (await request('/backup/download')).json();
  assert.equal(backup.data.nodes.find(n => n.id === node2).allow_udp443, 0);
  assert.ok(mock.requestedPaths.every(p => p.startsWith('GET ') || p === 'POST /panel/api/setting/all'), 'no remote settings/client mutation is needed');
  db.prepare('UPDATE nodes SET allow_udp443=1 WHERE id=?').run(node2);
  const restored = await request('/backup/restore', { method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-CSRF-Token': csrf }, body: JSON.stringify(backup) });
  assert.equal(restored.status, 302);
  assert.equal(db.prepare('SELECT allow_udp443 FROM nodes WHERE id=?').get(node2).allow_udp443, 0);
  await stopApp(app); app = await startApp(dataDir);
  assert.deepEqual(flows(await configs()), ['xtls-rprx-vision-udp443', 'xtls-rprx-vision']);
  const tlsInbound = inbound(1);
  tlsInbound.streamSettings = JSON.stringify({ network: 'tcp', security: 'tls', tlsSettings: { serverName: 'example.test' } });
  db.prepare('UPDATE node_inbound_cache SET inbound_json=? WHERE node_id=?').run(JSON.stringify(tlsInbound), node1.id);
  assert.equal(flows(await configs())[0], 'xtls-rprx-vision-udp443', 'TLS Vision is preserved in JSON as well as in the source URI');
});

test('multiple auto-connections create, edit, toggle and delete independently via HTTP and survive restart', { timeout:60000 }, async t => {
  const dataDir=fs.mkdtempSync(path.join(projectRoot,'.tmp-multi-auto-'));
  const mock=await startMock3xui();let app,db;
  t.after(async()=>{await stopApp(app);db?.close();await new Promise(r=>mock.server.close(r));fs.rmSync(dataDir,{recursive:true,force:true});});
  app=await startApp(dataDir);seedSubscription(dataDir,mock.port);
  db=new Database(path.join(dataDir,'app.db'));
  const c=db.prepare('SELECT * FROM clients').get();
  db.prepare('UPDATE clients SET traffic_gb=0 WHERE id=?').run(c.id);
  const node2=addSubscriptionNode(db,{mockPort:mock.port,name:'Finland',countryCode:'FI',countryName:'Финляндия',clientId:c.id,uuid:c.uuid,trafficGb:0});
  const node3=addSubscriptionNode(db,{mockPort:mock.port,name:'Sweden',countryCode:'SE',countryName:'Швеция',clientId:c.id,uuid:c.uuid,trafficGb:0});
  const node1=db.prepare('SELECT id FROM nodes ORDER BY id LIMIT 1').get().id;
  const cookieJar=new Map();
  const request=async(route,options={})=>{
    const headers=new Headers(options.headers||{});headers.set('X-Nexus-Workspace','main');
    if(cookieJar.size)headers.set('Cookie',[...cookieJar].map(([k,v])=>`${k}=${v}`).join('; '));
    const r=await fetch(`http://127.0.0.1:${app.port}${route}`,{...options,headers,redirect:'manual'});
    for(const value of r.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');cookieJar.set(pair.slice(0,i),pair.slice(i+1));}return r;
  };
  const readCsrf=html=>{const m=html.match(/name="csrf-token" content="([^"]+)"/);assert.ok(m);return m[1];};
  const loginCsrf=readCsrf(await(await request('/login')).text());
  const post=(route,body)=>request(route,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body instanceof URLSearchParams?body:new URLSearchParams(body)});
  const login=await post('/login',{_csrf:loginCsrf,username:'admin',password:'test-password-strong'});
  assert.equal(login.headers.get('location'),'/dashboard');
  const html=await(await request('/nodes?create=auto_select')).text();
  assert.match(html,/Новое автоподключение/);assert.match(html,/<option value="auto_select" selected>/);
  assert.match(html,/data-create-auto-select/);
  const csrf=readCsrf(html);
  const forms=[
    {name:'Европа',nodes:[node1,node2],seconds:10},
    {name:'CDN',nodes:[node1,node3],seconds:60},
    {name:'Резерв',nodes:[node2,node3],seconds:120}
  ];
  function form(spec){
    const body=new URLSearchParams({_csrf:csrf,node_type:'auto_select',auto_select_name:spec.name,auto_select_icon:'⚡',auto_select_probe_interval_seconds:String(spec.seconds),auto_select_probe_url:'https://cp.cloudflare.com/generate_204'});
    for(const id of spec.nodes)body.append('auto_select_node_ids',String(id));return body;
  }
  for(const spec of forms){
    const r=await post('/nodes',form(spec));assert.equal(r.status,302);
    const location=new URL(r.headers.get('location'),'http://local');assert.equal(location.searchParams.get('create'),'auto_select');assert.ok(!location.searchParams.has('error'),location.toString());
  }
  const profiles=db.prepare('SELECT * FROM auto_select_profiles ORDER BY id').all();
  assert.equal(profiles.length,3);assert.deepEqual(profiles.map(p=>p.name),forms.map(f=>f.name));
  assert.equal(new Set(profiles.map(p=>p.id)).size,3);
  const configs=async()=>{const r=await request('/json/portal-user?download=1');assert.equal(r.status,200);return r.json();};
  const first=await configs(), autos=first.filter(x=>x.autoSelect?.enabled);
  assert.deepEqual(autos.map(x=>x.title),forms.map(f=>'⚡ '+f.name));
  assert.equal(first.filter(x=>!x.autoSelect).length,4,'ordinary regions including two external proxies remain visible');
  for(let i=0;i<autos.length;i++){
    const cfg=autos[i],p=profiles[i],spec=forms[i];
    assert.deepEqual(cfg.autoSelect.normalNodeIds,spec.nodes);assert.equal(cfg.observatory.probeInterval,`${spec.seconds}s`);
    assert.deepEqual(cfg.observatory.subjectSelector,[`auto-${p.id}-node-`]);
    const tags=new Set(cfg.outbounds.map(o=>o.tag));
    for(const balancer of cfg.routing.balancers){assert.ok(balancer.selector.every(tag=>tags.has(tag)));assert.ok(tags.has(balancer.fallbackTag));}
    assert.ok(cfg.routing.balancers.every(b=>b.tag.startsWith(`auto-${p.id}-`)));
  }
  const invalid=await post('/nodes',form({name:'Bad',nodes:[node1],seconds:30}));
  assert.equal(new URL(invalid.headers.get('location'),'http://local').searchParams.get('create'),'auto_select');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auto_select_profiles').get().n,3);
  assert.equal((await post('/nodes',new URLSearchParams({node_type:'auto_select'}))).status,403);
  const edited={name:'Европа 2',nodes:[node2,node3],seconds:30};
  await post(`/auto-select-profiles/${profiles[0].id}/edit`,form(edited));
  assert.deepEqual(db.prepare('SELECT * FROM auto_select_profiles WHERE id=?').get(profiles[1].id),profiles[1]);
  assert.deepEqual(db.prepare('SELECT * FROM auto_select_profiles WHERE id=?').get(profiles[2].id),profiles[2]);
  assert.deepEqual((await configs()).filter(x=>x.autoSelect).map(x=>x.title),['⚡ Европа 2','⚡ CDN','⚡ Резерв']);
  await post(`/auto-select-profiles/${profiles[1].id}/toggle`,{_csrf:csrf});
  assert.deepEqual((await configs()).filter(x=>x.autoSelect).map(x=>x.title),['⚡ Европа 2','⚡ Резерв']);
  await post(`/auto-select-profiles/${profiles[2].id}/delete`,{_csrf:csrf});
  assert.deepEqual((await configs()).filter(x=>x.autoSelect).map(x=>x.title),['⚡ Европа 2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n,3);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n,1);
  const sub=await(await request('/sub/portal-user?raw=1')).text();
  assert.ok(!sub.includes('Европа 2'),'auto profiles must not become fake VLESS/SUB endpoints');
  const dnsRoutingForm=new URLSearchParams({_csrf:csrf,routing_enabled:'1',routing_dns_controls:'1',routing_modes:'proxy-except',
    direct_dns_enabled:'1',direct_dns_preset:'yandex',sniffing_route_only:'1',except_domains:'geosite:category-ru\ndomain:qip.ru',dns_preset:'google'});
  dnsRoutingForm.append('routing_mode_nodes_proxy_except',String(node1));dnsRoutingForm.append('routing_mode_nodes_proxy_except',String(node2));
  const dnsSaved=await post('/routing',dnsRoutingForm);assert.ok(!dnsSaved.headers.get('location').includes('error='));
  const withDns=await configs();const autoDns=withDns.find(x=>x.autoSelect);
  assert.equal(autoDns.dns.servers.filter(x=>x.tag==='nexus-dns-direct').length,2);
  assert.ok(autoDns.routing.rules.some(x=>x.inboundTag?.includes('nexus-dns-proxy')&&x.balancerTag&&!x.outboundTag),'autoconnect DNS proxy must use the balancer, not a renamed-away proxy tag');
  assert.ok(autoDns.routing.rules.some(x=>x.inboundTag?.includes('nexus-dns-direct')&&x.outboundTag==='direct'));
  assert.ok(autoDns.inbounds.every(x=>x.sniffing.routeOnly===true));
  await stopApp(app);app=await startApp(dataDir);
  assert.deepEqual((await configs()).filter(x=>x.autoSelect).map(x=>x.title),['⚡ Европа 2']);
  assert.ok((await configs()).find(x=>x.autoSelect).dns.servers.some(x=>x.tag==='nexus-dns-direct'),'direct DNS persists after restart');
  assert.equal(db.prepare('SELECT enabled FROM auto_select_profiles WHERE id=?').get(profiles[1].id).enabled,0);
  if(process.env.NEXUS_PLAYWRIGHT_MODULE){
    const {chromium}=require(process.env.NEXUS_PLAYWRIGHT_MODULE);
    const browser=await chromium.launch({headless:true,channel:'msedge'});
    try{
      const page=await browser.newPage();const errors=[],uiPosts=[];page.on('pageerror',e=>errors.push(e.message));
      page.on('request',r=>{if(r.method()==='POST' && new URL(r.url()).pathname==='/nodes')uiPosts.push(new URLSearchParams(r.postData()));});
      await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await page.goto(`http://127.0.0.1:${app.port}/login`);
      await page.locator('[name=username]').fill('admin');await page.locator('[name=password]').fill('test-password-strong');
      await Promise.all([page.waitForURL('**/dashboard'),page.locator('button[type=submit]').click()]);
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:900});
        await page.goto(`http://127.0.0.1:${app.port}/nodes?tab=list`);
        await Promise.all([page.waitForURL(url=>url.searchParams.get('create')==='auto_select'),page.locator('[data-create-auto-select]:visible').click()]);
        const form=page.locator('#node-create-form');
        await form.locator('[name=auto_select_name]').waitFor({state:'visible'});
        assert.equal(await form.locator('[name=node_type]').inputValue(),'auto_select');
        assert.equal(await form.locator('[name=country_code]').isDisabled(),true);
        assert.equal(await form.locator('[name=panel_url]').isDisabled(),true);
        await form.locator('[name=node_type]').selectOption('3xui');
        assert.equal(await form.locator('[name=api_token]').isEnabled(),true);
        await form.locator('[name=node_type]').selectOption('remnawave');
        assert.equal(await form.locator('[name=api_token]').isEnabled(),true);
        await form.locator('[name=node_type]').selectOption('auto_select');
        await page.waitForTimeout(300); // Exercise the late legacy auth pass.
        assert.equal(await form.locator('[name=api_token]').isDisabled(),true);
        await form.locator('[name=auto_select_name]').fill(`UI ${width}`);
        for(const id of [node2,node3])await form.locator(`[name=auto_select_node_ids][value="${id}"]`).check();
        try {
          await Promise.all([page.waitForURL(url=>url.searchParams.has('message'),{timeout:10000}),form.locator('[type=submit]').click()]);
        } catch(error) {
          const details=await page.evaluate(()=>({url:location.href,alerts:[...document.querySelectorAll('.alert,dialog[open]')].map(e=>e.innerText),invalid:[...document.querySelectorAll('#node-create-form :invalid')].map(e=>({name:e.name,disabled:e.disabled})),buttons:[...document.querySelectorAll('#node-create-form button')].map(e=>({text:e.innerText,disabled:e.disabled}))}));
          throw Error(error.message+'\n'+JSON.stringify(details));
        }
        assert.match(await page.locator('.alert.ok').filter({hasText:'автоподключение создано'}).innerText(),/автоподключение создано/);
        assert.equal(await page.locator('#node-create-form [name=node_type]').inputValue(),'auto_select');
        assert.equal(await page.locator('#node-create-form [name=auto_select_name]').inputValue(),'');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        if(process.env.NEXUS_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.NEXUS_UI_SCREENSHOT_DIR,`multi-auto-${width}.png`),fullPage:true});
      }
      assert.equal(errors.length,0,errors.join('\n'));
      assert.equal(uiPosts.length,2);
      for(const body of uiPosts)for(const name of ['panel_url','api_token','username','password','inbound_id'])assert.equal(body.has(name),false,name);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM auto_select_profiles').get().n,4);
    }finally{await browser.close();}
  }
});
