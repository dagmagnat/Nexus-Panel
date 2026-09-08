'use strict';

// Nexus Node is intentionally a pull-based control plane: a node opens only an
// outbound HTTPS connection to the panel.  This keeps the Xray host out of the
// public management surface and also works behind NAT.
const { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } = require('crypto');
const bodyParser = require('body-parser');

const API_PREFIX = '/api/nexus-node/v1';
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_CAPABILITIES_BYTES = 32 * 1024;
const MAX_OPERATION_PAYLOAD_BYTES = 512 * 1024;

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function parseJson(value, fallback) {
  try { return JSON.parse(String(value || '')); } catch (_) { return fallback; }
}

function cleanNodeName(value) {
  const name = String(value || '').replace(/[\u0000-\u001f]/g, '').trim();
  if (name.length < 1 || name.length > 100) throw new Error('Имя ноды должно содержать от 1 до 100 символов.');
  return name;
}

function cleanCapabilities(value) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const encoded = JSON.stringify(raw);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_CAPABILITIES_BYTES) throw new Error('Список capabilities слишком большой.');
  return encoded;
}

function initNexusNodeControlSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nexus_node_enrollments (
      id TEXT PRIMARY KEY,
      name_hint TEXT NOT NULL DEFAULT '',
      token_hash TEXT NOT NULL UNIQUE,
      expires_at_ms INTEGER NOT NULL,
      used_at_ms INTEGER DEFAULT NULL,
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nexus_node_enrollments_expiry
      ON nexus_node_enrollments(expires_at_ms);

    CREATE TABLE IF NOT EXISTS nexus_nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      shared_secret_enc TEXT NOT NULL,
      agent_version TEXT NOT NULL DEFAULT '',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'offline',
      last_seen_at_ms INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT '',
      revoked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nexus_nodes_seen ON nexus_nodes(last_seen_at_ms);

    CREATE TABLE IF NOT EXISTS nexus_node_nonces (
      node_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      PRIMARY KEY (node_id, nonce)
    );
    CREATE INDEX IF NOT EXISTS idx_nexus_node_nonces_expiry ON nexus_node_nonces(expires_at_ms);

    CREATE TABLE IF NOT EXISTS nexus_node_operations (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'queued',
      result_json TEXT NOT NULL DEFAULT '',
      error_text TEXT NOT NULL DEFAULT '',
      created_at_ms INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL DEFAULT 0,
      finished_at_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_nexus_node_operations_queue
      ON nexus_node_operations(node_id, status, created_at_ms);
  `);
}

function attachNexusNodeControl({ app, db, requireAuth, render, appSecret, encrypt, decrypt }) {
  const json = bodyParser.json({ limit: '600kb' });

  function listNodes() {
    return db.prepare(`
      SELECT n.*, (
        SELECT COUNT(*) FROM nexus_node_operations o WHERE o.node_id = n.id AND o.status IN ('queued', 'running')
      ) AS pending_operations
      FROM nexus_nodes n ORDER BY n.last_seen_at_ms DESC, n.created_at DESC
    `).all().map(row => ({
      ...row,
      capabilities: parseJson(row.capabilities_json, {}),
      online: !row.revoked && Date.now() - Number(row.last_seen_at_ms || 0) < 75 * 1000
    }));
  }

  function page(req, res, options = {}) {
    res.setHeader('Cache-Control', 'no-store');
    render(res, 'nexus_nodes', {
      nodes: listNodes(),
      enrollmentToken: options.enrollmentToken || '',
      enrollmentName: options.enrollmentName || '',
      message: options.message || req.query.message || '',
      error: options.error || req.query.error || ''
    });
  }

  function createEnrollment(nameHint, minutes) {
    const ttlMinutes = Math.max(5, Math.min(60, Math.floor(Number(minutes) || 15)));
    const token = `nxenr_${randomBytes(24).toString('base64url')}`;
    db.prepare(`INSERT INTO nexus_node_enrollments (id, name_hint, token_hash, expires_at_ms)
      VALUES (?, ?, ?, ?)`)
      .run(randomUUID(), String(nameHint || '').trim().slice(0, 100), sha256(token), Date.now() + ttlMinutes * 60 * 1000);
    return { token, ttlMinutes };
  }

  function verifyAgent(req, res, next) {
    try {
      const nodeId = String(req.headers['x-nexus-node-id'] || '').trim();
      const timestamp = Number(req.headers['x-nexus-timestamp']);
      const nonce = String(req.headers['x-nexus-nonce'] || '').trim();
      const signature = String(req.headers['x-nexus-signature'] || '').trim();
      if (!/^[0-9a-f-]{36}$/i.test(nodeId) || !Number.isFinite(timestamp) || !/^[A-Za-z0-9_-]{16,160}$/.test(nonce) || !/^[a-f0-9]{64}$/i.test(signature)) {
        return res.status(401).json({ ok: false, error: 'Invalid node authentication headers.' });
      }
      if (Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
        return res.status(401).json({ ok: false, error: 'Node clock is outside the allowed window.' });
      }
      const node = db.prepare('SELECT * FROM nexus_nodes WHERE id = ?').get(nodeId);
      if (!node || Number(node.revoked) === 1) return res.status(401).json({ ok: false, error: 'Node is unknown or revoked.' });
      const nonceExists = db.prepare('SELECT 1 FROM nexus_node_nonces WHERE node_id = ? AND nonce = ?').get(nodeId, nonce);
      if (nonceExists) return res.status(409).json({ ok: false, error: 'Replayed node request.' });
      const secret = decrypt(node.shared_secret_enc, appSecret);
      const bodyHash = sha256(JSON.stringify(req.body || {}));
      const canonical = `${req.method}\n${req.path}\n${timestamp}\n${nonce}\n${bodyHash}`;
      const expected = createHmac('sha256', secret).update(canonical).digest('hex');
      if (!safeEqual(signature, expected)) return res.status(401).json({ ok: false, error: 'Invalid node signature.' });
      db.prepare('DELETE FROM nexus_node_nonces WHERE expires_at_ms < ?').run(Date.now());
      db.prepare('INSERT INTO nexus_node_nonces (node_id, nonce, expires_at_ms) VALUES (?, ?, ?)')
        .run(nodeId, nonce, Date.now() + MAX_CLOCK_SKEW_MS);
      req.nexusNode = node;
      next();
    } catch (err) {
      res.status(401).json({ ok: false, error: 'Node authentication failed.' });
    }
  }

  function touchNode(nodeId, body) {
    const agentVersion = String(body?.agentVersion || '').trim().slice(0, 80);
    const capabilities = cleanCapabilities(body?.capabilities || {});
    db.prepare(`UPDATE nexus_nodes SET status = 'online', last_seen_at_ms = ?, agent_version = ?, capabilities_json = ?, last_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(Date.now(), agentVersion, capabilities, nodeId);
  }

  app.get('/nexus-nodes', requireAuth, (req, res) => page(req, res));
  app.post('/nexus-nodes/enrollments', requireAuth, (req, res) => {
    try {
      const name = String(req.body.name || '').trim().slice(0, 100);
      const enrollment = createEnrollment(name, req.body.expires_minutes);
      page(req, res, { enrollmentToken: enrollment.token, enrollmentName: name, message: `Код создан на ${enrollment.ttlMinutes} мин. Скопируй его сейчас: после ухода со страницы он больше не показывается.` });
    } catch (err) { page(req, res, { error: String(err.message || err) }); }
  });
  app.post('/nexus-nodes/:id/revoke', requireAuth, (req, res) => {
    const result = db.prepare(`UPDATE nexus_nodes SET revoked = 1, status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(String(req.params.id));
    page(req, res, result.changes ? { message: 'Нода отозвана. Следующий запрос агента будет отклонён.' } : { error: 'Нода не найдена.' });
  });
  app.post('/nexus-nodes/:id/health-check', requireAuth, (req, res) => {
    const nodeId = String(req.params.id);
    const node = db.prepare('SELECT id FROM nexus_nodes WHERE id = ? AND revoked = 0').get(nodeId);
    if (!node) return page(req, res, { error: 'Нода не найдена или уже отозвана.' });
    db.prepare(`INSERT INTO nexus_node_operations (id, node_id, kind, payload_json, created_at_ms) VALUES (?, ?, 'health.check', '{}', ?)`)
      .run(randomUUID(), nodeId, Date.now());
    page(req, res, { message: 'Проверка поставлена в очередь. Агент заберёт её при следующем опросе.' });
  });

  app.get('/api/nexus-nodes', requireAuth, (req, res) => res.json({ ok: true, nodes: listNodes() }));
  app.post('/api/nexus-nodes/enrollments', requireAuth, json, (req, res) => {
    try {
      const enrollment = createEnrollment(req.body?.name, req.body?.expiresMinutes);
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ ok: true, enrollmentToken: enrollment.token, expiresInMinutes: enrollment.ttlMinutes });
    } catch (err) { res.status(400).json({ ok: false, error: String(err.message || err) }); }
  });
  app.post('/api/nexus-nodes/:id/operations', requireAuth, json, (req, res) => {
    try {
      const nodeId = String(req.params.id);
      const node = db.prepare('SELECT id FROM nexus_nodes WHERE id = ? AND revoked = 0').get(nodeId);
      if (!node) throw new Error('Нода не найдена или отозвана.');
      const kind = String(req.body?.kind || '').trim();
      if (!['health.check', 'xray.test-config', 'xray.apply-config'].includes(kind)) throw new Error('Неподдерживаемый тип операции.');
      const payload = req.body?.payload && typeof req.body.payload === 'object' && !Array.isArray(req.body.payload) ? req.body.payload : {};
      const payloadJson = JSON.stringify(payload);
      if (Buffer.byteLength(payloadJson, 'utf8') > MAX_OPERATION_PAYLOAD_BYTES) throw new Error('Payload операции слишком большой.');
      const id = randomUUID();
      db.prepare('INSERT INTO nexus_node_operations (id, node_id, kind, payload_json, created_at_ms) VALUES (?, ?, ?, ?, ?)')
        .run(id, nodeId, kind, payloadJson, Date.now());
      res.status(201).json({ ok: true, operationId: id });
    } catch (err) { res.status(400).json({ ok: false, error: String(err.message || err) }); }
  });

  // The enrollment request is deliberately not authenticated with the regular
  // node secret: the one-use token is its short-lived, single-purpose proof.
  app.post(`${API_PREFIX}/enroll`, json, (req, res) => {
    try {
      const token = String(req.body?.enrollmentToken || '').trim();
      const enrollment = db.prepare('SELECT * FROM nexus_node_enrollments WHERE token_hash = ?').get(sha256(token));
      if (!enrollment || enrollment.revoked || enrollment.used_at_ms || Number(enrollment.expires_at_ms) < Date.now()) {
        return res.status(401).json({ ok: false, error: 'Enrollment token is invalid, expired, or already used.' });
      }
      const name = cleanNodeName(req.body?.name || enrollment.name_hint);
      const agentVersion = String(req.body?.agentVersion || '').trim().slice(0, 80);
      const capabilities = cleanCapabilities(req.body?.capabilities || {});
      const nodeId = randomUUID();
      const secret = randomBytes(32).toString('base64url');
      const tx = db.transaction(() => {
        const consumed = db.prepare(`UPDATE nexus_node_enrollments SET used_at_ms = ? WHERE id = ? AND used_at_ms IS NULL AND revoked = 0`).run(Date.now(), enrollment.id);
        if (consumed.changes !== 1) throw new Error('Enrollment token has already been consumed.');
        db.prepare(`INSERT INTO nexus_nodes (id, name, shared_secret_enc, agent_version, capabilities_json, status, last_seen_at_ms)
          VALUES (?, ?, ?, ?, ?, 'online', ?)`)
          .run(nodeId, name, encrypt(secret, appSecret), agentVersion, capabilities, Date.now());
      });
      tx();
      res.setHeader('Cache-Control', 'no-store');
      res.status(201).json({ ok: true, nodeId, sharedSecret: secret, pollIntervalSeconds: 10, protocolVersion: 1 });
    } catch (err) { res.status(400).json({ ok: false, error: String(err.message || err) }); }
  });

  app.post(`${API_PREFIX}/heartbeat`, json, verifyAgent, (req, res) => {
    try { touchNode(req.nexusNode.id, req.body); res.json({ ok: true, serverTime: Date.now() }); }
    catch (err) { res.status(400).json({ ok: false, error: String(err.message || err) }); }
  });
  app.post(`${API_PREFIX}/poll`, json, verifyAgent, (req, res) => {
    try {
      touchNode(req.nexusNode.id, req.body);
      const operation = db.prepare(`SELECT * FROM nexus_node_operations WHERE node_id = ? AND status = 'queued' ORDER BY created_at_ms ASC LIMIT 1`).get(req.nexusNode.id);
      if (!operation) return res.json({ ok: true, operation: null });
      const claimed = db.prepare(`UPDATE nexus_node_operations SET status = 'running', started_at_ms = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'queued'`).run(Date.now(), operation.id);
      if (!claimed.changes) return res.json({ ok: true, operation: null });
      return res.json({ ok: true, operation: { id: operation.id, kind: operation.kind, payload: parseJson(operation.payload_json, {}) } });
    } catch (err) { res.status(400).json({ ok: false, error: String(err.message || err) }); }
  });
  app.post(`${API_PREFIX}/operations/:id/result`, json, verifyAgent, (req, res) => {
    try {
      touchNode(req.nexusNode.id, req.body);
      const ok = req.body?.ok === true;
      const result = req.body?.result && typeof req.body.result === 'object' ? req.body.result : {};
      const resultJson = JSON.stringify(result);
      if (Buffer.byteLength(resultJson, 'utf8') > MAX_OPERATION_PAYLOAD_BYTES) throw new Error('Operation result is too large.');
      const changed = db.prepare(`UPDATE nexus_node_operations
        SET status = ?, result_json = ?, error_text = ?, finished_at_ms = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND node_id = ? AND status = 'running'`)
        .run(ok ? 'succeeded' : 'failed', resultJson, String(req.body?.error || '').slice(0, 2000), Date.now(), String(req.params.id), req.nexusNode.id);
      if (!changed.changes) return res.status(409).json({ ok: false, error: 'Operation is not running for this node.' });
      res.json({ ok: true });
    } catch (err) { res.status(400).json({ ok: false, error: String(err.message || err) }); }
  });
}

module.exports = { API_PREFIX, initNexusNodeControlSchema, attachNexusNodeControl };
