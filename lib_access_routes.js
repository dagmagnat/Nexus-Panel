'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { PERMISSIONS, denyAccess } = require('./lib_access');
const profiles = require('./lib_settings_profile');
function attachAccessRoutes({ app, access, runtime, render, db, dataDir, requireAuth }) {
  function signed(req, res, next) {
    res.setHeader('Cache-Control', 'private, no-store');
    if (!access.sessionUser(req)) return res.redirect('/login');
    next();
  }
  function owner(req, res, next) {
    if (!access.sessionUser(req)?.is_owner || access.workspaceId !== 'main') return denyAccess(req, res);
    next();
  }
  if (runtime) {
    // Read-only preflight: never execute the target route or change its data.
    app.get('/access/check', signed, (req, res) => {
      const raw = String(req.query.path || '');
      const method = String(req.query.method || 'GET').toUpperCase();
      if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || raw.length > 4096 || !['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(method)) return res.status(400).json({allowed:false});
      const target = new URL(raw, 'http://nexus.local');
      const wid = req.session.workspaceId || 'main';
      const stale = String(req.query.workspace || '') !== wid;
      res.json({allowed: !stale && access.allowsRoute(access.sessionUser(req), wid, method, target.pathname), stale});
    });
    app.get('/access', signed, (req, res) => {
      const u = access.sessionUser(req);
      render(res, 'access', { accessUser: u, allWorkspaces: access.workspaces(u), permissions: PERMISSIONS,
        accounts: u.is_owner ? access.control.prepare('SELECT id,username,is_owner,disabled FROM users ORDER BY id').all() : [],
        memberships: u.is_owner ? access.control.prepare('SELECT * FROM memberships').all() : [],
        audit: u.is_owner ? access.control.prepare('SELECT * FROM access_audit ORDER BY id DESC LIMIT 40').all() : [],
        message: String(req.query.message || ''), error: String(req.query.error || '') });
    });
    app.post('/access/switch', signed, (req, res) => {
      const wid = String(req.body.workspace_id || '');
      if (!access.workspaces(access.sessionUser(req)).some(w => w.id === wid && w.status === 'ready')) return res.sendStatus(403);
      req.session.workspaceId = wid;
      req.session.save(() => res.redirect(access.landingPath(access.sessionUser(req), wid)));
    });
    app.post('/access/workspaces', signed, owner, async (req, res) => {
      try {
        await runtime.create(req.body.name, req.session.userId);
        res.redirect('/access?message=' + encodeURIComponent('Пустое пространство создано. Теперь назначьте пользователя.'));
      } catch (err) { res.redirect('/access?error=' + encodeURIComponent(err.message)); }
    });
    app.post('/access/users', signed, owner, (req, res) => {
      try {
        const id = access.createUser({ username: req.body.username, password: req.body.password, wid: req.body.workspace_id, permissions: req.body.permissions });
        access.audit(req.session.userId, req.body.workspace_id, 'user.created', id);
        res.redirect('/access?message=' + encodeURIComponent('Пользователь создан'));
      } catch (err) { res.redirect('/access?error=' + encodeURIComponent(err.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'Логин уже занят' : err.message)); }
    });
    app.post('/access/workspaces/:id/retry', signed, owner, async (req, res) => {
      try {
        await runtime.retry(req.params.id, req.session.userId);
        res.redirect('/access?message=' + encodeURIComponent('Пространство запущено'));
      } catch (err) { res.redirect('/access?error=' + encodeURIComponent(err.message)); }
    });
    app.post('/access/users/:id', signed, owner, (req, res) => {
      try {
        access.updateUser(Number(req.params.id), { disabled: req.body.disabled === '1', password: req.body.password, wid: req.body.workspace_id, permissions: req.body.permissions });
        access.audit(req.session.userId, req.body.workspace_id, 'user.updated.sessions-revoked', req.params.id);
        res.redirect('/access?message=' + encodeURIComponent('Права обновлены; прежние сессии отозваны'));
      } catch (err) { res.redirect('/access?error=' + encodeURIComponent(err.message)); }
    });
  }
  const json = express.json({ limit: '80kb' });
  app.get('/preferences', requireAuth, (req, res) => render(res, 'preferences', { profile: profiles.exportProfile(db), rules: profiles.rules, preferenceLabels: profiles.labels,
    vpnName: db.prepare("SELECT value FROM app_settings WHERE key='subscription_name'").get()?.value || '' }));
  app.post('/preferences/name', requireAuth, (req, res) => {
    const name = String(req.body.subscription_name || '').trim();
    if (!name || name.length > 100 || /[\r\n\x00-\x1f]/.test(name)) return res.status(400).send('Название: от 1 до 100 символов без переносов строк');
    db.prepare("INSERT INTO app_settings(key,value) VALUES ('subscription_name',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(name);
    access.audit(req.session.userId, access.workspaceId, 'preferences.name-changed');
    res.redirect('/preferences');
  });
  app.post('/preferences/options', requireAuth, async (req, res) => {
    try {
      const settings = {};
      for (const key of Object.keys(profiles.rules).filter(k => !k.startsWith('client_default_'))) {
        if (req.body[key] !== undefined) settings[key] = req.body[key];
      }
      await profiles.apply(db, dataDir, { format: profiles.FORMAT, version: 1, settings });
      access.audit(req.session.userId, access.workspaceId, 'preferences.options-changed');
      res.redirect('/preferences');
    } catch (err) { res.status(400).send(err.message); }
  });
  app.get('/preferences/export', requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.attachment('nexus.nxpreferences').json(profiles.exportProfile(db));
  });
  app.get('/preferences/backups/:name', requireAuth, (req, res) => {
    const name = String(req.params.name);
    if (!/^preferences-before-\d+-[a-f0-9]{8}\.nxpreferences$/.test(name)) return res.sendStatus(404);
    try {
      const bundle = JSON.parse(fs.readFileSync(path.join(dataDir, 'backups', name), 'utf8'));
      const settings = profiles.parse(bundle);
      res.attachment(name).json({format:profiles.FORMAT, version:1, settings});
    } catch (_) { res.sendStatus(404); }
  });
  app.post('/preferences/inspect', requireAuth, json, (req, res) => {
    try { res.json({ ok: true, changes: profiles.preview(db, req.body) }); }
    catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });
  app.post('/preferences/import', requireAuth, json, async (req, res) => {
    try {
      if (req.headers['x-confirm-import'] !== 'yes') throw new Error('Нужно подтверждение импорта');
      const result = await profiles.apply(db, dataDir, req.body);
      access.audit(req.session.userId, access.workspaceId, 'preferences.imported', result.updated);
      res.json({ ok: true, ...result });
    } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
  });
  app.post('/preferences/defaults', requireAuth, async (req, res) => {
    try {
      const settings = {};
      for (const key of Object.keys(profiles.rules).filter(k => k.startsWith('client_default_'))) settings[key] = String(req.body[key] ?? (key.endsWith('start_on_activation') ? '0' : profiles.rules[key].fallback));
      await profiles.apply(db, dataDir, { format: profiles.FORMAT, version: 1, settings });
      res.redirect('/preferences');
    } catch (err) { res.status(400).send(err.message); }
  });
}
module.exports = { attachAccessRoutes };
