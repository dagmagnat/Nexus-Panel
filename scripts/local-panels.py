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
import json
import os
from pathlib import Path
import re
import secrets
import shutil
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
    print("0 — только Nexus / оставить как есть (по умолчанию)\n1 — добавить 3x-ui\n2 — добавить Remnawave\n3 — добавить обе\nr — повторить незавершённый запуск без смены версий")
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
            choice_mode = ask("3x-ui: 1 — отдельный домен HTTPS; 2 — IP + порт HTTPS (локальный сертификат)", "1")
            if choice_mode not in ("1", "2"):
                raise ValueError("Неверный режим доступа")
            item["mode"] = "domain" if choice_mode == "1" else "ip"
            if item["mode"] == "ip":
                item["host"] = str(ipaddress.ip_address(ask("Публичный IP сервера")))
                item["port"] = port(ask("HTTPS-порт панели 3x-ui", "2053"))
                print("Браузер предупредит о локальном сертификате. Для доверенного HTTPS выберите домен.")
            else:
                item["host"] = domain(ask("Домен 3x-ui (например xui.example.com)"))
            item["vpn_ports"] = vpn_ports(ask("Порты Xray для публикации, через запятую", "8443/tcp,8443/udp"))
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
    private_write(root / "Caddyfile", import_line + "\n")
    if has_caddy:
        caddyfile = app / "Caddyfile"
        text = caddyfile.read_text(encoding="utf-8")
        if import_line not in text:
            private_write(caddyfile, text + "\n# nexus-local-panels managed import\n" + import_line + "\n")
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
        print(f"  {kind} {item['version']}: https://{host}{path}")
    if "remnawave" in state["providers"]:
        print("  Remnawave: создайте администратора сразу при первом входе, затем API-токен и подключите Remnawave Node.")
    print(f"  Состояние контейнеров: docker compose --project-directory {root} ps")
    print("  Данные этих панелей не входят в обычный backup Nexus — копируйте их отдельно.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("wizard", "render", "status", "validate", "needs-web", "releases"))
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
