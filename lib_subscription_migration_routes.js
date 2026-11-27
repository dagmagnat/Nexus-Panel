'use strict';
const QRCode=require('qrcode');
function attachSubscriptionMigrationRoutes({ app, db, migration, karingLinks, routerNodes, shortPortalUrl, requireAuth, render, subscriptionName, portalModel, billing, supportUrl=()=>'' }) {
  let bulk = { running: false, total: 0, done: 0, errors: [] };
  const back = (res, message, error = false) => res.redirect('/subscription-migration?' + (error ? 'error=' : 'message=') + encodeURIComponent(message));
  const karingQrUrl = client => shortPortalUrl(client) + '?app=karing';
  app.get('/subscription-migration', requireAuth, (req, res) => {
    const rows = db.prepare(`SELECT c.id,c.login,c.display_name,c.sub_slug,m.mode,m.happ_enc,
      (SELECT COUNT(*) FROM subscription_devices d WHERE d.client_id=c.id AND d.app_name='Happ') AS happ_devices,
      (SELECT COUNT(*) FROM subscription_migration_devices d WHERE d.client_id=c.id AND d.app_name='Happ') AS delivered_happ,
      (SELECT COUNT(*) FROM subscription_migration_devices d WHERE d.client_id=c.id AND d.app_name='INCY') AS delivered_incy
      FROM clients c LEFT JOIN subscription_migrations m ON m.client_id=c.id ORDER BY c.id`).all();
    render(res, 'subscription_migration_admin', { rows: rows.map(row => ({ ...row, ready: Boolean(row.happ_enc), happ_enc: undefined, portal: migration.portal(row) })), bulk,
      message: req.query.message || '', error: req.query.error || '' });
  });
  app.post('/subscription-migration/:id/prepare', requireAuth, async (req, res) => {
    try {
      const client = db.prepare('SELECT * FROM clients WHERE id=?').get(Number(req.params.id));
      if (!client) throw Error('Клиент не найден');
      await migration.prepare(client, 'notify');
      back(res, 'Кабинет и обе ссылки подготовлены. Старый Happ получает уведомление; действующие узлы сохранены.');
    } catch (e) { back(res, String(e.message || e), true); }
  });
  app.post('/subscription-migration/:id/mode', requireAuth, (req, res) => {
    try { migration.setMode(Number(req.params.id), String(req.body.mode)); back(res, 'Режим старой выдачи обновлён.'); }
    catch (e) { back(res, String(e.message || e), true); }
  });
  app.post('/subscription-migration/prepare-all', requireAuth, (req, res) => {
    if (bulk.running) return back(res, 'Подготовка уже выполняется.');
    const clients = db.prepare('SELECT * FROM clients WHERE enabled=1').all();
    bulk = { running: true, total: clients.length, done: 0, errors: [] };
    let index = 0;
    const worker = async () => {
      while (index < clients.length) {
        const client = clients[index++];
        try { if (!migration.ready(migration.get(client.id))) await migration.prepare(client, 'notify'); }
        catch (e) { bulk.errors.push({ login: client.login, error: String(e.message || e).slice(0, 160) }); }
        finally { bulk.done++; }
      }
    };
    Promise.allSettled([worker(), worker(), worker()]).finally(() => { bulk.running = false; });
    back(res, 'Подготовка запущена. Обновляйте страницу для проверки прогресса. Отключение старых ссылок не включается.');
  });
  app.post('/clients/:id/app-subscription', requireAuth, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(Number(req.params.id));
    if (!client) return res.status(404).json({ error: 'Клиент не найден.' });
    const appName = req.body.app;
    if (!['happ', 'incy', 'karing', 'router', 'sub', 'portal'].includes(appName)) return res.status(400).json({ error: 'Выберите тип ссылки.' });
    try {
      if (appName === 'portal') return res.json({ link: shortPortalUrl(client) });
      if (appName === 'router') {
        if (req.body.detail === 'nodes') return res.json({ nodes: await routerNodes(client) });
        return res.json({ link: karingLinks.routerUrl(client) });
      }
      if (appName === 'sub') return res.json({ link: karingLinks.plainUrl(client) });
      const karing = appName === 'karing' ? karingLinks.links(client) : null;
      const link = karing?.open || (migration.links(client) || await migration.prepare(client, null))[appName];
      const qr = await QRCode.toDataURL(karing ? karingQrUrl(client) : link, { width: 420, margin: 4, errorCorrectionLevel: 'L' });
      res.json({ link, qr, ...(karing ? { importUrl: karing.url } : {}) });
    } catch (error) {
      console.error('Client application link:', error.message);
      res.status(503).json({ error: 'Не удалось подготовить ссылку приложения. Повторите позже.' });
    }
  });
  app.get('/open/:slug/connection-qr', async (req,res) => {
    if(!req.portalAccount||!req.portalClient)return res.sendStatus(403);
    const appName=req.query.app===undefined?'happ':req.query.app;
    if(!['happ','incy','karing'].includes(appName))return res.sendStatus(400);
    const links=migration.links(req.portalClient);
    const link = appName === 'karing' ? karingQrUrl(req.portalClient) : links?.[appName];
    if(!link)return res.sendStatus(404);
    try{
      const png=await QRCode.toBuffer(link,{type:'png',width:360,margin:4,errorCorrectionLevel:'L'});
      res.setHeader('Cache-Control','private, no-store, max-age=0');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.type('png').send(png);
    }catch(_){res.status(503).send('Не удалось создать QR-код. Используйте копирование ключа.');}
  });
  app.get('/open/:slug', async (req, res, next) => {
    const client = db.prepare('SELECT * FROM clients WHERE sub_slug=?').get(req.params.slug);
    if (!client) return next();
    const links = migration.links(client);
    if (!links) return next();
    try {
      const account = await portalModel(client);
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      res.setHeader('Referrer-Policy', 'no-referrer');
      render(res, 'subscription_account', { portalClient:client, account, links: { ...links, karing: karingLinks?.links(client) }, billing:await billing.portal(client), notice:String(req.portalNotice||req.query.notice||'').slice(0,500), subscriptionName: subscriptionName(), supportUrl: supportUrl() });
    } catch (_) { res.status(503).send('Кабинет временно недоступен. Обновите страницу немного позже.'); }
  });
}
module.exports = { attachSubscriptionMigrationRoutes };
