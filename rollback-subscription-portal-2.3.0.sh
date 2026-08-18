#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT="${1:-}"
NO_BUILD="${2:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "[ERR] Запусти скрипт через sudo или от root." >&2
  exit 1
fi
if [[ -z "$BACKUP_ROOT" || ! -d "$BACKUP_ROOT/files" || ! -f "$BACKUP_ROOT/TARGET_DIR" ]]; then
  echo "[ERR] Укажи каталог резервной копии subscription-portal-2.3.0-* первым аргументом." >&2
  exit 1
fi

TARGET_DIR="$(<"$BACKUP_ROOT/TARGET_DIR")"
[[ -d "$TARGET_DIR" && -f "$TARGET_DIR/app.js" ]] || {
  echo "[ERR] Каталог Nexus Panel из резервной копии не найден: $TARGET_DIR" >&2
  exit 1
}

MANIFEST="$BACKUP_ROOT/SUBSCRIPTION_PORTAL_2_3_0_FILES.txt"
[[ -f "$MANIFEST" ]] || { echo "[ERR] В резервной копии отсутствует manifest." >&2; exit 1; }

echo "[INF] Возвращаю прежние файлы из $BACKUP_ROOT"
while IFS= read -r relative; do
  [[ -n "$relative" ]] || continue
  if [[ -f "$BACKUP_ROOT/files/$relative" ]]; then
    mkdir -p "$TARGET_DIR/$(dirname "$relative")"
    cp -a "$BACKUP_ROOT/files/$relative" "$TARGET_DIR/$relative"
  elif [[ -f "$BACKUP_ROOT/FILES_CREATED.txt" ]] && grep -Fqx -- "$relative" "$BACKUP_ROOT/FILES_CREATED.txt"; then
    if [[ -f "$TARGET_DIR/$relative" ]]; then
      mkdir -p "$BACKUP_ROOT/removed-new-files/$(dirname "$relative")"
      mv "$TARGET_DIR/$relative" "$BACKUP_ROOT/removed-new-files/$relative"
    fi
  fi
done < "$MANIFEST"

echo "[INF] data/app.db не восстанавливается автоматически: патч её не изменяет."
echo "[INF] Отдельная копия базы сохранена в $BACKUP_ROOT/data/app.db."
if [[ "$NO_BUILD" == "--no-build" ]]; then
  echo "[OK] Прежние файлы возвращены без перезапуска."
  exit 0
fi

cd "$TARGET_DIR"
docker compose up -d --build
docker compose ps
echo "[OK] Предыдущая версия Nexus Panel восстановлена."
