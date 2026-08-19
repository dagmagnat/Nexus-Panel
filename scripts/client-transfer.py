#!/usr/bin/env python3
"""Portable Nexus Panel client export/import utility.

The tool deliberately talks to SQLite directly, so it can recover clients even
when the web application or Docker stack does not start.  It exports client
credentials and local node assignments, but never exports node passwords or API
tokens and never contacts a remote 3x-ui/Remnawave server during import.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit


FORMAT_NAME = "nexus-panel-client-transfer"
SCHEMA_VERSION = 1
MAX_TRANSFER_BYTES = 100 * 1024 * 1024
MAX_CLIENTS = 200_000
DETAIL_LIMIT = 100


class TransferError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def payload_hash(clients: list[dict[str, Any]]) -> str:
    return hashlib.sha256(canonical_json(clients)).hexdigest()


def clamp_int(value: Any, default: int = 0, minimum: int = 0, maximum: int = 2**63 - 1) -> int:
    try:
        number = int(float(value))
    except (TypeError, ValueError, OverflowError):
        number = default
    return max(minimum, min(maximum, number))


def bool_int(value: Any, default: int = 1) -> int:
    if value is None:
        return 1 if default else 0
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"0", "false", "no", "off", "disabled"}:
            return 0
        if normalized in {"1", "true", "yes", "on", "enabled"}:
            return 1
    return 1 if bool(value) else 0


def clean_text(value: Any, default: str = "", maximum: int = 16_384) -> str:
    if value is None:
        return default
    return str(value).replace("\x00", "").strip()[:maximum]


def clean_color(value: Any, default: str) -> str:
    color = clean_text(value, "", 7).lower()
    if len(color) == 7 and color.startswith("#") and all(ch in "0123456789abcdef" for ch in color[1:]):
        return color
    return default


def get_first(mapping: dict[str, Any], *keys: str, default: Any = None) -> Any:
    for key in keys:
        if key in mapping:
            return mapping[key]
    return default


def row_value(row: sqlite3.Row | None, key: str, default: Any = None) -> Any:
    if row is None:
        return default
    return row[key] if key in row.keys() else default


def normalize_node_type(value: Any) -> str:
    raw = clean_text(value, "3xui", 80).lower().replace("_", "-")
    aliases = {
        "3x-ui": "3xui",
        "x-ui": "3xui",
        "xui": "3xui",
        "remna": "remnawave",
    }
    return aliases.get(raw, raw or "3xui")


def normalize_panel_url(value: Any) -> str:
    raw = clean_text(value, "", 2048).rstrip("/")
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw if "://" in raw else f"https://{raw}")
        scheme = parsed.scheme.lower()
        host = (parsed.hostname or "").lower()
        if not host:
            return raw.lower()
        default_port = (scheme == "https" and parsed.port == 443) or (scheme == "http" and parsed.port == 80)
        port = "" if default_port or parsed.port is None else f":{parsed.port}"
        netloc = f"{host}{port}"
        path = parsed.path.rstrip("/")
        return urlunsplit((scheme, netloc, path, "", ""))
    except (ValueError, TypeError):
        return raw.lower()


def normalize_panel_path(value: Any) -> str:
    raw = clean_text(value, "", 1024).strip("/")
    return f"/{raw}" if raw else ""


def table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)).fetchone() is not None


def table_columns(conn: sqlite3.Connection, name: str) -> set[str]:
    if not table_exists(conn, name):
        return set()
    return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{name}")')}


def require_database(conn: sqlite3.Connection, *, importing: bool = False) -> None:
    required = {"clients"}
    if importing:
        required.add("client_nodes")
    missing = sorted(name for name in required if not table_exists(conn, name))
    if missing:
        raise TransferError("В базе не найдены таблицы Nexus Panel: " + ", ".join(missing))
    client_columns = table_columns(conn, "clients")
    required_client_columns = {"id", "login", "display_name", "uuid", "sub_slug"}
    missing_columns = sorted(required_client_columns - client_columns)
    if missing_columns:
        raise TransferError("Несовместимая таблица clients; отсутствуют поля: " + ", ".join(missing_columns))


def open_readonly_database(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise TransferError(f"Файл базы не найден: {path}")
    conn = sqlite3.connect(f"file:{path.resolve()}?mode=ro", uri=True, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    return conn


def open_writable_database(path: Path) -> sqlite3.Connection:
    if not path.is_file():
        raise TransferError(f"Файл базы не найден: {path}")
    conn = sqlite3.connect(str(path.resolve()), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def export_assignment(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "nodeRef": {
            "sourceId": clamp_int(row_value(row, "node_id"), 0),
            "name": clean_text(row_value(row, "node_name"), "", 500),
            "nodeType": normalize_node_type(row_value(row, "node_type")),
            # Normalize the endpoint and deliberately strip any accidental
            # user:password@ credentials embedded in panel_url.
            "panelUrl": normalize_panel_url(row_value(row, "panel_url")),
            "panelPath": clean_text(row_value(row, "panel_path"), "", 1024),
            "inboundId": clamp_int(row_value(row, "inbound_id"), 0),
            "countryCode": clean_text(row_value(row, "country_code"), "", 16),
            "labelSuffix": clean_text(row_value(row, "label_suffix"), "", 500),
        },
        "remoteEmail": clean_text(row_value(row, "remote_email"), "", 500),
        "remoteUuid": clean_text(row_value(row, "remote_uuid"), "", 500),
        "remoteSubUrl": clean_text(row_value(row, "remote_sub_url"), "", 8192),
        "trafficGb": clamp_int(row_value(row, "node_traffic_gb"), 0),
        "limitIp": None if row_value(row, "node_limit_ip") is None else clamp_int(row_value(row, "node_limit_ip"), 0),
        "uploadBytes": clamp_int(row_value(row, "upload_bytes"), 0),
        "downloadBytes": clamp_int(row_value(row, "download_bytes"), 0),
        "usedBytes": clamp_int(row_value(row, "used_bytes"), 0),
        "enabled": bool_int(row_value(row, "node_enabled"), 1),
        "createdAt": clean_text(row_value(row, "node_created_at"), "", 100),
    }


def export_clients(db_path: Path) -> dict[str, Any]:
    conn = open_readonly_database(db_path)
    try:
        require_database(conn)
        client_rows = conn.execute("SELECT * FROM clients ORDER BY id").fetchall()
        if len(client_rows) > MAX_CLIENTS:
            raise TransferError(f"Слишком много клиентов для одного файла: {len(client_rows)}")

        assignments_by_client: dict[int, list[dict[str, Any]]] = {}
        group_by_id: dict[int, dict[str, Any]] = {}
        tags_by_client: dict[int, list[dict[str, Any]]] = {}
        if table_exists(conn, "client_groups"):
            for group in conn.execute("SELECT id, name, color FROM client_groups ORDER BY id"):
                group_by_id[clamp_int(row_value(group, "id"), 0)] = {
                    "name": clean_text(row_value(group, "name"), "", 64),
                    "color": clean_color(row_value(group, "color"), "#64748b"),
                }
        if table_exists(conn, "client_tags") and table_exists(conn, "client_tag_assignments"):
            for tag in conn.execute("""
                SELECT a.client_id, t.name, t.color
                FROM client_tag_assignments a
                JOIN client_tags t ON t.id = a.tag_id
                ORDER BY a.client_id, t.name COLLATE NOCASE
            """):
                client_id = clamp_int(row_value(tag, "client_id"), 0)
                tags_by_client.setdefault(client_id, []).append({
                    "name": clean_text(row_value(tag, "name"), "", 64),
                    "color": clean_color(row_value(tag, "color"), "#3b82f6"),
                })
        if table_exists(conn, "client_nodes"):
            client_node_columns = table_columns(conn, "client_nodes")
            node_columns = table_columns(conn, "nodes")

            def cn(name: str, alias: str | None = None, fallback: str = "NULL") -> str:
                return f'cn."{name}" AS "{alias or name}"' if name in client_node_columns else f'{fallback} AS "{alias or name}"'

            def node(name: str, alias: str | None = None, fallback: str = "NULL") -> str:
                if node_columns:
                    return f'n."{name}" AS "{alias or name}"' if name in node_columns else f'{fallback} AS "{alias or name}"'
                return f'{fallback} AS "{alias or name}"'

            join = "LEFT JOIN nodes n ON n.id = cn.node_id" if node_columns else ""
            assignment_sql = f"""
                SELECT
                  {cn('client_id')}, {cn('node_id')},
                  {cn('remote_email')}, {cn('remote_uuid')}, {cn('remote_sub_url', fallback="''")},
                  {cn('traffic_gb', 'node_traffic_gb', '0')}, {cn('limit_ip', 'node_limit_ip')},
                  {cn('upload_bytes', fallback='0')}, {cn('download_bytes', fallback='0')},
                  {cn('used_bytes', fallback='0')}, {cn('enabled', 'node_enabled', '1')},
                  {cn('created_at', 'node_created_at', "''")},
                  {node('name', 'node_name', "''")}, {node('node_type', fallback="'3xui'")},
                  {node('panel_url', fallback="''")}, {node('panel_path', fallback="''")},
                  {node('inbound_id', fallback='0')}, {node('country_code', fallback="''")},
                  {node('label_suffix', fallback="''")}
                FROM client_nodes cn
                {join}
                ORDER BY cn.client_id, cn.id
            """
            for row in conn.execute(assignment_sql):
                client_id = clamp_int(row_value(row, "client_id"), 0)
                if client_id:
                    assignments_by_client.setdefault(client_id, []).append(export_assignment(row))

        clients: list[dict[str, Any]] = []
        for row in client_rows:
            login = clean_text(row_value(row, "login"), "", 500)
            client_id = clamp_int(row_value(row, "id"), 0)
            clients.append({
                "login": login,
                "displayName": clean_text(row_value(row, "display_name"), login, 500) or login,
                "uuid": clean_text(row_value(row, "uuid"), "", 500),
                "subSlug": clean_text(row_value(row, "sub_slug"), "", 500),
                "durationDays": clamp_int(row_value(row, "duration_days"), 0),
                "trafficGb": clamp_int(row_value(row, "traffic_gb"), 0),
                "limitIp": clamp_int(row_value(row, "limit_ip"), 1),
                "deviceLimit": clamp_int(row_value(row, "device_limit"), clamp_int(row_value(row, "limit_ip"), 1)),
                "expiryTime": clamp_int(row_value(row, "expiry_time"), 0),
                "enabled": bool_int(row_value(row, "enabled"), 1),
                "comment": clean_text(row_value(row, "comment"), "", 16_384),
                "flow": clean_text(row_value(row, "flow"), "", 500),
                "lastOnlineAt": clean_text(row_value(row, "last_online_at"), "", 100),
                "createdAt": clean_text(row_value(row, "created_at"), "", 100),
                "group": group_by_id.get(clamp_int(row_value(row, "group_id"), 0)),
                "tags": tags_by_client.get(client_id, []),
                "nodeAssignments": assignments_by_client.get(client_id, []),
            })

        version_file = Path(__file__).resolve().parent.parent / "VERSION"
        app_version = clean_text(version_file.read_text(encoding="utf-8") if version_file.is_file() else "", "unknown", 200)
        assignment_count = sum(len(client["nodeAssignments"]) for client in clients)
        document = {
            "format": FORMAT_NAME,
            "schemaVersion": SCHEMA_VERSION,
            "exportedAt": utc_now(),
            "source": {
                "application": "Nexus Panel / 3x-ui Aggregator",
                "appVersion": app_version,
                "clientCount": len(clients),
                "assignmentCount": assignment_count,
            },
            "clients": clients,
        }
        document["integrity"] = {"algorithm": "sha256", "clients": payload_hash(clients)}
        return document
    finally:
        conn.close()


def write_document(document: dict[str, Any], output: str) -> None:
    encoded = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    if output == "-":
        sys.stdout.buffer.write(encoded)
        return

    target = Path(output).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent))
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, target)
        os.chmod(target, 0o600)
    except Exception:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except OSError:
            pass
        raise


def load_document(input_path: str) -> dict[str, Any]:
    path = Path(input_path).expanduser().resolve()
    if not path.is_file():
        raise TransferError(f"Файл переноса не найден: {path}")
    size = path.stat().st_size
    if size > MAX_TRANSFER_BYTES:
        raise TransferError(f"Файл слишком большой: {size} байт (лимит {MAX_TRANSFER_BYTES})")
    try:
        value = json.loads(path.read_text(encoding="utf-8-sig"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise TransferError(f"Некорректный JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise TransferError("Корень файла переноса должен быть JSON-объектом")
    return value


def validate_document(document: dict[str, Any]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    errors: list[str] = []
    warnings: list[str] = []
    if document.get("format") != FORMAT_NAME:
        errors.append(f"Неизвестный формат: {document.get('format')!r}")
    if clamp_int(document.get("schemaVersion"), 0) != SCHEMA_VERSION:
        errors.append(f"Неподдерживаемая версия схемы: {document.get('schemaVersion')!r}")
    raw_clients = document.get("clients")
    if not isinstance(raw_clients, list):
        errors.append("Поле clients должно быть массивом")
        raw_clients = []
    if len(raw_clients) > MAX_CLIENTS:
        errors.append(f"В файле слишком много клиентов: {len(raw_clients)}")

    integrity = document.get("integrity")
    if isinstance(integrity, dict) and integrity.get("clients"):
        actual_hash = payload_hash(raw_clients)
        if clean_text(integrity.get("algorithm"), "").lower() != "sha256" or clean_text(integrity.get("clients"), "").lower() != actual_hash:
            errors.append("Контрольная сумма файла не совпадает; файл повреждён или изменён")
    else:
        warnings.append("В файле нет контрольной суммы; содержимое будет проверено только по структуре")

    normalized: list[dict[str, Any]] = []
    seen: dict[str, dict[str, int]] = {"login": {}, "uuid": {}, "subSlug": {}}
    assignment_count = 0
    for index, raw in enumerate(raw_clients, start=1):
        if not isinstance(raw, dict):
            errors.append(f"Клиент #{index}: запись должна быть объектом")
            continue
        login = clean_text(get_first(raw, "login"), "", 500)
        uuid = clean_text(get_first(raw, "uuid"), "", 500)
        sub_slug = clean_text(get_first(raw, "subSlug", "sub_slug"), "", 500)
        if not login:
            errors.append(f"Клиент #{index}: пустой login")
        if not uuid:
            errors.append(f"Клиент #{index}: пустой UUID")
        if not sub_slug:
            errors.append(f"Клиент #{index}: пустой subSlug")
        if any(ch.isspace() or ch in "/\\" for ch in sub_slug):
            errors.append(f"Клиент #{index}: subSlug содержит запрещённые пробелы или слеши")

        identities = {"login": login.casefold(), "uuid": uuid.casefold(), "subSlug": sub_slug}
        for kind, identity in identities.items():
            if not identity:
                continue
            previous = seen[kind].get(identity)
            if previous:
                errors.append(f"Клиенты #{previous} и #{index}: повторяется {kind}")
            else:
                seen[kind][identity] = index

        raw_assignments = get_first(raw, "nodeAssignments", "node_assignments", default=[])
        if raw_assignments is None:
            raw_assignments = []
        if not isinstance(raw_assignments, list):
            errors.append(f"Клиент #{index}: nodeAssignments должно быть массивом")
            raw_assignments = []
        assignments: list[dict[str, Any]] = []
        for assignment_index, assignment in enumerate(raw_assignments, start=1):
            if not isinstance(assignment, dict):
                errors.append(f"Клиент #{index}, связь #{assignment_index}: запись должна быть объектом")
                continue
            raw_ref = get_first(assignment, "nodeRef", "node_ref", default={})
            if not isinstance(raw_ref, dict):
                raw_ref = {}
            normalized_assignment = {
                "nodeRef": {
                    "sourceId": clamp_int(get_first(raw_ref, "sourceId", "source_id"), 0),
                    "name": clean_text(get_first(raw_ref, "name"), "", 500),
                    "nodeType": normalize_node_type(get_first(raw_ref, "nodeType", "node_type", default="3xui")),
                    "panelUrl": clean_text(get_first(raw_ref, "panelUrl", "panel_url"), "", 2048),
                    "panelPath": clean_text(get_first(raw_ref, "panelPath", "panel_path"), "", 1024),
                    "inboundId": clamp_int(get_first(raw_ref, "inboundId", "inbound_id"), 0),
                    "countryCode": clean_text(get_first(raw_ref, "countryCode", "country_code"), "", 16),
                    "labelSuffix": clean_text(get_first(raw_ref, "labelSuffix", "label_suffix"), "", 500),
                },
                "remoteEmail": clean_text(get_first(assignment, "remoteEmail", "remote_email"), login, 500) or login,
                "remoteUuid": clean_text(get_first(assignment, "remoteUuid", "remote_uuid"), uuid, 500) or uuid,
                "remoteSubUrl": clean_text(get_first(assignment, "remoteSubUrl", "remote_sub_url"), "", 8192),
                "trafficGb": clamp_int(get_first(assignment, "trafficGb", "traffic_gb"), clamp_int(get_first(raw, "trafficGb", "traffic_gb"), 0)),
                "limitIp": None if get_first(assignment, "limitIp", "limit_ip") is None else clamp_int(get_first(assignment, "limitIp", "limit_ip"), 0),
                "uploadBytes": clamp_int(get_first(assignment, "uploadBytes", "upload_bytes"), 0),
                "downloadBytes": clamp_int(get_first(assignment, "downloadBytes", "download_bytes"), 0),
                "usedBytes": clamp_int(get_first(assignment, "usedBytes", "used_bytes"), 0),
                "enabled": bool_int(get_first(assignment, "enabled"), 1),
                "createdAt": clean_text(get_first(assignment, "createdAt", "created_at"), "", 100),
            }
            assignments.append(normalized_assignment)
        assignment_count += len(assignments)
        metadata_present = "group" in raw or "tags" in raw
        raw_group = get_first(raw, "group")
        group = None
        if isinstance(raw_group, dict):
            group_name = clean_text(get_first(raw_group, "name"), "", 64)
            if group_name:
                group = {"name": group_name, "color": clean_color(get_first(raw_group, "color"), "#64748b")}
        raw_tags = get_first(raw, "tags", default=[])
        if not isinstance(raw_tags, list):
            errors.append(f"Клиент #{index}: tags должно быть массивом")
            raw_tags = []
        tags: list[dict[str, Any]] = []
        seen_tag_names: set[str] = set()
        for raw_tag in raw_tags:
            if not isinstance(raw_tag, dict):
                continue
            tag_name = clean_text(get_first(raw_tag, "name"), "", 64)
            if not tag_name or tag_name.casefold() in seen_tag_names:
                continue
            seen_tag_names.add(tag_name.casefold())
            tags.append({"name": tag_name, "color": clean_color(get_first(raw_tag, "color"), "#3b82f6")})
        normalized.append({
            "login": login,
            "displayName": clean_text(get_first(raw, "displayName", "display_name"), login, 500) or login,
            "uuid": uuid,
            "subSlug": sub_slug,
            "durationDays": clamp_int(get_first(raw, "durationDays", "duration_days"), 0),
            "trafficGb": clamp_int(get_first(raw, "trafficGb", "traffic_gb"), 0),
            "limitIp": clamp_int(get_first(raw, "limitIp", "limit_ip"), 1),
            "deviceLimit": clamp_int(get_first(raw, "deviceLimit", "device_limit"), clamp_int(get_first(raw, "limitIp", "limit_ip"), 1)),
            "expiryTime": clamp_int(get_first(raw, "expiryTime", "expiry_time"), 0),
            "enabled": bool_int(get_first(raw, "enabled"), 1),
            "comment": clean_text(get_first(raw, "comment"), "", 16_384),
            "flow": clean_text(get_first(raw, "flow"), "", 500),
            "lastOnlineAt": clean_text(get_first(raw, "lastOnlineAt", "last_online_at"), "", 100),
            "createdAt": clean_text(get_first(raw, "createdAt", "created_at"), "", 100),
            "metadataPresent": metadata_present,
            "group": group,
            "tags": tags,
            "nodeAssignments": assignments,
        })

    summary = {
        "ok": not errors,
        "format": document.get("format"),
        "schemaVersion": document.get("schemaVersion"),
        "exportedAt": clean_text(document.get("exportedAt"), "", 100),
        "source": document.get("source") if isinstance(document.get("source"), dict) else {},
        "clients": len(normalized),
        "assignments": assignment_count,
        "errors": errors[:DETAIL_LIMIT],
        "errorCount": len(errors),
        "warnings": warnings[:DETAIL_LIMIT],
        "warningCount": len(warnings),
        "sensitive": True,
    }
    if errors:
        raise TransferError("; ".join(errors[:10]))
    return normalized, summary


def list_local_nodes(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    if not table_exists(conn, "nodes"):
        return []
    return conn.execute("SELECT * FROM nodes ORDER BY id").fetchall()


def match_node(node_ref: dict[str, Any], nodes: list[sqlite3.Row]) -> tuple[sqlite3.Row | None, str]:
    wanted_type = normalize_node_type(node_ref.get("nodeType"))
    wanted_url = normalize_panel_url(node_ref.get("panelUrl"))
    wanted_path = normalize_panel_path(node_ref.get("panelPath"))
    wanted_inbound = clamp_int(node_ref.get("inboundId"), 0)

    exact = [node for node in nodes if (
        normalize_node_type(row_value(node, "node_type")) == wanted_type
        and normalize_panel_url(row_value(node, "panel_url")) == wanted_url
        and normalize_panel_path(row_value(node, "panel_path")) == wanted_path
        and clamp_int(row_value(node, "inbound_id"), 0) == wanted_inbound
    )]
    if len(exact) == 1:
        return exact[0], "endpoint"
    if len(exact) > 1:
        return None, "ambiguous endpoint"

    wanted_name = clean_text(node_ref.get("name"), "", 500).casefold()
    fallback = [node for node in nodes if (
        wanted_name
        and clean_text(row_value(node, "name"), "", 500).casefold() == wanted_name
        and normalize_node_type(row_value(node, "node_type")) == wanted_type
        and clamp_int(row_value(node, "inbound_id"), 0) == wanted_inbound
    )]
    if len(fallback) == 1:
        return fallback[0], "name"
    if len(fallback) > 1:
        return None, "ambiguous name"
    return None, "not found"


def find_existing_clients(conn: sqlite3.Connection, client: dict[str, Any]) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM clients
        WHERE lower(login) = lower(?) OR lower(uuid) = lower(?) OR sub_slug = ?
        ORDER BY id
        """,
        (client["login"], client["uuid"], client["subSlug"]),
    ).fetchall()


def column_value_map(client: dict[str, Any], available: set[str]) -> dict[str, Any]:
    candidates = {
        "login": client["login"],
        "display_name": client["displayName"],
        "uuid": client["uuid"],
        "sub_slug": client["subSlug"],
        "duration_days": client["durationDays"],
        "traffic_gb": client["trafficGb"],
        "limit_ip": client["limitIp"],
        "device_limit": client["deviceLimit"],
        "expiry_time": client["expiryTime"],
        "enabled": client["enabled"],
        "comment": client["comment"],
        "flow": client["flow"],
        "last_online_at": client["lastOnlineAt"],
        "created_at": client["createdAt"] or utc_now(),
    }
    return {key: value for key, value in candidates.items() if key in available}


def create_client(conn: sqlite3.Connection, client: dict[str, Any], columns: set[str]) -> int:
    values = column_value_map(client, columns)
    names = list(values)
    placeholders = ", ".join("?" for _ in names)
    cursor = conn.execute(
        f"INSERT INTO clients ({', '.join(names)}) VALUES ({placeholders})",
        tuple(values[name] for name in names),
    )
    return int(cursor.lastrowid)


def update_client(conn: sqlite3.Connection, client_id: int, client: dict[str, Any], columns: set[str]) -> None:
    values = column_value_map(client, columns)
    # Keep the target database's original creation time for existing clients.
    values.pop("created_at", None)
    names = list(values)
    conn.execute(
        f"UPDATE clients SET {', '.join(f'{name} = ?' for name in names)} WHERE id = ?",
        tuple(values[name] for name in names) + (client_id,),
    )


def apply_client_metadata(conn: sqlite3.Connection, client_id: int, client: dict[str, Any]) -> None:
    if not client.get("metadataPresent"):
        return
    client_columns = table_columns(conn, "clients")
    if "group_id" in client_columns and table_exists(conn, "client_groups"):
        group_id = None
        group = client.get("group")
        if isinstance(group, dict) and group.get("name"):
            existing = conn.execute("SELECT id FROM client_groups WHERE lower(name)=lower(?)", (group["name"],)).fetchone()
            if existing:
                group_id = int(existing["id"])
            else:
                group_id = int(conn.execute(
                    "INSERT INTO client_groups (name, color) VALUES (?, ?)",
                    (group["name"], group["color"]),
                ).lastrowid)
        conn.execute("UPDATE clients SET group_id=? WHERE id=?", (group_id, client_id))

    if table_exists(conn, "client_tags") and table_exists(conn, "client_tag_assignments"):
        conn.execute("DELETE FROM client_tag_assignments WHERE client_id=?", (client_id,))
        for tag in client.get("tags", []):
            existing = conn.execute("SELECT id FROM client_tags WHERE lower(name)=lower(?)", (tag["name"],)).fetchone()
            if existing:
                tag_id = int(existing["id"])
            else:
                tag_id = int(conn.execute(
                    "INSERT INTO client_tags (name, color) VALUES (?, ?)",
                    (tag["name"], tag["color"]),
                ).lastrowid)
            conn.execute(
                "INSERT OR IGNORE INTO client_tag_assignments (client_id, tag_id) VALUES (?, ?)",
                (client_id, tag_id),
            )


def upsert_matched_assignment(
    conn: sqlite3.Connection,
    client_id: int,
    node_id: int,
    assignment: dict[str, Any],
    available: set[str],
) -> str:
    values = {
        "client_id": client_id,
        "node_id": node_id,
        "remote_email": assignment["remoteEmail"],
        "remote_uuid": assignment["remoteUuid"],
        "remote_sub_url": assignment["remoteSubUrl"],
        "traffic_gb": assignment["trafficGb"],
        "limit_ip": assignment["limitIp"],
        "upload_bytes": assignment["uploadBytes"],
        "download_bytes": assignment["downloadBytes"],
        "used_bytes": max(assignment["usedBytes"], assignment["uploadBytes"] + assignment["downloadBytes"]),
        "enabled": assignment["enabled"],
        "created_at": assignment["createdAt"] or utc_now(),
    }
    values = {key: value for key, value in values.items() if key in available}
    existing = conn.execute("SELECT id FROM client_nodes WHERE client_id=? AND node_id=?", (client_id, node_id)).fetchone()
    if existing:
        update_values = {key: value for key, value in values.items() if key not in {"client_id", "node_id", "created_at"}}
        conn.execute(
            f"UPDATE client_nodes SET {', '.join(f'{key} = ?' for key in update_values)} WHERE id = ?",
            tuple(update_values.values()) + (int(existing["id"]),),
        )
        return "updated"
    names = list(values)
    conn.execute(
        f"INSERT INTO client_nodes ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})",
        tuple(values[name] for name in names),
    )
    return "created"


def create_selected_assignment(
    conn: sqlite3.Connection,
    client_id: int,
    node_id: int,
    client: dict[str, Any],
    available: set[str],
) -> str:
    existing = conn.execute("SELECT id FROM client_nodes WHERE client_id=? AND node_id=?", (client_id, node_id)).fetchone()
    if existing:
        return "skipped"
    values = {
        "client_id": client_id,
        "node_id": node_id,
        "remote_email": client["login"],
        "remote_uuid": client["uuid"],
        "remote_sub_url": "",
        "traffic_gb": client["trafficGb"],
        "limit_ip": client["limitIp"],
        "upload_bytes": 0,
        "download_bytes": 0,
        "used_bytes": 0,
        "enabled": client["enabled"],
        "created_at": utc_now(),
    }
    values = {key: value for key, value in values.items() if key in available}
    names = list(values)
    conn.execute(
        f"INSERT INTO client_nodes ({', '.join(names)}) VALUES ({', '.join('?' for _ in names)})",
        tuple(values[name] for name in names),
    )
    return "created"


def append_detail(result: dict[str, Any], key: str, value: dict[str, Any]) -> None:
    counter_key = "conflictCount" if key == "conflicts" else f"{key}Count"
    result[counter_key] = result.get(counter_key, 0) + 1
    bucket = result.setdefault(key, [])
    if len(bucket) < DETAIL_LIMIT:
        bucket.append(value)


def backup_database(conn: sqlite3.Connection, db_path: Path) -> Path:
    backup_dir = db_path.parent / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup_path = backup_dir / f"client-import-before-{stamp}.db"
    backup_conn = sqlite3.connect(str(backup_path))
    try:
        conn.backup(backup_conn)
    finally:
        backup_conn.close()
    os.chmod(backup_path, 0o600)
    return backup_path


def bump_subscription_revision(conn: sqlite3.Connection) -> None:
    columns = table_columns(conn, "app_settings")
    if not {"key", "value"}.issubset(columns):
        return
    row = conn.execute("SELECT value FROM app_settings WHERE key='subscription_revision'").fetchone()
    current = clamp_int(row_value(row, "value"), 1) if row else 1
    next_revision = max(int(time.time() * 1000), current + 1)
    if row:
        if "updated_at" in columns:
            conn.execute(
                "UPDATE app_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='subscription_revision'",
                (str(next_revision),),
            )
        else:
            conn.execute("UPDATE app_settings SET value=? WHERE key='subscription_revision'", (str(next_revision),))
    elif "updated_at" in columns:
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES ('subscription_revision', ?, CURRENT_TIMESTAMP)",
            (str(next_revision),),
        )
    else:
        conn.execute("INSERT INTO app_settings (key, value) VALUES ('subscription_revision', ?)", (str(next_revision),))


def parse_node_ids(values: Iterable[str] | str | None) -> list[int]:
    if values is None:
        return []
    raw_values = [values] if isinstance(values, str) else list(values)
    result: list[int] = []
    for value in raw_values:
        for part in str(value).split(","):
            node_id = clamp_int(part.strip(), 0)
            if node_id and node_id not in result:
                result.append(node_id)
    return result


def import_clients(
    db_path: Path,
    clients: list[dict[str, Any]],
    *,
    mode: str,
    node_mode: str,
    target_node_ids: list[int],
    dry_run: bool,
) -> dict[str, Any]:
    conn = open_writable_database(db_path)
    try:
        require_database(conn, importing=True)
        client_columns = table_columns(conn, "clients")
        client_node_columns = table_columns(conn, "client_nodes")
        nodes = list_local_nodes(conn)
        nodes_by_id = {clamp_int(row_value(node, "id"), 0): node for node in nodes}
        if node_mode == "selected":
            if not target_node_ids:
                raise TransferError("Для режима selected укажи хотя бы один target node ID")
            missing_node_ids = [node_id for node_id in target_node_ids if node_id not in nodes_by_id]
            if missing_node_ids:
                raise TransferError("В новой панели не найдены выбранные узлы: " + ", ".join(map(str, missing_node_ids)))

        result: dict[str, Any] = {
            "ok": True,
            "dryRun": dry_run,
            "mode": mode,
            "nodeMode": node_mode,
            "inputClients": len(clients),
            "created": 0,
            "updated": 0,
            "skipped": 0,
            "assignmentsCreated": 0,
            "assignmentsUpdated": 0,
            "assignmentsSkipped": 0,
            "unmatchedAssignments": 0,
            "conflicts": [],
            "conflictCount": 0,
            "unmatched": [],
            "backupPath": "",
        }
        if not dry_run:
            result["backupPath"] = str(backup_database(conn, db_path))

        conn.execute("BEGIN IMMEDIATE")
        try:
            for client in clients:
                existing_rows = find_existing_clients(conn, client)
                if len(existing_rows) > 1:
                    append_detail(result, "conflicts", {
                        "login": client["login"],
                        "reason": "login/UUID/subSlug совпали с разными клиентами новой панели",
                        "targetIds": [int(row["id"]) for row in existing_rows],
                    })
                    continue

                target_id: int
                if existing_rows:
                    existing = existing_rows[0]
                    target_id = int(existing["id"])
                    same_identity = (
                        clean_text(row_value(existing, "uuid"), "").casefold() == client["uuid"].casefold()
                        and clean_text(row_value(existing, "sub_slug"), "") == client["subSlug"]
                    )
                    if mode == "skip":
                        result["skipped"] += 1
                        continue
                    if mode == "update" and not same_identity:
                        append_detail(result, "conflicts", {
                            "login": client["login"],
                            "reason": "существующий клиент имеет другой UUID или subSlug; используй replace только после проверки",
                            "targetId": target_id,
                            "targetLogin": row_value(existing, "login"),
                        })
                        continue
                    update_client(conn, target_id, client, client_columns)
                    result["updated"] += 1
                else:
                    target_id = create_client(conn, client, client_columns)
                    result["created"] += 1

                apply_client_metadata(conn, target_id, client)

                if node_mode == "match":
                    matched_target_ids: set[int] = set()
                    for assignment in client["nodeAssignments"]:
                        matched_node, match_reason = match_node(assignment["nodeRef"], nodes)
                        if matched_node is None:
                            result["unmatchedAssignments"] += 1
                            append_detail(result, "unmatched", {
                                "login": client["login"],
                                "node": assignment["nodeRef"].get("name") or assignment["nodeRef"].get("panelUrl") or "неизвестный узел",
                                "reason": match_reason,
                            })
                            continue
                        node_id = int(matched_node["id"])
                        if node_id in matched_target_ids:
                            result["assignmentsSkipped"] += 1
                            continue
                        matched_target_ids.add(node_id)
                        outcome = upsert_matched_assignment(conn, target_id, node_id, assignment, client_node_columns)
                        result[f"assignments{outcome.title()}"] += 1
                elif node_mode == "selected":
                    for node_id in target_node_ids:
                        outcome = create_selected_assignment(conn, target_id, node_id, client, client_node_columns)
                        result[f"assignments{outcome.title()}"] += 1

            if dry_run:
                conn.rollback()
            else:
                if result["created"] > 0 or result["updated"] > 0:
                    bump_subscription_revision(conn)
                conn.commit()
        except Exception:
            conn.rollback()
            raise

        result["processed"] = result["created"] + result["updated"] + result["skipped"] + result["conflictCount"]
        result["message"] = (
            "Проверка завершена без записи" if dry_run else "Импорт клиентов завершён"
        )
        return result
    except sqlite3.IntegrityError as exc:
        raise TransferError(f"Конфликт ограничений SQLite: {exc}") from exc
    finally:
        conn.close()


def print_json(value: dict[str, Any], stream: Any = sys.stdout) -> None:
    stream.write(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Экспорт и безопасный импорт клиентов Nexus Panel напрямую из SQLite",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="Экспортировать клиентов из app.db")
    export_parser.add_argument("--db", required=True, help="Путь к app.db")
    export_parser.add_argument("--output", "-o", required=True, help="JSON-файл или - для stdout")

    inspect_parser = subparsers.add_parser("inspect", help="Проверить структуру файла без базы и без записи")
    inspect_parser.add_argument("--input", "-i", required=True, help="JSON-файл переноса")

    import_parser = subparsers.add_parser("import", help="Импортировать клиентов в app.db")
    import_parser.add_argument("--db", required=True, help="Путь к app.db новой панели")
    import_parser.add_argument("--input", "-i", required=True, help="JSON-файл переноса")
    import_parser.add_argument("--mode", choices=("skip", "update", "replace"), default="update", help="Обработка существующих клиентов")
    import_parser.add_argument("--node-mode", choices=("none", "match", "selected"), default="none", help="Восстановление локальных связей с узлами")
    import_parser.add_argument("--target-node-ids", action="append", default=[], help="ID узлов новой панели для node-mode=selected; можно 1,2")
    import_parser.add_argument("--dry-run", action="store_true", help="Полная проверка в транзакции с обязательным rollback")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        if args.command == "export":
            document = export_clients(Path(args.db).expanduser())
            write_document(document, args.output)
            if args.output != "-":
                print_json({
                    "ok": True,
                    "message": "Экспорт клиентов завершён",
                    "output": str(Path(args.output).expanduser().resolve()),
                    "clients": len(document["clients"]),
                    "assignments": sum(len(client["nodeAssignments"]) for client in document["clients"]),
                    "sensitive": True,
                })
            return 0

        document = load_document(args.input)
        clients, inspection = validate_document(document)
        if args.command == "inspect":
            print_json(inspection)
            return 0

        result = import_clients(
            Path(args.db).expanduser(),
            clients,
            mode=args.mode,
            node_mode=args.node_mode,
            target_node_ids=parse_node_ids(args.target_node_ids),
            dry_run=bool(args.dry_run),
        )
        result["inspection"] = inspection
        print_json(result)
        return 0
    except (TransferError, OSError, sqlite3.Error) as exc:
        print_json({"ok": False, "error": str(exc)}, stream=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
