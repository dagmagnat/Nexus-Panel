# Nexus Panel 2.0.0 — Spectrum Clear

## Что меняется

- единый каркас и дизайн всех страниц панели;
- тёмная и светлая темы из палитры логотипа Nexus;
- новая desktop/mobile навигация;
- master-detail узлов и отдельные мобильные карточки;
- единая компоновка клиентов, форм, таблиц, модальных окон и статусов;
- тот же дизайн страницы входа и публичной страницы подключения;
- постоянная спецификация продукта и контракт сохранности данных.

## Что не меняется

- `data/app.db`;
- `.env`;
- клиенты, UUID, `sub_slug`, сроки и статистика;
- привязки клиентов к узлам;
- уже отправленные ссылки SUB/JSON/Happ;
- домен, TLS и Docker volume.

## Установка

```bash
mkdir -p /root/nexus-spectrum-clear
unzip -o /root/Nexus-Panel-2.0.0-Spectrum-Clear-changed-files.zip \
  -d /root/nexus-spectrum-clear
cd /root/nexus-spectrum-clear
sudo bash apply-spectrum-clear.sh
```

Скрипт создаст backup в `/opt/3xui-backups/spectrum-clear-*`, заменит только файлы из `SPECTRUM_CLEAR_FILES.txt` и пересоберёт контейнер.

## Проверка

```bash
cd /opt/3xui-aggregator
docker compose ps
docker compose logs --tail=80 aggregator
```

После входа нажмите `Ctrl+F5`, чтобы браузер не использовал старый HTML-кэш. Откройте дашборд, узлы, клиентов и настройки; затем проверьте одну ранее выданную клиентскую ссылку.

## Откат

Точная команда печатается после установки. Общий вид:

```bash
sudo bash /opt/3xui-backups/spectrum-clear-ДАТА/rollback-spectrum-clear.sh \
  /opt/3xui-backups/spectrum-clear-ДАТА
```

Откат возвращает только файлы интерфейса. База не откатывается, потому что Spectrum Clear её не изменяет.

