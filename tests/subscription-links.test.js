'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { subscriptionUrl, cleanSubscriptionTarget, cleanSlug, RESERVED } = require('../lib_subscription_links');
const { publicTarget } = require('../lib_workspace_runtime');
const profile = require('../lib_settings_profile');

test('clean link preference is transferable and validates boolean values', () => {
  assert.equal(profile.rules.subscription_clean_urls.fallback, '1');
  for (const value of ['0','1']) assert.equal(profile.validate('subscription_clean_urls', value), value);
  assert.throws(() => profile.validate('subscription_clean_urls', 'false'));
  assert.equal(profile.parse({format:profile.FORMAT,version:1,settings:{subscription_clean_urls:'0'}}).subscription_clean_urls,'0');
});

test('clean subscription links default to JSON, SUB is explicit, legacy IDs remain usable', () => {
  const key = 'clean-key-12345678';
  assert.equal(subscriptionUrl('https://sub.example.test', key), `https://sub.example.test/${key}`);
  assert.equal(subscriptionUrl('https://sub.example.test', key, 'sub'), `https://sub.example.test/${key}?format=sub`);
  assert.equal(subscriptionUrl('https://sub.example.test', key, 'json', false), `https://sub.example.test/json/${key}`);
  assert.equal(subscriptionUrl('https://sub.example.test', key, 'sub', false), `https://sub.example.test/sub/${key}`);
  assert.equal(subscriptionUrl('https://sub.example.test/s/team', key, 'sub', false), `https://sub.example.test/s/team/sub/${key}`);
  assert.equal(subscriptionUrl('https://sub.example.test', 'old-key'), 'https://sub.example.test/json/old-key');
  assert.equal(subscriptionUrl('https://sub.example.test', 'old-key', 'sub'), 'https://sub.example.test/sub/old-key');
  assert.equal(subscriptionUrl('https://sub.example.test', ''), '');
  assert.equal(subscriptionUrl('https://sub.example.test', 'happ-routing-json'), 'https://sub.example.test/json/happ-routing-json');
});

test('internal alias keeps query options and rejects ambiguous formats and unsafe/admin paths', () => {
  assert.deepEqual(cleanSubscriptionTarget('/clean-key-12345678?download=1&format=sub&rev=42'), { url: '/sub/clean-key-12345678?download=1&rev=42' });
  assert.deepEqual(cleanSubscriptionTarget('/clean-key-12345678/?format=single&node=2'), { url: '/json/clean-key-12345678?format=single&node=2' });
  assert.deepEqual(cleanSubscriptionTarget('/clean-key-12345678?format=json'), { url: '/json/clean-key-12345678' });
  assert.ok(cleanSubscriptionTarget('/clean-key-12345678?format=oops').error);
  assert.ok(cleanSubscriptionTarget('/clean-key-12345678?format=sub&format=json').error);
  for (const item of RESERVED) assert.equal(cleanSubscriptionTarget('/' + item), null, item);
  for (const path of ['/nodes/1/edit', '/json/abc', '/s/abc/clean-key-12345678', '/%2e%2e/clean-key-12345678', '/clean-key-12345678/extra', '//clean-key-12345678']) assert.equal(cleanSubscriptionTarget(path), null, path);
  assert.equal(cleanSlug('a'.repeat(129)), false);
});

test('workspace clean links preserve explicit namespace and cannot proxy administration', () => {
  const id = 'a'.repeat(24), key = 'clean-key-12345678';
  assert.deepEqual(publicTarget(`/s/${id}/${key}`), { id, url: `/json/${key}` });
  assert.deepEqual(publicTarget(`/s/${id}/${key}?format=sub&raw=1`), { id, url: `/sub/${key}?raw=1` });
  for (const suffix of ['/auto-select-profiles', '/node-traffic', '/happ-routing-json', '/backup/download', '/clean-key-12345678?format=bad']) assert.equal(publicTarget(`/s/${id}${suffix}`), null, suffix);
});
