#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/3xui-aggregator}"
AGG_INSTANCE="${AGG_INSTANCE:-default}"
DATA_DIR="$APP_DIR/data"
REQUEST_FILE="$DATA_DIR/project_update_request.json"
STATUS_FILE="$DATA_DIR/project_update_status.json"
LOCK_DIR="$DATA_DIR/project_update.lock"
SLEEP_SEC="${SLEEP_SEC:-3}"
BACKUP_DIR="${BACKUP_DIR:-/opt/3xui-backups}"

mkdir -p "$DATA_DIR" "$BACKUP_DIR"

json_escape() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

write_status() {
  local state="$1" message="$2" err="${3:-}" log_tail="${4:-}" archive_url="${5:-}"
  local now
  now="$(date -Iseconds)"
  python3 - "$STATUS_FILE" "$state" "$message" "$err" "$log_tail" "$archive_url" "$now" <<'PY'
import json, sys, os
path, state, message, err, log_tail, archive_url, now = sys.argv[1:]
old = {}
try:
    with open(path, 'r', encoding='utf-8') as f:
        old = json.load(f)
except Exception:
    pass
old.update({
    'status': state,
    'message': message,
    'error': err,
    'logTail': log_tail[-4000:] if log_tail else '',
    'archiveUrl': archive_url or old.get('archiveUrl', ''),
    'updatedAt': now,
})
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, 'w', encoding='utf-8') as f:
    json.dump(old, f, ensure_ascii=False, indent=2)
PY
}

read_request_field() {
  local field="$1"
  python3 - "$REQUEST_FILE" "$field" <<'PY'
import json, sys
path, field = sys.argv[1:]
try:
    with open(path, 'r', encoding='utf-8') as f:
        data = json.load(f)
    print(data.get(field, '') or '')
except Exception:
    print('')
PY
}

run_once() {
  [ -f "$REQUEST_FILE" ] || return 0
  local status archive_url req_id
  status="$(read_request_field status)"
  [ "$status" = "requested" ] || return 0

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    return 0
  fi
  trap 'rm -rf "$LOCK_DIR"' RETURN

  archive_url="$(read_request_field archiveUrl)"
  req_id="$(read_request_field id)"
  if [ -z "$archive_url" ]; then
    write_status failed "Не указан archiveUrl для обновления" "archiveUrl empty" "" ""
    mv -f "$REQUEST_FILE" "$REQUEST_FILE.failed.$(date +%s)" || true
    return 0
  fi

  local tmp zip log src
  tmp="$(mktemp -d)"
  zip="$tmp/update.zip"
  log="$DATA_DIR/project_update_${req_id:-manual}.log"
  write_status downloading "Скачиваю архив обновления..." "" "" "$archive_url"

  if ! curl -fL --connect-timeout 20 --max-time 180 "$archive_url" -o "$zip" >"$log" 2>&1; then
    write_status failed "Не удалось скачать архив обновления" "curl failed" "$(tail -n 80 "$log" 2>/dev/null || true)" "$archive_url"
    mv -f "$REQUEST_FILE" "$REQUEST_FILE.failed.$(date +%s)" || true
    rm -rf "$tmp"
    return 0
  fi

  write_status installing "Архив скачан. Запускаю обновление файлов без изменения настроек..." "" "" "$archive_url"
  if ! unzip -q "$zip" -d "$tmp/unpacked" >>"$log" 2>&1; then
    write_status failed "Не удалось распаковать архив обновления" "unzip failed" "$(tail -n 80 "$log" 2>/dev/null || true)" "$archive_url"
    mv -f "$REQUEST_FILE" "$REQUEST_FILE.failed.$(date +%s)" || true
    rm -rf "$tmp"
    return 0
  fi

  src="$(find "$tmp/unpacked" -maxdepth 2 -type f -name install.sh -printf '%h\n' | head -n 1)"
  if [ -z "$src" ] || [ ! -f "$src/app.js" ]; then
    write_status failed "В архиве не найден корректный проект" "install.sh/app.js not found" "$(find "$tmp/unpacked" -maxdepth 3 -type f | head -n 40)" "$archive_url"
    mv -f "$REQUEST_FILE" "$REQUEST_FILE.failed.$(date +%s)" || true
    rm -rf "$tmp"
    return 0
  fi

  chmod +x "$src/install.sh" || true
  if env APP_DIR="$APP_DIR" AGG_INSTANCE="$AGG_INSTANCE" BACKUP_DIR="$BACKUP_DIR" bash "$src/install.sh" --update-files-only >>"$log" 2>&1; then
    write_status success "Обновление успешно произведено" "" "$(tail -n 80 "$log" 2>/dev/null || true)" "$archive_url"
    mv -f "$REQUEST_FILE" "$REQUEST_FILE.done.$(date +%s)" || true
  else
    write_status failed "Обновление завершилось ошибкой" "install.sh failed" "$(tail -n 120 "$log" 2>/dev/null || true)" "$archive_url"
    mv -f "$REQUEST_FILE" "$REQUEST_FILE.failed.$(date +%s)" || true
  fi
  rm -rf "$tmp"
}

if [ "${1:-loop}" = "once" ]; then
  run_once
  exit 0
fi

while true; do
  run_once || true
  sleep "$SLEEP_SEC"
done
