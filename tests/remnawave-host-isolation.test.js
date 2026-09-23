'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const addNodeView = fs.readFileSync(path.join(__dirname, '..', 'views', 'nodes.ejs'), 'utf8');
const editNodeView = fs.readFileSync(path.join(__dirname, '..', 'views', 'node_edit.ejs'), 'utf8');
const start = source.indexOf('function parseRemnawaveShareCandidate(');
const end = source.indexOf('\nfunction isUuidText(', start);
assert.ok(start >= 0 && end > start, 'Remnawave candidate/Host matching helpers must exist');
const context = vm.createContext({ URL, URLSearchParams });
vm.runInContext(`${source.slice(start, end)}\nthis.helpers = { parseRemnawaveShareCandidate, filterRemnawaveCandidatesByHost };`, context);
const { parseRemnawaveShareCandidate, filterRemnawaveCandidatesByHost } = context.helpers;

test('selected Remnawave Host includes only matching CDN link', () => {
  const cloud = parseRemnawaveShareCandidate('vless://id@example.net:443?type=xhttp&host=cloud.example.net&path=%2Fuploadfiles%2F#Cloud');
  const turbo = parseRemnawaveShareCandidate('vless://id@example.net:443?type=xhttp&host=turbo.example.org&path=%2Fstatic%2Fsegment%2F#Turbo');
  const result = filterRemnawaveCandidatesByHost([cloud, turbo], {
    address: 'example.net', port: 443, remark: 'Cloud', host: 'cloud.example.net', path: '/uploadfiles/'
  });
  assert.deepEqual(Array.from(result, item => item.remark), ['Cloud']);
});

test('selected Remnawave Host fails closed when no candidate matches', () => {
  const cloud = parseRemnawaveShareCandidate('vless://id@example.net:443?type=xhttp&host=cloud.example.net&path=%2Fuploadfiles%2F#Cloud');
  const turbo = parseRemnawaveShareCandidate('vless://id@example.net:443?type=xhttp&host=turbo.example.org&path=%2Fstatic%2Fsegment%2F#Turbo');
  const result = filterRemnawaveCandidatesByHost([cloud, turbo], {
    address: 'missing.example.com', port: 8443, remark: 'Missing CDN', host: 'missing.example.com', path: '/not-this-host/'
  });
  assert.deepEqual(Array.from(result), [], 'mismatch must not fall back to links belonging to another Host');
});

test('unscoped Remnawave nodes retain existing candidate behavior', () => {
  const cloud = parseRemnawaveShareCandidate('vless://id@example.net:443?type=xhttp&host=cloud.example.net#Cloud');
  const result = filterRemnawaveCandidatesByHost([cloud], null);
  assert.equal(result.length, 1);
});

test('node forms explain strict Host UUID isolation for separate CDN methods', () => {
  assert.match(addNodeView, /Для отдельного CDN-метода укажи UUID именно его Host/);
  assert.match(editNodeView, /Для изоляции отдельного CDN укажи UUID именно его Host/);
  assert.match(editNodeView, /Если меняешь панель Remnawave, заново проверь этот UUID/);
});
