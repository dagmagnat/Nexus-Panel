'use strict';
const { randomUUID, randomBytes } = require('node:crypto');
const { encrypt, decrypt } = require('./lib_crypto');

// Credential revocation is separate from clearing the HWID registry. A failed
// operation stays disabled and can resume; old credentials are never restored.
function createClientAccessRotation({ db, secret, adapters, preparePrivate }) {
  db.exec(`CREATE TABLE IF NOT EXISTS client_access_rotations(
    id TEXT PRIMARY KEY,client_id INTEGER NOT NULL,status TEXT NOT NULL,
    state_enc TEXT NOT NULL,error TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );CREATE INDEX IF NOT EXISTS idx_access_rotation_client ON client_access_rotations(client_id,status)`);
  const locks = new Map();
  const read = row => JSON.parse(decrypt(row.state_enc, secret));
  const save = (id, state, status = 'running', error = '') => db.prepare('UPDATE client_access_rotations SET state_enc=?,status=?,error=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(encrypt(JSON.stringify(state), secret), status, error, id);
  async function run(clientId) {
    let job = db.prepare("SELECT * FROM client_access_rotations WHERE client_id=? AND status IN ('running','failed') ORDER BY updated_at DESC LIMIT 1").get(clientId);
    let state;
    if (job) state = read(job);
    else {
      const client = db.prepare('SELECT * FROM clients WHERE id=?').get(clientId);
      if (!client) throw Error('Клиент не найден');
      const maps = db.prepare('SELECT cn.* FROM client_nodes cn JOIN nodes n ON n.id=cn.node_id WHERE cn.client_id=?').all(clientId);
      const nodes = maps.map(map => ({ ...db.prepare('SELECT * FROM nodes WHERE id=?').get(map.node_id), map }));
      if (nodes.some(n => !['remnawave', '3xui'].includes(n.node_type))) throw Error('Для этого типа провайдера полный перевыпуск пока не поддерживается');
      if (nodes.some(n => n.node_type === '3xui' && !n.enabled)) throw Error('Сначала отзовите ключ на отключённом 3x-ui узле; полный сброс пока не подтверждён');
      if (db.prepare('SELECT 1 FROM client_support_identities WHERE client_id=? LIMIT 1').get(clientId)) throw Error('У клиента есть отдельные служебные ключи: требуется их отдельный отзыв');
      const remna = nodes.filter(n => n.node_type === 'remnawave');
      if (new Set(remna.map(n => n.panel_url.replace(/\/$/, ''))).size > 1) throw Error('Несколько независимых Remnawave-панелей: требуется согласованный перевыпуск');
      state = { client, maps, newSlug: randomBytes(24).toString('hex'), newUuid: '', nativeDone: [], remnaDone: false, enabledDone: [], snapshots: {} };
      for (const n of nodes.filter(n => n.node_type === '3xui')) state.snapshots[n.id] = await adapters.snapshotNative(n, n.map, client);
      job = { id: randomUUID() };
      db.prepare('INSERT INTO client_access_rotations(id,client_id,status,state_enc) VALUES(?,?,?,?)').run(job.id, clientId, 'running', encrypt(JSON.stringify(state), secret));
    }
    db.prepare('UPDATE clients SET enabled=0 WHERE id=?').run(clientId);
    try {
      const nodes = state.maps.map(map => ({ ...db.prepare('SELECT * FROM nodes WHERE id=?').get(map.node_id), map }));
      const remna = nodes.find(n => n.node_type === 'remnawave');
      if (!state.remnaDone) {
        if (remna) {
          const result = await adapters.revokeRemna(remna, remna.map, state.client);
          if (!result.uuid || result.uuid === state.client.uuid) throw Error('Remnawave не подтвердил новый VLESS UUID');
          state.newUuid = result.uuid; state.remoteSubUrl = result.subscriptionUrl;
        } else state.newUuid = randomUUID();
        state.remnaDone = true; save(job.id, state);
      }
      const next = { ...state.client, uuid: state.newUuid, sub_slug: state.newSlug, enabled: 0, last_online_at: '' };
      for (const n of nodes.filter(n => n.node_type === '3xui')) {
        if (state.nativeDone.includes(n.id)) continue;
        await adapters.rotateNative(n, n.map, next, state.snapshots[n.id]);
        state.nativeDone.push(n.id); save(job.id, state);
      }
      if (!state.localCommitted) { db.transaction(() => {
        db.prepare('UPDATE clients SET uuid=?,sub_slug=?,last_online_at=? WHERE id=?').run(next.uuid, next.sub_slug, '', clientId);
        if (remna) db.prepare("UPDATE client_nodes SET remote_sub_url=? WHERE client_id=? AND node_id IN (SELECT id FROM nodes WHERE node_type='remnawave')").run(state.remoteSubUrl, clientId);
        db.prepare('DELETE FROM subscription_devices WHERE client_id=?').run(clientId);
        db.prepare('DELETE FROM client_nodes WHERE client_id=? AND node_id NOT IN (SELECT id FROM nodes)').run(clientId);
        db.prepare('DELETE FROM awg_manual_links WHERE client_id=?').run(clientId);
        db.prepare('DELETE FROM subscription_migration_devices WHERE client_id=?').run(clientId);
        db.prepare('DELETE FROM subscription_migrations WHERE client_id=?').run(clientId);
      })(); state.localCommitted = true; save(job.id, state); }
      if (preparePrivate && !state.privatePrepared) {
        await preparePrivate(next); state.privatePrepared = true; save(job.id, state);
      }
      for (const n of nodes) {
        if (state.enabledDone.includes(n.id)) continue;
        await adapters.restoreEnabled(n, next, state.client.enabled !== 0);
        state.enabledDone.push(n.id); save(job.id, state);
      }
      db.prepare('UPDATE clients SET enabled=? WHERE id=?').run(state.client.enabled, clientId);
      save(job.id, state, 'complete');
      return { clientId, login: state.client.login, revokedNodes: nodes.length, newSlug: state.newSlug };
    } catch (e) { save(job.id, state, 'failed', String(e.message || e).slice(0, 600)); throw e; }
  }
  return { rotate(id) {
    id = Number(id);
    if (locks.has(id)) return locks.get(id);
    const operation = run(id).finally(() => locks.delete(id));
    locks.set(id, operation); return operation;
  } };
}
module.exports = { createClientAccessRotation };
