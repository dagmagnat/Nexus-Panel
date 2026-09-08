#!/usr/bin/env node
'use strict';

// Dependency-free Nexus Node Agent. It uses only Node.js built-ins, so it can
// be copied to a clean Linux VPS with Node.js 22 and does not expose a port.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createHash, createHmac, randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const VERSION = '0.1.0';
const CONFIG_PATH = process.env.NEXUS_NODE_CONFIG || '/etc/nexus-node-agent/config.json';
const STATE_PATH = process.env.NEXUS_NODE_STATE || '/var/lib/nexus-node-agent/state.json';
const POLL_FALLBACK_SECONDS = 10;

function usage() {
  console.log(`Nexus Node Agent ${VERSION}\n\nCommands:\n  node agent.js enroll --panel https://panel.example --token nxenr_... --name "NL-1"\n  node agent.js run\n  node agent.js status\n\nEnvironment:\n  NEXUS_NODE_CONFIG, NEXUS_NODE_STATE, NEXUS_ALLOW_INSECURE_HTTP=1 (development only)`);
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writePrivateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function sha256(value) { return createHash('sha256').update(String(value)).digest('hex'); }

function args(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    result[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '1';
  }
  return result;
}

function normalisePanelUrl(value) {
  const url = new URL(String(value || '').trim());
  if (url.protocol !== 'https:' && process.env.NEXUS_ALLOW_INSECURE_HTTP !== '1') {
    throw new Error('Panel URL must use HTTPS. Set NEXUS_ALLOW_INSECURE_HTTP=1 only for local development.');
  }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Panel URL must use HTTP(S).');
  return url.toString().replace(/\/$/, '');
}

function capabilities() {
  return {
    protocol: 1,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    operations: ['health.check', 'xray.test-config', 'xray.apply-config'],
    xray: Boolean(process.env.NEXUS_XRAY_BIN || findOnPath('xray'))
  };
}

function findOnPath(name) {
  return String(process.env.PATH || '').split(path.delimiter).some(folder => {
    try { return fs.statSync(path.join(folder, name)).isFile(); } catch (_) { return false; }
  });
}

async function request(config, endpoint, body, { signed = true } = {}) {
  const payload = body || {};
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (signed) {
    const timestamp = Date.now();
    const nonce = randomUUID().replace(/-/g, '');
    const canonical = `POST\n${endpoint}\n${timestamp}\n${nonce}\n${sha256(JSON.stringify(payload))}`;
    headers['x-nexus-node-id'] = config.nodeId;
    headers['x-nexus-timestamp'] = String(timestamp);
    headers['x-nexus-nonce'] = nonce;
    headers['x-nexus-signature'] = createHmac('sha256', config.sharedSecret).update(canonical).digest('hex');
  }
  const response = await fetch(config.panelUrl + endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `Panel returned HTTP ${response.status}`);
  return data;
}

async function enroll(options) {
  if (!options.panel || !options.token || !options.name) throw new Error('For enrollment provide --panel, --token, and --name.');
  const config = { panelUrl: normalisePanelUrl(options.panel) };
  const result = await request(config, '/api/nexus-node/v1/enroll', {
    enrollmentToken: options.token,
    name: options.name,
    agentVersion: VERSION,
    capabilities: capabilities()
  }, { signed: false });
  const saved = {
    panelUrl: config.panelUrl,
    nodeId: result.nodeId,
    sharedSecret: result.sharedSecret,
    pollIntervalSeconds: Number(result.pollIntervalSeconds) || POLL_FALLBACK_SECONDS,
    enrolledAt: new Date().toISOString()
  };
  writePrivateJson(CONFIG_PATH, saved);
  console.log(`Enrolled as ${saved.nodeId}. Private configuration: ${CONFIG_PATH}`);
}

function xrayBin() { return String(process.env.NEXUS_XRAY_BIN || 'xray'); }
function xrayConfigPath() { return String(process.env.NEXUS_XRAY_CONFIG || '/etc/xray/config.json'); }

async function testXrayConfig(config) {
  const dir = path.dirname(xrayConfigPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = path.join(dir, `.nexus-xray-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(temporary, JSON.stringify(config), { mode: 0o600 });
  try {
    const { stdout, stderr } = await execFileAsync(xrayBin(), ['run', '-test', '-c', temporary], { timeout: 30000, maxBuffer: 1024 * 1024 });
    return { ok: true, output: String(stdout || stderr || 'Configuration OK').slice(0, 4000) };
  } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
}

async function applyXrayConfig(config) {
  const checked = await testXrayConfig(config);
  const target = xrayConfigPath();
  const dir = path.dirname(target);
  const temporary = path.join(dir, `.nexus-xray-apply-${process.pid}-${randomUUID()}.json`);
  fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
  const reload = String(process.env.NEXUS_XRAY_RELOAD_COMMAND || '').trim();
  if (reload) {
    const [command, ...commandArgs] = reload.split(/\s+/);
    await execFileAsync(command, commandArgs, { timeout: 30000, maxBuffer: 1024 * 1024 });
  }
  return { ...checked, appliedTo: target, reloadRequested: Boolean(reload) };
}

async function executeOperation(operation) {
  if (operation.kind === 'health.check') {
    return { hostname: os.hostname(), uptimeSeconds: Math.round(os.uptime()), loadavg: os.loadavg(), capabilities: capabilities() };
  }
  if (operation.kind === 'xray.test-config' || operation.kind === 'xray.apply-config') {
    const config = operation.payload?.config;
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Operation does not contain an Xray config object.');
    return operation.kind === 'xray.apply-config' ? applyXrayConfig(config) : testXrayConfig(config);
  }
  throw new Error(`Unsupported operation: ${operation.kind}`);
}

async function run() {
  const config = readJson(CONFIG_PATH);
  if (!config?.panelUrl || !config?.nodeId || !config?.sharedSecret) throw new Error(`No valid configuration in ${CONFIG_PATH}. Run enroll first.`);
  normalisePanelUrl(config.panelUrl);
  const state = readJson(STATE_PATH, {});
  console.log(`Nexus Node Agent ${VERSION} connected to ${config.panelUrl} as ${config.nodeId}`);
  for (;;) {
    try {
      await request(config, '/api/nexus-node/v1/heartbeat', { agentVersion: VERSION, capabilities: capabilities(), state });
      const poll = await request(config, '/api/nexus-node/v1/poll', { agentVersion: VERSION, capabilities: capabilities() });
      if (poll.operation) {
        let ok = true; let result = {}; let error = '';
        try { result = await executeOperation(poll.operation); }
        catch (err) { ok = false; error = String(err.message || err); }
        await request(config, `/api/nexus-node/v1/operations/${encodeURIComponent(poll.operation.id)}/result`, { agentVersion: VERSION, capabilities: capabilities(), ok, result, error });
        if (ok) writePrivateJson(STATE_PATH, { ...state, lastOperationId: poll.operation.id, lastSuccessAt: new Date().toISOString() });
      }
      await new Promise(resolve => setTimeout(resolve, Math.max(3, Number(config.pollIntervalSeconds) || POLL_FALLBACK_SECONDS) * 1000));
    } catch (err) {
      console.error(`[${new Date().toISOString()}] ${String(err.message || err)}`);
      await new Promise(resolve => setTimeout(resolve, 15000));
    }
  }
}

(async () => {
  const command = process.argv[2];
  try {
    if (command === 'enroll') await enroll(args(process.argv.slice(3)));
    else if (command === 'run') await run();
    else if (command === 'status') console.log(JSON.stringify(readJson(CONFIG_PATH, { enrolled: false }), null, 2));
    else usage();
  } catch (err) { console.error(`Nexus Node Agent: ${String(err.message || err)}`); process.exitCode = 1; }
})();
