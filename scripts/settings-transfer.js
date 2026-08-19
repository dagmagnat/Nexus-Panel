#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { encrypt, decrypt } = require('../lib_crypto');

const BUNDLE_FORMAT = 'nexus-panel-settings-bundle';
const PAYLOAD_FORMAT = 'nexus-panel-settings-payload';
const SCHEMA_VERSION = 1;
const PASSPHRASE_ENV = 'NEXUS_SETTINGS_PASSPHRASE';
const MAX_INPUT_BYTES = 100 * 1024 * 1024;
const DETAIL_LIMIT = 100;
const SENSITIVE_SETTING_KEYS = new Set([
  'telegram_bot_token',
  'telegram_manager_bot_token',
  'telegram_backup_bot_token',
  'telegram_manager_proxy_url'
]);
const SKIPPED_SETTING_KEYS = new Set([
  'panel_access_key',
  'admin_allowed_ips',
  'panel_public_url',
  'sub_public_url',
  'sub_url_mode',
  'update_repo_url',
  'subscription_revision',
  'subscription_device_limit_migrated_v1',
  'install_panel_access_key_env_fingerprint_v1',
  'install_public_url_fingerprint'
]);
const NODE_SECRET_COLUMNS = new Set(['password_enc', 'api_token_enc', 'remnawave_caddy_token_enc']);
const VPN_HOST_SECRET_COLUMNS = new Set(['password_enc', 'private_key_enc', 'private_key_passphrase_enc', 'sudo_password_enc']);
const VPN_SERVICE_SECRET_COLUMNS = new Set(['server_private_key_enc', 'api_url_enc', 'backup_enc']);

class TransferError extends Error {}

function utcNow() {
  return new Date().toISOString();
}

function cleanText(value, maximum = 16384) {
  return String(value == null ? '' : value).replaceAll('\0', '').trim().slice(0, maximum);
}

function normalizeNodeType(value) {
  const raw = cleanText(value, 80).toLowerCase().replaceAll('_', '-');
  return ({ '3x-ui': '3xui', 'x-ui': '3xui', xui: '3xui', remna: 'remnawave' })[raw] || raw || '3xui';
}

function normalizePanelUrl(value) {
  const raw = cleanText(value, 2048).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`);
    parsed.username = '';
    parsed.password = '';
    parsed.hash = '';
    parsed.search = '';
    if ((parsed.protocol === 'https:' && parsed.port === '443') || (parsed.protocol === 'http:' && parsed.port === '80')) parsed.port = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '').toLowerCase();
  } catch (_) {
    return raw.toLowerCase();
  }
}

function normalizePanelPath(value) {
  const raw = cleanText(value, 1024).replace(/^\/+|\/+$/g, '');
  return raw ? `/${raw}` : '';
}

function quoteIdentifier(value) {
  const name = String(value || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TransferError(`Недопустимое имя SQLite: ${name}`);
  return `"${name}"`;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function tableColumns(db, table) {
  if (!tableExists(db, table)) return [];
  return db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all().map(row => String(row.name));
}

function rowObject(row, allowedColumns = null) {
  const result = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (!allowedColumns || allowedColumns.has(key)) result[key] = value;
  }
  return result;
}

function requireDatabase(db) {
  for (const table of ['app_settings', 'nodes', 'clients']) {
    if (!tableExists(db, table)) throw new TransferError(`В базе отсутствует таблица ${table}`);
  }
}

function getPassphrase() {
  let passphrase = String(process.env[PASSPHRASE_ENV] || '');
  if (!passphrase && String(process.env.NEXUS_SETTINGS_PASSPHRASE_STDIN || '') === '1') {
    try {
      passphrase = fs.readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
    } catch (_) {
      throw new TransferError('Не удалось прочитать парольную фразу из stdin');
    }
  }
  if (passphrase.length < 12) throw new TransferError('Парольная фраза должна содержать минимум 12 символов');
  return passphrase;
}

function encryptBundle(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    encryption: {
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      N: 16384,
      r: 8,
      p: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64')
    },
    ciphertext: ciphertext.toString('base64')
  };
}

function decryptBundle(bundle, passphrase) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT || Number(bundle.schemaVersion) !== SCHEMA_VERSION) {
    throw new TransferError('Неизвестный или несовместимый файл настроек');
  }
  const spec = bundle.encryption || {};
  if (spec.algorithm !== 'aes-256-gcm' || spec.kdf !== 'scrypt') throw new TransferError('Неподдерживаемое шифрование файла');
  if (Number(spec.N) !== 16384 || Number(spec.r) !== 8 || Number(spec.p) !== 1) {
    throw new TransferError('Файл использует неподдерживаемые параметры шифрования');
  }
  try {
    const salt = Buffer.from(String(spec.salt || ''), 'base64');
    const iv = Buffer.from(String(spec.iv || ''), 'base64');
    const tag = Buffer.from(String(spec.tag || ''), 'base64');
    const ciphertext = Buffer.from(String(bundle.ciphertext || ''), 'base64');
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || !ciphertext.length) {
      throw new TransferError('Файл настроек повреждён');
    }
    const key = crypto.scryptSync(passphrase, salt, 32, {
      N: 16384,
      r: 8,
      p: 1
    });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (payload?.format !== PAYLOAD_FORMAT || Number(payload?.schemaVersion) !== SCHEMA_VERSION) {
      throw new TransferError('Расшифрованный файл имеет неизвестный формат');
    }
    return payload;
  } catch (err) {
    if (err instanceof TransferError) throw err;
    throw new TransferError('Не удалось расшифровать файл: неверная парольная фраза или файл повреждён');
  }
}

function decryptSourceValue(value, sourceSecret, label) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return decrypt(raw, sourceSecret);
  } catch (err) {
    throw new TransferError(`Не удалось расшифровать ${label}. Проверь APP_SECRET старой панели.`);
  }
}

function exportSettings(db, sourceSecret) {
  requireDatabase(db);
  if (!sourceSecret || sourceSecret === 'change-me') throw new TransferError('APP_SECRET старой панели не задан');

  const settings = db.prepare('SELECT key, value FROM app_settings ORDER BY key').all()
    .filter(row => {
      const key = String(row.key || '');
      return !SKIPPED_SETTING_KEYS.has(key) && !/^stage\d+_/i.test(key);
    })
    .map(row => {
      const key = String(row.key);
      const raw = String(row.value ?? '');
      if (!SENSITIVE_SETTING_KEYS.has(key)) return { key, value: raw, sensitive: false };
      if (!raw) return { key, value: '', sensitive: true };
      // Current versions store these values with enc:v1:. A plaintext value
      // can still exist in an older database before its first migration.
      const value = raw.startsWith('enc:v1:')
        ? decryptSourceValue(raw.slice('enc:v1:'.length), sourceSecret, `настройку ${key}`)
        : raw;
      return { key, value, sensitive: true };
    });

  const exportSecretRows = (table, secretColumns, reset = {}) => {
    if (!tableExists(db, table)) return [];
    return db.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY id`).all().map(row => {
      const result = rowObject(row);
      for (const column of secretColumns) {
        if (column in result) result[column] = decryptSourceValue(result[column], sourceSecret, `${table}.${column}`);
      }
      Object.assign(result, reset);
      return result;
    });
  };

  const categories = {
    appSettings: settings,
    nodes: exportSecretRows('nodes', NODE_SECRET_COLUMNS, { last_status: 'unknown', last_error: '' }),
    nodeInboundCache: tableExists(db, 'node_inbound_cache')
      ? db.prepare('SELECT * FROM node_inbound_cache ORDER BY node_id').all().map(row => rowObject(row))
      : [],
    redirectRules: tableExists(db, 'redirect_rules') ? db.prepare('SELECT * FROM redirect_rules ORDER BY id').all().map(row => ({
      ...rowObject(row),
      enabled: 0,
      last_status: 'pending',
      last_error: 'Импортировано отключённым: проверь bind IP и порт на новом сервере',
      metrics_json: ''
    })) : [],
    sniProfiles: tableExists(db, 'sni_profiles')
      ? db.prepare('SELECT * FROM sni_profiles ORDER BY id').all().map(row => rowObject(row))
      : [],
    vpnHosts: exportSecretRows('vpn_hosts', VPN_HOST_SECRET_COLUMNS, { enabled: 0, last_status: 'unknown', last_error: 'Импортировано отключённым: проверь доступ с нового сервера' }),
    vpnServices: exportSecretRows('vpn_services', VPN_SERVICE_SECRET_COLUMNS, { enabled: 0, last_status: 'unknown', last_error: 'Импортировано отключённым: проверь конфигурацию нового сервера' })
  };

  const versionPath = path.resolve(__dirname, '..', 'VERSION');
  return {
    format: PAYLOAD_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: utcNow(),
    source: {
      application: 'Nexus Panel / 3x-ui Aggregator',
      appVersion: fs.existsSync(versionPath) ? cleanText(fs.readFileSync(versionPath, 'utf8'), 200) : 'unknown'
    },
    exclusions: [
      'clients and client-node assignments',
      'traffic history',
      'Telegram users/orders/tickets/history',
      'administrator account and deployment-specific IP/URL/access-key settings',
      'VPN clients and queued jobs'
    ],
    categories
  };
}

function summaryFromPayload(payload) {
  const categories = payload.categories || {};
  const count = key => Array.isArray(categories[key]) ? categories[key].length : 0;
  return {
    ok: true,
    format: payload.format,
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt,
    source: payload.source || {},
    counts: {
      appSettings: count('appSettings'),
      nodes: count('nodes'),
      nodeInboundCache: count('nodeInboundCache'),
      redirectRules: count('redirectRules'),
      sniProfiles: count('sniProfiles'),
      vpnHosts: count('vpnHosts'),
      vpnServices: count('vpnServices')
    },
    exclusions: Array.isArray(payload.exclusions) ? payload.exclusions : [],
    encrypted: true
  };
}

function readBundle(input) {
  const target = path.resolve(input);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new TransferError(`Файл не найден: ${target}`);
  if (stat.size > MAX_INPUT_BYTES) throw new TransferError('Файл настроек превышает 100 МБ');
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (err) {
    throw new TransferError(`Некорректный файл настроек: ${err.message || err}`);
  }
}

function writeBundle(bundle, output) {
  const encoded = Buffer.from(`${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
  if (output === '-') {
    process.stdout.write(encoded);
    return;
  }
  const target = path.resolve(output);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, target);
  fs.chmodSync(target, 0o600);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const part = argv[index];
    if (!part.startsWith('--')) {
      args._.push(part);
      continue;
    }
    const key = part.slice(2);
    if (key === 'dry-run') {
      args.dryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (value == null || value.startsWith('--')) throw new TransferError(`Для --${key} не указано значение`);
    args[key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    index += 1;
  }
  return args;
}

function matchNode(db, source) {
  const rows = db.prepare('SELECT * FROM nodes ORDER BY id').all();
  const exact = rows.filter(row => normalizeNodeType(row.node_type) === normalizeNodeType(source.node_type)
    && normalizePanelUrl(row.panel_url) === normalizePanelUrl(source.panel_url)
    && normalizePanelPath(row.panel_path) === normalizePanelPath(source.panel_path)
    && Number(row.inbound_id || 0) === Number(source.inbound_id || 0));
  if (exact.length === 1) return exact[0];
  const byName = rows.filter(row => cleanText(row.name, 500).toLowerCase() === cleanText(source.name, 500).toLowerCase()
    && normalizeNodeType(row.node_type) === normalizeNodeType(source.node_type)
    && Number(row.inbound_id || 0) === Number(source.inbound_id || 0));
  return byName.length === 1 ? byName[0] : null;
}

function encodeImportedRow(row, secretColumns, targetSecret) {
  const result = { ...row };
  for (const column of secretColumns) {
    if (column in result) result[column] = result[column] ? encrypt(String(result[column]), targetSecret) : '';
  }
  return result;
}

function insertDynamic(db, table, row, { omit = [] } = {}) {
  const allowed = new Set(tableColumns(db, table));
  const omitted = new Set(omit);
  const clean = rowObject(row, allowed);
  for (const key of omitted) delete clean[key];
  const keys = Object.keys(clean);
  if (!keys.length) throw new TransferError(`Нет совместимых полей для ${table}`);
  const sql = `INSERT INTO ${quoteIdentifier(table)} (${keys.map(quoteIdentifier).join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const info = db.prepare(sql).run(...keys.map(key => clean[key]));
  return Number(info.lastInsertRowid);
}

function updateDynamic(db, table, id, row, { omit = [] } = {}) {
  const allowed = new Set(tableColumns(db, table));
  const omitted = new Set(['id', 'created_at', ...omit]);
  const clean = rowObject(row, allowed);
  for (const key of omitted) delete clean[key];
  const keys = Object.keys(clean);
  if (!keys.length) return;
  db.prepare(`UPDATE ${quoteIdentifier(table)} SET ${keys.map(key => `${quoteIdentifier(key)} = ?`).join(', ')} WHERE id = ?`)
    .run(...keys.map(key => clean[key]), id);
}

async function backupDatabase(db, dbPath) {
  const backupDirectory = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDirectory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(backupDirectory, `settings-import-before-${stamp}.db`);
  await db.backup(target);
  fs.chmodSync(target, 0o600);
  return target;
}

async function importSettings(db, dbPath, payload, targetSecret, dryRun) {
  requireDatabase(db);
  if (!targetSecret || targetSecret === 'change-me') throw new TransferError('APP_SECRET новой панели не задан');
  const categories = payload.categories || {};
  const result = {
    ok: true,
    dryRun: Boolean(dryRun),
    settingsUpserted: 0,
    nodesCreated: 0,
    nodesUpdated: 0,
    inboundCachesUpserted: 0,
    redirectRulesCreated: 0,
    redirectRulesUpdated: 0,
    sniProfilesCreated: 0,
    sniProfilesUpdated: 0,
    vpnHostsCreated: 0,
    vpnHostsUpdated: 0,
    vpnServicesCreated: 0,
    vpnServicesUpdated: 0,
    warnings: [],
    backupPath: ''
  };
  if (!dryRun) result.backupPath = await backupDatabase(db, dbPath);

  const transaction = db.transaction(() => {
    const settingsColumns = new Set(tableColumns(db, 'app_settings'));
    for (const item of Array.isArray(categories.appSettings) ? categories.appSettings : []) {
      const key = cleanText(item?.key, 300);
      if (!key || SKIPPED_SETTING_KEYS.has(key) || /^stage\d+_/i.test(key)) continue;
      const value = Boolean(item?.sensitive) || SENSITIVE_SETTING_KEYS.has(key)
        ? (item?.value ? `enc:v1:${encrypt(String(item.value), targetSecret)}` : '')
        : String(item?.value ?? '');
      const existing = db.prepare('SELECT key FROM app_settings WHERE key=?').get(key);
      if (existing) {
        if (settingsColumns.has('updated_at')) db.prepare('UPDATE app_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key=?').run(value, key);
        else db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(value, key);
      } else if (settingsColumns.has('updated_at')) {
        db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)").run(key, value);
      } else {
        db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run(key, value);
      }
      result.settingsUpserted += 1;
    }

    const nodeMap = new Map();
    for (const source of Array.isArray(categories.nodes) ? categories.nodes : []) {
      const sourceId = Number(source.id || 0);
      const encoded = encodeImportedRow(source, NODE_SECRET_COLUMNS, targetSecret);
      encoded.last_status = 'unknown';
      encoded.last_error = '';
      const existing = matchNode(db, source);
      let targetId;
      if (existing) {
        targetId = Number(existing.id);
        updateDynamic(db, 'nodes', targetId, encoded);
        result.nodesUpdated += 1;
      } else {
        targetId = insertDynamic(db, 'nodes', encoded, { omit: ['id'] });
        result.nodesCreated += 1;
      }
      if (sourceId) nodeMap.set(sourceId, targetId);
    }

    if (tableExists(db, 'node_inbound_cache')) {
      for (const source of Array.isArray(categories.nodeInboundCache) ? categories.nodeInboundCache : []) {
        const nodeId = nodeMap.get(Number(source.node_id || 0));
        if (!nodeId) {
          if (result.warnings.length < DETAIL_LIMIT) result.warnings.push(`Кэш inbound пропущен: исходный node_id=${source.node_id}`);
          continue;
        }
        const row = { ...source, node_id: nodeId };
        const existing = db.prepare('SELECT node_id FROM node_inbound_cache WHERE node_id=?').get(nodeId);
        if (existing) {
          const allowed = new Set(tableColumns(db, 'node_inbound_cache'));
          const clean = rowObject(row, allowed);
          delete clean.node_id;
          const keys = Object.keys(clean);
          if (keys.length) db.prepare(`UPDATE node_inbound_cache SET ${keys.map(key => `${quoteIdentifier(key)}=?`).join(', ')} WHERE node_id=?`)
            .run(...keys.map(key => clean[key]), nodeId);
        } else {
          insertDynamic(db, 'node_inbound_cache', row);
        }
        result.inboundCachesUpserted += 1;
      }
    }

    if (tableExists(db, 'redirect_rules')) {
      for (const source of Array.isArray(categories.redirectRules) ? categories.redirectRules : []) {
        const nodeId = nodeMap.get(Number(source.node_id || 0));
        if (!nodeId) {
          if (result.warnings.length < DETAIL_LIMIT) result.warnings.push(`Редирект пропущен: исходный node_id=${source.node_id}`);
          continue;
        }
        const row = { ...source, node_id: nodeId, enabled: 0, last_status: 'pending', metrics_json: '' };
        const existing = db.prepare('SELECT id FROM redirect_rules WHERE bind_ip=? AND node_id=? AND target_port=? AND protocol=?')
          .get(String(row.bind_ip || ''), nodeId, Number(row.target_port || 0), String(row.protocol || 'tcp'));
        if (existing) {
          updateDynamic(db, 'redirect_rules', Number(existing.id), row);
          result.redirectRulesUpdated += 1;
        } else {
          insertDynamic(db, 'redirect_rules', row, { omit: ['id'] });
          result.redirectRulesCreated += 1;
        }
      }
    }

    if (tableExists(db, 'sni_profiles')) {
      for (const source of Array.isArray(categories.sniProfiles) ? categories.sniProfiles : []) {
        const existing = db.prepare('SELECT id, is_builtin FROM sni_profiles WHERE sni=?').get(String(source.sni || ''));
        if (existing) {
          updateDynamic(db, 'sni_profiles', Number(existing.id), { ...source, is_builtin: existing.is_builtin }, { omit: ['last_status', 'last_check_json'] });
          result.sniProfilesUpdated += 1;
        } else {
          insertDynamic(db, 'sni_profiles', source, { omit: ['id', 'last_status', 'last_check_json'] });
          result.sniProfilesCreated += 1;
        }
      }
    }

    const hostMap = new Map();
    if (tableExists(db, 'vpn_hosts')) {
      for (const source of Array.isArray(categories.vpnHosts) ? categories.vpnHosts : []) {
        const sourceId = Number(source.id || 0);
        const row = encodeImportedRow({ ...source, enabled: 0, last_status: 'unknown' }, VPN_HOST_SECRET_COLUMNS, targetSecret);
        const existing = db.prepare('SELECT id FROM vpn_hosts WHERE hostname=? AND ssh_port=? AND ssh_username=?')
          .get(String(row.hostname || ''), Number(row.ssh_port || 22), String(row.ssh_username || 'root'));
        let targetId;
        if (existing) {
          targetId = Number(existing.id);
          updateDynamic(db, 'vpn_hosts', targetId, row);
          result.vpnHostsUpdated += 1;
        } else {
          targetId = insertDynamic(db, 'vpn_hosts', row, { omit: ['id'] });
          result.vpnHostsCreated += 1;
        }
        if (sourceId) hostMap.set(sourceId, targetId);
      }
    }

    if (tableExists(db, 'vpn_services')) {
      for (const source of Array.isArray(categories.vpnServices) ? categories.vpnServices : []) {
        const hostId = hostMap.get(Number(source.host_id || 0));
        if (!hostId) {
          if (result.warnings.length < DETAIL_LIMIT) result.warnings.push(`VPN-сервис пропущен: исходный host_id=${source.host_id}`);
          continue;
        }
        const row = encodeImportedRow({ ...source, host_id: hostId, enabled: 0, last_status: 'unknown' }, VPN_SERVICE_SECRET_COLUMNS, targetSecret);
        const existing = db.prepare('SELECT id FROM vpn_services WHERE host_id=? AND protocol=? AND interface_name=?')
          .get(hostId, String(row.protocol || ''), String(row.interface_name || ''));
        if (existing) {
          updateDynamic(db, 'vpn_services', Number(existing.id), row);
          result.vpnServicesUpdated += 1;
        } else {
          insertDynamic(db, 'vpn_services', row, { omit: ['id'] });
          result.vpnServicesCreated += 1;
        }
      }
    }

    const revision = String(Date.now());
    const rev = db.prepare("SELECT key FROM app_settings WHERE key='subscription_revision'").get();
    if (rev) db.prepare("UPDATE app_settings SET value=? WHERE key='subscription_revision'").run(revision);
    else db.prepare("INSERT INTO app_settings (key, value) VALUES ('subscription_revision', ?)").run(revision);

    if (dryRun) throw new TransferError('__ROLLBACK_DRY_RUN__');
  });

  try {
    transaction();
  } catch (err) {
    if (!(dryRun && err instanceof TransferError && err.message === '__ROLLBACK_DRY_RUN__')) throw err;
  }
  result.message = dryRun ? 'Проверка настроек завершена без записи' : 'Настройки импортированы';
  return result;
}

function help() {
  return `Перенос настроек Nexus Panel / 3xui-Aggregator

Парольная фраза передаётся только через переменную ${PASSPHRASE_ENV}.

  settings-transfer.js export  --db app.db --output settings.nxsettings
  settings-transfer.js inspect --input settings.nxsettings
  settings-transfer.js import  --db app.db --input settings.nxsettings [--dry-run]
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || ['help', '-h', '--help'].includes(command)) {
    process.stdout.write(help());
    return;
  }
  const passphrase = getPassphrase();

  if (command === 'export') {
    if (!args.db || !args.output) throw new TransferError('Для export нужны --db и --output');
    const db = new Database(path.resolve(args.db), { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 30000');
    try {
      const payload = exportSettings(db, String(process.env.APP_SECRET || ''));
      const bundle = encryptBundle(payload, passphrase);
      writeBundle(bundle, args.output);
      if (args.output !== '-') process.stdout.write(`${JSON.stringify({ ...summaryFromPayload(payload), output: path.resolve(args.output) }, null, 2)}\n`);
    } finally {
      db.close();
    }
    return;
  }

  if (!args.input) throw new TransferError(`Для ${command} нужен --input`);
  const payload = decryptBundle(readBundle(args.input), passphrase);
  if (command === 'inspect') {
    process.stdout.write(`${JSON.stringify(summaryFromPayload(payload), null, 2)}\n`);
    return;
  }
  if (command !== 'import') throw new TransferError(`Неизвестная команда: ${command}`);
  if (!args.db) throw new TransferError('Для import нужен --db');
  const dbPath = path.resolve(args.db);
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma('busy_timeout = 30000');
  try {
    const result = await importSettings(db, dbPath, payload, String(process.env.APP_SECRET || ''), Boolean(args.dryRun));
    result.inspection = summaryFromPayload(payload);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    db.close();
  }
}

main().catch(err => {
  const message = err instanceof TransferError ? err.message : String(err?.message || err);
  process.stderr.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exitCode = 2;
});
