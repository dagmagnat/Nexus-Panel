'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { appendRealityHint, mlkemFormValue } = require('../lib_reality_compat');
const { createInboundRevalidator } = require('../lib_inbound_revalidation');
test('REALITY link hint honors node/source opt-out and never leaks into TLS links', () => {
  const q=new URLSearchParams('security=reality');
  appendRealityHint(q,{}); assert.equal(q.get('support-x25519mlkem768'),'true');
  appendRealityHint(q,{reality_mlkem_hint:0});assert.equal(q.has('support-x25519mlkem768'),false);
  appendRealityHint(q,{}, {settings:{supportX25519Mlkem768:false}});assert.equal(q.has('support-x25519mlkem768'),false);
  appendRealityHint(q,{}, {supportX25519Mlkem768:'1'});assert.equal(q.get('support-x25519mlkem768'),'true');
  appendRealityHint(q,{reality_mlkem_hint:0},{supportX25519Mlkem768:true});assert.equal(q.has('support-x25519mlkem768'),false);
  q.set('security','tls');appendRealityHint(q,{});assert.equal(q.has('support-x25519mlkem768'),false);
  assert.equal(mlkemFormValue({}, {reality_mlkem_hint:0}),0);
  assert.equal(mlkemFormValue({reality_compat_controls:'1'},{}),0);
  assert.equal(mlkemFormValue({reality_compat_controls:'1',reality_mlkem_hint:'1'},{}),1);
});
test('inbound refresh is TTL/single-flight, changes connection parameters and bounds API fanout', async () => {
  let now=100000,calls=0,release;
  let snapshot={inbound:{port:8443},updatedAt:0};
  const read=createInboundRevalidator({now:()=>now,read:()=>snapshot,maxConcurrent:1,load:async()=>{calls++;await new Promise(r=>release=r);snapshot={inbound:{port:10443},updatedAt:now};return snapshot.inbound;}});
  const a=read({id:1}),b=read({id:1});await new Promise(r=>setImmediate(r));assert.equal(calls,1);
  assert.equal((await read({id:2})).port,8443);
  release();assert.deepEqual(await a,await b);assert.equal((await a).port,10443);
  assert.equal((await read({id:1})).port,10443);assert.equal(calls,1);
});
test('transient outages retain last parameters with backoff; deleted/mismatched inbound is not served', async () => {
  let calls=0;
  const config={read:()=>({inbound:{port:8443},updatedAt:0}),now:()=>100000};
  const fallback=createInboundRevalidator({...config,load:async()=>{calls++;throw Error('offline');}});
  assert.equal((await fallback({id:1})).port,8443);await fallback({id:1});assert.equal(calls,1);
  for(const code of ['INBOUND_NOT_FOUND','INBOUND_ID_MISMATCH','NODE_CONNECTION_CHANGED']) {
    const fail=createInboundRevalidator({...config,load:async()=>{throw Object.assign(Error('invalid'),{code});}});
    await assert.rejects(fail({id:1}),{code});
  }
});
