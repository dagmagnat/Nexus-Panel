'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../public/js/security.js'),'utf8');
function setup({allowed=false,login=false}={}) {
  const events={},requests=[],dialogs=[];let submitted=0;
  const location=new URL('https://panel.test/clients');
  class Form {constructor(){this.method='post';this.action='/clients/125/extend';this.isConnected=true;this.fields=[];}querySelector(){return null;}appendChild(f){this.fields.push(f);}submit(){submitted++;}requestSubmit(){submitted++;}}
  const document={activeElement:{focus(){}},querySelector(s){return s.includes('csrf')?{getAttribute:()=> 'csrf'}:login?null:{content:'main'};},addEventListener(k,fn){events[k]=fn;},body:{appendChild(x){dialogs.push(x);}},createElement(tag){
    if(tag!=='dialog')return {};
    const p={textContent:''},button={addEventListener(){}};
    return {style:{},setAttribute(){},addEventListener(){},querySelector:s=>s==='p'?p:button,showModal(){this.open=true;},close(){this.open=false;}};
  }};
  const window={location,fetch:async(url)=>{requests.push(url);return {ok:true,status:200,headers:new Headers({'content-type':'application/json'}),json:async()=>({allowed})};}};
  vm.runInNewContext(source,{document,window,location,HTMLFormElement:Form,Headers,URL,URLSearchParams});
  return {events,requests,dialogs,Form,submitted:()=>submitted};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
test('denied native form stays on page and opens a large modal without submitting',async()=>{
  const s=setup();let prevented=false;
  s.events.submit({target:new s.Form(),preventDefault(){prevented=true;},stopImmediatePropagation(){}});
  await settle();assert.equal(prevented,true);assert.equal(s.submitted(),0);assert.equal(s.dialogs.length,1);assert.equal(s.dialogs[0].open,true);
  assert.match(s.dialogs[0].querySelector('p').textContent,/нет прав/);
});
test('allowed native submit resumes once, programmatic submit is also guarded',async()=>{
  const s=setup({allowed:true});
  new s.Form().submit();await settle();assert.equal(s.submitted(),1);
  const denied=setup();new denied.Form().submit();await settle();assert.equal(denied.submitted(),0);assert.equal(denied.dialogs.length,1);
});
test('login retains native submit and does not ask an authenticated permission endpoint',async()=>{
  const s=setup({login:true});new s.Form().submit();await settle();assert.equal(s.submitted(),1);assert.equal(s.requests.length,0);
});
test('denied link stays on current page; permitted link is replayed',async()=>{
  for(const allowed of [false,true]){
    const s=setup({allowed});let clicked=0;
    const link={href:'https://panel.test/settings',target:'',isConnected:true,getAttribute:()=>'/settings',click(){clicked++;}};
    s.events.click({target:{closest:()=>link},button:0,preventDefault(){},stopImmediatePropagation(){}});
    await settle();assert.equal(clicked,allowed?1:0);assert.equal(s.dialogs.length,allowed?0:1);
  }
});
