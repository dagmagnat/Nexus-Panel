'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { fork } = require('node:child_process');
const Database = require('better-sqlite3');
const key = n => Buffer.alloc(32, n).toString('base64');

test('HTTP: add AWG node for all clients, mixed SUB/JSON, lifecycle and isolated peer credentials', { timeout: 60000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-awg-'));
  const inbounds = new Map([
    [42, { id: 42, protocol: 'amneziawg', port: 51820, enable: true, shareAddrStrategy: 'custom', shareAddr: 'vpn.example',
      settings: { server: { publicKey: key(1), privateKey: key(2), primaryDns: '1.1.1.1', s1: 73, s2: 65, s3: 48, s4: 24,
        jc: 4, jmin: 40, jmax: 90, h1: '1-100', h2: '101-200', h3: '201-300', h4: '301-400',
        headerProtectionKey: key(3), contentPaddingAddition: '16-52', randomTrailers: true, disableCookies: true }, clients: [] } }],
    [43, { id: 43, protocol: 'vless', port: 443, enable: true, shareAddrStrategy: 'custom', shareAddr: 'vless.example',
      settings: { clients: [] }, streamSettings: { network: 'tcp', security: 'none' } }]
  ]);
  const clients = new Map(), writes = [], unexpected = [];
  const remote = http.createServer(async (req, res) => {
    const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let text = ''; for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : {};
    let obj;
    if (route === '/panel/api/server/status') obj = { version: '3.10.0' };
    else if (route === '/panel/api/setting/all') obj = {};
    else if (/\/inbounds\/get\/\d+$/.test(route)) {
      const inbound = inbounds.get(Number(route.split('/').pop()));
      obj = { ...inbound, settings: JSON.stringify(inbound.settings) };
    } else if (route === '/panel/api/clients/list') obj = [...clients.values()].map(c => ({ client: c, inboundIds: c.inboundIds }));
    else if (route.startsWith('/panel/api/clients/get/')) {
      const c = clients.get(route.split('/').pop());
      if (!c) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: false, msg: 'record not found' })); return; }
      // Deliberately expose a DIFFERENT tunnel identity in the global row.
      obj = { client: { ...c, privateKey: key(20), publicKey: key(21), allowedIPs: '10.99.0.2/32', keepAlive: '50-60' }, inboundIds: c.inboundIds };
    } else if (route === '/panel/api/clients/add') {
      writes.push({ route, body });
      const c = { ...body.client, uuid: body.client.id, id: clients.size + 1, inboundIds: body.inboundIds };
      clients.set(c.email, c);
      for (const id of c.inboundIds) {
        const peer = { ...body.client };
        if (id === 42) Object.assign(peer, { privateKey: key(c.id + 4), publicKey: key(c.id + 10),
          allowedIPs: [`10.8.1.${c.id + 1}/32`], preSharedKey: key(7), keepAlive: '15-25' });
        inbounds.get(id).settings.clients.push(peer);
      }
      obj = null;
    } else if (route.includes('/clients/update/')) {
      writes.push({ route, body });
      const email = route.split('/').pop(), c = clients.get(email);
      assert.ok(c);
      assert.ok(!('privateKey' in body), 'AWG update must not copy global tunnel keys');
      assert.ok(!('allowedIPs' in body), 'AWG update must preserve inbound address');
      Object.assign(c, body);
      for (const ib of inbounds.values()) for (const peer of ib.settings.clients) if (peer.email === email) Object.assign(peer, body);
      obj = null;
    } else if (/\/clients\/[^/]+\/attach$/.test(route)) {
      const email = route.split('/').at(-2), c = clients.get(email);
      for (const id of body.inboundIds) {
        if (!c.inboundIds.includes(id)) c.inboundIds.push(id);
        if (!inbounds.get(id).settings.clients.some(p => p.email === email)) inbounds.get(id).settings.clients.push({ ...c, id: c.uuid });
      }
      obj = null;
    } else if (/\/clients\/[^/]+\/detach$/.test(route)) {
      const email = route.split('/').at(-2), c = clients.get(email);
      c.inboundIds = c.inboundIds.filter(id => !body.inboundIds.includes(id));
      for (const id of body.inboundIds) inbounds.get(id).settings.clients = inbounds.get(id).settings.clients.filter(p => p.email !== email);
      obj = null;
    } else if (route.includes('ClientTraffics') || route.includes('ClientTraffic') || route.includes('/clients/traffic/')) {
      const c = clients.get(route.split('/').pop());
      obj = { email: c?.email, up: 0, down: 0, enable: c?.enable ?? true, total: c?.totalGB || 0, expiryTime: c?.expiryTime || 0 };
    } else { unexpected.push(route); res.writeHead(404).end(); return; }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ success: true, obj }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  let db, logs = '';
  let child;
  function startApp() {
  const app = fork(path.join(__dirname, '../app.js'), [], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: {
    ...process.env, DOTENV_CONFIG_PATH: path.join(dir, 'absent.env'), DATA_DIR: dir, NEXUS_CONTROL_DIR: dir, NODE_ENV: 'development', PORT: '0',
    ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'test-owner-password', APP_SECRET: 'a'.repeat(64), SESSION_SECRET: 's'.repeat(64),
    SESSION_SECURE: '0', TRUST_PROXY: '0', NEXUS_NODE_ENABLED: '0', PANEL_PUBLIC_URL: 'http://localhost:3000', SUB_PUBLIC_URL: 'http://localhost:3000'
  } });
  app.stderr.on('data', d => logs += d); app.stdout.on('data', () => {});
  return app;
  }
  child = startApp();
  t.after(async () => {
    db?.close(); child.kill();
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
    await new Promise(resolve => remote.close(resolve));
    if (path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  function ready(app) { return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(logs || 'startup timeout')), 20000);
    app.on('message', m => { if (m.type === 'ready') { clearTimeout(timer); resolve(m.port); } });
    app.once('exit', () => { clearTimeout(timer); reject(new Error(logs)); });
  }); }
  let port = await ready(child);
  let cookie = '', csrf = '';
  async function request(route, body, extraHeaders = {}) {
    const headers = { cookie, ...extraHeaders };
    let encoded;
    if (body) {
      encoded = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) for (const item of Array.isArray(v) ? v : [v]) encoded.append(k, item);
      encoded.set('_csrf', csrf); encoded.set('_workspace', 'main'); headers['content-type'] = 'application/x-www-form-urlencoded';
    }
    const r = await fetch(`http://127.0.0.1:${port}${route}`, { method: body ? 'POST' : 'GET', headers, body: encoded?.toString(), redirect: 'manual' });
    if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie').split(';')[0];
    const text = await r.text(); csrf = text.match(/name="csrf-token" content="([^"]+)"/)?.[1] || csrf;
    return { status: r.status, text, location: r.headers.get('location') };
  }
  function successful(r) { assert.equal(r.status, 302, r.text); assert.ok(!r.location.includes('error='), decodeURIComponent(r.location)); }
  await request('/login'); successful(await request('/login', { username: 'owner', password: 'test-owner-password' }));
  assert.equal((await request('/nodes')).status, 200);
  db = new Database(path.join(dir, 'app.db')); db.pragma('busy_timeout=5000');
  // Existing Nexus users keep UUIDs/slugs when the new node is assigned to all.
  for (let i = 1; i <= 2; i++) db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug,device_limit) VALUES(?,?,?,?,?,0)')
    .run(i, `user${i}`, `user${i}`, `10000000-0000-4000-8000-00000000000${i}`, `awg-subscription-${i}`);
  const nodeForm = { node_type: '3xui', panel_url: `http://127.0.0.1:${remote.address().port}`, api_auth_mode: 'token', api_token: 'test-token',
    country_code: 'DE', inbound_id: 42, subscription_protocol: 'amneziawg', create_existing_clients_on_node: '1' };
  successful(await request('/nodes', nodeForm));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM client_nodes').get().n, 2, logs);
  assert.equal(writes.filter(w => w.route.endsWith('/add')).length, 2);
  assert.notEqual(inbounds.get(42).settings.clients[0].privateKey, inbounds.get(42).settings.clients[1].privateKey);
  assert.equal(db.prepare('SELECT sub_slug FROM clients WHERE id=1').get().sub_slug, 'awg-subscription-1');
  const nodeId = db.prepare('SELECT id FROM nodes WHERE inbound_id=42').get().id;
  const uri = (await request('/sub-plain/awg-subscription-1')).text;
  assert.match(uri, /^amneziawg:\/\//, logs);
  const conf = Buffer.from(uri.split('://')[1].split('#')[0], 'base64url').toString();
  assert.match(conf, /Endpoint = vpn.example:51820/); assert.match(conf, /PersistentKeepalive = 15-25/);
  assert.ok(conf.includes(key(5))); assert.ok(!conf.includes(key(20))); assert.ok(!conf.includes(key(2)));
  let configs = JSON.parse((await request('/json/awg-subscription-1?format=incy')).text);
  assert.equal(configs[0].type, 'amneziawg');
  // Add VLESS to the SAME subscription, then exercise both text and JSON.
  successful(await request('/nodes', { ...nodeForm, inbound_id: 43, subscription_protocol: 'auto', create_existing_clients_on_node: '0' }));
  const vlessId = db.prepare('SELECT id FROM nodes WHERE inbound_id=43').get().id;
  successful(await request('/clients/1/sync', { node_ids: [vlessId] }));
  let response = await request('/sub-plain/awg-subscription-1'); assert.match(response.text, /amneziawg:\/\//); assert.match(response.text, /vless:\/\//);
  configs = JSON.parse((await request('/json/awg-subscription-1?format=incy')).text);
  assert.equal(configs.length, 2); assert.ok(configs.some(c => c.type === 'amneziawg')); assert.ok(configs.some(c => c.outbounds));
  // Redirect must change the endpoint INSIDE native AWG, in every subscription
  // format, without rotating the peer or changing its tunnel address/options.
  function awgConf(text) {
    const line = text.split('\n').find(line => line.startsWith('amneziawg://'));
    assert.ok(line, text);
    return Buffer.from(line.split('://')[1].split('#')[0], 'base64url').toString();
  }
  const originalMixed = response.text;
  const originalVless = originalMixed.split('\n').find(line => line.startsWith('vless://'));
  const redirectForm = { bind_ip_mode: 'custom', bind_ip_custom: '198.51.100.23',
    redirect_runtime: 'external', protocol: 'udp', node_ids: [nodeId], rewrite_enabled: '1' };
  successful(await request('/redirects/apply', redirectForm));
  const redirectRule = db.prepare('SELECT * FROM redirect_rules WHERE node_id=?').get(nodeId);
  assert.equal(redirectRule.public_host, '198.51.100.23');
  assert.equal(redirectRule.helper_enabled, 0);
  assert.equal(redirectRule.protocol, 'udp');
  const redirectedConf = conf.replace('Endpoint = vpn.example:51820', 'Endpoint = 198.51.100.23:51820');
  for (const route of ['/sub-plain/', '/sub/', '/hiddify/']) {
    const sub = await request(`${route}awg-subscription-1`);
    assert.equal(sub.status, 200);
    assert.equal(awgConf(sub.text), redirectedConf, route);
    assert.ok(sub.text.split('\n').includes(originalVless), 'unselected VLESS stays unchanged');
  }
  for (const route of ['/json/awg-subscription-1?format=incy', '/awg-subscription-1?format=incy', '/json/awg-subscription-1']) {
    const json = JSON.parse((await request(route, undefined, { 'user-agent': 'INCY/2.6.2/ios' })).text);
    const native = json.find(c => c.type === 'amneziawg');
    assert.equal(Buffer.from(native.servers[0].config, 'base64url').toString(), redirectedConf, route);
  }
  assert.match(awgConf((await request('/sub-plain/awg-subscription-2')).text), /Endpoint = 198\.51\.100\.23:51820/);
  successful(await request(`/redirects/${redirectRule.id}/toggle`, {}));
  assert.equal(awgConf((await request('/sub-plain/awg-subscription-1')).text), conf, 'disabled rule restores endpoint');
  successful(await request(`/redirects/${redirectRule.id}/toggle`, {}));
  assert.equal(awgConf((await request('/sub-plain/awg-subscription-1')).text), redirectedConf);
  successful(await request('/redirects/apply', { ...redirectForm, rewrite_enabled: '0' }));
  assert.equal(awgConf((await request('/sub-plain/awg-subscription-1')).text), conf, 'unchecked rewrite restores endpoint');
  successful(await request('/redirects/apply', { ...redirectForm, bind_ip_custom: 'relay.example.com' }));
  assert.equal(awgConf((await request('/sub-plain/awg-subscription-1')).text),
    conf.replace('Endpoint = vpn.example:51820', 'Endpoint = relay.example.com:51820'), 'custom domain replaces previous IP');
  successful(await request(`/redirects/${redirectRule.id}/delete`, {}));
  assert.equal(awgConf((await request('/sub-plain/awg-subscription-1')).text), conf, 'deleted rule restores endpoint');
  async function reorder(order) {
    const r = await fetch(`http://127.0.0.1:${port}/nodes/reorder`, { method: 'POST', redirect: 'manual',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'x-nexus-workspace': 'main' },
      body: JSON.stringify({ order, _workspace: 'main' }) });
    assert.equal(r.status, 200, await r.text());
  }
  await reorder([nodeId, vlessId]);
  configs = JSON.parse((await request('/json/awg-subscription-1?format=incy')).text);
  assert.equal(configs[0].type, 'amneziawg', 'AWG must follow node ordering instead of appending at the end');
  await reorder([vlessId, nodeId]);
  configs = JSON.parse((await request('/json/awg-subscription-1?format=incy')).text);
  assert.ok(configs[0].outbounds); assert.equal(configs[1].type, 'amneziawg');
  const routingPage = await request('/routing');
  assert.equal(routingPage.status, 200); assert.match(routingPage.text, /AWG-узлы ниже недоступны/);
  assert.match(routingPage.text, new RegExp(`value="${nodeId}" disabled`));
  successful(await request('/routing', { routing_enabled: '1', routing_modes: ['proxy-except'],
    routing_mode_nodes_proxy_except: [vlessId, nodeId], except_domains: 'domain:bank.example.ru' }));
  const routingCfg = JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='routing_config'").get().value);
  assert.deepEqual(routingCfg.modeAssignments['proxy-except'], [vlessId], 'server must reject assigning Xray rules to native AWG');
  configs = JSON.parse((await request('/json/awg-subscription-1?format=incy')).text);
  assert.ok(configs[0].routing.rules.some(rule => rule.domain?.includes('domain:bank.example.ru') && rule.outboundTag === 'direct'));
  assert.equal(configs[1].routing, undefined, 'must not claim to apply Xray routing to AWG');
  const nodesPage = await request('/nodes?tab=add&create=auto_select');
  assert.equal(nodesPage.status, 200);
  assert.match(nodesPage.text, new RegExp(`name="auto_select_node_ids" value="${nodeId}" disabled`));
  const profileCount = db.prepare('SELECT COUNT(*) n FROM auto_select_profiles').get().n;
  for (const policy of [
    { auto_select_node_ids: [vlessId, nodeId] },
    { auto_select_node_ids: [vlessId], auto_select_preferred_node_id: nodeId },
    { auto_select_node_ids: [vlessId], auto_select_emergency_node_id: nodeId }
  ]) {
    const denied = await request('/nodes', { node_type: 'auto_select', auto_select_name: 'AWG invalid pool', ...policy });
    assert.equal(denied.status, 302);
    assert.match(decodeURIComponent(denied.location), /AmneziaWG.*не участвует в автовыборе Xray/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM auto_select_profiles').get().n, profileCount);
  configs = JSON.parse((await request('/json/awg-subscription-1', undefined, { 'user-agent': 'INCY/2.6.2/ios' })).text); assert.equal(configs.length, 2);
  configs = JSON.parse((await request('/awg-subscription-1?format=incy')).text); assert.equal(configs.length, 2, 'clean INCY link');
  assert.equal(inbounds.get(42).settings.clients[0].privateKey, key(5), 'VLESS update preserves AWG key');
  configs = JSON.parse((await request('/json/awg-subscription-1')).text); assert.equal(configs.length, 1, 'ordinary Xray JSON stays usable');
  assert.match((await request('/open/awg-subscription-1')).text, /format=incy/);
  // Persisted per-inbound credentials and clean URLs must survive a restart.
  child.kill(); await new Promise(resolve => child.once('exit', resolve));
  child = startApp(); port = await ready(child); cookie = ''; csrf = '';
  assert.match((await request('/awg-subscription-1?format=incy')).text, /amneziawg/);
  await request('/login'); successful(await request('/login', { username: 'owner', password: 'test-owner-password' }));
  await request('/nodes');
  db.prepare('UPDATE clients SET expiry_time=? WHERE id=1').run(Date.now() - 86400000);
  assert.doesNotMatch((await request('/sub-plain/awg-subscription-1')).text, /amneziawg:\/\//);
  assert.match((await request('/sub-plain/awg-subscription-2')).text, /amneziawg:\/\//);
  db.prepare('UPDATE clients SET expiry_time=0 WHERE id=1').run();

  // Keep VLESS out of the lifecycle assertions: its global full-row updates
  // are independently covered by the existing suite.
  db.prepare('DELETE FROM client_nodes WHERE client_id=1 AND node_id=?').run(vlessId);
  successful(await request('/clients/1/extend', { days: 30 }));
  assert.equal((await request('/sub-plain/awg-subscription-1')).text.includes(key(20)), false);
  assert.equal(inbounds.get(42).settings.clients[0].privateKey, key(5));
  assert.equal(inbounds.get(42).settings.clients[0].keepAlive, '15-25');
  successful(await request('/clients/1/edit', { login: 'user1', traffic_gb: 10, [`node_enabled_${nodeId}`]: '1', [`node_traffic_gb_${nodeId}`]: 5 }));
  assert.equal(clients.get('user1').totalGB, 5 * 1024 ** 3);
  successful(await request('/clients/1/toggle', {}));
  assert.equal(clients.get('user1').enable, false); assert.equal((await request('/sub-plain/awg-subscription-1')).status, 404);
  successful(await request('/clients/1/toggle', {})); assert.match((await request('/sub-plain/awg-subscription-1')).text, /amneziawg:\/\//);
  const removed = await request('/clients/bulk-remove-node', { client_ids: [1], bulk_node_id: nodeId, bulk_confirmation: 'CONFIRMED' });
  assert.ok([200, 302].includes(removed.status), removed.text);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM client_nodes WHERE client_id=1 AND node_id=?').get(nodeId).n, 0);
  assert.equal(inbounds.get(42).settings.clients.some(p => p.email === 'user1'), false);
  const wrong = await request('/nodes', { ...nodeForm, inbound_id: 43 });
  assert.match(decodeURIComponent(wrong.location), /другой протокол/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM nodes').get().n, 2);
  assert.ok(!writes.some(w => w.route.includes('/inbounds/addClient')), 'no legacy writes for AWG');
});
