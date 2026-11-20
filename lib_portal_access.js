'use strict';
const {createHmac}=require('node:crypto');
const {encrypt,decrypt}=require('./lib_crypto');
function createPortalAccess({db,secret,baseUrl}){
 const byId=db.prepare('SELECT * FROM clients WHERE id=?'),bySlug=db.prepare('SELECT * FROM clients WHERE sub_slug=?');
 const stamp=c=>createHmac('sha256',secret).update('portal-session-v1:'+c.id+':'+c.uuid).digest('hex');
 const url=input=>{const c=byId.get(Number(input?.id)||-1);if(!c)return '';return baseUrl().replace(/\/$/,'')+'/cabinet/'+Buffer.from(encrypt(JSON.stringify({purpose:'portal-v1',id:c.id,stamp:stamp(c)}),secret)).toString('base64url');};
 function decode(token){try{if(!/^[A-Za-z0-9_-]{40,600}$/.test(token))return null;const p=JSON.parse(decrypt(Buffer.from(token,'base64url').toString(),secret));if(p.purpose!=='portal-v1'||!Number.isSafeInteger(p.id))return null;const c=byId.get(p.id);return c&&p.stamp===stamp(c)?c:null;}catch{return null;}}
 function enter(req,res,c){req.session.portalIdentity={id:c.id,stamp:stamp(c)};if(req.query?.notice)req.session.portalNotice=String(req.query.notice).slice(0,500);req.session.save(e=>e?res.status(503).send('Не удалось открыть кабинет. Повторите вход.'):res.redirect(303,'/account'));}
 function middleware(req,res,next){
  const p=req.path;
  if(p==='/account'||p.startsWith('/account/')||p.startsWith('/cabinet/')||p.startsWith('/open/')){res.setHeader('Cache-Control','private, no-store, max-age=0');res.setHeader('Referrer-Policy','no-referrer');}
  const entry=p.match(/^\/cabinet\/([^/]+)\/?$/);
  if(entry){if(!['GET','HEAD'].includes(req.method))return res.sendStatus(405);const c=decode(entry[1]);return c?enter(req,res,c):res.status(404).send('Ссылка кабинета недействительна. Откройте сайт из вашей подписки.');}
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
 return {url,decode,middleware};
}
module.exports={createPortalAccess};
