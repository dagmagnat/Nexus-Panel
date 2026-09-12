'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const {createAccess, denyAccess} = require('../lib_access');
const {grantOwner} = require('../access-admin');

test('SSH recovery promotes only explicit existing login, preserves passwords and revokes sessions', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'owner-recovery-'));
  const db = new Database(path.join(root,'app.db'));
  db.exec("CREATE TABLE app_users(id INTEGER PRIMARY KEY,username TEXT,password_hash TEXT); INSERT INTO app_users VALUES(1,'admin','hash-admin'),(2,'actual-owner','hash-owner'),(3,'employee','hash-staff')");
  const access = createAccess({rootDir:root,localDb:db,legacyUsername:'admin'});
  t.after(()=>{access.control.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
  assert.equal(access.allowsRoute(access.user(2),'main','POST','/clients/125/extend'),false);
  await assert.rejects(grantOwner(access.control,root,'missing'),/не найден/);
  const saved = await grantOwner(access.control,root,'actual-owner');
  assert.equal(access.user(2).is_owner,1);
  assert.equal(access.user(2).password_hash,'hash-owner');
  assert.equal(access.user(2).auth_version,2);
  assert.equal(access.sessionUser({session:{userId:2,authVersion:1}}),null);
  assert.equal(access.allowsRoute(access.user(2),'main','POST','/clients/125/extend'),true);
  assert.equal(access.user(3).is_owner,0);
  assert.equal(access.user(1).is_owner,1);
  const before = new Database(saved.backup,{readonly:true});
  assert.equal(before.prepare('SELECT is_owner FROM users WHERE id=2').get().is_owner,0); before.close();
  assert.equal((await grantOwner(access.control,root,'actual-owner')).unchanged,true);
  access.control.prepare('UPDATE users SET disabled=1 WHERE id=3').run();
  await assert.rejects(grantOwner(access.control,root,'employee'),/заблокирован/);
});

test('denials carry a machine-readable marker and readable HTML or JSON', () => {
  for (const accept of ['text/html','application/json']) {
    const headers={};let status,body;
    const res={setHeader(k,v){headers[k]=v;},status(n){status=n;return this;},send(v){body=v;},json(v){body=v;}};
    denyAccess({get:k=>k==='Accept'?accept:undefined},res);
    assert.equal(status,403);assert.equal(headers['X-Nexus-Access-Denied'],'1');
    if (accept==='application/json') assert.equal(body.code,'ACCESS_DENIED');
    else {assert.match(body,/Недостаточно прав/);assert.match(body,/font-size:26px/);}
  }
});
