#!/usr/bin/env bash
# Delta installer for Nexus 2.7.26 -> 2.7.27; runtime data and Compose are preserved.
set -Eeuo pipefail
PATCH_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
TARGET="${1:-}"
die() { printf '%s\n' "$*" >&2; exit 1; }
[[ "$TARGET" == /* && -d "$TARGET" ]] || die "Usage: sudo bash $0 /absolute/path/to/installed-nexus"
TARGET="$(cd -- "$TARGET" && pwd -P)"
case "$TARGET" in /|/root|/opt|"$PATCH_DIR") die "Choose the installed Nexus directory, not a root or patch directory." ;; esac
[[ -f "$TARGET/.env" && -f "$TARGET/app.js" && -f "$TARGET/docker-compose.yml" ]] || die "Installed Docker Nexus not found (.env/app.js/docker-compose.yml)."
[[ -f "$TARGET/VERSION" ]] || die "VERSION not found; use this delta only on Nexus 2.7.26."
VERSION="$(tr -d '\r\n' < "$TARGET/VERSION")"
[[ "$VERSION" == 2.7.26 || "$VERSION" == 2.7.27 ]] || die "This delta requires 2.7.26. Installed: $VERSION"
[[ -f "$PATCH_DIR/DELTA_FILES.txt" ]] || die "DELTA_FILES.txt is missing."
FILES=()
while IFS= read -r rel || [[ -n "$rel" ]]; do
  rel="${rel%$'\r'}"
  [[ -z "$rel" || "$rel" == \#* ]] && continue
  [[ "$rel" != /* && "$rel" != *\\* && "$rel" != *..* ]] || die "Unsafe manifest path: $rel"
  case "$rel" in .env*|data/*|node_modules/*|docker-compose*|Caddyfile*) die "Runtime file in manifest: $rel" ;; esac
  [[ -f "$PATCH_DIR/$rel" && ! -L "$PATCH_DIR/$rel" ]] || die "Missing or symlinked patch file: $rel"
  resolved="$(realpath -m -- "$TARGET/$rel")"
  [[ "$resolved" == "$TARGET/"* && ! -L "$TARGET/$rel" ]] || die "Destination escapes installation: $rel"
  FILES+=("$rel")
done < "$PATCH_DIR/DELTA_FILES.txt"
(( ${#FILES[@]} > 0 )) || die "Empty delta."
cd -- "$TARGET"
docker compose config --services | grep -qx aggregator || die "Compose service aggregator not found."
[[ -s .dockerignore ]] || die ".dockerignore is missing; repair the 2.7.26 installation first."
printf 'Target: %s\nVersion: %s -> 2.7.27\nChanged files: %s\n' "$TARGET" "$VERSION" "${#FILES[@]}"
read -r -p "Back up the installation and apply this delta? Type YES: " reply
[[ "$reply" == YES ]] || die "Cancelled."
BACKUP_DIR="$(dirname -- "$TARGET")/.nexus-backups"
mkdir -p -- "$BACKUP_DIR"
chmod 700 -- "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/$(basename -- "$TARGET")-before-2.7.27-$(date +%Y%m%d-%H%M%S)-$$.tar.gz"
docker compose stop aggregator
if ! tar --exclude='./node_modules' --exclude='./.git' -czf "$BACKUP" -C "$TARGET" .; then
  docker compose start aggregator || true
  die "Backup failed; no source files were replaced. Check free disk space."
fi
chmod 600 -- "$BACKUP"
# The previous image serves requests while the new image is built.
docker compose start aggregator
for rel in "${FILES[@]}"; do
  mkdir -p -- "$(dirname -- "$TARGET/$rel")"
  cp -- "$PATCH_DIR/$rel" "$TARGET/$rel"
done
printf 'Backup: %s\n' "$BACKUP"
if ! docker compose build aggregator; then
  die "Build failed; the previous image is still running. Backup: $BACKUP"
fi
docker compose up -d --no-deps --no-build aggregator
docker compose ps
printf '\nNexus 2.7.27 files applied. Check container logs and panel login.\nEnable per-device AWG in Settings -> Subscriptions and applications.\nBackup: %s\n' "$BACKUP"
