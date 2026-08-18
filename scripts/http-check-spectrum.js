'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const envText = fs.readFileSync(path.join(root, '.env.development'), 'utf8');
const devEnv = Object.fromEntries(envText.split(/\r?\n/).map(line => line.match(/^([^#=]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]));
const port = 3078;
const baseUrl = `http://127.0.0.1:${port}`;
const isolatedDataDir = path.join(root, `.tmp-spectrum-http-${process.pid}`);
const isolatedDbPath = path.join(isolatedDataDir, 'app.db');
fs.mkdirSync(isolatedDataDir, { recursive: true });
const server = spawn(process.execPath, ['app.js'], {
  cwd: root,
  env: { ...process.env, ...devEnv, NODE_ENV: 'development', DATA_DIR: isolatedDataDir, PORT: String(port), BASE_URL: baseUrl, PANEL_PUBLIC_URL: baseUrl, SUB_PUBLIC_URL: baseUrl },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += String(chunk); });
server.stderr.on('data', chunk => { serverOutput += String(chunk); });

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function request(pathname, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 20_000);
  try {
    return await fetch(`${baseUrl}${pathname}`, { ...options, signal: controller.signal, redirect: options.redirect || 'manual' });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Server exited (${server.exitCode}): ${serverOutput}`);
    try {
      const response = await request('/login', { timeout: 1_000 });
      if (response.status === 200) return;
    } catch (_) {}
    await wait(100);
  }
  throw new Error(`Server did not become ready: ${serverOutput}`);
}

function cookieFrom(response) {
  return String(response.headers.get('set-cookie') || '').split(';')[0];
}

function csrfFrom(html) {
  return (html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/) || [])[1] || '';
}

(async () => {
  await waitForServer();
  const seedResult = spawnSync(process.execPath, [path.join(root, 'scripts/dev-seed-spectrum.js')], {
    cwd: root,
    env: { ...process.env, SPECTRUM_DB_PATH: isolatedDbPath },
    encoding: 'utf8'
  });
  if (seedResult.status !== 0) throw new Error(`Preview seed failed: ${seedResult.stderr || seedResult.stdout}`);
  const loginPage = await request('/login');
  const loginHtml = await loginPage.text();
  let cookie = cookieFrom(loginPage);
  const csrf = csrfFrom(loginHtml);
  if (!cookie || !csrf) throw new Error('Login page did not provide session/CSRF data.');

  const loginResponse = await request('/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams({ username: devEnv.ADMIN_USERNAME || 'admin', password: devEnv.ADMIN_PASSWORD || '', _csrf: csrf }).toString()
  });
  if (loginResponse.status !== 302 || !String(loginResponse.headers.get('location') || '').includes('/dashboard')) {
    throw new Error(`Login failed with HTTP ${loginResponse.status}.`);
  }
  cookie = cookieFrom(loginResponse) || cookie;

  const routes = [
    '/dashboard', '/nodes', '/clients', '/clients?q=nexus01&edit=1', '/nodes/1/edit',
    '/routing', '/redirects', '/diagnostics', '/telegram-bot', '/settings', '/more'
  ];
  const report = [];
  for (const pathname of routes) {
    const response = await request(pathname, { headers: { cookie }, timeout: 30_000 });
    const html = await response.text();
    const styleHrefs = Array.from(html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)/g), match => match[1]);
    report.push({
      path: pathname,
      status: response.status,
      spectrumBody: /<body\s+class="[^"]*nexus-spectrum/.test(html),
      spectrumCss: styleHrefs.some(href => href.includes('/css/spectrum-clear.css')),
      legacyCss: styleHrefs.filter(href => /\/(?:style|redesign|nexus-ui|branding|stage\d+)\.css/.test(href)),
      title: (html.match(/<title>([^<]+)/) || [,''])[1]
    });
  }

  const publicResponse = await request('/open/spectrum-preview-01', { timeout: 15_000 });
  const publicHtml = await publicResponse.text();
  report.push({
    path: '/open/:slug',
    status: publicResponse.status,
    spectrumBody: /<body\s+class="[^"]*nexus-spectrum/.test(publicHtml),
    spectrumCss: publicHtml.includes('/css/spectrum-clear.css'),
    legacyCss: []
  });

  const cssResponse = await request('/css/spectrum-clear.css');
  const manifestResponse = await request('/site.webmanifest');
  const manifest = await manifestResponse.json();
  const cssCacheControl = String(cssResponse.headers.get('cache-control') || '');
  const manifestCacheControl = String(manifestResponse.headers.get('cache-control') || '');
  const failed = report.filter(item => item.status !== 200 || !item.spectrumBody || !item.spectrumCss || item.legacyCss.length);
  const staticRevisionOk = cssCacheControl.includes('no-store')
    && manifestCacheControl.includes('no-store')
    && manifest.start_url === '/mobile-login';
  const result = {
    ok: failed.length === 0 && cssResponse.status === 200 && manifestResponse.status === 200 && staticRevisionOk,
    routes: report.length,
    cssStatus: cssResponse.status,
    manifestStatus: manifestResponse.status,
    manifestStartUrl: manifest.start_url,
    cssCacheControl,
    manifestCacheControl,
    failed,
    report
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
})().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  server.kill('SIGTERM');
  try { fs.rmSync(isolatedDataDir, { recursive: true, force: true }); } catch (_) {}
});
