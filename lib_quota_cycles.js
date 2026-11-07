'use strict';
const DAY=86400000;
function createQuotaCycles({db,days,entries,reset,repair=async()=>{},clock=Date.now}) {
 db.exec("CREATE TABLE IF NOT EXISTS quota_reset_cycles(scope TEXT PRIMARY KEY,next_at INTEGER NOT NULL,last_at INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '')");
 if(!db.prepare('PRAGMA table_info(quota_reset_cycles)').all().some(c=>c.name==='pending_sync'))db.exec('ALTER TABLE quota_reset_cycles ADD COLUMN pending_sync INTEGER NOT NULL DEFAULT 0');
 let pending;
 function restart(){db.prepare("UPDATE quota_reset_cycles SET next_at=?,error=''").run(clock()+30*DAY);}
 async function tick(){
  if(pending)return pending;
  pending=(async()=>{
   const period=Number(days());if(period!==30)return;
   const now=clock(),groups=new Map();
   for(const e of entries()){if(!groups.has(e.scope))groups.set(e.scope,[]);groups.get(e.scope).push(e);}
   // Initializing thousands of timers must not fsync a transaction per client.
   const insert=db.prepare('INSERT OR IGNORE INTO quota_reset_cycles(scope,next_at) VALUES(?,?)');
   db.transaction(()=>{for(const scope of groups.keys())insert.run(scope,now+period*DAY)})();
   const rows=new Map(db.prepare('SELECT * FROM quota_reset_cycles').all().map(r=>[r.scope,r]));
   for(const [scope,group] of groups){
    const row=rows.get(scope);
    if(row.next_at>now&&!row.pending_sync)continue;
    let committed=false;
    const commit=()=>{db.prepare("UPDATE quota_reset_cycles SET next_at=?,last_at=?,error='',pending_sync=1 WHERE scope=?").run(clock()+period*DAY,clock(),scope);committed=true;};
    try{
     if(!row.pending_sync)await reset(group,commit);
     // An acknowledged reset must not be repeated if later re-enabling fails.
     if(!committed&&!row.pending_sync)commit();
     await repair(group);
     db.prepare("UPDATE quota_reset_cycles SET pending_sync=0,error='' WHERE scope=?").run(scope);
    }catch(e){const error=((group[0].label?group[0].label+': ':'')+String(e.message||e)).slice(0,400);db.prepare('UPDATE quota_reset_cycles SET error=? WHERE scope=?').run(error,scope);}
   }
   return db.prepare("SELECT scope,error FROM quota_reset_cycles WHERE error<>''").all().filter(r=>groups.has(r.scope)).map(r=>r.error);
  })().finally(()=>{pending=null});
  return pending;
 }
 return {tick,restart};
}
module.exports={createQuotaCycles,DAY};

