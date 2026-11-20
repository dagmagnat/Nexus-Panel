'use strict';
const {randomUUID}=require('node:crypto');
const QRCode=require('qrcode');
const defaults={enabled:false,button:'Оплатить подписку',monthlyRub:'200',deviceRub:'50',includedDevices:2,maxDevices:30,discount3:0,discount6:0,discount12:0,phone:'',bank:'',paymentUrl:'',selfService:true,activeButtonText:'Личный кабинет',expiredButtonText:'Оплатите подписку',activeColor:'#2189EA',expiredColor:'#E23D45',activeTextColor:'#FFFFFF',expiredTextColor:'#FFFFFF'};
function normalize(input){
  const c={...defaults,...input};
  c.enabled=input.enabled===true||input.enabled==='1';
  c.selfService=input.selfService===true||input.selfService==='1';
  for(const k of ['activeButtonText','expiredButtonText'])c[k]=String(c[k]||defaults[k]).trim().slice(0,25);
  for(const k of ['activeColor','expiredColor','activeTextColor','expiredTextColor']){c[k]=String(c[k]).toUpperCase();if(!/^#[0-9A-F]{6}$/.test(c[k]))throw Error('Цвет должен иметь формат #RRGGBB.');}
  c.button=String(c.button||defaults.button).trim().slice(0,25);
  c.monthlyRub=String(c.monthlyRub||'').trim().replace(',','.');
  if(c.monthlyRub&&!/^\d{1,6}(\.\d{1,2})?$/.test(c.monthlyRub))throw Error('Цена: укажите положительную сумму в рублях, не более двух знаков после запятой.');
  c.deviceRub=String(c.deviceRub).replace(',','.');if(!/^\d{1,6}(\.\d{1,2})?$/.test(c.deviceRub))throw Error('Укажите цену дополнительного устройства.');
  for(const k of ['includedDevices','maxDevices']){c[k]=Number(c[k]);if(!Number.isInteger(c[k])||c[k]<1||c[k]>200)throw Error('Количество устройств: от 1 до 200.');}if(c.maxDevices<c.includedDevices)throw Error('Максимум устройств меньше включённого количества.');
  for(const k of ['discount3','discount6','discount12']){c[k]=Number(c[k]);if(!Number.isInteger(c[k])||c[k]<0||c[k]>90)throw Error('Скидка должна быть целым числом от 0 до 90%.');}
  c.phone=String(c.phone||'').trim().slice(0,30);c.bank=String(c.bank||'').trim().slice(0,100);
  c.paymentUrl=String(c.paymentUrl||'').trim();
  if(c.paymentUrl){const u=new URL(c.paymentUrl);if(u.protocol!=='https:'||u.username||u.password)throw Error('Укажите HTTPS-ссылку СБП, выданную банком.');}
  if(c.enabled&&(!c.monthlyRub||Number(c.monthlyRub)<=0||!c.paymentUrl&&!c.phone))throw Error('Для включения нужны цена и ссылка банка либо телефон получателя.');
  return c;
}
function quote(c,months,devices=c.includedDevices){
  months=Number(months);if(!Number.isInteger(months)||months<1||months>12)throw Error('Выберите срок от 1 до 12 месяцев.');
  devices=Number(devices);if(!Number.isInteger(devices)||devices<c.includedDevices||devices>c.maxDevices)throw Error('Недопустимое количество устройств.');
  const kopecks=Math.round(Number(c.monthlyRub)*100)+Math.max(0,devices-c.includedDevices)*Math.round(Number(c.deviceRub)*100);if(!Number.isSafeInteger(kopecks)||kopecks<=0)throw Error('Тариф пока не настроен.');
  const discount=months>=12?c.discount12:months>=6?c.discount6:months>=3?c.discount3:0;
  return {months,devices,days:months*30,discount,monthly:kopecks,amount:Math.round(kopecks*months*(100-discount)/100),original:kopecks*months};
}
function createBilling({app,db,getSetting,setSetting,requireAuth,render,migration,removeDevices,term,syncClient}){
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_orders(id TEXT PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,months INTEGER NOT NULL,days INTEGER NOT NULL,amount INTEGER NOT NULL,discount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,confirmed_at TEXT,sync_error TEXT NOT NULL DEFAULT '');`);
  if(!db.prepare('PRAGMA table_info(subscription_orders)').all().some(x=>x.name==='devices'))db.exec('ALTER TABLE subscription_orders ADD COLUMN devices INTEGER NOT NULL DEFAULT 2');
  // Older installations created this table without cascading client deletion.
  // Preserve orders while repairing the relation atomically.
  if(!db.prepare('PRAGMA foreign_key_list(subscription_orders)').all().some(x=>x.table==='clients'&&x.on_delete==='CASCADE')) db.transaction(()=>{
    db.exec(`CREATE TABLE subscription_orders_cascade(id TEXT PRIMARY KEY,client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,months INTEGER NOT NULL,days INTEGER NOT NULL,amount INTEGER NOT NULL,discount INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'new',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,confirmed_at TEXT,sync_error TEXT NOT NULL DEFAULT '',devices INTEGER NOT NULL DEFAULT 2);
      INSERT INTO subscription_orders_cascade SELECT id,client_id,months,days,amount,discount,status,created_at,confirmed_at,sync_error,devices FROM subscription_orders;
      DROP TABLE subscription_orders;ALTER TABLE subscription_orders_cascade RENAME TO subscription_orders;`);
  })();
  db.exec('CREATE INDEX IF NOT EXISTS subscription_orders_client_created ON subscription_orders(client_id,created_at); CREATE INDEX IF NOT EXISTS subscription_orders_created ON subscription_orders(created_at)');
  const config=()=>{try{return {...defaults,...JSON.parse(getSetting('subscription_billing_v1','{}'))}}catch{return {...defaults}}};
  const publicClient=slug=>db.prepare('SELECT * FROM clients WHERE sub_slug=?').get(String(slug));
  const orders=id=>db.prepare('SELECT * FROM subscription_orders WHERE client_id=? ORDER BY created_at DESC LIMIT 5').all(id);
  const money=n=>(n/100).toLocaleString('ru-RU',{minimumFractionDigits:0,maximumFractionDigits:2})+' ₽';
  const portal=async client=>{const c=config();return {config:c,button:buttonState(c,client),options:c.monthlyRub?Array.from({length:12},(_,i)=>quote(c,i+1)):[],orders:orders(client.id),devices:db.prepare('SELECT id,os_name,device_model,app_name,last_seen_at FROM subscription_devices WHERE client_id=? ORDER BY id').all(client.id),qr:c.paymentUrl?await QRCode.toDataURL(c.paymentUrl,{width:240,margin:2}):'',money};};
  const back=(res,slug,message,fragment='renew')=>{if(res.req?.session)res.req.session.portalNotice=String(message).slice(0,500);return res.redirect('/account#'+fragment);};
  app.get('/subscription-billing',requireAuth,(req,res)=>render(res,'subscription_billing_admin',{config:config(),orders:db.prepare('SELECT o.*,c.login FROM subscription_orders o JOIN clients c ON c.id=o.client_id ORDER BY o.created_at DESC LIMIT 100').all(),money,message:req.query.message||'',error:req.query.error||''}));
  app.post('/subscription-billing/settings',requireAuth,(req,res)=>{try{const c=normalize(req.body);setSetting('subscription_billing_v1',JSON.stringify(c));res.redirect('/subscription-billing?message='+encodeURIComponent('Настройки сохранены. 1 месяц = 30 дней; скидка применяется ко всему выбранному сроку.'))}catch(e){res.redirect('/subscription-billing?error='+encodeURIComponent(e.message))}});
  app.post('/open/:slug/order',(req,res)=>{try{const client=publicClient(req.params.slug),c=config();if(!client)return res.sendStatus(404);if(!c.enabled)throw Error('Оплата пока не настроена.');const q=quote(c,req.body.months,req.body.devices);const old=db.prepare("SELECT id FROM subscription_orders WHERE client_id=? AND months=? AND devices=? AND amount=? AND status IN ('new','review') AND created_at>datetime('now','-1 day') LIMIT 1").get(client.id,q.months,q.devices,q.amount);const orderId=old?.id||randomUUID();if(!old)db.prepare('INSERT INTO subscription_orders(id,client_id,months,days,amount,discount,devices) VALUES(?,?,?,?,?,?,?)').run(orderId,client.id,q.months,q.days,q.amount,q.discount,q.devices);back(res,client.sub_slug,'Заказ готов. Откройте банковскую ссылку ниже или переведите по реквизитам.','order-'+orderId)}catch(e){back(res,req.params.slug,e.message)}});
  app.post('/open/:slug/orders/:order/paid',(req,res)=>{const c=publicClient(req.params.slug);if(!c)return res.sendStatus(404);db.prepare("UPDATE subscription_orders SET status='review' WHERE id=? AND client_id=? AND status='new'").run(String(req.params.order),c.id);back(res,c.sub_slug,'Заявка отправлена. Продление произойдёт после проверки поступления перевода.');});
  app.post('/open/:slug/devices/:device/delete',async(req,res)=>{try{const c=publicClient(req.params.slug);if(!c)return res.sendStatus(404);if(!config().selfService)throw Error('Управление устройствами отключено.');const id=Number(req.params.device);if(!Number.isSafeInteger(id)||id<1)throw Error('Устройство не найдено.');const result=await removeDevices(c.id,id);back(res,c.sub_slug,result)}catch(e){back(res,req.params.slug,e.message)}});
  app.post('/open/:slug/devices/reset',async(req,res)=>{try{const c=publicClient(req.params.slug);if(!c)return res.sendStatus(404);if(!config().selfService)throw Error('Управление устройствами отключено.');back(res,c.sub_slug,await removeDevices(c.id,null))}catch(e){back(res,req.params.slug,e.message)}});
  app.post('/subscription-billing/orders/:id/confirm',requireAuth,async(req,res)=>{let id;try{id=Number(db.transaction(()=>{const o=db.prepare('SELECT * FROM subscription_orders WHERE id=?').get(req.params.id);if(!o)throw Error('Заказ не найден.');if(o.status==='confirmed')return o.client_id;const c=db.prepare('SELECT * FROM clients WHERE id=?').get(o.client_id);if(!c)throw Error('Клиент не найден.');const next=term(c,o.days);db.prepare('UPDATE clients SET expiry_time=?,duration_days=?,device_limit=? WHERE id=?').run(next.expiry,next.duration,o.devices,c.id);db.prepare("UPDATE subscription_orders SET status='confirmed',confirmed_at=CURRENT_TIMESTAMP WHERE id=?").run(o.id);return c.id})());await syncClient(id);db.prepare("UPDATE subscription_orders SET sync_error='' WHERE id=?").run(req.params.id);res.redirect('/subscription-billing?message='+encodeURIComponent('Поступление подтверждено, срок и лимит устройств обновлены. Повторное подтверждение не добавляет срок ещё раз.'))}catch(e){if(id)db.prepare('UPDATE subscription_orders SET sync_error=? WHERE id=?').run(String(e.message).slice(0,300),req.params.id);res.redirect('/subscription-billing?error='+encodeURIComponent(e.message))}});
  function headers(res,client){
   if(!client)return;const url=migration.portal(client);
   res.setHeader('profile-web-page-url',url);res.setHeader('hide-url','1');res.setHeader('announce-url',url);
   // Clear an earlier advanced expiration directive; use standard free links only.
   res.setHeader('sub-expire','0');
  }
  return {portal,headers,config};
}
function buttonState(config,client,now=Date.now()){
 const c={...defaults,...config},expired=Number(client?.expiry_time)>0&&Number(client.expiry_time)<=now;
 return {expired,label:expired?c.expiredButtonText:c.activeButtonText,color:expired?c.expiredColor:c.activeColor,textColor:expired?c.expiredTextColor:c.activeTextColor};
}
module.exports={createBilling,normalize,quote,defaults,buttonState};
