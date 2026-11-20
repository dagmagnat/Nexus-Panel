'use strict';
const { randomBytes, createHash } = require('node:crypto');
const { encrypt, decrypt } = require('./lib_crypto');
const { encryptLink } = require('./vendor/incy-link-encoder');

const MODES = ['off', 'notify', 'require-happ', 'retired'];
const tokenHash = token => createHash('sha256').update(String(token)).digest('hex');
const isHapp = req => /happ/i.test(String(req.get?.('user-agent') || ''));

function createSubscriptionMigration({ db, secret, baseUrl, name, portalUrl, fetchImpl = global.fetch }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subscription_migrations (
      client_id INTEGER PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
      source_hash TEXT UNIQUE NOT NULL, source_enc TEXT NOT NULL,
      happ_enc TEXT NOT NULL DEFAULT '', incy_enc TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'off', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS subscription_migration_devices (
      client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      hwid_hash TEXT NOT NULL, app_name TEXT NOT NULL,
      first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY(client_id, hwid_hash, app_name)
    );
  `);
  const pending = new Map();
  const get = id => db.prepare('SELECT * FROM subscription_migrations WHERE client_id=?').get(id);
  const ready = row => Boolean(row?.happ_enc && row?.incy_enc);
  const portal = client => portalUrl?portalUrl(client):baseUrl().replace(/\/$/, '') + '/open/' + encodeURIComponent(client.sub_slug);
  const source = row => baseUrl().replace(/\/$/, '') + '/' + decrypt(row.source_enc, secret);
  function links(client) {
    const row = get(client.id);
    if (!ready(row)) return null;
    return { portal: portal(client), happ: decrypt(row.happ_enc, secret), incy: decrypt(row.incy_enc, secret), mode: row.mode };
  }
  async function prepare(client, mode = 'notify') {
    if (!MODES.includes(mode)) throw Error('Неизвестный режим переноса');
    if (pending.has(client.id)) return pending.get(client.id);
    const run = (async () => {
      let row = get(client.id);
      if (!row) {
        const token = 'k' + randomBytes(24).toString('hex');
        db.prepare('INSERT OR IGNORE INTO subscription_migrations(client_id,source_hash,source_enc) VALUES(?,?,?)')
          .run(client.id, tokenHash(token), encrypt(token, secret));
        row = get(client.id);
      }
      if (!ready(row)) {
        const response = await fetchImpl('https://crypto.happ.su/api-v2.php', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: source(row) }), signal: AbortSignal.timeout(15000)
        });
        if (!response.ok) throw Error('Сервис Happ недоступен: HTTP ' + response.status);
        const body = await response.json();
        if (!/^happ:\/\/crypt5\/[A-Za-z0-9+/=]+$/.test(body.encrypted_link || '')) throw Error('Сервис Happ вернул неподдерживаемую ссылку');
        const incy = encryptLink(source(row) + '?format=incy', { name: name() });
        db.prepare('UPDATE subscription_migrations SET happ_enc=?,incy_enc=? WHERE client_id=?')
          .run(encrypt(body.encrypted_link, secret), encrypt(incy, secret), client.id);
      }
      db.prepare('UPDATE subscription_migrations SET mode=? WHERE client_id=?').run(mode, client.id);
      return links(client);
    })().finally(() => pending.delete(client.id));
    pending.set(client.id, run);
    return run;
  }
  function rewrite(req) {
    const match = String(req.url).match(/^\/json\/(k[a-f0-9]{48})(?=\?|\/|$)/);
    if (!match) return;
    const row = db.prepare('SELECT m.*,c.sub_slug FROM subscription_migrations m JOIN clients c ON c.id=m.client_id WHERE source_hash=?').get(tokenHash(match[1]));
    if (!ready(row)) return;
    req.nexusPrivateSubscription = { clientId: row.client_id };
    req.url = req.url.replace('/json/' + match[1], '/json/' + encodeURIComponent(row.sub_slug));
  }
  function state(req, client, hwidHash) {
    const row = get(client.id);
    if (!ready(row)) return null;
    const secure = req.nexusPrivateSubscription?.clientId === client.id;
    const happ = isHapp(req);
    const seen = Boolean(hwidHash && db.prepare("SELECT 1 FROM subscription_migration_devices WHERE client_id=? AND hwid_hash=? AND app_name='Happ'").get(client.id, hwidHash));
    const blocked = !secure && (row.mode === 'retired' || (happ && (row.mode === 'require-happ' || (row.mode === 'notify' && seen))));
    return { secure, blocked, notify: !secure && (row.mode === 'retired' || (happ && row.mode !== 'off')), portal: portal(client), mode: row.mode };
  }
  function delivered(req, client, hwidHash) {
    if (!hwidHash || req.method !== 'GET' || req.nexusPrivateSubscription?.clientId !== client.id) return;
    const app = isHapp(req) ? 'Happ' : /incy/i.test(req.get?.('user-agent') || '') ? 'INCY' : 'Other';
    db.prepare(`INSERT INTO subscription_migration_devices(client_id,hwid_hash,app_name) VALUES(?,?,?)
      ON CONFLICT(client_id,hwid_hash,app_name) DO UPDATE SET last_seen_at=CURRENT_TIMESTAMP`).run(client.id, hwidHash, app);
  }
  return { get, ready, links, prepare, rewrite, state, delivered, portal, source,
    setMode(id, mode) {
      if (!MODES.includes(mode)) throw Error('Неизвестный режим переноса');
      if (!ready(get(id))) throw Error('Сначала подготовьте ссылки');
      db.prepare('UPDATE subscription_migrations SET mode=? WHERE client_id=?').run(mode, id);
    }
  };
}
module.exports = { createSubscriptionMigration, MODES, isHapp, tokenHash };
