#!/usr/bin/env bash
set -Eeuo pipefail

INSTALLER_URL="${NEXUS_INSTALLER_URL:-https://raw.githubusercontent.com/dagmagnat/Nexus-Panel/main/install.sh}"
INSTALLER_FILE="/tmp/nexus-install.sh"
CURL_BIN="${NEXUS_BOOTSTRAP_CURL:-curl}"

if [ "${NEXUS_BOOTSTRAP_SKIP_ROOT_CHECK:-0}" != "1" ] && [ "$(id -u)" -ne 0 ]; then
  printf 'Nexus Panel: сначала выполните sudo -i, затем повторите команду установки.\n' >&2
  exit 1
fi

printf 'Nexus Panel: загружаю установщик...\n'
"$CURL_BIN" --fail --show-error --location --retry 5 --retry-delay 2 \
  --connect-timeout 20 --max-time 180 \
  "$INSTALLER_URL" -o "$INSTALLER_FILE"

sed -i 's/\r$//' "$INSTALLER_FILE"
if [ ! -s "$INSTALLER_FILE" ] || ! grep -q '^#!/usr/bin/env bash' "$INSTALLER_FILE"; then
  printf 'Nexus Panel: GitHub вернул пустой или некорректный install.sh.\n' >&2
  exit 1
fi
chmod 0755 "$INSTALLER_FILE"

printf 'Nexus Panel: запускаю установщик...\n'
if [ "${NEXUS_BOOTSTRAP_NO_TTY:-0}" != "1" ] && [ -r /dev/tty ]; then
  exec env -u NEXUS_INSTALLER_LIBRARY_ONLY NEXUS_INSTALLER_FORCE_RUN=1 \
    bash "$INSTALLER_FILE" "$@" </dev/tty
fi
exec env -u NEXUS_INSTALLER_LIBRARY_ONLY NEXUS_INSTALLER_FORCE_RUN=1 \
  bash "$INSTALLER_FILE" "$@"
