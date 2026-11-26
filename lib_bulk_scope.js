'use strict';
function resolveBulkClientIds(db,body={}) {
 const scope=String(body.bulk_scope||'selected');
 let sql,args=[];
 if(scope==='all')sql='SELECT id FROM clients ORDER BY id';
 else if(scope==='group'){
  const id=Number(body.scope_group_id);if(!Number.isInteger(id)||id<=0)throw Error('Выберите группу для массового действия.');
  sql='SELECT id FROM clients WHERE group_id=? ORDER BY id';args=[id];
 }else if(scope==='tag'||scope==='group-tag'){
  const id=Number(body.scope_tag_id);if(!Number.isInteger(id)||id<=0)throw Error('Выберите метку для массового действия.');
  sql='SELECT c.id FROM clients c JOIN client_tag_assignments t ON t.client_id=c.id WHERE t.tag_id=?';args=[id];
  if(scope==='group-tag'){
   const groupId=Number(body.scope_group_id);if(!Number.isInteger(groupId)||groupId<=0)throw Error('Выберите группу для массового действия.');
   sql+=' AND c.group_id=?';args.push(groupId);
  }
  sql+=' ORDER BY c.id';
 }else if(scope==='node'){
  const id=Number(body.bulk_node_id);if(!Number.isInteger(id)||id<=0)throw Error('Выберите узел.');
  sql='SELECT DISTINCT c.id FROM clients c JOIN client_nodes m ON m.client_id=c.id WHERE m.node_id=? ORDER BY c.id';args=[id];
 }else if(scope==='selected'){
  const raw=Array.isArray(body.client_ids)?body.client_ids:[body.client_ids];
  return [...new Set(raw.map(Number).filter(id=>Number.isInteger(id)&&id>0))];
 }else throw Error('Неизвестная область массового действия.');
 return db.prepare(sql).all(...args).map(r=>r.id);
}
function resolveBulkNodes(db, body) {
  if (body.node_scope === 'all') return db.prepare('SELECT * FROM nodes ORDER BY id').all();
  if (body.node_scope !== 'picked') throw Error('Выберите область узлов.');
  const ids = [...new Set([body.node_ids].flat().map(Number))];
  if (!ids.length || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw Error('Отметьте хотя бы один узел.');
  const getNode = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const nodes = ids.map(id => getNode.get(id));
  if (nodes.some(node => !node)) throw Error('Один из выбранных узлов больше не существует.');
  return nodes;
}

module.exports={resolveBulkClientIds, resolveBulkNodes};

