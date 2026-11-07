'use strict';
function resolveBulkClientIds(db,body={}) {
 const scope=String(body.bulk_scope||'selected');
 let sql,args=[];
 if(scope==='all')sql='SELECT id FROM clients ORDER BY id';
 else if(scope==='group'){
  const id=Number(body.scope_group_id);if(!Number.isInteger(id)||id<=0)throw Error('Выберите группу для массового действия.');
  sql='SELECT id FROM clients WHERE group_id=? ORDER BY id';args=[id];
 }else if(scope==='tag'){
  const id=Number(body.scope_tag_id);if(!Number.isInteger(id)||id<=0)throw Error('Выберите метку для массового действия.');
  sql='SELECT c.id FROM clients c JOIN client_tag_assignments t ON t.client_id=c.id WHERE t.tag_id=? ORDER BY c.id';args=[id];
 }else if(scope==='node'){
  const id=Number(body.bulk_node_id);if(!Number.isInteger(id)||id<=0)throw Error('Выберите узел.');
  sql='SELECT DISTINCT c.id FROM clients c JOIN client_nodes m ON m.client_id=c.id WHERE m.node_id=? ORDER BY c.id';args=[id];
 }else if(scope==='selected'){
  const raw=Array.isArray(body.client_ids)?body.client_ids:[body.client_ids];
  return [...new Set(raw.map(Number).filter(id=>Number.isInteger(id)&&id>0))];
 }else throw Error('Неизвестная область массового действия.');
 return db.prepare(sql).all(...args).map(r=>r.id);
}
module.exports={resolveBulkClientIds};

