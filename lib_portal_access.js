'use strict';
const {createHmac,timingSafeEqual}=require('node:crypto');
const {encrypt,decrypt}=require('./lib_crypto');
function createPortalAccess({db,secret,baseUrl}){
 const byId=db.prepare('SELECT * FROM clients WHERE id=?'),bySlug=db.prepare('SELECT * FROM clients WHERE sub_slug=?');
 const stamp=c=>createHmac('sha256',secret).update('portal-session-v1:'+c.id+':'+c.uuid).digest('hex');
 const url=input=>{const c=byId.get(Number(input?.id)||-1);if(!c)return '';return baseUrl().replace(/\/$/,'')+'/cabinet/'+Buffer.from(encrypt(JSON.stringify({purpose:'portal-v1',id:c.id,stamp:stamp(c)}),secret)).toString('base64url');};
 const shortSignature = client => createHmac('sha256', secret)
   .update(JSON.stringify(['portal-share-v1', client.id, client.uuid, client.sub_slug]))
   .digest().subarray(0, 18).toString('base64url');
 function shortUrl(client) {
   return baseUrl().replace(/\/$/, '') + '/cabinet/p' + client.id.toString(36) + '-' + shortSignature(client);
 }
 function decodeShort(token) {
   const match = /^p([0-9a-z]{1,11})-([A-Za-z0-9_-]{24})$/.exec(token);
   if (!match) return null;
   const id = Number.parseInt(match[1], 36);
   if (!Number.isSafeInteger(id) || id <= 0 || id.toString(36) !== match[1]) return null;
   const client = byId.get(id);
   return client && timingSafeEqual(Buffer.from(match[2]), Buffer.from(shortSignature(client))) ? client : null;
 }
 function decode(token){try{if(!/^[A-Za-z0-9_-]{40,600}$/.test(token))return null;const p=JSON.parse(decrypt(Buffer.from(token,'base64url').toString(),secret));if(p.purpose!=='portal-v1'||!Number.isSafeInteger(p.id))return null;const c=byId.get(p.id);return c&&p.stamp===stamp(c)?c:null;}catch{return null;}}
 function enter(req,res,c){
  req.session.portalIdentity={id:c.id,stamp:stamp(c)};
  if(req.query?.notice)req.session.portalNotice=String(req.query.notice).slice(0,500);
  const destination=req.query?.app==='karing'?'/account#karing':'/account';
  req.session.save(e=>e?res.status(503).send('Не удалось открыть кабинет. Повторите вход.'):res.redirect(303,destination));
 }
 function middleware(req,res,next){
  const p=req.path;
  if(p==='/account'||p.startsWith('/account/')||p.startsWith('/cabinet/')||p.startsWith('/open/')){res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Referrer-Policy','no-referrer');}
  const entry=p.match(/^\/cabinet\/([^/]+)\/?$/);
  if(entry){if(!['GET','HEAD'].includes(req.method))return res.sendStatus(405);const c=decodeShort(entry[1])||decode(entry[1]);return c?enter(req,res,c):res.status(404).send('Ссылка кабинета недействительна. Откройте сайт из вашей подписки.');}
  if(p==='/account'||p.startsWith('/account/')){
   const id=Number(req.session?.portalIdentity?.id),c=Number.isSafeInteger(id)?byId.get(id):null;
   if(!c||req.session.portalIdentity.stamp!==stamp(c))return res.status(401).send('Откройте личный кабинет кнопкой «Сайт» в вашей подписке.');
   req.portalAccount=true;req.portalClient=c;
   if(req.method==='GET'){req.portalNotice=String(req.session.portalNotice||'').slice(0,500);delete req.session.portalNotice;}
   const u=new URL(req.url,'http://nexus.local');req.url='/open/'+encodeURIComponent(c.sub_slug)+u.pathname.slice('/account'.length)+u.search;return next();
  }
  const old=p.match(/^\/open\/([^/]+)\/?$/);
  if(old&&['GET','HEAD'].includes(req.method)){const c=bySlug.get(old[1]);return c?enter(req,res,c):res.sendStatus(404);}
  if(p.startsWith('/open/')&&!['GET','HEAD','OPTIONS'].includes(req.method))return res.sendStatus(403);
  next();
 }
 return {url,shortUrl,decode,middleware};
}
module.exports={createPortalAccess};
