'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {createQuotaCycles,DAY}=require('../lib_quota_cycles'),{resolveBulkClientIds}=require('../lib_bulk_scope');
test('bulk scope resolves all pages, groups, tags and node mappings, with explicit scope validation',()=>{
 const db=new Database(':memory:');
 db.exec('CREATE TABLE clients(id INTEGER PRIMARY KEY,group_id INTEGER);CREATE TABLE client_tag_assignments(client_id INTEGER,tag_id INTEGER);CREATE TABLE client_nodes(client_id INTEGER,node_id INTEGER)');
 const insert=db.prepare('INSERT INTO clients VALUES(?,?)');db.transaction(()=>{for(let i=1;i<=2100;i++)insert.run(i,i%2?7:8)})();
 db.exec('INSERT INTO client_tag_assignments VALUES(2,9),(2001,9);INSERT INTO client_nodes VALUES(2001,3)');
 assert.equal(resolveBulkClientIds(db,{bulk_scope:'all'}).length,2100);
 assert.equal(resolveBulkClientIds(db,{bulk_scope:'group',scope_group_id:7}).length,1050);
 assert.deepEqual(resolveBulkClientIds(db,{bulk_scope:'tag',scope_tag_id:9}),[2,2001]);
 assert.deepEqual(resolveBulkClientIds(db,{bulk_scope:'node',bulk_node_id:3}),[2001]);
 assert.throws(()=>resolveBulkClientIds(db,{bulk_scope:'tag',scope_tag_id:'9 OR 1=1'}));
 assert.throws(()=>resolveBulkClientIds(db,{bulk_scope:'bogus'}));db.close();
});
test('30-day quota renewal is persistent, single-flight, grouped, retryable and does not catch up repeatedly',async()=>{
 const db=new Database(':memory:');let now=1000,enabled=30,calls=0,used=5,fail=false;
 const options={db,clock:()=>now,days:()=>enabled,entries:()=>[{scope:'shared-account',id:1},{scope:'shared-account',id:2}],reset:async group=>{
  calls++;assert.equal(group.length,2);if(fail)throw Error('API offline');used=0;
 }};
 let q=createQuotaCycles(options);await q.tick();assert.equal(calls,0);
 now+=30*DAY-1;await q.tick();assert.equal(used,5);
 now++;fail=true;await q.tick();assert.equal(used,5);assert.equal(db.prepare('SELECT next_at FROM quota_reset_cycles').get().next_at,now);
 q=createQuotaCycles(options);fail=false;await Promise.all([q.tick(),q.tick()]);assert.equal(used,0);assert.equal(calls,2);
 used=8;now+=90*DAY;await q.tick();assert.equal(calls,3,'one reset after downtime');await q.tick();assert.equal(calls,3);
 enabled=0;now+=31*DAY;await q.tick();assert.equal(calls,3);
 enabled=30;q.restart();await q.tick();assert.equal(calls,3,'re-enabling starts a full new period');db.close();
});
test('acknowledged remote reset is not repeated if post-reset synchronization fails',async()=>{
 const db=new Database(':memory:');let now=0,calls=0,fail=true;
 const q=createQuotaCycles({db,days:()=>30,clock:()=>now,entries:()=>[{scope:'one'}],reset:async(group,commit)=>{calls++;commit()},repair:async()=>{if(fail)throw Error('restore API failed')}});
 await q.tick();now=30*DAY;assert.deepEqual(await q.tick(),['restore API failed']);assert.equal(calls,1);
 assert.deepEqual(await q.tick(),['restore API failed']);assert.equal(calls,1);
 fail=false;assert.deepEqual(await q.tick(),[]);assert.equal(calls,1,'retry only restores access, without another reset');db.close();
});

