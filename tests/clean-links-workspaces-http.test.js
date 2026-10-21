'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname,'..');

test('clean public links isolate real workspace workers; empty node screen has compact actions', {timeout:90000}, async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-clean-workspaces-'));
  const child=fork(path.join(root,'app.js'),[],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,
    DOTENV_CONFIG_PATH:path.join(dir,'missing.env'),NODE_ENV:'development',DATA_DIR:dir,NEXUS_CONTROL_DIR:dir,NEXUS_WORKSPACE_ID:'main',
    PORT:'0',ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'test-owner-password',APP_SECRET:'a'.repeat(64),SESSION_SECRET:'s'.repeat(64),
    PANEL_ACCESS_KEY:'',SESSION_SECURE:'0',TRUST_PROXY:'0',NEXUS_NODE_ENABLED:'0',BASE_URL:'http://localhost:3000',PANEL_PUBLIC_URL:'http://localhost:3000',SUB_PUBLIC_URL:'http://localhost:3000'}});
  let log='';child.stderr.on('data',b=>log+=b);child.stdout.on('data',()=>{});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,5000).unref();});}fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log||'startup timeout')),20000);child.on('message',msg=>{if(msg?.type==='ready'){clearTimeout(timer);resolve(msg.port);}});child.once('exit',()=>{clearTimeout(timer);reject(Error(log));});});
  const base=`http://127.0.0.1:${port}`,cookies=new Map();let csrf='',workspace='main';
  async function request(route,body){
    const headers={};if(cookies.size)headers.Cookie=[...cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    let encoded;
    if(body){encoded=new URLSearchParams({...body,_csrf:csrf,_workspace:workspace});headers['Content-Type']='application/x-www-form-urlencoded';}
    const r=await fetch(base+route,{method:body?'POST':'GET',headers,body:encoded,redirect:'manual'});
    for(const value of r.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}
    const text=await r.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;workspace=text.match(/name="nexus-workspace" content="([^"]+)"/)?.[1]||workspace;
    return {status:r.status,text,location:r.headers.get('location')};
  }
  await request('/login');assert.equal((await request('/login',{username:'owner',password:'test-owner-password'})).status,302);
  const empty=await request('/nodes?tab=list');assert.equal(empty.status,200);assert.ok(empty.text.includes('nodes-empty-card'));assert.ok(empty.text.includes('nodes-empty-state'));
  assert.ok(empty.text.indexOf('data-create-auto-select')>empty.text.indexOf('nodes-modern-head'),'action belongs to the card header');
  if(process.env.NEXUS_PLAYWRIGHT_MODULE){
    const {chromium}=require(process.env.NEXUS_PLAYWRIGHT_MODULE);
    const browser=await chromium.launch({headless:true,channel:'msedge'});
    try{
      const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
      await page.goto(base+'/login');await page.locator('[name=username]').fill('owner');await page.locator('[name=password]').fill('test-owner-password');
      await Promise.all([page.waitForURL('**/dashboard'),page.locator('button[type=submit]').click()]);
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:920});await page.goto(base+'/nodes?tab=list');
        const card=page.locator('.nodes-empty-card');await card.waitFor({state:'visible'});
        const box=await card.boundingBox();assert.ok(box.height<520,JSON.stringify(box));
        assert.equal(await page.locator('.nodes-modern-head [data-create-auto-select]').isVisible(),true);
        assert.equal(await page.locator('.nodes-empty-state a').evaluate(e=>getComputedStyle(e).color),'rgb(255, 255, 255)');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        if(process.env.NEXUS_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.NEXUS_UI_SCREENSHOT_DIR,`nodes-empty-${width}-2.7.17.png`),fullPage:true});
        await page.locator('.nodes-empty-state a').click();await page.locator('#node-create-form').waitFor({state:'visible'});
      }
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  }
  await request('/access');const created=await request('/access/workspaces',{name:'Clean link team'});
  assert.equal(created.status,302);assert.ok(!created.location.includes('error='),created.location+'\n'+log);
  const control=new Database(path.join(dir,'control.db'));const w=control.prepare("SELECT id FROM workspaces WHERE id!='main' AND status='ready'").get();control.close();assert.ok(w);
  const slug='same-clean-token-123456';
  for(const [directory,label] of [[dir,'ROOT-CONFIG'],[path.join(dir,'workspaces',w.id),'TEAM-CONFIG']]){
    const db=new Database(path.join(directory,'app.db'));
    db.prepare('INSERT INTO clients(login,display_name,uuid,sub_slug,expiry_time,enabled) VALUES(?,?,?,?,0,1)').run(label,label,'11111111-2222-4333-8444-555555555555',slug);
    db.prepare("UPDATE app_settings SET value=? WHERE key='subscription_name'").run(label);db.close();
  }
  const switched=await request('/access/switch',{workspace_id:w.id});assert.equal(switched.status,302);
  const teamDb=new Database(path.join(dir,'workspaces',w.id,'app.db'));
  teamDb.prepare("UPDATE app_settings SET value='0' WHERE key='subscription_clean_urls'").run();teamDb.close();
  const rootPortal=await request(`/open/${slug}`);assert.ok(!rootPortal.text.includes(`/json/${slug}`));
  const teamPortal=await fetch(`${base}/s/${w.id}/open/${slug}`);assert.ok((await teamPortal.text()).includes(`/s/${w.id}/json/${slug}`),'URL preference is workspace-local, not taken from selected cookie');
  for(const [url,wanted,other] of [[`/${slug}`,'ROOT-CONFIG','TEAM-CONFIG'],[`/s/${w.id}/${slug}`,'TEAM-CONFIG','ROOT-CONFIG']]){
    const anonymous=await fetch(base+url,{redirect:'manual'});assert.equal(anonymous.status,200);const text=await anonymous.text();assert.ok(text.includes(wanted),text);assert.ok(!text.includes(other));
    const logged=await request(url);assert.equal(logged.status,200);assert.ok(logged.text.includes(wanted),'selected workspace cookie must not alter public URL namespace');
    const sub=await fetch(base+url+'?format=sub',{redirect:'manual'});assert.equal(sub.status,200);assert.match(sub.headers.get('content-type'),/text\/plain/);
  }
  for(const suffix of ['/clients','/auto-select-profiles','/node-traffic','/backup/download'])assert.equal((await fetch(`${base}/s/${w.id}${suffix}`,{redirect:'manual'})).status,404);
  const db=new Database(path.join(dir,'workspaces',w.id,'app.db'));db.prepare('UPDATE clients SET enabled=0').run();db.close();
  assert.equal((await fetch(`${base}/s/${w.id}/${slug}`,{redirect:'manual'})).status,404);
  assert.equal((await fetch(`${base}/${slug}`,{redirect:'manual'})).status,200);
});
