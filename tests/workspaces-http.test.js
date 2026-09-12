'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
test('live HTTP: independent workers, RBAC, profiles and unchanged main subscriptions', { timeout: 90000 }, async t => {
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
  assert.equal((await owner.request('/preferences')).status,200);
  let result=await owner.request('/access/workspaces',{name:'Other team'});
  assert.equal(result.status,302,result.text); assert.ok(!result.location.includes('error='),result.location+'\n'+log);
  const control=new Database(path.join(dir,'control.db'));
  const w=control.prepare("SELECT id FROM workspaces WHERE id!='main' AND status='ready'").get(); assert.ok(w,log);
  control.close();
  result=await owner.request('/access/users',{username:'reader',password:'reader-password-test',workspace_id:w.id,permissions:['clients.read']});
  assert.equal(result.status,302); assert.ok(!result.location.includes('error='),result.location);
  // Identical local IDs in two SQLite files must never select the other client.
  for(const [data,label,slug] of [[dir,'MAIN-PRIVATE','main-token'],[path.join(dir,'workspaces',w.id),'TEAM-PRIVATE','team-token']]) {
    const db=new Database(path.join(data,'app.db')); db.prepare('INSERT INTO clients(login,display_name,uuid,sub_slug) VALUES (?,?,?,?)').run(label,label,label,slug); db.close();
  }
  const reader=await browser(); await reader.login('reader','reader-password-test');
  const preflight = async (actor, wid, route, method = 'GET') => actor.request('/access/check?' + new URLSearchParams({workspace:wid,path:route,method}));
  assert.equal(JSON.parse((await preflight(reader,w.id,'/clients')).text).allowed,true);
  assert.equal(JSON.parse((await preflight(reader,w.id,'/clients/1/extend','POST')).text).allowed,false);
  assert.equal(JSON.parse((await preflight(owner,'main','/settings')).text).allowed,true);
  assert.equal(JSON.parse((await preflight(reader,'main','/clients')).text).stale,true);
  assert.equal((await anonymousPreflight()).status,302);
  async function anonymousPreflight() { const a=await browser(); return preflight(a,'main','/clients'); }
  result=await reader.request('/clients'); assert.equal(result.status,200,result.text.slice(0,600)+'\n'+log); assert.match(result.text,/TEAM-PRIVATE/); assert.doesNotMatch(result.text,/MAIN-PRIVATE/);
  for(const route of ['/nodes','/settings','/backup/download','/diagnostics','/preferences']) assert.equal((await reader.request(route)).status,403,route);
  assert.equal((await reader.request('/clients/1/delete',{})).status,403);
  assert.equal((await reader.request('/access/switch',{workspace_id:'main'})).status,403);
  // Root public routing ignores the logged-in employee's selected workspace.
  assert.equal((await reader.request('/s/'+w.id+'/clients')).status,404);
  const anonymous=await browser();
  for (const [url,label,other] of [['/open/main-token','MAIN-PRIVATE','TEAM-PRIVATE'],['/s/'+w.id+'/open/team-token','TEAM-PRIVATE','MAIN-PRIVATE']]) {
    const page=await anonymous.request(url); assert.equal(page.status,200,page.text.slice(0,400)); assert.match(page.text,new RegExp(label)); assert.doesNotMatch(page.text,new RegExp(other));
  }
  assert.equal((await anonymous.request('/json/team-token')).status,404);
  assert.equal((await anonymous.request('/s/'+w.id+'/json/main-token')).status,404);
  const publicPage=await reader.request('/open/main-token'); assert.equal(publicPage.status,200); assert.match(publicPage.text,/MAIN-PRIVATE/);
  const summary=await reader.request('/clients/1/summary.json'); assert.equal(summary.status,200); assert.ok(summary.text.includes('/s/'+w.id+'/open/team-token'));
  const main=await owner.request('/clients'); assert.match(main.text,/MAIN-PRIVATE/); assert.doesNotMatch(main.text,/TEAM-PRIVATE/);
  await Promise.all(Array.from({length:4},async()=>{
    const [a,b]=await Promise.all([owner.request('/clients'),reader.request('/clients')]);
    assert.match(a.text,/MAIN-PRIVATE/); assert.doesNotMatch(a.text,/TEAM-PRIVATE/);
    assert.match(b.text,/TEAM-PRIVATE/); assert.doesNotMatch(b.text,/MAIN-PRIVATE/);
  }));
  result=await owner.request('/access/switch',{workspace_id:w.id}); assert.equal(result.status,302);
  // Deliberately submit a stale Main form before fetching a page in the new workspace.
  assert.equal((await owner.request('/clients/1/delete',{})).status,409);
  result=await owner.request('/clients'); assert.equal(result.status,200); assert.match(result.text,/TEAM-PRIVATE/);
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
  const mainDb=new Database(path.join(dir,'app.db')); assert.notEqual(mainDb.prepare("SELECT value FROM app_settings WHERE key='client_default_duration_days'").get()?.value,'17'); mainDb.close();
  const teamDb=new Database(path.join(dir,'workspaces',w.id,'app.db')); assert.equal(teamDb.prepare("SELECT value FROM app_settings WHERE key='client_default_duration_days'").get().value,'17'); teamDb.close();
  // Revocation works on an existing session, not only on next login.
  const c=new Database(path.join(dir,'control.db')); const user=c.prepare("SELECT id FROM users WHERE username='reader'").get(); c.close();
  await owner.request('/access');
  await owner.request('/access/users/'+user.id,{workspace_id:w.id,disabled:'1',permissions:['clients.read']});
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
  assert.equal((await afterRestart.request('/access/switch',{workspace_id:w.id})).status,302);
  const preserved=await afterRestart.request('/clients'); assert.equal(preserved.status,200); assert.match(preserved.text,/TEAM-PRIVATE/); assert.doesNotMatch(preserved.text,/MAIN-PRIVATE/);
  const savedProfile=await afterRestart.request('/preferences/export'); assert.equal(JSON.parse(savedProfile.text).settings.client_default_duration_days,'17');
});
