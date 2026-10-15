'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const Database = require('better-sqlite3');
const { encrypt } = require('../lib_crypto');
const root = path.resolve(__dirname,'..'), secret='support-test-0123456789abcdef0123456789abcdef';
const DAY=86400000;

async function listen(server) {
  server.listen(0,'127.0.0.1'); await once(server,'listening'); return server.address().port;
}
async function startApp(dir) {
  const reservation=http.createServer(); const port=await listen(reservation);
  await new Promise(resolve=>reservation.close(resolve));
  const child=spawn(process.execPath,['app.js'],{cwd:root,env:{...process.env,NODE_ENV:'development',PORT:String(port),DATA_DIR:dir,
    APP_SECRET:secret,SESSION_SECRET:secret,ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'test-password-strong',PANEL_ACCESS_KEY:'',
    PANEL_PUBLIC_URL:`http://127.0.0.1:${port}`,SUB_PUBLIC_URL:`http://127.0.0.1:${port}`,BASE_URL:`http://127.0.0.1:${port}`,
    SESSION_SECURE:'0',TRUST_PROXY:'0'},stdio:['ignore','pipe','pipe']});
  let log='';
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill(); reject(Error(log));},15000);
    const collect=b=>{log+=b; if(log.includes(`started on :${port}`)){clearTimeout(timer);resolve();}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.once('exit',code=>{clearTimeout(timer);reject(Error(`${code}: ${log}`));});
  });
  return {child,port,log:()=>log};
}
async function stop(app) { if(app && app.child.exitCode===null){app.child.kill();await once(app.child,'exit');} }
async function waitFor(fn) {
  for(let i=0;i<150;i++){const value=fn();if(value)return value;await new Promise(r=>setTimeout(r,30));}
  throw Error('Background service sync timed out');
}

for (const [modern,ageDays] of [[true,1],[false,1],[true,30],[false,30]]) test(`same-panel support lifecycle over HTTP (${modern?'global v3':'legacy inbound API'}, expired ${ageDays}d)`,{timeout:60000},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-support-'));
  const remote=new Map(), mutations=[];
  const paid={id:'00000000-0000-4000-8000-000000000011',email:'paid-user',subId:'paid-sub',enable:false,expiryTime:Date.now()-ageDays*DAY,totalGB:5*1024**3,inboundIds:[1]};
  remote.set(paid.email,structuredClone(paid));
  const inbound=id=>({id,port:id===1?1443:2443,protocol:'vless',enable:true,remark:id===1?'Paid':'Telegram',
    settings:JSON.stringify({clients:[...remote.values()].filter(c=>c.inboundIds.includes(id)).map(c=>({...c}))}),
    streamSettings:JSON.stringify({network:'raw',security:'none'}),sniffing:'{}'});
  const mock=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');
    const ok=obj=>res.end(JSON.stringify({success:true,obj}));
    const no=()=>{res.statusCode=404;res.end(JSON.stringify({success:false,msg:'endpoint not found'}));};
    const url=new URL(req.url,'http://local'), p=decodeURIComponent(url.pathname);
    if(req.method==='GET'){
      if(p==='/panel/api/server/status')return ok({version:modern?'3.4.0':'2.5.8'});
      if(p==='/panel/api/inbounds/list')return ok([inbound(1),inbound(2)]);
      if(p.startsWith('/panel/api/inbounds/get/'))return ok(inbound(Number(p.split('/').at(-1))));
      if(modern && p==='/panel/api/clients/list')return ok([...remote.values()].map(c=>({client:{...c,uuid:c.id},inboundIds:c.inboundIds})));
      if(modern && p.startsWith('/panel/api/clients/get/')){
        const c=remote.get(p.split('/').at(-1));if(c)return ok({client:{...c,uuid:c.id},inboundIds:c.inboundIds});
      }
      return no();
    }
    const chunks=[];for await(const b of req)chunks.push(b);
    const raw=Buffer.concat(chunks).toString();
    const body=(req.headers['content-type']||'').includes('json')?JSON.parse(raw||'{}'):Object.fromEntries(new URLSearchParams(raw));
    if(p==='/login'){res.setHeader('Set-Cookie','session=test; Path=/');return ok({});}
    if(modern && p==='/panel/api/clients/add'){
      const c={...body.client,id:body.client.uuid||body.client.id,inboundIds:body.inboundIds};
      if(remote.has(c.email)){res.statusCode=409;return res.end(JSON.stringify({success:false,msg:'duplicate'}));}
      remote.set(c.email,c);mutations.push({p,body});return ok({});
    }
    if(modern && p.startsWith('/panel/api/clients/update/')){
      const old=remote.get(p.split('/').at(-1));assert.ok(old);
      remote.set(old.email,{...old,...body,id:body.uuid||body.id||old.id,inboundIds:old.inboundIds});mutations.push({p,body});return ok({});
    }
    if(!modern && (p==='/panel/api/inbounds/addClient'||p.startsWith('/panel/api/inbounds/updateClient/'))){
      const c=JSON.parse(body.settings).clients[0];remote.set(c.email,{...c,inboundIds:[Number(body.id)]});mutations.push({p,body:c});return ok({});
    }
    return no();
  });
  const remotePort=await listen(mock);let app,db;
  t.after(async()=>{await stop(app);db?.close();await new Promise(r=>mock.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  app=await startApp(dir);
  db=new Database(path.join(dir,'app.db'));
  db.prepare(`INSERT INTO nodes(id,name,node_type,panel_url,panel_path,api_auth_mode,api_token_enc,username,password_enc,inbound_id,enabled,last_status,country_code,country_name_ru)
    VALUES(1,'Finland','3xui',?,'',?,?,?, ?,1,1,'online','FI','Финляндия')`)
    .run(`http://127.0.0.1:${remotePort}`,modern?'token':'password',encrypt('token',secret),'admin',encrypt('password',secret));
  db.prepare(`INSERT INTO clients(id,display_name,login,uuid,sub_slug,expiry_time,enabled,traffic_gb,limit_ip) VALUES(1,'Paid',?,?,?,?,1,5,2)`)
    .run(paid.email,paid.id,'local-sub',paid.expiryTime);
  db.prepare(`INSERT INTO client_nodes(client_id,node_id,remote_uuid,remote_email,enabled,traffic_gb) VALUES(1,1,?,?,1,5)`).run(paid.id,paid.email);
  const cookies=new Map();
  async function request(route,options={}){
    const headers=new Headers(options.headers||{});headers.set('X-Nexus-Workspace','main');
    if(cookies.size)headers.set('Cookie',[...cookies].map(([k,v])=>`${k}=${v}`).join('; '));
    const r=await fetch(`http://127.0.0.1:${app.port}${route}`,{...options,headers,redirect:'manual'});
    for(const value of r.headers.getSetCookie()){const pair=value.split(';')[0],i=pair.indexOf('=');cookies.set(pair.slice(0,i),pair.slice(i+1));}return r;
  }
  function csrf(html){const m=html.match(/name="csrf-token" content="([^"]+)"/);assert.ok(m);return m[1];}
  const loginToken=csrf(await(await request('/login')).text());
  let r=await request('/login',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:loginToken,username:'admin',password:'test-password-strong'})});
  assert.equal(r.headers.get('location'),'/dashboard');
  const token=csrf(await(await request('/nodes?tab=add')).text());
  const form={_csrf:token,node_type:'3xui',panel_url:`http://127.0.0.1:${remotePort}`,panel_path:'',api_auth_mode:modern?'token':'password',api_token:'token',username:'admin',password:'password',country_code:'FI',label_suffix:'Telegram для связи',inbound_id:'2',expired_support:'1'};
  r=await request('/nodes',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form)});
  assert.match(new URL(r.headers.get('location'),'http://local').searchParams.get('message')||'',/Узел добавлен/,app.log());
  const serviceNode=db.prepare('SELECT * FROM nodes WHERE id!=1').get();assert.ok(serviceNode);
  const s=await waitFor(()=>db.prepare('SELECT * FROM client_nodes WHERE node_id=?').get(serviceNode.id));
  assert.notEqual(s.remote_uuid,paid.id);assert.notEqual(s.remote_email,paid.email);
  if(ageDays>7){
    await waitFor(()=>remote.get(s.remote_email)?.enable===false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM client_support_sync WHERE error!=?').get('').n,0,'zero sync errors does not imply eligibility');
    assert.match(await(await request('/clients')).text(),/Служебный срок закончился/);
    for(const route of ['/sub/local-sub','/json/local-sub?download=1']){
      const absent=await(await request(route)).text();
      assert.ok(!absent.includes(s.remote_uuid),'finite window ended: service must be absent before changing policy');
    }
    // Save through the real settings handler, not a direct DB override.
    const change=await request('/settings/happ-control',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:token,subscription_expired_grace_days:'0',subscription_expired_grace_node_ids:String(serviceNode.id),subscription_expired_notice_enabled:'1',subscription_userinfo_header:'1'})});
    assert.equal(change.status,302);
    assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='subscription_expired_grace_days'").get().value,'0');
  }
  await waitFor(()=>remote.get(s.remote_email)?.enable===true);
  assert.match(await(await request('/clients')).text(),/Служебный доступ разрешён/);
  for(const key of Object.keys(paid))assert.deepEqual(remote.get(paid.email)[key],paid[key],`service activation must preserve paid ${key}`);
  assert.deepEqual(remote.get(s.remote_email).inboundIds,[2]);
  assert.equal(remote.get(s.remote_email).expiryTime,ageDays>7?0:paid.expiryTime+7*DAY);
  assert.equal(remote.get(s.remote_email).totalGB,0);
  const backup=await(await request('/backup/download')).json();
  assert.equal(backup.data.client_support_identities.length,1);
  assert.equal(backup.data.client_support_identities[0].uuid,s.remote_uuid);
  const sub=await(await request('/sub/local-sub')).text();
  const decoded=sub.includes('://')?sub:Buffer.from(sub,'base64').toString();
  assert.ok(decoded.includes(s.remote_uuid),decoded);assert.ok(!decoded.includes(paid.id),decoded);assert.ok(decoded.includes(':2443'),decoded);
  const jsonResponse=await request('/json/local-sub?download=1');
  if(ageDays>7){
    assert.match(jsonResponse.headers.get('subscription-userinfo')||'',/upload=/);
    assert.doesNotMatch(jsonResponse.headers.get('subscription-userinfo')||'',/expire=|total=/);
  }
  const json=await jsonResponse.text();
  assert.ok(json.includes(s.remote_uuid),json);assert.ok(!json.includes(paid.id),json);
  const configs=JSON.parse(json);
  assert.equal(configs.length,2,'notice followed by the real service config, no ordinary regions');
  assert.ok(configs[0].outbounds.some(o=>o.protocol==='vless' && o.settings?.vnext?.[0]?.port===1));
  assert.ok(configs[1].outbounds.some(o=>o.protocol==='vless' && o.settings?.vnext?.[0]?.port===2443));
  db.prepare('UPDATE client_nodes SET enabled=0 WHERE node_id=?').run(serviceNode.id);
  const repaired=await(await request('/json/local-sub?download=1')).text();
  assert.ok(repaired.includes(s.remote_uuid),'expired refresh repairs a disabled service mapping');
  assert.equal(db.prepare('SELECT enabled FROM client_nodes WHERE node_id=?').get(serviceNode.id).enabled,1);
  const paidAfterExpiry=structuredClone(remote.get(paid.email));
  assert.equal(paidAfterExpiry.enable,false);assert.equal(paidAfterExpiry.totalGB,paid.totalGB);assert.equal(paidAfterExpiry.expiryTime,paid.expiryTime);
  r=await request('/nodes',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...form,inbound_id:'1'})});
  assert.match(new URL(r.headers.get('location'),'http://local').searchParams.get('error')||'',/другой inbound/);
  // Renewal hides/disables service; it never applies service expiry/unlimited to paid identity.
  db.prepare('UPDATE clients SET expiry_time=? WHERE id=1').run(Date.now()+30*DAY);
  // Restart exercises persisted identity and the startup reconciler.
  await stop(app);app=await startApp(dir);
  await waitFor(()=>remote.get(s.remote_email)?.enable===false);
  assert.deepEqual(remote.get(paid.email),paidAfterExpiry);
  assert.equal(db.prepare('SELECT uuid FROM clients WHERE id=1').get().uuid,paid.id);
  assert.equal(db.prepare('SELECT remote_uuid FROM client_nodes WHERE node_id=?').get(serviceNode.id).remote_uuid,s.remote_uuid);
  const renewed=await(await request('/json/local-sub?download=1')).text();
  assert.ok(!renewed.includes(s.remote_uuid),'service hidden after main renewal');
  if(modern){
    // Manual attachment of the service account to a paid inbound must not
    // turn into a global enable via the new API.
    remote.get(s.remote_email).inboundIds=[2,1];
    db.prepare('UPDATE clients SET expiry_time=? WHERE id=1').run(paid.expiryTime);
    const blocked=await(await request('/sub/local-sub')).text();
    assert.ok(!blocked.includes(s.remote_uuid));
    assert.match(db.prepare('SELECT error FROM client_support_sync WHERE node_id=?').get(serviceNode.id).error,/inbound/);
    assert.equal(remote.get(s.remote_email).enable,false);
    assert.equal(remote.get(paid.email).enable,false);
    remote.get(s.remote_email).inboundIds=[2];
    const recovered=await(await request('/sub/local-sub')).text();
    assert.ok(recovered.includes(s.remote_uuid));
    assert.equal(remote.get(s.remote_email).enable,true);
  }
  assert.ok(mutations.length>=2);
  assert.ok(mutations.filter(m=>String(m.body.email||m.body.client?.email)===paid.email).every(m=>m.body.enable===false && m.body.totalGB===paid.totalGB));
  const restored=await request('/backup/restore',{method:'POST',headers:{'Content-Type':'text/plain','X-CSRF-Token':token},body:JSON.stringify(backup)});
  assert.equal(restored.status,302,await restored.text());
  assert.equal(db.prepare('SELECT uuid FROM client_support_identities WHERE node_id=?').get(serviceNode.id).uuid,s.remote_uuid);
});
