# Stage 113 — отдельный перенос настроек

Версия: `stage113-settings-transfer-1.0.9-2026-08-12`

## Что добавлено

- Зашифрованный пакет `.nxsettings`, отдельный от JSON с клиентами.
- SSH-команды `agg settings export`, `inspect` и `import [--dry-run]`.
- Экспорт и импорт в разделе «Настройки → Перенос настроек».
- Перешифрование секретов узлов, Telegram и VPN с `APP_SECRET` старого сервера на `APP_SECRET` нового.
- Сопоставление узлов и зависимых записей при изменившихся локальных ID.
- Транзакционный dry-run и автоматический SQLite-backup перед настоящей записью.

## Правильный порядок миграции

```bash
# Старый сервер
agg settings export /root/aggregator-settings.nxsettings
agg clients export /root/aggregator-clients.json

# Новый сервер
agg settings import /root/aggregator-settings.nxsettings --dry-run
agg settings import /root/aggregator-settings.nxsettings
cd /opt/3xui-aggregator && docker compose restart aggregator
agg clients import /root/aggregator-clients.json --dry-run --node-mode match
agg clients import /root/aggregator-clients.json --mode update --node-mode match
```

Клиенты не входят в `.nxsettings`. Параметры входа и размещения новой панели не заменяются. Редиректы и VPN-сервисы после переноса остаются выключенными до ручной проверки.
