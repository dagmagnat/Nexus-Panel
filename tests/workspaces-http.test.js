'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
test('live HTTP: main workspace, RBAC, profiles and preserved main subscriptions', { timeout: 90000 }, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-workspaces-http-'));
  const options = { cwd:path.join(__dirname,'..'), stdio:['ignore','pipe','pipe','ipc'], env:{...process.env,
    DOTENV_CONFIG_PATH:path.join(dir,'absent.env'), NODE_ENV:'development', DATA_DIR:dir, NEXUS_CONTROL_DIR:dir, NEXUS_WORKSPACE_ID:'main',
    PORT:'0', ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'test-owner-password', APP_SECRET:'a'.repeat(64), SESSION_SECRET:'s'.repeat(64),
    SESSION_SECURE:'0', TRUST_PROXY:'0', NEXUS_NODE_ENABLED:'0', BASE_URL:'http://localhost:3000', PANEL_PUBLIC_URL:'http://localhost:3000', SUB_PUBLIC_URL:'http://localhost:3000'
  }};
  let child = fork(path.join(__dirname, '../app.js'), [], options);
  let log = ''; child.stderr.on('data', d => log += d); child.stdout.on('data', () => {});
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit',resolve); setTimeout(resolve,3000).unref(); });
    await new Promise(resolve => setTimeout(resolve,500));
    fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  const port = await new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error(log || 'startup timeout')),25000);
    child.on('message', msg => { if(msg?.type==='ready'){clearTimeout(timer);resolve(msg.port);} });
    child.on('exit', () => {clearTimeout(timer);reject(new Error(log));});
  });
  let base = `http://127.0.0.1:${port}`;
  async function browser() {
    let cookie = '', csrf = '', workspace='main';
    async function request(url, body, method) {
      const headers = {cookie}; let encoded;
      if (body !== undefined) { encoded = new URLSearchParams(); for(const [k,v] of Object.entries(body)) for(const item of Array.isArray(v)?v:[v]) encoded.append(k,item); encoded.set('_csrf',csrf); encoded.set('_workspace',workspace); headers['content-type']='application/x-www-form-urlencoded'; }
      const r=await fetch(base+url,{method:method || (body===undefined?'GET':'POST'),headers,body:encoded?.toString(),redirect:'manual'});
      const setCookie=r.headers.get('set-cookie'); if(setCookie) cookie=setCookie.split(';')[0];
      const text=await r.text(); csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1] || csrf; workspace=text.match(/name="nexus-workspace" content="([^"]+)"/)?.[1] || workspace;
      return {status:r.status,text,location:r.headers.get('location')};
    }
    async function login(username,password) {await request('/login'); const r=await request('/login',{username,password}); assert.equal(r.status,302,r.text); await request('/access');}
    return {request,login, json:async (url,body,extra={}) => {
      const r=await fetch(base+url,{method:'POST',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf,'x-nexus-workspace':workspace,...extra},body:JSON.stringify(body),redirect:'manual'}); return {status:r.status,text:await r.text()};
    }};
  }
  const owner=await browser(); await owner.login('owner','test-owner-password');
  const accessPage = await owner.request('/access');
  assert.equal(accessPage.status,200);
  assert.match(accessPage.text, /href="\/access" class="active" aria-current="page"/);
  assert.doesNotMatch(accessPage.text, /href="\/settings" class="active"/);
  const preferencesPage = await owner.request('/preferences');
  assert.equal(preferencesPage.status,200);
  assert.match(preferencesPage.text, /href="\/preferences" class="active" aria-current="page"/);
  assert.doesNotMatch(preferencesPage.text, /href="\/settings" class="active"/);
  assert.match(preferencesPage.text, /management-layout\.css\?v=1/);
  const archivedId = 'a'.repeat(24);
  const control = new Database(path.join(dir, 'control.db'));
  control.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(archivedId, 'Old team', 'ready', '');
  control.close();
  const previousDb = new Database(path.join(dir, 'app.db'));
  previousDb.prepare('INSERT INTO clients(login,display_name,uuid,sub_slug) VALUES (?,?,?,?)')
    .run('MAIN-PRIVATE', 'MAIN-PRIVATE', '11111111-2222-4333-8444-555555555555', 'main-token');
  previousDb.close();
  const createReader = await owner.request('/access/users',{username:'reader',password:'reader-password-test',permissions:['clients.read']});
  assert.equal(createReader.status,302);
  assert.ok(!createReader.location.includes('error='),createReader.location);
  const reader=await browser(); await reader.login('reader','reader-password-test');
  const preflight = (actor, wid, route, method = 'GET') => actor.request('/access/check?' + new URLSearchParams({workspace:wid,path:route,method}));
  assert.equal(JSON.parse((await preflight(reader,'main','/clients')).text).allowed,true);
  assert.equal(JSON.parse((await preflight(reader,'main','/clients/1/extend','POST')).text).allowed,false);
  assert.equal(JSON.parse((await preflight(owner,'main','/settings')).text).allowed,true);
  assert.equal(JSON.parse((await preflight(reader,archivedId,'/clients')).text).stale,true);
  assert.equal((await preflight(await browser(),'main','/clients')).status,302);
  const directory=await reader.request('/clients');
  assert.equal(directory.status,200,directory.text.slice(0,600)+'\n'+log);
  assert.match(directory.text,/MAIN-PRIVATE/);
  for(const route of ['/nodes','/settings','/backup/download','/diagnostics','/preferences']) assert.equal((await reader.request(route)).status,403,route);
  assert.equal((await reader.request('/clients/1/delete',{})).status,403);
  assert.equal((await owner.request('/access/workspaces',{name:'Other team'})).status,404);
  assert.equal((await owner.request('/access/switch',{workspace_id:archivedId})).status,404);
  const anonymous=await browser();
  const portal=await anonymous.request('/open/main-token');
  assert.equal(portal.status,303);
  assert.equal(portal.location,'/account');
  assert.equal((await anonymous.request('/account')).status,200);
  for (const suffix of ['/clients','/open/team-token','/json/main-token']) {
    assert.equal((await anonymous.request('/s/'+archivedId+suffix)).status,404);
  }
  const summary=await reader.request('/clients/1/summary.json');
  assert.equal(summary.status,200);
  assert.match(summary.text,/\/cabinet\//);
  const profile={format:'nexus-preferences',version:1,settings:{client_default_duration_days:'17',subscription_expired_grace_days:'3'}};
  assert.equal((await owner.json('/preferences/inspect',profile)).status,200);
  const imported=await owner.json('/preferences/import',profile,{'x-confirm-import':'yes'}); assert.equal(imported.status,200);
  const backupUrl='/preferences/backups/'+JSON.parse(imported.text).backup;
  assert.equal((await owner.request(backupUrl)).status,200);
  assert.equal((await reader.request(backupUrl)).status,403);
  assert.equal((await owner.json('/preferences/import',{...profile,settings:{subscription_name:'not-allowed'}},{'x-confirm-import':'yes'})).status,400);
  assert.equal((await owner.request('/preferences/name',{subscription_name:'Other VPN'})).status,302);
  assert.equal((await owner.request('/preferences/options',{subscription_expired_grace_days:'7',show_sub_links:'0'})).status,302);
  const exported=await owner.request('/preferences/export'); assert.equal(exported.status,200); assert.doesNotMatch(exported.text,/Other VPN|TEAM-PRIVATE|MAIN-PRIVATE|subscription_name/);
  assert.equal(JSON.parse(exported.text).settings.show_sub_links,'0');
  assert.equal((await owner.request('/preferences')).status,200);
  const mainDb=new Database(path.join(dir,'app.db')); assert.equal(mainDb.prepare("SELECT value FROM app_settings WHERE key='client_default_duration_days'").get()?.value,'17'); mainDb.close();
  // Revocation works on an existing session, not only on next login.
  const c=new Database(path.join(dir,'control.db')); const user=c.prepare("SELECT id FROM users WHERE username='reader'").get(); c.close();
  await owner.request('/access');
  await owner.request('/access/users/'+user.id,{disabled:'1',permissions:['clients.read']});
  assert.equal((await reader.request('/clients')).status,302);
  // Restart the installation: credentials, memberships, databases and settings survive.
  await new Promise(resolve => { child.once('exit',resolve); child.kill('SIGTERM'); });
  await new Promise(resolve => setTimeout(resolve,500));
  child=fork(path.join(__dirname,'../app.js'),[],options);
  child.stdout.on('data',()=>{}); child.stderr.on('data',d=>log+=d);
  const newPort=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('restart timeout: '+log)),25000);
    child.on('message',m=>{if(m?.type==='ready'){clearTimeout(timer);resolve(m.port);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(log));});
  });
  base=`http://127.0.0.1:${newPort}`;
  const afterRestart=await browser(); await afterRestart.login('owner','test-owner-password');
  const preserved=await afterRestart.request('/clients'); assert.equal(preserved.status,200); assert.match(preserved.text,/MAIN-PRIVATE/);
  const savedProfile=await afterRestart.request('/preferences/export'); assert.equal(JSON.parse(savedProfile.text).settings.client_default_duration_days,'17');
});
