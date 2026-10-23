# Nexus Panel — журнал продолжения разработки

Последнее обновление: **2026-10-23**

Этот файл нужно читать первым при продолжении работы из другой учётной записи или нового чата. После каждой доработки обновляйте разделы «Последнее изменение», «Изменённые файлы» и «Проверки».

## Исходная версия

- Текущая рабочая база взята из архива `Nexus-Panel-main (3).zip`.
- Архив не совпадает с предыдущей рабочей копией 2.7.0: в нём добавлены SVG-флаги и доработаны совместимость Remnawave, прокрутка страницы узлов и соответствующий тест.
- Папка `node_modules` в исходный архив не входит и в итоговые архивы изменений попадать не должна.

## Отложенные замечания пользователя

2026-10-21 — вёрстка страницы «Узлы», состояние без добавленных узлов:

- Пользователь прислал desktop-скриншот и попросил только взять на заметку для будущего исправления, не исправлять сейчас. Файл: C:/Users/user/AppData/Local/Temp/codex-clipboard-4d149cf5-fc67-4330-83fb-0a204fc87351.png.
- Видимые симптомы: пустой список растянут почти на весь экран; сообщение «Пока нет добавленных узлов» прижато к левой границе без отступа относительно заголовка; кнопка «Добавить автоподключение» визуально отделена от блока списка и почти примыкает к его верхней рамке.
- При будущей правке согласовать отступы/расположение действий и компактное пустое состояние, проверить desktop/mobile и список с узлами. Причина CSS пока не исследовалась, исправление и новая сборка по этому замечанию не выполнялись.
- Выполнено в 2.7.17 после запроса «доработай и исправь ошибки»: padding=0 и desktop flex/100dvh растягивали пустой список; добавлены empty-state/компактная высота, действия перенесены в заголовок. Локальные HTTP+Edge 1440/390, переход к форме и отсутствие overflow проверены, screenshots просмотрены. Исходный пункт выше сохранён как история запроса.

## Последнее изменение

2026-10-23 — Nexus 2.7.20, управление каталогом/автовыбором:

- Запрос: показывать способ подключения у кандидатов автовыбора (чтобы различать TCP и XHTTP с одинаковыми странами), перенести создание рядом с «Добавить узел», сортировать по четырём заголовкам тип/транспорт/статус/активность.
- views/nodes.ejs: connectionLabel использует Map уже загруженного enriched-каталога, полный transport_label без удаления RAW/TCP, RAW отображается как TCP (RAW), ID в pool checkbox и preferred/emergency options и при создании, и при edit. Дополнительных SQL/API нет; неизвестный транспорт не выдумывается, Remna без transport info остаётся API. Боковая сводка оставлена компактной: длинная строка транспорта ломала её flex-вёрстку, удалена после визуальной проверки.
- Создание auto перенесено из nodes-modern-head в desktop/mobile top nav. Обновлены старые тесты расположения/visible locator. CSS переносы транспортной строки и мобильных вкладок, focus-visible кнопок сортировки.
- Сортировка в браузере всего DOM-каталога перед пагинацией: asc/desc/manual, стабильный original-index tie break; numeric enabled/activity и ru collator type/transport. Фильтры/live poll повторно применяют сортировку. Original Map обновляется после успешного ручного reorder; сортировка ничего не отправляет. На sorted view отключены drag/стрелки/longpress и saveNodeOrder guard, reset возвращает manual. Мобильный select синхронизирован с заголовками. Активность означает health state, не скорость/расход; auto имеет прежнюю условную online-метку.
- Расширен optional Edge-блок tests/client-node-editor-http.test.js: реальные UI asc всех ключей/desc state/third click/reset на 1440, mobile select390, неизменные nodes.sort_order/remote writes, открытие create и видимого edit пула с транспортом. Ранний тест ERR_ABORTED исправлен ожиданием навигации после клика; forced click не используется. 4/4 включая HTTP. Screenshots work/ui-qa/2.7.20 просмотрены.
- Целевой 26: 22 pass/4 skip/0 fail; полный256:230pass/9прежнихfail/17skip, имена точно совпадают с2.7.19. JS/20EJS проверены. Логи work/node-ui-2.7.20.log, nodes-target-2.7.20.log, nodes-full-2.7.20.log. Нет проверки на реальном VPS/Docker/физическом телефоне.
- Выпуск2.7.20: version metadata/helper, README/CHANGELOG/docs UPDATE_2.7.20, cumulative manifest+doc. work/package_node_catalog_2_7_20.ps1 → outputs/Nexus-Panel-2.7.20-node-catalog-patch.zip. Локальный ZIP, не опубликован/не установлен на сервер пользователя; старые ZIP не изменены.

Изменены: views/nodes.ejs, public/css/spectrum-clear.css, tests/client-node-editor-http.test.js/subscription-portal-traffic.test.js/clean-links-workspaces-http.test.js/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md/CHANGELOG.md/PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh, docs/UPDATE_2.7.20.md.

2026-10-23 — Nexus 2.7.19, неназначенные узлы в редакторе клиента:

- Запрос пользователя: после добавления 3x-ui/Remnawave узла без импорта всех клиентов он должен быть виден в «Узлы клиента» у любого пользователя без галочки; выбрать, задать ГБ и сохранить только этого клиента. Глобально отключённые узлы не показывать. Новый Finland XHTTP в общем списке был, в редакторе отсутствовал.
- Причина: GET /clients после оптимизации заполняет node_limits только реальными client_nodes; EJS ошибочно использовал их как каталог. Не возвращать SQL CROSS JOIN всех клиентов/узлов и не добавлять удалённые запросы при открытии. В views/clients.ejs редактор берёт уже загруженный enabled-каталог nodes, сопоставляет с node_limits через Map. Новые строки unchecked/пустые ГБ, старые сохраняют enabled/traffic_gb/service badge. Статистика/сводки остаются только по реальным связям. Добавлены ID и inbound/тип Squad для одинаковых названий.
- Backend POST /clients/:id/edit уже умеет пропускать unmapped unchecked, создавать ensureAggregatorClientOnNode только для checked и обновлять старые mappings. Product-код app.js не менялся. Реальные ограничения общей Remna-квоты и API не переопределялись. Глобально отключённые привязки остаются нетронутыми; включённые offline-узлы предлагаются, remote failure отображается существующим error message.
- Новый tests/client-node-editor-http.test.js: реальные isolated production Nexus HTTP процессы + mock legacy3xui/modern3xui (версии 2.5.8/3.10.2) и Remna3.3.0/3.4.5. Создание узла без массовых флагов; пустой/привязанный пользователь, страница2, unassigned/offline/disabled; POST select одного клиента, reuse identity, no duplicates, дробный/0/blank GB, uncheck и сохранение другого Squad, hidden-map unchanged, CSRF/negative before write, restart; GET не ходит к удалённым API. До EJS исправления 0/4 с точной missing-node ошибкой; после 4/4.
- UI опционально NEXUS_PLAYWRIGHT_MODULE + NEXUS_UI_SCREENSHOT_DIR в том же тесте: headless Edge 1440/390, реальные check/GB/кнопки all/none/save, проверка записанного mapping только beta, без JS errors/overflow. Клик используется на собственной кнопке формы в модалке (floatingSave снаружи закономерно перекрыт backdrop); force-click/DOM-submit не используются. Снимки work/ui-qa/2.7.19 просмотрены; прогон 4/4.
- Целевой набор 44: 36 pass/8 skip/0 fail. Полный 256: 230 pass/9 прежних fail/17 skip; названия fail совпадают с 2.7.18 (Python PATH×3/VM budget/старые inbound/CSS/grace/device-grace/RBAC). JS, 20 EJS и install/helper Bash syntax прошли. Журналы work/client-node-editor-*.log. Реальные VPS/удалённые версии API/Docker/Caddy/физический телефон не проверялись.
- Версия 2.7.19 в package/lock/VERSION/update/README/installer assertion/helper. docs/UPDATE_2.7.19.md; cumulative manifest добавляет новый тест/документ. Пакетирование work/package_client_node_editor_2_7_19.ps1 → outputs/Nexus-Panel-2.7.19-client-node-editor-patch.zip, без node_modules/.env/баз/логов, static Compose не заменяется. Локальный патч, не опубликован и не установлен на серверы пользователя. Старые ZIP не изменять.

Изменены: views/clients.ejs, tests/client-node-editor-http.test.js (новый), tests/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md/CHANGELOG.md, docs/UPDATE_2.7.19.md (новый), PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh.

2026-10-21 — Nexus 2.7.18, переключатель чистых ссылок:

- Запрос пользователя: сделать выдачу JSON `/ключ` и SUB `/ключ?format=sub` настройкой вкл/выкл. Добавлен `subscription_clean_urls` default `1`, сохраняющий поведение 2.7.17. Настройки → Общие настройки → Адреса панели и подписок. Off возвращает генерацию `/json/ключ` и `/sub/ключ`; оба handler-стиля всегда работают, иначе уже выданные клиентам ссылки ломались бы. Middleware и ограничения Caddy не выключаются галочкой. Короткие/зарезервированные ключи остаются legacy.
- Два массива defaults, GET/POST settings с marker `subscription_link_controls` (old form сохраняет выбор), revision при смене, профиль настроек с bool validation/fallback1. Переменная хранится в локальной app_settings своего workspace, не в общей control DB. Уточнена старая ложная подсказка о редиректе на rev: никаких редиректов приложения для смены ревизии нет.
- Найдена недоделка 2.7.17: clients.ejs всё ещё формировал /json/?raw=1 и /sub-plain/ во всех desktop/mobile вариантах. Копирование и QR, редактор и неиспользуемый сейчас client_detail переведены на общие генераторы; настройки базы/формата читаются один раз на render, не запрос на каждую кнопку/строку. API summary/Telegram/CSV/portal учитывают bool в публичных builders. Стандартная кнопка SUB добавлена в portal; специальные plain/Hiddify/Happ-адреса и import/deeplink поведение сохранены.
- Тесты: unit on/off/workspace/short/reserved и перенос bool; production HTTP settings on/off/old form/CSRF/revision, links в списке/редакторе/summary/portal, все четыре URL в обоих режимах, restart; реальные отдельные workspace workers с одним ключом и независимым выбором формата. Целевой 51: 42 pass/9 platform skip/0 fail. JS, 20 EJS, install/helper Bash syntax прошли.
- UI: headless Edge 1440/390, реальная галочка и сохранение формы в обоих состояниях, без JS errors/горизонтального overflow; screenshots work/ui-qa/2.7.18 просмотрены. UI тестирует production-mode локальную фикстуру (не VPS): dev-only UI inspector перекрывал мобильную sticky-save; обычная форма использует существующий floating save, он проверен кликом. Не исправляли несвязанную development overlay-вёрстку и не обходили actionability принудительным click.
- Полный набор 252: 226 pass/9 прежних fail/17 skip; имена fail совпадают с 2.7.17 (Python PATH×3/VM budget/старые inbound/CSS/grace/device-grace/RBAC). Полный набор не зелёный. Логи work/link-settings-*.log. Реальный Docker/Linux/Caddy/телефон и production-подписки не проверялись.
- Версии package/lock/VERSION/update/README/installer assertion 2.7.18, docs/UPDATE_2.7.18.md, cumulative manifest для 2.7.7–2.7.17 с добавленными views/client_detail.ejs/open_sub.ejs. Пакетирование work/package_subscription_url_setting_2_7_18.ps1 → outputs/Nexus-Panel-2.7.18-subscription-link-settings-patch.zip. Локальный выпуск, не опубликован и не установлен на VPS. Предыдущие ZIP не изменяются.

Изменены: app.js, lib_subscription_links.js, lib_settings_profile.js, views/settings.ejs/clients.ejs/client_detail.ejs/open_sub.ejs, tests/subscription-links.test.js/subscription-portal-traffic.test.js/clean-links-workspaces-http.test.js/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md/CHANGELOG.md, docs/UPDATE_2.7.18.md, PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh.

2026-10-21 — Nexus 2.7.17, чистые ссылки и исправления установки:

- Пользователь после вопросов об удалении /sub/ и /json/ дал запрос «доработай и исправь ошибки». Объявленная область: чистые JSON/SUB с сохранением старых ссылок, две воспроизведённые установки (network.host entitlement и ADMIN_PASSWORD=admin), замечание пустой страницы узлов. Не выполнять глобальное переименование каталогов/контейнеров: это отдельная миграция, не причина ошибки сборки.
- lib_subscription_links.js: ключи 12–128 [A-Za-z0-9_-] и reserved set. JSON /key, SUB /key?format=sub, format=single поддержан; неизвестный/повторный формат 400. Короткие/зарезервированные импортированные ключи используют прежние URL, без замены токенов. Alias middleware перед workspace routing внутренне переписывает req.url в старый handler, не выдаёт redirect приложению и не ослабляет HWID/expiry/disabled/CSRF. lib_workspace_runtime.publicTarget поддерживает явные /s/<workspace>/key и не проксирует admin paths; /s/ намеренно сохранён. URL builders/portal/Telegram/CSV формируют новые ссылки, rev остаётся в заголовках, не обязателен в чистой ссылке.
- install.sh и статический docker-compose.yml: пять генерируемых шаблонов build.network default вместо host, явный opt-in NEXUS_BUILD_NETWORK. Caddy генератор добавляет отдельный строгий matcher чистых путей, исключая системные имена. Старые public paths и respond404 остаются. Установщик валидирует default пароль до stop/build, новые пароли >=12 chars/<=72 bytes; сохраняет ADMIN_PASSWORD в single-quoted literal, read_env_literal читает его назад. $/# не интерполируются, apostrophe/newlines в новых значениях отклоняются до записи. ask_secret_optional newline перенесён на stderr, чтобы не загрязнять captured password. Production-guard не менялся; существующий пароль БД автоматически не сбрасывается.
- scripts/upgrade-install-config.py: известный aggregator build.network:host→default и ограниченный Caddy matcher с backup/idempotence. Порты/project/container names/runtime network_mode/секреты/базы не меняются. --check проверяет пароль без печати значения до stop. apply-node-traffic-update.sh использует Python preflight, backup каталога, validates Caddy в run --rm (без публикации портов), пересоздаёт Caddy при changed single-file bind mount. При нужной правке Caddy без compose-сервиса — остановка до изменений. Для внешнего Nginx/произвольного прокси есть только инструкция, автоматическая правка не заявляется.
- views/nodes.ejs/CSS: компактное пустое состояние, нет подсказки перетаскивания пустых узлов, CTA первого узла, автоподключение внутри head. Регрессия add/auto UI проверена.
- Тесты: новые subscription-links 3 unit, install-config 4 (Git Bash/Python, shell password literal/default guard/не останавливать, network default/Caddy idempotence/backups/env unchanged), clean-links-workspaces-http 1 (настоящие worker-процессы, одинаковый токен, namespace vs cookie, disabled и запрет admin), subscription-portal-traffic ещё 1 (JSON/SUB/single/HEAD/browser/HWID/disabled/no-cache/CSRF/restart). Целевой 48: 40 pass/8 platform skip/0 fail; UI отдельно 6/6 с Edge 1440/390, screenshots work/ui-qa/2.7.17 просмотрены, без JS errors/горизонтального overflow. 20 EJS, JS и Bash syntax проверены. Полный 249: 224 pass/9 прежних fail/16 skip; названия fail точно совпадают с 2.7.16 (work/clean-links-full-2.7.17.log). Не заявлять полный green. Production Docker/Caddy/Linux, TLS домена/телефон не проверялись.
- Финальный набор после добавления end-to-end POSIX helper test: целевой 49 (40 pass/9 platform skip/0 fail), полный 250 (224 pass/9 прежних fail/17 skip). Новый прогон helper с mocked Docker CLI требует нативных POSIX mkdir/install: на Windows Git Bash mkdir -p существующего каталога дал Permission denied, поэтому тест явно platform-skip, не заявлять его успешное выполнение. Shell/Python unit migration и UI/HTTP тесты работают. Это не новое падение Linux/Docker и не проверка реального VPS; Linux helper integration требуется проверить отдельно.
- Версии package/lock/VERSION/update/README/installer assertion 2.7.17, docs/UPDATE_2.7.17.md, cumulative manifest для 2.7.7–2.7.16. Статический docker-compose.yml намеренно НЕ в PATCH_FILES (нельзя заменять работающие порты/тома). Пакетирование work/package_clean_links_2_7_17.ps1 → outputs/Nexus-Panel-2.7.17-clean-links-install-patch.zip. Это локальный patch, не свежая установка через старый GitHub bootstrap; не публиковался и не установлен на пользовательские VPS.

Изменены: app.js, lib_subscription_links.js (новый), lib_workspace_runtime.js, install.sh, docker-compose.yml, scripts/upgrade-install-config.py (новый), views/nodes.ejs, public/css/spectrum-clear.css, tests/subscription-links.test.js/install-config.test.js/clean-links-workspaces-http.test.js (новые), tests/subscription-portal-traffic.test.js/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md/CHANGELOG.md, docs/UPDATE_2.7.17.md, PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh.

2026-10-21 — Nexus 2.7.16, UDP/443 только обычных 3x-ui:

- Пользователь разрешил добавить per-node UDP443 default-on и затем явно ограничил запрос обычными узлами XUI: каскад/Remnawave не менять. Не подтверждать, что UDP443 включён на его Remna серверах: этого не проверяли. До production/телефона доступа нет.
- lib_node_udp443.js: только node_type=3xui, известный Vision при TCP/raw+TLS/REALITY меняется client flow udp443↔стандартный. Никогда не вводить Vision в XHTTP/WS/gRPC/flowless. Если Mux уже есть, override только xudpProxyUDP443 skip/reject, enabled/concurrency не менять, отсутствующий Mux не создавать. Без Vision/Mux выключение не общий firewall; это явно написано в UI/docs. Исходник Xray подтверждает удаление клиентского суффикса до отправки серверу, так что server flow остаётся обычным Vision.
- app.js: nodes.allow_udp443 INTEGER NOT NULL DEFAULT 1 + addColumnIfMissing (существующие записи получают on), add/edit через marker udp443_controls (старые формы сохраняют выбор), revision при смене. Поле добавлено в явный SELECT buildSubscriptionEntries для SUB и в существующую выборку source controls без дополнительного запроса. URI builder применяет nodeVisionFlow, JSON после наследования Mux — applyNodeUdp443; original flow передаётся для сохранения TLS Vision. Remna generator не меняется. lib_node_clone.js наследует выбор; общий backup по столбцам автоматически сохраняет поле.
- UI nodes/node_edit: галочка только обычной 3x-ui, default-on, объяснение области действия, не-включения Mux, обновления подписки и ограничений сервера. Никаких правок panel-script-v1 и каскада.
- tests/node-udp443.test.js: 4 unit (defaults/form/clone, reversibility/idempotence, scope/transport/flowless/TLS, Mux preservation/Remna unchanged). HTTP в subscription-portal-traffic: миграция после DROP COLUMN старой базы, add default/off, edit on/off/oldform/CSRF/revision, SUB+JSON, независимый auto pool, source mux/server flow unchanged, backup restore/restart/TLS, только read API/setting-all на mock3xui. Целевой 28/28; полный 240: 215 pass/9 прежних fail/16 skip, категории совпадают с 2.7.15. Логи work/udp443-target-2.7.16.log и udp443-full-2.7.16.log. Не заявлять исправление WhatsApp по этим тестам.
- Версии package/lock/VERSION/update/README и installer assertion 2.7.16, docs/UPDATE_2.7.16.md, cumulative PATCH_FILES + helper для 2.7.7–2.7.15. Пакетирование work/package_udp443_2_7_16.ps1, outputs/Nexus-Panel-2.7.16-udp443-patch.zip. Не установлен и не опубликован.

Изменены: app.js, lib_node_udp443.js (новый), lib_node_clone.js, views/nodes.ejs/node_edit.ejs, tests/node-udp443.test.js (новый)/subscription-portal-traffic.test.js/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md/CHANGELOG.md, docs/UPDATE_2.7.16.md, PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh.

2026-10-21 — Nexus 2.7.15, DNS direct-исключений и routeOnly:

- Пользователь сравнил клиентский JSON стороннего продавца и свой REALITY: российские приложения долго открываются, WhatsApp иногда зависает и на обычной ноде, и на каскаде. Запросил отдельный DNS рядом с direct-исключениями и переключатель routeOnly; UDP пока только объяснить. Нет доступа к production, причина зависаний не доказана.
- Новый lib_json_routing_dns.js: opt-in directDnsEnabled/directDnsPreset/directDnsCustom и sniffingRouteOnly в routing_config (default false, без схемной миграции). Direct DNS только для доменных исключений proxy-except выбранных узлов. GeoIP не используется как DNS domain selector. Яндекс DoH официальный common.dot.dns.yandex.net через https+local (системный bootstrap), IP DNS tagged direct; основной DNS tagged proxy/balancer. Принудительные proxy-домены сначала используют основной DNS, стандартный sequential fallback сохранён; при пересекающихся списках это не строгая DNS-изоляция. Нативные app/TUN DNS зависят от клиента, routeOnly может сохранить уже известный IP.
- Встраивается ПОСЛЕ normalizeXrayJsonForIos, чтобы не терялись tagged rules; авто-пул преобразует DNS proxy rule существующим autoSelectRuleForBalancer. Серверный transport/security/credentials/flow/mux, URI/SUB и отдельный Happ routing профиль не менялись. Новые формы с marker явно выключают, старые posts сохраняют opt-ins. Ошибочные IP/HTTP/DoT/URL credentials и пустой manual отклоняются до записи, повреждённый импорт не даёт HTTP 500 и показывает предупреждение.
- views/routing.ejs: controls возле Domain/GeoSite direct, routeOnly с человеческим объяснением/возможностью выключить и текущим итогом; hint области действия/GeoIP/fallback/DNS перехвата. App /routing CSRF/RBAC сохранены, revision bump обновляет JSON.
- tests/routing-dns.test.js: 6 unit (default-off, DNSpriority, tag routes, idempotence, scope, invalid/manual/IPv6, no transport changes, independent routeOnly, imported bad config). Реальный node-traffic HTTP: Remnawave XHTTP cascade, DNS/routeOnly/save/off/old form/invalid atomic/CSRF/assignment/transport preservation. Multi-auto HTTP: 3x-ui, DNS balancer/direct tags и сохранение после restart. Целевой 20/20 pass; доп. installer/version набор 18 pass/4 platform skip; 20 EJS, JS и helper bash -n. Полный 235: 210 pass, 9 прежних fail, 16 skip (work/routing-dns-full-2.7.15.log). Полный набор не зелёный. Не было теста production Xray/телефона/WhatsApp, визуальная mobile QA не заявлялась.
- Версии package/lock/VERSION/update/README = 2.7.15; docs/UPDATE_2.7.15.md содержит включение, scope/fallback/DoH bootstrap и UDP443 explanation (Vision client flow vs cascade server mux.reject). Cumulative PATCH_FILES/helper 2.7.7–2.7.14 включает новый module и tests; GitHub/сервер не менялись. Дистрибутив outputs/Nexus-Panel-2.7.15-routing-dns-patch.zip.

Изменены: app.js, lib_json_routing_dns.js, views/routing.ejs, tests/routing-dns.test.js/node-traffic-http.test.js/subscription-portal-traffic.test.js/installer-source-migration.test.js, package.json/package-lock.json/VERSION/update.json/README.md/CHANGELOG.md, docs/UPDATE_2.7.15.md, PROJECT_HANDOFF.md/PATCH_FILES.txt/apply-node-traffic-update.sh.

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

- 2.7.20: nodes EJS/CSS, сортировка/транспорт автовыбора, HTTP/UI tests, версии/helper/docs перечислены в последней записи выше.
- 2.7.19: каталог включённых узлов в редакторе клиента, отдельный HTTP/UI regression test, версии и инструкция перечислены в последней записи выше; backend создания/привязки не менялся.
- 2.7.18: настройка чистых ссылок, генераторы/копирование/QR/публичный профиль, unit/HTTP/workspace/UI tests и инструкция выпуска перечислены в записи выше.
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

- 2.7.20: целевой26 (22pass/4skip/0fail), UI4/4 с Edge1440/390; полный256(230pass/9прежнихfail/17skip). Имена fail совпадают с2.7.19, снимки просмотрены. Production не проверялся.

- 2.7.19: целевой 44 (36 pass/8 platform skip/0 fail); UI 4/4 с Edge 1440/390, снимки просмотрены; полный 256 (230 pass/9 прежних fail/17 skip), имена fail совпадают с 2.7.18. JS/20 EJS/Bash syntax пройдены. Не проверено на реальных VPS и телефоне.

- 2.7.18: целевой набор 42 pass/9 skip/0 fail (51); production-mode локальная Edge UI фикстура 1440/390 с сохранением галочки, просмотрены screenshots; JS/20 EJS/Bash syntax. Полный 226 pass/9 прежних fail/17 skip (252), не зелёный. Подробности и ограничения в записи последнего изменения и docs/UPDATE_2.7.18.md.
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
