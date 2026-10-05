'use strict';
(() => {
  const el=id=>document.getElementById(id), selected=new Set();
  let nodes=[], activeNode=null, busy=false, generation=0;
  const gb=n=>(Number(n||0)/1024**3).toLocaleString('ru-RU',{maximumFractionDigits:3})+' ГБ';
  const stamp=n=>n?new Date(Number(n)).toLocaleString('ru-RU'):'ещё не собрана';
  const make=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
  function cell(row,text,small){const c=make('td',text);if(small)c.append(make('small',small));row.append(c);return c;}
  function labels(tbody,values){for(const row of tbody.rows)for(let i=0;i<row.cells.length;i++)row.cells[i].dataset.label=values[i]||'';}
  function showClients(){
    el('ntClientSection').hidden=false;
    el('ntNodeTitle').textContent=activeNode ? (nodes.find(n=>n.id===activeNode)?.name || 'Узел') : 'Клиенты всех узлов';
    const node=nodes.find(n=>n.id===activeNode);
    el('ntScope').textContent=node?.physicalUuid ? 'Физическая нода Remnawave: '+node.physicalUuid : 'Счётчики разделены по узлам. У XUI история начинается с первых двух опросов Nexus.';
    const q=el('ntSearch').value.trim().toLowerCase(), tbody=el('ntClients');tbody.replaceChildren();
    const rows=new Map();
    for(const n of nodes.filter(n=>!activeNode || n.id===activeNode)) for(const c of n.clients){
      if(q && !`${c.login} ${c.display_name||''}`.toLowerCase().includes(q))continue;
      if(!rows.has(c.id))rows.set(c.id,{...c,period_bytes:0,used_bytes:0,limits:[],errors:[],updated_at:c.updated_at});
      const r=rows.get(c.id);r.period_bytes+=c.period_bytes;r.used_bytes+=c.used_bytes;r.limits.push(n.name+': '+gb(c.used_bytes)+' / '+(c.traffic_gb>0?c.traffic_gb+' ГБ':'∞'));
      r.blocked=Boolean(r.blocked||c.blocked);
      if(c.error)r.errors.push(c.error);else if(!c.updated_at)r.errors.push('Нет проверенных данных');
    }
    for(const c of [...rows.values()].sort((a,b)=>b.period_bytes-a.period_bytes)){
      const tr=make('tr');tr.dataset.clientId=c.id;
      const check=make('input');check.type='checkbox';check.name='client_ids';check.value=c.id;check.checked=selected.has(c.id);check.setAttribute('aria-label','Выбрать '+c.login);
      check.addEventListener('change',()=>{if(check.checked)selected.add(c.id);else selected.delete(c.id);updateSelection();});cell(tr).append(check);
      const link=make('a',c.display_name||c.login);link.href='/clients?q='+encodeURIComponent(c.login)+'&edit='+c.id;cell(tr,undefined,c.display_name?c.login:'').prepend(link);
      cell(tr,c.updated_at?gb(c.period_bytes):'—');cell(tr,c.updated_at?gb(c.used_bytes):'—',c.limits.join(' · '));
      cell(tr,c.errors.length?'Требует внимания':c.blocked?'Лимит исчерпан':'Данные собраны',c.errors.join(' · ')||'Обновлено: '+stamp(c.updated_at)).className=c.errors.length?'nt-warning':'';
      const reset=make('button','Сбросить');reset.type='button';reset.addEventListener('click',()=>{selected.clear();selected.add(c.id);el('ntResetNode').value=activeNode||'all';showClients();el('ntResetForm').requestSubmit();});cell(tr).append(reset);tbody.append(tr);
    }
    if(!rows.size){const tr=make('tr');const c=cell(tr,'Клиенты не найдены.');c.colSpan=6;tbody.append(tr);}
    labels(tbody,['Выбор','Клиент','За период','Счётчик лимита','Состояние','Действие']);
    updateSelection();
  }
  function updateSelection(){el('ntSelected').textContent='Выбрано: '+selected.size;el('ntResetButton').disabled=!selected.size||busy;}
  function render(){
    el('ntCount').textContent=nodes.length;
    el('ntTotal').textContent=nodes.some(n=>n.clients.some(c=>c.updated_at))?gb(nodes.reduce((s,n)=>s+n.totalBytes,0)):'—';
    el('ntUnavailable').textContent=nodes.filter(n=>n.clients.some(c=>c.error||!c.updated_at)).length;
    const tbody=el('ntNodes');tbody.replaceChildren();
    for(const n of nodes){
      const tr=make('tr');if(n.id===activeNode)tr.className='is-selected';
      const button=make('button',n.name,'nt-node-button');button.type='button';button.addEventListener('click',()=>{activeNode=n.id;selected.clear();render();el('ntResetNode').value=n.id;showClients();el('ntClientSection').scrollIntoView({behavior:'smooth',block:'start'});});
      cell(tr,undefined,n.node_type==='remnawave'?'Remnawave':'3x-ui').append(button);
      const known=n.clients.filter(c=>c.updated_at);cell(tr,known.length?gb(n.totalBytes):'—');cell(tr,n.clients.length);
      const issues=n.clients.filter(c=>c.error||!c.updated_at), first=n.clients.map(c=>c.first_day).filter(Boolean).sort()[0];
      cell(tr,issues.length?`Неактуальные / недоступные: ${issues.length}`:'Собрано',`История с ${first||'—'}${n.node_type==='remnawave'?' · API '+(known[0]?.api_version||'проверка возможностей'):''}`).className=issues.length?'nt-warning':'';tbody.append(tr);
    }
    if(!nodes.length){const tr=make('tr');cell(tr,'Нет добавленных узлов.').colSpan=4;tbody.append(tr);}
    labels(tbody,['Узел','За период','Клиентов','Источник / состояние']);
    const old=el('ntResetNode').value;el('ntResetNode').replaceChildren();
    for(const n of nodes){const option=make('option',n.name);option.value=n.id;el('ntResetNode').append(option);}
    const all=make('option','Все узлы + общий счётчик Remnawave');all.value='all';el('ntResetNode').append(all);
    el('ntResetNode').value=activeNode||old||'all';
    if(!el('ntClientSection').hidden)showClients();
  }
  async function load(refresh=false){
    const seq=++generation;busy=true;el('ntRefresh').disabled=true;updateSelection();el('ntStatus').textContent=refresh?'Сбор с удалённых панелей… Можно продолжать просмотр сохранённых данных.':'Загрузка…';
    try{
      const query=new URLSearchParams({from:el('ntFrom').value,to:el('ntTo').value});if(refresh)query.set('refresh','1');
      const res=await fetch('/node-traffic/data.json?'+query,{headers:{Accept:'application/json'}});const data=await res.json();if(seq!==generation)return;
      if(!res.ok||!data.ok)throw new Error(data.error||'Не удалось получить статистику');
      nodes=data.nodes;render();el('ntStatus').textContent='Последний полный опрос: '+stamp(data.updatedAt)+'.';
      const warnings=el('ntWarnings'),body=warnings.querySelector('div');body.replaceChildren();warnings.hidden=!(data.errors||[]).length;
      for(const error of [...new Set(data.errors||[])])body.append(make('p',error));
    }catch(e){if(seq===generation)el('ntStatus').textContent=e.message;}finally{if(seq===generation){busy=false;el('ntRefresh').disabled=false;updateSelection();}}
  }
  function preset(days){const now=new Date(),end=now.toISOString().slice(0,10);el('ntTo').value=end;el('ntTo').max=end;el('ntFrom').max=end;el('ntFrom').value=new Date(now.getTime()-(days-1)*86400000).toISOString().slice(0,10);load();}
  el('ntRange').addEventListener('submit',e=>{e.preventDefault();load();});
  document.querySelectorAll('[data-nt-days]').forEach(b=>b.addEventListener('click',()=>preset(Number(b.dataset.ntDays))));
  el('ntRefresh').addEventListener('click',()=>load(true));el('ntSearch').addEventListener('input',showClients);
  el('ntAllNodes').addEventListener('click',()=>{activeNode=null;selected.clear();el('ntResetNode').value='all';render();showClients();});
  el('ntSelectAll').addEventListener('click',()=>{el('ntClients').querySelectorAll('input[name=client_ids]').forEach(c=>{c.checked=true;selected.add(Number(c.value));});updateSelection();});
  el('ntSelectNone').addEventListener('click',()=>{selected.clear();showClients();});
  el('ntResetForm').addEventListener('submit',e=>{
    if(!selected.size||!confirm(`Сбросить счётчики ${selected.size} выбранным клиентам?\nУзлы: ${el('ntResetNode').selectedOptions[0]?.textContent}\nИстория расхода сохраняется.`)){e.preventDefault();return;}
    el('ntResetForm').querySelectorAll('[data-hidden-selection]').forEach(i=>i.remove());
    // Checked visible rows plus hidden selections outside the search filter.
    const visible=new Set([...el('ntClients').querySelectorAll('input[name=client_ids]:checked')].map(c=>Number(c.value)));
    for(const id of selected)if(!visible.has(id)){const input=make('input');input.type='hidden';input.name='client_ids';input.value=id;input.dataset.hiddenSelection='1';el('ntResetForm').append(input);}
  });
  preset(7);setInterval(()=>{if(!busy&&!document.hidden)load();},30000);
})();
