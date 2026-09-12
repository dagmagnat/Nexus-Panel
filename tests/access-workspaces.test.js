'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { createAccess, permissionFor } = require('../lib_access');
const { publicTarget } = require('../lib_workspace_runtime');
const profile = require('../lib_settings_profile');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-access-test-'));
  const db = new Database(path.join(dir, 'app.db'));
  db.exec('CREATE TABLE app_users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT); CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE clients(id INTEGER PRIMARY KEY,login TEXT); CREATE TABLE nodes(id INTEGER PRIMARY KEY,name TEXT)');
  db.prepare('INSERT INTO app_users VALUES (1,?,?)').run('owner', bcrypt.hashSync('test-owner-password', 4));
  const access = createAccess({ rootDir: dir, localDb: db, legacyUsername: 'owner' });
  t.after(() => { access.control.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, db, access };
}
test('migration retains password hash and existing primary data', t => {
  const { db, access, dir } = fixture(t);
  assert.equal(access.user(1).password_hash, db.prepare('SELECT password_hash FROM app_users').get().password_hash);
  assert.equal(access.user(1).is_owner, 1);
  assert.equal(fs.readdirSync(path.join(dir,'migration-backups')).filter(f => f.endsWith('.db')).length,1);
});
test('permissions, session revocation and owner protection', t => {
  const { access } = fixture(t);
  const id = access.createUser({ username: 'operator', password: 'test-password-123', wid: 'main', permissions: ['clients.read'] });
  const req = { session: {} }; access.authenticate(req, access.user(id));
  assert.ok(access.can(access.sessionUser(req), 'main', 'clients.read'));
  assert.equal(access.can(access.sessionUser(req), 'main', 'nodes.manage'), false);
  access.updateUser(id, { disabled: true, wid: 'main', permissions: ['clients.read'] });
  assert.equal(access.sessionUser(req), null);
  assert.throws(() => access.updateUser(1, { disabled: true, wid: 'main', permissions: [] }), /защищён/);
  assert.throws(() => access.createUser({ username: 'bad', password: 'test-password-123', wid: 'main', permissions: ['owner'] }), /Неизвестное/);
});
test('workspace membership does not grant access to another database', t => {
  const { access } = fixture(t);
  access.control.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run('other', 'Other', 'ready', '');
  const id = access.createUser({ username: 'otheruser', password: 'test-password-123', wid: 'other', permissions: ['clients.read'] });
  assert.equal(access.can(access.user(id), 'main', 'clients.read'), false);
  assert.equal(access.can(access.user(id), 'other', 'clients.read'), true);
});

test('a remote panel belongs to only one workspace, including background calls', t => {
  const { access, dir, db } = fixture(t);
  access.claimRemote('https://panel.example.test:2053/secret-path');
  const other = createAccess({rootDir:dir, localDb:db, workspaceId:'a'.repeat(24)});
  try {
    assert.throws(() => other.claimRemote('https://PANEL.example.test:2053/other-path'), /другим пространством/);
    assert.doesNotThrow(() => other.claimRemote('https://separate.example.test:2053'));
  } finally { other.control.close(); }
});
test('unknown and host-wide routes default to owner only', () => {
  for (const url of ['/backup/download','/backup/restore','/settings/security','/settings/project-update/start.json','/vpn/services/1/install','/new-future-api','/diagnostics','/debug/inbound/1']) assert.equal(permissionFor('POST', url), null, url);
});
test('public workspace router cannot tunnel administrative paths', () => {
  const id = 'a'.repeat(24);
  assert.deepEqual(publicTarget(`/s/${id}/json/secret?raw=1`), { id, url: '/json/secret?raw=1' });
  for (const url of [`/s/${id}/clients`, `/s/${id}/backup/download`, `/s/${id}/json/a/../../clients`]) assert.equal(publicTarget(url), null);
});
test('preferences allowlist excludes identity, nodes, clients and secrets', async t => {
  const { db, dir } = fixture(t);
  for (const [k,v] of Object.entries({ subscription_name:'PRIVATE NAME', telegram_bot_token:'SECRET', subscription_expired_grace_node_ids:'123', subscription_expired_grace_days:'3', client_default_duration_days:'45' })) db.prepare('INSERT INTO app_settings VALUES (?,?)').run(k,v);
  db.exec("INSERT INTO clients VALUES(1,'do-not-change'); INSERT INTO nodes VALUES(1,'private-node')");
  const bundle = profile.exportProfile(db);
  assert.doesNotMatch(JSON.stringify(bundle), /PRIVATE NAME|SECRET|private-node|do-not-change|node_ids/);
  assert.equal(bundle.settings.client_default_duration_days, '45');
  for (const key of ['subscription_name','telegram_bot_token','__proto__','constructor','toString','nodes']) assert.throws(() => profile.parse({ format:profile.FORMAT,version:1,settings:{[key]:'1'} }));
  const safe = { format: profile.FORMAT, version:1, settings: { client_default_duration_days:'14' } };
  assert.equal(profile.preview(db, safe)[0].before, '45');
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='client_default_duration_days'").get().value, '45');
  const result = await profile.apply(db, dir, safe);
  assert.equal(db.prepare('SELECT login FROM clients').get().login, 'do-not-change');
  assert.equal(db.prepare('SELECT name FROM nodes').get().name, 'private-node');
  assert.doesNotMatch(fs.readFileSync(path.join(dir,'backups',result.backup),'utf8'), /SECRET|private-node|do-not-change/);
  await profile.apply(db, dir, JSON.parse(fs.readFileSync(path.join(dir,'backups',result.backup),'utf8')));
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='client_default_duration_days'").get().value, '45');
  assert.throws(() => profile.parse({ format:profile.FORMAT,version:1,settings:{client_default_duration_days:'-1'} }));
});
