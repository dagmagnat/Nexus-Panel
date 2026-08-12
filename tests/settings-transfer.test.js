'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('../lib_crypto');

const projectRoot = path.resolve(__dirname, '..');
const toolPath = path.join(projectRoot, 'scripts', 'settings-transfer.js');
const testTempRoot = path.join(projectRoot, 'tmp');
const passphrase = 'correct horse battery staple';
const sourceSecret = 'source-secret-that-is-at-least-32-characters-long';
const targetSecret = 'target-secret-that-is-at-least-32-characters-long';

function tempDir(prefix) {
  fs.mkdirSync(testTempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testTempRoot, prefix));
}

function runTool(args, { appSecret = sourceSecret, phrase = passphrase, expectedStatus = 0 } = {}) {
  const result = spawnSync(process.execPath, [toolPath, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_SECRET: appSecret,
      NEXUS_SETTINGS_PASSPHRASE: phrase
    }
  });
  assert.equal(result.status, expectedStatus, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  const text = (expectedStatus === 0 ? result.stdout : result.stderr).trim();
  return text ? JSON.parse(text) : null;
}

function schema(db) {
  db.exec(`
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, node_type TEXT DEFAULT '3xui',
      panel_url TEXT NOT NULL, panel_path TEXT DEFAULT '', username TEXT NOT NULL,
      password_enc TEXT NOT NULL, api_auth_mode TEXT DEFAULT 'password', api_token_enc TEXT DEFAULT '',
      remnawave_caddy_token_enc TEXT DEFAULT '', inbound_id INTEGER NOT NULL, enabled INTEGER DEFAULT 1,
      last_status TEXT DEFAULT 'unknown', last_error TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      uuid TEXT NOT NULL, sub_slug TEXT UNIQUE NOT NULL
    );
    CREATE TABLE node_inbound_cache (
      node_id INTEGER PRIMARY KEY, inbound_id INTEGER NOT NULL, inbound_json TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE redirect_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT, bind_ip TEXT NOT NULL, node_id INTEGER NOT NULL,
      target_host TEXT NOT NULL, target_port INTEGER NOT NULL, protocol TEXT DEFAULT 'tcp',
      rewrite_enabled INTEGER DEFAULT 1, enabled INTEGER DEFAULT 1, last_status TEXT DEFAULT 'pending',
      last_error TEXT DEFAULT '', metrics_json TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(bind_ip,node_id,target_port,protocol)
    );
    CREATE TABLE sni_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, sni TEXT NOT NULL UNIQUE,
      comment TEXT DEFAULT '', is_builtin INTEGER DEFAULT 0, last_status TEXT DEFAULT '',
      last_check_json TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE vpn_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, placement TEXT DEFAULT 'remote',
      hostname TEXT NOT NULL, ssh_port INTEGER DEFAULT 22, ssh_username TEXT DEFAULT 'root',
      auth_type TEXT DEFAULT 'password', password_enc TEXT DEFAULT '', private_key_enc TEXT DEFAULT '',
      private_key_passphrase_enc TEXT DEFAULT '', sudo_password_enc TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      last_status TEXT DEFAULT 'unknown', last_error TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE vpn_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT, host_id INTEGER NOT NULL, protocol TEXT NOT NULL, name TEXT NOT NULL,
      interface_name TEXT DEFAULT '', listen_port INTEGER DEFAULT 0, server_private_key_enc TEXT DEFAULT '',
      api_url_enc TEXT DEFAULT '', backup_enc TEXT DEFAULT '', enabled INTEGER DEFAULT 1,
      last_status TEXT DEFAULT 'unknown', last_error TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(host_id,protocol,interface_name)
    );
  `);
}

function createSource(file) {
  const db = new Database(file);
  schema(db);
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('routing_config', ?)").run('{"rules":[{"outboundTag":"direct"}]}');
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('telegram_bot_token', ?)").run(`enc:v1:${encrypt('123456:telegram-secret', sourceSecret)}`);
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('telegram_backup_bot_token', 'legacy-plaintext-token')").run();
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('panel_access_key', ?)").run(`enc:v1:${encrypt('must-not-migrate', sourceSecret)}`);
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('panel_public_url', 'https://old.example')").run();
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('admin_allowed_ips', '10.0.0.1')").run();
  db.prepare(`
    INSERT INTO nodes (id,name,node_type,panel_url,panel_path,username,password_enc,api_auth_mode,api_token_enc,remnawave_caddy_token_enc,inbound_id,enabled,last_status)
    VALUES (7,'EU','3xui','https://node.example','/panel','admin',?,'token',?,'',1,1,'online')
  `).run(encrypt('node-password', sourceSecret), encrypt('node-api-token', sourceSecret));
  db.prepare("INSERT INTO node_inbound_cache (node_id,inbound_id,inbound_json) VALUES (7,1,'{\"protocol\":\"vless\"}')").run();
  db.prepare("INSERT INTO redirect_rules (bind_ip,node_id,target_host,target_port,enabled,last_status,metrics_json) VALUES ('31.1.2.3',7,'127.0.0.1',2053,1,'online','{\"connections\":10}')").run();
  db.prepare("INSERT INTO sni_profiles (name,sni,comment) VALUES ('VK','vk.com','old profile')").run();
  db.prepare(`
    INSERT INTO vpn_hosts (id,name,hostname,ssh_port,ssh_username,password_enc,enabled,last_status)
    VALUES (9,'VPN host','10.0.0.2',22,'root',?,1,'online')
  `).run(encrypt('ssh-password', sourceSecret));
  db.prepare(`
    INSERT INTO vpn_services (host_id,protocol,name,interface_name,listen_port,server_private_key_enc,enabled,last_status)
    VALUES (9,'wireguard','WG','wg0',51820,?,1,'online')
  `).run(encrypt('wg-private-key', sourceSecret));
  db.prepare("INSERT INTO clients (login,display_name,uuid,sub_slug) VALUES ('old-client','old-client','11111111-1111-4111-8111-111111111111','old-client-slug')").run();
  db.close();
}

function createTarget(file) {
  const db = new Database(file);
  schema(db);
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('panel_access_key', ?)").run(`enc:v1:${encrypt('new-panel-key', targetSecret)}`);
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('panel_public_url', 'https://new.example')").run();
  db.prepare("INSERT INTO app_settings (key,value) VALUES ('admin_allowed_ips', '203.0.113.10')").run();
  db.prepare(`
    INSERT INTO nodes (id,name,node_type,panel_url,panel_path,username,password_enc,api_auth_mode,api_token_enc,inbound_id)
    VALUES (42,'Existing EU','3xui','https://NODE.example/','panel','new-admin',?,'password','',1)
  `).run(encrypt('temporary', targetSecret));
  db.prepare("INSERT INTO clients (login,display_name,uuid,sub_slug) VALUES ('new-client','new-client','22222222-2222-4222-8222-222222222222','new-client-slug')").run();
  db.close();
}

test('encrypted settings bundle re-encrypts secrets and never imports clients or deployment access', () => {
  const directory = tempDir('nexus-settings-transfer-');
  try {
    const sourceDb = path.join(directory, 'source.db');
    const targetDb = path.join(directory, 'target.db');
    const bundle = path.join(directory, 'settings.nxsettings');
    createSource(sourceDb);
    createTarget(targetDb);

    const exported = runTool(['export', '--db', sourceDb, '--output', bundle]);
    assert.equal(exported.counts.nodes, 1);
    assert.equal(exported.counts.redirectRules, 1);
    assert.equal(fs.statSync(bundle).mode & 0o777, 0o600);
    const outerText = fs.readFileSync(bundle, 'utf8');
    assert.doesNotMatch(outerText, /node-password|telegram-secret|routing_config/);

    const wrongPass = runTool(['inspect', '--input', bundle], { phrase: 'wrong-password-phrase', expectedStatus: 2 });
    assert.match(wrongPass.error, /неверная парольная фраза|повреждён/);

    const stdinInspect = spawnSync(process.execPath, [toolPath, 'inspect', '--input', bundle], {
      encoding: 'utf8',
      input: passphrase,
      env: {
        ...process.env,
        APP_SECRET: sourceSecret,
        NEXUS_SETTINGS_PASSPHRASE: '',
        NEXUS_SETTINGS_PASSPHRASE_STDIN: '1'
      }
    });
    assert.equal(stdinInspect.status, 0, stdinInspect.stderr);
    assert.equal(JSON.parse(stdinInspect.stdout).encrypted, true);

    const unsupportedBundle = path.join(directory, 'unsupported-kdf.nxsettings');
    const unsupportedOuter = JSON.parse(outerText);
    unsupportedOuter.encryption.N = 1073741824;
    fs.writeFileSync(unsupportedBundle, JSON.stringify(unsupportedOuter));
    const unsupported = runTool(['inspect', '--input', unsupportedBundle], { expectedStatus: 2 });
    assert.match(unsupported.error, /неподдерживаемые параметры шифрования/);

    const preview = runTool(['import', '--db', targetDb, '--input', bundle, '--dry-run'], { appSecret: targetSecret });
    assert.equal(preview.dryRun, true);
    assert.equal(preview.nodesUpdated, 1);
    let db = new Database(targetDb, { readonly: true });
    assert.equal(decrypt(db.prepare('SELECT password_enc FROM nodes WHERE id=42').get().password_enc, targetSecret), 'temporary');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM redirect_rules').get().n, 0);
    db.close();
    assert.equal(fs.existsSync(path.join(directory, 'backups')), false);

    const imported = runTool(['import', '--db', targetDb, '--input', bundle], { appSecret: targetSecret });
    assert.equal(imported.nodesUpdated, 1);
    assert.equal(imported.redirectRulesCreated, 1);
    assert.match(imported.backupPath, /settings-import-before-.*\.db$/);
    assert.equal(fs.existsSync(imported.backupPath), true);

    db = new Database(targetDb, { readonly: true });
    const node = db.prepare('SELECT * FROM nodes WHERE id=42').get();
    assert.equal(decrypt(node.password_enc, targetSecret), 'node-password');
    assert.equal(decrypt(node.api_token_enc, targetSecret), 'node-api-token');
    assert.equal(node.last_status, 'unknown');
    const telegram = db.prepare("SELECT value FROM app_settings WHERE key='telegram_bot_token'").get().value;
    assert.equal(decrypt(telegram.slice('enc:v1:'.length), targetSecret), '123456:telegram-secret');
    const backupTelegram = db.prepare("SELECT value FROM app_settings WHERE key='telegram_backup_bot_token'").get().value;
    assert.equal(decrypt(backupTelegram.slice('enc:v1:'.length), targetSecret), 'legacy-plaintext-token');
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='panel_public_url'").get().value, 'https://new.example');
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='admin_allowed_ips'").get().value, '203.0.113.10');
    assert.equal(decrypt(db.prepare("SELECT value FROM app_settings WHERE key='panel_access_key'").get().value.slice('enc:v1:'.length), targetSecret), 'new-panel-key');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM clients').get().n, 1);
    assert.equal(db.prepare('SELECT login FROM clients').get().login, 'new-client');
    const redirect = db.prepare('SELECT * FROM redirect_rules').get();
    assert.equal(redirect.node_id, 42);
    assert.equal(redirect.enabled, 0);
    assert.equal(redirect.metrics_json, '');
    assert.equal(db.prepare('SELECT node_id FROM node_inbound_cache').get().node_id, 42);
    const vpnHost = db.prepare('SELECT * FROM vpn_hosts').get();
    assert.equal(decrypt(vpnHost.password_enc, targetSecret), 'ssh-password');
    assert.equal(vpnHost.enabled, 0);
    const vpnService = db.prepare('SELECT * FROM vpn_services').get();
    assert.equal(decrypt(vpnService.server_private_key_enc, targetSecret), 'wg-private-key');
    assert.equal(vpnService.host_id, vpnHost.id);
    assert.equal(vpnService.enabled, 0);
    db.close();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('web settings page and agg command expose encrypted import with dry-run', () => {
  const appSource = fs.readFileSync(path.join(projectRoot, 'app.js'), 'utf8');
  const viewSource = fs.readFileSync(path.join(projectRoot, 'views', 'settings.ejs'), 'utf8');
  const installerSource = fs.readFileSync(path.join(projectRoot, 'install.sh'), 'utf8');

  assert.match(appSource, /\/settings\/transfer\/export/);
  assert.match(appSource, /\/settings\/transfer\/import/);
  assert.match(viewSource, /Отдельный зашифрованный пакет/);
  assert.match(viewSource, /JSON\.stringify\(\{ passphrase, bundle, dryRun \}\)/);
  assert.match(installerSource, /agg settings export/);
  assert.match(installerSource, /settings_transfer_cli/);
  assert.match(installerSource, /\/app\/scripts\/settings-transfer\.js/);
  assert.match(installerSource, /NEXUS_SETTINGS_PASSPHRASE_STDIN=1/);
  assert.doesNotMatch(installerSource, /-e NEXUS_SETTINGS_PASSPHRASE="\$passphrase"/);
});
