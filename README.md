<p align="center">
  <img src="public/img/nexus-logo.png" width="132" alt="Логотип Nexus Panel">
</p>

<h1 align="center">Nexus Panel</h1>

Nexus Panel — панель агрегации и управления узлами **3x-ui** и **Remnawave**: клиенты, SUB/JSON-подписки, маршрутизация, трафик, Telegram и синхронизация выбранного inbound.

[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/dagmagnat/Nexus-Panel)
![Node.js](https://img.shields.io/badge/node-%3E%3D22-gray)
![License](https://img.shields.io/badge/license-MIT-gray)

## Возможности

- добавление и мониторинг обычных 3x-ui и Remnawave-узлов;
- точная загрузка параметров указанного `Inbound ID` до сохранения узла;
- поддержка VLESS, XHTTP, Reality/TLS/NONE и параметров выбранного транспорта;
- отображение upload, download и общего расхода трафика выбранного inbound;
- управление клиентами и синхронизация клиентов с выбранными узлами;
- перенос клиентов между серверами через JSON, веб-интерфейс или SSH с сохранением UUID и ссылок подписок;
- отдельный зашифрованный перенос настроек и секретов узлов между серверами;
- генерация SUB и JSON-подписок;
- собственный логотип в панели, favicon, Apple Touch Icon и фирменная публичная страница подписки;
- маршрутизация, перенаправление трафика, Telegram-бот и резервные копии;
- адаптивный интерфейс со светлой и тёмной темами.

## Spectrum Clear

Начиная с версии 2.0.0 панель использует единый интерфейс **Nexus Spectrum Clear**. Это полный дизайн-системный переход, а не набор цветовых переопределений: общий каркас, группированная навигация, master-detail для узлов, новый каталог клиентов, единые формы/модальные окна и отдельные мобильные компоновки.

Старые `style.css`, `redesign.css`, `nexus-ui.css` и `stage*.css` больше не подключаются, поэтому разные разделы не получают конфликтующие цвета и размеры. Источник интерфейса один: `public/css/spectrum-clear.css`.

Редизайн не меняет `data/app.db`, `.env`, UUID клиентов и `sub_slug`. Уже выданные ссылки подписок сохраняются. Подробные критерии и контракт: [`docs/NEXUS_PRODUCT_SPEC.md`](docs/NEXUS_PRODUCT_SPEC.md) и [`docs/DATA_COMPATIBILITY.md`](docs/DATA_COMPATIBILITY.md).

## Быстрая установка

Требуется VPS с Linux, root-доступом и открытыми портами. Для автоматического HTTPS домен должен указывать на этот сервер, а порты `80` и `443` не должны быть заняты другим Nginx, Apache или Caddy.

```bash
sudo -i
apt-get update && apt-get install -y curl
curl -fsSL https://raw.githubusercontent.com/dagmagnat/Nexus-Panel/main/install.sh -o /tmp/nexus-panel-install.sh
bash /tmp/nexus-panel-install.sh
```

Установщик сам скачает `dagmagnat/Nexus-Panel`, создаст конфигурацию, установит Docker при необходимости и покажет точный адрес входа с ключом.

## Установка из клонированного репозитория

```bash
git clone https://github.com/dagmagnat/Nexus-Panel.git
cd Nexus-Panel
sudo bash install.sh
```

## Обновление и управление

```bash
# Обновить файлы, сохранив базу и настройки
agg update

# Открыть интерактивное меню управления
agg
```

Если установка ещё привязана к старому репозиторию `dagmagnat/3xui-Aggregator`, сначала убедитесь, что файлы Nexus Panel уже загружены в ветку `main`, создайте резервную копию через пункт `5`, а затем один раз запустите новый установщик напрямую:

```bash
curl -fsSL https://raw.githubusercontent.com/dagmagnat/Nexus-Panel/main/install.sh -o /tmp/nexus-panel-install.sh
bash /tmp/nexus-panel-install.sh update
```

Версия 1.0.7 сначала проверяет новый репозиторий без остановки контейнеров, затем автоматически меняет старый Git `origin` и обновляет файлы. При недоступном или пустом репозитории рабочая панель не останавливается. Каталог `data`, `.env`, `.install.conf` и `.source.conf` не удаляются, поэтому клиенты, UUID, привязки узлов и настройки сохраняются.

Если прежняя попытка уже остановилась на `Username for 'https://github.com':`, нажмите `Ctrl+C`, восстановите работу командой `cd /opt/3xui-aggregator && docker compose up -d`, загрузите файлы Nexus Panel в GitHub и повторите команду выше.

Внутренний каталог `/opt/3xui-aggregator`, имена контейнеров и команда `agg` сохранены для совместимости с уже установленными версиями.

## Перенос настроек и клиентов на новый сервер

Настройки и клиенты переносятся двумя отдельными файлами. Сначала импортируйте настройки: так Nexus создаст узлы и сохранит их параметры, после чего импорт клиентов сможет сопоставить прежние связи с новыми локальными ID узлов.

На старом сервере создайте защищённый пакет настроек. Команда попросит парольную фразу длиной не менее 12 символов:

```bash
agg settings export /root/aggregator-settings.nxsettings
agg settings inspect /root/aggregator-settings.nxsettings
```

Пакет включает настройки подписок, Happ, routing и Telegram, узлы с паролями/API-токенами, кэш выбранных inbound, SNI-профили, редиректы и VPN-хосты/сервисы. Секреты внутри защищены AES-256-GCM. Клиенты, история трафика, администратор, ключ входа, разрешённые admin IP и URL/IP развёртывания в него не входят.

Передайте `.nxsettings` на новый сервер и сначала выполните полный пробный импорт:

```bash
agg settings import /root/aggregator-settings.nxsettings --dry-run
agg settings import /root/aggregator-settings.nxsettings
cd /opt/3xui-aggregator && docker compose restart aggregator
```

При импорте секреты автоматически перешифровываются ключом нового сервера. Перед записью создаётся `data/backups/settings-import-before-*.db`. Редиректы и VPN-сервисы переносятся отключёнными: проверьте адреса и порты нового VPS, затем включите их вручную. Те же операции доступны в разделе «Настройки → Перенос настроек».

После настроек перенесите клиентов.

Экспорт читает SQLite напрямую, поэтому старая веб-панель и Docker-контейнеры могут быть остановлены. В файл попадают Reality/Xray-клиенты, их UUID, `sub_slug`, сроки, лимиты, комментарии, статистика и безопасные описания связей с узлами. Пароли панелей и API-токены не экспортируются.

На старом сервере:

```bash
# Панель может быть недоступна
agg clients export /root/nexus-clients.json
agg clients inspect /root/nexus-clients.json
```

Если старый `install.sh` ещё не знает команду `agg clients`, скопируйте на сервер только `scripts/client-transfer.py` из этого релиза и выполните:

```bash
python3 /opt/3xui-aggregator/scripts/client-transfer.py export \
  --db /opt/3xui-aggregator/data/app.db \
  --output /root/nexus-clients.json
```

Передайте `/root/nexus-clients.json` на новый сервер по SCP/SFTP. Этот файл содержит клиентские идентификаторы и должен храниться как пароль.

После установки Nexus Panel на новом сервере сначала выполните пробный импорт, который полностью откатывает транзакцию:

```bash
agg clients import /root/nexus-clients.json --dry-run
```

Затем запустите безопасный импорт только клиентов:

```bash
agg clients import /root/nexus-clients.json --mode update --node-mode none
```

Другие варианты привязки:

```bash
# Узлы уже созданы в Nexus: сопоставить по типу, Panel URL, Panel Path и Inbound ID
agg clients import /root/nexus-clients.json --mode update --node-mode match

# Привязать всех импортируемых клиентов к конкретным локальным ID узлов
agg clients import /root/nexus-clients.json --mode update --node-mode selected --target-node-ids 1,2
```

Режим `update` обновляет существующего клиента только при совпадении UUID и `sub_slug`; подозрительное совпадение логина становится конфликтом. `replace` разрешает смену идентификаторов и должен использоваться только после проверки `--dry-run`. Перед настоящим импортом автоматически создаётся `data/backups/client-import-before-*.db`.

Импорт не подключается к удалённым 3x-ui/Remnawave-серверам. После переноса при необходимости откройте «Клиенты → Импорт и синхронизация → Добавить отсутствующих клиентов на один узел» для каждого нового узла.

Те же операции доступны кнопкой «Перенос клиентов» на странице клиентов. Если новый сервер использует прежний домен, сначала перенесите и проверьте клиентов, затем измените DNS. Сохранённые UUID и `sub_slug` оставляют прежние пути подписок действующими. После завершения удалите JSON с обоих серверов.

## Логотип и Happ

Логотип Nexus Panel находится в `branding/nexus-logo-master.png`; готовые размеры для сайта лежат в `public/img/`. Панель использует его в сайдбаре, мобильной шапке, на странице входа, в favicon и на публичной странице подключения.

JSON-подписки также содержат публичный `logoUrl`, а стандартный `profile-web-page-url` Happ ведёт на фирменную страницу клиента. При этом официальный формат метаданных Happ не содержит отдельного поля для произвольной растровой иконки слева: клиент гарантированно поддерживает название, трафик, объявление, ссылку поддержки и ссылку страницы профиля. Поэтому отображение именно круглого аватара, как у отдельных VPN-провайдеров, зависит от версии Happ и настроек аккаунта провайдера.

Подробности и инструкция для GitHub: [`docs/BRANDING.md`](docs/BRANDING.md).

## Разработка

```bash
git clone https://github.com/dagmagnat/Nexus-Panel.git
cd Nexus-Panel
npm ci
npm run check
npm test
npm run check:spectrum
npm run dev
```

Development-режим создаёт отдельную конфигурацию и данные через `scripts/setup-dev.js`.

## Частые проблемы

### Порт 80 уже занят

Если ACME сообщает `tcp port 80 is already used`, остановите сервис, который слушает порт, и повторите получение сертификата:

```bash
ss -ltnp | grep ':80 '
systemctl stop nginx
```

Не останавливайте Nginx, если он намеренно обслуживает другие сайты: в этом случае сначала настройте проксирование или выберите другой режим публикации панели.

### `self-signed certificate`

Nexus Panel проверяет сертификат удалённого узла. На API-адресе узла должен отдаваться сертификат, выпущенный для указанного домена, а не локальный `CN=cdn-origin`. После установки сертификата проверьте именно тот домен и порт, которые добавляете как API / Panel URL.

### `Not found` при входе

Используйте полный адрес `/login?key=...`, который напечатал установщик. После первой успешной проверки ключ синхронизируется с SQLite, а параметр `key` удаляется из адресной строки безопасным редиректом.

## Структура проекта

- `app.js` — сервер Nexus Panel;
- `views/` — EJS-шаблоны интерфейса;
- `public/` — CSS, JavaScript, шрифты и статические ресурсы;
- `branding/` — мастер-файл фирменного логотипа;
- `scripts/` — updater, диагностика и вспомогательные команды;
- `docs/` — дополнительная документация;
- `install.sh` — установка, обновление, backup и восстановление.

## Технологии

Node.js 22, Express, SQLite, EJS и Docker Compose.

## Лицензия

MIT
