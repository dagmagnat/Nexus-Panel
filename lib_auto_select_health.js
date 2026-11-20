'use strict';
// Every tier is health-gated. No raw outbound is an unconditional fallback.
function healthPolicy(config,{id,preferredTags=[],normalTags=[],emergencyTags=[],unavailableTag}) {
 const balancers=[],reentryRules=[];
 function tier(name,tags,fallback){
  if(!tags.length)return null;
  const tag='auto-'+id+'-'+name+'-balancer';
  balancers.push({tag,selector:[...new Set(tags)],strategy:{type:'leastPing'},fallbackTag:fallback});
  return tag;
 }
 function reentry(name,balancerTag){
  const inboundTag='auto-'+id+'-'+name+'-reentry',tag='auto-'+id+'-'+name+'-loopback';
  config.outbounds.push({tag,protocol:'loopback',settings:{inboundTag}});
  reentryRules.push({type:'field',inboundTag:[inboundTag],balancerTag});return tag;
 }
 let fallback=unavailableTag,root=null;
 const emergency=tier('emergency',emergencyTags,fallback);
 if(emergency){root=emergency;fallback=reentry('emergency',emergency);}
 const main=tier('main',normalTags,fallback);
 if(main){root=main;fallback=reentry('main',main);}
 const preferred=tier('preferred',preferredTags,fallback);
 if(preferred)root=preferred;
 return {balancers,reentryRules,routeBalancerTag:root};
}
module.exports={healthPolicy};
