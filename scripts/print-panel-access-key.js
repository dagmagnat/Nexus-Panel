'use strict';

const path = require('node:path');
const Database = require('better-sqlite3');
const { decrypt } = require('../lib_crypto');

const fallback = String(process.env.PANEL_ACCESS_KEY || '').trim();
const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
const databasePath = path.join(dataDir, 'app.db');

let database;
try {
  database = new Database(databasePath, { readonly: true, fileMustExist: true });
  const row = database.prepare('SELECT value FROM app_settings WHERE key = ?').get('panel_access_key');
  const raw = String(row?.value ?? '');

  if (!raw) {
    process.stdout.write(fallback);
  } else if (raw.startsWith('enc:v1:')) {
    process.stdout.write(String(decrypt(raw.slice('enc:v1:'.length), process.env.APP_SECRET || 'change-me') || fallback).trim());
  } else {
    process.stdout.write(raw.trim());
  }
} catch (_) {
  process.stdout.write(fallback);
} finally {
  if (database) database.close();
}
