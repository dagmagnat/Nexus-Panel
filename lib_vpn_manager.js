'use strict';

const { Client: SshClient } = require('ssh2');
const crypto = require('crypto');
const https = require('https');
const net = require('net');
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const { URL } = require('url');

const PROTOCOLS = new Set(['wireguard', 'amneziawg_legacy', 'amneziawg2', 'outline']);
const PROTOCOL_LABELS = {
  wireguard: 'WireGuard',
  amneziawg_legacy: 'AmneziaWG Legacy',
  amneziawg2: 'AmneziaWG 2.0',
  outline: 'Outline'
};

function nowIso() {
  return new Date().toISOString();
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanText(value, max = 255) {
  return String(value ?? '').trim().slice(0, max);
}

function validHostname(value) {
  const text = cleanText(value, 253);
  if (!text || /[\s/\\]/.test(text)) return false;
  if (net.isIP(text)) return true;
  return /^(?=.{1,253}$)(?!-)[a-z0-9-]+(?:\.(?!-)[a-z0-9-]+)*\.?$/i.test(text);
}

function validInterfaceName(value) {
  return /^[a-zA-Z0-9_=+.-]{1,15}$/.test(String(value || ''));
}

function ipv4ToInt(ip) {
  const parts = String(ip || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isInteger(v) || v < 0 || v > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function intToIpv4(value) {
  const n = Number(value) >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

function parseIpv4Cidr(value) {
  const match = String(value || '').trim().match(/^(\d+\.\d+\.\d+\.\d+)\/(\d{1,2})$/);
  if (!match) return null;
  const ipInt = ipv4ToInt(match[1]);
  const prefix = Number(match[2]);
  if (ipInt === null || prefix < 8 || prefix > 30) return null;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const network = (ipInt & mask) >>> 0;
  const size = 2 ** (32 - prefix);
  return { cidr: `${intToIpv4(network)}/${prefix}`, network, prefix, size };
}

function shQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function base64(value) {
  return Buffer.from(String(value ?? ''), 'utf8').toString('base64');
}

function randomInt(min, max) {
  return crypto.randomInt(min, max + 1);
}

function buildAwgParams(protocol) {
  const s1 = randomInt(20, 100);
  let s2 = randomInt(20, 100);
  while (s2 === s1 + 56) s2 = randomInt(20, 100);

  if (protocol === 'amneziawg_legacy') {
    const headers = new Set();
    while (headers.size < 4) headers.add(randomInt(1000000, 2147483000));
    const [h1, h2, h3, h4] = [...headers];
    return {
      preset: 'legacy_compatible',
      Jc: randomInt(4, 8),
      Jmin: randomInt(8, 20),
      Jmax: randomInt(50, 90),
      S1: s1,
      S2: s2,
      H1: String(h1), H2: String(h2), H3: String(h3), H4: String(h4)
    };
  }

  // AWG 2.0 profile with non-overlapping ranged headers. S3/S4 remain zero
  // for broader compatibility with current mobile/router importers.
  const ranges = [];
  let cursor = randomInt(1000000, 50000000);
  for (let i = 0; i < 4; i += 1) {
    const width = randomInt(500000, 2500000);
    ranges.push(`${cursor}-${cursor + width}`);
    cursor += width + randomInt(500000, 3000000);
  }
  return {
    preset: 'awg2_mobile_compatible',
    Jc: randomInt(4, 8),
    Jmin: randomInt(8, 20),
    Jmax: randomInt(50, 90),
    S1: s1,
    S2: s2,
    S3: 0,
    S4: 0,
    H1: ranges[0], H2: ranges[1], H3: ranges[2], H4: ranges[3],
    I1: '', I2: '', I3: '', I4: '', I5: ''
  };
}

function awgInterfaceLines(params = {}) {
  const keys = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4', 'H1', 'H2', 'H3', 'H4', 'I1', 'I2', 'I3', 'I4', 'I5'];
  return keys
    .filter(key => params[key] !== undefined && params[key] !== null && String(params[key]) !== '')
    .map(key => `${key} = ${params[key]}`)
    .join('\n');
}

function parseMarker(output) {
  const lines = String(output || '').split(/\r?\n/).reverse();
  const line = lines.find(item => item.startsWith('AGG_JSON:'));
  if (!line) return null;
  try {
    return JSON.parse(Buffer.from(line.slice('AGG_JSON:'.length), 'base64').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function initVpnDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vpn_hosts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      placement TEXT NOT NULL DEFAULT 'remote',
      hostname TEXT NOT NULL,
      public_host TEXT DEFAULT '',
      ssh_port INTEGER NOT NULL DEFAULT 22,
      ssh_username TEXT NOT NULL DEFAULT 'root',
      auth_type TEXT NOT NULL DEFAULT 'password',
      password_enc TEXT DEFAULT '',
      private_key_enc TEXT DEFAULT '',
      private_key_passphrase_enc TEXT DEFAULT '',
      sudo_password_enc TEXT DEFAULT '',
      host_key_fingerprint TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT DEFAULT '',
      os_info TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vpn_services (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER NOT NULL,
      protocol TEXT NOT NULL,
      name TEXT NOT NULL,
      interface_name TEXT DEFAULT '',
      listen_port INTEGER NOT NULL DEFAULT 0,
      subnet_cidr TEXT DEFAULT '',
      endpoint_host TEXT DEFAULT '',
      dns_servers TEXT DEFAULT '1.1.1.1, 1.0.0.1',
      client_mtu INTEGER NOT NULL DEFAULT 0,
      server_public_key TEXT DEFAULT '',
      server_private_key_enc TEXT DEFAULT '',
      api_url_enc TEXT DEFAULT '',
      api_cert_sha256 TEXT DEFAULT '',
      config_json TEXT DEFAULT '{}',
      backup_enc TEXT DEFAULT '',
      install_status TEXT NOT NULL DEFAULT 'new',
      last_status TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT DEFAULT '',
      domain_status TEXT NOT NULL DEFAULT 'unchecked',
      domain_resolved_ips TEXT DEFAULT '',
      domain_error TEXT DEFAULT '',
      domain_checked_at TEXT DEFAULT '',
      legacy_ports_json TEXT DEFAULT '[]',
      migrated_at TEXT DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(host_id, protocol, interface_name)
    );

    CREATE TABLE IF NOT EXISTS vpn_clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service_id INTEGER NOT NULL,
      aggregator_client_id INTEGER DEFAULT NULL,
      name TEXT NOT NULL,
      remote_id TEXT DEFAULT '',
      address TEXT DEFAULT '',
      public_key TEXT DEFAULT '',
      private_key_enc TEXT DEFAULT '',
      preshared_key_enc TEXT DEFAULT '',
      config_enc TEXT DEFAULT '',
      access_url_enc TEXT DEFAULT '',
      peer_json TEXT DEFAULT '{}',
      expires_at INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      disabled_reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vpn_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id INTEGER DEFAULT NULL,
      service_id INTEGER DEFAULT NULL,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      progress INTEGER NOT NULL DEFAULT 0,
      message TEXT DEFAULT '',
      log_text TEXT DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT DEFAULT '',
      finished_at TEXT DEFAULT ''
    );
  `);
  try { db.exec("ALTER TABLE vpn_clients ADD COLUMN disabled_reason TEXT NOT NULL DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_hosts ADD COLUMN public_host TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN client_mtu INTEGER NOT NULL DEFAULT 0"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN domain_status TEXT NOT NULL DEFAULT 'unchecked'"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN domain_resolved_ips TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN domain_error TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN domain_checked_at TEXT DEFAULT ''"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN legacy_ports_json TEXT DEFAULT '[]'"); } catch (_) {}
  try { db.exec("ALTER TABLE vpn_services ADD COLUMN migrated_at TEXT DEFAULT ''"); } catch (_) {}
}

function createVpnManager({ db, appSecret, encrypt, decrypt, dataDir = path.join(__dirname, 'data') }) {
  initVpnDb(db);

  function encryptValue(value) {
    return value ? encrypt(String(value), appSecret) : '';
  }

  function decryptValue(value) {
    if (!value) return '';
    return decrypt(String(value), appSecret);
  }

  function getHost(id) {
    return db.prepare('SELECT * FROM vpn_hosts WHERE id = ?').get(Number(id));
  }

  function getService(id) {
    return db.prepare(`
      SELECT s.*, h.name AS host_name, h.hostname, h.public_host, h.ssh_port, h.placement,
             h.last_status AS host_status
      FROM vpn_services s
      JOIN vpn_hosts h ON h.id = s.host_id
      WHERE s.id = ?
    `).get(Number(id));
  }

  function getClient(id) {
    return db.prepare(`
      SELECT c.*, s.protocol, s.name AS service_name, s.endpoint_host, s.listen_port,
             s.server_public_key, s.config_json, s.dns_servers, s.client_mtu, s.interface_name,
             h.hostname, h.public_host
      FROM vpn_clients c
      JOIN vpn_services s ON s.id = c.service_id
      JOIN vpn_hosts h ON h.id = s.host_id
      WHERE c.id = ?
    `).get(Number(id));
  }

  function hostConnectionConfig(host, { trustNewHost = false } = {}) {
    const expectedFingerprint = cleanText(host.host_key_fingerprint, 256);
    const authType = host.auth_type === 'key' ? 'key' : 'password';
    let seenFingerprint = '';
    const config = {
      host: host.hostname,
      port: Number(host.ssh_port || 22),
      username: host.ssh_username,
      readyTimeout: 20000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      hostHash: 'sha256',
      hostVerifier: fingerprint => {
        seenFingerprint = String(fingerprint || '');
        if (trustNewHost || !expectedFingerprint) return true;
        const actual = Buffer.from(seenFingerprint, 'utf8');
        const expected = Buffer.from(expectedFingerprint, 'utf8');
        return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
      }
    };
    if (authType === 'key') {
      config.privateKey = decryptValue(host.private_key_enc);
      const passphrase = decryptValue(host.private_key_passphrase_enc);
      if (passphrase) config.passphrase = passphrase;
    } else {
      config.password = decryptValue(host.password_enc);
    }
    return { config, getFingerprint: () => seenFingerprint };
  }

  function sshExec(host, command, { timeoutMs = 15 * 60 * 1000, trustNewHost = false } = {}) {
    return new Promise((resolve, reject) => {
      const conn = new SshClient();
      const { config, getFingerprint } = hostConnectionConfig(host, { trustNewHost });
      let timer;
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { conn.end(); } catch (_) {}
        if (err) reject(err); else resolve({ ...result, fingerprint: getFingerprint() });
      };
      timer = setTimeout(() => finish(new Error(`SSH timeout after ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
      conn.on('ready', () => {
        conn.exec(command, { pty: false }, (err, stream) => {
          if (err) return finish(err);
          let stdout = '';
          let stderr = '';
          stream.on('data', chunk => { stdout += chunk.toString('utf8'); });
          stream.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
          stream.on('close', code => {
            if (Number(code) !== 0) {
              const message = cleanText(stderr || stdout || `Remote command failed with code ${code}`, 5000);
              return finish(new Error(message));
            }
            return finish(null, { stdout, stderr, code: Number(code || 0) });
          });
        });
      });
      conn.on('error', err => finish(err));
      conn.connect(config);
    });
  }

  function privilegedCommand(host, script) {
    const script64 = base64(script);
    const sudoPassword = decryptValue(host.sudo_password_enc) || decryptValue(host.password_enc);
    const password64 = base64(sudoPassword);
    return [
      'set -e',
      'tmp="$(mktemp /tmp/agg-vpn.XXXXXX)"',
      `printf %s ${shQuote(script64)} | base64 -d > "$tmp"`,
      'chmod 700 "$tmp"',
      'set +e',
      'if [ "$(id -u)" = "0" ]; then',
      '  bash "$tmp"',
      '  rc=$?',
      'elif true_bin=/usr/bin/true; [ -x "$true_bin" ] || true_bin=/bin/true; sudo -n "$true_bin" >/dev/null 2>&1; then',
      '  sudo -n bash "$tmp"',
      '  rc=$?',
      `elif [ -n ${shQuote(password64)} ]; then`,
      `  printf %s ${shQuote(password64)} | base64 -d | sudo -S -p '' bash "$tmp"`,
      '  rc=$?',
      'else',
      '  echo "Root or passwordless sudo access is required" >&2',
      '  rc=77',
      'fi',
      'rm -f "$tmp"',
      'exit $rc'
    ].join('\n');
  }

  async function testHost(id, { trustNewHost = false } = {}) {
    const host = getHost(id);
    if (!host) throw new Error('VPS not found');
    const command = [
      'set -e',
      'printf "USER=%s\\n" "$(id -un)"',
      'printf "UID=%s\\n" "$(id -u)"',
      'printf "HOST=%s\\n" "$(hostname)"',
      'printf "KERNEL=%s\\n" "$(uname -srmo)"',
      'if [ -r /etc/os-release ]; then . /etc/os-release; printf "OS=%s %s\\n" "$NAME" "$VERSION_ID"; fi',
      'if command -v sudo >/dev/null 2>&1; then printf "SUDO=yes\\n"; else printf "SUDO=no\\n"; fi',
      'if command -v docker >/dev/null 2>&1; then printf "DOCKER=yes\\n"; else printf "DOCKER=no\\n"; fi'
    ].join('\n');
    try {
      const result = await sshExec(host, command, { timeoutMs: 30000, trustNewHost });
      db.prepare(`
        UPDATE vpn_hosts SET last_status = 'online', last_error = '', os_info = ?,
          host_key_fingerprint = CASE WHEN host_key_fingerprint = '' THEN ? ELSE host_key_fingerprint END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(cleanText(result.stdout, 5000), cleanText(result.fingerprint, 256), host.id);
      return result;
    } catch (err) {
      db.prepare(`UPDATE vpn_hosts SET last_status = 'offline', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(cleanText(err.message || err, 3000), host.id);
      throw err;
    }
  }

  function packageInstallBlock(protocol) {
    if (protocol === 'wireguard') {
      return `
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y wireguard wireguard-tools iptables
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y wireguard-tools iptables
elif command -v yum >/dev/null 2>&1; then
  yum install -y epel-release || true
  yum install -y wireguard-tools iptables
else
  echo "Unsupported package manager" >&2
  exit 21
fi`;
    }
    return `
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y software-properties-common python3-launchpadlib gnupg2 "linux-headers-$(uname -r)" iptables curl ca-certificates
  . /etc/os-release
  if [ "\${ID:-}" = "ubuntu" ] || echo " \${ID_LIKE:-} " | grep -qi ' ubuntu '; then
    add-apt-repository -y ppa:amnezia/ppa
  elif [ "\${ID:-}" = "debian" ] || echo " \${ID_LIKE:-} " | grep -qi ' debian '; then
    apt-key adv --keyserver keyserver.ubuntu.com --recv-keys 57290828
    touch /etc/apt/sources.list
    grep -q '^deb https://ppa.launchpadcontent.net/amnezia/ppa/ubuntu focal main$' /etc/apt/sources.list || echo 'deb https://ppa.launchpadcontent.net/amnezia/ppa/ubuntu focal main' >> /etc/apt/sources.list
    grep -q '^deb-src https://ppa.launchpadcontent.net/amnezia/ppa/ubuntu focal main$' /etc/apt/sources.list || echo 'deb-src https://ppa.launchpadcontent.net/amnezia/ppa/ubuntu focal main' >> /etc/apt/sources.list
  else
    echo "Unsupported APT-based distribution for automatic AmneziaWG installation: \${ID:-unknown}" >&2
    exit 22
  fi
  apt-get update
  apt-get install -y amneziawg
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y 'dnf-command(copr)' || true
  dnf copr enable -y amneziavpn/amneziawg
  dnf install -y amneziawg-dkms amneziawg-tools iptables
else
  echo "Automatic AmneziaWG installation supports Ubuntu, Debian and Fedora/RHEL family" >&2
  exit 22
fi`;
  }

  function buildTunnelInstallScript(service, host) {
    const cidr = parseIpv4Cidr(service.subnet_cidr);
    if (!cidr) throw new Error('Invalid IPv4 subnet');
    const iface = service.interface_name;
    if (!validInterfaceName(iface)) throw new Error('Invalid interface name');
    const port = clampInt(service.listen_port, 1, 65535, 51820);
    const serverAddress = intToIpv4(cidr.network + 1);
    const command = service.protocol === 'wireguard' ? 'wg' : 'awg';
    const quick = service.protocol === 'wireguard' ? 'wg-quick' : 'awg-quick';
    const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
    let params = {};
    try { params = JSON.parse(service.config_json || '{}'); } catch (_) {}
    const awgLines = service.protocol === 'wireguard' ? '' : awgInterfaceLines(params);
    const installBlock = packageInstallBlock(service.protocol);
    return `#!/usr/bin/env bash
set -euo pipefail
${installBlock}
command -v ${command} >/dev/null 2>&1 || { echo "${command} utility not found after installation" >&2; exit 23; }
command -v ${quick} >/dev/null 2>&1 || { echo "${quick} utility not found after installation" >&2; exit 24; }
mkdir -p ${shQuote(configDir)}
umask 077
KEY_FILE=${shQuote(`${configDir}/${iface}.server.key`)}
CONF_FILE=${shQuote(`${configDir}/${iface}.conf`)}
if [ ! -s "$KEY_FILE" ]; then ${command} genkey > "$KEY_FILE"; fi
PRIVATE_KEY="$(cat "$KEY_FILE")"
PUBLIC_KEY="$(printf %s "$PRIVATE_KEY" | ${command} pubkey)"
OUT_IF="$(ip -4 route list default | awk '{print $5; exit}')"
[ -n "$OUT_IF" ] || { echo 'Default network interface not found' >&2; exit 25; }
cat > "$CONF_FILE" <<'AGGCONF'
[Interface]
Address = ${serverAddress}/${cidr.prefix}
ListenPort = ${port}
PrivateKey = __PRIVATE_KEY__
SaveConfig = false
${awgLines}
PostUp = iptables -A FORWARD -i ${iface} -j ACCEPT; iptables -A FORWARD -o ${iface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s ${cidr.cidr} -o __OUT_IF__ -j MASQUERADE
PostDown = iptables -D FORWARD -i ${iface} -j ACCEPT; iptables -D FORWARD -o ${iface} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s ${cidr.cidr} -o __OUT_IF__ -j MASQUERADE
AGGCONF
sed -i "s|__PRIVATE_KEY__|$PRIVATE_KEY|; s|__OUT_IF__|$OUT_IF|g" "$CONF_FILE"
chmod 600 "$CONF_FILE" "$KEY_FILE"
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/99-3xui-aggregator-vpn.conf
sysctl --system >/dev/null
systemctl enable ${quick}@${iface}
systemctl restart ${quick}@${iface}
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then ufw allow ${port}/udp >/dev/null || true; fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port=${port}/udp >/dev/null || true; firewall-cmd --reload >/dev/null || true; fi
BACKUP="$(base64 -w0 "$CONF_FILE" 2>/dev/null || base64 "$CONF_FILE" | tr -d '\\n')"
JSON="$(printf '{\"publicKey\":\"%s\",\"privateKey\":\"%s\",\"serverAddress\":\"%s\",\"interface\":\"%s\",\"listenPort\":%s,\"backup\":\"%s\"}' "$PUBLIC_KEY" "$PRIVATE_KEY" "${serverAddress}" "${iface}" "${port}" "$BACKUP")"
printf 'AGG_JSON:%s\n' "$(printf %s "$JSON" | base64 -w0 2>/dev/null || printf %s "$JSON" | base64 | tr -d '\\n')"
`;
  }

  function buildOutlineInstallScript(service, host) {
    const endpoint = cleanText(service.endpoint_host || host.hostname, 253);
    if (!validHostname(endpoint)) throw new Error('Invalid Outline endpoint hostname');
    const keysPort = clampInt(service.listen_port, 1, 65535, 443);
    return `#!/usr/bin/env bash
set -euo pipefail
if ! command -v curl >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y curl ca-certificates;
  elif command -v dnf >/dev/null 2>&1; then dnf install -y curl ca-certificates;
  else echo 'curl is required' >&2; exit 31; fi
fi
INSTALLER=/tmp/outline-install-server.sh
curl -fsSL https://raw.githubusercontent.com/OutlineFoundation/outline-apps/master/server_manager/install_scripts/install_server.sh -o "$INSTALLER"
chmod 700 "$INSTALLER"
OUTPUT="$(bash "$INSTALLER" --hostname ${shQuote(endpoint)} --keys-port ${keysPort} 2>&1)" || { printf '%s\n' "$OUTPUT" >&2; exit 32; }
printf '%s\n' "$OUTPUT"
ACCESS_FILE=/opt/outline/access.txt
[ -s "$ACCESS_FILE" ] || { echo '/opt/outline/access.txt was not created' >&2; exit 33; }
API_URL="$(sed -n 's/^apiUrl:[[:space:]]*//p' "$ACCESS_FILE" | head -n1)"
CERT="$(sed -n 's/^certSha256:[[:space:]]*//p' "$ACCESS_FILE" | head -n1)"
[ -n "$API_URL" ] && [ -n "$CERT" ] || { echo 'Outline access data is incomplete' >&2; exit 34; }
BACKUP="$(tar -C /opt -czf - outline 2>/dev/null | base64 -w0 2>/dev/null || true)"
JSON="$(printf '{\"apiUrl\":\"%s\",\"certSha256\":\"%s\",\"backup\":\"%s\"}' "$API_URL" "$CERT" "$BACKUP")"
printf 'AGG_JSON:%s\n' "$(printf %s "$JSON" | base64 -w0 2>/dev/null || printf %s "$JSON" | base64 | tr -d '\\n')"
`;
  }

  async function installService(id) {
    const service = getService(id);
    if (!service) throw new Error('Service not found');
    const clientCount = Number(db.prepare('SELECT COUNT(*) AS count FROM vpn_clients WHERE service_id = ?').get(service.id)?.count || 0);
    if (service.install_status === 'installed' && clientCount > 0) {
      throw new Error('Переустановка заблокирована: сначала удалите клиентов сервиса, чтобы не потерять активные конфигурации');
    }
    const host = getHost(service.host_id);
    if (!host) throw new Error('VPS not found');
    db.prepare(`UPDATE vpn_services SET install_status = 'installing', last_status = 'checking', last_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(service.id);
    try {
      await testHost(host.id, { trustNewHost: !host.host_key_fingerprint });
      const freshHost = getHost(host.id);
      const script = service.protocol === 'outline'
        ? buildOutlineInstallScript(service, freshHost)
        : buildTunnelInstallScript(service, freshHost);
      const result = await sshExec(freshHost, privilegedCommand(freshHost, script), { timeoutMs: 20 * 60 * 1000 });
      const data = parseMarker(result.stdout);
      if (!data) throw new Error('Installer completed without a valid result marker');
      if (service.protocol === 'outline') {
        db.prepare(`
          UPDATE vpn_services SET api_url_enc = ?, api_cert_sha256 = ?, backup_enc = ?,
            install_status = 'installed', last_status = 'online', last_error = '', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(encryptValue(data.apiUrl), cleanText(data.certSha256, 256), encryptValue(data.backup || ''), service.id);
      } else {
        db.prepare(`
          UPDATE vpn_services SET server_public_key = ?, server_private_key_enc = ?, backup_enc = ?,
            install_status = 'installed', last_status = 'online', last_error = '', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(cleanText(data.publicKey, 256), encryptValue(data.privateKey), encryptValue(data.backup || ''), service.id);
      }
      return data;
    } catch (err) {
      db.prepare(`UPDATE vpn_services SET install_status = 'error', last_status = 'offline', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(cleanText(err.message || err, 5000), service.id);
      throw err;
    }
  }

  async function checkService(id) {
    const service = getService(id);
    if (!service) throw new Error('Service not found');
    const host = getHost(service.host_id);
    try {
      let result;
      if (service.protocol === 'outline') {
        result = await outlineRequest(service, 'GET', '/server');
      } else {
        const command = service.protocol === 'wireguard' ? 'wg' : 'awg';
        result = await sshExec(host, `set -e; systemctl is-active ${service.protocol === 'wireguard' ? 'wg-quick' : 'awg-quick'}@${shQuote(service.interface_name)}; ${command} show ${shQuote(service.interface_name)}`,
          { timeoutMs: 30000 });
      }
      db.prepare(`UPDATE vpn_services SET last_status = 'online', last_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(service.id);
      return result;
    } catch (err) {
      db.prepare(`UPDATE vpn_services SET last_status = 'offline', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(cleanText(err.message || err, 3000), service.id);
      throw err;
    }
  }

  function outlineRequest(service, method, suffix, body = null) {
    return new Promise((resolve, reject) => {
      const apiUrl = decryptValue(service.api_url_enc);
      if (!apiUrl) return reject(new Error('Outline API URL is missing'));
      let target;
      try { target = new URL(String(suffix || '').replace(/^\//, ''), apiUrl.replace(/\/?$/, '/')); }
      catch (_) { return reject(new Error('Invalid Outline API URL')); }
      const expected = String(service.api_cert_sha256 || '').replace(/:/g, '').toLowerCase();
      const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const req = https.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method,
        rejectUnauthorized: false,
        timeout: 20000,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
      }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk.toString('utf8'); });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error(`Outline API ${res.statusCode}: ${cleanText(text, 2000)}`));
          if (!text.trim()) return resolve({ statusCode: res.statusCode });
          try { return resolve(JSON.parse(text)); } catch (_) { return resolve({ statusCode: res.statusCode, text }); }
        });
      });
      req.on('socket', socket => {
        socket.on('secureConnect', () => {
          const cert = socket.getPeerCertificate(true);
          const actual = String(cert?.fingerprint256 || '').replace(/:/g, '').toLowerCase();
          if (expected && actual !== expected) req.destroy(new Error('Outline TLS certificate fingerprint mismatch'));
        });
      });
      req.on('timeout', () => req.destroy(new Error('Outline API timeout')));
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async function refreshServiceBackup(serviceId) {
    const service = getService(serviceId);
    if (!service || service.install_status !== 'installed') return;
    const host = getHost(service.host_id);
    if (!host) return;
    let script;
    if (service.protocol === 'outline') {
      script = `#!/usr/bin/env bash
set -euo pipefail
ARCHIVE="$(tar -C /opt -czf - outline 2>/dev/null | base64 -w0 2>/dev/null || true)"
printf 'AGG_JSON:%s\n' "$(printf '{\"backup\":\"%s\"}' "$ARCHIVE" | base64 -w0 2>/dev/null || printf '{\"backup\":\"%s\"}' "$ARCHIVE" | base64 | tr -d '\\n')"
`;
    } else {
      const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
      script = `#!/usr/bin/env bash
set -euo pipefail
CONF=${shQuote(`${configDir}/${service.interface_name}.conf`)}
[ -s "$CONF" ] || { echo 'Service configuration not found' >&2; exit 41; }
ARCHIVE="$(base64 -w0 "$CONF" 2>/dev/null || base64 "$CONF" | tr -d '\\n')"
printf 'AGG_JSON:%s\n' "$(printf '{\"backup\":\"%s\"}' "$ARCHIVE" | base64 -w0 2>/dev/null || printf '{\"backup\":\"%s\"}' "$ARCHIVE" | base64 | tr -d '\\n')"
`;
    }
    const result = await sshExec(host, privilegedCommand(host, script), { timeoutMs: 120000 });
    const data = parseMarker(result.stdout);
    if (!data || typeof data.backup !== 'string') throw new Error('Could not create the aggregator backup copy');
    db.prepare('UPDATE vpn_services SET backup_enc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(encryptValue(data.backup), service.id);
  }

  async function safeRefreshServiceBackup(serviceId) {
    try { await refreshServiceBackup(serviceId); }
    catch (err) {
      db.prepare('UPDATE vpn_services SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run(cleanText(`Backup warning: ${err.message || err}`, 3000), Number(serviceId));
    }
  }

  function allocateClientAddress(serviceId, subnetCidr) {
    const cidr = parseIpv4Cidr(subnetCidr);
    if (!cidr) throw new Error('Invalid service subnet');
    const used = new Set(db.prepare('SELECT address FROM vpn_clients WHERE service_id = ?').all(serviceId)
      .map(row => ipv4ToInt(String(row.address || '').split('/')[0])).filter(v => v !== null));
    for (let offset = 2; offset < cidr.size - 1; offset += 1) {
      const candidate = (cidr.network + offset) >>> 0;
      if (!used.has(candidate)) return `${intToIpv4(candidate)}/32`;
    }
    throw new Error('No free addresses in the service subnet');
  }

  function clientDurationToExpiry(daysRaw) {
    const days = clampInt(daysRaw, 0, 3650, 30);
    return days === 0 ? 0 : Date.now() + days * 86400000;
  }

  function buildTunnelClientConfig(service, host, client) {
    let params = {};
    try { params = JSON.parse(service.config_json || '{}'); } catch (_) {}
    const extra = service.protocol === 'wireguard' ? '' : `${awgInterfaceLines(params)}\n`;
    const endpoint = service.endpoint_host || host.public_host || host.hostname;
    const mtuLine = Number(service.client_mtu || 0) > 0 ? `MTU = ${Number(service.client_mtu)}\n` : '';
    const privateKey = client.privateKey || decryptValue(client.private_key_enc);
    const psk = client.presharedKey || decryptValue(client.preshared_key_enc);
    return `[Interface]\nAddress = ${client.address}\nDNS = ${service.dns_servers || '1.1.1.1'}\n${mtuLine}PrivateKey = ${privateKey}\n${extra}\n[Peer]\nPublicKey = ${service.server_public_key}\nPresharedKey = ${psk}\nAllowedIPs = 0.0.0.0/0\nEndpoint = ${endpoint}:${service.listen_port}\nPersistentKeepalive = 25\n`;
  }

  function regenerateTunnelClientConfigs(serviceId) {
    const service = getService(serviceId);
    if (!service || service.protocol === 'outline') return 0;
    const host = getHost(service.host_id);
    const rows = db.prepare('SELECT * FROM vpn_clients WHERE service_id = ? ORDER BY id').all(service.id);
    const update = db.prepare('UPDATE vpn_clients SET config_enc = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    const tx = db.transaction(items => {
      for (const client of items) update.run(encryptValue(buildTunnelClientConfig(service, host, client)), client.id);
    });
    tx(rows);
    return rows.length;
  }

  async function createTunnelClient(service, name, durationDays, aggregatorClientId = null) {
    const host = getHost(service.host_id);
    const command = service.protocol === 'wireguard' ? 'wg' : 'awg';
    const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
    const address = allocateClientAddress(service.id, service.subnet_cidr);
    const token = crypto.randomUUID();
    const clientName = cleanText(name, 120);
    const script = `#!/usr/bin/env bash
set -euo pipefail
umask 077
PRIVATE="$(${command} genkey)"
PUBLIC="$(printf %s "$PRIVATE" | ${command} pubkey)"
PSK="$(${command} genpsk)"
PSK_FILE="$(mktemp)"
printf %s "$PSK" > "$PSK_FILE"
${command} set ${shQuote(service.interface_name)} peer "$PUBLIC" preshared-key "$PSK_FILE" allowed-ips ${shQuote(address)}
rm -f "$PSK_FILE"
CONF=${shQuote(`${configDir}/${service.interface_name}.conf`)}
cat >> "$CONF" <<'PEERBLOCK'

# AGG-PEER:${token}
[Peer]
PublicKey = __PUBLIC__
PresharedKey = __PSK__
AllowedIPs = ${address}
# END-AGG-PEER:${token}
PEERBLOCK
sed -i "s|__PUBLIC__|$PUBLIC|; s|__PSK__|$PSK|" "$CONF"
JSON="$(printf '{\"privateKey\":\"%s\",\"publicKey\":\"%s\",\"presharedKey\":\"%s\"}' "$PRIVATE" "$PUBLIC" "$PSK")"
printf 'AGG_JSON:%s\n' "$(printf %s "$JSON" | base64 -w0 2>/dev/null || printf %s "$JSON" | base64 | tr -d '\\n')"
`;
    const result = await sshExec(host, privilegedCommand(host, script), { timeoutMs: 60000 });
    const keys = parseMarker(result.stdout);
    if (!keys) throw new Error('Could not generate client keys');
    let params = {};
    try { params = JSON.parse(service.config_json || '{}'); } catch (_) {}
    const extra = service.protocol === 'wireguard' ? '' : `${awgInterfaceLines(params)}\n`;
    const endpoint = service.endpoint_host || host.public_host || host.hostname;
    const mtuLine = Number(service.client_mtu || 0) > 0 ? `MTU = ${Number(service.client_mtu)}\n` : '';
    const config = `[Interface]\nAddress = ${address}\nDNS = ${service.dns_servers || '1.1.1.1'}\n${mtuLine}PrivateKey = ${keys.privateKey}\n${extra}\n[Peer]\nPublicKey = ${service.server_public_key}\nPresharedKey = ${keys.presharedKey}\nAllowedIPs = 0.0.0.0/0\nEndpoint = ${endpoint}:${service.listen_port}\nPersistentKeepalive = 25\n`;
    const peerJson = JSON.stringify({ token, publicKey: keys.publicKey, presharedKey: keys.presharedKey, address });
    const info = db.prepare(`
      INSERT INTO vpn_clients (
        service_id, aggregator_client_id, name, address, public_key, private_key_enc,
        preshared_key_enc, config_enc, peer_json, expires_at, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(service.id, aggregatorClientId || null, clientName, address, keys.publicKey,
      encryptValue(keys.privateKey), encryptValue(keys.presharedKey), encryptValue(config), peerJson,
      clientDurationToExpiry(durationDays));
    await safeRefreshServiceBackup(service.id);
    return getClient(info.lastInsertRowid);
  }

  async function createOutlineClient(service, name, durationDays, aggregatorClientId = null) {
    const created = await outlineRequest(service, 'POST', '/access-keys', { name: cleanText(name, 120) });
    const info = db.prepare(`
      INSERT INTO vpn_clients (
        service_id, aggregator_client_id, name, remote_id, access_url_enc,
        peer_json, expires_at, enabled
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(service.id, aggregatorClientId || null, cleanText(name, 120), cleanText(created.id, 120),
      encryptValue(created.accessUrl || ''), JSON.stringify(created), clientDurationToExpiry(durationDays));
    await safeRefreshServiceBackup(service.id);
    return getClient(info.lastInsertRowid);
  }

  async function createClient(serviceId, values) {
    const service = getService(serviceId);
    if (!service) throw new Error('Service not found');
    if (service.install_status !== 'installed') throw new Error('Install the service first');
    const name = cleanText(values.name, 120);
    if (!name) throw new Error('Client name is required');
    const duplicate = db.prepare('SELECT id FROM vpn_clients WHERE service_id = ? AND lower(name) = lower(?)').get(service.id, name);
    if (duplicate) throw new Error('A client with this name already exists in the service');
    if (service.protocol === 'outline') return createOutlineClient(service, name, values.duration_days, values.aggregator_client_id);
    return createTunnelClient(service, name, values.duration_days, values.aggregator_client_id);
  }

  async function removeTunnelPeer(client, { keepRow = false } = {}) {
    const service = getService(client.service_id);
    const host = getHost(service.host_id);
    const command = service.protocol === 'wireguard' ? 'wg' : 'awg';
    const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
    let peer = {};
    try { peer = JSON.parse(client.peer_json || '{}'); } catch (_) {}
    const token = cleanText(peer.token, 80);
    const publicKey = cleanText(client.public_key, 256);
    const script = `#!/usr/bin/env bash
set -euo pipefail
${command} set ${shQuote(service.interface_name)} peer ${shQuote(publicKey)} remove || true
CONF=${shQuote(`${configDir}/${service.interface_name}.conf`)}
if [ -f "$CONF" ] && [ -n ${shQuote(token)} ]; then
  awk 'BEGIN{skip=0} $0=="# AGG-PEER:${token}"{skip=1;next} $0=="# END-AGG-PEER:${token}"{skip=0;next} !skip{print}' "$CONF" > "$CONF.tmp"
  mv "$CONF.tmp" "$CONF"
  chmod 600 "$CONF"
fi
`;
    await sshExec(host, privilegedCommand(host, script), { timeoutMs: 60000 });
    await safeRefreshServiceBackup(service.id);
    if (!keepRow) db.prepare('DELETE FROM vpn_clients WHERE id = ?').run(client.id);
  }

  async function setClientEnabled(id, enabled, reason = '') {
    const client = getClient(id);
    if (!client) throw new Error('VPN client not found');
    const service = getService(client.service_id);
    if (service.protocol === 'outline') {
      if (enabled) await outlineRequest(service, 'DELETE', `/access-keys/${encodeURIComponent(client.remote_id)}/data-limit`);
      else await outlineRequest(service, 'PUT', `/access-keys/${encodeURIComponent(client.remote_id)}/data-limit`, { limit: { bytes: 0 } });
      db.prepare("UPDATE vpn_clients SET enabled = ?, disabled_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(enabled ? 1 : 0, enabled ? '' : cleanText(reason || 'manual', 40), client.id);
      await safeRefreshServiceBackup(service.id);
      return;
    }
    if (!enabled) {
      await removeTunnelPeer(client, { keepRow: true });
      db.prepare("UPDATE vpn_clients SET enabled = 0, disabled_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(cleanText(reason || 'manual', 40), client.id);
      return;
    }
    const host = getHost(service.host_id);
    const command = service.protocol === 'wireguard' ? 'wg' : 'awg';
    const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
    let peer = {};
    try { peer = JSON.parse(client.peer_json || '{}'); } catch (_) {}
    const token = cleanText(peer.token, 80);
    const psk = decryptValue(client.preshared_key_enc);
    const script = `#!/usr/bin/env bash
set -euo pipefail
PSK_FILE="$(mktemp)"
printf %s ${shQuote(psk)} > "$PSK_FILE"
${command} set ${shQuote(service.interface_name)} peer ${shQuote(client.public_key)} preshared-key "$PSK_FILE" allowed-ips ${shQuote(client.address)}
rm -f "$PSK_FILE"
CONF=${shQuote(`${configDir}/${service.interface_name}.conf`)}
if ! grep -q '^# AGG-PEER:${token}$' "$CONF"; then
cat >> "$CONF" <<'PEERBLOCK'

# AGG-PEER:${token}
[Peer]
PublicKey = ${client.public_key}
PresharedKey = ${psk}
AllowedIPs = ${client.address}
# END-AGG-PEER:${token}
PEERBLOCK
fi
`;
    await sshExec(host, privilegedCommand(host, script), { timeoutMs: 60000 });
    db.prepare("UPDATE vpn_clients SET enabled = 1, disabled_reason = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(client.id);
    await safeRefreshServiceBackup(service.id);
  }

  async function deleteClient(id) {
    const client = getClient(id);
    if (!client) return;
    const service = getService(client.service_id);
    if (service.protocol === 'outline') {
      try { await outlineRequest(service, 'DELETE', `/access-keys/${encodeURIComponent(client.remote_id)}`); }
      catch (err) { if (!/404/.test(String(err.message))) throw err; }
      db.prepare('DELETE FROM vpn_clients WHERE id = ?').run(client.id);
      await safeRefreshServiceBackup(service.id);
      return;
    }
    await removeTunnelPeer(client);
  }

  function revealClientConfig(id) {
    const client = getClient(id);
    if (!client) throw new Error('VPN client not found');
    return client.protocol === 'outline' ? decryptValue(client.access_url_enc) : decryptValue(client.config_enc);
  }

  function createHost(values) {
    const placement = values.placement === 'aggregator' ? 'aggregator' : 'remote';
    let name = cleanText(values.name, 120);
    let hostname = cleanText(values.hostname, 253);
    let publicHost = cleanText(values.public_host || values.hostname, 253);
    let username = cleanText(values.ssh_username || 'root', 80);
    let authType = values.auth_type === 'key' ? 'key' : 'password';
    let password = String(values.password || '');
    let privateKey = String(values.private_key || '').trim();
    let privateKeyPassphrase = String(values.private_key_passphrase || '');
    let sudoPassword = String(values.sudo_password || '');

    if (placement === 'aggregator') {
      const localKeyFile = path.join(dataDir, 'vpn_local_ed25519');
      if (!name) name = 'Сервер агрегатора';
      hostname = 'host.docker.internal';
      username = 'aggvpn';
      authType = 'key';
      password = '';
      privateKeyPassphrase = '';
      sudoPassword = '';
      try { privateKey = fs.readFileSync(localKeyFile, 'utf8').trim(); }
      catch (_) {
        throw new Error('Для режима «Сервер агрегатора» локальный SSH-ключ не найден. Повторно запустите обновление через install.sh. Для стороннего VPS выберите «Сторонний VPS» и используйте пароль либо приватный ключ.');
      }
    }

    if (!name) throw new Error('VPS name is required');
    if (!validHostname(hostname)) throw new Error('Enter a valid VPS SSH address');
    if (!publicHost) publicHost = hostname;
    if (!validHostname(publicHost)) throw new Error('Enter a valid public VPS IP address or hostname');
    if (!username || !/^[a-z_][a-z0-9_.-]*[$]?$/i.test(username)) throw new Error('Invalid SSH username');
    if (authType === 'password' && !password) throw new Error('SSH password is required');
    if (authType === 'key' && !privateKey) throw new Error('Private SSH key is required');

    const existingAggregator = placement === 'aggregator'
      ? db.prepare("SELECT id FROM vpn_hosts WHERE placement = 'aggregator' LIMIT 1").get()
      : null;
    if (existingAggregator) throw new Error('Сервер агрегатора уже добавлен. Используйте существующую карточку.');

    const result = db.prepare(`
      INSERT INTO vpn_hosts (
        name, placement, hostname, public_host, ssh_port, ssh_username, auth_type,
        password_enc, private_key_enc, private_key_passphrase_enc, sudo_password_enc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, placement, hostname, publicHost,
      clampInt(values.ssh_port, 1, 65535, 22), username, authType,
      encryptValue(authType === 'password' ? password : ''),
      encryptValue(authType === 'key' ? privateKey : ''),
      encryptValue(authType === 'key' ? privateKeyPassphrase : ''),
      encryptValue(sudoPassword));
    return getHost(result.lastInsertRowid);
  }

  function findServicePortConflict(hostId, port, excludeServiceId = 0) {
    const rows = db.prepare('SELECT id, name, listen_port, legacy_ports_json FROM vpn_services WHERE host_id = ?').all(Number(hostId));
    for (const row of rows) {
      if (Number(row.id) === Number(excludeServiceId || 0)) continue;
      if (Number(row.listen_port) === Number(port)) return { ...row, conflictType: 'active' };
      let legacy = [];
      try { legacy = JSON.parse(row.legacy_ports_json || '[]'); } catch (_) {}
      if (Array.isArray(legacy) && legacy.some(value => Number(value) === Number(port))) {
        return { ...row, conflictType: 'legacy' };
      }
    }
    return null;
  }

  function assertServicePortAvailable(hostId, port, excludeServiceId = 0) {
    const conflict = findServicePortConflict(hostId, port, excludeServiceId);
    if (!conflict) return;
    if (conflict.conflictType === 'legacy') {
      throw new Error(`Port ${port} is preserved for old client configurations of service ${conflict.name}`);
    }
    throw new Error(`Port ${port} is already assigned to service ${conflict.name}`);
  }

  function createService(values) {
    const hostId = Number(values.host_id || 0);
    const host = getHost(hostId);
    const protocol = cleanText(values.protocol, 40);
    if (!host) throw new Error('Select a VPS');
    if (!PROTOCOLS.has(protocol)) throw new Error('Unsupported protocol');
    const name = cleanText(values.name || PROTOCOL_LABELS[protocol], 120);
    let iface = cleanText(values.interface_name, 15);
    if (protocol === 'outline') iface = 'outline';
    if (protocol !== 'outline' && !validInterfaceName(iface)) throw new Error('Invalid interface name');
    const subnet = protocol === 'outline' ? '' : parseIpv4Cidr(values.subnet_cidr);
    if (protocol !== 'outline' && !subnet) throw new Error('Invalid IPv4 subnet');
    const defaultPort = protocol === 'outline' ? 443 : protocol === 'amneziawg_legacy' ? 585 : protocol === 'amneziawg2' ? 1234 : 51820;
    const port = clampInt(values.listen_port, 1, 65535, defaultPort);
    const endpoint = cleanText(values.endpoint_host || host.public_host || host.hostname, 253);
    if (!validHostname(endpoint)) throw new Error('Invalid public endpoint hostname');
    const interfaceConflict = db.prepare('SELECT id, name FROM vpn_services WHERE host_id = ? AND interface_name = ?').get(host.id, iface);
    if (interfaceConflict) throw new Error(`Interface ${iface} is already used by service ${interfaceConflict.name}`);
    assertServicePortAvailable(host.id, port);
    if (subnet) {
      const existingTunnels = db.prepare("SELECT name, subnet_cidr FROM vpn_services WHERE host_id = ? AND protocol != 'outline'").all(host.id);
      const start = subnet.network;
      const end = subnet.network + subnet.size - 1;
      for (const item of existingTunnels) {
        const other = parseIpv4Cidr(item.subnet_cidr);
        if (!other) continue;
        const otherEnd = other.network + other.size - 1;
        if (start <= otherEnd && other.network <= end) throw new Error(`VPN subnet overlaps with service ${item.name}`);
      }
    }
    const params = protocol.startsWith('amneziawg') ? buildAwgParams(protocol) : {};
    const result = db.prepare(`
      INSERT INTO vpn_services (
        host_id, protocol, name, interface_name, listen_port, subnet_cidr,
        endpoint_host, dns_servers, client_mtu, config_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(host.id, protocol, name, iface, port, subnet ? subnet.cidr : '', endpoint,
      cleanText(values.dns_servers || '1.1.1.1, 1.0.0.1', 200), clampInt(values.client_mtu, 0, 9000, 0), JSON.stringify(params));
    return getService(result.lastInsertRowid);
  }

  async function resolveHostAddresses(hostname) {
    const value = cleanText(hostname, 253).replace(/\.$/, '');
    if (!value) return [];
    if (net.isIP(value)) return [value];
    const rows = await dns.lookup(value, { all: true, verbatim: true });
    return [...new Set(rows.map(row => String(row.address || '')).filter(Boolean))];
  }

  async function checkServiceDomain(id) {
    const service = getService(id);
    if (!service) throw new Error('Service not found');
    const host = getHost(service.host_id);
    const endpoint = cleanText(service.endpoint_host || host.public_host || host.hostname, 253);
    const target = cleanText(host.public_host || host.hostname, 253);
    const checkedAt = nowIso();
    try {
      const endpointIps = await resolveHostAddresses(endpoint);
      const targetIps = await resolveHostAddresses(target);
      const direct = net.isIP(endpoint) > 0;
      const matched = endpointIps.some(ip => targetIps.includes(ip));
      const status = direct ? (matched ? 'match' : 'mismatch') : (matched ? 'match' : 'mismatch');
      const error = matched ? '' : `Домен ${endpoint} указывает на ${endpointIps.join(', ') || 'нет адресов'}, а VPS — на ${targetIps.join(', ') || 'нет адресов'}`;
      db.prepare(`UPDATE vpn_services SET domain_status = ?, domain_resolved_ips = ?, domain_error = ?, domain_checked_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(status, endpointIps.join(', '), cleanText(error, 1000), checkedAt, service.id);
      return { status, endpoint, endpointIps, targetIps, matched };
    } catch (err) {
      db.prepare(`UPDATE vpn_services SET domain_status = 'error', domain_resolved_ips = '', domain_error = ?, domain_checked_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(cleanText(err.message || err, 1000), checkedAt, service.id);
      throw err;
    }
  }

  async function applyTunnelPortChange(service, oldPort, newPort, previousLegacyPorts = []) {
    if (oldPort === newPort || service.install_status !== 'installed') return;
    const host = getHost(service.host_id);
    const quick = service.protocol === 'wireguard' ? 'wg-quick' : 'awg-quick';
    const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
    const sources = [...new Set([...(Array.isArray(previousLegacyPorts) ? previousLegacyPorts : []), oldPort]
      .map(value => Number.parseInt(String(value), 10))
      .filter(value => Number.isInteger(value) && value > 0 && value <= 65535 && value !== newPort))];
    const interfaceToken = String(service.interface_name).replace(/[^a-zA-Z0-9_.-]/g, '-');
    const reusedPortUnit = `agg-vpn-port-${interfaceToken}-${newPort}`;
    const redirectBlocks = sources.map(sourcePort => {
      const unitName = `agg-vpn-port-${interfaceToken}-${sourcePort}`;
      return `
  systemctl stop ${unitName}.service >/dev/null 2>&1 || true
  cat > /etc/systemd/system/${unitName}.service <<'UNIT_${sourcePort}'
[Unit]
Description=3xui Aggregator legacy VPN port ${sourcePort} to ${newPort}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -t nat -C PREROUTING -p udp --dport ${sourcePort} -j REDIRECT --to-ports ${newPort} 2>/dev/null || iptables -t nat -A PREROUTING -p udp --dport ${sourcePort} -j REDIRECT --to-ports ${newPort}'
ExecStop=/bin/sh -c 'iptables -t nat -D PREROUTING -p udp --dport ${sourcePort} -j REDIRECT --to-ports ${newPort} 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
UNIT_${sourcePort}
`;
    }).join('\n');
    const enableUnits = sources.map(sourcePort => {
      const unitName = `agg-vpn-port-${interfaceToken}-${sourcePort}`;
      return `systemctl enable --now ${unitName}.service >/dev/null 2>&1 || true`;
    }).join('\n  ');
    const ufwPorts = sources.map(port => `ufw allow ${port}/udp >/dev/null || true`).join('; ');
    const firewallPorts = sources.map(port => `firewall-cmd --permanent --add-port=${port}/udp >/dev/null || true`).join('; ');
    const script = `#!/usr/bin/env bash
set -euo pipefail
CONF=${shQuote(`${configDir}/${service.interface_name}.conf`)}
[ -s "$CONF" ] || { echo 'Service configuration not found' >&2; exit 51; }
# If a previously preserved port becomes the active port again, remove its
# compatibility redirect first. Otherwise traffic could be redirected away
# from the newly restored listener or form a redirect loop.
systemctl disable --now ${reusedPortUnit}.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/${reusedPortUnit}.service
systemctl daemon-reload
IPT="$(command -v iptables || true)"
if [ -n "$IPT" ]; then
  iptables -t nat -D PREROUTING -p udp --dport ${newPort} -j REDIRECT --to-ports ${oldPort} >/dev/null 2>&1 || true
fi
sed -i -E 's/^ListenPort[[:space:]]*=.*/ListenPort = ${newPort}/' "$CONF"
systemctl restart ${quick}@${service.interface_name}
if [ -n "$IPT" ]; then
${redirectBlocks}
  systemctl daemon-reload
  ${enableUnits}
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then ufw allow ${newPort}/udp >/dev/null || true; ${ufwPorts}; fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port=${newPort}/udp >/dev/null || true; ${firewallPorts}; firewall-cmd --reload >/dev/null || true; fi
`;
    await sshExec(host, privilegedCommand(host, script), { timeoutMs: 120000 });
  }

  async function updateService(id, values) {
    const service = getService(id);
    if (!service) throw new Error('Service not found');
    const host = getHost(service.host_id);
    const name = cleanText(values.name || service.name, 120);
    const endpoint = cleanText(values.endpoint_host || service.endpoint_host || host.public_host || host.hostname, 253);
    if (!validHostname(endpoint)) throw new Error('Invalid public endpoint hostname');
    const port = clampInt(values.listen_port, 1, 65535, Number(service.listen_port || 51820));
    const dnsServers = cleanText(values.dns_servers || service.dns_servers || '1.1.1.1, 1.0.0.1', 200);
    const mtu = clampInt(values.client_mtu, 0, 9000, Number(service.client_mtu || 0));
    assertServicePortAvailable(service.host_id, port, service.id);
    if (service.protocol === 'outline' && service.install_status === 'installed' && (port !== Number(service.listen_port) || endpoint !== service.endpoint_host)) {
      throw new Error('Для установленного Outline порт и адрес меняются через перенос сервиса на VPS, чтобы корректно пересоздать access keys.');
    }
    let legacyPorts = [];
    try { legacyPorts = JSON.parse(service.legacy_ports_json || '[]'); } catch (_) {}
    if (!Array.isArray(legacyPorts)) legacyPorts = [];
    legacyPorts = legacyPorts.map(value => Number.parseInt(String(value), 10)).filter(value => Number.isInteger(value) && value > 0 && value <= 65535);
    // A port that becomes active again is no longer a legacy compatibility port.
    legacyPorts = legacyPorts.filter(value => value !== port);
    if (service.protocol !== 'outline' && port !== Number(service.listen_port)) {
      await applyTunnelPortChange(service, Number(service.listen_port), port, legacyPorts);
    }
    if (service.protocol !== 'outline' && service.install_status === 'installed' && port !== Number(service.listen_port) && Number(service.listen_port) > 0) {
      legacyPorts = [...new Set([...legacyPorts, Number(service.listen_port)])].slice(-50);
    }
    db.prepare(`UPDATE vpn_services SET name = ?, endpoint_host = ?, listen_port = ?, dns_servers = ?, client_mtu = ?,
      legacy_ports_json = ?, domain_status = 'unchecked', domain_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(name, endpoint, port, dnsServers, mtu, JSON.stringify(legacyPorts), service.id);
    if (service.protocol !== 'outline') regenerateTunnelClientConfigs(service.id);
    await safeRefreshServiceBackup(service.id);
    return getService(service.id);
  }

  async function renameClient(id, nameValue) {
    const client = getClient(id);
    if (!client) throw new Error('VPN client not found');
    const name = cleanText(nameValue, 120);
    if (!name) throw new Error('Client name is required');
    const duplicate = db.prepare('SELECT id FROM vpn_clients WHERE service_id = ? AND lower(name) = lower(?) AND id != ?').get(client.service_id, name, client.id);
    if (duplicate) throw new Error('A client with this name already exists in the service');
    if (client.protocol === 'outline') {
      const service = getService(client.service_id);
      await outlineRequest(service, 'PUT', `/access-keys/${encodeURIComponent(client.remote_id)}/name`, { name });
    }
    db.prepare('UPDATE vpn_clients SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(name, client.id);
    return getClient(client.id);
  }

  function buildTunnelMigrationScript(service, clients) {
    const cidr = parseIpv4Cidr(service.subnet_cidr);
    if (!cidr) throw new Error('Invalid IPv4 subnet');
    const command = service.protocol === 'wireguard' ? 'wg' : 'awg';
    const quick = service.protocol === 'wireguard' ? 'wg-quick' : 'awg-quick';
    const configDir = service.protocol === 'wireguard' ? '/etc/wireguard' : '/etc/amnezia/amneziawg';
    const privateKey = decryptValue(service.server_private_key_enc);
    if (!privateKey) throw new Error('Server private key is missing from the aggregator backup');
    let params = {};
    try { params = JSON.parse(service.config_json || '{}'); } catch (_) {}
    const awgLines = service.protocol === 'wireguard' ? '' : awgInterfaceLines(params);
    const serverAddress = intToIpv4(cidr.network + 1);
    let legacyPorts = [];
    try { legacyPorts = JSON.parse(service.legacy_ports_json || '[]'); } catch (_) {}
    if (!Array.isArray(legacyPorts)) legacyPorts = [];
    legacyPorts = [...new Set(legacyPorts
      .map(value => Number.parseInt(String(value), 10))
      .filter(value => Number.isInteger(value) && value > 0 && value <= 65535 && value !== Number(service.listen_port)))];
    const interfaceToken = String(service.interface_name).replace(/[^a-zA-Z0-9_.-]/g, '-');
    const legacyCompatibilityScript = legacyPorts.length ? (() => {
      const units = legacyPorts.map(sourcePort => {
        const unitName = `agg-vpn-port-${interfaceToken}-${sourcePort}`;
        return `cat > /etc/systemd/system/${unitName}.service <<'UNIT_${sourcePort}'
[Unit]
Description=3xui Aggregator legacy VPN port ${sourcePort} to ${service.listen_port}
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'iptables -t nat -C PREROUTING -p udp --dport ${sourcePort} -j REDIRECT --to-ports ${service.listen_port} 2>/dev/null || iptables -t nat -A PREROUTING -p udp --dport ${sourcePort} -j REDIRECT --to-ports ${service.listen_port}'
ExecStop=/bin/sh -c 'iptables -t nat -D PREROUTING -p udp --dport ${sourcePort} -j REDIRECT --to-ports ${service.listen_port} 2>/dev/null || true'

[Install]
WantedBy=multi-user.target
UNIT_${sourcePort}`;
      }).join('\n');
      const enable = legacyPorts.map(sourcePort => `systemctl enable --now agg-vpn-port-${interfaceToken}-${sourcePort}.service >/dev/null 2>&1 || true`).join('\n');
      const ufw = legacyPorts.map(sourcePort => `ufw allow ${sourcePort}/udp >/dev/null || true`).join('; ');
      const firewalld = legacyPorts.map(sourcePort => `firewall-cmd --permanent --add-port=${sourcePort}/udp >/dev/null || true`).join('; ');
      return `if command -v iptables >/dev/null 2>&1; then
${units}
systemctl daemon-reload
${enable}
fi
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then ${ufw}; fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then ${firewalld}; firewall-cmd --reload >/dev/null || true; fi`;
    })() : '';
    const peerBlocks = clients.filter(client => client.enabled !== 0).map(client => {
      let peer = {};
      try { peer = JSON.parse(client.peer_json || '{}'); } catch (_) {}
      const token = cleanText(peer.token || crypto.randomUUID(), 80);
      return `\n# AGG-PEER:${token}\n[Peer]\nPublicKey = ${client.public_key}\nPresharedKey = ${decryptValue(client.preshared_key_enc)}\nAllowedIPs = ${client.address}\n# END-AGG-PEER:${token}`;
    }).join('\n');
    return `#!/usr/bin/env bash
set -euo pipefail
${packageInstallBlock(service.protocol)}
mkdir -p ${shQuote(configDir)}
umask 077
KEY_FILE=${shQuote(`${configDir}/${service.interface_name}.server.key`)}
CONF_FILE=${shQuote(`${configDir}/${service.interface_name}.conf`)}
printf %s ${shQuote(privateKey)} > "$KEY_FILE"
OUT_IF="$(ip -4 route list default | awk '{print $5; exit}')"
[ -n "$OUT_IF" ] || { echo 'Default network interface not found' >&2; exit 61; }
cat > "$CONF_FILE" <<'AGGCONF'
[Interface]
Address = ${serverAddress}/${cidr.prefix}
ListenPort = ${service.listen_port}
PrivateKey = ${privateKey}
SaveConfig = false
${awgLines}
PostUp = iptables -A FORWARD -i ${service.interface_name} -j ACCEPT; iptables -A FORWARD -o ${service.interface_name} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -A POSTROUTING -s ${cidr.cidr} -o __OUT_IF__ -j MASQUERADE
PostDown = iptables -D FORWARD -i ${service.interface_name} -j ACCEPT; iptables -D FORWARD -o ${service.interface_name} -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT; iptables -t nat -D POSTROUTING -s ${cidr.cidr} -o __OUT_IF__ -j MASQUERADE
${peerBlocks}
AGGCONF
sed -i "s|__OUT_IF__|$OUT_IF|g" "$CONF_FILE"
chmod 600 "$CONF_FILE" "$KEY_FILE"
printf 'net.ipv4.ip_forward=1\n' > /etc/sysctl.d/99-3xui-aggregator-vpn.conf
sysctl --system >/dev/null
systemctl enable ${quick}@${service.interface_name}
systemctl restart ${quick}@${service.interface_name}
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q '^Status: active'; then ufw allow ${service.listen_port}/udp >/dev/null || true; fi
if command -v firewall-cmd >/dev/null 2>&1 && systemctl is-active --quiet firewalld; then firewall-cmd --permanent --add-port=${service.listen_port}/udp >/dev/null || true; firewall-cmd --reload >/dev/null || true; fi
${legacyCompatibilityScript}
BACKUP="$(base64 -w0 "$CONF_FILE" 2>/dev/null || base64 "$CONF_FILE" | tr -d '\\n')"
PUBLIC_KEY="$(printf %s ${shQuote(privateKey)} | ${command} pubkey)"
JSON="$(printf '{\"publicKey\":\"%s\",\"backup\":\"%s\"}' "$PUBLIC_KEY" "$BACKUP")"
printf 'AGG_JSON:%s\n' "$(printf %s "$JSON" | base64 -w0 2>/dev/null || printf %s "$JSON" | base64 | tr -d '\\n')"
`;
  }

  async function migrateService(id, targetHostId, values = {}) {
    const service = getService(id);
    if (!service) throw new Error('Service not found');
    if (service.install_status !== 'installed') throw new Error('Install the service before migration');
    const targetHost = getHost(targetHostId);
    if (!targetHost) throw new Error('Target VPS not found');
    if (Number(targetHost.id) === Number(service.host_id)) throw new Error('Select another VPS for migration');
    const movingPorts = [Number(service.listen_port)];
    if (service.protocol !== 'outline') {
      let legacyPorts = [];
      try { legacyPorts = JSON.parse(service.legacy_ports_json || '[]'); } catch (_) {}
      if (Array.isArray(legacyPorts)) movingPorts.push(...legacyPorts.map(value => Number.parseInt(String(value), 10)));
    }
    for (const movingPort of [...new Set(movingPorts.filter(value => Number.isInteger(value) && value > 0 && value <= 65535))]) {
      const targetPortConflict = findServicePortConflict(targetHost.id, movingPort, service.id);
      if (!targetPortConflict) continue;
      const reason = targetPortConflict.conflictType === 'legacy' ? 'is preserved for old client configurations of' : 'is already assigned to';
      throw new Error(`Port ${movingPort} ${reason} service ${targetPortConflict.name} on target VPS`);
    }
    const interfaceConflict = db.prepare('SELECT id, name FROM vpn_services WHERE host_id = ? AND interface_name = ? AND id != ?').get(targetHost.id, service.interface_name, service.id);
    if (interfaceConflict) throw new Error(`Interface ${service.interface_name} is already used on target VPS by ${interfaceConflict.name}`);
    if (service.protocol !== 'outline') {
      const movingSubnet = parseIpv4Cidr(service.subnet_cidr);
      if (!movingSubnet) throw new Error('Invalid service subnet');
      const existingTunnels = db.prepare("SELECT id, name, subnet_cidr FROM vpn_services WHERE host_id = ? AND protocol != 'outline' AND id != ?").all(targetHost.id, service.id);
      const movingEnd = movingSubnet.network + movingSubnet.size - 1;
      for (const item of existingTunnels) {
        const other = parseIpv4Cidr(item.subnet_cidr);
        if (!other) continue;
        const otherEnd = other.network + other.size - 1;
        if (movingSubnet.network <= otherEnd && other.network <= movingEnd) {
          throw new Error(`VPN subnet overlaps on target VPS with service ${item.name}`);
        }
      }
    }
    const endpoint = cleanText(values.endpoint_host || service.endpoint_host || targetHost.public_host || targetHost.hostname, 253);
    if (!validHostname(endpoint)) throw new Error('Invalid public endpoint hostname');
    await testHost(targetHost.id, { trustNewHost: !targetHost.host_key_fingerprint });
    const freshTarget = getHost(targetHost.id);
    const clients = db.prepare('SELECT * FROM vpn_clients WHERE service_id = ? ORDER BY id').all(service.id);

    if (service.protocol === 'outline') {
      const tempService = { ...service, endpoint_host: endpoint };
      const result = await sshExec(freshTarget, privilegedCommand(freshTarget, buildOutlineInstallScript(tempService, freshTarget)), { timeoutMs: 20 * 60 * 1000 });
      const data = parseMarker(result.stdout);
      if (!data?.apiUrl || !data?.certSha256) throw new Error('Outline installer completed without access data');
      const remoteService = { ...service, api_url_enc: encryptValue(data.apiUrl), api_cert_sha256: data.certSha256 };
      const recreated = [];
      for (const client of clients) {
        const created = await outlineRequest(remoteService, 'POST', '/access-keys', { name: client.name });
        if (client.enabled === 0) await outlineRequest(remoteService, 'PUT', `/access-keys/${encodeURIComponent(created.id)}/data-limit`, { limit: { bytes: 0 } });
        recreated.push({ id: client.id, remoteId: created.id, accessUrl: created.accessUrl || '', peer: created });
      }
      const tx = db.transaction(() => {
        db.prepare(`UPDATE vpn_services SET host_id = ?, endpoint_host = ?, api_url_enc = ?, api_cert_sha256 = ?, backup_enc = ?,
          last_status = 'online', last_error = '', domain_status = 'unchecked', migrated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(freshTarget.id, endpoint, encryptValue(data.apiUrl), cleanText(data.certSha256, 256), encryptValue(data.backup || ''), nowIso(), service.id);
        const update = db.prepare('UPDATE vpn_clients SET remote_id = ?, access_url_enc = ?, peer_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
        recreated.forEach(item => update.run(cleanText(item.remoteId, 120), encryptValue(item.accessUrl), JSON.stringify(item.peer), item.id));
      });
      tx();
      await safeRefreshServiceBackup(service.id);
      return getService(service.id);
    }

    const migratedService = { ...service, endpoint_host: endpoint };
    const script = buildTunnelMigrationScript(migratedService, clients);
    const result = await sshExec(freshTarget, privilegedCommand(freshTarget, script), { timeoutMs: 20 * 60 * 1000 });
    const data = parseMarker(result.stdout);
    if (!data?.publicKey) throw new Error('Migration completed without a valid result marker');
    db.prepare(`UPDATE vpn_services SET host_id = ?, endpoint_host = ?, server_public_key = ?, backup_enc = ?,
      last_status = 'online', last_error = '', domain_status = 'unchecked', migrated_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(freshTarget.id, endpoint, cleanText(data.publicKey, 256), encryptValue(data.backup || ''), nowIso(), service.id);
    regenerateTunnelClientConfigs(service.id);
    await safeRefreshServiceBackup(service.id);
    return getService(service.id);
  }

  async function deleteService(id) {
    const service = getService(id);
    if (!service) return;
    const count = db.prepare('SELECT COUNT(*) AS count FROM vpn_clients WHERE service_id = ?').get(service.id).count;
    if (count > 0) throw new Error('Delete VPN clients from this service first');
    db.prepare('DELETE FROM vpn_services WHERE id = ?').run(service.id);
  }

  function deleteHost(id) {
    const count = db.prepare('SELECT COUNT(*) AS count FROM vpn_services WHERE host_id = ?').get(Number(id)).count;
    if (count > 0) throw new Error('Delete services from this VPS first');
    db.prepare('DELETE FROM vpn_hosts WHERE id = ?').run(Number(id));
  }

  function listPageData(query = {}) {
    const tab = ['hosts', 'services', 'clients', 'jobs'].includes(String(query.tab || '')) ? String(query.tab) : 'hosts';
    const hosts = db.prepare(`
      SELECT h.*, (SELECT COUNT(*) FROM vpn_services s WHERE s.host_id = h.id) AS service_count
      FROM vpn_hosts h ORDER BY h.id DESC
    `).all();
    const services = db.prepare(`
      SELECT s.*, h.name AS host_name, h.hostname, h.public_host,
        (SELECT COUNT(*) FROM vpn_clients c WHERE c.service_id = s.id) AS client_count
      FROM vpn_services s JOIN vpn_hosts h ON h.id = s.host_id ORDER BY s.id DESC
    `).all();
    const clients = db.prepare(`
      SELECT c.*, s.name AS service_name, s.protocol, h.name AS host_name
      FROM vpn_clients c
      JOIN vpn_services s ON s.id = c.service_id
      JOIN vpn_hosts h ON h.id = s.host_id
      ORDER BY c.id DESC
    `).all();
    const jobs = db.prepare('SELECT * FROM vpn_jobs ORDER BY id DESC LIMIT 100').all();
    const aggregatorClients = db.prepare('SELECT id, login, display_name FROM clients ORDER BY display_name COLLATE NOCASE, login COLLATE NOCASE').all();
    return { tab, hosts, services, clients, jobs, aggregatorClients, protocolLabels: PROTOCOL_LABELS };
  }

  return {
    initVpnDb,
    getHost,
    getService,
    getClient,
    createHost,
    deleteHost,
    testHost,
    createService,
    deleteService,
    installService,
    checkService,
    checkServiceDomain,
    updateService,
    migrateService,
    createClient,
    setClientEnabled,
    renameClient,
    deleteClient,
    revealClientConfig,
    listPageData,
    protocolLabels: PROTOCOL_LABELS
  };
}

module.exports = { createVpnManager, initVpnDb, PROTOCOL_LABELS };
