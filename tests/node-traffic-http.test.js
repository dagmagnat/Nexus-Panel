'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {fork}=require('node:child_process');
const Database=require('better-sqlite3'),{encrypt}=require('../lib_crypto');
test('real HTTP: scoped reporting, individual/bulk/all reset, CSRF and viewer protection',{timeout:60000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-node-traffic-')),secret='node-traffic-http-secret-'.repeat(3),GB=1024**3,today=new Date().toISOString().slice(0,10);
  const physical=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'],squads=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
  const users=[17,18].map((id,i)=>({id,uuid:`20000000-0000-4000-8000-0000000000${id}`,vlessUuid:`40000000-0000-4000-8000-00000000000${i+1}`,username:'user'+(i+1),activeInternalSquads:[...squads],status:'ACTIVE',trafficLimitBytes:0,expireAt:'2099-01-01T00:00:00Z',userTraffic:{usedTrafficBytes:(i?21:32)*GB}}));
  const resets=[],patches=[]; let userListReads=0;
  const origin=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost'),route=url.pathname;
    let response;
    if(route.startsWith('/sub/users/')) {
      const u=users.find(u=>route.endsWith('/'+u.id));
      const extra=encodeURIComponent(JSON.stringify({xPaddingBytes:'100-1000',xPaddingObfsMode:true,xPaddingPlacement:'queryInHeader'}));
      res.setHeader('content-type','text/plain');res.end(physical.flatMap((uuid,i)=>u.activeInternalSquads.includes(squads[i]) ? [`vless://${u.vlessUuid}@${i?'finland':'germany'}.invalid:443?security=tls&type=xhttp&host=cdn.example.invalid&path=%2Fstreaming%2Fcontent%2Fmusic-cascade%2F&mode=packet-up&extra=${extra}#${i?'Finland':'Germany'}`] : []).join('\n'));return;
    }
    if(route==='/api/nodes')response={nodes:physical.map(uuid=>({uuid}))};
    else if(route==='/api/system/metadata')response={version:'3.3.0'};
    else if(route==='/api/users' && req.method==='GET'){userListReads++;response={users,total:2};}
    else if(route==='/api/users' && req.method==='PATCH'){
      let body='';for await(const chunk of req)body+=chunk;const p=JSON.parse(body);
      if (p.uuid || !Number.isSafeInteger(p.id) || p.username) {res.writeHead(400).end(JSON.stringify({error:'3.3.0 requires exactly id or username'}));return;}
      const u=users.find(u=>u.id===p.id);assert.ok(u);Object.assign(u,p);patches.push(p);response=u;
    }else if(route.includes('/accessible-nodes')){const i=squads.findIndex(id=>route.includes(id));response={accessibleNodes:[{uuid:physical[i]}]};}
    else if(route.includes('/api/bandwidth-stats/users/')){
      const i=Number(route.split('/').pop())===17?0:1;response={categories:[today],series:physical.map((uuid,j)=>({uuid,data:[(j?(i?1:2):(i?20:30))*GB]}))};
    }else if(route.includes('/actions/reset-traffic')){const u=users.find(u=>route.includes(u.uuid)||route.split('/').includes(String(u.id)));u.userTraffic.usedTrafficBytes=0;resets.push(u.id);response=u;}
    else if(route.startsWith('/api/users/'))response=users.find(u=>route.endsWith('/'+u.uuid)||route.endsWith('/'+u.id));
    else{res.writeHead(404).end();return;}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({response}));
  });await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));
  const child=fork(path.join(__dirname,'../app.js'),[],{cwd:path.join(__dirname,'..'),stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,DOTENV_CONFIG_PATH:path.join(dir,'absent.env'),DATA_DIR:dir,NEXUS_CONTROL_DIR:dir,NODE_ENV:'development',PORT:'0',ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'test-owner-password',APP_SECRET:secret,SESSION_SECRET:'s'.repeat(64),SESSION_SECURE:'0',TRUST_PROXY:'0',NEXUS_NODE_ENABLED:'0',PANEL_PUBLIC_URL:'http://localhost:3000',SUB_PUBLIC_URL:'http://localhost:3000'}});
  let log='';child.stderr.on('data',d=>log+=d);child.stdout.on('data',()=>{});
  let db;
  t.after(async()=>{db?.close();child.kill();await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);setTimeout(resolve,3000).unref();});await new Promise(resolve=>origin.close(resolve));if(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep))fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(log||'startup timeout')),20000);child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m.port);}});child.once('exit',()=>{clearTimeout(timer);reject(new Error(log));});});
  const base='http://127.0.0.1:'+port;let cookie='',csrf='';
  async function request(route,body,{raw=false,extraHeaders={}}={}){
    const headers={cookie,...extraHeaders};let encoded;
    if(body){encoded=new URLSearchParams();for(const [key,value]of Object.entries(body))for(const item of Array.isArray(value)?value:[value])encoded.append(key,item);if(!raw){encoded.set('_csrf',csrf);encoded.set('_workspace','main');}headers['content-type']='application/x-www-form-urlencoded';}
    const r=await fetch(base+route,{method:body?'POST':'GET',headers,body:encoded?.toString(),redirect:'manual'});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const text=await r.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;return{status:r.status,text,location:r.headers.get('location'),headers:r.headers};
  }
  assert.equal((await request('/node-traffic')).status,302);await request('/login');assert.equal((await request('/login',{username:'owner',password:'test-owner-password'})).status,302);
  assert.equal((await request('/node-traffic')).status,200,log);
  db=new Database(path.join(dir,'app.db'));db.pragma('busy_timeout=5000');
  for(let i=0;i<2;i++){
    db.prepare('INSERT INTO nodes(id,name,node_type,panel_url,username,password_enc,api_auth_mode,api_token_enc,remnawave_internal_squad_uuid,remnawave_node_uuid,inbound_id) VALUES(?,?,?,?,?,?,?,?,?,?,1)').run(i+1,i?'Финляндия':'Германия','remnawave','http://127.0.0.1:'+origin.address().port,'','', 'token',encrypt('synthetic-token',secret),squads[i],physical[i]);
    const u=users[i];db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug) VALUES(?,?,?,?,?)').run(i+1,u.username,u.username,u.vlessUuid,'synthetic-'+i);
  }
  for(const c of [1,2])for(const n of [1,2])db.prepare('INSERT INTO client_nodes(client_id,node_id,remote_email,remote_uuid,traffic_gb) VALUES(?,?,?,?,?)').run(c,n,users[c-1].username,users[c-1].uuid,n===1&&c===1?5:50);
  for(const [i,u] of users.entries()){
    u.subscriptionUrl='http://127.0.0.1:'+origin.address().port+'/sub/users/'+u.id;
    db.prepare('UPDATE client_nodes SET remote_sub_url=? WHERE client_id=?').run(u.subscriptionUrl,i+1);
  }
  db.exec("UPDATE nodes SET remnawave_link_filter=CASE WHEN id=1 THEN 'germany.invalid' ELSE 'finland.invalid' END");
  let r=await request('/node-traffic/data.json?refresh=1&from='+today+'&to='+today);assert.equal(r.status,200,r.text);let data=JSON.parse(r.text);assert.deepEqual(data.errors,[],log);assert.equal(data.nodes[0].clients.find(c=>c.id===1).used_bytes,30*GB);assert.equal(data.nodes[1].clients.find(c=>c.id===1).used_bytes,2*GB);assert.doesNotMatch(r.text,/synthetic-token|api_token_enc|password_enc/);
  assert.equal(userListReads,1,'two physical nodes share one remote user-directory read per sweep');
  assert.deepEqual(users[0].activeInternalSquads,[squads[1]]);assert.equal(users[0].trafficLimitBytes,0);
  // Exercise a real edit against a strict 3.3.0 API (exactly one numeric ID).
  r=await request('/clients/1/edit',{login:'user1',traffic_gb:50,node_enabled_1:'1',node_enabled_2:'1',node_traffic_gb_1:5,node_traffic_gb_2:50});
  assert.equal(r.status,302,r.text);assert.ok(!r.location.includes('error='),r.location);assert.equal(users[0].trafficLimitBytes,50*GB);
  assert.equal(db.prepare('SELECT traffic_gb FROM client_nodes WHERE client_id=1 AND node_id=1').get().traffic_gb,5);
  // Repair old native LIMITED in the SAME subscription request, retaining Finland.
  db.exec('UPDATE clients SET traffic_gb=0 WHERE id=1');users[0].trafficLimitBytes=5*GB;users[0].status='LIMITED';
  r=await request('/sub-plain/synthetic-0');assert.equal(r.status,200,r.text);assert.match(r.text,/finland\.invalid/);assert.doesNotMatch(r.text,/germany\.invalid/);assert.equal(users[0].status,'ACTIVE');assert.equal(users[0].trafficLimitBytes,0);
  assert.equal((await request('/clients/traffic/reset-selected',{client_ids:[1],reset_node_id:1},{raw:true})).status,403);
  r=await request('/clients/1/traffic/reset',{node_ids:[1]});assert.equal(r.status,302,r.text);assert.ok(!r.location.includes('error='),r.location);assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE client_id=1 AND node_id=1').get().used_bytes,0);assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE client_id=1 AND node_id=2').get().used_bytes,2*GB);assert.deepEqual(resets,[]);assert.ok(users[0].activeInternalSquads.includes(squads[0]));
  const outcome=text=>new URL(text.match(/location.replace\("([^"]+)"/)[1],'http://localhost').searchParams.get('message');
  r=await request('/clients/traffic/reset-selected',{client_ids:[1,1],reset_node_id:2});assert.equal(r.status,200,r.text);assert.match(outcome(r.text),/Сброшено счётчиков: 1 из 1/);assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE client_id=2 AND node_id=2').get().used_bytes,GB);assert.deepEqual(resets,[]);
  r=await request('/clients/traffic/reset-selected',{client_ids:[1],reset_node_id:'all'});assert.match(outcome(r.text),/Сброшено счётчиков: 2 из 2/);assert.deepEqual(resets,[17]);
  data=JSON.parse((await request('/node-traffic/data.json?from='+today+'&to='+today)).text);assert.equal(data.nodes[0].totalBytes,50*GB);assert.equal(data.nodes[1].totalBytes,3*GB);
  // Routing saved in Nexus must apply to Remnawave JSON entries, not change
  // server profiles or their XHTTP/TLS transport settings.
  r=await request('/routing');assert.equal(r.status,200,r.text);assert.match(r.text,/data-node-id="1"/);assert.match(r.text,/data-node-id="2"/);
  const routingForm={routing_enabled:'1',routing_modes:['proxy-except','node-selective'],routing_mode_nodes_proxy_except:[1],routing_mode_nodes_node_selective:[2],
    except_domains:'domain:direct-only.example',custom_domains:'domain:proxy-only.example',adblock_enabled:'1',adblock_domains:'domain:ads-only.example'};
  r=await request('/routing',routingForm);assert.equal(r.status,302,r.text);assert.ok(!r.location.includes('error='),r.location);
  async function jsonConfigs(query='') {
    const result=await request('/json/synthetic-0?download=1'+query);assert.equal(result.status,200,result.text);return JSON.parse(result.text);
  }
  let configs=await jsonConfigs();assert.equal(configs.length,2);
  const configFor=(items,address)=>items.find(config=>config.outbounds.some(out=>out.settings?.vnext?.[0]?.address===address));
  const germany=configFor(configs,'germany.invalid'),finland=configFor(configs,'finland.invalid');
  assert.ok(germany.routing,'Remnawave Germany must receive assigned Nexus routing');
  assert.ok(finland.routing,'Remnawave Finland must receive assigned Nexus routing');
  assert.ok(germany.routing.rules.some(rule=>rule.domain?.includes('domain:direct-only.example')&&rule.outboundTag==='direct'));
  assert.equal(germany.routing.rules.at(-1).outboundTag,'proxy');
  assert.ok(finland.routing.rules.some(rule=>rule.domain?.includes('domain:proxy-only.example')&&rule.outboundTag==='proxy'));
  assert.equal(finland.routing.rules.at(-1).outboundTag,'direct');
  for(const config of configs) {
    assert.ok(config.routing.rules.some(rule=>rule.domain?.includes('domain:ads-only.example')&&rule.outboundTag==='block'));
    const proxy=config.outbounds.find(out=>out.tag==='proxy');assert.equal(proxy.streamSettings.network,'xhttp');assert.equal(proxy.streamSettings.security,'tls');
    assert.equal(proxy.streamSettings.xhttpSettings.host,'cdn.example.invalid');assert.equal(proxy.streamSettings.xhttpSettings.path,'/streaming/content/music-cascade/');
    assert.equal(proxy.streamSettings.xhttpSettings.mode,'packet-up');assert.equal(proxy.streamSettings.xhttpSettings.extra.xPaddingObfsMode,true);
    assert.equal(proxy.settings.vnext[0].users[0].id,users[0].vlessUuid);
  }
  const single=await jsonConfigs('&node=1');assert.deepEqual(single.routing,configs[0].routing);
  const previousTransport=germany.outbounds.find(out=>out.tag==='proxy');
  const dnsForm={...routingForm,routing_dns_controls:'1',direct_dns_enabled:'1',direct_dns_preset:'doh_yandex',sniffing_route_only:'1'};
  r=await request('/routing',dnsForm);assert.ok(!r.location.includes('error='),r.location);
  r=await request('/routing');assert.equal(r.status,200,r.text);assert.match(r.text,/name="direct_dns_enabled" value="1" checked/);assert.match(r.text,/name="sniffing_route_only" value="1" checked/);
  configs=await jsonConfigs();let dnsGermany=configFor(configs,'germany.invalid'),dnsFinland=configFor(configs,'finland.invalid');
  assert.equal(dnsGermany.dns.servers.find(x=>x.tag==='nexus-dns-direct').address,'https+local://common.dot.dns.yandex.net/dns-query');
  assert.deepEqual(dnsGermany.dns.servers.find(x=>x.tag==='nexus-dns-direct').domains,['domain:direct-only.example']);
  assert.ok(dnsGermany.routing.rules.some(x=>x.inboundTag?.includes('nexus-dns-direct')&&x.outboundTag==='direct'));
  assert.ok(!dnsFinland.dns.servers.some(x=>x.tag==='nexus-dns-direct'),'direct DNS belongs only to direct-exceptions mode');
  for(const cfg of [dnsGermany,dnsFinland])assert.ok(cfg.inbounds.every(x=>x.sniffing.routeOnly===true));
  assert.deepEqual(dnsGermany.outbounds.find(x=>x.tag==='proxy'),previousTransport,'cascade XHTTP and its credentials stay unchanged');
  const savedDns=db.prepare("SELECT value FROM app_settings WHERE key='routing_config'").get().value;
  r=await request('/routing',{...dnsForm,direct_dns_preset:'manual',direct_dns_custom:'http://invalid-dns.test/query'});assert.match(r.location,/error=/);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='routing_config'").get().value,savedDns,'invalid resolver must not partially save settings');
  r=await request('/routing',dnsForm,{raw:true});assert.equal(r.status,403,'DNS save still requires CSRF');
  r=await request('/routing',routingForm);assert.ok(!r.location.includes('error='),'old forms remain compatible');
  assert.equal(JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key='routing_config'").get().value).directDnsEnabled,true,'old form does not reset new opt-ins');
  r=await request('/routing',{...routingForm,routing_dns_controls:'1'});assert.ok(!r.location.includes('error='),r.location);
  configs=await jsonConfigs();dnsGermany=configFor(configs,'germany.invalid');assert.ok(!dnsGermany.dns.servers.some(x=>x.tag==='nexus-dns-direct'));assert.ok(dnsGermany.inbounds.every(x=>x.sniffing.routeOnly===false));
  r=await request('/routing',{...routingForm,routing_modes:['proxy-except']});assert.ok(!r.location.includes('error='),r.location);
  configs=await jsonConfigs();assert.equal(configFor(configs,'finland.invalid').routing,undefined,'unassigned node must not inherit routing');
  r=await request('/routing',{...routingForm,routing_enabled:'0'});assert.ok(!r.location.includes('error='),r.location);
  configs=await jsonConfigs();assert.ok(configs.every(config=>!config.routing),'global off is respected');
  assert.deepEqual(configFor(configs,'germany.invalid').outbounds.find(out=>out.tag==='proxy'),previousTransport);
  assert.equal((await request('/node-traffic/data.json?from=2026-02-30')).status,400);
  assert.equal((await request('/clients')).status,200,log);
  // Real HTTP directory: only page clients and their modals are serialized.
  db.transaction(()=>{for(let id=3;id<=243;id++)db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug) VALUES(?,?,?,?,?)').run(id,'paged-user-'+id,'Paged user '+id,'test-uuid-'+id,'paged-sub-'+id);})();
  const renderedIds=text=>[...new Set([...text.matchAll(/data-client-id-entry="(\d+)"/g)].map(m=>Number(m[1])))];
  r=await request('/clients');assert.equal(r.status,200,r.text);assert.equal(renderedIds(r.text).length,20);assert.deepEqual(renderedIds(r.text).slice(0,2),[243,242]);assert.match(r.text,/Показано 1–20 из 243/);assert.doesNotMatch(r.text,/id="clientEditor-1"/);
  r=await request('/clients?page=2');assert.equal(renderedIds(r.text)[0],223);assert.equal(renderedIds(r.text).length,20);
  for(const size of [50,100,150,200]){r=await request('/clients?page_size='+size);assert.equal(renderedIds(r.text).length,size);}
  r=await request('/clients?page_size=all');assert.equal(renderedIds(r.text).length,243);
  r=await request('/clients?q=paged-user-3');assert.ok(renderedIds(r.text).includes(3));
  r=await request('/clients/usage.json?ids=1,2');assert.deepEqual(JSON.parse(r.text).clients.map(c=>c.id),[1,2]);
  r=await request('/settings');assert.equal(r.status,200,r.text);assert.match(r.text,/subscription_device_refresh_mode/);
  // Rejected unacknowledged full-reset mode must not change any setting.
  r=await request('/settings/happ-control',{subscription_device_refresh_mode:'reset-on-refresh'});assert.match(r.location,/error=/);assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='subscription_device_refresh_mode'").get().value,'manual');
  db.exec('UPDATE clients SET device_limit=2 WHERE id=1');
  const appRequest=hwid=>request('/sub-plain/synthetic-0',undefined,{extraHeaders:{'x-hwid':hwid,'user-agent':'Happ/Test'}});
  await appRequest('DeviceSynthetic01');await appRequest('DeviceSynthetic02');
  r=await appRequest('DeviceSynthetic03');assert.equal(r.headers.get('x-hwid-limit'),'true');
  db.prepare("UPDATE app_settings SET value='replace-stale' WHERE key='subscription_device_refresh_mode'").run();
  db.exec("UPDATE subscription_devices SET last_seen_at='2020-01-01' WHERE client_id=1 AND id=(SELECT MIN(id) FROM subscription_devices WHERE client_id=1)");
  r=await appRequest('DeviceSynthetic03');assert.notEqual(r.headers.get('x-hwid-limit'),'true');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscription_devices WHERE client_id=1').get().n,2);
  db.prepare("UPDATE app_settings SET value='reset-on-refresh' WHERE key='subscription_device_refresh_mode'").run();
  await appRequest('DeviceSynthetic04');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscription_devices WHERE client_id=1').get().n,1);
  if(process.env.NEXUS_BROWSER_QA==='1'){
    const {chromium}=require('C:/Users/user/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    const browser=await chromium.launch({executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true});
    try{
      const context=await browser.newContext();await context.addCookies([{name:cookie.split('=')[0],value:cookie.slice(cookie.indexOf('=')+1),url:base}]);
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      for(const width of [1440,390]){
        await page.setViewportSize({width,height:900});await page.goto(base+'/clients');await page.waitForSelector('#clientPageSize');
        assert.equal(await page.locator('#clientPageSize').inputValue(),'20');assert.equal(await page.locator('[data-client-entry]:visible').count(),20);
        await page.selectOption('#clientPageSize','50');await page.waitForURL(/page_size=50/);await page.waitForLoadState('domcontentloaded');assert.equal(await page.locator('[data-client-entry]:visible').count(),50);
        await page.locator('.client-pagination a[rel=next]').click();await page.waitForURL(/page=2/);await page.waitForLoadState('domcontentloaded');assert.equal(await page.locator('[data-client-entry]:visible').count(),50);
        await page.locator('.client-pagination').screenshot({path:path.join(__dirname,'../../work/ui-qa/clients-pagination-'+width+'.png')});
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
        await page.selectOption('#clientNodeFilter','1');await page.waitForURL(/node_id=1/);await page.waitForLoadState('domcontentloaded');assert.equal(await page.locator('[data-client-entry]:visible').count(),2);
      }
      assert.deepEqual(errors,[]);
    }finally{await browser.close();}
  }
  r=await request('/access/users',{username:'viewer',password:'viewer-test-password',workspace_id:'main',permissions:['clients.read']});assert.equal(r.status,302,r.text);cookie='';csrf='';await request('/login');await request('/login',{username:'viewer',password:'viewer-test-password'});
  assert.equal((await request('/node-traffic')).status,200);assert.equal((await request('/node-traffic/data.json')).status,200);assert.equal((await request('/clients/traffic/reset-selected',{client_ids:[1],reset_node_id:1})).status,403);assert.equal((await request('/clients/1/traffic/reset',{node_ids:[1]})).status,403);
});
