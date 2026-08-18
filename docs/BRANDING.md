# Фирменный стиль Nexus Panel

## Где используется логотип

| Место | Файл или URL |
| --- | --- |
| Сайдбар и мобильная шапка | `/img/nexus-logo-192.png` |
| Страница входа | `/img/nexus-logo.png` |
| Публичная страница клиента | `/open/:slug` |
| Вкладка браузера | `/favicon.ico` |
| iPhone / iPad Home Screen | `/apple-touch-icon.png` |
| PWA / Android | `/site.webmanifest` |
| JSON-подписка | `logoUrl` и `iconUrl` с абсолютным публичным URL |

Исходник находится в `branding/nexus-logo-master.png`. Он имеет прозрачный фон и безопасные поля, поэтому подходит для квадратной, круглой и скруглённой маски.

## Happ

Nexus Panel передаёт стандартные метаданные `profile-title`, `subscription-userinfo`, `announce`, `support-url` и `profile-web-page-url`. Последний ведёт на фирменную страницу `/open/:slug`; её favicon и Open Graph image используют логотип Nexus Panel. В JSON дополнительно передаются `logoUrl` и `iconUrl` как совместимые подсказки для клиентов, которые умеют их читать.

Официальная спецификация Happ не описывает отдельный стандартный заголовок с произвольной PNG-иконкой подписки. Поэтому собственный логотип внутри панели и браузера работает всегда, а круглый аватар слева в Happ зависит от реализации конкретной версии приложения или брендинга аккаунта провайдера. Не добавляйте случайный `providerid`: он привязывает подписку к аккаунту на happ-proxy.com и передаёт сервису идентификатор устройства и хеш домена.

- [Официальные метаданные Happ](https://github.com/Flyfrog-LLC/Happ-docs/blob/main/dev-docs/meta-info.md)
- [Официальное описание Provider ID](https://github.com/Flyfrog-LLC/Happ-docs/blob/main/dev-docs/provider-id.md)
- [Иконки серверов из emoji/флагов](https://happ.mintlify.app/en/dev-docs/displaying-flags-and-smileys)

## GitHub

README уже показывает `public/img/nexus-logo.png`. Для Social preview откройте репозиторий GitHub → **Settings** → **General** → **Social preview** и загрузите `branding/nexus-logo-master.png`.

После обновления сервера браузер может показывать старый favicon из кэша. Выполните жёсткое обновление страницы (`Ctrl+F5`) или откройте сайт в новой приватной вкладке.
