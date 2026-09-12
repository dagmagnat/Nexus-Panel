'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ejs=require('ejs');
const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
test('new forms use dedicated grids and preserve their existing submit endpoints',()=>{
  for (const name of ['access','preferences']) {
    const source=read(`views/${name}.ejs`);
    assert.doesNotThrow(()=>ejs.compile(source));
    assert.match(source,new RegExp(`activePage: '${name}'`));
    assert.doesNotMatch(source,/class="form-grid"/);
    assert.match(source,/management-form-actions/);
  }
  assert.match(read('views/access.ejs'),/action="\/access\/users"/);
  assert.match(read('views/preferences.ejs'),/action="\/preferences\/defaults"/);
});
test('sticky tabs follow actual visible header height on desktop and mobile',()=>{
  const desktop={height:114,display:'flex'},mobile={height:58,display:'none'};
  for(const bar of [desktop,mobile])bar.getBoundingClientRect=()=>({height:bar.height});
  let resize,offset;const observed=[];
  class Observer {constructor(cb){resize=cb;}observe(bar){observed.push(bar);}}
  const document={body:{classList:{contains:()=>true}},querySelectorAll:()=>[desktop,mobile],documentElement:{style:{setProperty(k,v){assert.equal(k,'--settings-header-offset');offset=v;}}}};
  vm.runInNewContext(read('public/js/management-layout.js'),{document,window:{ResizeObserver:Observer,addEventListener(){}},ResizeObserver:Observer,getComputedStyle:bar=>bar});
  assert.equal(offset,'114px');assert.equal(observed.length,2);
  desktop.height=142.4;resize();assert.equal(offset,'143px');
  desktop.display='none';mobile.display='flex';resize();assert.equal(offset,'58px');
});
