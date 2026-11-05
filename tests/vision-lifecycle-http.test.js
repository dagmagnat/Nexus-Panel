'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {fork}=require('node:child_process'),{once}=require('node:events'),Database=require('better-sqlite3'),{encrypt}=require('../lib_crypto');
const root=path.resolve(__dirname,'..'),vision='xtls-rprx-vision';
for(const modern of [false,true])test('Vision lifecycle: '+(modern?'global clients with per-inbound Flow':'legacy inbound API'),{timeout:60000},async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-vision-')),secret='vision-http-secret-'.repeat(5),users=new Map(),links=new Map(),writes=[];
 const uuid=n=>'90000000-0000-4000-8000-'+String(n).padStart(12,'0');
 let discardFlow=false;
 const attach=(email,id,flow='')=>{if(!links.has(email))links.set(email,new Map());links.get(email).set(id,flow)};
 const inbound=id=>({id,port:id===1?8443:id===2?10443:9443,enable:true,protocol:'vless',remark:'test',
  settings:JSON.stringify({decryption:'none',clients:[...users.values()].filter(c=>links.get(c.email)?.has(id)).map(c=>({...c,flow:links.get(c.email).get(id)}))}),
  streamSettings:JSON.stringify({network:id===2?'xhttp':'tcp',security:id===3?'tls':'reality',
   realitySettings:{serverNames:['vpn.example'],shortIds:['ab'],settings:{publicKey:'synthetic-key',fingerprint:'firefox'}},
   tlsSettings:{serverName:'vpn.example'},xhttpSettings:{path:'/xhttp/'}}),clientStats:[]});
 const remote=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://local'),p=decodeURIComponent(url.pathname);
  let raw='';for await(const b of req)raw+=b;
  const body=raw?((req.headers['content-type']||'').includes('json')?JSON.parse(raw):Object.fromEntries(new URLSearchParams(raw))):{};
  const ok=obj=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({success:true,obj}));
  const missing=()=>res.writeHead(404).end(JSON.stringify({success:false,msg:'record not found'}));
  if(p==='/login'){res.setHeader('set-cookie','session=test; Path=/');return ok({});}
  if(p==='/panel/api/server/status')return ok({version:modern?'3.11.0':'2.5.8'});
  if(p==='/panel/api/setting/all')return ok({});
  if(p==='/panel/api/clients/bulkDetach'){
   if(!modern)return res.writeHead(404).end('Cannot POST /panel/api/clients/bulkDetach');
   for(const email of body.emails)for(const id of body.inboundIds)links.get(email)?.delete(id);
   writes.push({p,body});return ok({detached:body.emails,skipped:[],errors:[]});
  }
  if(p==='/panel/api/inbounds/list')return ok([1,2,3].map(inbound));
  if(p.startsWith('/panel/api/inbounds/get/'))return ok(inbound(Number(p.split('/').at(-1))));
  if(modern&&p==='/panel/api/clients/list')return ok([...users.values()].map(c=>({client:c,inboundIds:[...links.get(c.email).keys()]})));
  if(modern&&p.startsWith('/panel/api/clients/get/')){const c=users.get(p.split('/').at(-1));return c?ok({client:c,inboundIds:[...links.get(c.email).keys()]}):missing();}
  if(modern&&p.endsWith('/attach')){const c=users.get(p.split('/').at(-2));if(!c)return missing();for(const id of body.inboundIds)attach(c.email,id,id===2?'':c.flow||'');writes.push({p,body});return ok({});}
  if(modern&&p==='/panel/api/clients/add'){const c=body.client;assert.ok(!users.has(c.email));users.set(c.email,c);for(const id of body.inboundIds)attach(c.email,id,c.flow||'');writes.push({p,body});return ok({});}
  if(modern&&p.startsWith('/panel/api/clients/update/')){
   const c=users.get(p.split('/').at(-1));if(!c)return missing();Object.assign(c,body);
   const ids=url.searchParams.get('inboundIds')?.split(',').map(Number)||[...links.get(c.email).keys()];
   for(const id of ids)if(links.get(c.email).has(id))attach(c.email,id,id===2?'':body.flow||'');
   writes.push({p,body});return ok({});
  }
  if(p==='/panel/api/inbounds/addClient'||p.startsWith('/panel/api/inbounds/updateClient/')){
   const c=JSON.parse(body.settings).clients[0],old=users.get(c.email);
   if(p.includes('updateClient')&&!old)return missing();
   users.set(c.email,{...old,...c});attach(c.email,Number(body.id),discardFlow?'':c.flow||'');
   writes.push({p,body});return ok({});
  }
  if((modern&&p.endsWith('/detach'))||(!modern&&p.includes('/delClient/'))){
   const c=modern?users.get(p.split('/').at(-2)):[...users.values()].find(c=>c.id===p.split('/').at(-1));if(!c)return missing();
   for(const id of modern?body.inboundIds:[Number(p.split('/')[4])])links.get(c.email).delete(id);
   writes.push({p,body});return ok({});
  }
  return missing();
 });
 await new Promise(r=>remote.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+remote.address().port;
 let log='',child,db,cookie='',csrf='';
 t.after(async()=>{if(child?.exitCode===null){child.kill();await once(child,'exit');}db?.close();await new Promise(r=>remote.close(r));fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
 child=fork(path.join(root,'app.js'),[],{cwd:root,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PORT:'0',DATA_DIR:dir,NEXUS_CONTROL_DIR:dir,NODE_ENV:'production',DOTENV_CONFIG_PATH:path.join(dir,'none.env'),ADMIN_USERNAME:'owner',ADMIN_PASSWORD:'vision-test-password',APP_SECRET:secret,SESSION_SECRET:secret,SESSION_SECURE:'0',TRUST_PROXY:'0',NEXUS_NODE_ENABLED:'0'}});
 child.stderr.on('data',b=>log+=b);child.stdout.on('data',()=>{});
 const port=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(log)),15000);child.on('message',m=>{if(m.type==='ready'){clearTimeout(timer);resolve(m.port)}})});
 const base='http://127.0.0.1:'+port;
 async function request(route,body){
  const r=await fetch(base+route,{method:body?'POST':'GET',redirect:'manual',headers:{cookie,...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams({_csrf:csrf,_workspace:'main',...body}):undefined});
  for(const h of r.headers.getSetCookie())cookie=h.split(';')[0];
  const text=await r.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;return {status:r.status,text,location:r.headers.get('location')};
 }
 db=new Database(path.join(dir,'app.db'));db.pragma('busy_timeout=5000');
 for(const [id,name] of [[1,'alice'],[2,'bob'],[3,'charlie']])db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug,enabled,traffic_gb) VALUES(?,?,?,?,?,1,5)').run(id,name,name,uuid(id),'vision-key-'+id);
 users.set('alice',{id:uuid(1),email:'alice',enable:true,subId:'alice-remote',totalGB:12345,expiryTime:0,flow:''});attach('alice',1,'');
 if(modern){users.set('charlie',{id:uuid(3),email:'charlie',enable:true,subId:'charlie-remote',totalGB:45678,expiryTime:0,flow:''});attach('charlie',2,'');}
 await request('/login');assert.equal((await request('/login',{username:'owner',password:'vision-test-password'})).status,302);await request('/nodes?tab=add');
 const added=await request('/nodes',{node_type:'3xui',panel_url:origin,inbound_id:'1',api_auth_mode:modern?'token':'password',api_token:'token',username:'admin',password:'password',country_code:'NL',create_existing_clients_on_node:'1'});
 assert.equal(added.status,302);assert.ok(!new URL(added.location,base).searchParams.has('error'),added.location+log);
 for(const name of ['alice','bob','charlie'])assert.equal(links.get(name).get(1),vision,name+' must have server-side Vision');
 assert.equal(users.get('alice').totalGB,12345,'Flow repair must preserve remote quota');assert.equal(users.get('alice').subId,'alice-remote');
 if(modern)assert.equal(links.get('charlie').get(2),'','repair must not change XHTTP flow');
 let before=writes.length;await request('/nodes/1/create-missing-clients',{});assert.equal(writes.length,before,'repeat is idempotent');
 links.get('alice').set(1,'');await request('/nodes/1/create-missing-clients',{});assert.equal(links.get('alice').get(1),vision,'old broken client is repaired');
 const edit=await request('/clients/2/edit',{login:'bob',node_enabled_1:'1',node_traffic_gb_1:'8'});
 assert.ok(!edit.location.includes('error='),edit.location+log);assert.equal(links.get('bob').get(1),vision);
 const sub=await request('/sub/vision-key-2?raw=1');assert.equal(sub.status,200);assert.ok(sub.text.includes('flow=xtls-rprx-vision'));
 // No fallback to another client's Vision when an exact user's server flow is empty.
 links.get('bob').set(1,'');db.prepare("UPDATE node_inbound_cache SET updated_at='2000-01-01 00:00:00'").run();
 const oldSub=await request('/sub/vision-key-2?raw=1');assert.equal(oldSub.text.includes('flow=xtls-rprx-vision'),false);
 const message=r=>new URL(JSON.parse(r.text.match(/location\.replace\((".*?")\)/)[1]),base).searchParams.get('message');
 discardFlow=true;const failed=await request('/nodes/1/create-missing-clients',{});assert.equal(links.get('bob').get(1),'');assert.match(message(failed),/ошибок:\s*1/);discardFlow=false;
 await request('/nodes/1/create-missing-clients',{});assert.equal(links.get('bob').get(1),vision);
 // TLS TCP follows the same rule even if the template starts with no users.
 const tlsNode=await request('/nodes',{node_type:'3xui',panel_url:origin,inbound_id:'3',api_auth_mode:modern?'token':'password',api_token:'token',username:'admin',password:'password',country_code:'NL',create_existing_clients_on_node:'1'});
 assert.ok(!new URL(tlsNode.location,base).searchParams.has('error'),tlsNode.location+log);
 assert.equal(links.get('bob').get(3),vision);
 // Per-node removal keeps the user's other attachment.
 const removed=await request('/clients/bulk-remove-node',{client_ids:'2',bulk_node_id:'1',bulk_filter_node_id:'1',bulk_confirmation:'CONFIRMED'});
 assert.equal(removed.status,200,removed.location+log);
 assert.equal(links.get('bob').has(1),false);assert.equal(links.get('bob').get(3),vision,'other remote inbound remains');
 const writesBefore=writes.length;
 assert.equal((await request('/nodes/1/create-missing-clients',{_csrf:'invalid'})).status,403);assert.equal(writes.length,writesBefore);
 const charlie=users.get('charlie');charlie.id=uuid(99);links.get('charlie').set(1,'');
 const conflict=await request('/nodes/1/create-missing-clients',{});
 assert.match(message(conflict),/конфликтов UUID:\s*1/);assert.equal(links.get('charlie').get(1),'','conflicting identity is not repaired or overwritten');
});

