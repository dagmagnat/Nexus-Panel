'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const Database = require('better-sqlite3');
const root = path.resolve(__dirname,'..');

test('clean public links remain scoped to the main database; empty node screen has compact actions', {timeout:90000}, async t => {
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
  assert.ok(empty.text.indexOf('data-create-auto-select')<empty.text.indexOf('nodes-modern-head'),'action belongs to the top navigation');
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
        assert.equal(await page.locator('[data-create-auto-select]:visible').isVisible(),true);
        assert.equal(await page.locator('.nodes-empty-state a').evaluate(e=>getComputedStyle(e).color),'rgb(255, 255, 255)');
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        if(process.env.NEXUS_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.NEXUS_UI_SCREENSHOT_DIR,`nodes-empty-${width}-2.7.17.png`),fullPage:true});
        await page.locator('.nodes-empty-state a').click();await page.locator('#node-create-form').waitFor({state:'visible'});
      }
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  }
  const archivedId='a'.repeat(24);
  const control=new Database(path.join(dir,'control.db'));
  control.prepare('INSERT INTO workspaces VALUES (?,?,?,?)').run(archivedId,'Archived','ready','');
  control.close();
  const slug='same-clean-token-123456';
  const db=new Database(path.join(dir,'app.db'));
  db.prepare('INSERT INTO clients(login,display_name,uuid,sub_slug,expiry_time,enabled) VALUES(?,?,?,?,0,1)')
    .run('ROOT-CONFIG','ROOT-CONFIG','11111111-2222-4333-8444-555555555555',slug);
  db.prepare("UPDATE app_settings SET value=? WHERE key='subscription_name'").run('ROOT-CONFIG');
  db.close();
  const portal=await request(`/open/${slug}`);
  assert.equal(portal.status,303);
  assert.equal(portal.location,'/account');
  assert.equal((await request('/account')).status,200);
  const direct=await fetch(base+'/'+slug,{redirect:'manual'});
  assert.equal(direct.status,200);
  assert.ok((await direct.text()).includes('ROOT-CONFIG'));
  const sub=await fetch(base+'/'+slug+'?format=sub',{redirect:'manual'});
  assert.equal(sub.status,200);
  assert.match(sub.headers.get('content-type'),/text\/plain/);
  for(const suffix of [`/${slug}`,'/clients','/auto-select-profiles','/node-traffic','/backup/download']) {
    assert.equal((await fetch(`${base}/s/${archivedId}${suffix}`,{redirect:'manual'})).status,404);
  }
});
