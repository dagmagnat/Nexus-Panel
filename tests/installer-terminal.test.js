'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const bash = process.env.NEXUS_TEST_BASH || 'bash';
const available = !spawnSync(bash, ['--version']).error;
const options = { skip: !available && 'Bash is required for terminal rendering tests' };
const stripAnsi = text => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

test('installation and restoration print saved Nexus credentials via terminal only', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const result = installer.split('print_result() {')[1].split('\n}')[0];
  assert.match(result, /load_existing_config\s+print_nexus_credentials/);
  const restore = installer.split('restore_from_backup() {')[1].split('\n}')[0];
  assert.match(restore, /load_existing_config\s+print_result/);
  const credentials = installer.split('print_nexus_credentials() {')[1].split('\n}')[0];
  assert.match(credentials, /exec 8>\/dev\/tty/);
  assert.match(credentials, /ADMIN_PASS[^\n]+>&8/);
  assert.match(credentials, /могут устареть/);
});

function render(script, env = {}) {
  const tempRoot = path.join(root, 'tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const temp = fs.mkdtempSync(path.join(tempRoot, 'installer-terminal-'));
  try {
    const result = spawnSync(bash, ['-c', 'NEXUS_INSTALLER_LIBRARY_ONLY=1 source "$1"\n' + script,
      'terminal-test', path.join(root, 'install.sh').replace(/\\/g, '/')], {
      encoding: 'utf8', timeout: 10000, cwd: root,
      env: { ...process.env, TERM: 'xterm-256color', LC_ALL: 'C.UTF-8', COLUMNS: '80',
        NEXUS_INSTALLER_FORCE_RUN: '0', NEXUS_INSTALLER_PLAIN: '0', NO_COLOR: '',
        NEXUS_INSTALLER_LOG_DIR: path.relative(root, temp).replace(/\\/g, '/'), ...env }
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
    assert.doesNotMatch(result.stdout + result.stderr, /\\(?:033|x1b|e)\[/,
      'escape codes must never appear as literal text');
    return result;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test('colored banner renders actual ANSI and aligned borders', options, () => {
  const { stdout } = render('ui_banner');
  assert.match(stdout, /\x1b\[1;35m/);
  const lines = stripAnsi(stdout).split('\n').filter(line => /[╭│╰]/.test(line));
  assert.equal(lines.length, 4);
  assert.deepEqual(lines.map(line => [...line].length), [48, 48, 48, 48]);
});

test('Russian menu rows align without counting UTF-8 bytes as columns', options, () => {
  const { stdout } = render(`ui_box_rule '╭' '─' '╮' 60
ui_box_line 58 'Управление Nexus Panel' "\${BOLD}Управление Nexus Panel\${NC}"
ui_box_line 58 '8  Диагностика и автоматическое восстановление'
ui_box_rule '╰' '─' '╯' 60`);
  assert.deepEqual(stripAnsi(stdout).trimEnd().split('\n').map(line => [...line].length), [64, 64, 64, 64]);
});

for (const [name, env] of Object.entries({
  plain: { NEXUS_INSTALLER_PLAIN: '1' },
  dumb: { TERM: 'dumb' },
  noColor: { NO_COLOR: '1' }
})) {
  test(`${name} output contains no color escapes`, options, () => {
    const { stdout } = render('ui_banner; ui_section "Подготовка сервера"; ui_step_success 1 "Обновление списка пакетов" 39', env);
    assert.doesNotMatch(stdout, /\x1b/);
    assert.match(stdout, /Обновление списка пакетов · 39s/);
  });
}

test('narrow terminal omits broken frames and bounds animated progress', options, () => {
  const { stdout } = render(`ui_banner
ui_step_progress '⠋' 2 'Установка системных компонентов и дополнительных служб' 240`, { COLUMNS: '40' });
  const plain = stripAnsi(stdout);
  assert.doesNotMatch(plain, /[╭╮│╰╯]/);
  const progress = plain.split('\r').at(-1);
  assert.ok([...progress].length < 40, progress);
  assert.match(progress, /… · 240s$/);
});

test('progress does not interpret backslashes or percent signs in labels', options, () => {
  const { stdout } = render("ui_step_progress '.' 1 '50% \\n test' 2");
  assert.match(stripAnsi(stdout), /50% \\n test/);
});

test('successful and failed steps retain diagnostics and exact exit status', options, () => {
  const { stdout, stderr } = render(`ui_run 'Тест успеха' bash -c 'printf "operation-ok\\n"'
if ui_run 'Тест ошибки' bash -c 'printf "operation-failed\\n" >&2; exit 17'; then
  exit 99
else
  result=$?
fi
[ "$result" -eq 17 ]
grep -q operation-ok "$NEXUS_UI_LOG_FILE"
grep -q operation-failed "$NEXUS_UI_LOG_FILE"`, { NEXUS_INSTALLER_PLAIN: '1' });
  assert.match(stdout, /✓ 01  Тест успеха/);
  assert.match(stderr, /Тест ошибки.*код 17/);
  assert.match(stderr, /operation-failed/);
  assert.doesNotMatch(stdout + stderr, /\x1b/);
});
