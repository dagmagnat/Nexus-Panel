#!/usr/bin/env bash
set -euo pipefail
if [ "$(id -u)" != "0" ]; then
  echo "Run as root." >&2
  exit 1
fi
systemctl disable --now danted 2>/dev/null || true
if command -v apt-get >/dev/null 2>&1; then
  apt-get purge -y dante-server || true
  apt-get autoremove -y || true
fi
echo "Telegram SOCKS5 proxy disabled on this server. Also clear Telegram Proxy URL in the aggregator panel."
