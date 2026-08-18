#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-1080}"
ALLOWED_IP="${ALLOWED_IP:-${PANEL_IP:-}}"
PROXY_USER="${PROXY_USER:-tgproxy}"
PROXY_PASS="${PROXY_PASS:-}"

if [ "$(id -u)" != "0" ]; then
  echo "Run as root." >&2
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian/Ubuntu servers with apt-get." >&2
  exit 1
fi

case "$PORT" in
  *[!0-9]*|'') echo "PORT must be numeric." >&2; exit 1 ;;
esac

if [ -z "$ALLOWED_IP" ]; then
  echo "Enter the OUTGOING public IP of the panel server, not necessarily the IP used to open the panel."
  echo "Run this on the panel server to see it: curl -4 https://api.ipify.org; echo"
  printf "Allowed panel IP: "
  read -r ALLOWED_IP
fi

if ! printf '%s' "$ALLOWED_IP" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "ALLOWED_IP/PANEL_IP must be an IPv4 address." >&2
  exit 1
fi

if [ -z "$PROXY_PASS" ]; then
  PROXY_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)"
fi

EXT_IF="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="dev") {print $(i+1); exit}}')"
if [ -z "$EXT_IF" ]; then
  EXT_IF="$(ip -o -4 route show to default | awk '{print $5; exit}')"
fi
if [ -z "$EXT_IF" ]; then
  echo "Could not detect the external network interface." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y dante-server curl ca-certificates

if ! id "$PROXY_USER" >/dev/null 2>&1; then
  useradd -r -s /usr/sbin/nologin "$PROXY_USER"
fi
echo "${PROXY_USER}:${PROXY_PASS}" | chpasswd

cp -f /etc/danted.conf "/etc/danted.conf.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
cat > /etc/danted.conf <<DANTECONF
logoutput: syslog
internal: 0.0.0.0 port = ${PORT}
external: ${EXT_IF}

socksmethod: username
clientmethod: none
user.privileged: root
user.notprivileged: nobody
user.libwrap: nobody

client pass {
  from: ${ALLOWED_IP}/32 to: 0.0.0.0/0
  log: error connect disconnect
}
client block {
  from: 0.0.0.0/0 to: 0.0.0.0/0
  log: connect error
}

socks pass {
  from: ${ALLOWED_IP}/32 to: 0.0.0.0/0
  command: connect
  protocol: tcp
  socksmethod: username
  log: error connect disconnect
}
socks block {
  from: 0.0.0.0/0 to: 0.0.0.0/0
  log: connect error
}
DANTECONF

if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -qi 'Status: active'; then
  ufw allow from "$ALLOWED_IP" to any port "$PORT" proto tcp >/dev/null || true
fi

systemctl enable danted >/dev/null
systemctl restart danted
sleep 1
if ! systemctl is-active --quiet danted; then
  echo "danted failed to start. Logs:" >&2
  journalctl -u danted --no-pager -n 80 >&2 || true
  exit 1
fi

PUB_IP="$(curl -4fsS --max-time 5 https://ifconfig.me 2>/dev/null || true)"
if [ -z "$PUB_IP" ]; then
  PUB_IP="$(hostname -I | awk '{print $1}')"
fi

cat <<RESULT

Telegram SOCKS5 proxy is ready.

Paste this into 3xui-Aggregator -> TG-bot -> Telegram Proxy URL:
socks5h://${PROXY_USER}:${PROXY_PASS}@${PUB_IP}:${PORT}

Allowed panel outgoing IP: ${ALLOWED_IP}
Service: danted
Config: /etc/danted.conf

Test from the panel server:
curl --socks5-hostname ${PROXY_USER}:${PROXY_PASS}@${PUB_IP}:${PORT} https://api.telegram.org

Disable on the panel side: clear Telegram Proxy URL and click Save/Apply.
Disable on this server: systemctl disable --now danted

RESULT
