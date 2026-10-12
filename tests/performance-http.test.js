'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), http = require('node:http');
const { fork } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const Database = require('better-sqlite3'), { encrypt } = require('../lib_crypto');

test('HTTP performance: large directory, lazy reports, offline independence and shared online polls', { timeout:120000 }, async t => {
  const root = path.resolve(process.env.NEXUS_PERF_SOURCE_DIR || path.join(__dirname,'..'));
  const baseline = !!process.env.NEXUS_PERF_SOURCE_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'nexus-performance-'));
  const secret = 'performance-synthetic-secret-'.repeat(3);
  const count = Number(process.env.NEXUS_PERF_CLIENTS || 1000), samples = 120;
  let remoteCalls = 0;
  const origin = http.createServer((req,res) => {
    remoteCalls++;
    setTimeout(() => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({response:{users:[],total:0}})); },100);
  });
  await new Promise(resolve => origin.listen(0,'127.0.0.1',resolve));
  const child = fork(path.join(root,'app.js'),[],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,
    DOTENV_CONFIG_PATH:path.join(dir,'missing.env'),DATA_DIR:dir,NEXUS_CONTROL_DIR:dir,NODE_ENV:'development',PORT:'0',
    ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'performance-test-password',APP_SECRET:secret,SESSION_SECRET:'s'.repeat(64),SESSION_SECURE:'0',TRUST_PROXY:'0',NEXUS_NODE_ENABLED:'0',
    PANEL_PUBLIC_URL:'http://localhost:3000',SUB_PUBLIC_URL:'http://localhost:3000'}});
  let log = '', db; child.stderr.on('data',value => log += value); child.stdout.on('data',()=>{});
  t.after(async () => {
    db?.close(); child.kill();
    await new Promise(resolve => {if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000).unref();});
    await new Promise(resolve => origin.close(resolve));
    if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep)) fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  const port = await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(log||'startup timeout')),20000);
    child.on('message',value=>{if(value.type==='ready'){clearTimeout(timer);resolve(value.port);}});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error(log));});
  });
  const base = 'http://127.0.0.1:'+port; let cookie='', csrf='';
  async function request(route, body) {
    const start = performance.now(), headers = {cookie}; let encoded;
    if(body){encoded=new URLSearchParams({...body,_csrf:csrf,_workspace:'main'});headers['content-type']='application/x-www-form-urlencoded';}
    const response=await fetch(base+route,{method:body?'POST':'GET',headers,body:encoded?.toString(),redirect:'manual'});
    const text=await response.text(); if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;
    return {status:response.status,text,headers:response.headers,ms:Math.round(performance.now()-start)};
  }
  if (!baseline) assert.equal((await request('/dashboard/traffic-summary.json')).status,302);
  await request('/login'); const login=await request('/login',{username:'owner',password:'performance-test-password'}); assert.equal(login.status,302,login.text);
  db=new Database(path.join(dir,'app.db')); db.pragma('busy_timeout=5000');
  const start=Date.now()-7*86400000-1000;
  db.transaction(()=>{
    db.prepare(`INSERT INTO nodes(id,name,node_type,panel_url,username,password_enc,inbound_id,api_auth_mode,api_token_enc,remnawave_node_uuid,remnawave_internal_squad_uuid) VALUES(1,'Germany','remnawave',?,'','',1,'token',?,'10000000-0000-4000-8000-000000000001','squad')`).run('http://127.0.0.1:'+origin.address().port,encrypt('performance-token',secret));
    const client=db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug) VALUES(?,?,?,?,?)');
    const mapping=db.prepare('INSERT INTO client_nodes(client_id,node_id,upload_bytes,download_bytes,used_bytes,traffic_gb,remote_email,remote_uuid) VALUES(?,1,0,120000,120000,5,?,?)');
    const snapshot=db.prepare('INSERT INTO client_traffic_snapshots(client_id,node_id,upload_bytes,download_bytes,used_bytes,created_at_ms) VALUES(?,1,0,?,?,?)');
    for(let id=1;id<=count;id++){
      client.run(id,'perf-user-'+id,'Performance '+id,'synthetic-uuid-'+id,'synthetic-sub-'+id);mapping.run(id,'perf-user-'+id,'synthetic-remote-'+id);
      for(let sample=0;sample<samples;sample++)snapshot.run(id,sample*1000,sample*1000,start+sample*3600000);
    }
  })();
  const snapshotCount=()=>db.prepare('SELECT COUNT(*) AS n FROM traffic_snapshots').get().n;
  const before=snapshotCount(), calls=remoteCalls, times=[]; let dashboard;
  for(let i=0;i<3;i++){dashboard=await request('/dashboard?online=1');assert.equal(dashboard.status,200,log);times.push(dashboard.ms);}
  const clients=await request('/clients'); assert.equal(clients.status,200,log);
  const measurements={source:baseline?'2.7.9 baseline':'optimized',clients:count,snapshots:count*samples,loginMs:login.ms,dashboardMs:times,clientsMs:clients.ms,htmlBytes:Buffer.byteLength(dashboard.text)};
  t.diagnostic(JSON.stringify(measurements));
  if(baseline)return;
  assert.equal(remoteCalls,calls,'landing HTML must not call remote APIs');
  assert.equal(snapshotCount(),before,'landing HTML must not insert snapshots');
  assert.match(dashboard.headers.get('server-timing'),/nexus;dur=/);
  assert.ok(Buffer.byteLength(dashboard.text)<300000,'do not serialize all clients into landing HTML');
  assert.match(dashboard.text,/"deferred":true/);
  const limits=await request('/dashboard/limits.json'); assert.equal(JSON.parse(limits.text).rows.length,count);
  assert.doesNotMatch(limits.text,/performance-token|api_token_enc|password_enc/);
  const summary=await request('/dashboard/traffic-summary.json');assert.equal(summary.status,200,summary.text);assert.equal(JSON.parse(summary.text).currentTotalText,'114 МБ');
  const onlineStart=remoteCalls;
  const online=await Promise.all([request('/dashboard/online-clients.json'),request('/dashboard/online-clients.json')]);
  assert.ok(online.every(result=>result.status===200));assert.equal(remoteCalls-onlineStart,1,'concurrent browser polls share one remote directory request');
  await request('/dashboard/online-clients.json'); assert.equal(remoteCalls-onlineStart,1,'5-second read cache');
  const reportPending=request('/dashboard/top-client-usage.json?refresh=0');
  const settingsDuringReport=await request('/settings');assert.equal(settingsDuringReport.status,200,settingsDuringReport.text);
  const top=await reportPending;assert.equal(top.status,200,top.text);assert.equal(JSON.parse(top.text).rows.length,Math.min(count,500));
  t.diagnostic(JSON.stringify({topReportMs:top.ms,settingsDuringReportMs:settingsDuringReport.ms}));

  if(process.env.NEXUS_BROWSER_QA==='1') {
    const {chromium}=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
    try {
      const context=await browser.newContext();await context.addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
      const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
      for(const width of [1440,390]) {
        await page.setViewportSize({width,height:900});await page.goto(base+'/dashboard');
        const topTab=width>600?page.locator('.desktop-page-tabs button[data-tab-target=top]'):page.locator('button[data-mobile-dashboard-tab=top]');
        await topTab.click(); await page.waitForFunction(()=>document.querySelectorAll('#quotaList .quota-client-row').length===20);
        await page.locator('#quotaNext').click();assert.match(await page.locator('#quotaPageInfo').textContent(),/^2 \/ /);
        await page.selectOption('#quotaPageSize','50');assert.equal(await page.locator('#quotaList .quota-client-row').count(),50);
        await page.locator('#quotaSearch').fill('perf-user-999');assert.equal(await page.locator('#quotaList .quota-client-row').count(),1);
        const trafficTab=width>600?page.locator('.desktop-page-tabs button[data-tab-target=traffic]'):page.locator('button[data-mobile-dashboard-tab=traffic]');
        await trafficTab.click();await page.waitForFunction(()=>document.querySelector('[data-traffic-summary="currentTotalText"]')?.textContent!=='—');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
        await page.screenshot({path:path.join(__dirname,'../../work/ui-qa/performance-dashboard-'+width+'.png'),fullPage:false});
      }
      assert.deepEqual(errors,[]);
    } finally { await browser.close(); }
  }
  // Repeated async checks still honor CSRF, disabled users and the lockout.
  const logout = await request('/logout',{}); assert.equal(logout.status,302,log + logout.text);await request('/login');
  const invalid=await Promise.all(Array.from({length:5},()=>request('/login',{username:'owner',password:'incorrect'})));
  assert.ok(invalid.every(result=>result.status===200));
  assert.match((await request('/login',{username:'owner',password:'performance-test-password'})).text,/Слишком много попыток/);
});
