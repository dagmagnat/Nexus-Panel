#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

patch_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
deploy_arg="${1:-}"
if [[ -z "$deploy_arg" || "$deploy_arg" != /* ]]; then
  echo 'Передайте абсолютный каталог существующей Nexus: bash apply-node-traffic-update.sh /opt/3xui-aggregator' >&2
  exit 1
fi
deploy_dir="$(realpath -e -- "$deploy_arg")"
if [[ "$deploy_dir" == / || "$deploy_dir" == /root || "$deploy_dir" == /opt || "$deploy_dir" == "$patch_root" ]]; then
  echo 'Нужен отдельный существующий каталог приложения, не корень или каталог патча.' >&2
  exit 1
fi
[[ -f "$deploy_dir/app.js" && -f "$deploy_dir/package.json" && -f "$deploy_dir/.env" ]] || { echo 'Не найден установленный Nexus с .env.' >&2; exit 1; }
grep -q '"name"[[:space:]]*:[[:space:]]*"nexus-panel"' "$deploy_dir/package.json" || { echo 'Это не Nexus Panel.' >&2; exit 1; }
grep -q 'createAccess' "$deploy_dir/lib_access.js" || { echo 'Этот патч требует рабочую базу Nexus 2.7.7 с поддержкой пространств.' >&2; exit 1; }
[[ -f "$deploy_dir/docker-compose.yml" ]] || { echo 'Для systemd используйте ручную инструкцию docs/UPDATE_2.7.14.md.' >&2; exit 1; }
docker compose version >/dev/null
compose=(docker compose --project-directory "$deploy_dir" -f "$deploy_dir/docker-compose.yml")
"${compose[@]}" config --services | grep -qx aggregator || { echo 'Сервис aggregator не найден. Используйте ручную инструкцию.' >&2; exit 1; }
[[ -f "$patch_root/PATCH_FILES.txt" ]] || { echo 'Нет списка файлов патча.' >&2; exit 1; }
while IFS= read -r relative || [[ -n "$relative" ]]; do
  relative="${relative%$'\r'}"
  [[ -n "$relative" && "$relative" != /* && "$relative" != *..* ]] || { echo 'Некорректный путь в PATCH_FILES.txt.' >&2; exit 1; }
  [[ -f "$patch_root/$relative" && ! -L "$patch_root/$relative" ]] || { echo "Отсутствует файл патча: $relative" >&2; exit 1; }
  resolved="$(realpath -m -- "$deploy_dir/$relative")"
  [[ "$resolved" == "$deploy_dir/"* ]] || { echo "Путь выходит за каталог Nexus: $relative" >&2; exit 1; }
done < "$patch_root/PATCH_FILES.txt"
if command -v node >/dev/null 2>&1; then
  node --check "$patch_root/app.js"
  node --check "$patch_root/lib_node_traffic.js"
  node --check "$patch_root/lib_client_directory.js"
  node --check "$patch_root/lib_device_refresh.js"
  node --check "$patch_root/lib_performance.js"
fi
echo "Обновление Nexus: $deploy_dir"
echo 'Остановится только сервис aggregator. Исходники, .env и базы будут сохранены в полный backup.'
echo 'Внешние DATA_DIR/control/workspaces/volumes за пределами каталога сохраните отдельно до продолжения.'
echo 'Первый сбор восстановит доступную историю Remnawave и начнёт применять независимые квоты.'
echo 'Исторический расход может уже превышать квоту. Для новой квоты с нуля выполните явный сброс в Nexus.'
echo 'Нужны отдельные эксклюзивные сквады и UUID физической ноды. Общий лимит клиента 0 — только раздельные квоты.'
read -r -p 'Введите YES для применения: ' confirmation
[[ "$confirmation" == YES ]] || { echo 'Отменено. Изменений нет.'; exit 0; }

backup_file="$(dirname -- "$deploy_dir")/nexus-before-traffic-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
stopped=0
failed() {
  local code=$?
  echo "Ошибка обновления (код $code). Backup: $backup_file" >&2
  if [[ "$stopped" == 1 ]]; then echo "Nexus остановлен либо не запустился. Проверьте ${deploy_dir}/docker-compose.yml; инструкция отката: docs/UPDATE_2.7.14.md." >&2; fi
  exit "$code"
}
trap failed ERR
"${compose[@]}" stop aggregator
stopped=1
tar -czf "$backup_file" -C "$deploy_dir" .
chmod 600 "$backup_file"
while IFS= read -r relative || [[ -n "$relative" ]]; do
  relative="${relative%$'\r'}"
  mkdir -p -- "$(dirname -- "$deploy_dir/$relative")"
  install -m 644 -- "$patch_root/$relative" "$deploy_dir/$relative"
done < "$patch_root/PATCH_FILES.txt"
"${compose[@]}" up -d --build aggregator
stopped=0
echo "Исходники Nexus 2.7.14 установлены. Полный backup: $backup_file"
echo 'Проверьте журналы aggregator и страницу Трафик → Обновить с узлов. Сам запуск контейнера не подтверждает успешный сбор API.'
