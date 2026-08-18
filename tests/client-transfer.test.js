'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const toolPath = path.join(projectRoot, 'scripts', 'client-transfer.py');
const testTempRoot = path.join(projectRoot, 'tmp');

function createTempDirectory(prefix) {
  fs.mkdirSync(testTempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testTempRoot, prefix));
}

function runTool(args, expectedStatus = 0) {
  const result = spawnSync('python3', ['-B', toolPath, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const text = (expectedStatus === 0 ? result.stdout : result.stderr).trim();
  return text ? JSON.parse(text) : null;
}

function createSchema(db) {
  db.exec(`
    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO app_settings (key, value) VALUES ('subscription_revision', '1');
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      node_type TEXT NOT NULL DEFAULT '3xui',
      panel_url TEXT NOT NULL,
      panel_path TEXT DEFAULT '',
      inbound_id INTEGER NOT NULL,
      country_code TEXT DEFAULT '',
      label_suffix TEXT DEFAULT ''
    );
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      uuid TEXT NOT NULL,
      sub_slug TEXT UNIQUE NOT NULL,
      duration_days INTEGER NOT NULL DEFAULT 0,
      traffic_gb INTEGER NOT NULL DEFAULT 0,
      limit_ip INTEGER NOT NULL DEFAULT 1,
      expiry_time INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      comment TEXT NOT NULL DEFAULT '',
      flow TEXT NOT NULL DEFAULT '',
      last_online_at TEXT NOT NULL DEFAULT '',
      group_id INTEGER DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE client_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT COLLATE NOCASE UNIQUE NOT NULL, color TEXT NOT NULL);
    CREATE TABLE client_tags (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT COLLATE NOCASE UNIQUE NOT NULL, color TEXT NOT NULL);
    CREATE TABLE client_tag_assignments (client_id INTEGER NOT NULL, tag_id INTEGER NOT NULL, PRIMARY KEY (client_id, tag_id));
    CREATE TABLE client_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      remote_email TEXT NOT NULL,
      remote_uuid TEXT NOT NULL,
      remote_sub_url TEXT DEFAULT '',
      traffic_gb INTEGER NOT NULL DEFAULT 0,
      limit_ip INTEGER DEFAULT NULL,
      upload_bytes INTEGER NOT NULL DEFAULT 0,
      download_bytes INTEGER NOT NULL DEFAULT 0,
      used_bytes INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, node_id)
    );
  `);
}

function createSourceDatabase(file) {
  const db = new Database(file);
  createSchema(db);
  db.prepare(`
    INSERT INTO nodes (id, name, node_type, panel_url, panel_path, inbound_id, country_code, label_suffix)
    VALUES (7, 'Европа', '3xui', 'https://operator:node-password@node.example.com/', '/secret/', 1, 'DE', 'LTE')
  `).run();
  const insertClient = db.prepare(`
    INSERT INTO clients
      (login, display_name, uuid, sub_slug, duration_days, traffic_gb, limit_ip, expiry_time, enabled, comment, flow, last_online_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const alice = Number(insertClient.run(
    'Alice', 'Телефон Alice', '11111111-1111-4111-8111-111111111111', 'alice-old-link',
    30, 100, 2, 1800000000000, 1, 'важный клиент', 'xtls-rprx-vision', '2026-08-10T10:00:00Z', '2026-01-01 00:00:00'
  ).lastInsertRowid);
  const groupId = Number(db.prepare("INSERT INTO client_groups (name, color) VALUES ('Яблоко', '#64748b')").run().lastInsertRowid);
  const tagId = Number(db.prepare("INSERT INTO client_tags (name, color) VALUES ('Друг', '#22c55e')").run().lastInsertRowid);
  db.prepare('UPDATE clients SET group_id = ? WHERE id = ?').run(groupId, alice);
  db.prepare('INSERT INTO client_tag_assignments (client_id, tag_id) VALUES (?, ?)').run(alice, tagId);
  insertClient.run(
    'Bob', 'Bob', '22222222-2222-4222-8222-222222222222', 'bob-old-link',
    0, 0, 1, 0, 1, '', '', '', '2026-01-02 00:00:00'
  );
  db.prepare(`
    INSERT INTO client_nodes
      (client_id, node_id, remote_email, remote_uuid, remote_sub_url, traffic_gb, limit_ip, upload_bytes, download_bytes, used_bytes, enabled)
    VALUES (?, 7, ?, ?, ?, 80, 2, 1000, 2000, 3000, 1)
  `).run(alice, 'Alice', '11111111-1111-4111-8111-111111111111', 'https://old.example/sub/alice');
  db.close();
}

function createTargetDatabase(file, { nodeId = 42 } = {}) {
  const db = new Database(file);
  createSchema(db);
  db.prepare(`
    INSERT INTO nodes (id, name, node_type, panel_url, panel_path, inbound_id, country_code, label_suffix)
    VALUES (?, 'Европа новая', '3xui', 'https://NODE.example.com', 'secret', 1, 'DE', '')
  `).run(nodeId);
  db.close();
}

test('direct SQLite export preserves credentials and excludes node secrets', () => {
  const tempDir = createTempDirectory('nexus-client-export-');
  try {
    const sourceDb = path.join(tempDir, 'old-app.db');
    const transferFile = path.join(tempDir, 'clients.json');
    createSourceDatabase(sourceDb);

    const result = runTool(['export', '--db', sourceDb, '--output', transferFile]);
    assert.equal(result.clients, 2);
    assert.equal(result.assignments, 1);
    if (process.platform !== 'win32') assert.equal(fs.statSync(transferFile).mode & 0o777, 0o600);

    const document = JSON.parse(fs.readFileSync(transferFile, 'utf8'));
    assert.equal(document.format, 'nexus-panel-client-transfer');
    assert.equal(document.clients[0].uuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(document.clients[0].subSlug, 'alice-old-link');
    assert.equal(document.clients[0].nodeAssignments[0].nodeRef.inboundId, 1);
    assert.deepEqual(document.clients[0].group, { name: 'Яблоко', color: '#64748b' });
    assert.deepEqual(document.clients[0].tags, [{ name: 'Друг', color: '#22c55e' }]);
    assert.equal(JSON.stringify(document).includes('password'), false);
    assert.equal(JSON.stringify(document).includes('api_token'), false);
    assert.equal(JSON.stringify(document).includes('node-password'), false);

    const inspection = runTool(['inspect', '--input', transferFile]);
    assert.equal(inspection.ok, true);
    assert.equal(inspection.clients, 2);
    assert.equal(inspection.assignments, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dry-run rolls back, then import keeps UUID/sub_slug and matches a changed node ID', () => {
  const tempDir = createTempDirectory('nexus-client-import-');
  try {
    const sourceDb = path.join(tempDir, 'old-app.db');
    const targetDb = path.join(tempDir, 'new-app.db');
    const transferFile = path.join(tempDir, 'clients.json');
    createSourceDatabase(sourceDb);
    createTargetDatabase(targetDb, { nodeId: 42 });
    runTool(['export', '--db', sourceDb, '--output', transferFile]);

    const preview = runTool([
      'import', '--db', targetDb, '--input', transferFile,
      '--mode', 'update', '--node-mode', 'match', '--dry-run'
    ]);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.created, 2);
    assert.equal(preview.assignmentsCreated, 1);
    let db = new Database(targetDb, { readonly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM clients').get().total, 0);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='subscription_revision'").get().value, '1');
    db.close();
    assert.equal(fs.existsSync(path.join(tempDir, 'backups')), false);

    const imported = runTool([
      'import', '--db', targetDb, '--input', transferFile,
      '--mode', 'update', '--node-mode', 'match'
    ]);
    assert.equal(imported.created, 2);
    assert.equal(imported.conflictCount, 0);
    assert.equal(imported.assignmentsCreated, 1);
    assert.match(imported.backupPath, /client-import-before-.*\.db$/);
    assert.equal(fs.existsSync(imported.backupPath), true);

    db = new Database(targetDb, { readonly: true });
    const alice = db.prepare('SELECT * FROM clients WHERE lower(login)=lower(?)').get('alice');
    assert.equal(alice.uuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(alice.sub_slug, 'alice-old-link');
    assert.equal(alice.display_name, 'Телефон Alice');
    const assignment = db.prepare('SELECT * FROM client_nodes WHERE client_id=?').get(alice.id);
    assert.equal(assignment.node_id, 42);
    assert.equal(assignment.used_bytes, 3000);
    assert.equal(assignment.remote_sub_url, 'https://old.example/sub/alice');
    assert.equal(db.prepare('SELECT name FROM client_groups WHERE id=?').get(alice.group_id).name, 'Яблоко');
    assert.equal(db.prepare(`SELECT t.name FROM client_tag_assignments a JOIN client_tags t ON t.id=a.tag_id WHERE a.client_id=?`).get(alice.id).name, 'Друг');
    assert.ok(Number(db.prepare("SELECT value FROM app_settings WHERE key='subscription_revision'").get().value) > 1);
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('update refuses a login with another identity while replace is explicit', () => {
  const tempDir = createTempDirectory('nexus-client-conflict-');
  try {
    const sourceDb = path.join(tempDir, 'old-app.db');
    const targetDb = path.join(tempDir, 'new-app.db');
    const transferFile = path.join(tempDir, 'clients.json');
    createSourceDatabase(sourceDb);
    createTargetDatabase(targetDb);
    runTool(['export', '--db', sourceDb, '--output', transferFile]);

    let db = new Database(targetDb);
    db.prepare(`
      INSERT INTO clients (login, display_name, uuid, sub_slug)
      VALUES ('Alice', 'Wrong Alice', '99999999-9999-4999-8999-999999999999', 'different-link')
    `).run();
    db.close();

    const safeResult = runTool(['import', '--db', targetDb, '--input', transferFile, '--mode', 'update', '--node-mode', 'none']);
    assert.equal(safeResult.created, 1);
    assert.equal(safeResult.conflictCount, 1);
    db = new Database(targetDb, { readonly: true });
    assert.equal(db.prepare("SELECT uuid FROM clients WHERE login='Alice'").get().uuid, '99999999-9999-4999-8999-999999999999');
    db.close();

    const replaceResult = runTool(['import', '--db', targetDb, '--input', transferFile, '--mode', 'replace', '--node-mode', 'none']);
    assert.equal(replaceResult.updated, 2);
    assert.equal(replaceResult.conflictCount, 0);
    db = new Database(targetDb, { readonly: true });
    const alice = db.prepare("SELECT uuid, sub_slug FROM clients WHERE login='Alice'").get();
    assert.equal(alice.uuid, '11111111-1111-4111-8111-111111111111');
    assert.equal(alice.sub_slug, 'alice-old-link');
    db.close();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('web UI and agg installer command expose the same transfer workflow', () => {
  const appSource = fs.readFileSync(path.join(projectRoot, 'app.js'), 'utf8');
  const viewSource = fs.readFileSync(path.join(projectRoot, 'views', 'clients.ejs'), 'utf8');
  const installerSource = fs.readFileSync(path.join(projectRoot, 'install.sh'), 'utf8');

  assert.match(appSource, /\/clients\/transfer\/export/);
  assert.match(appSource, /\/clients\/transfer\/import/);
  assert.match(viewSource, /Перенос клиентов между серверами/);
  assert.match(viewSource, /client-transfer\.js/);
  assert.match(installerSource, /agg clients export/);
  assert.match(installerSource, /client_transfer_cli/);
});
