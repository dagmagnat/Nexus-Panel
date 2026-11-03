'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const ignore = fs.readFileSync(path.join(root, '.dockerignore'), 'utf8');
const rules = ignore.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
test('build excludes runtime databases, secrets, archives and host dependencies; patch carries the hidden file', () => {
  for (const pattern of ['**/data','**/control','**/workspaces','**/backup','**/backups','**/node_modules','**/.env','**/.env.*','**/*.db','**/*.db-*','**/*.sqlite','**/*.sqlite3','**/*.zip','**/*.tar.gz']) assert.ok(rules.includes(pattern), pattern);
  assert.ok(!rules.some(line => line.startsWith('!')), 'no late re-inclusion of secrets/data');
  assert.ok(!rules.includes('**'), 'runtime source tree must not be excluded wholesale');
  assert.ok(fs.readFileSync(path.join(root,'PATCH_FILES.txt'),'utf8').split(/\r?\n/).includes('.dockerignore'));
});
const docker = spawnSync('docker', ['info','--format','{{.ServerVersion}}'], { encoding:'utf8', timeout:5000, windowsHide:true });
test('Docker applies ignore rules before COPY and retains application sources', {skip: docker.status !== 0, timeout:60000}, t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-context-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  fs.writeFileSync(path.join(dir,'.dockerignore'),ignore);
  fs.writeFileSync(path.join(dir,'Dockerfile'),'FROM scratch\nCOPY . /\n');
  const excluded=['data/app.db','data/app.db-wal','data/backup/full.tar.gz','control/control.db','workspaces/team/app.db','nested/data/secret','node_modules/test/index.js','.env','.env.before-update','nested/.env','snapshot.zip','backup.tgz','custom/path/app.sqlite3','custom/path/app.sqlite3-shm'];
  const included=['app.js','lib_access.js','package.json','package-lock.json','VERSION','views/settings.ejs','public/img/logo.png','public/flags/fi.svg','scripts/client-transfer.py','node-agent/agent.js'];
  for(const name of [...excluded,...included]) {const file=path.join(dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'test fixture');}
  const dest=path.join(dir,'outputs','export');
  const built=spawnSync('docker',['build','--output','type=local,dest='+dest,dir],{encoding:'utf8',timeout:50000,windowsHide:true});
  assert.equal(built.status,0,built.stderr);
  for(const name of excluded)assert.equal(fs.existsSync(path.join(dest,name)),false,name);
  for(const name of included)assert.equal(fs.existsSync(path.join(dest,name)),true,name);
});
