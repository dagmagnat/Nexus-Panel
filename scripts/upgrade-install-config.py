#!/usr/bin/env python3
"""Narrow, idempotent migration of Nexus-generated Compose/Caddy configuration.

No secrets, databases, ports, project names or runtime networking are changed.
Back up each changed file before replacing it. --check performs validation only.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
import time


def migrate_compose(text):
    result = []
    in_aggregator = False
    build_indent = None
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        indent = len(line) - len(line.lstrip(' '))
        if indent == 2 and stripped.endswith(':'):
            in_aggregator = stripped == 'aggregator:'
            build_indent = None
        if in_aggregator and stripped == 'build:':
            build_indent = indent
        elif stripped and not stripped.startswith('#') and build_indent is not None and indent <= build_indent:
            build_indent = None
        if build_indent is not None and indent == build_indent + 2 and re.fullmatch(r'network:\s*host\s*(?:#.*)?', stripped):
            line = ' ' * indent + 'network: default\n'
        result.append(line)
    return ''.join(result)


def migrate_caddy(text):
    if '# NEXUS-CLEAN-LINKS BEGIN' in text:
        return text
    lines = text.splitlines(keepends=True)
    result = []
    for i, line in enumerate(lines):
        # Only the known installer template. Do not turn a generic reverse
        # proxy or a custom domain into an unrestricted public admin endpoint.
        if '@public_sub path /s/* /sub/* /sub-plain/* /json/*' in line and i + 1 < len(lines):
            action = re.fullmatch(r'(\s*)(redir|reverse_proxy) @public_sub (.+)\s*', lines[i + 1].rstrip('\n'))
            if not action:
                raise ValueError('Unknown @public_sub directive; update Caddyfile manually')
            indent, directive, target = action.groups()
            result.extend([
                f'{indent}# NEXUS-CLEAN-LINKS BEGIN\n',
                f'{indent}@nexus_clean {{\n',
                f'{indent}    path_regexp nexus_clean ^/[A-Za-z0-9_-]{{12,128}}/?$\n',
                f'{indent}    not path /auto-select-profiles /happ-routing /happ-routing-json /mobile-login /node-traffic\n',
                f'{indent}}}\n',
                f'{indent}{directive} @nexus_clean {target}\n',
                f'{indent}# NEXUS-CLEAN-LINKS END\n',
            ])
        result.append(line)
    return ''.join(result)


def validate_password(text):
    value = ''
    for line in text.splitlines():
        if line.startswith('ADMIN_PASSWORD='):
            value = line.split('=', 1)[1].strip()
    if value.startswith("'") and value.endswith("'"):
        value = value[1:-1]
    elif value.startswith('"') and value.endswith('"'):
        value = value[1:-1]
        if '$' in value:
            raise ValueError('ADMIN_PASSWORD contains Compose interpolation; save it as a single-quoted literal first')
    else:
        value = re.split(r'\s+#', value, maxsplit=1)[0].strip()
        if '$' in value:
            raise ValueError('ADMIN_PASSWORD contains Compose interpolation; save it as a single-quoted literal first')
    if not value or value == 'admin':
        raise ValueError('ADMIN_PASSWORD is empty or admin. Set a non-default password in .env before updating; no secrets were printed')


def replace_with_backup(file, text):
    if file.is_symlink():
        raise ValueError(f'Refusing to replace symlink: {file.name}')
    old_mode = stat.S_IMODE(file.stat().st_mode)
    backup = file.with_name(file.name + f'.before-nexus-2.7.17-{time.time_ns()}')
    shutil.copy2(file, backup)
    os.chmod(backup, 0o600)
    fd, name = tempfile.mkstemp(prefix='.nexus-config-', dir=file.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as stream:
            stream.write(text)
        os.chmod(name, old_mode)
        os.replace(name, file)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print(f'Updated {file.name}; backup: {backup.name}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    directory = Path(args.directory).resolve(strict=True)
    if not (directory / 'app.js').is_file() or not (directory / '.env').is_file():
        raise ValueError('Expected an existing Nexus application directory with .env')
    validate_password((directory / '.env').read_text(encoding='utf-8-sig'))
    changes = []
    for filename, migrate in [('docker-compose.yml', migrate_compose), ('Caddyfile', migrate_caddy)]:
        file = directory / filename
        if not file.exists():
            continue
        if file.is_symlink():
            raise ValueError(f'Refusing to change symlink: {filename}')
        old = file.read_text(encoding='utf-8-sig')
        new = migrate(old)
        if new != old:
            changes.append((file, new))
    for file, text in changes:
        if args.check:
            print(f'Will update {file.name}')
        else:
            replace_with_backup(file, text)
    if not changes:
        print('Runtime configuration already compatible; no files changed')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError) as error:
        raise SystemExit(f'Nexus configuration migration stopped: {error}')
