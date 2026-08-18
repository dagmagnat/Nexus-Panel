#!/usr/bin/env bash
set -Eeuo pipefail

primary_registry="${NPM_REGISTRY:-https://registry.npmjs.org/}"
fallback_registry="${NPM_FALLBACK_REGISTRY:-https://registry.yarnpkg.com/}"
install_timeout="${NPM_INSTALL_TIMEOUT:-420}"
install_mode="${NPM_INSTALL_MODE:-install}"
fetch_timeout="${NPM_FETCH_TIMEOUT:-60000}"
fetch_retries="${NPM_FETCH_RETRIES:-1}"

normalize_registry() {
  local value="$1"
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"
  [ -n "$value" ] || value="https://registry.npmjs.org/"
  case "$value" in
    */) printf '%s' "$value" ;;
    *) printf '%s/' "$value" ;;
  esac
}

primary_registry="$(normalize_registry "$primary_registry")"
fallback_registry="$(normalize_registry "$fallback_registry")"

say() { printf '%s\n' "$*"; }

configure_npm() {
  local registry="$1"
  npm config set registry "$registry"
  npm config set audit false
  npm config set fund false
  npm config set update-notifier false
  npm config set progress false
  npm config set loglevel notice
  npm config set fetch-retries "$fetch_retries"
  npm config set fetch-retry-factor 2
  npm config set fetch-retry-mintimeout 5000
  npm config set fetch-retry-maxtimeout 30000
  npm config set fetch-timeout "$fetch_timeout"
  npm config set maxsockets 3
  npm config set prefer-online true
}

registry_ping() {
  local registry="$1"
  REGISTRY_URL="$registry" node <<'NODE'
const https = require('https');
const url = new URL(process.env.REGISTRY_URL || 'https://registry.npmjs.org/');
const target = `${url.origin}/-/ping`;
const req = https.get(target, { family: 4, timeout: 15000 }, (res) => {
  res.resume();
  res.on('end', () => process.exit(res.statusCode && res.statusCode < 500 ? 0 : 2));
});
req.on('timeout', () => req.destroy(new Error('registry ping timeout')));
req.on('error', (err) => { console.error(err.message); process.exit(1); });
NODE
}

run_npm_install() {
  local mode="$1"
  local label="$2"
  say "==> ${label}: npm ${mode}, timeout ${install_timeout}s"

  if [ "$mode" = "ci" ] && [ -f package-lock.json ]; then
    timeout --foreground --kill-after=30s "${install_timeout}s" \
      npm ci --omit=dev --no-audit --no-fund --prefer-online --foreground-scripts --no-progress
  else
    timeout --foreground --kill-after=30s "${install_timeout}s" \
      npm install --omit=dev --no-audit --no-fund --prefer-online --foreground-scripts --no-progress
  fi
}

try_registry() {
  local registry="$1"
  local label="$2"
  say "==> Checking npm registry: $registry"
  configure_npm "$registry"

  if ! registry_ping "$registry"; then
    say "==> Registry ping failed: $registry"
    return 1
  fi

  rm -rf node_modules /tmp/npm-cache
  mkdir -p /tmp/npm-cache
  export npm_config_cache=/tmp/npm-cache

  if [ "$install_mode" = "ci" ]; then
    run_npm_install ci "$label" || {
      say "==> npm ci failed on $registry; retrying with npm install"
      rm -rf node_modules /tmp/npm-cache
      mkdir -p /tmp/npm-cache
      run_npm_install install "$label fallback"
    }
  else
    run_npm_install install "$label"
  fi
}

say "==> Node: $(node -v), npm: $(npm -v)"
say "==> Primary registry: $primary_registry"
say "==> Fallback registry: $fallback_registry"
say "==> Install mode: $install_mode"

if try_registry "$primary_registry" "primary registry"; then
  say "==> npm dependencies installed successfully from primary registry"
elif [ "$fallback_registry" != "$primary_registry" ] && try_registry "$fallback_registry" "fallback registry"; then
  say "==> npm dependencies installed successfully from fallback registry"
else
  say "ERROR: npm dependencies installation failed on both registries."
  say "Try building with another registry, for example:"
  say "  NPM_REGISTRY=https://registry.npmjs.org/ NPM_FALLBACK_REGISTRY=https://registry.yarnpkg.com/ agg update"
  exit 1
fi

npm cache clean --force >/dev/null 2>&1 || true
rm -rf /tmp/npm-cache
