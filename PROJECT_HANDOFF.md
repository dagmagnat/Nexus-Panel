# Nexus Panel — журнал продолжения разработки

Последнее обновление: **2026-10-15**

Этот файл нужно читать первым при продолжении работы из другой учётной записи или нового чата. После каждой доработки обновляйте разделы «Последнее изменение», «Изменённые файлы» и «Проверки».

## Исходная версия

- Текущая рабочая база взята из архива `Nexus-Panel-main (3).zip`.
- Архив не совпадает с предыдущей рабочей копией 2.7.0: в нём добавлены SVG-флаги и доработаны совместимость Remnawave, прокрутка страницы узлов и соответствующий тест.
- Папка `node_modules` в исходный архив не входит и в итоговые архивы изменений попадать не должна.

## Последнее изменение

2026-10-15 — Nexus 2.7.14, служебный узел не появляется после expiry:

- Пользователь на последней установленной Nexus обновляет JSON, видит только notice, хотя node помечен expired_support и sync errors=0. Подчёркивает необходимость JSON и SUB. Дата expiry клиента не предоставлена, доступа к production нет. Не утверждать, что точная причина на его сервере доказана.
- Проверка текущего кода и HTTP: недавно истёкший (1 день) клиент получает service в обоих форматах; истёкший 30 дней — только notice и нулевые sync errors при стандартных 7 днях, потому что срок считался от original expiry, не от добавления node. Это реальный воспроизводимый сценарий симптома, но не доказанная prod-причина.
- Новый общий режим subscription_expired_grace_days='0' = «До продления основной подписки»: read/save/settings/preference rules и перенос допускают 0. Старые default/сохранённые 3/7 сохранены; после установки оператор ДОЛЖЕН выбрать 0 и отметить свой service node. Индивидуальные grants приоритетнее: вернуть default либо unlimited для нужного клиента. Обновление само не открывает бессрочный доступ и не продлевает основной VPN.
- Реальная ошибка supportAccess: unlike isClientExpiredAt сырые seconds считались ms, notice видел актуальное истечение, support видел 1970/dead window. Единый threshold <10^10 seconds→ms для main/grant base/until в lib_expired_support, без переписывания базы. До исправления новый тест false вместо true, после pass.
- supportAccess.reason и supportReasonText показывают причину в редакторе клиента (not-expired/no-expiry/window-ended/disabled/activation-pending/node-disabled) отдельно от sync status: ожидание / ошибка / учётная запись синхронизирована. UI node hints теперь объясняет, что errors=0 не означает eligible, срок 3/7 от expiry; настройки и подсказки add/edit отражают 0. Две дополнительные indexed SELECT на пару в render только для показанных клиентов/служебных узлов, без сетевых вызовов.
- tests/support-shared-panel-http: расширен до 4 вариантов modern/token и legacy/password × expiry 1/30 дней. В old30 воспроизводит отсутствие service в SUB/JSON и ноль ошибок, сохраняет 0 через настоящий POST settings, затем проверяет notice+реальный service config, оба формата и отсутствие expire/total (userinfo включён), причины UI, repair map.enabled=0 при refresh, renewal/hide/disable/restart и прежний UUID/backup restore. Опасная ручная v3 attachment по-прежнему fail closed. Платные срок/UUID/лимит не меняются. Unit: seconds/ms, глобальный read0, old100days/disabled/pending/individual-priority и profile validate0.
- Целевой основной набор 43/43 pass; расширенный release-набор: 59 тестов, 55 pass, 4 platform skip, 0 fail (work/expiry-release-target-2.7.14.log). Полный: 229, 204 pass, 9 прежних fail, 16 skip, категории совпадают с 2.7.13 (Python PATH ×3; VM budget; node-inbound/CSS/UX grace/device grace; workspace RBAC). Полный набор не зелёный. Синтаксис app/module/helper и 20 EJS успешно. Нет проверки production/реального приложения Telegram.
- package/lock/VERSION/update/README = 2.7.14; docs/UPDATE_2.7.14.md с прозрачной диагностикой и обязательным выбором режима. Накопительный PATCH_FILES/helper для 2.7.7–2.7.13; дополнительно включает lib_settings_profile.js и views/preferences.ejs. Пакетирование work/package_expiry_2_7_14.ps1 с manifest/hash/LF/version checks, предыдущие ZIP сохраняются. Не установлен/не опубликован. Ставить на Nexus, не panel-script/nodes. Серверные Telegram routing правила не менялись.

Изменены: app.js, lib_expired_support.js, lib_settings_profile.js, views/settings.ejs/nodes.ejs/node_edit.ejs/clients.ejs/preferences.ejs, tests/expired-support.test.js/support-shared-panel-http.test.js/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md, docs/UPDATE_2.7.14.md, PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh.

2026-10-15 — Nexus 2.7.13, несколько автоподключений:

- Пользователь просит несколько автоподключений вместо одного. В текущем backend уже были многозаписная auto_select_profiles, INSERT при создании и цикл выдачи всех enabled-профилей в JSON. Один профиль не был ограничением БД. Доработан UX: ссылка «Добавить автоподключение», GET /nodes?tab=add&create=auto_select сразу выбирает нужный тип и вкладку; success сохраняет create-режим с пустой формой, менеджер даёт «Создать ещё». Ошибки virtual create сохраняют режим. Названия/пулы/приоритет/аварийный/проверки независимы, shared nodes между профилями разрешены.
- Headless Edge выявил реальный browser-only blocker: поздний legacy auth pass заново включал required api_token в скрытом auth-контейнере виртуального профиля, native validation не давала отправить форму. Контейнер стал fieldset с disabled в auto-режиме (включая initial HTML); setNodeTypeElement переключает его disabled. Даже повторное включение отдельного input теперь не возвращает credentials в validation/FormData. Обратно в 3x-ui/Remnawave auth включается; node_edit не менялся.
- tests/subscription-portal-traffic.test.js: новый настоящий HTTP-тест создаёт три профиля с пересекающимися пулами, проверяет независимые имена/интервалы/outbound и balancer tags/JSON всех профилей + физические регионы/SUB, неверный пул/CSRF, отдельные edit/toggle/delete и restart. В существующем auto-select assertion исправлены старые selector/fallback под уже существующий безопасный blackhole, не менялась логика Xray.
- Опциональный NEXUS_PLAYWRIGHT_MODULE + NEXUS_UI_SCREENSHOT_DIR: Edge desktop 1440 и mobile 390, реальная кнопка/POST двух следующих профилей, переходы 3x-ui→Remna→auto, поздний auth pass, отсутствие реквизитов панели в POST, пустая auto-форма после создания, no JS errors/no horizontal overflow. Проверка успешно выполнена локально. Screenshots work/ui-qa/multi-auto-{1440,390}.png просмотрены, не входят в ZIP. Реальное приложение пользователя/боевой сервер не проверялись.
- Целевой набор: 46, 42 pass, 4 platform skip, 0 fail. Полный: 224, 199 pass, 9 прежних fail, 16 skip; на одно старое падение меньше после актуализации selector/fallback assertion. Оставшиеся категории: Python PATH ×3, VM subscriptionRequestBudget, node-inbound/CSS/UX grace/device grace assertions, workspace RBAC. JS/EJS 20/helper bash -n успешно. Полный набор не зелёный; логи work/*2.7.13*.log.
- package/lock/VERSION/update/README = 2.7.13. docs/UPDATE_2.7.13.md, cumulative PATCH_FILES/helper для 2.7.7–2.7.12 (включает 2.7.12 service identities и прежние оптимизации/Remna routing). Пакетирование work/package_auto_2_7_13.ps1, manifest/hash/LF/version verification. Не установлен, не опубликован в GitHub. Предыдущие ZIP не перезаписывались. Ставить на Nexus, не panel-script/nodes.

Изменены этапом: app.js, views/nodes.ejs, tests/subscription-portal-traffic.test.js, tests/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md, docs/UPDATE_2.7.13.md (новый), PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh. Новая серверная балансировка не создавалась: это несколько независимых клиентских Xray JSON профилей, обычный SUB не переносит Observatory.

2026-10-15 — Nexus 2.7.12, служебный доступ на той же панели 3x-ui:

- Пользователь хочет Telegram после окончания подписки на том же сервере/панели, другом inbound/порту. Старый validateSupportIsolation запрещал любой общий URL.origin. Теперь для обычной 3x-ui допускаются разные inbound ID, но не один и тот же. Remnawave/global Squad и специальные типы остаются под старым запретом. Нет доступа к production, ничего на сервере не менялось, GitHub не публиковался.
- Новая client_support_identities (FK clients/nodes cascade, UNIQUE UUID/email/subId): ключ сохраняется до сетевого вызова. supportRemoteClient подменяет только provider-facing копию клиента и opts; все UUID/email fallback в ensure/update видят служебную запись, не paid identity. Исходные local clients и обычные mappings не переименовываются. Новые служебные mappings сразу policy-only; снятие роли оставляет эту identity выключенной, не делает её платной.
- Новый API перед глобальным update/attach проверяет совпадение UUID/email и единственный подтверждённый inbound; неизвестная/лишняя привязка — fail closed с durable error/retry. Старые canonical mappings на общей панели отвергаются: создать новый пустой inbound/новый Nexus node, не удалять обычных клиентов. Существующие отдельные служебные панели сохраняют старые ключи. Импорт служебных записей в canonical users запрещён, create-missing идёт через isolated ensure, обычные лимиты и activation guard сохранены.
- Добавление узла с expired_support + import_clients отклоняется до INSERT; UI nodes/node_edit/settings объясняет тот же URL/API Token, отдельный inbound/порт, не импортировать и обязательные серверные Telegram-правила. Маршрутизация сервера автоматически НЕ меняется. Надёжный text-only без видео этими правилами невозможен. Новый server routing template не создавался: теги/рабочая конфигурация 3x-ui пользователя не предоставлены.
- Backup JSON export/restore сохраняет identities (restore после clients/nodes, delete до них). Diagnostics не считает намеренно отдельный service UUID расхождением. Проверка при API update scoped по client_id, не полный проход всех mappings на каждого пользователя.
- tests/expired-support: обновлён старый запрет, добавлены identity persistence/override/stale map, v3 attachment guard и запрет импорта. Новый tests/support-shared-panel-http.test.js: реально запущенная Nexus + фикстурные legacy/password и modern/token панели, общий URL, inbound 1/2 и порты 1443/2443, background provisioning, SUB/JSON с isolated UUID, обычная expired identity остаётся disabled/со своим лимитом, дубликат inbound rejected, renewal/restart и backup restore. Modern: опасная ручная привязка [2,1] не включает аккаунт, удаление лишней привязки позволяет retry. Серверный Telegram трафик и телефон не проверялись.
- Целевой набор: 56 тестов, 52 pass, 4 platform skip, 0 fail. JS app/module и 20 EJS + bash -n helper успешно. Полный исторический набор: 223, 197 pass, 10 прежних fail, 16 skip (категории те же 2.7.11: Python PATH ×3; VM budget; node-inbound/CSS/UX grace/device grace/autoselect quota assertions; workspace RBAC). Логи work/*2.7.12*.log не входят в архив. Полный набор не зелёный.
- Версии package/lock/VERSION/update/README 2.7.12, docs/UPDATE_2.7.12.md с порядком и установкой. Накопительный PATCH_FILES/helper для базы 2.7.7–2.7.11; архив только для сервера Nexus, не --update panel-script-v1. Пакетирование work/package_support_2_7_12.ps1, проверка manifest/hash/LF и версии, без node_modules/баз/.env. Предыдущие ZIP сохранены.

Изменены: app.js, lib_expired_support.js, views/nodes.ejs/node_edit.ejs/settings.ejs, tests/expired-support.test.js, tests/support-shared-panel-http.test.js (новый), tests/client-activation.test.js, tests/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md, docs/UPDATE_2.7.12.md, PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh. Незавершённый panel-script-v1 cascade conflict не затрагивался.

2026-10-15 — Nexus 2.7.11, маршрутизация Remnawave в JSON:

- Найден прямой hardcoded запрет Remnawave в isRoutingEnabledForNode: UI разрешал назначение, но JSON не содержал routing. Убран только Remnawave-запрет; логика режима/выбора узлов/global off сохранена. Это клиентские правила, серверные Config Profiles/relay/exit не меняются.
- views/routing.ejs: явное пояснение 3x-ui/Remnawave и JSON Nexus; исправлено вводящее в заблуждение обещание direct при выключенной маршрутизации. SUB/VLESS не несут Xray routing; отдельный Happ-профиль не включается.
- tests/remnawave-routing.test.js: 3 воспроизведения до исправления, затем 3 pass; aliases, assigned/unassigned, global off, legacy allNodes/exclusions. tests/node-traffic-http.test.js дополнен реальным POST routing, JSON array/single, двумя режимами на двух Remna узлах, block/direct/proxy, снятием назначения, выключением и равенством транспорта.
- HTTP fixture Remnawave 3.3.0 теперь включает XHTTP host/path/mode/padding: проверено сохранение xPaddingObfsMode и пути music-cascade, VLESS UUID/TLS/address. Fixture не поддерживает мутации серверных Config Profiles. Свежий целевой набор 27/27, JS check и 20 EJS успешно; performance benchmark прежний порядок 16–29 мс главная. На телефоне/боевом сервере не проверялось.
- Полный прогон: 218 тестов, 192 pass, 10 прежних fail, 16 platform skip. Категории совпадают с записью 2.7.10 (Python PATH ×3, VM subscriptionRequestBudget, старые assertions node-inbound/CSS/UX grace/device grace/autoselect quota, workspace RBAC). Полный набор не зелёный.
- Пользователь подтвердил ускорение после установки предыдущей 2.7.10. 2.7.11 не установлена и не опубликована в GitHub. Версии package/lock/VERSION/update/README=2.7.11, инструкция docs/UPDATE_2.7.11.md, накопительный patch manifest + прежний Docker-helper (со ссылками на новую инструкцию), поддерживаемая исходная база 2.7.7–2.7.10.

Изменены: app.js, views/routing.ejs, tests/remnawave-routing.test.js (новый), tests/node-traffic-http.test.js, tests/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md, docs/UPDATE_2.7.11.md (новый), PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh. Незавершённый вопрос переиспользования каскада panel-script-v1 при смене exit не смешивался с этим исправлением Nexus.

2026-10-12 — Nexus 2.7.10, оптимизация входа/страниц (локально, не production):

- Главная отдаёт лёгкий HTML без общего/нодового/top/live пересчёта истории, удалённого online даже при `?online=1`, записи и чистки traffic snapshots. Трафик/top/modal лимитов читаются защищёнными AJAX; скрытые тяжёлые разделы загружаются при открытии. Лимиты в разделе top — пагинация 20/50/100/200/Все, поиск по всему загруженному набору.
- Асинхронный bcrypt login с повторной проверкой актуального пользователя и lockout после await. Исправлено dereference CSRF после синхронного уничтожения сессии в logout. Старые хэши, RBAC и CSRF сохранены. Git execFile асинхронный/параллельный, TTL 60 секунд.
- `lib_performance.js`: ограниченный process-local read cache, TTL от завершения, single-flight, очистка ошибок; cooperativeMap/yieldToRequests. Top/live отчёты уступают event loop между небольшими группами. Online TTL 5 секунд, без клиентского HTTP-кэша; это не кэш решений по доступу/квотам.
- Remnawave: bootstrap/force/reset/суточная сверка до 370 дней, остальные чтения — последние три календарных дня; пропущенный интервал сохраняется, late старых дней подбирается суточной сверкой. Миграция `node_usage_state.full_synced_at`; значение сохраняется только после успешной записи series. Ledger/reset_base/неподмена userTraffic не менялись. Старый API-кэш очищается раз в 30 секунд, не накапливается по датам.
- Каталог Remnawave за один sweep дедуплицируется по URL и hash реальных заголовков авторизации, включая Caddy key. Два разных доступа не объединяются. Локальные XUI-записи по 25 в транзакции, Remna update+snapshot и общий snapshot в транзакциях. Нет await внутри write transaction. Старые retention сроки, индекс created_at_ms и часовая фоновая чистка вместо чистки при переходе.
- `Server-Timing: nexus;dur` HTML и приватно-безопасные slow_request логи управления. Порог NEXUS_SLOW_REQUEST_MS=1000 (минимум 100), без query/body/password/subslug.
- Версии package/lock/VERSION/update/README=2.7.10. Новая инструкция docs/UPDATE_2.7.10.md, накопительный manifest + helper для 2.7.7/2.7.8/2.7.9. На сервер Nexus, не на ноды. GitHub не публиковался.
- Локальный HTTP benchmark одинаковых synthetic 1000 клиентов/120000 снимков: исходная 2.7.9 из предыдущего ZIP — dashboard?online=1 955/899/914 мс, HTML 947696 bytes; оптимизация обычно 18–33 мс, HTML 226367 bytes. Top около 420 мс, /settings во время top 64–75 мс. Это не измерения VPS. Baseline сохранён в work/baseline-2.7.9-performance.
- Новый `tests/performance*.test.js`: HTTP большой базы/параллельного онлайн, cache/yield, incremental/reset/API failure, top counter resets; node-traffic HTTP дополнен directory-dedup assertion. Edge 1440/390 успешно: вкладки, отложенные отчёты, лимиты 20→50/страница2/поиск, no overflow/no JS errors. Картинки work/ui-qa/performance-dashboard-*.png, не в ZIP.
- Целевые проверки 65/65 и набор новых HTTP/installer/UI assertions 36 (32 pass/4 platform skip), JS/EJS 20. Полный исторический прогон после актуализации четырёх assertions под оптимизацию: 215, 189 pass, 10 fail, 16 skip. Те же известные категории предыдущего этапа: Python PATH (3), VM subscriptionRequestBudget, node-inbound-sync assert, CSS stylesheet assert, UX grace-node, device grace-node, autoselect/node quota old assert, workspace RBAC worker-profile. Полный набор не зелёный. Последующая очистка API-кэша отдельно перепроверяется целевыми тестами.

Изменённые файлы этапа: app.js, lib_performance.js (новый), lib_node_traffic.js, lib_access.js, views/dashboard.ejs, public/js/dashboard-quotas.js, tests/performance.test.js (новый), tests/performance-http.test.js (новый), tests/node-traffic-http.test.js, tests/usage-directory-2.7.3.test.js, tests/spectrum-clear-2.1.test.js, tests/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md, docs/UPDATE_2.7.10.md (новый), PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh. Пользователь попросил исправление оптимизации; боевой сервер не доступен, не устанавливалось. Последующий этап — проверить реальные timings после применения.

2026-10-08 — Nexus 2.7.9, текущий этап:

- `lib_client_directory.js`: SQL-пагинация и поиск/фильтры до LIMIT, 20 по умолчанию, 50/100/150/200/Все; общий COUNT и карточки статистики. Кириллический поиск/ё, буквальные SQL-wildcards, индексы; онлайн-фильтр использует live endpoint.
- `app.js` / `views/clients.ejs`: сериализуются только пользователи страницы, их метки, устройства, лимиты и редакторы. Poll usage ограничен ID страницы; «Выбрать все» — текущая страница, число и навигация снизу. Поиск с debounce и восстановлением фокуса; фильтры/страница сохраняются после редактора. Убрана запись общего traffic snapshot при простом открытии /clients.
- `lib_device_refresh.js` и `views/settings.ejs`: manual по умолчанию; replace-stale (одна привязка, заполненный лимит, 72 часа по умолчанию) и reset-on-refresh, требующий явного acknowledgement при сохранении. Регистрация/замена одной транзакцией, только с валидным HWID и разрешённым новым GET; HEAD/expired/disabled не освобождают слоты. Это не обнаружение удаления приложения, не отзыв скачанных ключей и не очистка native Remnawave HWID.
- Remnawave: предпочтение числового user.id, один идентификатор в PATCH 3.3+, подтверждение общего лимита чтением обратно. Старый LIMITED проверяется ПОСЛЕ синхронизации общего лимита; независимая статистика/сквады не подменяются общим счётчиком. Обычное ACTIVE-обновление не делает лишних GET native-лимита; свежий remoteUser возвращается из scoped reconcile.
- Для квот 5/50 на разных физических нодах общий лимит клиента=0, уникальная физическая UUID и эксклюзивный сквад каждой ноды. Нельзя отличить CDN-методы одной физической ноды этим API. Для глобальных 50 native user trafficLimitBytes=50 ГБ, а локальные квоты не меняются.
- Версии package/lock/VERSION/update.json/README=2.7.9, инструкция `docs/UPDATE_2.7.9.md`. Накопительный архив `Nexus-Panel-2.7.9-clients-patch.zip` по PATCH_FILES.txt и helper для существующей базы 2.7.7/2.7.8. На боевом сервере не установлен, GitHub не опубликован.
- Основной целевой набор 45/45, 20 EJS compile, JS syntax; HTTP-фикстура строго 3.3.0 id-only PATCH, реальный edit 5→50 и LIMITED repair в той же выдаче, страницы 20/50/100/150/200/All, scoped poll, HWID manual/stale/full, CSRF/RBAC.
- Браузер Edge 1440/390: выбор размера, переход, фильтр ноды, переполнение, отсутствие JS-ошибок; скриншоты рабочего `work/ui-qa/clients-pagination-*.png`, не в архиве.
- Расширенный набор 79: 76 успешно / 3 старых падения. Эти три подтверждены на отдельной копии 2.7.8: grace-node после истечения, устаревший autoselect fallback assert, RBAC worker-profile 403 vs 200. Финальный полный исторический набор: 209, 183 pass, 10 fail, 16 skip. Версионное ожидание обновлено на 2.7.9 и проходит. Оставшиеся падения: три client-transfer из-за отсутствия Python в PATH; API-VM без subscriptionRequestBudget; устаревший node-inbound-sync assert; CSS stylesheet assert; UX grace-node assert; subscription-device-registry grace-node; subscription-portal-traffic autoselect; workspace RBAC worker-profile. Эти ошибки присутствовали в предыдущем полном прогоне 2.7.8; отдельное повторение на baseline выполнено только для указанных трёх. Полный набор не зелёный, это не скрывать.

Изменённые файлы этого этапа: PATCH_FILES.txt + apply-node-traffic-update.sh. Отдельной автоматической связи с прод-сервером нет. Последний запрос пользователя — реализация пагинации, синхронизации квот и выбираемой политики HWID; оптимизация всего проекта пока отдельно не проводилась.

2026-10-05 — Nexus 2.7.8, независимый учёт Remnawave по физическим нодам:

- Новый `lib_node_traffic.js`: ежедневные серии API, SQLite-история, независимые базовые отметки сброса, безопасное ограничение эксклюзивным сквадом; недоступный API не подменяется общим userTraffic.
- `app.js`: фоновый опрос, импорт/выдача подписки не копируют общий расход; native trafficLimitBytes только для общего лимита клиента. Индивидуальный сброс не трогает соседние ноды; массовый All явно сбрасывает native account один раз.
- `lib_access.js`: read/write/bulk права новых маршрутов; существующая CSRF-защита сохранена. `lib_client_traffic_reset.js` принимает numeric Remnawave IDs.
- Главная → новая страница `/node-traffic`, узлы → клиенты, даты/пресеты, выбор клиентов и сброс; доработаны `views/clients.ejs`, `nodes.ejs`, `node_edit.ejs`. Календарный отчёт Remnawave на старой главной также использует новый дневной ledger.
- Версии синхронизированы в package/lock/VERSION/update.json. Инструкция `docs/UPDATE_2.7.8.md`, архив патча по `PATCH_FILES.txt`; Docker-helper с полной резервной копией.
- Официальные API-контракты статистики сравнены на всех существующих тегах 3.3.0–3.4.4, файл одинаков. Backend/node версии не смешивать; будущая несовместимая форма даёт предупреждение, а не fallback общего счётчика.
- `npm run test:node-traffic`: 27/27 успешно, включая реальный HTTP-процесс и SQLite с фикстурной панелью. Последний расширенный целевой набор: 61 тест, 57 успешно, 4 пропуска платформенных проверок, 0 падений. Node check и 20 EJS compile успешно. Bash syntax Docker-helper успешно. Edge headless: 1440/390, выбор ноды, фильтр, выбор клиентов и горизонтальное переполнение — успешно; изображения в рабочем `work/ui-qa`, не в патче.
- Полный исторический набор до последнего добавленного migration-теста: 197 тестов, 171 успешно, 10 падений, 16 пропусков. Остались старые ожидания CSS/grace/autoselect/RBAC, VM apiGet не передаёт subscriptionRequestBudget, node-add ждёт старый текст скрытого endpoint, Python3 отсутствует в PATH Windows. Не заявлять, что полный исторический набор зелёный. Привязанные к новому поведению тесты расхода обновлены, остальные функции не переделывались ради старых assert.
- Боевой сервер пользователя и настоящая панель Remnawave не проверялись. Старые ошибочные `client_nodes` и Remnawave node/client snapshots архивируются в recoverable SQL-таблицах; старые общие snapshot-графики до миграции остаются историческими и могут быть неточными. Начальный счётчик — доступная история до 370 дней; старый точный момент общего сброса не угадывается. Для новой квоты нужен явный независимый сброс.

Изменённые файлы этого этапа: `PATCH_FILES.txt` + `apply-node-traffic-update.sh`.

2026-09-25 — уровни приоритета профиля «Автовыбор»:

- `app.js`: миграция для основного пула, приоритетного узла и аварийного узла;
  старые профили без этих полей продолжают работать как leastPing.
- `views/nodes.ejs`: выбор трёх уровней при создании и редактировании профиля.
- JSON Xray: приоритетный balancer с Loopback-переходом на основной leastPing
  пул; fallback основного пула указывает на аварийный узел или blackhole.
- `tests/usage-directory-2.7.3.test.js`: проверка порядка приоритет → пул → резерв.
- Проверки: 11 тестов файла прошли, `node --check app.js` прошёл. `scripts/check-views.js`
  не запустился из-за отсутствующей зависимости `ejs`; реальный Xray-клиент и
  переключение на телефоне не проверялись.

2026-09-05 — отложенный старт срока клиента:

- `app.js`: миграция, первое HWID-устройство, единая дата окончания,
  выключенные до активации удалённые учётные записи и повтор синхронизации;
- `views/clients.ejs`, `views/open_sub.ejs`: галочка при создании/редактировании,
  статус ожидания и пояснение клиенту;
- `scripts/client-transfer.py`: перенос настроек активации;
- `tests/client-activation.test.js`: 7 успешных SQLite-проверок, API узлов заменены;
- `docs/CLIENT_ACTIVATION.md`: поведение, ограничения и установка обновления.

Проверен синтаксис app.js и запуск Python-инструмента переноса. Полный запуск
панели требует её npm-зависимостей; проверка с реальными узлами не выполнялась.

Nexus Node, Этап A от 2026-09-04:

- добавлен отдельный dependency-free агент `node-agent/agent.js` для Node.js 22;
- панель выдаёт одноразовый enrollment-код и принимает только исходящие
  подписанные запросы Node → Panel, поэтому на VPS не открывается админ-порт;
- добавлены heartbeat, статус, отзыв ноды, HMAC+nonce защита и очередь операций;
- реализованы безопасные операции health и тест/атомарное применение Xray config;
- это фундамент: существующие 3x-ui/Remnawave и синхронизация клиентов не менялись.

Предыдущее изменение — исправления интерфейса, трафика Remnawave и перенаправления от 2026-08-29:

- у профиля «Автовыбор» текст кнопки «Изменить» снова контрастный и читаемый;
- в редакторе клиента выровнены SUB, JSON, QR и открытие подписки, UUID больше не растягивает верхнюю сводку;
- в карточке информации о клиенте выровнены устройства и три действия с подпиской;
- счётчик Remnawave читает официальный `userTraffic.usedTrafficBytes` и совместимые варианты ответа API; если для нового узла ещё нет исторического снимка, показывается честный текущий общий счётчик;
- лимит IP и лимит устройств Remnawave разделены: `trafficLimitBytes`/IP-настройка больше не подменяет `hwidDeviceLimit`; по умолчанию устройств 1, IP без лимита;
- перенаправление разделяет публичный адрес подписки и локальный адрес firewall, поэтому работает на VPS за NAT;
- добавлен выбор: helper на текущем сервере либо отдельный уже настроенный сервер, для которого панель только меняет адрес в подписке;
- для Remnawave целью перенаправления теперь служит выбранный Host и его порт, а не URL панели управления;
- исправлена ручная проверка активных правил и отображение публичного домена/IP.

Дополнение от 2026-08-29:

- профили «Автовыбор» теперь отображаются отдельными строками в основном списке узлов;
- строка участвует в поиске, фильтре, счётчике и пагинации, но не вмешивается в порядок физических узлов;
- справа показываются выбранные физические узлы, URL и интервал HTTP-проверки;
- кнопка «Изменить» открывает нужный профиль во вкладке добавления, автоматически раскрывает редактор и сохраняет отмеченные узлы;
- на мобильной версии строка раскрывает компактные действия «Изменить» и «Включить/Выключить».

Основная реализация:

Реализован виртуальный узел **«Автовыбор»**:

- создаётся в разделе «Узлы → Добавить узел» отдельным типом;
- администратор задаёт название, emoji/флаг, выбирает минимум два физических узла, URL и интервал проверки;
- профиль добавляется первым сервером в JSON-подписку, при этом обычные физические регионы не скрываются;
- Xray `observatory` выполняет HTTP-запрос через каждый кандидат — это проверяет не только доступность порта, но и реальный выход в интернет;
- Xray `leastPing` выбирает доступный outbound с минимальной задержкой, а недоступные после проверки не участвуют в выборе;
- первый кандидат указан как `fallbackTag`, чтобы конфигурация могла начать подключение до накопления первых результатов наблюдения;
- профиль работает только в JSON-подписке. Обычный список `vless://` не умеет передать balancer/observatory;
- срок, лимит и доступ не дублируются в профиле: используются настройки клиента и связи клиента с выбранными физическими узлами;
- созданные профили можно редактировать, включать, выключать и удалять;
- профили входят в полную резервную копию панели.

## Изменённые файлы

- `app.js` — таблица и CRUD профилей, резервная копия, генерация JSON с balancer/observatory.
- `app.js`, `lib_nexus_node_control.js` — схема БД и HTTP control plane Nexus Node.
- `node-agent/agent.js`, `node-agent/install.sh`, `node-agent/README.md` — агент и установка на VPS.
- `views/nexus_nodes.ejs`, `views/partials_header.ejs` — интерфейс подключённых нод.
- `tests/nexus-node-control.test.js` — сквозной enrollment, защита replay и очередь health.
- `docs/NODE_ARCHITECTURE.md`, `README.md`, `package.json` — актуальная спецификация и проверки.
- `views/nodes.ejs` — создание и управление профилями «Автовыбор», контрастная кнопка редактора.
- `views/clients.ejs`, `views/partials_footer.ejs` — ровные действия и компактный UUID в окнах клиента.
- `views/dashboard.ejs` — текущий накопительный счётчик нового Remnawave-узла рядом с периодом.
- `views/redirects.ejs` — публичный адрес, локальный/внешний режим и фактическая цель Remnawave Host.
- `scripts/forwarder.sh` — wildcard DNAT для VPS, где публичный IP приходит на приватный интерфейс через NAT.
- `public/css/spectrum-clear.css` — адаптивное оформление профилей и исправленных клиентских действий.
- `tests/subscription-portal-traffic.test.js` — интеграционная проверка JSON-профиля.
- `tests/ux-2.7.1.test.js` — проверка отображения профиля в списке и перехода к редактору.
- `tests/redirect-remnawave-ui.test.js` — регрессии перенаправления, Remnawave-трафика, лимитов и интерфейса.
- `.gitattributes` — восстановлено обязательное LF-окончание строк для shell-скриптов; файл отсутствовал во входном ZIP, хотя тест установщика его требует.
- `PROJECT_HANDOFF.md` — этот журнал.

## Важные решения

1. Не создавать фиктивный клиент или inbound в каждой 3x-ui: автовыбор является клиентской Xray-конфигурацией поверх существующих узлов.
2. Не использовать обычный ICMP/TCP ping как признак исправности: узел может отвечать, но не иметь выхода в интернет.
3. URL проверки по умолчанию: `https://cp.cloudflare.com/generate_204`; разрешены только HTTP/HTTPS URL без учётных данных.
4. Интервал ограничен диапазоном 10–300 секунд, чтобы не создавать чрезмерную нагрузку.
5. Для конкретного клиента в профиль попадают только реально доступные ему VLESS-записи выбранных включённых узлов.
6. Текущее «Перенаправление» — это L4 DNAT/SNAT с заменой адреса в ссылке. Xray-каскад через `dialerProxy` является отдельной JSON-only цепочкой outbounds, поэтому не подмешивается в этот режим и не заменяет внешний SUB/VLESS endpoint.
7. В локальном режиме пустой `bind_ip` означает безопасное правило на входной порт всех локальных IPv4; публичный домен/IP при этом хранится отдельно в `public_host` и попадает в подписку.
8. В режиме отдельного сервера панель не обещает управлять чужим firewall: она только меняет endpoint, а DNAT/прокси остаётся под управлением внешнего скрипта.

## Проверки

- `node --check app.js`, `node --check lib_nexus_node_control.js`, `node --check node-agent/agent.js`, `node --check tests/nexus-node-control.test.js` — успешно.
- Полный EJS/интеграционный прогон требует `npm ci`; во входном архиве нет `node_modules`, а на Windows-хосте доступен `node`, но отсутствует `npm`.

- `node --check app.js` — успешно.
- `node scripts/check-views.js` — 16 EJS-шаблонов успешно.
- `node --test --test-concurrency=1 tests/*.test.js` — 80 исполняемых проверок успешно; 4 Linux/Bash-проверки пропущены на Windows-хосте, синтаксис helper отдельно проверен через Git Bash.
- Интеграционный тест подтверждает: профиль стоит первым, содержит два кандидата, `leastPing`, `fallbackTag`, HTTP-observatory и не скрывает обычные регионы.
- Xray 26.7.28: минимальная конфигурация с теми же `balancers`/`observatory` проверена командой `xray run -test`; результат `Configuration OK`.
- После дополнения списка: `node --check app.js`, проверка 16 EJS-шаблонов и 9 целевых тестов — успешно.
- После последних исправлений: визуально проверены страницы узлов, редактор клиента, карточка клиента и перенаправление при 1920×1080; размеры и контраст действий подтверждены браузером.

## Как передавать результат

- Сначала сравнить рабочую копию с исходным архивом.
- Пользователю передавать ZIP **только с изменёнными файлами**, сохраняя пути каталогов.
- Не добавлять `node_modules`, временные базы, журналы, `.env`, секреты и тестовые каталоги `.tmp-*`.
- Отдельно приложить список файлов и результаты проверок.
