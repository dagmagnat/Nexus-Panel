'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env.development');
const dataDir = path.join(root, 'data-dev');

fs.mkdirSync(dataDir, { recursive: true });
const sourceIpList = path.join(root, 'data', 'ip-list.json');
const targetIpList = path.join(dataDir, 'ip-list.json');
if (!fs.existsSync(targetIpList) && fs.existsSync(sourceIpList)) {
  fs.copyFileSync(sourceIpList, targetIpList);
}

function secret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

if (!fs.existsSync(envPath)) {
  const password = `dev-${secret(12)}`;
  const content = [
    'NODE_ENV=development',
    'PORT=3000',
    'DATA_DIR=./data-dev',
    `APP_SECRET=${secret(32)}`,
    `SESSION_SECRET=${secret(32)}`,
    'ADMIN_USERNAME=admin',
    `ADMIN_PASSWORD=${password}`,
    'PANEL_ACCESS_KEY=',
    'TRUST_PROXY=0',
    'SESSION_SECURE=0',
    'BASE_URL=http://localhost:3001',
    'PANEL_PUBLIC_URL=http://localhost:3001',
    'SUB_PUBLIC_URL=http://localhost:3001',
    'SUB_URL_MODE=custom',
    'DEV_BROWSER_PORT=3001',
    'DEV_BROWSER_UI_PORT=3002',
    ''
  ].join('\n');
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  console.log(`Создан ${path.basename(envPath)}. Логин: admin, пароль: ${password}`);
} else {
  try { fs.chmodSync(envPath, 0o600); } catch (_) {}
  const text = fs.readFileSync(envPath, 'utf8');
  const username = (text.match(/^ADMIN_USERNAME=(.*)$/m) || [,'admin'])[1];
  const password = (text.match(/^ADMIN_PASSWORD=(.*)$/m) || [,''])[1];
  console.log(`Dev-конфигурация готова. Логин: ${username}, пароль: ${password || '(см. .env.development)'}`);
}
