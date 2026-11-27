(() => {
'use strict';
const $=s=>document.querySelector(s),$$=s=>Array.from(document.querySelectorAll(s));
const status=$('#portal-status');let toastTimer;
function toast(text){status.textContent=text;status.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>status.classList.remove('visible'),4200);}
function preference(key,value){try{if(value===undefined)return localStorage.getItem('aero-portal-'+key);localStorage.setItem('aero-portal-'+key,value);}catch{}}
const apps = {
  happ: { label: 'Happ', icon: 'H', install: 'https://www.happ.su/main' },
  incy: { label: 'INCY', icon: 'INCY', install: 'https://incy.cc/' },
  karing: { label: 'Karing', icon: 'K', install: 'https://karing.app/download' },
};
function appLink(app) { return document.getElementById(app + '-link'); }
function copyValue(app) { const link = appLink(app); return link.dataset.importUrl || link.getAttribute('href'); }
const preferredApp = location.hash === '#karing' ? 'karing' : preference('app');
let selectedApp = appLink(preferredApp) ? preferredApp : 'happ';
const platforms={ios:'iPhone / iPad',android:'Android',windows:'Windows',mac:'macOS',linux:'Linux'};
const ua=navigator.userAgent,automatic=/Android/i.test(ua)?'android':/iPhone|iPad/i.test(ua)||(/Macintosh/i.test(ua)&&navigator.maxTouchPoints>1)?'ios':/Mac/i.test(ua)?'mac':/Linux/i.test(ua)?'linux':'windows';
let selectedPlatform=platforms[preference('platform')]?preference('platform'):automatic;
function updatePlatform(value){selectedPlatform=value;$$('[data-platform]').forEach(b=>{const on=b.dataset.platform===value;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});$('#platform-hint').textContent=platforms[value]+(value===automatic?' · определено':' · выбрано');preference('platform',value);}
const qr=$('#connection-qr'),qrError=$('#qr-error');qr.addEventListener('error',()=>{qr.hidden=true;qrError.hidden=false;});qr.addEventListener('load',()=>{qr.hidden=false;qrError.hidden=true;});
function updateApp(value) {
  if (!appLink(value)) return;
  selectedApp = value;
  const app = apps[value];
  $$('[data-app]').forEach(button => {
    const on = button.dataset.app === value;
    button.classList.toggle('selected', on);
    button.setAttribute('aria-pressed', String(on));
    button.querySelector('small').textContent = on ? 'Выбрано' : 'Доступно';
  });
  $('#connect-app').setAttribute('href', appLink(value).getAttribute('href'));
  $('#connect-label').textContent = 'Подключиться в ' + app.label;
  const logo = $('#connect-logo');
  logo.textContent = app.icon;
  logo.className = 'app-logo ' + value + '-logo';
  const install = $('#install-app');
  install.href = app.install;
  install.setAttribute('aria-label', 'Установить ' + app.label);
  const src = '/account/connection-qr?app=' + value;
  if (qr.getAttribute('src') !== src) { qr.hidden = false; qrError.hidden = true; qr.src = src; }
  $('#connection-qr-hint').textContent = value === 'karing'
    ? 'Наведите камеру телефона на QR-код и нажмите «Подключиться в Karing».'
    : 'Отсканируйте QR-код или отправьте ключ';
  qr.alt = 'QR-код подписки ' + app.label + ' для другого устройства';
  preference('app', value);
}
$$('[data-platform]').forEach(b=>b.addEventListener('click',()=>updatePlatform(b.dataset.platform)));
$$('[data-app]').forEach(b=>b.addEventListener('click',()=>updateApp(b.dataset.app)));
updatePlatform(selectedPlatform);updateApp(selectedApp);
async function copy(text,message){try{if(navigator.clipboard&&window.isSecureContext)await navigator.clipboard.writeText(text);else{const field=document.createElement('textarea');field.value=text;field.className='sr-only';document.body.append(field);field.focus();field.select();const ok=document.execCommand('copy');field.remove();if(!ok)throw Error('copy');}toast(message||'Скопировано');return true;}catch{toast('Не удалось скопировать. Нажмите и удерживайте кнопку подключения, чтобы скопировать ссылку.');return false;}}
$('#copy-connection').addEventListener('click',()=>copy(copyValue(selectedApp), selectedApp === 'karing' ? 'Ссылка скопирована. При импорте в Karing включите X-HWID.' : 'Ключ скопирован. Импортируйте его в '+apps[selectedApp].label+'.'));
$('#share-connection').addEventListener('click',async()=>{const text=appLink(selectedApp).getAttribute('href');if(navigator.share){try{await navigator.share({title:document.title,text});}catch(e){if(e.name!=='AbortError')await copy(text,'Ключ скопирован — отправьте его на другое устройство.');}}else await copy(text,'Ключ скопирован — отправьте его на другое устройство.');});
$$('[data-payment-copy]').forEach(b=>b.addEventListener('click',()=>copy(b.dataset.paymentCopy,'Скопировано: '+b.dataset.paymentCopy)));
$$('form[data-confirm]').forEach(f=>f.addEventListener('submit',e=>{if(!window.confirm(f.dataset.confirm))e.preventDefault();}));
function viewFromHash(hash){return hash==='#devices'?'devices':hash==='#traffic'?'traffic':hash==='#renew'||hash.startsWith('#order-')?'shop':'subscription';}
function showView(hash,scroll){const view=viewFromHash(hash);document.body.dataset.view=view;document.body.dataset.enhanced='1';$$('[data-tab-panel]').forEach(p=>p.hidden=p.dataset.tabPanel!==view);$$('[data-tab]').forEach(a=>{if(a.dataset.tab===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});if(scroll)window.scrollTo({top:0,behavior:'instant'});if(hash.startsWith('#order-')){const order=document.getElementById(hash.slice(1));if(order){order.scrollIntoView({block:'start'});order.focus({preventScroll:true});}}}
document.addEventListener('click',e=>{const a=e.target.closest('a[href^="#"]');if(!a)return;const hash=a.getAttribute('href');if(!['#subscription','#traffic','#devices','#renew'].includes(hash))return;e.preventDefault();history.replaceState(null,'',hash);showView(hash,true);});
window.addEventListener('hashchange',()=>showView(location.hash,true));
showView(location.hash,false);
const months=$('#months'),devices=$('#device-count');
if(months&&devices){const c=JSON.parse($('#billing-prices').textContent),money=n=>(n/100).toLocaleString('ru-RU',{maximumFractionDigits:2})+' ₽';
function quote(){const m=Number(months.value),n=Number(devices.value),discount=m>=12?c.discount12:m>=6?c.discount6:m>=3?c.discount3:0,monthly=Math.round(Number(c.monthlyRub)*100)+Math.max(0,n-c.includedDevices)*Math.round(Number(c.deviceRub)*100),amount=Math.round(monthly*m*(100-discount)/100);$('#quote-total').textContent=money(amount);if($('#dock-price'))$('#dock-price').textContent=money(amount);$('#quote-detail').textContent=money(monthly)+' в месяц · '+m*30+' дней';$('#quote-months').textContent=m+' мес. / '+m*30+' дней';$('#quote-devices').textContent=n;$('#quote-discount').textContent=discount?'−'+discount+'%':'Без скидки';$$('[data-month]').forEach(b=>{const on=Number(b.dataset.month)===m;b.classList.toggle('selected',on);b.setAttribute('aria-pressed',String(on));});}
months.addEventListener('change',quote);devices.addEventListener('change',quote);$$('[data-month]').forEach(b=>b.addEventListener('click',()=>{months.value=b.dataset.month;quote();}));$$('[data-add-device]').forEach(a=>a.addEventListener('click',()=>{const used=Number(a.dataset.currentLimit)||c.includedDevices;devices.value=String(Math.min(Number(devices.options[devices.options.length-1].value),Math.max(c.includedDevices+1,used+1)));quote();}));quote();}
})();
