# Карта UI

## Общая оболочка

| Что меняется | Основной файл | Примечание |
|---|---|---|
| Sidebar, desktop-навигация, mobile bottom nav, заголовок страницы | `views/partials_header.ejs` | Общий для всех авторизованных экранов |
| Общие модальные окна, переключение темы, вкладки, floating save, общий JS | `views/partials_footer.ejs` | Файл перегружен; новый общий JS выносить в `public/js/` |
| Базовые старые стили | `public/css/style.css` | Не добавлять новые большие блоки без необходимости |
| Основной редизайн | `public/css/redesign.css` | Содержит много накопленных переопределений |
| Исторический слой исправлений UI | `public/css/stage87.css` | Не наращивать без необходимости |
| Новый override-слой | `public/css/stage90.css` | Первая точка для новых точечных визуальных правок |
| CSRF для форм и fetch | `public/js/security.js` | Не удалять при переделке layout |
| Предупреждение о несохранённой форме | `public/js/dirty-form.js` | Общая логика форм |
| Экран входа | `views/login.ejs` | Runtime-шаблон находится только в `views/` |

## Экраны

| URL | Шаблон | Backend-маршруты |
|---|---|---|
| `/dashboard` | `views/dashboard.ejs` | `app.js`, поиск `app.get('/dashboard'` |
| `/clients` | `views/clients.ejs` | поиск `app.get('/clients'` и `app.post('/clients` |
| `/clients/:id` | `views/client_detail.ejs` | поиск `client_detail` и `/clients/:id` |
| `/nodes` | `views/nodes.ejs` | поиск `app.get('/nodes'`, `app.post('/nodes'` |
| `/nodes/:id/edit` | `views/node_edit.ejs` | поиск `/nodes/:id/edit` |
| `/vpn` | `views/vpn.ejs` | маршруты в `app.js`, бизнес-логика в `lib_vpn_manager.js` |
| `/routing` | `views/routing.ejs` | поиск `app.get('/routing'` и `app.post('/routing'` |
| `/redirects` | `views/redirects.ejs` | поиск `/redirects` |
| `/diagnostics` | `views/diagnostics.ejs` | поиск `/diagnostics` и `/dashboard/panel-check.json` |
| `/telegram-bot` | `views/telegram_bot.ejs` | поиск `/telegram-bot` и Telegram-функций в `app.js` |
| `/settings` | `views/settings.ejs` | поиск `/settings` |
| `/more` | `views/more.ejs` | мобильный/компактный экран дополнительных разделов |
| `/open/:slug` | `views/open_sub.ejs` | публичное открытие подписки |

## Как точно указать место изменения

Для постановки задачи используйте формат:

```text
Экран: /nodes
Блок: карточка узла в списке
Элемент: кнопка «Проверить»
Нужно: перенести в меню действий и сделать secondary
Desktop: справа в строке
Mobile: внутри раскрытой карточки
```

Ещё точнее можно указать селектор из DevTools:

```text
Экран: /clients
Селектор: .client-card .client-actions
Изменение: кнопки в одну строку при ширине от 768px
```

По URL + видимому тексту + CSS-селектору место обычно определяется однозначно.

## Рекомендуемое постепенное разбиение

```text
public/
  css/
    tokens.css
    layout.css
    components/
      buttons.css
      forms.css
      cards.css
      modals.css
    pages/
      dashboard.css
      clients.css
      nodes.css
  js/
    core/
      theme.js
      tabs.js
      forms.js
    pages/
      dashboard.js
      clients.js
      nodes.js
views/
  components/
    alert.ejs
    modal.ejs
    node-card.ejs
    client-card.ejs
```

Делать это лучше по одному экрану, не переписывая всю панель одновременно.
