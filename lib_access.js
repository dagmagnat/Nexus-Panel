'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const PERMISSIONS = {
  'clients.read': 'Клиенты и их ссылки подписки: просмотр',
  'clients.write': 'Создание и изменение клиентов, сроков и лимитов',
  'clients.delete': 'Удаление клиентов',
  'clients.bulk': 'Массовые операции и импорт/экспорт клиентов',
  'nodes.manage': 'Управление узлами и автовыбором',
  'routing.manage': 'Маршрутизация',
  'preferences.manage': 'Профили настроек и значения по умолчанию'
};
const ROLES = { viewer: ['clients.read'], operator: ['clients.read', 'clients.write'], admin: Object.keys(PERMISSIONS) };
const PUBLIC_PATH = /^\/(?:sub|sub-plain|json|happ|hiddify|happ-routing|happ-routing-json|open)\/[^/]+(?:\/status)?\/?$/;
function permissionFor(method, url) {
  const read = ['GET', 'HEAD'].includes(method);
  if (read && ['/', '/dashboard', '/more'].includes(url)) return 'clients.read';
  if (read && /^\/dashboard\/(?:node-status|panel-check|traffic-series|live-client-traffic|live-client-traffic-probe|online-clients|top-client-usage)\.json$/.test(url)) return 'clients.read';
  if (/^\/preferences(?:\/(?:export|inspect|import|defaults|options|name))?$/.test(url)) return 'preferences.manage';
  if (read && /^\/preferences\/backups\/preferences-before-\d+-[a-f0-9]{8}\.nxpreferences$/.test(url)) return 'preferences.manage';
  if (/^\/operations\/[a-f0-9-]+\/cancel$/.test(url)) return 'clients.write';
  if (/^\/clients\/transfer\//.test(url) || /^\/clients\/(?:import|sync-nodes|create-missing-on-node|apply-to-node|refresh-subscriptions|delete-all|bulk-remove-node|bulk-delete)$/.test(url)) return 'clients.bulk';
  if (/^\/clients(?:\/\d+(?:\/summary\.json)?|\/usage\.json)?$/.test(url) && read) return 'clients.read';
  if (/^\/clients\/\d+\/delete$/.test(url)) return 'clients.delete';
  if (!read && (url === '/clients' || /^\/clients\/\d+\/(?:sync|edit|extend|toggle|devices\/reset|devices\/\d+\/delete)$/.test(url) || /^\/client-(?:groups|tags)(?:\/\d+\/delete)?$/.test(url))) return 'clients.write';
  if (/^\/nodes(?:\/\d+(?:\/(?:edit|check|sync-clients|create-missing-clients|toggle|delete|clone|clone-remnawave|renew-support|h1cloud-transport|remnawave-resources\.json))?|\/reorder)?$/.test(url) || /^\/auto-select-profiles\/\d+\/(?:edit|toggle|delete)$/.test(url)) return 'nodes.manage';
  if (/^\/routing(?:\/geodata-index)?$/.test(url)) return 'routing.manage';
  // No wildcard grants for diagnostics, backup, SSH/VPN tools, host operations,
  // credential settings, Telegram administration or newly introduced routes.
  return null;
}
function createAccess({ rootDir, localDb, legacyUsername, workspaceId = 'main' }) {
  fs.mkdirSync(rootDir, { recursive: true });
  const file = path.join(rootDir, 'control.db');
  const control = new Database(file);
  control.pragma('journal_mode = WAL');
  control.pragma('busy_timeout = 5000');
  control.pragma('foreign_keys = ON');
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  control.exec(`
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, is_owner INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, auth_version INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, secret TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(user_id INTEGER REFERENCES users(id), workspace_id TEXT REFERENCES workspaces(id), permissions TEXT NOT NULL, PRIMARY KEY(user_id,workspace_id));
    CREATE TABLE IF NOT EXISTS access_audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, actor INTEGER, workspace TEXT, action TEXT NOT NULL, target TEXT);
    CREATE TABLE IF NOT EXISTS remote_owners(endpoint TEXT PRIMARY KEY, workspace TEXT NOT NULL);
  `);
  if (!control.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    if (workspaceId !== 'main') throw new Error('Сначала должен запуститься основной процесс Nexus');
    const legacy = localDb.prepare('SELECT * FROM app_users').all();
    const owner = legacy.find(u => u.username === legacyUsername) || (legacy.length === 1 ? legacy[0] : null);
    if (!owner) throw new Error('Не удалось однозначно определить владельца. Укажите ADMIN_USERNAME существующего администратора.');
    const snapshots = path.join(rootDir, 'migration-backups');
    fs.mkdirSync(snapshots, {recursive:true, mode:0o700});
    const snapshot = path.join(snapshots, `before-access-${randomUUID()}.db`);
    // SQLite creates a consistent snapshot, including any committed WAL pages.
    // If this fails (e.g. disk full), do not activate the new account registry.
    localDb.prepare('VACUUM INTO ?').run(snapshot);
    try { fs.chmodSync(snapshot, 0o600); } catch (_) {}
    control.transaction(() => {
      control.prepare("INSERT OR IGNORE INTO workspaces VALUES ('main','Основное','ready','')").run();
      for (const u of legacy) {
        control.prepare('INSERT INTO users(id,username,password_hash,is_owner) VALUES (?,?,?,?)').run(u.id, u.username, u.password_hash, Number(u.id === owner.id));
        // Existing additional accounts retain no implicit administrator rights.
        control.prepare('INSERT INTO memberships VALUES (?,?,?)').run(u.id, 'main', JSON.stringify(u.id === owner.id ? Object.keys(PERMISSIONS) : ROLES.viewer));
      }
    })();
  }
  const user = id => control.prepare('SELECT * FROM users WHERE id=?').get(Number(id) || -1);
  const workspaces = u => u?.is_owner ? control.prepare('SELECT id,name,status FROM workspaces ORDER BY id').all() : control.prepare('SELECT w.id,w.name,w.status FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.id').all(u?.id || -1);
  function can(u, wid, permission) {
    if (!u || u.disabled) return false;
    if (u.is_owner) return true;
    const member = control.prepare('SELECT permissions FROM memberships WHERE user_id=? AND workspace_id=?').get(u.id, wid);
    return Boolean(member && JSON.parse(member.permissions).includes(permission));
  }
  function audit(actor, wid, action, target = '') { control.prepare('INSERT INTO access_audit(actor,workspace,action,target) VALUES (?,?,?,?)').run(actor || null, wid, action, String(target).slice(0, 200)); }
  function sessionUser(req) {
    const u = user(req.session?.userId);
    return u && !u.disabled && Number(req.session.authVersion) === u.auth_version ? u : null;
  }
  function authenticate(req, u) {
    req.session.userId = u.id;
    req.session.authVersion = u.auth_version;
    const available = workspaces(u).filter(w => w.status === 'ready');
    req.session.workspaceId = (available.find(w => w.id === 'main') || available[0])?.id || '';
  }
  function landingPath(u, wid) {
    if (!wid) return '/access';
    for (const [permission, url] of [['clients.read','/dashboard'],['nodes.manage','/nodes'],['routing.manage','/routing'],['preferences.manage','/preferences']]) if (can(u, wid, permission)) return url;
    return '/access';
  }
  function allowsRoute(u, wid, method, url) {
    if (!u || u.disabled || !workspaces(u).some(w => w.id === wid && w.status === 'ready')) return false;
    const read = ['GET', 'HEAD'].includes(method);
    if (url === '/logout' || (read && ['/access', '/more'].includes(url)) || url === '/access/switch') return true;
    if (url.startsWith('/access/')) return Boolean(u.is_owner && wid === 'main');
    if (u.is_owner && wid === 'main') return true;
    const permission = permissionFor(method, url.replace(/\/$/, '') || '/');
    return Boolean(permission && can(u, wid, permission) &&
      !(permission === 'clients.bulk' && /(?:delete-all|bulk-delete)$/.test(url) && !can(u, wid, 'clients.delete')));
  }
  function authorize(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    const u = sessionUser(req);
    if (!u) { req.session.userId = null; res.redirect('/login'); return false; }
    if (!allowsRoute(u, workspaceId, req.method, req.path)) { denyAccess(req, res); return false; }
    return true;
  }
  function createUser({ username, password, wid, permissions }) {
    username = String(username || '').trim();
    if (!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username)) throw new Error('Логин: 3–64 буквы/цифры, _, -, . или @');
    if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) throw new Error('Пароль: минимум 12 символов, максимум 72 байта');
    if (!control.prepare("SELECT 1 FROM workspaces WHERE id=? AND status='ready'").get(wid)) throw new Error('Пространство не готово');
    permissions = validatePermissions(permissions);
    return control.transaction(() => {
      const id = Number(control.prepare('INSERT INTO users(username,password_hash) VALUES (?,?)').run(username, bcrypt.hashSync(password, 12)).lastInsertRowid);
      control.prepare('INSERT INTO memberships VALUES (?,?,?)').run(id, wid, JSON.stringify(permissions));
      return id;
    })();
  }
  function updateUser(id, { disabled, password, wid, permissions }) {
    const u = user(id);
    if (!u) throw new Error('Пользователь не найден');
    if (u.is_owner) throw new Error('Главный администратор защищён от изменения этой формой');
    if (password && (password.length < 12 || Buffer.byteLength(password) > 72)) throw new Error('Пароль: минимум 12 символов, максимум 72 байта');
    const selected = validatePermissions(permissions);
    if (!control.prepare("SELECT 1 FROM workspaces WHERE id=? AND status='ready'").get(wid)) throw new Error('Пространство не найдено');
    control.transaction(() => {
      control.prepare('UPDATE users SET disabled=?,password_hash=?,auth_version=auth_version+1 WHERE id=?').run(disabled ? 1 : 0, password ? bcrypt.hashSync(password, 12) : u.password_hash, id);
      control.prepare('INSERT INTO memberships VALUES (?,?,?) ON CONFLICT(user_id,workspace_id) DO UPDATE SET permissions=excluded.permissions').run(id, wid, JSON.stringify(selected));
      if (!selected.length) control.prepare('DELETE FROM memberships WHERE user_id=? AND workspace_id=?').run(id, wid);
    })();
  }
  function claimRemote(url) {
    const parsed = new URL(url);
    let host = parsed.hostname.toLowerCase();
    let port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    const localHost = process.env.NEXUS_LOCAL_XUI_PUBLIC_HOST || process.env.NEXUS_SHARED_XUI_PUBLIC_HOST;
    if (host === 'local-3xui' || (localHost && host === localHost && port === '2053')) { host = 'managed-local-3xui'; port = '2053'; }
    const endpoint = `${host}:${port}`;
    control.transaction(() => {
      const owner = control.prepare('SELECT workspace FROM remote_owners WHERE endpoint=?').get(endpoint);
      if (owner && owner.workspace !== workspaceId) throw new Error('Эта удалённая панель уже закреплена за другим пространством. Независимым базам нужна отдельная панель.');
      control.prepare('INSERT OR IGNORE INTO remote_owners VALUES (?,?)').run(endpoint, workspaceId);
    })();
  }
  return { control, user, workspaces, can, audit, authenticate, landingPath, sessionUser, authorize, allowsRoute, createUser, updateUser, claimRemote, workspaceId, rootDir };
}
function validatePermissions(values) {
  const result = Array.isArray(values) ? values : values ? [values] : [];
  if (result.some(p => !Object.hasOwn(PERMISSIONS, p))) throw new Error('Неизвестное разрешение');
  return [...new Set(result)];
}
function denyAccess(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Nexus-Access-Denied', '1');
  const message = 'У вас нет прав для этого действия. Обратитесь к главному администратору.';
  if (req.get?.('X-Requested-With') === 'XMLHttpRequest' || req.get?.('Accept')?.includes('application/json'))
    return res.status(403).json({ ok: false, code: 'ACCESS_DENIED', error: message });
  return res.status(403).send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Нет доступа — Nexus</title><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#080f1e;color:#f5f7ff;font-family:system-ui"><main role="alert" style="box-sizing:border-box;width:min(520px,92vw);padding:32px;border:1px solid #56627e;border-radius:20px;background:#142038;text-align:center"><h1 style="font-size:26px">Недостаточно прав</h1><p style="font-size:18px;line-height:1.6">${message}</p><a href="/access" style="color:#8edfff;font-size:18px">Пользователи и доступ</a></main></body></html>`);
}
module.exports = { createAccess, permissionFor, validatePermissions, PERMISSIONS, ROLES, PUBLIC_PATH, denyAccess };
