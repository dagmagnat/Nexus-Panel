'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Docker base image is configurable in source and every generated compose file', () => {
  const dockerfile = read('Dockerfile');
  const compose = read('docker-compose.yml');
  const installer = read('install.sh');

  assert.match(dockerfile, /^ARG NODE_IMAGE=node:22-bookworm-slim\r?\nFROM \$\{NODE_IMAGE\}/);
  assert.match(compose, /NODE_IMAGE: \$\{NODE_IMAGE:-node:22-bookworm-slim\}/);
  assert.equal((installer.match(/NODE_IMAGE: \$\{NODE_IMAGE:-node:22-bookworm-slim\}/g) || []).length, 5);
});

test('installer retries Docker Hub 429 through a safely merged registry mirror', () => {
  const installer = read('install.sh');

  assert.match(installer, /DOCKER_REGISTRY_MIRROR=\$\{DOCKER_REGISTRY_MIRROR:-https:\/\/mirror\.gcr\.io\}/);
  assert.match(installer, /configure_docker_registry_mirror\(\)/);
  assert.match(installer, /registry-1\\\.docker\\\.io\.\*\(429\|too many requests\)/);
  assert.match(installer, /json\.load\(handle\)/);
  assert.match(installer, /data\['registry-mirrors'\] = mirrors/);
  assert.match(installer, /os\.replace\(temporary, path\)/);
  assert.match(installer, /\$\{daemon_file\}\.nexus-backup-/);
  assert.ok((installer.match(/docker_compose_build_once 2>&1 \| tee/g) || []).length >= 2);
});

test('installer preserves tracked local changes before forcing an update checkout', () => {
  const installer = read('install.sh');

  assert.match(installer, /backup_tracked_source_changes\(\)/);
  assert.match(installer, /git -C "\$APP_DIR" diff --binary > "\$backup_dir\/worktree\.patch"/);
  assert.match(installer, /git -C "\$APP_DIR" diff --cached --binary > "\$backup_dir\/index\.patch"/);
  assert.match(installer, /backup_tracked_source_changes\s+stop_existing_aggregator_stack/);
  assert.match(installer, /git -C "\$APP_DIR" checkout -f -B "\$branch" "\$target_commit"/);
});
