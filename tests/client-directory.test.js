'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {initClientDirectory,queryClientDirectory,directoryOptions}=require('../lib_client_directory');
function fixture(t) {
  const db=new Database(':memory:');t.after(()=>db.close());
  db.exec(`CREATE TABLE clients(id INTEGER PRIMARY KEY,login TEXT,display_name TEXT,comment TEXT,uuid TEXT,sub_slug TEXT,group_id INTEGER,enabled INTEGER DEFAULT 1,expiry_time INTEGER DEFAULT 0,start_on_activation INTEGER DEFAULT 0,activation_started_at INTEGER DEFAULT 0,duration_days INTEGER DEFAULT 0,traffic_gb REAL DEFAULT 0);
    CREATE TABLE client_groups(id INTEGER PRIMARY KEY,name TEXT,color TEXT); CREATE TABLE client_tags(id INTEGER PRIMARY KEY,name TEXT,color TEXT);
    CREATE TABLE client_tag_assignments(client_id INTEGER,tag_id INTEGER);
    CREATE TABLE subscription_devices(id INTEGER PRIMARY KEY,client_id INTEGER,last_seen_at TEXT,os_name TEXT,device_model TEXT,app_name TEXT,hwid_hint TEXT);
    CREATE TABLE nodes(id INTEGER PRIMARY KEY,enabled INTEGER DEFAULT 1);
    CREATE TABLE client_nodes(id INTEGER PRIMARY KEY,client_id INTEGER,node_id INTEGER,remote_sub_url TEXT,traffic_gb REAL DEFAULT 0,used_bytes INTEGER DEFAULT 0,enabled INTEGER DEFAULT 1);
    INSERT INTO client_groups VALUES(1,'Основная','#123456'); INSERT INTO client_tags VALUES(1,'Учёба','#123456'); INSERT INTO nodes(id) VALUES(1),(2);`);
  const insert=db.prepare("INSERT INTO clients(id,login,display_name,comment,uuid,sub_slug) VALUES(?,?,?,'',?,?)");
  db.transaction(()=>{for(let id=1;id<=235;id++)insert.run(id,'user'+id,'Пользователь '+id,'uuid-'+id,'sub-'+id);})();
  initClientDirectory(db);return db;
}
test('20 by default, exact choices and all; pages clamp and never overlap',t=>{
  const db=fixture(t),a=queryClientDirectory(db),b=queryClientDirectory(db,{page:2});
  assert.equal(a.clients.length,20);assert.equal(a.pagination.total,235);assert.equal(a.pagination.pages,12);assert.equal(a.clients[0].id,235);assert.equal(b.clients[0].id,215);
  assert.ok(!a.clients.some(c=>b.clients.some(d=>d.id===c.id)));
  for(const size of [20,50,100,150,200])assert.equal(queryClientDirectory(db,{page_size:size}).clients.length,size);
  assert.equal(queryClientDirectory(db,{page_size:'all',page:90}).clients.length,235);
  const last=queryClientDirectory(db,{page:999});assert.equal(last.pagination.page,12);assert.equal(last.clients.length,15);
  for(const bad of [0,-1,'NaN','Infinity','20 OR 1=1'])assert.equal(directoryOptions({page_size:bad,page:bad}).size,20);
});
test('whole-directory Cyrillic/ё and literal wildcard search, device and tag search',t=>{
  const db=fixture(t);db.exec("UPDATE clients SET display_name='Алёна 100%_\\',group_id=1 WHERE id=1; INSERT INTO client_tag_assignments VALUES(2,1); INSERT INTO subscription_devices VALUES(1,3,'2026-01-01','Android','Pixel','Happ','hint');");
  assert.deepEqual(queryClientDirectory(db,{q:'алена'}).clients.map(c=>c.id),[1]);
  assert.deepEqual(queryClientDirectory(db,{q:'100%_\\'}).clients.map(c=>c.id),[1]);
  assert.deepEqual(queryClientDirectory(db,{q:'учеба'}).clients.map(c=>c.id),[2]);
  assert.deepEqual(queryClientDirectory(db,{q:'pixel'}).clients.map(c=>c.id),[3]);
  assert.deepEqual(queryClientDirectory(db,{q:'основная'}).clients.map(c=>c.id),[1]);
  assert.equal(queryClientDirectory(db,{q:"' OR 1=1 --"}).pagination.total,0);
});
test('group/tag/node/status and traffic filters run before pagination',t=>{
  const db=fixture(t),GB=1024**3,now=Date.now();db.exec('UPDATE clients SET group_id=1 WHERE id<=51; INSERT INTO client_tag_assignments SELECT id,1 FROM clients WHERE id<=31');
  db.prepare('UPDATE clients SET expiry_time=? WHERE id=1').run(now-1);db.prepare('UPDATE clients SET expiry_time=? WHERE id=2').run(now+86400000);db.exec('UPDATE clients SET enabled=0 WHERE id=3');
  const add=db.prepare('INSERT INTO client_nodes(client_id,node_id,traffic_gb,used_bytes) VALUES(?,?,?,?)');
  add.run(1,1,5,5*GB);add.run(1,2,50,2*GB);add.run(2,1,50,10*GB);
  assert.equal(queryClientDirectory(db,{group_id:1}).pagination.total,51);assert.equal(queryClientDirectory(db,{tag_id:1}).pagination.total,31);
  assert.equal(queryClientDirectory(db,{group_id:'none'}).pagination.total,184);assert.equal(queryClientDirectory(db,{tag_id:'none'}).pagination.total,204);
  assert.equal(queryClientDirectory(db,{node_id:1}).pagination.total,2);
  assert.deepEqual(queryClientDirectory(db,{sort:'traffic-desc',node_id:1}).clients.map(c=>c.id),[2,1]);
  assert.deepEqual(queryClientDirectory(db,{sort:'exhausted',node_id:1}).clients.map(c=>c.id),[1]);
  assert.equal(queryClientDirectory(db,{sort:'exhausted',node_id:2}).pagination.total,0);
  assert.deepEqual(queryClientDirectory(db,{sort:'expired'},{now}).clients.map(c=>c.id),[1]);
  assert.deepEqual(queryClientDirectory(db,{sort:'expiring'},{now}).clients.map(c=>c.id),[2]);
  assert.equal(queryClientDirectory(db,{sort:'online'},{onlineIds:[1,2]}).pagination.total,2);
  assert.equal(queryClientDirectory(db,{sort:'online'}).pagination.total,0);
  assert.equal(queryClientDirectory(db).stats.total,235);
});
test('empty directory has one valid page and zero range',t=>{
  const db=fixture(t);db.exec('DELETE FROM clients');const p=queryClientDirectory(db).pagination;assert.deepEqual(p,{page:1,pages:1,size:20,total:0,from:0,to:0});
});
