'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http');
const {fork}=require('node:child_process'),{once}=require('node:events'),Database=require('better-sqlite3');
const {encrypt,decrypt}=require('../lib_crypto');
const root=path.resolve(__dirname,'..'),secret='awg-device-http-secret-'.repeat(4),key=n=>Buffer.alloc(32,n).toString('base64');
test('HTTP per-device AWG: HWID isolation, slots, manual links, revocation retry/restart and mixed subscriptions',{timeout:90000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-device-awg-'));
 const uuid='11111111-2222-4333-8444-555555555555';
 const users=new Map([['alice',{id:uuid,uuid,email:'alice',enable:true,inboundIds:[42,43],privateKey:key(5),allowedIPs:['10.8.0.2/32']}]]);
 let allocated=5,failedRemove=false;
 const writes=[];
 const inbound=id=>({id,port:id===42?50669:8443,enable:true,protocol:id===42?'amneziawg':'vless',
  shareAddrStrategy:'custom',shareAddr:'vpn.example',
  settings:JSON.stringify({...(id===42?{server:{publicKey:key(1),privateKey:key(2),randomTrailers:true,disableCookies:true}}:{decryption:'none'}),
   clients:[...users.values()].filter(c=>c.inboundIds.includes(id))}),
  ...(id===42?{}:{streamSettings:JSON.stringify({network:'tcp',security:'none'})}),
  clientStats:[...users.values()].filter(c=>c.inboundIds.includes(id)).map(c=>({email:c.email,up:c.up||0,down:c.down||0,enable:c.enable,total:c.totalGB||0}))});
 const remote=http.createServer(async(req,res)=>{
  const p=decodeURIComponent(new URL(req.url,'http://local').pathname);
  let raw='';for await(const b of req)raw+=b;
  const body=raw?((req.headers['content-type']||'').includes('json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))):{};
  const ok=obj=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({success:true,obj}));
  const missing=()=>res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({success:false,msg:'record not found'}));
  if(p==='/panel/api/server/status')return ok({version:'3.10.2'});
  if(p==='/panel/api/setting/all')return ok({});
  if(p==='/panel/api/inbounds/list')return ok([inbound(42),inbound(43)]);
  if(p.startsWith('/panel/api/inbounds/get/'))return ok(inbound(Number(p.split('/').at(-1))));
  if(p==='/panel/api/clients/list')return ok([...users.values()].map(c=>({client:c,inboundIds:c.inboundIds})));
  if(p.startsWith('/panel/api/clients/get/')){const c=users.get(p.split('/').at(-1));return c?ok({client:c,inboundIds:c.inboundIds}):missing();}
  if(p==='/panel/api/clients/add'){
   assert.ok(!users.has(body.client.email),'unique dedicated remote identity');
   const c={...body.client,uuid:body.client.id,inboundIds:body.inboundIds,privateKey:key(++allocated),publicKey:key(allocated+50),allowedIPs:['10.8.0.'+allocated+'/32']};
   users.set(c.email,c);writes.push({p,body});return ok({});
  }
  if(p.startsWith('/panel/api/clients/update/')){
   const c=users.get(p.split('/').at(-1));if(!c)return missing();
   Object.assign(c,body);writes.push({p,body});return ok({});
  }
  if(p.endsWith('/detach')){
   const c=users.get(p.split('/').at(-2));if(!c)return missing();
   if(failedRemove&&c.email.startsWith('nxawg_'))return res.writeHead(503).end('offline');
   c.inboundIds=c.inboundIds.filter(id=>!body.inboundIds.includes(id));writes.push({p,body});return ok({});
  }
  if(p.endsWith('/attach')){
   const c=users.get(p.split('/').at(-2));if(!c)return missing();
   c.inboundIds=[...new Set([...c.inboundIds,...body.inboundIds])];return ok({});
  }
  if(p.startsWith('/panel/api/clients/del/')||p==='/panel/api/clients/bulkDel'||(req.method==='DELETE'&&p.startsWith('/panel/api/clients/'))){
   if(failedRemove)return res.writeHead(503).end('offline');
   const emails=body.emails||[p.split('/').at(-1)];for(const e of emails)users.delete(e);
   writes.push({p,body});return ok({});
  }
  if(p.includes('ClientTraffics')||p.includes('/clients/traffic/')){
   const c=users.get(p.split('/').at(-1));return c?ok({email:c.email,up:c.up||0,down:c.down||0,enable:c.enable,total:c.totalGB||0}):ok([]);
  }
  return missing();
 });
 await new Promise(r=>remote.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+remote.address().port;
 let app,db,base,log='',csrf='',cookie='';
 async function start(){
  app=fork(path.join(root,'app.js'),[],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PORT:'0',NODE_ENV:'production',DATA_DIR:dir,NEXUS_CONTROL_DIR:dir,DOTENV_CONFIG_PATH:path.join(dir,'none.env'),
   ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'test-device-password',APP_SECRET:secret,SESSION_SECRET:secret,SESSION_SECURE:'0',TRUST_PROXY:'0',NEXUS_NODE_ENABLED:'0',BASE_URL:'http://localhost:3000',SUB_PUBLIC_URL:'http://localhost:3000'}});
  app.stderr.on('data',b=>log+=b);app.stdout.on('data',()=>{});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),15000);app.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m.port);}});app.once('exit',()=>reject(Error(log)));});
  base='http://127.0.0.1:'+port;
 }
 async function stop(){if(app&&app.exitCode===null){app.kill();await once(app,'exit');}}
 t.after(async()=>{await stop();db?.close();await new Promise(r=>remote.close(r));fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 await start();db=new Database(path.join(dir,'app.db'));db.pragma('busy_timeout=5000');
 db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug,device_limit,limit_ip,enabled) VALUES(1,?,?,?,?,?,?,1)').run('alice','Alice',uuid,'device-subscription-1',2,2);
 for(const [id,inboundId] of [[1,42],[2,43]]) {
  db.prepare("INSERT INTO nodes(id,name,node_type,panel_url,username,password_enc,api_auth_mode,api_token_enc,inbound_id,enabled,last_status) VALUES(?,?,'3xui',?,'','','token',?,?,1,'online')").run(id,'node'+id,origin,encrypt('test-token',secret),inboundId);
  db.prepare('INSERT INTO client_nodes(client_id,node_id,remote_uuid,remote_email,traffic_gb,enabled) VALUES(1,?,?,?,0,1)').run(id,uuid,'alice');
  db.prepare('INSERT INTO node_inbound_cache(node_id,inbound_id,inbound_json) VALUES(?,?,?)').run(id,inboundId,JSON.stringify(inbound(inboundId)));
 }
 async function request(route,body,headers={}) {
  const r=await fetch(base+route,{method:body?'POST':'GET',redirect:'manual',headers:{cookie,...(body?{'content-type':'application/x-www-form-urlencoded'}:{}),...headers},
   body:body?new URLSearchParams({_csrf:csrf,_workspace:'main',...body}):undefined});
  for(const v of r.headers.getSetCookie())cookie=v.split(';')[0];
  const text=await r.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;
  return {status:r.status,text,location:r.headers.get('location')};
 }
 async function login(){await request('/login');assert.equal((await request('/login',{username:'owner',password:'test-device-password'})).status,302);}
 const hwid=n=>'device-hwid-000000000'+n;
 const sub=(n,extra='')=>request('/sub-plain/device-subscription-1'+extra,undefined,n?{'x-hwid':hwid(n),'user-agent':'INCY/ios'}:{});
 function conf(response) {
  const line=response.text.split('\n').find(l=>l.startsWith('amneziawg://'));
  return line?Buffer.from(line.split('://')[1].split('#')[0],'base64url').toString():'';
 }
 await login();await request('/settings');
 const enabled=await request('/settings/happ-control',{awg_device_controls:'1',awg_device_peers_enabled:'1',subscription_update_interval_hours:'1'});
 assert.equal(enabled.status,302);assert.ok(!enabled.location.includes('error='),enabled.location+log);
 assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='awg_device_peers_enabled'").get().value,'1');
 const same=await Promise.all([sub(1),sub(1)]);assert.ok(conf(same[0]),same[0].text+log);assert.equal(conf(same[0]),conf(same[1]));
 assert.deepEqual(users.get('alice').inboundIds,[43],'old shared AWG is detached without disabling paid VLESS');
 assert.equal(users.get('alice').enable,true);
 const second=await sub(2);assert.ok(conf(second));assert.notEqual(conf(second).match(/^PrivateKey = (.+)$/m)[1],conf(same[0]).match(/^PrivateKey = (.+)$/m)[1]);
 const creates=writes.filter(w=>w.p==='/panel/api/clients/add');assert.equal(creates.length,2);
 assert.ok(!conf(await sub(3)),'device 3 never receives a shared or personal AWG');
 const noHwid=await sub(0);assert.equal(conf(noHwid),'');assert.ok(noHwid.text.includes('vless://'),'no-HWID does not remove other protocols');
 const json=await request('/json/device-subscription-1?format=incy',undefined,{'x-hwid':hwid(1),'user-agent':'INCY/ios'});
 const native=JSON.parse(json.text).find(c=>c.type==='amneziawg');
 assert.equal(Buffer.from(native.servers[0].config,'base64url').toString(),conf(same[0]));
 await stop();await start();cookie='';csrf='';await login();await request('/clients');
 assert.equal(conf(await sub(1)),conf(same[0]),'key survives restart');
 await request('/settings/happ-control',{awg_device_controls:'1',subscription_update_interval_hours:'1'});
 for(let i=0;i<60&&db.prepare('SELECT 1 FROM awg_device_owners WHERE detached=1').get();i++)await new Promise(r=>setTimeout(r,50));
 assert.equal(db.prepare('SELECT 1 FROM awg_device_owners WHERE detached=1').get(),undefined,'turning off restores shared AWG');
 assert.deepEqual(users.get('alice').inboundIds.sort(),[42,43]);
 assert.ok([...users.values()].filter(p=>p.email.startsWith('nxawg_')).every(p=>p.enable===false),'personal keys disabled before shared restoration');
 await request('/settings/happ-control',{awg_device_controls:'1',awg_device_peers_enabled:'1',subscription_update_interval_hours:'1'});
 assert.equal(conf(await sub(1)),conf(same[0]),'turning back on keeps the personal key');
 assert.deepEqual(users.get('alice').inboundIds,[43]);
 const firstDevice=db.prepare('SELECT id FROM subscription_devices ORDER BY id LIMIT 1').get().id;
 const firstPeer=db.prepare('SELECT * FROM awg_device_peers WHERE device_id=?').get(firstDevice);
 failedRemove=true;
 const removed=await request('/clients/1/devices/'+firstDevice+'/delete',{});assert.equal(removed.status,302);
 assert.match(decodeURIComponent(removed.location),/очеред|отзыв/);
 assert.equal(users.has(firstPeer.email),true,'failed API never falsely confirms revocation');
 await request('/clients');
 const manual=await request('/clients/1/devices/create',{});assert.ok(!manual.location.includes('error='),manual.location+log);
 const link=db.prepare('SELECT * FROM awg_manual_links WHERE client_id=1').get();assert.ok(link);
 const token=decrypt(link.token_enc,secret);
 const beforeAdds=writes.filter(w=>w.p==='/panel/api/clients/add').length;
 assert.equal(conf(await sub(0,'?device='+token)),'','pending old key blocks a replacement');
 assert.equal(writes.filter(w=>w.p==='/panel/api/clients/add').length,beforeAdds);
 failedRemove=false;
 await stop();await start();cookie='';csrf='';await login();await request('/clients');
 const manualResponse=await sub(0,'?device='+token);assert.ok(conf(manualResponse),manualResponse.text+log);
 const nativeFile=await request('/sub-plain/device-subscription-1?device='+token+'&download=awg&node_id=1');
 assert.equal(nativeFile.status,200);assert.equal(nativeFile.text,conf(manualResponse),'native .conf belongs to the same device');
 db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug,device_limit,enabled) VALUES(2,?,?,?,?,2,1)')
  .run('bob','Bob','aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee','device-subscription-2');
 assert.equal((await request('/sub-plain/device-subscription-2?device='+token)).status,403,'manual token is scoped to its owner');
 assert.equal(users.has(firstPeer.email),false,'restart resumes durable revocation');
 const other=await request('/clients/1/devices/create',{});assert.ok(other.location.includes('error='),'manual links consume slots too');
 if(process.env.NEXUS_PLAYWRIGHT_MODULE) {
  const {chromium}=require(process.env.NEXUS_PLAYWRIGHT_MODULE),browser=await chromium.launch({headless:true,channel:'msedge'});
  try{
   const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',r=>new URL(r.request().url()).hostname==='127.0.0.1'?r.continue():r.abort());
   await page.goto(base+'/login');await page.locator('[name=username]').fill('owner');await page.locator('[name=password]').fill('test-device-password');
   await Promise.all([page.waitForURL('**/dashboard'),page.locator('button[type=submit]').click()]);
   for(const width of [1440,390]) {
    await page.setViewportSize({width,height:920});await page.goto(base+'/settings?settings_tab=settings-tab-happ');
    const toggle=page.locator('[name=awg_device_peers_enabled]');await toggle.scrollIntoViewIfNeeded();assert.equal(await toggle.isChecked(),true);
    assert.equal(await page.locator('[name=subscription_device_refresh_mode]').inputValue(),'manual');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    if(process.env.NEXUS_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.NEXUS_UI_SCREENSHOT_DIR,'awg-device-settings-'+width+'.png')});
    const clientsPage=await page.goto(base+'/clients?q=alice&edit=1');
    assert.equal(clientsPage.status(),200,(await page.locator('body').innerText()).slice(0,1800));
    assert.ok(await page.locator('.client-device-count-link').count(),(await page.locator('body').innerText()).slice(0,1800));
    await page.locator('#clientEditor-1 .client-device-count-link').click();
    const modal=page.locator('#deviceDetails-1');await modal.waitFor({state:'visible'});
    assert.equal(await modal.locator('form[action="/clients/1/devices/create"]').count(),1);
    assert.equal(await modal.getByRole('link',{name:'JSON устройства',exact:true}).count(),1);
    assert.ok((await modal.getByRole('link',{name:'JSON устройства',exact:true}).getAttribute('href')).includes('device='));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    if(process.env.NEXUS_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.NEXUS_UI_SCREENSHOT_DIR,'awg-device-modal-'+width+'.png')});
   }
   assert.deepEqual(errors,[]);
  }finally{await browser.close();}
 }
 const invalid=await request('/sub-plain/device-subscription-1?device='+'0'.repeat(40));assert.equal(invalid.status,403);
 assert.equal((await request('/clients/1/devices/reset',{})).status,302);
 assert.equal((await sub(0,'?device='+token)).status,403,'revoked manual link cannot allocate a replacement slot');
 assert.equal((await request('/sub-plain/device-subscription-1?device='+token+'&download=awg&node_id=1')).status,403);
 assert.equal([...users.keys()].filter(e=>e.startsWith('nxawg_')).length,0,'reset revokes every dedicated remote client');
 assert.deepEqual(users.get('alice').inboundIds,[43]);
});

