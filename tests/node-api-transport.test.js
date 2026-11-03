'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http');
const {apiTransport,apiIpFormValue,normalizeApiIp,apiAddressWarning}=require('../lib_node_api_transport');
const {connectionKey}=require('../lib_inbound_revalidation');
const {permissionFor}=require('../lib_access');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),https=require('node:https'),{spawnSync}=require('node:child_process');
test('API IP is independent, validated, preserved by old forms and included in refresh identity',()=>{
  for(const ip of ['127.0.0.1','2.27.40.95','2001:db8::1'])assert.equal(normalizeApiIp(ip),ip);
  for(const ip of ['a.example','https://1.2.3.4','1.2.3.4:443','0.0.0.0','::'])assert.throws(()=>normalizeApiIp(ip),/IP/);
  assert.equal(apiIpFormValue({}, {api_connect_ip:'127.0.0.1'}),'127.0.0.1');
  assert.equal(apiIpFormValue({api_connect_ip:''},{api_connect_ip:'127.0.0.1'}),'');
  assert.notEqual(connectionKey({id:1,api_connect_ip:'127.0.0.1'}),connectionKey({id:1,api_connect_ip:'127.0.0.2'}));
  assert.equal(permissionFor('POST','/nodes/1/refresh-parameters'),'nodes.manage');
  const tls=apiTransport({panel_url:'https://api.example',api_connect_ip:'127.0.0.1'});
  assert.notEqual(tls.agent.options.rejectUnauthorized,false);assert.equal(tls.redirect,'error');
  assert.throws(()=>apiTransport({panel_url:'https://192.0.2.1',api_connect_ip:'192.0.2.2'}),/не совпадает/);
});
test('real HTTP connection bypasses ambiguous DNS while retaining original Host',async t=>{
  let host='';
  const server=http.createServer((req,res)=>{host=req.headers.host;res.end('correct server');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>server.close(r)));
  const node={panel_url:'http://not-resolvable.example.invalid:'+server.address().port,api_connect_ip:'127.0.0.1'};
  const res=await require('node-fetch')(node.panel_url,apiTransport(node));
  assert.equal(await res.text(),'correct server');
  assert.equal(host,'not-resolvable.example.invalid:'+server.address().port);
});
test('multi-address API is warned; pin and single address are not labelled ambiguous',async()=>{
  const node={panel_url:'https://api.example'};
  assert.match(await apiAddressWarning(node,async()=>[{address:'192.0.2.1'},{address:'192.0.2.2'}]),/несколько IP/);
  assert.equal(await apiAddressWarning(node,async()=>[{address:'192.0.2.1'}]),'');
  assert.equal(await apiAddressWarning({...node,api_connect_ip:'192.0.2.1'},async()=>{throw Error('must not resolve');}),'');
});
const openssl=process.platform==='win32'?'C:/Program Files/Git/usr/bin/openssl.exe':'openssl';
test('real HTTPS pin preserves SNI and rejects a mismatching trusted certificate', {skip:spawnSync(openssl,['version'],{windowsHide:true}).status!==0},async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-api-tls-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const keyPath=path.join(dir,'test.key'),certPath=path.join(dir,'test.pem');
  const certResult=spawnSync(openssl,['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=api-panel.example.invalid',
    '-addext','subjectAltName=DNS:api-panel.example.invalid','-keyout',keyPath,'-out',certPath],{windowsHide:true,encoding:'utf8'});
  assert.equal(certResult.status,0,certResult.stderr);
  const cert=fs.readFileSync(certPath);let sni='';
  const server=https.createServer({key:fs.readFileSync(keyPath),cert},(req,res)=>{sni=req.socket.servername;res.end('correct TLS server');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const node={panel_url:'https://api-panel.example.invalid:'+server.address().port,api_connect_ip:'127.0.0.1'};
  const transport=apiTransport(node);transport.agent.options.ca=cert; // Trust only this test CA; verification remains enabled.
  const res=await require('node-fetch')(node.panel_url,transport);
  assert.equal(await res.text(),'correct TLS server');assert.equal(sni,'api-panel.example.invalid');
  const bad={...node,panel_url:'https://wrong-panel.example.invalid:'+server.address().port};
  const rejected=apiTransport(bad);rejected.agent.options.ca=cert;
  await assert.rejects(require('node-fetch')(bad.panel_url,rejected), /altnames|certificate|hostname/i);
});
