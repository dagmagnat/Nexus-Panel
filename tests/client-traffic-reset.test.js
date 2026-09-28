'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildClientTrafficResetRequest } = require('../lib_client_traffic_reset');

const client = { uuid: 'd7a86b1f-88cf-4ace-9f50-c1339f0acb17', login: 'phone user' };

test('Remnawave reset targets the mapped user UUID', () => {
  const request = buildClientTrafficResetRequest({
    node: { node_type: 'remnawave' },
    map: { remote_uuid: client.uuid }, client, remnawave: true
  });
  assert.equal(request.kind, 'remnawave');
  assert.equal(request.method, 'POST');
  assert.equal(request.path, `/api/users/${client.uuid}/actions/reset-traffic`);
});

test('3x-ui modern API resets the encoded mapped login', () => {
  const request = buildClientTrafficResetRequest({
    node: { inbound_id: 3 }, map: { remote_email: client.login }, client, modern3xui: true
  });
  assert.equal(request.path, '/panel/api/clients/resetTraffic/phone%20user');
});

test('3x-ui legacy API is scoped to the node inbound and encoded login', () => {
  const request = buildClientTrafficResetRequest({
    node: { inbound_id: 12 }, map: { remote_email: client.login }, client
  });
  assert.equal(request.path, '/panel/api/inbounds/12/resetClientTraffic/phone%20user');
});

test('unsupported H1Cloud counters fail closed and malformed targets are rejected', () => {
  assert.throws(() => buildClientTrafficResetRequest({ node: {}, map: {}, client, h1cloud: true }), /не поддерживается/);
  assert.throws(() => buildClientTrafficResetRequest({ node: {}, map: {}, client: { login: 'no-uuid' }, remnawave: true }), /UUID/);
  assert.throws(() => buildClientTrafficResetRequest({ node: { inbound_id: 0 }, map: {}, client }), /inbound ID/);
});
