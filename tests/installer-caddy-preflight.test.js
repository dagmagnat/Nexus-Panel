'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '../install.sh'), 'utf8');
const helper = fs.readFileSync(path.join(__dirname, '../scripts/local-panels.py'), 'utf8');
const bash = process.env.NEXUS_TEST_BASH || 'bash';
const options = { skip: !!spawnSync(bash, ['--version']).error };
function fn(name) { return name + '() {' + source.split(name + '() {')[1].split('\n}')[0] + '\n}\n'; }
function run(failure, publicIp = '1', parserFailure = false) {
  // Only the fixture path and external commands are mocked; run real shell flow.
  const functions = (fn('preflight_public_ip_caddy') + fn('stop_existing_aggregator_stack'))
    .replace('local state_file="/opt/nexus-local-panels/${INSTANCE_NAME}/state.json"', 'local state_file="$0"');
  return spawnSync(bash, ['-c', `
APP_DIR=.
INSTANCE_NAME=default
info() { echo "INFO:$*"; }
err() { echo "ERROR:$*"; }
python3() { cat >/dev/null; echo '${publicIp}'; return ${parserFailure ? 1 : 0}; }
docker() { echo "DOCKER:$*"; if [ "$1" = pull ]; then return ${failure ? 1 : 0}; fi; }
systemctl() { :; }
rm() { :; }
${functions}
stop_existing_aggregator_stack
`, path.join(__dirname, '../install.sh').replace(/\\/g, '/')], { encoding: 'utf8', timeout: 10000 });
}
test('generator and preflight agree on an official pinned tag', () => {
  assert.ok(helper.includes('caddy["image"] = "caddy:2.11.4"'));
  assert.ok(source.includes('docker pull caddy:2.11.4'));
  assert.ok(!helper.includes('caddy:2.11.0'));
  for (const line of source.split('\n').filter(line => /^\s+stop_existing_aggregator_stack\s/.test(line))) {
    assert.ok(line.includes('|| return 1'), line);
  }
});
test('failed image pull never reaches down or stop', options, () => {
  const result = run(true);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /DOCKER:pull caddy:2.11.4/);
  assert.doesNotMatch(result.stdout, /DOCKER:(compose down|stop|rm)/);
});
test('successful pull happens before destructive lifecycle commands', options, () => {
  const result = run(false);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.indexOf('DOCKER:pull') < result.stdout.indexOf('DOCKER:compose down'));
});
test('ordinary certificate installations do not fetch the special image', options, () => {
  const result = run(false, '0');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /DOCKER:pull/);
});
test('unreadable state aborts before touching containers', options, () => {
  const result = run(false, '1', true);
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout, /DOCKER:/);
});
