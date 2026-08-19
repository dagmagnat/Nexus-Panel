'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const installerPath = path.join(projectRoot, 'install.sh');
const testTempRoot = path.join(projectRoot, 'tmp');
const bashAvailable = !spawnSync('bash', ['--version'], { encoding: 'utf8' }).error;

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

test('installer maps the former official source to Nexus Panel', { skip: !bashAvailable && 'bash is unavailable on this host' }, () => {
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

test('installer fetches the new origin before stopping and keeps runtime data', { skip: !bashAvailable && 'bash is unavailable on this host' }, () => {
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

test('failed source download does not stop the running installation', { skip: !bashAvailable && 'bash is unavailable on this host' }, () => {
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
    /NEXUS_INSTALLER_FORCE_RUN[\s\S]{0,220}NEXUS_INSTALLER_LIBRARY_ONLY[\s\S]{0,220}BASH_SOURCE\[0\]:-\$0[\s\S]{0,120}return 0/,
    'helper-only guard must be limited to sourcing the installer'
  );
  assert.match(source, /maybe_clear_screen/, 'SSH diagnostics stay visible by default');
  assert.match(source, /"\$@" <\/dev\/null > "\$step_log" 2>&1 &/, 'background steps must never wait for invisible terminal input');
});

test('README exposes the same short bootstrap for install and agg recovery', () => {
  const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  assert.match(readme, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/dagmagnat\/Nexus-Panel\/main\/bootstrap\.sh \| bash/);
  assert.match(readme, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/dagmagnat\/Nexus-Panel\/main\/bootstrap\.sh \| bash -s -- repair-shortcut && agg/);
  assert.match(fs.readFileSync(path.join(projectRoot, '.gitattributes'), 'utf8'), /\*\.sh text eol=lf/);
});

test('bootstrap validates the download, clears legacy helper mode and restores tty input', () => {
  const bootstrap = fs.readFileSync(path.join(projectRoot, 'bootstrap.sh'), 'utf8');
  assert.match(bootstrap, /sed -i 's\/\\r\$\/\/' "\$INSTALLER_FILE"/);
  assert.match(bootstrap, /grep -q '\^#!\/usr\/bin\/env bash'/);
  assert.match(bootstrap, /env -u NEXUS_INSTALLER_LIBRARY_ONLY NEXUS_INSTALLER_FORCE_RUN=1/);
  assert.match(bootstrap, /bash "\$INSTALLER_FILE" "\$@" <\/dev\/tty/);
});

test('bootstrap really clears exported helper mode before starting installer', { skip: !bashAvailable && 'bash is unavailable on this host' }, () => {
  const tempDir = createTempDirectory('nexus-bootstrap-');
  try {
    const mockBin = path.join(tempDir, 'bin');
    fs.mkdirSync(mockBin);
    fs.writeFileSync(path.join(mockBin, 'id'), '#!/usr/bin/env bash\nprintf "0\\n"\n');
    fs.writeFileSync(path.join(mockBin, 'curl'), `#!/usr/bin/env bash
dest=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then dest="$2"; shift 2; else shift; fi
done
cat > "$dest" <<'SCRIPT'
#!/usr/bin/env bash
printf 'force=%s helper=%s arg=%s\\n' "\${NEXUS_INSTALLER_FORCE_RUN:-missing}" "\${NEXUS_INSTALLER_LIBRARY_ONLY:-unset}" "\${1:-none}"
SCRIPT
`);
    fs.chmodSync(path.join(mockBin, 'id'), 0o755);
    fs.chmodSync(path.join(mockBin, 'curl'), 0o755);
    const shellMockBin = process.platform === 'win32'
      ? mockBin.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`).replace(/\\/g, '/')
      : mockBin;
    const result = spawnSync(process.env.NEXUS_TEST_BASH || 'bash', [path.join(projectRoot, 'bootstrap.sh'), 'repair-shortcut'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${shellMockBin}:/usr/bin:/bin`,
        NEXUS_INSTALLER_LIBRARY_ONLY: '1',
        NEXUS_BOOTSTRAP_NO_TTY: '1',
        NEXUS_BOOTSTRAP_SKIP_ROOT_CHECK: '1',
        NEXUS_BOOTSTRAP_CURL: `${shellMockBin}/curl`
      }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Nexus Panel: загружаю установщик/);
    assert.match(result.stdout, /force=1 helper=unset arg=repair-shortcut/);
  } finally {
    spawnSync('bash', ['-c', 'rm -f /tmp/nexus-install.sh']);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('agg menu cannot launch an action on an empty Enter and legacy URL key is retired', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  assert.match(installer, /Enter ничего не запускает/);
  assert.match(installer, /''\) warn "Действие не выбрано\. Ничего не изменено\."/);
  assert.doesNotMatch(installer, /^PANEL_ACCESS_KEY=/m);
  assert.match(installer, /Адрес входа[^\n]+\/login/);
});

test('terminal fd setup keeps stderr visible and agg explicitly opens menu', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  assert.match(installer, /if \{ exec 9>\/dev\/tty; \} 2>\/dev\/null; then/);
  assert.doesNotMatch(installer, /if exec 9>\/dev\/tty 2>\/dev\/null; then/);
  assert.match(installer, /sync_current_installer_to_app\(\)/);
  assert.match(installer, /sync_current_installer_to_app\s+install_shortcut_command\s+local action/);
  assert.match(installer, /\[ "\\\$\{#args\[@\]\}" -gt 0 \] \|\| args=\(menu\)/);
  assert.match(installer, /LC_ALL=C grep -q \$'\\r'/);
  assert.match(installer, /NEXUS_INSTALLER_FORCE_RUN/);
  assert.match(installer, /unset NEXUS_INSTALLER_LIBRARY_ONLY/);
});

test('installer and web updater can unpack releases without hanging on a missing unzip command', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  const updater = fs.readFileSync(path.join(projectRoot, 'scripts', 'web_updater.sh'), 'utf8');
  assert.match(installer, /netcat-openbsd python3 unzip openssh-server sudo/);
  assert.match(updater, /command -v unzip/);
  assert.match(updater, /python3 -m zipfile -e/);
  assert.match(updater, /extract_archive "\$zip" "\$tmp\/unpacked"/);
});

test('installer banner and menu use one padded box renderer', () => {
  const installer = fs.readFileSync(installerPath, 'utf8');
  assert.match(installer, /ui_box_rule\(\)/);
  assert.match(installer, /ui_box_line\(\)/);
  assert.match(installer, /local menu_width=58/);
  assert.match(installer, /ui_box_line "\$menu_width" '8  Диагностика и автоматическое восстановление'/);
});

test('all public version sources identify the same release', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package-lock.json'), 'utf8'));
  const update = JSON.parse(fs.readFileSync(path.join(projectRoot, 'update.json'), 'utf8'));
  const version = fs.readFileSync(path.join(projectRoot, 'VERSION'), 'utf8').trim();
  assert.equal(packageJson.version, '2.6.0');
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
  assert.equal(update.version, packageJson.version);
  assert.equal(version, packageJson.version);
});
