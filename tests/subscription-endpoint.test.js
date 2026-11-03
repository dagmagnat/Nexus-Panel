'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { parseEndpoint, endpointFormValue, applySubscriptionEndpoint } = require('../lib_subscription_endpoint');
const { nodeCloneValues } = require('../lib_node_clone');

test('manual Endpoint validates domain/IPv4/bracketed IPv6, clearing and stale forms', () => {
  for (const value of ['edge.example:443','192.0.2.10:10443','[2001:db8::1]:51820'])
    assert.equal(parseEndpoint(value).value, value);
  assert.equal(parseEndpoint(' EDGE.EXAMPLE:0443 ').value, 'edge.example:443');
  for (const value of ['https://a.example:443','a.example','a:0','a:65536','2001:db8::1:443',
    'a:443/path','user@a:443','a:443?token=secret','a:443\nbad','0.0.0.0:1','[::]:1','999.1.1.1:2','a_b:443'])
    assert.throws(() => parseEndpoint(value), /Endpoint/);
  assert.equal(endpointFormValue({}, {subscription_endpoint:'a.example:443'}), 'a.example:443');
  assert.equal(endpointFormValue({subscription_endpoint:''}, {subscription_endpoint:'a.example:443'}), '');
  assert.equal(nodeCloneValues({subscription_endpoint:'edge.example:443', reality_mlkem_hint:0},10).subscription_endpoint, 'edge.example:443');
});
test('Endpoint changes only address/port and preserves transport, TLS identity and credentials', () => {
  const original = 'vless://synthetic-id@old.example:8443?type=xhttp&security=reality&sni=original.example&host=original.example&path=%2Fxhttp%2F&pbk=test&sid=abcd&extra=%7B%22mode%22%3A%22auto%22%7D#name';
  const uri = new URL(applySubscriptionEndpoint(original,'[2001:db8::1]:10443')), before=new URL(original);
  assert.equal(uri.hostname,'[2001:db8::1]'); assert.equal(uri.port,'10443');
  assert.equal(uri.search,before.search); assert.equal(uri.username,before.username); assert.equal(uri.hash,before.hash);
  assert.equal(applySubscriptionEndpoint(original,''),original);
  const conf='[Interface]\nPrivateKey = synthetic-secret\nAddress = 10.8.0.2/32\n[Peer]\nPublicKey = test\nEndpoint = old.example:51820\nPersistentKeepalive = 25';
  const line='amneziawg://'+Buffer.from(conf).toString('base64url')+'#test';
  const changed=applySubscriptionEndpoint(line,'manual.example:26589');
  assert.equal(Buffer.from(changed.split('://')[1].split('#')[0],'base64url').toString(),
    conf.replace('Endpoint = old.example:51820','Endpoint = manual.example:26589'));
});
