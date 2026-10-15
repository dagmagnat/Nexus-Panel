'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const Database = require('better-sqlite3');
const source = fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`,'m'));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n}',start)+2);
}
function fixture(t) {
  const db = new Database(':memory:'); t.after(()=>db.close());
  db.exec(`CREATE TABLE nodes(id INTEGER PRIMARY KEY,enabled INTEGER,node_type TEXT);
    INSERT INTO nodes VALUES(1,1,'remnawave'),(2,1,'3xui'),(3,1,'remna'),(4,1,'remnawave_panel');`);
  let config = {enabled:true,mode:'proxy-except',assignmentExplicit:true,modeAssignments:{'proxy-except':[1,2,3,4],'node-selective':[]}};
  const context = vm.createContext({db, NODE_TYPE_3XUI:'3xui',NODE_TYPE_H1CLOUD:'h1cloud',NODE_TYPE_H1CLOUD_3XUI:'h1cloud_3xui',NODE_TYPE_REMNAWAVE:'remnawave',
    getRoutingConfig:()=>config,isClientManagedNode:()=>true,uniqueList:values=>[...new Set(values)]});
  vm.runInContext(['normalizeNodeTypeValue','getNodeType','getRoutingModeAssignments','getRoutingModeForNode','isRoutingEnabledForNode'].map(extract).join('\n'),context);
  return {context,set config(value){config=value;}};
}
test('Remnawave and legacy aliases receive the same assigned JSON routing as 3x-ui',t=>{
  const f=fixture(t);
  for(const id of [1,2,3,4]) assert.equal(f.context.isRoutingEnabledForNode(id),true,`node ${id}`);
});
test('explicit per-node assignment and global off remain authoritative for Remnawave',t=>{
  const f=fixture(t);
  f.config={enabled:true,assignmentExplicit:true,modeAssignments:{'proxy-except':[1],'node-selective':[2]}};
  assert.equal(f.context.isRoutingEnabledForNode(1),true);assert.equal(f.context.getRoutingModeForNode(1),'proxy-except');
  assert.equal(f.context.isRoutingEnabledForNode(3),false);
  f.config={enabled:false,assignmentExplicit:true,modeAssignments:{'node-selective':[1]}};
  assert.equal(f.context.isRoutingEnabledForNode(1),false);
});
test('legacy all-nodes settings and node exclusions also include Remnawave',t=>{
  const f=fixture(t);
  f.config={enabled:true,mode:'node-selective',allNodes:true,assignmentExplicit:false};
  assert.equal(f.context.isRoutingEnabledForNode(1),true);assert.equal(f.context.getRoutingModeForNode(1),'node-selective');
  f.config={enabled:true,mode:'proxy-except',allNodes:false,excludedNodeIds:[1]};
  assert.equal(f.context.isRoutingEnabledForNode(1),false);assert.equal(f.context.isRoutingEnabledForNode(3),true);
});
