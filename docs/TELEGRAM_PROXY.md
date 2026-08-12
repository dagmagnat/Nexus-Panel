# Telegram bot proxy for restricted panel servers

If the aggregator panel is installed on a server that cannot reach Telegram API directly, route only the Telegram bot traffic through a foreign VPS.

This does not move subscriptions, nodes, clients, Caddy, or the web panel. Only the TG-bot API calls use the proxy.

## Quick setup

### 1. Find the outgoing IP of the panel server

Run this on the panel server:

```bash
curl -4 https://api.ipify.org; echo
```

Use this result as `ALLOWED_IP`. It may differ from the IP address that opens the panel in the browser.

### 2. Install SOCKS5 on the foreign VPS

Copy the repository to the foreign server or upload the script, then run:

```bash
ALLOWED_IP=77.222.35.110 PORT=1080 bash scripts/install-telegram-socks5-proxy.sh
```

The script prints a ready proxy URL, for example:

```text
socks5h://tgproxy:password@94.159.102.81:1080
```

### 3. Paste the URL into the panel

Open:

```text
TG-бот -> Telegram Proxy URL
```

Paste the `socks5h://...` URL, then click:

```text
Сохранить и применить -> Проверить токен
```

## Test from the panel server

```bash
curl -v --socks5-hostname 'tgproxy:password@94.159.102.81:1080' https://api.telegram.org
```

A `302 Found` or any valid Telegram response means the proxy is reachable.

## Disable proxy routing

To stop using the proxy but keep the bot:

1. Open `TG-бот` in the panel.
2. Clear `Telegram Proxy URL`.
3. Click `Сохранить и применить`.
4. Click `Проверить токен`.

If the panel server cannot access Telegram directly, token check will fail after disabling the proxy. That is expected.

To disable the SOCKS5 service on the foreign VPS:

```bash
systemctl disable --now danted
```

Or run:

```bash
bash scripts/disable-telegram-socks5-proxy.sh
```

## Security notes

- Use `socks5h://`, not `socks5://`, so DNS also goes through the foreign VPS.
- Do not publish Telegram bot tokens or SOCKS passwords.
- If a token or password appears in a screenshot, rotate it.
- The installer whitelists only the panel server's outgoing IP.

## Отключение Telegram-прокси

Чтобы отключить перенаправление Telegram API через иностранный сервер:

1. В панели откройте `TG-бот`.
2. Очистите поле `Telegram Proxy URL`.
3. Нажмите `Сохранить и применить`.
4. На иностранном сервере при необходимости отключите Dante:

```bash
systemctl disable --now danted
```

или используйте скрипт проекта:

```bash
bash scripts/disable-telegram-socks5-proxy.sh
```

Если поле `Telegram Proxy URL` пустое, бот пытается подключаться к Telegram напрямую с сервера панели.
