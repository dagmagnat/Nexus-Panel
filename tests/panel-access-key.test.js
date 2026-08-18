'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');

const projectRoot = path.resolve(__dirname, '..');

async function reservePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startApp(dataDir, panelAccessKey = 'legacy-key-that-must-be-ignored') {
  const port = await reservePort();
  const child = spawn(process.execPath, ['app.js'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_SECRET: 'test-app-secret-0123456789abcdef0123456789abcdef',
      SESSION_SECRET: 'test-session-secret-0123456789abcdef0123456789abcdef',
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
  await Promise.race([
    once(instance.child, 'exit'),
    new Promise(resolve => {
      timeoutId = setTimeout(() => {
        if (instance.child.exitCode === null) instance.child.kill('SIGKILL');
        resolve();
      }, 5000);
    })
  ]);
  clearTimeout(timeoutId);
}

test('legacy URL secret-key is ignored and password login remains reachable', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-login-without-key-'));
  let appInstance = null;
  t.after(async () => {
    await stopApp(appInstance);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  appInstance = await startApp(dataDir);
  for (const suffix of ['', '?key=wrong-key', '?key=old-bookmark-key']) {
    const response = await fetch(`http://127.0.0.1:${appInstance.port}/login${suffix}`, { redirect: 'manual' });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Вход в панель/);
  }
});

test('all unauthenticated dashboard requests redirect to login instead of Not found', { timeout: 30000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-direct-login-'));
  let appInstance = null;
  t.after(async () => {
    await stopApp(appInstance);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  appInstance = await startApp(dataDir);

  let response = await fetch(`http://127.0.0.1:${appInstance.port}/mobile-login`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/login');

  for (const accept of ['text/html', 'application/json']) {
    response = await fetch(`http://127.0.0.1:${appInstance.port}/dashboard`, {
      headers: { accept },
      redirect: 'manual'
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/login');
  }
});
