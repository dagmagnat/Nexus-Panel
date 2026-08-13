'use strict';

// Preview-only data for visual QA. Refuses to run outside data-dev.
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { encrypt } = require('../lib_crypto');

const root = path.resolve(__dirname, '..');
const envText = fs.readFileSync(path.join(root, '.env.development'), 'utf8');
const env = Object.fromEntries(envText.split(/\r?\n/).map(line => line.match(/^([^#=]+)=(.*)$/)).filter(Boolean).map(match => [match[1], match[2]]));
const dbPath = process.env.SPECTRUM_DB_PATH
  ? path.resolve(process.env.SPECTRUM_DB_PATH)
  : path.resolve(root, env.DATA_DIR || './data-dev', 'app.db');
const relativeDbPath = path.relative(root, dbPath);

if (relativeDbPath.startsWith('..') || !/(^|\/)(?:data-dev|\.tmp-spectrum-http-[^/]+)\/app\.db$/.test(relativeDbPath.replace(/\\/g, '/'))) {
  throw new Error('Preview seed is allowed only for data-dev or an isolated Spectrum HTTP-check database.');
}
if (!fs.existsSync(dbPath)) throw new Error('Start the development server once before seeding preview data.');

const db = new Database(dbPath);
const now = Date.now();
const day = 86_400_000;
const secret = env.APP_SECRET;

const seed = db.transaction(() => {
  if (db.prepare('SELECT COUNT(*) AS count FROM nodes').get().count > 0) {
    return { skipped: true };
  }

  const addNode = db.prepare(`
    INSERT INTO nodes (
      name, node_type, panel_url, panel_path, username, password_enc, api_auth_mode,
      api_token_enc, inbound_id, enabled, last_status, last_error, country_code,
      country_name_ru, country_flag, label_suffix, sort_order,
      remnawave_internal_squad_uuid, remnawave_host_uuid
    ) VALUES (
      @name, @node_type, @panel_url, @panel_path, @username, @password_enc, @api_auth_mode,
      @api_token_enc, @inbound_id, @enabled, @last_status, @last_error, @country_code,
      @country_name_ru, @country_flag, @label_suffix, @sort_order,
      @remnawave_internal_squad_uuid, @remnawave_host_uuid
    )
  `);
  const fakePassword = encrypt('preview-only', secret);
  const fakeToken = encrypt('preview-token-only', secret);
  const nodes = [
    { name: 'Германия', node_type: '3xui', panel_url: 'http://127.0.0.1:9', panel_path: '/nexus/', username: 'api', password_enc: fakePassword, api_auth_mode: 'token', api_token_enc: fakeToken, inbound_id: 1, enabled: 1, last_status: 'online', last_error: '', country_code: 'DE', country_name_ru: 'Германия', country_flag: '🇩🇪', label_suffix: 'Frankfurt', sort_order: 1, remnawave_internal_squad_uuid: '', remnawave_host_uuid: '' },
    { name: 'Швеция', node_type: '3xui', panel_url: 'http://127.0.0.1:9', panel_path: '/panel/', username: 'api', password_enc: fakePassword, api_auth_mode: 'token', api_token_enc: fakeToken, inbound_id: 1, enabled: 1, last_status: 'online', last_error: '', country_code: 'SE', country_name_ru: 'Швеция', country_flag: '🇸🇪', label_suffix: 'Без рекламы', sort_order: 2, remnawave_internal_squad_uuid: '', remnawave_host_uuid: '' },
    { name: 'Нидерланды', node_type: '3xui', panel_url: 'http://127.0.0.1:9', panel_path: '/api/', username: 'api', password_enc: fakePassword, api_auth_mode: 'token', api_token_enc: fakeToken, inbound_id: 4, enabled: 0, last_status: 'offline', last_error: 'Тестовый узел отключён', country_code: 'NL', country_name_ru: 'Нидерланды', country_flag: '🇳🇱', label_suffix: '', sort_order: 3, remnawave_internal_squad_uuid: '', remnawave_host_uuid: '' },
    { name: 'Финляндия', node_type: 'remnawave', panel_url: 'http://127.0.0.1:9', panel_path: '', username: 'api', password_enc: fakePassword, api_auth_mode: 'token', api_token_enc: fakeToken, inbound_id: 1, enabled: 1, last_status: 'unknown', last_error: '', country_code: 'FI', country_name_ru: 'Финляндия', country_flag: '🇫🇮', label_suffix: 'Remnawave', sort_order: 4, remnawave_internal_squad_uuid: 'preview-squad', remnawave_host_uuid: 'preview-host' }
  ].map(node => ({ ...node, id: Number(addNode.run(node).lastInsertRowid) }));

  const addCache = db.prepare('INSERT INTO node_inbound_cache (node_id, inbound_id, inbound_json) VALUES (?, ?, ?)');
  nodes.filter(node => node.node_type === '3xui').forEach((node, index) => {
    const inbound = {
      id: node.inbound_id,
      remark: index === 0 ? 'Nexus xHTTP' : (index === 1 ? 'Reality main' : 'Backup xHTTP'),
      protocol: 'vless',
      port: index === 1 ? 443 : 2053,
      up: (index + 2) * 1_200_000_000,
      down: (index + 4) * 3_900_000_000,
      settings: JSON.stringify({ clients: [] }),
      streamSettings: JSON.stringify(index === 1
        ? { network: 'tcp', security: 'reality', realitySettings: { serverNames: ['www.cloudflare.com'], settings: { fingerprint: 'chrome' } } }
        : { network: 'xhttp', security: 'none', xhttpSettings: { mode: 'packet-up', path: '/content/media/stream/', host: '' } })
    };
    addCache.run(node.id, node.inbound_id, JSON.stringify(inbound));
  });

  const addClient = db.prepare(`
    INSERT INTO clients (login, display_name, uuid, sub_slug, duration_days, traffic_gb, limit_ip, expiry_time, enabled, comment, last_online_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const addLink = db.prepare(`
    INSERT INTO client_nodes (client_id, node_id, remote_email, remote_uuid, traffic_gb, limit_ip, upload_bytes, download_bytes, used_bytes, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const clients = [];
  for (let index = 1; index <= 14; index += 1) {
    const idText = String(index).padStart(2, '0');
    const uuid = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const disabled = index === 12;
    const expiry = index === 13 ? now - 2 * day : now + (index === 11 ? 3 : 14 + index * 4) * day;
    const clientId = Number(addClient.run(
      `nexus${idText}`,
      index % 3 === 0 ? `Пользователь ${idText}` : `Nexus ${idText}`,
      uuid,
      `spectrum-preview-${idText}`,
      30,
      index % 4 === 0 ? 0 : 100,
      index % 5 === 0 ? 3 : 1,
      expiry,
      disabled ? 0 : 1,
      index % 2 ? 'Основная подписка' : 'Тест мобильной карточки',
      index < 7 ? new Date(now - index * 120_000).toISOString() : ''
    ).lastInsertRowid);
    clients.push(clientId);
    nodes.slice(0, index % 4 === 0 ? 4 : 3).forEach((node, nodeIndex) => {
      const used = (index * 900_000_000) + (nodeIndex * 300_000_000);
      addLink.run(clientId, node.id, `nexus${idText}`, uuid, index % 4 === 0 ? 0 : 100, null, Math.round(used * .32), Math.round(used * .68), used, node.enabled);
    });
  }

  const addSnapshot = db.prepare('INSERT INTO traffic_snapshots (upload_bytes, download_bytes, used_bytes, created_at_ms, source_kind) VALUES (?, ?, ?, ?, ?)');
  for (let daysAgo = 29; daysAgo >= 0; daysAgo -= 1) {
    const factor = 30 - daysAgo;
    const upload = (2_000_000_000 + factor * 150_000_000);
    const download = (5_000_000_000 + factor * 430_000_000);
    addSnapshot.run(upload, download, upload + download, now - daysAgo * day, 'preview');
  }
  return { skipped: false, nodes: nodes.length, clients: clients.length };
});

const result = seed();
if (require.main === module) console.log(JSON.stringify({ ok: true, database: dbPath, ...result }, null, 2));
db.close();
