'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {applyDeviceRefreshPolicy:apply,deviceRefreshPolicy}=require('../lib_device_refresh');
function fixture(t){const db=new Database(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE subscription_devices(id INTEGER PRIMARY KEY,client_id INTEGER,hwid_hash TEXT,last_seen_at TEXT);INSERT INTO subscription_devices VALUES(1,1,'old','2020-01-01'),(2,1,'recent',CURRENT_TIMESTAMP),(3,2,'other','2020-01-01')`);return db;}
test('manual is the safe default; missing HWID and read-only preview never reset',t=>{
  const db=fixture(t);assert.equal(deviceRefreshPolicy('unknown',NaN).mode,'manual');assert.equal(deviceRefreshPolicy('',0).staleHours,72);
  assert.equal(apply(db,1,'new',{}),0);assert.equal(apply(db,1,'',{mode:'reset-on-refresh'}),0);assert.equal(apply(db,1,'new',{mode:'reset-on-refresh',allowNew:false}),0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscription_devices').get().n,3);
});
test('stale replacement frees exactly one slot only for new HWID and full enforced limit',t=>{
  const db=fixture(t),options={mode:'replace-stale',limit:2,enforced:true,staleHours:72};
  assert.equal(apply(db,1,'recent',options),0);assert.equal(apply(db,1,'new',{...options,limit:3}),0);assert.equal(apply(db,1,'new',{...options,enforced:false}),0);
  assert.equal(apply(db,1,'new',options),1);assert.ok(!db.prepare('SELECT id FROM subscription_devices WHERE id=1').get());assert.ok(db.prepare('SELECT id FROM subscription_devices WHERE id=2').get());assert.ok(db.prepare('SELECT id FROM subscription_devices WHERE id=3').get());
});
test('recent slots and legacy excess rows are not silently evicted',t=>{
  const db=fixture(t);assert.equal(apply(db,1,'new',{mode:'replace-stale',limit:1,enforced:true}),0);
  db.exec('UPDATE subscription_devices SET last_seen_at=CURRENT_TIMESTAMP WHERE client_id=1');assert.equal(apply(db,1,'new',{mode:'replace-stale',limit:2,enforced:true}),0);
});
test('explicit full reset keeps the requesting HWID and never touches other clients; transaction rollback restores slots',t=>{
  const db=fixture(t);assert.throws(()=>db.transaction(()=>{assert.equal(apply(db,1,'recent',{mode:'reset-on-refresh'}),1);throw Error('insert failed');})());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subscription_devices WHERE client_id=1').get().n,2);
  assert.equal(apply(db,1,'recent',{mode:'reset-on-refresh'}),1);assert.ok(db.prepare('SELECT id FROM subscription_devices WHERE client_id=2').get());assert.equal(apply(db,1,'new',{mode:'reset-on-refresh'}),1);
});
