#!/usr/bin/env bash
set -euo pipefail

# Installs an already-copied Nexus Node Agent. The enrollment token remains
# one-time and short lived; it is never written to the systemd unit or config.
INSTALL_DIR="/opt/nexus-node-agent"
SERVICE_FILE="/etc/systemd/system/nexus-node-agent.service"
CONFIG_FILE="/etc/nexus-node-agent/config.json"
PANEL_URL=""
ENROLLMENT_TOKEN=""
NODE_NAME="$(hostname -s 2>/dev/null || hostname)"
INSTALL_NODE="0"

usage() {
  cat <<'EOF'
Usage:
  sudo bash install.sh --panel https://panel.example.com --token nxenr_... [--name finland-01] [--install-node]

Options:
  --panel URL       Public HTTPS URL of Nexus Panel (required)
  --token TOKEN     One-time enrollment token from Nexus Panel (required)
  --name NAME       Display name of this node (default: server hostname)
  --install-node    Install Node.js 22 through NodeSource on Debian/Ubuntu if needed
  -h, --help        Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel) PANEL_URL="${2:-}"; shift 2 ;;
    --token) ENROLLMENT_TOKEN="${2:-}"; shift 2 ;;
    --name) NODE_NAME="${2:-}"; shift 2 ;;
    --install-node) INSTALL_NODE="1"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root (sudo bash install.sh ...)." >&2
  exit 1
fi
if [[ -z "$PANEL_URL" || -z "$ENROLLMENT_TOKEN" || -z "$NODE_NAME" ]]; then
  echo "--panel, --token and --name must not be empty." >&2
  usage >&2
  exit 2
fi
if [[ ! "$PANEL_URL" =~ ^https:// ]]; then
  echo "Panel URL must start with https://" >&2
  exit 2
fi
if [[ ! "$ENROLLMENT_TOKEN" =~ ^nxenr_[A-Za-z0-9_-]{20,}$ ]]; then
  echo "The enrollment token format is invalid." >&2
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$SCRIPT_DIR/agent.js" ]]; then
  echo "agent.js must be in the same directory as install.sh." >&2
  exit 1
fi

node_major=""
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
fi
if [[ "$node_major" != "22" ]]; then
  if [[ "$INSTALL_NODE" != "1" ]]; then
    echo "Node.js 22 is required (found: ${node_major:-not installed}). Install it, or rerun with --install-node on Debian/Ubuntu." >&2
    exit 1
  fi
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    echo "--install-node supports Debian/Ubuntu with apt-get and curl only. Install Node.js 22 manually, then rerun." >&2
    exit 1
  fi
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "$node_major" != "22" ]]; then
    echo "Node.js 22 installation did not complete correctly." >&2
    exit 1
  fi
fi

if [[ -e "$CONFIG_FILE" ]]; then
  echo "Existing agent configuration found at $CONFIG_FILE. Refusing to overwrite an enrolled node." >&2
  exit 1
fi

install -d -m 0755 "$INSTALL_DIR" /etc/nexus-node-agent /var/lib/nexus-node-agent
install -m 0755 "$SCRIPT_DIR/agent.js" "$INSTALL_DIR/agent.js"
node "$INSTALL_DIR/agent.js" enroll --panel "$PANEL_URL" --token "$ENROLLMENT_TOKEN" --name "$NODE_NAME"
unset ENROLLMENT_TOKEN

cat > "$SERVICE_FILE" <<'EOF'
[Unit]
Description=Nexus Node Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/nexus-node-agent
ExecStart=/usr/bin/node /opt/nexus-node-agent/agent.js run
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/var/lib/nexus-node-agent

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nexus-node-agent.service
systemctl --no-pager --full status nexus-node-agent.service
echo "Nexus Node Agent is installed and running. Check it in Panel → Nexus Node."
