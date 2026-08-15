#!/usr/bin/env bash
set -Eeuo pipefail

PATCH_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="/opt/3xui-aggregator"
NO_BUILD=0

usage() {
  cat <<'EOF'
Nexus Panel 2.2.1 — компактная мобильная панель

Использование:
  sudo bash apply-spectrum-clear-2.2.1.sh
  sudo bash apply-spectrum-clear-2.2.1.sh --target /opt/3xui-aggregator
  sudo bash apply-spectrum-clear-2.2.1.sh --no-build

Скрипт не заменяет data/, .env и параметры установки. Перед изменениями
создаётся резервная копия базы и каждого заменяемого файла.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      [[ $# -ge 2 ]] || { echo "[ERR] После --target нужен каталог." >&2; exit 2; }
      TARGET_DIR="$2"
      shift 2
      ;;
    --no-build)
      NO_BUILD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[ERR] Неизвестный параметр: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERR] Запусти скрипт через sudo или от root." >&2
  exit 1
fi

TARGET_DIR="$(cd "$TARGET_DIR" 2>/dev/null && pwd)" || {
  echo "[ERR] Каталог установки не найден: $TARGET_DIR" >&2
  exit 1
}

if [[ ! -f "$TARGET_DIR/app.js" || ! -f "$TARGET_DIR/docker-compose.yml" ]]; then
  echo "[ERR] В $TARGET_DIR не найдена рабочая установка Nexus Panel." >&2
  exit 1
fi
if [[ ! -f "$TARGET_DIR/public/css/spectrum-clear.css" ]]; then
  echo "[ERR] Обновление 2.2.1 устанавливается поверх Nexus Panel Spectrum Clear 2.x." >&2
  exit 1
fi

MANIFEST="$PATCH_ROOT/SPECTRUM_CLEAR_2_2_1_FILES.txt"
ROLLBACK_SCRIPT="$PATCH_ROOT/rollback-spectrum-clear-2.2.1.sh"
[[ -f "$MANIFEST" ]] || { echo "[ERR] Нет SPECTRUM_CLEAR_2_2_1_FILES.txt." >&2; exit 1; }
[[ -f "$ROLLBACK_SCRIPT" ]] || { echo "[ERR] Нет rollback-spectrum-clear-2.2.1.sh." >&2; exit 1; }

while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  if [[ "$relative" == /* || "$relative" == *".."* ]]; then
    echo "[ERR] Недопустимый путь в manifest: $relative" >&2
    exit 1
  fi
  [[ -f "$PATCH_ROOT/$relative" ]] || {
    echo "[ERR] В архиве отсутствует файл: $relative" >&2
    exit 1
  }
done < "$MANIFEST"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_BASE="${NEXUS_BACKUP_BASE:-/opt/3xui-backups}"
BACKUP_ROOT="$BACKUP_BASE/spectrum-clear-2.2.1-$STAMP"
mkdir -p "$BACKUP_ROOT/files"
printf '%s\n' "$TARGET_DIR" > "$BACKUP_ROOT/TARGET_DIR"
cp -a "$MANIFEST" "$BACKUP_ROOT/SPECTRUM_CLEAR_2_2_1_FILES.txt"
cp -a "$ROLLBACK_SCRIPT" "$BACKUP_ROOT/rollback-spectrum-clear-2.2.1.sh"
chmod 700 "$BACKUP_ROOT/rollback-spectrum-clear-2.2.1.sh"

if [[ -f "$TARGET_DIR/data/app.db" ]]; then
  mkdir -p "$BACKUP_ROOT/data"
  cp -a "$TARGET_DIR/data/app.db" "$BACKUP_ROOT/data/app.db"
  chmod 600 "$BACKUP_ROOT/data/app.db" 2>/dev/null || true
  if command -v sqlite3 >/dev/null 2>&1; then
    {
      printf 'clients='; sqlite3 "$TARGET_DIR/data/app.db" 'SELECT COUNT(*) FROM clients;' 2>/dev/null || printf 'unknown\n'
      printf 'client_nodes='; sqlite3 "$TARGET_DIR/data/app.db" 'SELECT COUNT(*) FROM client_nodes;' 2>/dev/null || printf 'unknown\n'
    } > "$BACKUP_ROOT/COUNTS_BEFORE.txt"
  fi
fi

while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  if [[ -f "$TARGET_DIR/$relative" ]]; then
    mkdir -p "$BACKUP_ROOT/files/$(dirname "$relative")"
    cp -a "$TARGET_DIR/$relative" "$BACKUP_ROOT/files/$relative"
  else
    printf '%s\n' "$relative" >> "$BACKUP_ROOT/FILES_CREATED.txt"
  fi
done < "$MANIFEST"

echo "[INF] Резервная копия: $BACKUP_ROOT"
echo "[INF] Устанавливаю только файлы Nexus Panel 2.2.1; data/ и .env не изменяются."
while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  mkdir -p "$TARGET_DIR/$(dirname "$relative")"
  cp -a "$PATCH_ROOT/$relative" "$TARGET_DIR/$relative"
done < "$MANIFEST"

rollback_now() {
  echo "[ERR] Проверка обновления не пройдена. Возвращаю прежние файлы." >&2
  bash "$BACKUP_ROOT/rollback-spectrum-clear-2.2.1.sh" "$BACKUP_ROOT" --no-build || true
}

if command -v node >/dev/null 2>&1; then
  if ! node --check "$TARGET_DIR/app.js"; then
    rollback_now
    exit 1
  fi
  if [[ -f "$TARGET_DIR/scripts/check-views.js" ]] && ! (cd "$TARGET_DIR" && node scripts/check-views.js); then
    rollback_now
    exit 1
  fi
  if [[ -f "$TARGET_DIR/tests/spectrum-clear-2.2.1.test.js" ]] && ! (cd "$TARGET_DIR" && node --test tests/spectrum-clear-2.2.1.test.js); then
    rollback_now
    exit 1
  fi
else
  echo "[INF] Node.js на хосте не установлен — основная проверка выполнится в Docker-сборке."
fi

if [[ "$NO_BUILD" -eq 1 ]]; then
  echo "[OK] Файлы установлены без перезапуска (--no-build)."
  echo "[INF] Для применения: cd '$TARGET_DIR' && docker compose up -d --build"
  echo "[INF] Откат: bash '$BACKUP_ROOT/rollback-spectrum-clear-2.2.1.sh' '$BACKUP_ROOT'"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[ERR] Docker не найден. Прежние файлы будут возвращены." >&2
  rollback_now
  exit 1
fi

cd "$TARGET_DIR"
if ! docker compose config >/dev/null; then
  rollback_now
  exit 1
fi

if ! docker compose up -d --build; then
  echo "[ERR] Новая сборка не запустилась. Выполняю автоматический откат." >&2
  bash "$BACKUP_ROOT/rollback-spectrum-clear-2.2.1.sh" "$BACKUP_ROOT" --no-build || true
  docker compose up -d --build || true
  exit 1
fi

docker compose ps
echo "[OK] Nexus Panel 2.2.1 установлен. Клиенты, UUID и ссылки сохранены."
echo "[INF] Резервная копия: $BACKUP_ROOT"
echo "[INF] Откат: bash '$BACKUP_ROOT/rollback-spectrum-clear-2.2.1.sh' '$BACKUP_ROOT'"
