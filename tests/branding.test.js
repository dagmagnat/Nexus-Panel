'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath));
}

function pngDimensions(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

test('Nexus Panel brand assets contain the expected web icon sizes', () => {
  assert.deepEqual(pngDimensions(readProjectFile('public/img/nexus-logo.png')), { width: 512, height: 512 });
  assert.deepEqual(pngDimensions(readProjectFile('public/img/nexus-logo-192.png')), { width: 192, height: 192 });
  assert.deepEqual(pngDimensions(readProjectFile('public/img/nexus-logo-512.png')), { width: 512, height: 512 });
  assert.deepEqual(pngDimensions(readProjectFile('public/apple-touch-icon.png')), { width: 180, height: 180 });

  const favicon = readProjectFile('public/favicon.ico');
  assert.equal(favicon.readUInt16LE(0), 0);
  assert.equal(favicon.readUInt16LE(2), 1);
  assert.ok(favicon.readUInt16LE(4) >= 6, 'favicon must include several resolutions');
});

test('manifest and every standalone page use the Nexus Panel logo', () => {
  const manifest = JSON.parse(readProjectFile('public/site.webmanifest').toString('utf8'));
  assert.equal(manifest.name, 'Nexus Panel');
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ['192x192', '512x512']);

  for (const view of ['views/partials_header.ejs', 'views/login.ejs', 'views/open_sub.ejs']) {
    const source = readProjectFile(view).toString('utf8');
    assert.match(source, /\/favicon\.ico/);
    assert.match(source, /\/site\.webmanifest/);
    assert.match(source, /nexus-logo/);
  }
});
