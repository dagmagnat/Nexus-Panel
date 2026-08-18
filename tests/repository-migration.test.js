'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');

const projectRoot = path.resolve(__dirname, '..');
const officialRepository = 'https://github.com/dagmagnat/Nexus-Panel';
const migrationMarker = 'official_repository_migrated_stage109';

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startApp(dataDir) {
  const port = await reservePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: 'repository-test-app-secret-0123456789abcdef',
      SESSION_SECRET: 'repository-test-session-secret-0123456789abcdef',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'repository-test-password',
      PANEL_ACCESS_KEY: 'repository-test-access-key',
      PANEL_PUBLIC_URL: `http://127.0.0.1:${port}`,
      SUB_PUBLIC_URL: `http://127.0.0.1:${port}`,
      BASE_URL: `http://127.0.0.1:${port}`,
      SESSION_SECURE: '0',
      TRUST_PROXY: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let output = '';
  await new Promise((resolve, reject) => {
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
  return child;
}

async function stopApp(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise(resolve => setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve();
    }, 5000))
  ]);
}

function updateSettings(dataDir, values, deleteKeys = []) {
  const db = new Database(path.join(dataDir, 'app.db'));
  try {
    const upsert = db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `);
    for (const [key, value] of Object.entries(values)) upsert.run(key, value);
    for (const key of deleteKeys) db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
  } finally {
    db.close();
  }
}

function readSetting(dataDir, key) {
  const db = new Database(path.join(dataDir, 'app.db'), { readonly: true });
  try {
    return String(db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value || '');
  } finally {
    db.close();
  }
}

test('official repository default migrates legacy URL and preserves forks', { timeout: 45000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-panel-repository-'));
  let app = null;
  t.after(async () => {
    await stopApp(app);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  app = await startApp(dataDir);
  await stopApp(app);
  app = null;
  assert.equal(readSetting(dataDir, 'update_repo_url'), officialRepository);

  updateSettings(dataDir, {
    update_repo_url: 'https://github.com/dagmagnat/3xui-Aggregator.git'
  }, [migrationMarker]);
  app = await startApp(dataDir);
  await stopApp(app);
  app = null;
  assert.equal(readSetting(dataDir, 'update_repo_url'), officialRepository);

  const forkRepository = 'https://github.com/example/Nexus-Panel';
  updateSettings(dataDir, { update_repo_url: forkRepository }, [migrationMarker]);
  app = await startApp(dataDir);
  await stopApp(app);
  app = null;
  assert.equal(readSetting(dataDir, 'update_repo_url'), forkRepository);
});
