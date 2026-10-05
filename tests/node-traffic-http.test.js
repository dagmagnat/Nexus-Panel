'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {fork}=require('node:child_process');
const Database=require('better-sqlite3'),{encrypt}=require('../lib_crypto');
test('real HTTP: scoped reporting, individual/bulk/all reset, CSRF and viewer protection',{timeout:60000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-node-traffic-')),secret='node-traffic-http-secret-'.repeat(3),GB=1024**3,today=new Date().toISOString().slice(0,10);
  const physical=['10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002'],squads=['30000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000002'];
  const users=[17,18].map((id,i)=>({id,uuid:`20000000-0000-4000-8000-0000000000${id}`,vlessUuid:`40000000-0000-4000-8000-00000000000${i+1}`,username:'user'+(i+1),activeInternalSquads:[...squads],status:'ACTIVE',trafficLimitBytes:0,expireAt:'2099-01-01T00:00:00Z',userTraffic:{usedTrafficBytes:(i?21:32)*GB}}));
  const resets=[],patches=[];
  const origin=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost'),route=url.pathname;
    let response;
    if(route==='/api/nodes')response={nodes:physical.map(uuid=>({uuid}))};
    else if(route==='/api/system/metadata')response={version:'3.3.0'};
    else if(route==='/api/users' && req.method==='GET')response={users,total:2};
    else if(route==='/api/users' && req.method==='PATCH'){
      let body='';for await(const chunk of req)body+=chunk;const p=JSON.parse(body);const u=users.find(u=>u.uuid===p.uuid||u.id===p.id);assert.ok(u);Object.assign(u,p);patches.push(p);response=u;
    }else if(route.includes('/accessible-nodes')){const i=squads.findIndex(id=>route.includes(id));response={accessibleNodes:[{uuid:physical[i]}]};}
    else if(route.includes('/api/bandwidth-stats/users/')){
      const i=Number(route.split('/').pop())===17?0:1;response={categories:[today],series:physical.map((uuid,j)=>({uuid,data:[(j?(i?1:2):(i?20:30))*GB]}))};
    }else if(route.includes('/actions/reset-traffic')){const u=users.find(u=>route.includes(u.uuid));u.userTraffic.usedTrafficBytes=0;resets.push(u.id);response=u;}
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
  async function request(route,body,{raw=false}={}){
    const headers={cookie};let encoded;
    if(body){encoded=new URLSearchParams();for(const [key,value]of Object.entries(body))for(const item of Array.isArray(value)?value:[value])encoded.append(key,item);if(!raw){encoded.set('_csrf',csrf);encoded.set('_workspace','main');}headers['content-type']='application/x-www-form-urlencoded';}
    const r=await fetch(base+route,{method:body?'POST':'GET',headers,body:encoded?.toString(),redirect:'manual'});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const text=await r.text();csrf=text.match(/name="csrf-token" content="([^"]+)"/)?.[1]||csrf;return{status:r.status,text,location:r.headers.get('location')};
  }
  assert.equal((await request('/node-traffic')).status,302);await request('/login');assert.equal((await request('/login',{username:'owner',password:'test-owner-password'})).status,302);
  assert.equal((await request('/node-traffic')).status,200,log);
  db=new Database(path.join(dir,'app.db'));db.pragma('busy_timeout=5000');
  for(let i=0;i<2;i++){
    db.prepare('INSERT INTO nodes(id,name,node_type,panel_url,username,password_enc,api_auth_mode,api_token_enc,remnawave_internal_squad_uuid,remnawave_node_uuid,inbound_id) VALUES(?,?,?,?,?,?,?,?,?,?,1)').run(i+1,i?'Финляндия':'Германия','remnawave','http://127.0.0.1:'+origin.address().port,'','', 'token',encrypt('synthetic-token',secret),squads[i],physical[i]);
    const u=users[i];db.prepare('INSERT INTO clients(id,login,display_name,uuid,sub_slug) VALUES(?,?,?,?,?)').run(i+1,u.username,u.username,u.vlessUuid,'synthetic-'+i);
  }
  for(const c of [1,2])for(const n of [1,2])db.prepare('INSERT INTO client_nodes(client_id,node_id,remote_email,remote_uuid,traffic_gb) VALUES(?,?,?,?,?)').run(c,n,users[c-1].username,users[c-1].uuid,n===1&&c===1?5:50);
  let r=await request('/node-traffic/data.json?refresh=1&from='+today+'&to='+today);assert.equal(r.status,200,r.text);let data=JSON.parse(r.text);assert.deepEqual(data.errors,[],log);assert.equal(data.nodes[0].clients.find(c=>c.id===1).used_bytes,30*GB);assert.equal(data.nodes[1].clients.find(c=>c.id===1).used_bytes,2*GB);assert.doesNotMatch(r.text,/synthetic-token|api_token_enc|password_enc/);
  assert.deepEqual(users[0].activeInternalSquads,[squads[1]]);assert.equal(patches[0].trafficLimitBytes,0);
  assert.equal((await request('/clients/traffic/reset-selected',{client_ids:[1],reset_node_id:1},{raw:true})).status,403);
  r=await request('/clients/1/traffic/reset',{node_ids:[1]});assert.equal(r.status,302,r.text);assert.ok(!r.location.includes('error='),r.location);assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE client_id=1 AND node_id=1').get().used_bytes,0);assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE client_id=1 AND node_id=2').get().used_bytes,2*GB);assert.deepEqual(resets,[]);assert.ok(users[0].activeInternalSquads.includes(squads[0]));
  const outcome=text=>new URL(text.match(/location.replace\("([^"]+)"/)[1],'http://localhost').searchParams.get('message');
  r=await request('/clients/traffic/reset-selected',{client_ids:[1,1],reset_node_id:2});assert.equal(r.status,200,r.text);assert.match(outcome(r.text),/Сброшено счётчиков: 1 из 1/);assert.equal(db.prepare('SELECT used_bytes FROM client_nodes WHERE client_id=2 AND node_id=2').get().used_bytes,GB);assert.deepEqual(resets,[]);
  r=await request('/clients/traffic/reset-selected',{client_ids:[1],reset_node_id:'all'});assert.match(outcome(r.text),/Сброшено счётчиков: 2 из 2/);assert.deepEqual(resets,[17]);
  data=JSON.parse((await request('/node-traffic/data.json?from='+today+'&to='+today)).text);assert.equal(data.nodes[0].totalBytes,50*GB);assert.equal(data.nodes[1].totalBytes,3*GB);
  assert.equal((await request('/node-traffic/data.json?from=2026-02-30')).status,400);
  assert.equal((await request('/clients')).status,200,log);
  r=await request('/access/users',{username:'viewer',password:'viewer-test-password',workspace_id:'main',permissions:['clients.read']});assert.equal(r.status,302,r.text);cookie='';csrf='';await request('/login');await request('/login',{username:'viewer',password:'viewer-test-password'});
  assert.equal((await request('/node-traffic')).status,200);assert.equal((await request('/node-traffic/data.json')).status,200);assert.equal((await request('/clients/traffic/reset-selected',{client_ids:[1],reset_node_id:1})).status,403);assert.equal((await request('/clients/1/traffic/reset',{node_ids:[1]})).status,403);
});
