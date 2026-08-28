const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('redirect keeps public endpoint separate from the local iptables match', () => {
  const app = read('app.js');
  const view = read('views/redirects.ejs');
  const helper = read('scripts/forwarder.sh');

  assert.match(app, /public_host TEXT NOT NULL DEFAULT ''/);
  assert.match(app, /helper_enabled INTEGER NOT NULL DEFAULT 1/);
  assert.match(app, /normalizeRedirectPublicHost/);
  assert.match(app, /COALESCE\(NULLIF\(public_host, ''\), bind_ip\) AS replacement_host/);
  assert.match(app, /function getRemnawaveRedirectTarget/);
  assert.match(app, /await getRemnawaveHostDescriptor\(node\)/);
  assert.match(view, /Свой IP или домен/);
  assert.match(view, /На отдельном сервере — только менять подписку/);
  assert.match(helper, /destination_match = \(' -d ' \+ q\(bind\)\) if bind else ''/);
});

test('Remnawave usage accepts official and compatible counter shapes', () => {
  const app = read('app.js');
  const dashboard = read('views/dashboard.ejs');
  assert.match(app, /function getRemnawaveUsedTrafficBytes/);
  assert.match(app, /user\?\.userTraffic\?\.usedTrafficBytes/);
  assert.match(app, /user\?\.used_traffic_bytes/);
  assert.match(app, /hwidDeviceLimit: deviceLimit/);
  assert.doesNotMatch(app, /clampByteNumber\(user\?\.userTraffic\?\.usedTrafficBytes \|\| 0\)/);
  assert.match(app, /currentUsedText: formatTrafficBytes\(current\.used_bytes\)/);
  assert.match(dashboard, /общий счётчик/);
});

test('client action blocks and auto-select edit button have explicit alignment and contrast', () => {
  const clients = read('views/clients.ejs');
  const footer = read('views/partials_footer.ejs');
  const nodes = read('views/nodes.ejs');
  const css = read('public/css/spectrum-clear.css');

  assert.match(clients, /client-summary-action-card client-summary-open/);
  assert.match(footer, /class="client-quick-uuid"/);
  assert.match(nodes, /auto-select-edit-button/);
  assert.match(css, /auto-select-edit-button:visited[\s\S]{0,180}color: #fff !important/);
  assert.match(css, /client-quick-device-chip:only-child/);
  assert.match(css, /client-quick-actions\.modern \{[\s\S]{0,100}repeat\(3/);
});
