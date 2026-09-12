'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const { PUBLIC_PATH, denyAccess } = require('./lib_access');

function validId(id) { return /^[a-f0-9]{24}$/.test(String(id)); }
function publicTarget(url) {
  const parsed = new URL(url, 'http://localhost');
  const match = parsed.pathname.match(/^\/s\/([a-f0-9]{24})(\/.*)$/);
  if (!match || !(PUBLIC_PATH.test(match[2]) || /^\/img\/[a-zA-Z0-9_.-]+$/.test(match[2]))) return null;
  return { id: match[1], url: match[2] + parsed.search };
}
function createRuntime(access, baseEnv = process.env) {
  const children = new Map();
  let closing = false;
  // A previous process may have stopped halfway through provisioning. Preserve
  // its files/key and expose an explicit retry instead of making another DB.
  access.control.prepare("UPDATE workspaces SET status='failed' WHERE status='provisioning'").run();
  function directory(id) {
    if (!validId(id)) throw new Error('Недопустимый ID пространства');
    return path.join(access.rootDir, 'workspaces', id);
  }
  async function start(id) {
    const existing = children.get(id);
    if (existing) return existing.ready;
    const w = access.control.prepare('SELECT * FROM workspaces WHERE id=?').get(id);
    if (!w || !['ready', 'provisioning'].includes(w.status)) throw new Error('Пространство недоступно');
    const token = crypto.randomBytes(32).toString('hex');
    const child = fork(path.join(__dirname, 'app.js'), [], {
      cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...baseEnv, PORT: '0', DATA_DIR: directory(id), NEXUS_WORKSPACE_ID: id,
        NEXUS_CONTROL_DIR: access.rootDir, NEXUS_WORKSPACE_TOKEN: token,
        APP_SECRET: w.secret, NEXUS_NODE_ENABLED: '0', TRUST_PROXY: '1', SUBSCRIPTION_NAME: 'VPN',
        BASE_URL: baseEnv.PANEL_PUBLIC_URL || baseEnv.BASE_URL || `http://localhost:${baseEnv.PORT || 3000}`,
        NEXUS_SHARED_XUI_PUBLIC_HOST: baseEnv.NEXUS_LOCAL_XUI_PUBLIC_HOST || '',
        NEXUS_LOCAL_XUI_PUBLIC_HOST: '', NEXUS_LOCAL_XUI_VPN_PORTS: '',
        ADMIN_USERNAME: 'workspace-internal', ADMIN_PASSWORD: crypto.randomBytes(24).toString('hex') }
    });
    // Do not reflect child errors/credentials into HTTP responses.
    child.stdout.on('data', () => {});
    child.stderr.on('data', chunk => console.error(`[workspace ${id}] ${String(chunk).slice(0, 2000)}`));
    const entry = { child, token, port: 0 };
    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('Пространство не запустилось за 45 секунд')); }, 45000);
      child.once('error', err => { clearTimeout(timer); reject(err); });
      child.on('message', msg => {
        if (msg?.type === 'ready' && Number.isInteger(msg.port) && msg.port > 0) { clearTimeout(timer); entry.port = msg.port; resolve(entry); }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        if (children.get(id) === entry) children.delete(id);
        reject(new Error('Процесс пространства завершился'));
        if (!closing && access.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND status='ready'").get(id)) {
          setTimeout(() => start(id).catch(() => {}), 10000).unref();
        }
      });
    });
    children.set(id, entry);
    return entry.ready;
  }
  async function create(name, actor) {
    name = String(name || '').trim();
    if (!name || name.length > 80) throw new Error('Название пространства: 1–80 символов');
    if (access.control.prepare("SELECT COUNT(*) n FROM workspaces WHERE status IN ('ready','provisioning')").get().n >= 8) throw new Error('Лимит первой версии: 8 пространств, включая Основное. Проверьте ресурсы сервера.');
    const id = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(directory(id), { recursive: true, mode: 0o700 });
    access.control.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(id, name, 'provisioning', crypto.randomBytes(32).toString('hex'));
    try {
      await start(id);
      access.control.prepare("UPDATE workspaces SET status='ready' WHERE id=?").run(id);
      access.audit(actor, id, 'workspace.created', name);
      return id;
    } catch (err) {
      access.control.prepare("UPDATE workspaces SET status='failed' WHERE id=?").run(id);
      children.get(id)?.child.kill();
      throw err;
    }
  }
  function proxy(req, res, id, url) {
    start(id).then(entry => {
      req.session.save(err => {
        if (err) return res.status(503).send('Не удалось сохранить сессию');
        const headers = { ...req.headers, 'x-nexus-internal': entry.token, 'x-forwarded-for': req.ip, 'x-forwarded-proto': req.protocol };
        delete headers.connection; delete headers['transfer-encoding'];
        if (req.rawFormBody) headers['content-length'] = String(req.rawFormBody.length);
        const upstream = http.request({ hostname: '127.0.0.1', port: entry.port, path: url, method: req.method, headers }, response => {
          res.statusCode = response.statusCode;
          for (const [key, value] of Object.entries(response.headers)) if (!['connection', 'transfer-encoding', 'set-cookie'].includes(key) && value !== undefined) res.setHeader(key, value);
          response.pipe(res);
        });
        upstream.setTimeout(120000, () => upstream.destroy(new Error('timeout')));
        upstream.on('error', () => { if (!res.headersSent) res.status(503).send('Пространство временно недоступно'); else res.destroy(); });
        res.on('close', () => upstream.destroy());
        if (req.rawFormBody) upstream.end(req.rawFormBody); else req.pipe(upstream);
      });
    }).catch(() => res.status(503).send('Пространство временно недоступно'));
  }
  async function retry(id, actor) {
    directory(id);
    if (access.control.prepare("SELECT COUNT(*) n FROM workspaces WHERE status IN ('ready','provisioning')").get().n >= 8) throw new Error('Лимит: 8 пространств');
    if (!access.control.prepare("UPDATE workspaces SET status='provisioning' WHERE id=? AND status='failed'").run(id).changes) throw new Error('Повтор доступен только для неудачного запуска');
    try {
      await start(id);
      access.control.prepare("UPDATE workspaces SET status='ready' WHERE id=?").run(id);
      access.audit(actor, id, 'workspace.retried');
    } catch (err) {
      access.control.prepare("UPDATE workspaces SET status='failed' WHERE id=?").run(id);
      throw err;
    }
  }
  function middleware(req, res, next) {
    const target = publicTarget(req.originalUrl);
    if (target) {
      if (!['GET', 'HEAD'].includes(req.method) || !access.control.prepare("SELECT 1 FROM workspaces WHERE id=? AND status='ready'").get(target.id)) return res.sendStatus(404);
      return proxy(req, res, target.id, target.url);
    }
    if (req.path.startsWith('/s/')) return res.sendStatus(404);
    if (PUBLIC_PATH.test(req.path) || ['/login', '/logout', '/mobile-login', '/qr', '/healthz'].includes(req.path) || req.path.startsWith('/access')) return next();
    const u = access.sessionUser(req);
    if (!u) return next();
    const id = req.session.workspaceId || 'main';
    if (!access.workspaces(u).some(w => w.id === id && w.status === 'ready')) return denyAccess(req, res);
    if (id === 'main') return next();
    proxy(req, res, id, req.originalUrl);
  }
  function stop() { closing = true; for (const entry of children.values()) entry.child.kill(); }
  return { start, create, retry, middleware, stop, directory, children };
}
module.exports = { createRuntime, publicTarget, validId };
