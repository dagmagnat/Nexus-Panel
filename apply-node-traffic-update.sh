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
[[ -f "$deploy_dir/docker-compose.yml" ]] || { echo 'Для systemd используйте ручную инструкцию docs/UPDATE_2.7.19.md.' >&2; exit 1; }
docker compose version >/dev/null
command -v python3 >/dev/null || { echo 'Нужен python3 для безопасной проверки и миграции конфигурации.' >&2; exit 1; }
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
preflight_changes="$(python3 "$patch_root/scripts/upgrade-install-config.py" "$deploy_dir" --check)"
printf '%s\n' "$preflight_changes"
if [[ "$preflight_changes" == *'Will update Caddyfile'* ]] && ! "${compose[@]}" config --services | grep -qx caddy; then
  echo 'Caddyfile требует обновления, но сервис caddy отсутствует. Обновите правила внешнего прокси по инструкции до применения патча.' >&2
  exit 1
fi
if command -v node >/dev/null 2>&1; then
  node --check "$patch_root/app.js"
  node --check "$patch_root/lib_node_traffic.js"
  node --check "$patch_root/lib_client_directory.js"
  node --check "$patch_root/lib_device_refresh.js"
  node --check "$patch_root/lib_performance.js"
  node --check "$patch_root/lib_json_routing_dns.js"
  node --check "$patch_root/lib_node_udp443.js"
  node --check "$patch_root/lib_subscription_links.js"
  node --check "$patch_root/lib_workspace_runtime.js"
fi
echo "Обновление Nexus: $deploy_dir"
echo 'Остановится только сервис aggregator. Исходники, .env и базы будут сохранены в полный backup.'
echo 'Внешние DATA_DIR/control/workspaces/volumes за пределами каталога сохраните отдельно до продолжения.'
echo 'Сборка network: host будет заменена на default; в шаблон Caddy добавятся только чистые ссылки подписок. Порты и имена экземпляра сохраняются.'
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
  if [[ "$stopped" == 1 ]]; then echo "Nexus остановлен либо не запустился. Проверьте ${deploy_dir}/docker-compose.yml; инструкция отката: docs/UPDATE_2.7.19.md." >&2; fi
  exit "$code"
}
trap failed ERR
"${compose[@]}" stop aggregator
stopped=1
tar -czf "$backup_file" -C "$deploy_dir" .
chmod 600 "$backup_file"
runtime_changes="$(python3 "$patch_root/scripts/upgrade-install-config.py" "$deploy_dir")"
printf '%s\n' "$runtime_changes"
caddy_changed=0
if [[ "$runtime_changes" == *'Updated Caddyfile;'* ]]; then
  caddy_changed=1
  "${compose[@]}" run --rm --no-deps --entrypoint caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
fi
"${compose[@]}" config --quiet
while IFS= read -r relative || [[ -n "$relative" ]]; do
  relative="${relative%$'\r'}"
  mkdir -p -- "$(dirname -- "$deploy_dir/$relative")"
  install -m 644 -- "$patch_root/$relative" "$deploy_dir/$relative"
done < "$patch_root/PATCH_FILES.txt"
"${compose[@]}" up -d --build aggregator
if [[ "$caddy_changed" == 1 ]]; then
  # A single-file bind mount may keep the old inode after atomic replacement.
  "${compose[@]}" up -d --no-deps --force-recreate caddy
fi
stopped=0
echo "Исходники Nexus 2.7.19 установлены. Полный backup: $backup_file"
echo 'Проверьте журналы aggregator и страницу Трафик → Обновить с узлов. Сам запуск контейнера не подтверждает успешный сбор API.'
