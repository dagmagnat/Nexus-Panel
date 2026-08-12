'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('../lib_crypto');

const projectRoot = path.resolve(__dirname, '..');
const appSecret = 'test-app-secret-0123456789abcdef0123456789abcdef';
const sessionSecret = 'test-session-secret-0123456789abcdef0123456789abcdef';
const fingerprintSetting = 'install_panel_access_key_env_fingerprint_v1';

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startApp(dataDir, panelAccessKey) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: appSecret,
      SESSION_SECRET: sessionSecret,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'test-password-strong',
      PANEL_ACCESS_KEY: panelAccessKey,
      PANEL_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
      BASE_URL: `http://127.0.0.1:${port}`,
      SESSION_SECURE: '0',
      TRUST_PROXY: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`App startup timed out:\n${output}`)), 15000);
    const collect = chunk => {
      output += chunk.toString();
      if (output.includes(`3xui-aggregator started on :${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`App exited with code ${code}:\n${output}`));
    });
  });

  await started;
  return { child, port };
}

async function stopApp(instance) {
  if (!instance || instance.child.exitCode !== null) return;
  instance.child.kill('SIGTERM');
  let timeoutId;
  const timeout = new Promise(resolve => {
    timeoutId = setTimeout(() => {
      if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
      resolve();
    }, 5000);
  });
  await Promise.race([once(instance.child, 'exit'), timeout]);
  clearTimeout(timeoutId);
}

async function requestLogin(port, key) {
  return fetch(`http://127.0.0.1:${port}/login?key=${encodeURIComponent(key)}`, {
    redirect: 'manual'
  });
}

function setDatabaseSetting(dataDir, key, value) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    const stored = key === 'panel_access_key' && value
      ? `enc:v1:${encrypt(value, appSecret)}`
      : String(value || '');
    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `).run(key, stored);
  } finally {
    db.close();
  }
}

function deleteDatabaseSetting(dataDir, key) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  } finally {
    db.close();
  }
}

function readPanelAccessKey(dataDir) {
  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  try {
    const raw = String(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('panel_access_key')?.value || '');
    return raw.startsWith('enc:v1:') ? decrypt(raw.slice('enc:v1:'.length), appSecret) : raw;
  } finally {
    db.close();
  }
}

function printRuntimePanelAccessKey(dataDir, environmentKey) {
  return execFileSync(process.execPath, ['scripts/print-panel-access-key.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      APP_SECRET: appSecret,
      PANEL_ACCESS_KEY: environmentKey
    },
    encoding: 'utf8'
  });
}

test('panel access key recovers once from .env and respects later UI changes', { timeout: 45000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-panel-key-'));
  let appInstance = null;
  t.after(async () => {
    await stopApp(appInstance);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const initialKey = 'initial-panel-key-1234';
  appInstance = await startApp(dataDir, initialKey);
  let response = await requestLogin(appInstance.port, initialKey);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
  await stopApp(appInstance);
  appInstance = null;

  // Simulate a pre-fix backup whose SQLite key differs from the deployment
  // key and has no reconciliation fingerprint.
  setDatabaseSetting(dataDir, 'panel_access_key', 'legacy-database-key-1234');
  deleteDatabaseSetting(dataDir, fingerprintSetting);

  const recoveredEnvironmentKey = 'deployment-key-from-env-1234';
  appInstance = await startApp(dataDir, recoveredEnvironmentKey);
  response = await requestLogin(appInstance.port, recoveredEnvironmentKey);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');
  await stopApp(appInstance);
  appInstance = null;
  assert.equal(readPanelAccessKey(dataDir), recoveredEnvironmentKey);
  assert.equal(printRuntimePanelAccessKey(dataDir, 'stale-env-key-1234'), recoveredEnvironmentKey);

  // A later key chosen in the UI is authoritative: the unchanged .env key is
  // no longer accepted as a permanent back door.
  const uiKey = 'key-selected-in-ui-1234';
  setDatabaseSetting(dataDir, 'panel_access_key', uiKey);
  assert.equal(printRuntimePanelAccessKey(dataDir, recoveredEnvironmentKey), uiKey);
  appInstance = await startApp(dataDir, recoveredEnvironmentKey);
  response = await requestLogin(appInstance.port, recoveredEnvironmentKey);
  assert.equal(response.status, 404);
  assert.equal(await response.text(), 'Not found');
  response = await requestLogin(appInstance.port, uiKey);
  assert.equal(response.status, 302);
  await stopApp(appInstance);
  appInstance = null;

  // Rotating PANEL_ACCESS_KEY in the deployment creates a new one-time
  // recovery value and synchronizes SQLite after successful use.
  const rotatedEnvironmentKey = 'rotated-deployment-key-1234';
  appInstance = await startApp(dataDir, rotatedEnvironmentKey);
  response = await requestLogin(appInstance.port, rotatedEnvironmentKey);
  assert.equal(response.status, 302);
  await stopApp(appInstance);
  appInstance = null;
  assert.equal(readPanelAccessKey(dataDir), rotatedEnvironmentKey);
});
