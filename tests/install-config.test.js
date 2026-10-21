'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');
const root = path.resolve(__dirname, '..');
const python = process.env.NEXUS_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const bash = process.env.NEXUS_TEST_BASH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
const script = path.join(root, 'scripts/upgrade-install-config.py');
const installer = path.join(root, 'install.sh').replace(/\\/g,'/');

function shell(source) {
  return spawnSync(bash, ['-c', `NEXUS_INSTALLER_LIBRARY_ONLY=1 source '${installer}'; ${source}`], { encoding: 'utf8' });
}
function migrate(name, value) {
  const result = spawnSync(python, ['-c', `import importlib.util,json,sys; s=importlib.util.spec_from_file_location('upgrade',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(getattr(m,sys.argv[2])(json.load(sys.stdin))))`,script,name], { input: JSON.stringify(value), encoding:'utf8' });
  assert.equal(result.status,0,result.stderr); return JSON.parse(result.stdout);
}

test('installer rejects default/empty/new short passwords, preserves literal special characters without printing them', () => {
  for (const candidate of ['', 'admin', 'short']) {
    const r = shell(`validate_new_admin_password '${candidate}' >/dev/null`);
    assert.notEqual(r.status,0);
  }
  const password = 'Long$Password#with\\slash!123';
  const r = shell(`value='${password}'; validate_new_admin_password "$value"; quoted="$(quote_env_literal "$value")"; printf 'ADMIN_PASSWORD=%s\\n' "$quoted"`);
  assert.equal(r.status,0,r.stderr);
  assert.equal(dotenv.parse(r.stdout).ADMIN_PASSWORD,password);
  assert.ok(!r.stderr.includes(password));
  const read = shell(`read_env_literal "'${password.replace(/\$/g,'\\$')}'"`);
  assert.equal(read.status,0,read.stderr); assert.equal(read.stdout,password);
  const bad = shell("ADMIN_PASS=admin; APP_DIR=/not-a-real-app; get_public_server_ip(){ echo 127.0.0.1; }; stop_existing_aggregator_stack(){ echo SHOULD-NOT-STOP; }; prepare_config_and_run");
  assert.notEqual(bad.status,0); assert.ok(!bad.stdout.includes('SHOULD-NOT-STOP'));
});

test('all compose templates use default build networking without runtime host-network changes', () => {
  const source = fs.readFileSync(path.join(root,'install.sh'),'utf8');
  assert.equal((source.match(/network: \$\{NEXUS_BUILD_NETWORK:-default\}/g)||[]).length,5);
  assert.ok(!/^\s*network: host\s*$/m.test(source));
  assert.match(fs.readFileSync(path.join(root,'docker-compose.yml'),'utf8'),/network: \$\{NEXUS_BUILD_NETWORK:-default\}/);
  const old = 'services:\n  aggregator:\n    build:\n      context: .\n      network: host\n      args:\n        KEEP: yes\n    network_mode: host\n    ports:\n      - "127.0.0.1:3000:3000"\n  another:\n    build:\n      network: host\n';
  const result = migrate('migrate_compose',old);
  assert.ok(result.includes('      network: default\n')); assert.ok(result.includes('    network_mode: host\n'));
  assert.ok(result.includes('  another:\n    build:\n      network: host\n'));
  assert.ok(result.includes('127.0.0.1:3000:3000')); assert.equal(migrate('migrate_compose',result),result);
});

test('Caddy migration adds only strict clean-subscription matchers and is idempotent', () => {
  const old = 'http://sub.example.test {\n    @public_sub path /s/* /sub/* /sub-plain/* /json/* /open/*\n    redir @public_sub https://sub.example.test{uri} permanent\n    redir https://sub.example.test:2096{uri} permanent\n}\nhttps://sub.example.test {\n    @public_sub path /s/* /sub/* /sub-plain/* /json/* /open/*\n    reverse_proxy @public_sub aggregator:3000\n    respond 404\n}\n';
  const result = migrate('migrate_caddy',old);
  assert.equal((result.match(/NEXUS-CLEAN-LINKS BEGIN/g)||[]).length,2);
  assert.match(result,/redir @nexus_clean https:\/\/sub\.example\.test\{uri\} permanent/);
  assert.match(result,/reverse_proxy @nexus_clean aggregator:3000/);
  assert.match(result,/not path \/auto-select-profiles \/happ-routing \/happ-routing-json \/mobile-login \/node-traffic/);
  assert.ok(result.includes('respond 404')); assert.ok(result.includes(':2096{uri}'));
  assert.equal(migrate('migrate_caddy',result),result);
  const generated = shell("write_clean_subscription_matcher reverse_proxy 'aggregator:3000'");
  assert.equal(generated.status,0,generated.stderr);
  assert.ok(result.includes(generated.stdout.trimEnd()));
});

test('runtime migration preflights secrets, backs up changed files and leaves data/env unchanged', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'nexus-install-config-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'app.js'),'// fixture');
  const compose = 'services:\n  aggregator:\n    build:\n      context: .\n      network: host\n';
  fs.writeFileSync(path.join(dir,'docker-compose.yml'),compose);
  fs.writeFileSync(path.join(dir,'.env'),'ADMIN_PASSWORD=admin\nAPP_SECRET=KEEP-THIS\n');
  const run = args => spawnSync(python,[script,dir,...args],{encoding:'utf8'});
  const refused=run(['--check']);assert.notEqual(refused.status,0);assert.ok(!refused.stderr.includes('KEEP-THIS'));
  assert.equal(fs.readFileSync(path.join(dir,'docker-compose.yml'),'utf8'),compose);
  const env="ADMIN_PASSWORD='Long$Password#12345'\nAPP_SECRET=KEEP-THIS\n";
  fs.writeFileSync(path.join(dir,'.env'),env);
  const dry=run(['--check']);assert.equal(dry.status,0,dry.stderr);
  assert.equal(fs.readFileSync(path.join(dir,'docker-compose.yml'),'utf8'),compose);
  const applied=run([]);assert.equal(applied.status,0,applied.stderr);
  assert.equal(fs.readFileSync(path.join(dir,'.env'),'utf8'),env);
  assert.ok(fs.readFileSync(path.join(dir,'docker-compose.yml'),'utf8').includes('network: default'));
  assert.equal(fs.readdirSync(dir).filter(f=>f.includes('.before-nexus-')).length,1);
  assert.equal(run([]).status,0);assert.equal(fs.readdirSync(dir).filter(f=>f.includes('.before-nexus-')).length,1);
});

test('patch helper runs the complete migration with a mocked Docker CLI and preserves deployment bindings', { skip: process.platform === 'win32' && 'requires native POSIX mkdir/install; migration unit tests run on Windows' }, t => {
  const fixture = fs.mkdtempSync(path.join(root,'.tmp-patch-helper-'));
  t.after(()=>fs.rmSync(fixture,{recursive:true,force:true}));
  const posix = value => value.replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,drive)=>'/'+drive.toLowerCase());
  const app = path.join(fixture,'app'), bin=path.join(fixture,'bin'), log=path.join(fixture,'docker.log');
  fs.mkdirSync(app);fs.mkdirSync(bin);
  fs.writeFileSync(path.join(app,'app.js'),'// fixture');fs.writeFileSync(path.join(app,'lib_access.js'),'// createAccess');
  fs.writeFileSync(path.join(app,'package.json'),JSON.stringify({name:'nexus-panel',version:'2.7.16'}));
  const env="ADMIN_PASSWORD='Good$Password#12345'\nAPP_SECRET=do-not-change\n";fs.writeFileSync(path.join(app,'.env'),env);
  fs.writeFileSync(path.join(app,'docker-compose.yml'),'name: original-instance\nservices:\n  aggregator:\n    build:\n      context: .\n      network: host\n    ports:\n      - "127.0.0.1:3000:3000"\n  caddy:\n    image: caddy:2\n');
  fs.writeFileSync(path.join(app,'Caddyfile'),'https://sub.example.test {\n    @public_sub path /s/* /sub/* /sub-plain/* /json/*\n    reverse_proxy @public_sub aggregator:3000\n    respond 404\n}\n');
  const executable=spawnSync(python,['-c','import sys;print(sys.executable)'],{encoding:'utf8'});assert.equal(executable.status,0);
  fs.writeFileSync(path.join(bin,'python3'),`#!/usr/bin/env bash\nexec '${executable.stdout.trim().replace(/\\/g,'/')}' "$@"\n`,{mode:0o755});
  fs.writeFileSync(path.join(bin,'docker'),'#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$NEXUS_DOCKER_LOG"\nif [[ "$*" == *"config --services"* ]]; then printf "aggregator\\ncaddy\\n"; fi\n',{mode:0o755});
  const result=spawnSync(bash,[path.join(root,'apply-node-traffic-update.sh'),posix(app)],{encoding:'utf8',input:'YES\n',env:{...process.env,PATH:posix(bin)+':/usr/bin:/bin',NEXUS_DOCKER_LOG:posix(log)}});
  assert.equal(result.status,0,result.stdout+'\n'+result.stderr);
  const calls=fs.readFileSync(log,'utf8');
  assert.match(calls,/stop aggregator/);assert.match(calls,/caddy validate --config \/etc\/caddy\/Caddyfile/);
  assert.match(calls,/up -d --build aggregator/);assert.match(calls,/up -d --no-deps --force-recreate caddy/);
  const compose=fs.readFileSync(path.join(app,'docker-compose.yml'),'utf8');
  assert.ok(compose.includes('name: original-instance'));assert.ok(compose.includes('127.0.0.1:3000:3000'));assert.ok(compose.includes('network: default'));
  assert.equal(fs.readFileSync(path.join(app,'.env'),'utf8'),env);
  assert.ok(fs.readdirSync(fixture).some(name=>name.endsWith('.tar.gz')));
});
