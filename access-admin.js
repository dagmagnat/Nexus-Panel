'use strict';
// SSH-only recovery utility. Not exposed through HTTP and never creates users.
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

async function grantOwner(db, root, username) {
  const target = db.prepare('SELECT id,username,is_owner,disabled FROM users WHERE username=?').get(username);
  if (!target) throw new Error('Логин не найден. Сначала выполните list.');
  if (target.disabled) throw new Error('Аккаунт заблокирован. Сначала выясните причину блокировки.');
  if (target.is_owner) return {username:target.username, unchanged:true};
  const directory = path.join(root, 'migration-backups');
  fs.mkdirSync(directory, {recursive:true, mode:0o700});
  const backup = path.join(directory, `before-owner-${crypto.randomUUID()}.db`);
  // Reserve a private file before SQLite opens it; includes committed WAL data.
  fs.closeSync(fs.openSync(backup, 'wx', 0o600));
  await db.backup(backup);
  db.transaction(() => {
    const result = db.prepare('UPDATE users SET is_owner=1,auth_version=auth_version+1 WHERE id=? AND disabled=0 AND is_owner=0').run(target.id);
    if (result.changes !== 1) throw new Error('Аккаунт изменился. Повторите проверку list.');
    db.prepare("INSERT INTO access_audit(actor,workspace,action,target) VALUES(NULL,'main','owner.granted-via-ssh',?)").run(String(target.id));
  })();
  return {username:target.username, backup};
}

async function main() {
  require('dotenv').config({quiet:true});
  const [command, username, confirm] = process.argv.slice(2);
  if (command !== 'list' && !(command === 'grant-owner' && username && confirm === '--confirm'))
    throw new Error('Команды: node access-admin.js list | node access-admin.js grant-owner ТОЧНЫЙ_ЛОГИН --confirm');
  if (process.env.NEXUS_WORKSPACE_ID && process.env.NEXUS_WORKSPACE_ID !== 'main') throw new Error('Запустите в основном контейнере Nexus.');
  const root = path.resolve(process.env.NEXUS_CONTROL_DIR || path.resolve(__dirname, process.env.DATA_DIR || 'data'));
  const db = new Database(path.join(root, 'control.db'), {fileMustExist:true, readonly:command === 'list'});
  db.pragma('busy_timeout = 5000');
  try {
    if (command === 'list') {
      console.table(db.prepare('SELECT id,username,is_owner AS main_admin,disabled FROM users ORDER BY id').all());
      console.table(db.prepare('SELECT id,name,status FROM workspaces ORDER BY id').all());
    } else {
      const result = await grantOwner(db, root, username);
      console.log(result.unchanged ? `У ${result.username} уже есть права главного администратора.` : `Права главного администратора выданы: ${result.username}. Резервная копия: ${result.backup}`);
      console.log('Выйдите из панели и войдите заново. Выберите пространство «Основное». Пароль не изменён.');
    }
  } finally { db.close(); }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = {grantOwner};
