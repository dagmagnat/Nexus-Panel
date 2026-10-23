'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { encrypt } = require('../lib_crypto');
const root = path.resolve(__dirname, '..'), secret = 'client-node-editor-test-secret-'.repeat(3), GB = 1024 ** 3;

for (const kind of ['3xui-modern', '3xui-legacy', 'remna-3.3', 'remna-3.4']) {
  test(`client editor exposes unassigned enabled nodes and provisions only selected clients (${kind})`, { timeout: 90000 }, async t => {
    const remna = kind.startsWith('remna'), modern = kind === '3xui-modern';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-client-editor-'));
    const uuids = [1, 2, 3].map(n => `10000000-0000-4000-8000-00000000000${n}`);
    const squad = n => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const physical = n => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const remote = new Map(), writes = [], reads = [];
    const alpha = remna
      ? { id: 17, uuid: '40000000-0000-4000-8000-000000000017', username: 'alpha', vlessUuid: uuids[0], activeInternalSquads: [squad(1)], status: 'ACTIVE', trafficLimitBytes: 0, userTraffic: { usedTrafficBytes: 4 * GB }, expireAt: '2099-01-01T00:00:00Z' }
      : { id: uuids[0], email: 'alpha', subId: 'editor-alpha-12345678', enable: true, totalGB: 13 * GB, expiryTime: 0, inboundIds: [1] };
    remote.set('alpha', alpha);
    const inbound = id => ({ id, port: 20000 + id, protocol: 'vless', enable: true, remark: 'test-' + id,
      settings: JSON.stringify({ decryption: 'none', clients: [...remote.values()].filter(c => c.inboundIds?.includes(id)).map(c => ({ ...c })) }),
      streamSettings: JSON.stringify({ network: 'xhttp', security: 'none', xhttpSettings: { path: '/xhttp/', mode: 'auto' } }), sniffing: '{}',
      clientStats: [...remote.values()].filter(c => c.inboundIds?.includes(id)).map(c => ({ email: c.email, up: c.email === 'alpha' ? GB : 0, down: c.email === 'alpha' ? 3 * GB : 0, total: c.totalGB, enable: c.enable })) });
    let originBase;
    const origin = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://local'), p = decodeURIComponent(url.pathname);
      const ok = obj => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(remna ? { response: obj } : { success: true, obj })); };
      const missing = () => { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ success: false, message: 'not found' })); };
      if (req.method === 'GET') {
        reads.push(p);
        if (remna) {
          if (p === '/api/system/metadata') return ok({ version: kind === 'remna-3.3' ? '3.3.0' : '3.4.5' });
          if (p === '/api/system/stats') return ok({ users: { totalUsers: remote.size } });
          if (p === '/api/nodes') return ok({ nodes: [1, 2, 3, 4, 5].map(n => ({ uuid: physical(n), isConnected: true })) });
          if (p === '/api/users') return ok({ users: [...remote.values()], total: remote.size });
          if (p.startsWith('/api/users/by-username/')) { const u = remote.get(p.split('/').at(-1)); return u ? ok(u) : missing(); }
          if (p.startsWith('/api/users/')) { const u = [...remote.values()].find(u => p.endsWith('/' + u.id) || p.endsWith('/' + u.uuid)); return u ? ok(u) : missing(); }
          return missing();
        }
        if (p === '/panel/api/server/status') return ok({ version: modern ? '3.10.2' : '2.5.8' });
        if (p === '/panel/api/setting/all') return ok({});
        if (p === '/panel/api/inbounds/list') return ok([1, 2, 3, 4, 5].map(inbound));
        if (p.startsWith('/panel/api/inbounds/get/')) return ok(inbound(Number(p.split('/').at(-1))));
        if (modern && p === '/panel/api/clients/list') return ok([...remote.values()].map(c => ({ client: { ...c, uuid: c.id }, inboundIds: c.inboundIds })));
        if (modern && p.startsWith('/panel/api/clients/get/')) { const c = remote.get(p.split('/').at(-1)); return c ? ok({ client: { ...c, uuid: c.id }, inboundIds: c.inboundIds }) : missing(); }
        return missing();
      }
      const chunks = []; for await (const b of req) chunks.push(b);
      const raw = Buffer.concat(chunks).toString();
      const body = (req.headers['content-type'] || '').includes('json') ? JSON.parse(raw || '{}') : Object.fromEntries(new URLSearchParams(raw));
      if (p === '/login') { res.setHeader('Set-Cookie', 'session=test; Path=/'); return ok({}); }
      if (remna && p === '/api/users' && req.method === 'POST') {
        assert.ok(!remote.has(body.username));
        const c = { ...body, id: 17 + remote.size, uuid: `40000000-0000-4000-8000-${String(17 + remote.size).padStart(12, '0')}`, userTraffic: { usedTrafficBytes: 0 }, subscriptionUrl: originBase + '/unused-sub' };
        remote.set(c.username, c); writes.push({ p, body }); return ok(c);
      }
      if (remna && p === '/api/users' && req.method === 'PATCH') {
        assert.ok(Number.isSafeInteger(body.id) && !body.username && !body.uuid, '3.3+ uses one numeric lookup ID');
        const c = [...remote.values()].find(c => c.id === body.id); assert.ok(c); Object.assign(c, body); writes.push({ p, body }); return ok(c);
      }
      if (modern && p === '/panel/api/clients/add') {
        assert.ok(!remote.has(body.client.email));
        const c = { ...body.client, id: body.client.uuid || body.client.id, inboundIds: body.inboundIds };
        remote.set(c.email, c); writes.push({ p, body }); return ok({});
      }
      if (modern && /^\/panel\/api\/clients\/[^/]+\/attach$/.test(p)) {
        const c = remote.get(p.split('/').at(-2)); assert.ok(c); c.inboundIds = [...new Set([...c.inboundIds, ...body.inboundIds])]; writes.push({ p, body }); return ok({});
      }
      if (modern && p.startsWith('/panel/api/clients/update/')) {
        const c = remote.get(p.split('/').at(-1)); assert.ok(c); Object.assign(c, body, { id: body.uuid || body.id || c.id }); writes.push({ p, body }); return ok({});
      }
      if (!remna && !modern && (p === '/panel/api/inbounds/addClient' || p.startsWith('/panel/api/inbounds/updateClient/'))) {
        const patch = JSON.parse(body.settings).clients[0], old = remote.get(patch.email);
        remote.set(patch.email, { ...old, ...patch, inboundIds: [...new Set([...(old?.inboundIds || []), Number(body.id)])] }); writes.push({ p, body }); return ok({});
      }
      return missing();
    });
    origin.listen(0, '127.0.0.1'); await once(origin, 'listening'); originBase = 'http://127.0.0.1:' + origin.address().port;
    alpha.subscriptionUrl = originBase + '/unused-sub';
    let child, db, base, log = '';
    async function stop() { if (child && child.exitCode === null) { child.kill(); await once(child, 'exit'); } }
    t.after(async () => { await stop(); db?.close(); await new Promise(r => origin.close(r)); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
    async function start() {
      child = fork(path.join(root, 'app.js'), [], { cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
        DOTENV_CONFIG_PATH: path.join(dir, 'absent.env'), DATA_DIR: dir, NEXUS_CONTROL_DIR: dir, NEXUS_WORKSPACE_ID: 'main', NODE_ENV: 'production', PORT: '0',
        ADMIN_USERNAME: 'owner', ADMIN_PASSWORD: 'test-owner-password', APP_SECRET: secret, SESSION_SECRET: secret, SESSION_SECURE: '0', TRUST_PROXY: '0', NEXUS_NODE_ENABLED: '0', PANEL_ACCESS_KEY: '',
        BASE_URL: 'http://localhost:3000', PANEL_PUBLIC_URL: 'http://localhost:3000', SUB_PUBLIC_URL: 'http://localhost:3000' } });
      child.stderr.on('data', b => log += b); child.stdout.on('data', () => {});
      const port = await new Promise((resolve, reject) => { const timer = setTimeout(() => { child.kill(); reject(Error(log || 'startup timeout')); }, 20000);
        child.on('message', m => { if (m?.type === 'ready') { clearTimeout(timer); resolve(m.port); } }); child.once('exit', () => { clearTimeout(timer); reject(Error(log)); }); });
      base = 'http://127.0.0.1:' + port;
    }
    await start(); db = new Database(path.join(dir, 'app.db')); db.pragma('busy_timeout=5000');
    const clientInsert = db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug,traffic_gb,enabled) VALUES(?,?,?,?,?,?,1)');
    for (let id = 1; id <= 25; id++) clientInsert.run(id, id <= 3 ? ['alpha', 'beta', 'gamma'][id - 1] : 'test-user-' + id, 'Client ' + id, uuids[id - 1] || `10000000-0000-4000-8000-${String(id).padStart(12, '0')}`, 'editor-client-key-' + id, id === 3 ? 7 : 0);
    db.prepare(`INSERT INTO nodes(id,name,node_type,panel_url,username,password_enc,api_auth_mode,api_token_enc,inbound_id,enabled,last_status,country_code,country_name_ru,remnawave_internal_squad_uuid,remnawave_node_uuid) VALUES(1,'Old',?,?,'admin',?,?,?,1,1,'online','FI','Финляндия',?,?)`)
      .run(remna ? 'remnawave' : '3xui', originBase, encrypt('password', secret), modern || remna ? 'token' : 'password', encrypt('token', secret), remna ? squad(1) : '', remna ? physical(1) : '');
    db.prepare('INSERT INTO client_nodes(client_id,node_id,remote_email,remote_uuid,traffic_gb,used_bytes,enabled) VALUES(1,1,?,?,13,?,1)').run('alpha', remna ? '17' : uuids[0], 4 * GB);
    if (!remna) db.prepare('INSERT INTO node_inbound_cache(node_id,inbound_id,inbound_json) VALUES(1,1,?)').run(JSON.stringify(inbound(1)));
    const cookies = new Map(); let csrf = '';
    async function request(route, body) {
      const headers = { 'X-Nexus-Workspace': 'main' }; if (cookies.size) headers.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const r = await fetch(base + route, { method: body ? 'POST' : 'GET', headers, body: body ? new URLSearchParams({ _csrf: csrf, _workspace: 'main', ...body }) : undefined, redirect: 'manual' });
      for (const value of r.headers.getSetCookie()) { const pair = value.split(';')[0], i = pair.indexOf('='); cookies.set(pair.slice(0, i), pair.slice(i + 1)); }
      const text = await r.text(); csrf = text.match(/name="csrf-token" content="([^"]+)"/)?.[1] || csrf; return { status: r.status, text, location: r.headers.get('location') };
    }
    async function login() { await request('/login'); assert.equal((await request('/login', { username: 'owner', password: 'test-owner-password' })).status, 302); }
    await login(); await request('/nodes?tab=add');
    const added = await request('/nodes', { node_type: remna ? 'remnawave' : '3xui', panel_url: originBase, inbound_id: '2', api_auth_mode: modern || remna ? 'token' : 'password', api_token: 'token', username: 'admin', password: 'password', country_code: 'FI', label_suffix: 'XHTTP test', sni_mode: 'inbound', remnawave_internal_squad_uuid: remna ? squad(2) : '', remnawave_node_uuid: remna ? physical(2) : '' });
    assert.equal(added.status, 302); assert.match(new URL(added.location, base).searchParams.get('message') || '', /Узел добавлен/, log);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE node_id=2').get().n, 0, 'adding without import/create must not provision everyone');
    assert.equal(writes.length, 0);
    for (const [id, enabled, status] of [[3, 0, 'online'], [4, 1, 'offline'], [5, 1, 'online']]) {
      db.prepare(`INSERT INTO nodes(id,name,node_type,panel_url,username,password_enc,api_auth_mode,api_token_enc,inbound_id,enabled,last_status,country_code,country_name_ru,label_suffix,remnawave_internal_squad_uuid,remnawave_node_uuid) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, 'Node ' + id, remna ? 'remnawave' : '3xui', originBase, 'admin', encrypt('password', secret), modern || remna ? 'token' : 'password', encrypt('token', secret), id, enabled, status, 'FI', 'Финляндия', 'test-' + id, remna ? squad(id) : '', remna ? physical(id) : '');
    }
    db.prepare('INSERT INTO client_nodes(client_id,node_id,remote_email,remote_uuid,traffic_gb,used_bytes,enabled) VALUES(1,3,?,?,19,?,1)').run('alpha', remna ? '17' : uuids[0], 9 * GB);
    const hiddenBefore = db.prepare('SELECT * FROM client_nodes WHERE node_id=3').get();
    const beforeReads = reads.length;
    function editor(html, id) { const result = html.match(new RegExp(`<div id="clientEditor-${id}"[\\s\\S]*?<form[^>]+action="/clients/${id}/edit"[\\s\\S]*?</form>`)); assert.ok(result, 'editor ' + id); return result[0]; }
    function checkbox(html, id) { return html.match(new RegExp(`<input[^>]+name="node_enabled_${id}"[^>]*>`))?.[0]; }
    const page = await request('/clients?page_size=20'); assert.equal(page.status, 200, log);
    const secondPage = await request('/clients?page=2&page_size=20'); assert.equal(secondPage.status, 200);
    const firstEditor = editor(secondPage.text, 1), emptyEditor = editor(secondPage.text, 2);
    assert.ok(checkbox(firstEditor, 1)?.includes('checked'));
    for (const html of [firstEditor, emptyEditor, editor(page.text, 25)]) {
      for (const id of [2, 4, 5]) assert.ok(checkbox(html, id) && !checkbox(html, id).includes('checked'), `unassigned enabled node ${id} must be visible unchecked`);
      assert.equal(checkbox(html, 3), undefined, 'globally disabled node stays hidden');
    }
    assert.equal(reads.length, beforeReads, 'directory rendering must not call remote APIs'); assert.equal(writes.length, 0);
    const edit = (id, extra = {}) => request(`/clients/${id}/edit`, { login: ['alpha', 'beta', 'gamma'][id - 1], back: '/clients?edit=' + id, ...extra });
    const untouched = await edit(2); assert.ok(!untouched.location.includes('error='), untouched.location); assert.equal(writes.length, 0);
    assert.equal((await edit(2, { _csrf: 'wrong', node_enabled_2: '1' })).status, 403); assert.equal(writes.length, 0);
    const invalid = await edit(2, { node_enabled_2: '1', node_traffic_gb_2: '-1' }); assert.ok(invalid.location.includes('error=')); assert.equal(writes.length, 0);
    const selected = await edit(2, { node_enabled_2: '1', node_traffic_gb_2: '2.5', node_enabled_3: '1', node_traffic_gb_3: '99' });
    assert.ok(!selected.location.includes('error='), selected.location + log);
    assert.equal(db.prepare('SELECT traffic_gb FROM client_nodes WHERE client_id=2 AND node_id=2').get()?.traffic_gb, 2.5);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE client_id=2 AND node_id!=2').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE node_id=2').get().n, 1, 'only the edited client is assigned');
    assert.equal(remote.size, 2); assert.ok(remote.has('beta')); assert.ok(!remote.has('gamma'));
    const repeated = await edit(2, { node_enabled_2: '1', node_traffic_gb_2: '0' }); assert.ok(!repeated.location.includes('error='), repeated.location);
    assert.equal(remote.size, 2); assert.equal(db.prepare('SELECT traffic_gb FROM client_nodes WHERE client_id=2 AND node_id=2').get().traffic_gb, 0);
    const attached = await edit(1, { node_enabled_1: '1', node_traffic_gb_1: '13', node_enabled_2: '1', node_traffic_gb_2: '8' });
    assert.ok(!attached.location.includes('error='), attached.location + log); assert.equal(remote.size, 2, 'reuse the existing remote identity');
    assert.equal(db.prepare('SELECT traffic_gb FROM client_nodes WHERE client_id=1 AND node_id=2').get()?.traffic_gb, 8);
    assert.deepEqual(db.prepare('SELECT * FROM client_nodes WHERE node_id=3').get(), hiddenBefore, 'hidden global-disabled mapping remains unchanged');
    const unchecked = await edit(1, { node_enabled_1: '1', node_traffic_gb_1: '13', node_traffic_gb_2: '8' }); assert.ok(!unchecked.location.includes('error='), unchecked.location);
    assert.equal(db.prepare('SELECT enabled FROM client_nodes WHERE client_id=1 AND node_id=2').get().enabled, 0);
    const disabledEditor = editor((await request('/clients?q=alpha')).text, 1);
    assert.ok(checkbox(disabledEditor, 2) && !checkbox(disabledEditor, 2).includes('checked'), 'existing disabled-for-client mapping stays visible unchecked');
    if (remna) { assert.ok(remote.get('alpha').activeInternalSquads.includes(squad(1))); assert.ok(!remote.get('alpha').activeInternalSquads.includes(squad(2))); }
    const inherited = await edit(3, { traffic_gb: '7', node_enabled_2: '1', node_traffic_gb_2: '' }); assert.ok(!inherited.location.includes('error='), inherited.location);
    assert.equal(db.prepare('SELECT traffic_gb FROM client_nodes WHERE client_id=3 AND node_id=2').get()?.traffic_gb, 7);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE node_id IN (4,5)').get().n, 0);
    const stable = db.prepare('SELECT uuid,sub_slug FROM clients WHERE id=2').get(); assert.deepEqual(stable, { uuid: uuids[1], sub_slug: 'editor-client-key-2' });
    const after = editor((await request('/clients?q=beta')).text, 2); assert.ok(checkbox(after, 2).includes('checked'));
    assert.ok(!checkbox(after, 4).includes('checked'));
    await stop(); await start(); cookies.clear(); csrf = ''; await login();
    assert.ok(checkbox(editor((await request('/clients?q=beta')).text, 2), 2).includes('checked'), 'assignment persists after restart');
    if (modern && process.env.NEXUS_PLAYWRIGHT_MODULE) {
      const { chromium } = require(process.env.NEXUS_PLAYWRIGHT_MODULE); const browser = await chromium.launch({ headless: true, channel: 'msedge' });
      try {
        const page = await browser.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
        await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
        await page.goto(base + '/login'); await page.locator('[name=username]').fill('owner'); await page.locator('[name=password]').fill('test-owner-password');
        await Promise.all([page.waitForURL('**/dashboard'), page.locator('button[type=submit]').click()]);
        for (const [width, targetId] of [[1440, 4], [390, 5]]) {
          await page.setViewportSize({ width, height: 920 }); await page.goto(base + '/clients?q=beta&edit=2');
          const form = page.locator('#clientEditor-2 form[action="/clients/2/edit"]'); await form.waitFor({ state: 'visible' });
          assert.equal(await form.locator('[name=node_enabled_2]').isChecked(), true); assert.equal(await form.locator(`[name=node_enabled_${targetId}]`).isChecked(), false);
          assert.equal(await form.locator('[name=node_enabled_3]').count(), 0);
          if (width === 1440) {
            await form.locator('[data-node-check-set=all]').click(); assert.equal(await form.locator('input[type=checkbox][name^=node_enabled_]:checked').count(), 4);
            await form.locator('[data-node-check-set=none]').click(); assert.equal(await form.locator('input[type=checkbox][name^=node_enabled_]:checked').count(), 0);
            await form.locator('[name=node_enabled_2]').check();
          }
          await form.locator(`[name=node_enabled_${targetId}]`).check(); await form.locator(`[name=node_traffic_gb_${targetId}]`).fill('3');
          await form.locator(`[name=node_enabled_${targetId}]`).scrollIntoViewIfNeeded();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          if (process.env.NEXUS_UI_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.NEXUS_UI_SCREENSHOT_DIR, `client-node-editor-${width}.png`) });
          const save = form.getByRole('button', { name: 'Сохранить изменения', exact: true });
          try {
            await Promise.all([page.waitForURL(url => url.searchParams.has('message'), { timeout: 10000 }), save.click({ timeout: 5000 })]);
          } catch (err) {
            throw new Error(`${err.message}\nURL: ${page.url()}\nForm: ${JSON.stringify(await form.evaluate(el => ({ invalid: [...el.querySelectorAll(':invalid')].map(i => ({ name: i.name, message: i.validationMessage })), action: el.action })))}\n${log}`);
          }
          assert.ok(!new URL(page.url()).searchParams.has('error'), page.url());
          const saved = db.prepare('SELECT enabled,traffic_gb FROM client_nodes WHERE client_id=2 AND node_id=?').get(targetId);
          assert.deepEqual(saved, { enabled: 1, traffic_gb: 3 });
          assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_nodes WHERE client_id!=2 AND node_id=?').get(targetId).n, 0);
        }
        assert.deepEqual(errors, []);
      } finally { await browser.close(); }
    }
  });
}
