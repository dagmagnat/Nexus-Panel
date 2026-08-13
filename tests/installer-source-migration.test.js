'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const installerPath = path.join(projectRoot, 'install.sh');
const testTempRoot = path.join(projectRoot, 'tmp');

function createTempDirectory(prefix) {
  fs.mkdirSync(testTempRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testTempRoot, prefix));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function initRepository(directory, filename, contents) {
  fs.mkdirSync(directory, { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  fs.writeFileSync(path.join(directory, filename), contents);
  run('git', ['add', filename], { cwd: directory });
  run('git', ['-c', 'user.name=Nexus Test', '-c', 'user.email=nexus@example.invalid', 'commit', '-q', '-m', filename], { cwd: directory });
}

function installerLibraryPrefix() {
  return `NEXUS_INSTALLER_LIBRARY_ONLY=1 source ${JSON.stringify(installerPath)}`;
}

test('installer maps the former official source to Nexus Panel', () => {
  const tempDir = createTempDirectory('nexus-installer-source-');
  try {
    const appDir = path.join(tempDir, 'app');
    fs.mkdirSync(appDir);
    fs.writeFileSync(path.join(appDir, '.source.conf'), [
      'REPO_URL=https://github.com/dagmagnat/3xui-Aggregator.git',
      'BRANCH=main',
      'INSTALLER_RAW_URL=https://raw.githubusercontent.com/dagmagnat/3xui-Aggregator/main/install.sh'
    ].join('\n'));

    const script = `
      ${installerLibraryPrefix()}
      APP_DIR=${JSON.stringify(appDir)}
      SOURCE_CONF=${JSON.stringify(path.join(tempDir, 'missing-source.conf'))}
      load_source_config
      printf '%s\n%s\n' "$REPO_URL" "$INSTALLER_RAW_URL"
    `;
    const output = run('bash', ['-c', script]).split('\n');
    assert.deepEqual(output, [
      'https://github.com/dagmagnat/Nexus-Panel.git',
      'https://raw.githubusercontent.com/dagmagnat/Nexus-Panel/main/install.sh'
    ]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('installer fetches the new origin before stopping and keeps runtime data', () => {
  const tempDir = createTempDirectory('nexus-installer-git-');
  try {
    const oldRepo = path.join(tempDir, 'old-repository');
    const newRepo = path.join(tempDir, 'new-repository');
    const appDir = path.join(tempDir, 'application');
    const stopMarker = path.join(tempDir, 'stopped');
    initRepository(oldRepo, 'old.txt', 'legacy');
    initRepository(newRepo, 'new.txt', 'nexus');
    run('git', ['clone', '-q', '-b', 'main', oldRepo, appDir]);

    fs.mkdirSync(path.join(appDir, 'data'));
    fs.writeFileSync(path.join(appDir, 'data', 'app.db'), 'client database');
    fs.writeFileSync(path.join(appDir, '.env'), 'APP_SECRET=preserved');
    fs.writeFileSync(path.join(appDir, '.install.conf'), 'PANEL_MODE=ip');

    const script = `
      ${installerLibraryPrefix()}
      APP_DIR=${JSON.stringify(appDir)}
      SOURCE_CONF=${JSON.stringify(path.join(tempDir, 'source.conf'))}
      INSTANCE_NAME=default
      stop_existing_aggregator_stack() { printf stopped > ${JSON.stringify(stopMarker)}; }
      save_source_config() { :; }
      clone_or_update_repo ${JSON.stringify(newRepo)} main
    `;
    run('bash', ['-c', script]);

    assert.equal(fs.readFileSync(path.join(appDir, 'new.txt'), 'utf8'), 'nexus');
    assert.equal(fs.readFileSync(path.join(appDir, 'data', 'app.db'), 'utf8'), 'client database');
    assert.equal(fs.readFileSync(path.join(appDir, '.env'), 'utf8'), 'APP_SECRET=preserved');
    assert.equal(fs.readFileSync(stopMarker, 'utf8'), 'stopped');
    assert.equal(run('git', ['remote', 'get-url', 'origin'], { cwd: appDir }), newRepo);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('failed source download does not stop the running installation', () => {
  const tempDir = createTempDirectory('nexus-installer-failure-');
  try {
    const oldRepo = path.join(tempDir, 'old-repository');
    const appDir = path.join(tempDir, 'application');
    const stopMarker = path.join(tempDir, 'stopped');
    const missingRepo = path.join(tempDir, 'does-not-exist');
    initRepository(oldRepo, 'old.txt', 'still running');
    run('git', ['clone', '-q', '-b', 'main', oldRepo, appDir]);

    const script = `
      ${installerLibraryPrefix()}
      APP_DIR=${JSON.stringify(appDir)}
      SOURCE_CONF=${JSON.stringify(path.join(tempDir, 'source.conf'))}
      INSTANCE_NAME=default
      stop_existing_aggregator_stack() { printf stopped > ${JSON.stringify(stopMarker)}; }
      save_source_config() { :; }
      set +e
      clone_or_update_repo ${JSON.stringify(missingRepo)} main
      status=$?
      set -e
      [ "$status" -ne 0 ]
    `;
    run('bash', ['-c', script]);

    assert.equal(fs.existsSync(stopMarker), false);
    assert.equal(fs.readFileSync(path.join(appDir, 'old.txt'), 'utf8'), 'still running');
    assert.equal(run('git', ['remote', 'get-url', 'origin'], { cwd: appDir }), oldRepo);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('installer cannot silently exit when helper-only variable is exported', () => {
  const source = fs.readFileSync(installerPath, 'utf8');
  assert.match(
    source,
    /NEXUS_INSTALLER_LIBRARY_ONLY[^\n]+BASH_SOURCE\[0\][^\n]+!=[^\n]+\$0/,
    'helper-only guard must be limited to sourcing the installer'
  );
  assert.match(source, /maybe_clear_screen/, 'SSH diagnostics stay visible by default');
});

test('README bootstrap validates the downloaded installer before execution', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  assert.match(readme, /unset NEXUS_INSTALLER_LIBRARY_ONLY/);
  assert.match(readme, /--retry 5 --retry-delay 2 --connect-timeout 20/);
  assert.match(readme, /test -s \/tmp\/nexus-panel-install\.sh/);
  assert.match(readme, /grep -q '\^#!\/usr\/bin\/env bash'/);
  assert.match(readme, /tee \/root\/nexus-panel-install\.log/);
});
