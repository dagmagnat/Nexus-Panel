'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {createManager}=require('../lib_awg_devices');
function fixture(t) {
 const db=new Database(':memory:');t.after(()=>db.close());
 db.exec("CREATE TABLE clients(id INTEGER PRIMARY KEY,device_limit INTEGER,enabled INTEGER,expiry_time INTEGER,login TEXT,uuid TEXT);CREATE TABLE nodes(id INTEGER PRIMARY KEY,node_type TEXT,enabled INTEGER,panel_url TEXT,inbound_id INTEGER);CREATE TABLE client_nodes(client_id INTEGER,node_id INTEGER,remote_email TEXT,remote_uuid TEXT,used_bytes INTEGER,enabled INTEGER,traffic_gb REAL);CREATE TABLE subscription_devices(id INTEGER PRIMARY KEY AUTOINCREMENT,client_id INTEGER);CREATE TABLE node_inbound_cache(node_id INTEGER,inbound_json TEXT)");
 db.exec("INSERT INTO clients VALUES(1,2,1,0,'alice','original');INSERT INTO nodes VALUES(1,'3xui',1,'https://api.example',42);INSERT INTO client_nodes VALUES(1,1,'alice','original',0,1,0);INSERT INTO subscription_devices(client_id) VALUES(1),(1)");
 const remote=new Map([['alice',{email:'alice',id:'original',enable:true}]]),counters=new Map();
 let enabled=true,failRemove=false,adds=0,limit=0;
 const node=()=>db.prepare('SELECT * FROM nodes').get(),client=()=>db.prepare('SELECT * FROM clients').get();
 const inbound=()=>({id:42,protocol:'amneziawg',port:51820,settings:{server:{publicKey:Buffer.alloc(32,1).toString('base64')},clients:[...remote.values()]}});
 const callbacks={
  db,enabled:()=>enabled,readInbound:async()=>inbound(),
  add:async(n,p,state)=>{adds++;remote.set(p.email,{id:p.uuid,email:p.email,privateKey:'key-'+p.id,allowedIPs:['10.8.0.'+(adds+1)+'/32'],...state});},
  update:async(n,p,state)=>{if(!remote.has(p.email))throw Error('missing');Object.assign(remote.get(p.email),state);},
  remove:async(n,p)=>{if(failRemove)throw Error('API offline');remote.delete(p.email);},
  detachLegacy:async(n,o)=>remote.delete(o.legacy_email),
  restoreLegacy:async(n,o)=>remote.set(o.legacy_email,{email:o.legacy_email,id:o.legacy_uuid,enable:true}),
  usage:async(n,p)=>counters.get(p.email)||{uploadBytes:0,downloadBytes:0},
  policy:(n,c,m)=>({enabled:!!c.enabled&&!!m.enabled&&!!n.enabled&&(!c.expiry_time||c.expiry_time>Date.now()),expiryTimeMs:c.expiry_time,limitBytes:limit}),
  onUsage:(c,n,v)=>db.prepare('UPDATE client_nodes SET used_bytes=? WHERE client_id=? AND node_id=?').run(v.usedBytes,c,n)
 };
 const manager=createManager(callbacks);
 return {db,remote,counters,manager,node,client,callbacks,setFailure:v=>failRemove=v,setLimit:v=>limit=v,getAdds:()=>adds,get enabled(){return enabled},set enabled(v){enabled=v}};
}
test('one AWG peer per admitted device; concurrent refresh retains identity and denies an unregistered third',async t=>{
 const f=fixture(t),{manager}=f;
 const [a,b]=await Promise.all([manager.ensure(f.node(),f.client(),1),manager.ensure(f.node(),f.client(),1)]);
 assert.equal(a.peer.email,b.peer.email);assert.equal(f.getAdds(),1);assert.equal(f.remote.has('alice'),false);
 const c=await manager.ensure(f.node(),f.client(),2);
 assert.notEqual(a.peer.email,c.peer.email);assert.notEqual(a.peer.uuid,c.peer.uuid);
 assert.equal(await manager.ensure(f.node(),f.client(),3),null);
 f.db.prepare('UPDATE clients SET device_limit=1').run();await manager.sweep();
 assert.equal(f.remote.get(a.peer.email).enable,true);assert.equal(f.remote.get(c.peer.email).enable,false);
 f.db.prepare('UPDATE clients SET device_limit=2').run();
 assert.equal((await manager.ensure(f.node(),f.client(),2)).peer.uuid,c.peer.uuid);
});
test('revocation is durable, blocks new issuance on API failure and succeeds after restart',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1);
 f.setFailure(true);f.db.prepare('DELETE FROM subscription_devices WHERE id=1').run();
 assert.equal((await f.manager.flush(1)).length,1);assert.equal(f.remote.has(a.peer.email),true);
 const id=f.db.prepare('INSERT INTO subscription_devices(client_id) VALUES(1)').run().lastInsertRowid;
 await assert.rejects(f.manager.ensure(f.node(),f.client(),id),/отзыв/);
 assert.equal(f.getAdds(),1,'no extra key until former key is revoked');
 f.setFailure(false);
 const restarted=createManager(f.callbacks);
 await restarted.sweep();assert.equal(f.remote.has(a.peer.email),false);
 assert.ok(await restarted.ensure(f.node(),f.client(),id));
});
test('aggregate quota sums devices once, survives remote counter reset and preserves revocation history',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1),b=await f.manager.ensure(f.node(),f.client(),2);
 f.setLimit(100);f.counters.set(a.peer.email,{uploadBytes:10,downloadBytes:50});f.counters.set(b.peer.email,{uploadBytes:0,downloadBytes:40});
 await f.manager.sweep();assert.equal(f.manager.total(1,1).usedBytes,100);
 assert.equal(f.remote.get(a.peer.email).enable,false);assert.equal(f.remote.get(b.peer.email).enable,false);
 f.db.prepare('DELETE FROM subscription_devices WHERE id=2').run();await f.manager.flush(1);
 assert.equal(f.manager.total(1,1).usedBytes,100,'deleting a device never releases consumed traffic');
 f.db.prepare('UPDATE client_nodes SET used_bytes=0').run();
 assert.equal(f.manager.total(1,1).usedBytes,0);await f.manager.sweep();
 assert.equal(f.remote.get(a.peer.email).enable,true);
 f.counters.set(a.peer.email,{uploadBytes:2,downloadBytes:3});await f.manager.sweep();
 assert.equal(f.manager.total(1,1).usedBytes,5);
});
test('client expiry, node/mapping disable and deletion affect only owned peers',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1);
 f.remote.set('unrelated',{email:'unrelated',enable:true});
 f.db.prepare('UPDATE clients SET expiry_time=?').run(Date.now()-1000);await f.manager.sweep();
 assert.equal(f.remote.get(a.peer.email).enable,false);assert.equal(f.remote.get('unrelated').enable,true);
 f.db.prepare('UPDATE clients SET expiry_time=0').run();await f.manager.sweep();assert.equal(f.remote.get(a.peer.email).enable,true);
 f.db.prepare('DELETE FROM client_nodes').run();await f.manager.sweep();
 assert.equal(f.remote.has(a.peer.email),false);assert.equal(f.remote.has('unrelated'),true);
});
test('turning the mode off disables personal keys before restoring the shared inbound; on reuses a device',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1);
 f.enabled=false;await f.manager.sweep();
 assert.equal(f.remote.get(a.peer.email).enable,false);assert.equal(f.remote.has('alice'),true);
 f.enabled=true;const again=await f.manager.ensure(f.node(),f.client(),1);
 assert.equal(again.peer.uuid,a.peer.uuid);assert.equal(f.remote.has('alice'),false);assert.equal(f.remote.get(a.peer.email).enable,true);
});
test('API credential rotation is used for revocation; a new server gets a new owned identity',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1);
 f.db.exec("ALTER TABLE nodes ADD COLUMN api_token_enc TEXT DEFAULT '';UPDATE nodes SET api_token_enc='rotated'");
 let token='';
 const callbacks={...f.callbacks,remove:async(n,p)=>{token=n.api_token_enc;f.remote.delete(p.email);}};
 const manager=createManager(callbacks);
 f.db.prepare('DELETE FROM subscription_devices WHERE id=1').run();await manager.flush(1);
 assert.equal(token,'rotated');assert.equal(f.remote.has(a.peer.email),false);
 const b=await manager.ensure(f.node(),f.client(),2);
 f.db.prepare("UPDATE nodes SET panel_url='https://new-api.example'").run();
 const moved=await manager.ensure(f.node(),f.client(),2);
 assert.notEqual(moved.peer.email,b.peer.email);assert.equal(f.remote.has(b.peer.email),false);
});
test('a server returning duplicate tunnel addresses never produces a second usable config',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1),original=f.callbacks.add;
 const manager=createManager({...f.callbacks,add:async(n,p,s)=>{await original(n,p,s);f.remote.get(p.email).allowedIPs=f.remote.get(a.peer.email).allowedIPs;}});
 await assert.rejects(manager.ensure(f.node(),f.client(),2),/повторяющиеся/);
 assert.equal(f.remote.has(a.peer.email),true);assert.equal([...f.remote.values()].length,1);
});

test('renaming the shared account updates migration and rollback without rotating personal keys',async t=>{
 const f=fixture(t),a=await f.manager.ensure(f.node(),f.client(),1);
 f.db.prepare("UPDATE client_nodes SET remote_email='renamed'").run();
 f.db.prepare("UPDATE clients SET login='renamed'").run();
 f.remote.set('renamed',{email:'renamed',id:'original',enable:true});
 const b=await f.manager.ensure(f.node(),f.client(),1);
 assert.equal(b.peer.uuid,a.peer.uuid);assert.equal(f.remote.has('renamed'),false);
 f.enabled=false;await f.manager.sweep();
 assert.equal(f.remote.has('alice'),false);assert.equal(f.remote.has('renamed'),true);
 assert.equal(f.remote.get(a.peer.email).enable,false);
});
test('the whole quota is divided, not multiplied, and redistribution reduces budgets before increasing others',async t=>{
 const f=fixture(t);f.setLimit(100);
 const totals=[];
 const manager=createManager({...f.callbacks,update:async(n,p,s)=>{await f.callbacks.update(n,p,s);totals.push([...f.remote.values()].filter(v=>v.enable).reduce((sum,v)=>sum+(v.totalGB||0),0));}});
 const a=await manager.ensure(f.node(),f.client(),1);assert.equal(f.remote.get(a.peer.email).totalGB,100);
 const b=await manager.ensure(f.node(),f.client(),2);
 assert.equal(f.remote.get(a.peer.email).totalGB,50);assert.equal(f.remote.get(b.peer.email).totalGB,50);
 f.counters.set(a.peer.email,{uploadBytes:0,downloadBytes:40});await manager.sweep();
 assert.equal(f.remote.get(a.peer.email).totalGB,70);assert.equal(f.remote.get(b.peer.email).totalGB,30);
 assert.ok(totals.every(n=>n<=100),'no update temporarily allocates two full client quotas');
 f.setLimit(41);await manager.sweep();
 assert.ok([...f.remote.values()].every(p=>!p.enable),'rounding a remaining byte to zero must never enable an unlimited peer');
 assert.equal(await manager.ensure(f.node(),f.client(),1),null);
});

