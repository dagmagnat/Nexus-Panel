#!/usr/bin/env python3
"""Optional, isolated Docker companions for Nexus. No host installer is executed.

State and provider databases live outside APP_DIR so a Nexus update cannot erase
them. The provider compose project is independent; only its front network is
shared with Nexus/Caddy. Ordinary Nexus updates never choose a new provider tag.
"""
import argparse
import copy
import ipaddress
import hashlib
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import shlex
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request

REPOS = {"3xui": "MHSanaei/3x-ui", "remnawave": "remnawave/backend"}
TAG = re.compile(r"v?\d+\.\d+\.\d+(?:\.\d+)?\Z")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Nexus-Local-Panels", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("Слишком большой ответ официального репозитория")
    return data.decode("utf-8")


def stable_releases(kind):
    found = []
    for page in range(1, 6):
        rows = json.loads(fetch(f"https://api.github.com/repos/{REPOS[kind]}/releases?per_page=30&page={page}"))
        if not isinstance(rows, list):
            raise ValueError("GitHub не вернул список релизов")
        for row in rows:
            tag = row.get("tag_name", "")
            if not row.get("draft") and not row.get("prerelease") and TAG.fullmatch(tag) and tag not in found:
                found.append(tag)
        if len(found) >= 5 or len(rows) < 30:
            break
    if not found:
        raise ValueError("Стабильные релизы не найдены; установка отменена")
    return found[:5]


def resolve_release(kind, tag):
    if not TAG.fullmatch(tag):
        raise ValueError("Нужен номер стабильного релиза, например 3.4.3 или v3.7.0")
    candidates = [tag, tag[1:] if tag.startswith("v") else "v" + tag]
    for candidate in candidates:
        try:
            row = json.loads(fetch(f"https://api.github.com/repos/{REPOS[kind]}/releases/tags/{candidate}"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                continue
            raise
        actual = row.get("tag_name", "")
        if row.get("draft") or row.get("prerelease") or not TAG.fullmatch(actual):
            raise ValueError("Выбран не стабильный релиз")
        return actual
    raise ValueError("Такого официального релиза нет")


def ask(prompt, default=""):
    # EOF cancels instead of looping forever in curl/non-interactive invocations.
    value = input(prompt + (f" [{default}]" if default else "") + ": ").strip()
    return value or default


def choose_version(kind):
    try:
        versions = stable_releases(kind)
    except (OSError, ValueError) as exc:
        print(f"Список версий недоступен: {exc}. Можно указать точную версию; её существование будет проверено.")
        return resolve_release(kind, ask("Точная версия"))
    print(f"\n{kind}: последние стабильные релизы (без dev/beta):")
    print("  0 — последняя стабильная: " + versions[0])
    for i, tag in enumerate(versions, 1):
        print(f"  {i} — {tag}")
    print("  m — ввести другую версию вручную")
    while True:
        choice = ask("Версия", "0").lower()
        if choice == "m":
            return resolve_release(kind, ask("Точная версия"))
        if choice == "0":
            return versions[0]
        if choice.isdigit() and 1 <= int(choice) <= len(versions):
            return versions[int(choice) - 1]
        print("Выберите пункт списка или m.")


def domain(value):
    value = value.strip().lower().rstrip(".")
    if len(value) > 253 or "." not in value or not all(re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", p) for p in value.split(".")):
        raise ValueError("Введите домен без https://, порта и пути; IDN — в punycode")
    try:
        ipaddress.ip_address(value)
    except ValueError:
        return value
    raise ValueError("Здесь нужен домен, а не IP")


def port(value):
    if not str(value).isdigit() or not 1024 <= int(value) <= 65535:
        raise ValueError("Порт должен быть числом от 1024 до 65535")
    return int(value)


def vpn_ports(value):
    result = []
    for item in value.replace(" ", "").split(","):
        if not item:
            continue
        match = re.fullmatch(r"(\d+)/(tcp|udp)", item)
        if not match:
            raise ValueError("Формат VPN-портов: 8443/tcp,8443/udp; диапазоны не поддерживаются")
        item = f"{port(match[1])}/{match[2]}"
        if item not in result:
            result.append(item)
    if len(result) > 32:
        raise ValueError("Не более 32 VPN-портов за один раз")
    return result


def assert_ports_free(bindings):
    # Check TCP and UDP, IPv4 and IPv6 wildcard listeners. No firewall mutation.
    for number, protocol in set(bindings):
        for family, address in ((socket.AF_INET, "0.0.0.0"), (socket.AF_INET6, "::")):
            if family == socket.AF_INET6 and not socket.has_ipv6:
                continue
            sock = socket.socket(family, socket.SOCK_STREAM if protocol == "tcp" else socket.SOCK_DGRAM)
            try:
                if family == socket.AF_INET6:
                    sock.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                sock.bind((address, number))
            except OSError as exc:
                # Hosts with IPv6 disabled cannot bind even an unused port.
                if family == socket.AF_INET6 and exc.errno in (97, 99):
                    continue
                raise ValueError(f"Порт {number}/{protocol} занят или недоступен; чужой сервис не остановлен") from exc
            finally:
                sock.close()


def choose_ports(prompt, preferred, protocols, reserved):
    """Enter selects a free port; explicit input is validated without mutations."""
    while True:
        value = ask(prompt + " (Enter — подобрать свободный порт)", "авто").lower()
        try:
            if value in ("авто", "auto", ""):
                # Bounded search; never stop an existing listener or change firewall.
                for number in range(preferred, min(preferred + 256, 65536)):
                    if number in reserved:
                        continue
                    bindings = [(number, proto) for proto in protocols]
                    try:
                        assert_ports_free(bindings)
                    except ValueError:
                        continue
                    break
                else:
                    raise ValueError("Свободный порт в автоматическом диапазоне не найден; укажите другой вручную")
            else:
                # A bare number is convenient for the common TCP+UDP case.
                bindings = ([(port(value), proto) for proto in protocols] if value.isdigit()
                            else [(int(p.split('/')[0]), p.split('/')[1]) for p in vpn_ports(value)])
                if not bindings or any(proto not in protocols for _, proto in bindings):
                    raise ValueError("Укажите порт с допустимым протоколом: " + ", ".join(protocols))
                if any(number in reserved for number, _ in bindings):
                    raise ValueError("Этот порт зарезервирован для Nexus или другой панели")
                if protocols == ("tcp",) and len(bindings) != 1:
                    raise ValueError("Для HTTPS нужен один TCP-порт")
                assert_ports_free(bindings)
            print("Выбрано: " + ", ".join(f"{number}/{proto}" for number, proto in bindings))
            return bindings
        except ValueError as exc:
            print(str(exc) + ". Повторите ввод или нажмите Enter для автоподбора.")


def read_env(text):
    result = {}
    for line in text.splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line.strip())
        if not match:
            raise ValueError("Неизвестный формат официального .env.sample")
        value = match[2].strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[match[1]] = value
    return result


def remna_recipe(tag, hostname):
    base = f"https://raw.githubusercontent.com/remnawave/backend/{tag}/"
    upstream = fetch(base + "docker-compose-prod.yml")
    env = read_env(fetch(base + ".env.sample"))
    # Fail before deployment on incompatible future/legacy schemas.
    required = {"APP_SECRET", "REDIS_SOCKET", "DATABASE_URL", "POSTGRES_PASSWORD", "FRONT_END_DOMAIN", "SUB_PUBLIC_DOMAIN"}
    if not required.issubset(env) or env["REDIS_SOCKET"] != "/var/run/valkey/valkey.sock":
        raise ValueError("Схема этого релиза Remnawave не поддерживается мастером. Нужна ручная установка по его документации.")
    pg = re.search(r"^\s+image:\s*(postgres:[\w.-]+)\s*$", upstream, re.M)
    redis = re.search(r"^\s+image:\s*(valkey/valkey:[\w.-]+)\s*$", upstream, re.M)
    target = re.search(r"remnawave-db-data:(/var/lib/postgresql(?:/data)?)\s*$", upstream, re.M)
    if not pg or not redis or not target:
        raise ValueError("Изменилась схема официального Compose Remnawave; автоматическая установка остановлена")
    password = secrets.token_hex(24)
    env.update(APP_SECRET=secrets.token_hex(64), METRICS_PASS=secrets.token_hex(32),
               WEBHOOK_SECRET_HEADER=secrets.token_hex(32), POSTGRES_USER="postgres", POSTGRES_DB="postgres",
               POSTGRES_PASSWORD=password, DATABASE_URL=f"postgresql://postgres:{password}@remnawave-db:5432/postgres",
               PANEL_DOMAIN=hostname, FRONT_END_DOMAIN=hostname, SUB_PUBLIC_DOMAIN=hostname + "/api/sub",
               APP_PORT="3000", METRICS_PORT="3001", API_INSTANCES="1")
    return {"pg_image": pg[1], "redis_image": redis[1], "pg_target": target[1]}, env


def private_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix=".nexus-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.chmod(temp, 0o600)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def common_service(image):
    return {"image": image, "restart": "unless-stopped", "logging": {"driver": "json-file", "options": {"max-size": "20m", "max-file": "3"}}}


def provider_compose(state, root):
    services = {}
    for kind, item in state["providers"].items():
        if kind == "3xui":
            services["local-3xui"] = {
                **common_service(item["image"]), "networks": ["front"],
                "environment": {"XUI_ENABLE_FAIL2BAN": "true", "TZ": "UTC"},
                "cap_add": ["NET_ADMIN", "NET_RAW"],
                "volumes": [f"{root}/3xui/db:/etc/x-ui", f"{root}/3xui/cert:/root/cert", f"{root}/3xui/acme:/root/.acme.sh"],
                "ports": [f"{p.split('/')[0]}:{p}" for p in item["vpn_ports"]],
                "healthcheck": {"test": ["CMD", "curl", "--silent", "--output", "/dev/null", "http://127.0.0.1:2053/"], "interval": "5s", "timeout": "3s", "retries": 12, "start_period": "10s"},
            }
        elif kind == "remnawave":
            env_file = str(root / "remnawave" / ".env")
            services["local-remnawave"] = {
                **common_service(item["image"]), "networks": ["front", "db"], "env_file": [env_file],
                "volumes": [f"{root}/remnawave/valkey:/var/run/valkey"],
                "healthcheck": {"test": ["CMD", "curl", "-f", "http://127.0.0.1:3001/health"], "interval": "15s", "timeout": "5s", "retries": 8, "start_period": "30s"},
                "depends_on": {"remnawave-db": {"condition": "service_healthy"}, "remnawave-redis": {"condition": "service_healthy"}},
            }
            services["remnawave-db"] = {
                **common_service(item["pg_image"]), "networks": ["db"], "env_file": [env_file],
                "environment": {"TZ": "UTC"}, "shm_size": "256mb",
                "volumes": [f"{root}/remnawave/pgdata:{item['pg_target']}"],
                "healthcheck": {"test": ["CMD", "pg_isready", "-U", "postgres", "-d", "postgres"], "interval": "3s", "timeout": "5s", "retries": 10},
            }
            services["remnawave-redis"] = {
                **common_service(item["redis_image"]), "networks": ["db"],
                "volumes": [f"{root}/remnawave/valkey:/var/run/valkey"],
                "command": ["valkey-server", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction", "--unixsocket", "/var/run/valkey/valkey.sock", "--unixsocketperm", "777", "--port", "0"],
                "healthcheck": {"test": ["CMD", "valkey-cli", "-s", "/var/run/valkey/valkey.sock", "ping"], "interval": "3s", "timeout": "3s", "retries": 10},
            }
    return {"name": "nexus-local-" + state["instance"], "services": services,
            "networks": {"front": {"name": "nexus-local-" + state["instance"] + "-front"}, "db": {"internal": True}}}


def caddy_sites(state):
    blocks = []
    for kind, item in state["providers"].items():
        internal = "local-3xui:2053" if kind == "3xui" else "local-remnawave:3000"
        if item["mode"] == "domain":
            name = domain(item['host'])
            blocks.append(f"http://{name} {{\n    redir https://{name}{{uri}} permanent\n}}\nhttps://{name} {{\n    encode gzip\n    reverse_proxy {internal}\n}}")
        else:
            host = ipaddress.ip_address(item["host"])
            address = f"[{host}]" if host.version == 6 else str(host)
            blocks.append(f"https://{address}:{port(item['port'])} {{\n    tls internal\n    reverse_proxy {internal}\n}}")
    return "\n\n".join(blocks) + "\n"


def caddy_default_sni(text, state):
    # Browsers omit SNI for IP URLs. Behind Docker NAT Caddy otherwise guesses
    # its container IP instead of the public IP whose certificate it manages.
    marker = "# nexus-local-panels default_sni"
    text = re.sub(r"(?m)^\s*default_sni [^\n]+ " + re.escape(marker) + r"\n", "", text)
    hosts = {str(ipaddress.ip_address(p["host"])) for p in state["providers"].values() if p["mode"] == "ip"}
    if not hosts:
        return text
    if len(hosts) != 1:
        raise ValueError("Для нескольких IP нужны отдельные TLS-политики; автоматический default_sni неоднозначен")
    host = next(iter(hosts))
    existing = re.search(r"(?m)^\s*default_sni\s+(\S+)", text)
    if existing:
        if existing[1] != host:
            raise ValueError("В Caddyfile уже задан другой default_sni; пользовательская настройка не изменена")
        return text
    line = f"    default_sni {host} {marker}\n"
    opening = re.match(r"(?:\s|#[^\n]*\n)*\{[^\S\n]*\n", text)
    if opening:
        return text[:opening.end()] + line + text[opening.end():]
    return "{\n" + line + "}\n\n" + text


def proxy_override(state, root, has_caddy, bind_ip=""):
    sites = {"type": "bind", "source": str(root / "sites"), "target": "/etc/caddy/nexus-local", "read_only": True}
    ports = []
    if any(p["mode"] == "domain" for p in state["providers"].values()):
        ports += [80, 443]
    ports += [p["port"] for p in state["providers"].values() if p["mode"] == "ip"]
    published = [{"target": n, "published": str(n), "protocol": "tcp", **({"host_ip": bind_ip} if bind_ip else {})} for n in sorted(set(ports))]
    caddy = {"networks": ["default", "nexus-local"], "volumes": [sites], "ports": published}
    volumes = {}
    if not has_caddy:
        caddy.update(common_service("caddy:2"))
        caddy["volumes"] += [str(root / "Caddyfile") + ":/etc/caddy/Caddyfile:ro", "nexus_local_tls:/data", "nexus_local_caddy_config:/config"]
        volumes = {"nexus_local_tls": {}, "nexus_local_caddy_config": {}}
    return {"services": {"aggregator": {"networks": ["default", "nexus-local"]}, "caddy": caddy},
            "networks": {"nexus-local": {"external": True, "name": "nexus-local-" + state["instance"] + "-front"}}, "volumes": volumes}


def load_state(root, instance):
    file = root / "state.json"
    return json.loads(file.read_text(encoding="utf-8")) if file.exists() else {"instance": instance, "providers": {}}


def validate_names(state, args):
    names = [n.lower() for n in (args.panel_domain, args.sub_domain) if n]
    names = list(dict.fromkeys(names))
    for item in state["providers"].values():
        if item["mode"] == "domain":
            name = domain(item["host"])
            if name in names:
                raise ValueError("Домен служебной панели совпадает с другим сайтом: " + name)
            names.append(name)
        else:
            ipaddress.ip_address(item["host"])
            if item["port"] == args.app_port:
                raise ValueError("Порт 3x-ui совпадает с портом Nexus")
    return state


def run(command, quiet=False):
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE if quiet else None, stderr=subprocess.PIPE if quiet else None)
    if result.returncode:
        # Commands may contain generated passwords; never format argv in errors.
        raise RuntimeError("Команда Docker завершилась с ошибкой; состояние сохранено, повторите мастер после проверки Docker/сети")
    return result.stdout or ""


def ensure_3xui_initialized(item, root):
    folder = root / "3xui"
    marker = folder / ".initialized"
    if marker.exists():
        return
    credentials = json.loads((folder / "credentials.json").read_text(encoding="utf-8"))
    db = folder / "db"
    db.mkdir(parents=True, exist_ok=True)
    base = ["docker", "run", "--rm", "--network", "none", "-v", str(db) + ":/etc/x-ui", "--entrypoint", "/app/x-ui", item["image"], "setting"]
    run(base + ["-port", "2053", "-listenIP", "0.0.0.0", "-webBasePath", credentials["path"], "-username", credentials["username"], "-password", credentials["password"]], quiet=True)
    shown = run(base + ["-show", "true"], quiet=True)
    if "hasDefaultCredential: false" not in shown or not re.search(r"port:\s*2053\b", shown) or credentials["path"] not in shown:
        raise ValueError("Не подтверждена безопасная инициализация 3x-ui. Публичный запуск остановлен; проверьте совместимость выбранной версии.")
    if item.get("supports_api_token") and not credentials.get("api_token"):
        try:
            credentials["api_token"] = parse_api_token(run(base + ["-getApiToken"], quiet=True))
            private_write(folder / "credentials.json", json.dumps(credentials, indent=2) + "\n")
        except (RuntimeError, ValueError):
            print("API-токен не получен. Вход по логину/паролю доступен; создать токен можно через x-ui token или настройки 3x-ui.")
    private_write(marker, item["version"] + "\n")


def apply_providers(state, root):
    # A repeated run never chooses another version or resets existing credentials.
    if "--wait" not in run(["docker", "compose", "up", "--help"], quiet=True):
        raise ValueError("Нужен современный Docker Compose с поддержкой up --wait; обновите Compose")
    project = root / "docker-compose.yml"
    private_write(project, json.dumps(provider_compose(state, root), indent=2) + "\n")
    base = ["docker", "compose", "--project-directory", str(root), "-f", str(project)]
    run(base + ["config", "--quiet"])
    run(base + ["pull"])
    if "3xui" in state["providers"]:
        ensure_3xui_initialized(state["providers"]["3xui"], root)
    run(base + ["up", "-d", "--wait", "--wait-timeout", "180"])


def wizard(args, root):
    state = load_state(root, args.instance)
    print("\nДополнительные панели на этом же VPS (существующие внешние панели не меняются)")
    print("0 — только Nexus / оставить как есть (по умолчанию)\n1 — Nexus + 3x-ui\n2 — Nexus + Remnawave\n3 — Nexus + обе дополнительные панели (расширенный вариант)\nr — повторить незавершённый запуск без смены версий")
    choice = ask("Выбор", "0").lower()
    if choice == "0":
        return
    if choice == "r":
        if not state["providers"]:
            raise ValueError("Нет сохранённого плана")
        validate_names(state, args)
        apply_providers(state, root)
        return
    if choice not in ("1", "2", "3"):
        raise ValueError("Нет такого пункта; ничего не изменено")
    requested = ["3xui", "remnawave"] if choice == "3" else ["3xui" if choice == "1" else "remnawave"]
    new = [kind for kind in requested if kind not in state["providers"]]
    if not new:
        print("Эти панели уже управляются мастером. Их версия и данные оставлены без изменений. Для повтора запуска выберите r.")
        return
    plan = copy.deepcopy(state)
    envs = {}
    for kind in new:
        item = {"version": choose_version(kind)}
        if kind == "3xui":
            source = fetch(f"https://raw.githubusercontent.com/MHSanaei/3x-ui/{item['version']}/main.go")
            if not all('"' + flag + '"' in source for flag in ("listenIP", "webBasePath", "username", "password", "port")):
                raise ValueError("CLI этой версии 3x-ui несовместим с безопасной инициализацией")
            item["image"] = "ghcr.io/mhsanaei/3x-ui:" + item["version"]
            item["supports_api_token"] = '"getApiToken"' in source
            choice_mode = ask("3x-ui: 1 — отдельный домен HTTPS; 2 — IP + порт HTTPS (локальный сертификат)", "1")
            if choice_mode not in ("1", "2"):
                raise ValueError("Неверный режим доступа")
            item["mode"] = "domain" if choice_mode == "1" else "ip"
            reserved_ports = {args.app_port, 80, 443}
            for existing in plan["providers"].values():
                if existing.get("mode") == "ip":
                    reserved_ports.add(existing["port"])
                reserved_ports.update(int(p.split('/')[0]) for p in existing.get("vpn_ports", []))
            if item["mode"] == "ip":
                item["host"] = str(ipaddress.ip_address(ask("Публичный IP сервера")))
                item["port"] = choose_ports("HTTPS-порт панели 3x-ui", 2053, ("tcp",), reserved_ports)[0][0]
                reserved_ports.add(item["port"])
                print("Браузер предупредит о локальном сертификате. Для доверенного HTTPS выберите домен.")
            else:
                item["host"] = domain(ask("Домен 3x-ui (например xui.example.com)"))
            item["vpn_ports"] = [f"{number}/{proto}" for number, proto in
                                 choose_ports("Порты Xray", 8443, ("tcp", "udp"), reserved_ports)]
            print("В inbound 3x-ui затем укажите выбранный порт Xray; публикация порта сама inbound не создаёт.")
        else:
            print("Remnawave: отдельный домен с HTTPS обязателен; БД, Redis и backend не публикуются наружу.")
            item.update(mode="domain", host=domain(ask("Домен Remnawave (например rw.example.com)")), image="remnawave/backend:" + item["version"].lstrip("v"))
            recipe, envs[kind] = remna_recipe(item["version"], item["host"])
            item.update(recipe)
        plan["providers"][kind] = item
    validate_names(plan, args)
    bindings = []
    for kind in new:
        item = plan["providers"][kind]
        if item["mode"] == "ip":
            bindings.append((item["port"], "tcp"))
        bindings += [(int(p.split("/")[0]), p.split("/")[1]) for p in item.get("vpn_ports", [])]
    reserved = {args.app_port, 80, 443}
    for n, proto in bindings:
        if n in reserved:
            raise ValueError(f"Порт {n} зарезервирован для Nexus / HTTPS; выберите другой порт")
    if len(bindings) != len(set(bindings)):
        raise ValueError("Порты панелей и Xray пересекаются")
    assert_ports_free(bindings)
    needs_web = any(p["mode"] == "domain" for p in plan["providers"].values())
    if needs_web and not args.has_web_proxy:
        assert_ports_free([(80, "tcp"), (443, "tcp")])
    print("\nБудет установлено:")
    for kind in new:
        p = plan["providers"][kind]
        print(f"  {kind} {p['version']} — {p['host']} ({p['mode']})")
        if p.get("mode") == "ip":
            print(f"    HTTPS-порт панели: {p['port']}")
        if p.get("vpn_ports"):
            print("    Порты Xray: " + ", ".join(p["vpn_ports"]))
    print(f"Данные: {root}. Нужны свободные ресурсы VPS. DNS доменов должен указывать на этот сервер.")
    disk = shutil.disk_usage(root.parent if root.parent.exists() else "/opt").free // (1024 ** 3)
    print(f"CPU: {os.cpu_count() or '?'}; свободное место: {disk} ГБ. Для Remnawave: минимум 2 CPU / 2 ГБ RAM / 20 ГБ диска, плюс ресурсы Nexus и Xray.")
    print("Чужие панели, firewall и существующие базы не изменяются. Remnawave Node этим шагом не устанавливается.")
    if ask("Продолжить? Введите ДА", "НЕТ").upper() not in ("ДА", "YES"):
        print("Отменено; конфигурация не записана.")
        return
    # Refuse adopting unrelated pre-existing data folders.
    for kind in new:
        if (root / kind).exists():
            raise ValueError(f"Каталог {root / kind} уже существует без управляемого назначения; он не будет перезаписан")
    root.mkdir(parents=True, exist_ok=True)
    os.chmod(root, 0o700)
    for kind in new:
        folder = root / kind
        folder.mkdir(mode=0o700)
        if kind == "3xui":
            credentials = {"username": "nexus_" + secrets.token_hex(4), "password": secrets.token_urlsafe(24), "path": "/" + secrets.token_hex(12) + "/"}
            private_write(folder / "credentials.json", json.dumps(credentials, indent=2) + "\n")
        else:
            private_write(folder / ".env", "\n".join(k + "=" + v for k, v in envs[kind].items()) + "\n")
            (folder / "valkey").mkdir(mode=0o777)
            os.chmod(folder / "valkey", 0o777)
    private_write(root / "state.json", json.dumps(plan, indent=2) + "\n")
    apply_providers(plan, root)


def render(args, root):
    state = validate_names(load_state(root, args.instance), args)
    if not state["providers"]:
        return
    app = Path(args.app_dir)
    override = app / "docker-compose.override.yml"
    ownership = root / "override-managed"
    if override.exists() and (not ownership.exists() or ownership.read_text().strip() != hashlib.sha256(override.read_bytes()).hexdigest()):
        raise ValueError("Найден пользовательский/изменённый docker-compose.override.yml. Автоматическая замена запрещена")
    base = (app / "docker-compose.yml").read_text(encoding="utf-8")
    has_caddy = bool(re.search(r"^  caddy:\s*$", base, re.M))
    private_write(root / "sites" / "panels.caddy", caddy_sites(state))
    import_line = "import /etc/caddy/nexus-local/*.caddy"
    private_write(root / "Caddyfile", caddy_default_sni(import_line + "\n", state))
    if has_caddy:
        caddyfile = app / "Caddyfile"
        text = caddyfile.read_text(encoding="utf-8")
        if import_line not in text:
            text += "\n# nexus-local-panels managed import\n" + import_line + "\n"
        private_write(caddyfile, caddy_default_sni(text, state))
    config = proxy_override(state, root, has_caddy, args.bind_ip)
    config["services"]["caddy"]["container_name"] = args.caddy_container
    private_write(override, json.dumps(config, indent=2) + "\n")
    private_write(ownership, hashlib.sha256(override.read_bytes()).hexdigest() + "\n")


def status(args, root):
    state = load_state(root, args.instance)
    if not state["providers"]:
        return
    print("\nДополнительные панели (запущены отдельным Docker Compose проектом):")
    for kind, item in state["providers"].items():
        host = item["host"]
        if item["mode"] == "ip":
            host = ("[" + host + "]" if ":" in host else host) + ":" + str(item["port"])
        path = ""
        if kind == "3xui":
            file = root / kind / "credentials.json"
            path = json.loads(file.read_text())["path"]
            print("  Логин/пароль 3x-ui сохранены только в root-файле: " + str(file))
            print("  В Nexus: API/Panel URL http://local-3xui:2053 ; Panel Path " + path)
            print(f"  Управление: x-ui-{args.instance} (или x-ui / xui, если имена свободны)")
            print("  Данные входа: x-ui credentials; новый API-токен: x-ui token (с подтверждением)")
        print(f"  {kind} {item['version']}: https://{host}{path}")
    if "remnawave" in state["providers"]:
        print("  Remnawave: создайте администратора сразу при первом входе, затем API-токен и подключите Remnawave Node.")
    print(f"  Состояние контейнеров: docker compose --project-directory {root} ps")
    print("  Данные этих панелей не входят в обычный backup Nexus — копируйте их отдельно.")


def require_admin():
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise ValueError("Запустите команду от root: sudo -i")


def xui_context(args, root):
    state = load_state(root, args.instance)
    if "3xui" not in state["providers"]:
        raise ValueError("В этом экземпляре нет управляемой Docker-панели 3x-ui")
    return state["providers"]["3xui"], ["docker", "compose", "--project-directory", str(root), "-f", str(root / "docker-compose.yml")]


def parse_api_token(output):
    match = re.search(r"(?m)^apiToken:\s*([^\s]+)\s*$", output)
    if not match:
        raise ValueError("3x-ui не подтвердил выдачу API-токена; секреты не изменены в файле")
    return match[1]


def show_credentials(args, root):
    require_admin()
    item, _ = xui_context(args, root)
    file = root / "3xui" / "credentials.json"
    credentials = json.loads(file.read_text(encoding="utf-8"))
    host = item["host"]
    if item["mode"] == "ip":
        host = (f"[{host}]" if ":" in host else host) + ":" + str(item["port"])
    # Never duplicate passwords into installer tee/journald or redirected logs.
    try:
        terminal = open("/dev/tty", "w", encoding="utf-8")
    except OSError:
        print("Секреты не выведены без терминала. Откройте SSH с TTY и выполните x-ui credentials. Файл: " + str(file))
        return
    with terminal:
        print("\n=== 3x-ui: сохранённые данные входа (не публикуйте этот блок) ===", file=terminal)
        print(f"Адрес: https://{host}{credentials['path']}", file=terminal)
        print("Логин: " + credentials["username"], file=terminal)
        print("Пароль: " + credentials["password"], file=terminal)
        print("API-токен: " + credentials.get("api_token", "не создан — x-ui token или настройки 3x-ui"), file=terminal)
        print("Nexus / API Panel URL: http://local-3xui:2053", file=terminal)
        print("Nexus / Panel Path: " + credentials["path"], file=terminal)
        print("Авторизация Nexus: API Token, если токен создан; иначе логин/пароль.", file=terminal)
        print("Порты Xray: " + ", ".join(item.get("vpn_ports", [])), file=terminal)
        print("Inbound ID: укажите ID созданного вами inbound в 3x-ui.", file=terminal)
        print("Если пароль/путь/токен меняли в веб-панели, сохранённые здесь значения могут устареть.", file=terminal)
        print("Внутренний порт 2053 и HTTP оставьте без изменений: внешний HTTPS обслуживает Caddy.", file=terminal)


def install_xui_cli(args, root, bin_dir=Path("/usr/local/bin")):
    require_admin()
    if "3xui" not in load_state(root, args.instance)["providers"]:
        return
    helper = Path(__file__).resolve()
    marker = f"# Nexus managed x-ui CLI: {args.instance}"
    script = ("#!/usr/bin/env bash\nset -euo pipefail\n" + marker + "\n"
              + 'if [ "$#" -gt 1 ]; then echo "Usage: x-ui [menu|status|credentials|password|token|start|stop|restart|logs|settings]"; exit 2; fi\n'
              + "exec python3 " + shlex.quote(str(helper)) + " xui --instance " + shlex.quote(args.instance)
              + ' --xui-action "${1:-menu}"\n')
    bin_dir.mkdir(parents=True, exist_ok=True)
    for name in (f"x-ui-{args.instance}", f"xui-{args.instance}", "x-ui", "xui"):
        target = bin_dir / name
        existing_command = shutil.which(name)
        if target.is_symlink() or (target.exists() and marker not in target.read_text(encoding="utf-8", errors="replace").splitlines()):
            print(f"Команда {name} уже существует, оставлена без изменений. Используйте x-ui-{args.instance}.")
            continue
        if not target.exists() and existing_command:
            print(f"Команда {name} уже найдена в PATH, не перекрываю её: {existing_command}")
            continue
        private_write(target, script)
        os.chmod(target, 0o755)


def xui_change(args, root, action):
    item, base = xui_context(args, root)
    file = root / "3xui" / "credentials.json"
    credentials = json.loads(file.read_text(encoding="utf-8"))
    if action == "password":
        username = ask("Новый логин", credentials["username"])
        password = getpass.getpass("Новый пароль (не отображается): ")
        if len(password) < 12 or len(password.encode("utf-8")) > 72 or password != getpass.getpass("Повторите пароль: "):
            raise ValueError("Пароли должны совпадать: минимум 12 символов, максимум 72 байта")
        if any(ord(c) < 32 for c in username + password):
            raise ValueError("Управляющие символы недопустимы")
        flags = ["-username", username, "-password", password]
    else:
        print("Будет создан/перевыпущен CLI API-токен. Прежний cli-fallback может перестать работать; обновите токен в Nexus.")
        flags = ["-getApiToken"]
    print("3x-ui и его VPN-соединения будут кратковременно остановлены. Nexus и Remnawave не останавливаются.")
    if ask("Продолжить? Введите ДА", "НЕТ").upper() not in ("ДА", "YES"):
        return
    running = bool(run(base + ["ps", "--status", "running", "-q", "local-3xui"], quiet=True).strip())
    if running:
        run(base + ["stop", "local-3xui"])
    try:
        # Offline backup includes SQLite sidecars and belongs to root only.
        backup = Path(tempfile.mkdtemp(prefix="xui-settings-backup-", dir=root))
        os.chmod(backup, 0o700)
        shutil.copytree(root / "3xui" / "db", backup / "db")
        shutil.copy2(file, backup / "credentials.json")
        print("Резервная копия перед изменением: " + str(backup))
        cli = ["docker", "run", "--rm", "--network", "none", "-v", str(root / "3xui" / "db") + ":/etc/x-ui",
               "--entrypoint", "/app/x-ui", item["image"], "setting"]
        output = run(cli + flags, quiet=True)
        if action == "password":
            if "Username and password updated successfully" not in output:
                raise ValueError("3x-ui не подтвердил смену пароля. Сохранённые данные не переписаны; резервная копия указана выше")
            credentials.update(username=username, password=password)
        else:
            credentials["api_token"] = parse_api_token(output)
        private_write(file, json.dumps(credentials, indent=2) + "\n")
    finally:
        if running:
            run(base + ["start", "local-3xui"])
    show_credentials(args, root)


def xui_action(args, root, action):
    require_admin()
    _, base = xui_context(args, root)
    if action == "credentials":
        show_credentials(args, root)
    elif action in ("password", "token"):
        xui_change(args, root, action)
    elif action == "status":
        run(base + ["ps", "-a", "local-3xui"])
    elif action == "logs":
        run(base + ["logs", "--tail", "80", "local-3xui"])
    elif action == "settings":
        print(run(base + ["exec", "-T", "local-3xui", "/app/x-ui", "setting", "-show", "true"], quiet=True))
        print("Внутренний HTTP без SSL — ожидаемо: внешний сертификат находится в Caddy.")
    elif action in ("start", "stop", "restart"):
        if action != "start" and ask("VPN-соединения 3x-ui прервутся. Продолжить? ДА", "НЕТ").upper() not in ("ДА", "YES"):
            return
        run(base + [action, "local-3xui"])
    else:
        choices = {"1": "status", "2": "credentials", "3": "password", "4": "token", "5": "start", "6": "stop", "7": "restart", "8": "logs", "9": "settings"}
        while True:
            print(f"\n3x-ui / Docker — экземпляр {args.instance}\n1 — Статус\n2 — Данные входа и подключения Nexus\n3 — Сменить логин/пароль\n4 — Создать/перевыпустить API-токен\n5 — Запустить\n6 — Остановить\n7 — Перезапустить\n8 — Журнал\n9 — Текущие настройки\n0 — Выход")
            choice = ask("Выбор", "0")
            if choice == "0":
                return
            if choice in choices:
                try:
                    xui_action(args, root, choices[choice])
                except (RuntimeError, ValueError, OSError) as exc:
                    print(str(exc))
            else:
                print("Выберите пункт 0–9")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("wizard", "render", "status", "validate", "needs-web", "releases", "install-cli", "credentials", "xui"))
    parser.add_argument("--xui-action", choices=("menu", "status", "credentials", "password", "token", "start", "stop", "restart", "logs", "settings"), default="menu")
    parser.add_argument("--instance", default="default")
    parser.add_argument("--app-dir", default="/opt/3xui-aggregator")
    parser.add_argument("--panel-domain", default="")
    parser.add_argument("--sub-domain", default="")
    parser.add_argument("--app-port", type=int, default=3000)
    parser.add_argument("--bind-ip", default="")
    parser.add_argument("--has-web-proxy", action="store_true")
    parser.add_argument("--caddy-container", default="3xui-aggregator-caddy")
    parser.add_argument("--kind", choices=tuple(REPOS), default="3xui")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,40}", args.instance):
        raise ValueError("Неверное имя экземпляра")
    if args.bind_ip:
        ipaddress.ip_address(args.bind_ip)
    root = Path("/opt/nexus-local-panels") / args.instance
    if args.action == "releases":
        print("\n".join(stable_releases(args.kind)))
    elif args.action == "needs-web":
        sys.exit(0 if any(p["mode"] == "domain" for p in load_state(root, args.instance)["providers"].values()) else 1)
    elif args.action == "validate":
        validate_names(load_state(root, args.instance), args)
    elif args.action == "status":
        status(args, root)
    elif args.action == "credentials":
        if "3xui" in load_state(root, args.instance)["providers"]:
            show_credentials(args, root)
    elif args.action == "install-cli":
        install_xui_cli(args, root)
    elif args.action == "xui":
        xui_action(args, root, args.xui_action)
    else:
        if not hasattr(os, "geteuid") or os.geteuid() != 0:
            raise ValueError("Запустите установщик от root на Linux VPS")
        if args.action == "wizard":
            wizard(args, root)
        else:
            render(args, root)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, EOFError, KeyboardInterrupt) as exc:
        print("Локальные панели: " + (str(exc) or "Ввод прерван; операция отменена"), file=sys.stderr)
        sys.exit(1)
