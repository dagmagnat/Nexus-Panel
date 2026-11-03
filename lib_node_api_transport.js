'use strict';
const net = require('node:net'), http = require('node:http'), https = require('node:https');
function normalizeApiIp(value) {
  const ip = String(value ?? '').trim().replace(/^\[|\]$/g,'');
  if (!ip) return '';
  if (!net.isIP(ip) || ip === '0.0.0.0' || ip === '::') throw new Error('IP для API: укажите IPv4 или IPv6 без порта и пути.');
  return net.isIP(ip) === 6 ? new URL('http://['+ip+']/').hostname.slice(1,-1) : ip;
}
function apiIpFormValue(body, existing = {}) {
  return Object.prototype.hasOwnProperty.call(body,'api_connect_ip') ? normalizeApiIp(body.api_connect_ip) : existing.api_connect_ip || '';
}
function apiTransport(node) {
  const ip = normalizeApiIp(node.api_connect_ip);
  if (!ip) return {};
  const url = new URL(node.panel_url), host = url.hostname.replace(/^\[|\]$/g,'');
  if (!['http:','https:'].includes(url.protocol)) throw new Error('API требует http:// или https://');
  if (net.isIP(host) && normalizeApiIp(host) !== ip) throw new Error('IP в API URL не совпадает с выбранным IP для API. Используйте домен панели либо один и тот же IP.');
  const lookup = (_host, options, callback) => {
    if (typeof options === 'function') { callback=options;options={}; }
    const family=net.isIP(ip);
    if (options?.all) callback(null,[{address:ip,family}]);
    else callback(null,ip,family);
  };
  // Keep URL, Host, SNI and certificate verification on the panel domain.
  const Agent = url.protocol === 'https:' ? https.Agent : http.Agent;
  return {agent:new Agent({lookup}),redirect:'error'};
}
async function apiAddressWarning(node, lookup = require('node:dns').promises.lookup) {
  const host=new URL(node.panel_url).hostname.replace(/^\[|\]$/g,'');
  if (node.api_connect_ip || net.isIP(host)) return '';
  let timer;
  try {
    const records=await Promise.race([lookup(host,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DNS timeout')),800);})]);
    if (new Set(records.map(r=>r.address)).size>1) return 'API-домен возвращает несколько IP. Если это разные панели 3x-ui, укажите IP именно этой панели в поле «IP сервера для API». Иначе параметры и операции могут попадать на другой сервер.';
    return '';
  } catch { return 'Не удалось отдельно проверить адреса API-домена. Проверьте DNS либо задайте IP сервера для API.'; }
  finally { clearTimeout(timer); }
}
module.exports={normalizeApiIp,apiIpFormValue,apiTransport,apiAddressWarning};
