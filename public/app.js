(() => {
  'use strict';
  const quadrants=[
    {id:'q2',title:'计划去做',priority:'重要 · 不紧急',icon:'calendar',hint:'安排值得提前规划的事'},
    {id:'q1',title:'立即行动',priority:'重要 · 紧急',icon:'bolt',hint:'优先推进今天最重要的事'},
    {id:'q4',title:'暂时搁置',priority:'不重要 · 不紧急',icon:'coffee',hint:'暂存以后再看的事'},
    {id:'q3',title:'灵活安排',priority:'不重要 · 紧急',icon:'clock',hint:'收纳可顺手或委派的事'}
  ];
  const $=s=>document.querySelector(s),esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon=n=>`<svg aria-hidden="true"><use href="#i-${n}"/></svg>`;
  let doc={tasks:[],trash:[],revision:0},filter='all',search='',lastTarget='q1',editing=null,menu=null,moveMenu=null,deletedOpen=false,dragId=null,ready=false,saving=0,sending=false,queue=Promise.resolve();
  const qTitle=id=>quadrants.find(q=>q.id===id).title;
  function note(text,retry,error=false,actionLabel='重试'){
    const el=$('#feedback'),visible=error;
    el.replaceChildren(document.createTextNode(text));
    el.classList.toggle('sr-only',!visible);el.classList.toggle('inline-feedback',visible);
    document.querySelector('main').classList.toggle('has-feedback',visible);
    if(error&&retry){const b=document.createElement('button');b.type='button';b.textContent=actionLabel;b.onclick=retry;el.append(b);}
  }
  function status(text,error=false){$('#task-form').classList.toggle('save-error',error);if(error)note(text,load,true,'重试');else note('');}
  async function request(url,method='GET',value){const response=await fetch(url,{method,headers:method==='GET'?{}:{'Content-Type':'application/json'},body:method==='GET'?undefined:JSON.stringify(value??{})});let data;try{data=await response.json();}catch{throw Error('本地服务返回了无法读取的数据');}if(!response.ok)throw Error(data.error||'保存失败');return data;}
  async function load(){try{const value=await request('/api/data');doc=value;ready=true;status('已写入 本地数据库');render();}catch(error){ready=false;status('本地服务未连接',true);note(error.message,load,true,'重试');render();}}
  function change(url,method,value,onSuccess){
    const run=async()=>{saving++;status('写入中…');try{const result=await request(url,method,value);doc=result;ready=true;onSuccess?.(result);status('已写入 本地数据库');render();return result;}catch(error){status('未保存，请重试',true);note(error.message,load,true,'重试');throw error;}finally{saving--;}};
    const operation=queue.then(run,run);queue=operation.catch(()=>{});return operation;
  }
  const visible=t=>(filter==='trash'||filter==='all'||filter==='done'&&t.done||filter==='pending'&&!t.done||filter==='processing'&&!t.done&&t.inProgress)&&t.text.toLocaleLowerCase().includes(search);
  const taskDateFormatter=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function formatDateParts(value){
    if(!value||!Number.isFinite(Date.parse(value)))return null;
    const date=new Date(value),parts=Object.fromEntries(taskDateFormatter.formatToParts(date).map(part=>[part.type,part.value]));
    return {date,parts};
  }
  function timeValue(value){
    const formatted=formatDateParts(value);
    if(!formatted)return '<span class="task-time-unknown">未记录</span>';
    const {date,parts}=formatted;
    return `<time datetime="${date.toISOString()}"><span class="task-time-date">${parts.year}/${parts.month}/${parts.day}</span><span class="task-time-clock">${parts.hour}:${parts.minute}:${parts.second}</span></time>`;
  }
  function deletedTimeText(value){
    const formatted=formatDateParts(value);
    if(!formatted)return '最近删除';
    const {parts}=formatted;
    return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
  }
  function taskTimeline(t){
    return `<dl class="task-timeline" aria-label="任务时间（北京时间）"><div class="task-time-row"><dt>创建</dt><dd>${timeValue(t.createdAt)}</dd></div>${t.done?`<div class="task-time-row time-completed"><dt>完成</dt><dd>${timeValue(t.completedAt)}</dd></div>`:''}</dl>`;
  }
  const menuAnchor=()=>Array.from(document.querySelectorAll('.task-card')).find(card=>card.dataset.id===menu)?.querySelector('.more-task');
  function positionTaskMenu(){
    const panel=$('#task-menu'),anchor=menuAnchor();
    if(panel.hidden||!anchor?.getBoundingClientRect)return;
    const rect=anchor.getBoundingClientRect(),viewport=window.visualViewport;
    const left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight;
    const list=anchor.closest('.task-list').getBoundingClientRect();
    if(rect.bottom<=list.top||rect.top>=list.bottom||rect.right<=list.left||rect.left>=list.right){closeTaskMenu();return;}
    panel.style.maxHeight=`${Math.max(0,height-16)}px`;
    const size=panel.getBoundingClientRect(),below=top+height-rect.bottom-6,above=rect.top-top-6;
    const up=size.height>below&&above>below;
    panel.dataset.side=up?'above':'below';
    panel.style.left=`${Math.max(left+8,Math.min(rect.right-size.width,left+width-size.width-8))}px`;
    panel.style.top=`${Math.max(top+8,Math.min(up?rect.top-size.height-6:rect.bottom+6,top+height-size.height-8))}px`;
  }
  function renderTaskMenu(){
    const panel=$('#task-menu'),task=doc.tasks.find(t=>t.id===menu&&visible(t));
    if(!task||editing?.id===menu||deletedOpen){menu=null;moveMenu=null;panel.hidden=true;panel.innerHTML='';delete panel.dataset.id;return;}
    panel.dataset.id=task.id;panel.className=`task-menu ${task.quadrant}`;
    const actions=moveMenu===task.id?`<div class="move-actions" role="group" aria-label="移动任务"><button data-action="move-menu" class="menu-back">${icon('arrow')}<span>返回任务操作</span></button>${['q1','q2','q3','q4'].map(id=>quadrants.find(q=>q.id===id)).map(q=>`<button data-action="move" data-q="${q.id}" class="${q.id}"${q.id===task.quadrant?' disabled aria-label="'+q.title+'，当前象限"':''}><span class="menu-quadrant-dot"></span><span>${q.title}</span>${q.id===task.quadrant?`<span class="menu-tail">${icon('check')}</span>`:''}</button>`).join('')}</div>`:`<div class="task-actions" role="group" aria-label="任务操作"><button data-action="edit"><span class="menu-lead">${icon('edit')}</span><span>编辑</span></button>${!task.done?`<button data-action="progress" aria-pressed="${Boolean(task.inProgress)}"><span class="menu-lead">${icon('progress')}</span><span>${task.inProgress?'恢复待办':'开始处理'}</span></button>`:''}<button data-action="toggle"><span class="menu-lead">${icon('done')}</span><span>${task.done?'恢复待办':'完成'}</span></button><button data-action="move-menu" aria-expanded="false"><span class="menu-lead">${icon('move')}</span><span>移动</span><span class="menu-chevron">${icon('arrow')}</span></button><button data-action="delete" class="delete-action"><span class="menu-lead">${icon('trash')}</span><span>删除</span></button></div>`;
    const markup=taskTimeline(task)+actions;
    if(panel.innerHTML!==markup)panel.innerHTML=markup;
    panel.hidden=false;positionTaskMenu();
  }
  function closeTaskMenu(restoreFocus=false){
    if(!menu)return;const anchor=menuAnchor(),card=anchor?.closest('.task-card');menu=null;moveMenu=null;renderTaskMenu();
    anchor?.setAttribute('aria-expanded','false');card?.classList.remove('has-actions');if(card)card.draggable=true;
    if(restoreFocus)anchor?.focus({preventScroll:true});
  }
  function focusTaskMenu(last=false){
    const buttons=Array.from($('#task-menu').querySelectorAll?.('button:not([disabled])')||[]);
    (last?buttons.at(-1):buttons[0])?.focus({preventScroll:true});
  }
  function row(t){
    const id=esc(t.id),trash=filter==='trash',edit=editing?.id===t.id,arriving=window.workboardMotion?.isArriving(t.id);
    const count=Math.min(60,Math.max(5,Array.from(edit?editing.text:t.text).reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0)));
    return `<article class="task-card${t.done?' is-done':t.inProgress?' is-processing':''}${edit?' is-editing':''}${menu===t.id?' has-actions':''}${arriving?' is-arriving':''}"${arriving?' inert':''} data-id="${id}" draggable="${!trash&&!edit&&menu!==t.id}"><button class="task-check" data-action="${trash?'restore':'toggle'}" aria-label="${trash?'恢复任务':t.done?'恢复待办':'完成任务'}：${esc(t.text)}" aria-pressed="${t.done}">${icon(trash?'arrow':'check')}</button>${edit?`<label class="sr-only" for="edit-${id}">编辑任务内容</label><input class="inline-input" id="edit-${id}" maxlength="500" value="${esc(editing.text)}" style="--input-ch:${count}" autocomplete="off"><button class="small-action" data-action="save" aria-label="保存编辑">${icon('check')}</button><button class="small-action" data-action="cancel" aria-label="取消编辑">${icon('close')}</button>`:`<button class="task-text" data-action="${trash?'menu':'edit'}" aria-label="${trash?'查看删除任务':'编辑任务'}：${esc(t.text)}"><span class="task-title">${esc(t.text)}</span>${t.inProgress&&!t.done?`<span class="task-progress" aria-label="任务状态：处理中">${icon('progress')}<span>处理中</span></span>`:''}</button><button class="more-task" data-action="menu" aria-label="任务操作：${esc(t.text)}" aria-controls="task-menu" aria-expanded="${menu===t.id}">${icon('more')}</button>`}</article>`;
  }
  function patchMatrix(markup){
    const matrix=$('#matrix'),sections=Array.from(matrix.querySelectorAll?.('.quadrant')||[]);
    if(sections.length!==quadrants.length){matrix.innerHTML=markup;return;}
    const template=document.createElement('template');template.innerHTML=markup;
    Array.from(template.content.querySelectorAll('.quadrant')).forEach((next,index)=>{
      const current=sections[index];
      current.querySelector('.quadrant-count').textContent=next.querySelector('.quadrant-count').textContent;
      const list=current.querySelector('.task-list'),previous=new Map(Array.from(list.children).map(node=>[node.dataset.id||'empty',node]));
      Array.from(next.querySelector('.task-list').children).forEach((node,position)=>{
        const key=node.dataset.id||'empty',old=previous.get(key);previous.delete(key);
        if(old?.isEqualNode(node))node=old;else if(old)old.replaceWith(node);
        if(list.children[position]!==node)list.insertBefore(node,list.children[position]||null);
      });
      previous.forEach(node=>node.remove());
    });
  }
  let drawerAnimation=null,backdropAnimation=null,returnDrawerFocus=false,pendingPurge=null,confirmClear=false,deletedBusy=false;
  function syncDrawerBackground(){
    const blocked=deletedOpen||Boolean(drawerAnimation);
    $('.topbar').inert=blocked;$('main').inert=blocked;
    if(!blocked&&returnDrawerFocus){returnDrawerFocus=false;$('#trash-toggle').focus({preventScroll:true});}
  }
  function renderDeleted(){
    $('#trash-toggle').setAttribute('aria-expanded',String(deletedOpen));
    $('#trash-toggle').setAttribute('aria-label',`最近删除（${doc.trash.length}）`);
    const badge=$('#trash-badge');
    if(badge){badge.textContent=doc.trash.length?String(doc.trash.length):'';badge.hidden=!doc.trash.length;}
    const panel=$('#recent-deleted'),backdrop=$('#drawer-backdrop'),wasOpen=panel.dataset.open==='true';
    panel.dataset.open=String(deletedOpen);
    panel.setAttribute('aria-hidden',String(!deletedOpen));panel.inert=!deletedOpen;
    if(wasOpen!==deletedOpen){
      const previous=drawerAnimation&&window.getComputedStyle?.(panel);
      const previousBackdrop=backdropAnimation&&window.getComputedStyle?.(backdrop);
      drawerAnimation?.cancel();backdropAnimation?.cancel();drawerAnimation=null;backdropAnimation=null;
      const reduced=window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      if(typeof panel.animate==='function'&&typeof backdrop.animate==='function'&&!reduced&&!document.hidden){
        panel.hidden=false;backdrop.hidden=false;
        try{
          const animation=panel.animate([
            {transform:previous?.transform||(wasOpen?'translateX(0)':'translateX(calc(100% + 24px))'),opacity:previous?.opacity??(wasOpen?1:0)},
            {transform:deletedOpen?'translateX(0)':'translateX(calc(100% + 24px))',opacity:deletedOpen?1:0}
          ],{duration:260,easing:'cubic-bezier(.22,.75,.22,1)',fill:'both'});
          drawerAnimation=animation;
          backdropAnimation=backdrop.animate([{opacity:previousBackdrop?.opacity??(wasOpen?1:0)},{opacity:deletedOpen?1:0}],{duration:260,easing:'cubic-bezier(.22,.75,.22,1)',fill:'both'});
          backdropAnimation.finished.catch(()=>{});
          animation.finished.then(()=>{if(drawerAnimation!==animation)return;drawerAnimation=null;panel.hidden=!deletedOpen;backdrop.hidden=!deletedOpen;animation.cancel();backdropAnimation?.cancel();backdropAnimation=null;syncDrawerBackground();},()=>{});
        }catch{drawerAnimation?.finished.catch(()=>{});drawerAnimation?.cancel();backdropAnimation?.cancel();drawerAnimation=null;backdropAnimation=null;panel.hidden=!deletedOpen;backdrop.hidden=!deletedOpen;}
      }else{panel.hidden=!deletedOpen;backdrop.hidden=!deletedOpen;}
    }else if(!drawerAnimation){panel.hidden=!deletedOpen;backdrop.hidden=!deletedOpen;}
    syncDrawerBackground();
    $('#deleted-count').textContent=`${doc.trash.length} 项`;
    if(!doc.trash.length){confirmClear=false;pendingPurge=null;}
    $('#clear-deleted').disabled=deletedBusy||!doc.trash.length;
    $('#clear-deleted').setAttribute('aria-expanded',String(confirmClear));
    $('#clear-deleted-confirm').hidden=!confirmClear;
    $('#confirm-clear-deleted').disabled=deletedBusy;
    $('#cancel-clear-deleted').disabled=deletedBusy;
    if(!deletedOpen)return;
    const disabled=deletedBusy?' disabled':'';
    const markup=doc.trash.slice().sort((a,b)=>Date.parse(b.deletedAt)-Date.parse(a.deletedAt)).map(({task,deletedAt})=>`<article class="deleted-item"><div class="deleted-item-body"><span class="deleted-item-text">${esc(task.text)}</span><div class="deleted-item-meta ${esc(task.quadrant)}"><span class="menu-quadrant-dot"></span><span>${esc(qTitle(task.quadrant))}</span><span aria-hidden="true">·</span><span>${esc(deletedTimeText(deletedAt))}</span></div></div><div class="deleted-item-actions"><button class="restore-task" data-restore="${esc(task.id)}" aria-label="恢复任务：${esc(task.text)}"${disabled}>恢复</button><button class="purge-task" data-purge="${esc(task.id)}" aria-label="永久删除任务：${esc(task.text)}" aria-expanded="${pendingPurge===task.id}"${disabled}>删除</button></div>${pendingPurge===task.id?`<div class="delete-confirm" role="group" aria-label="永久删除确认"><span>永久删除此任务？此操作无法恢复。</span><button class="confirm-danger" data-confirm-purge="${esc(task.id)}"${disabled}>确认删除</button><button data-cancel-purge${disabled}>取消</button></div>`:''}</article>`).join('')||'<p class="deleted-empty">没有已删除的任务</p>';
    if($('#deleted-list').innerHTML!==markup)$('#deleted-list').innerHTML=markup;
  }
  function closeDeletedDrawer(){deletedOpen=false;confirmClear=false;pendingPurge=null;returnDrawerFocus=true;renderDeleted();}
  async function purgeDeleted(id){
    if(deletedBusy)return;deletedBusy=true;renderDeleted();
    try{await change(id?`/api/trash/${encodeURIComponent(id)}`:'/api/trash','DELETE',{},()=>{pendingPurge=null;confirmClear=false;});}catch{}
    finally{deletedBusy=false;renderDeleted();$('#close-deleted').focus({preventScroll:true});}
  }
  function render(reset){
    const active=document.activeElement,focusedCard=active?.closest?.('[data-id]');
    const focused=focusedCard?{id:focusedCard.dataset.id,action:active.dataset.action,quadrant:focusedCard.closest('[data-quadrant]')?.dataset.quadrant}:null;
    const scrolls=Object.fromEntries(Array.from(document.querySelectorAll('.quadrant')).map(q=>[q.dataset.quadrant,q.querySelector('.task-list').scrollTop]));
    const counts={pending:doc.tasks.filter(t=>!t.done).length,processing:doc.tasks.filter(t=>!t.done&&t.inProgress).length,all:doc.tasks.length,done:doc.tasks.filter(t=>t.done).length};
    const labels={pending:'待办',processing:'处理中',all:'全部',done:'已完成'};
    document.querySelectorAll('[data-filter]').forEach(b=>{const label=labels[b.dataset.filter],count=counts[b.dataset.filter];b.innerHTML=`<span>${label}</span><span class="filter-count">${count}</span>`;b.setAttribute('aria-label',`${label} ${count}`);b.classList.toggle('selected',b.dataset.filter===filter);b.setAttribute('aria-pressed',String(b.dataset.filter===filter));});
    const shown=(filter==='trash'?doc.trash.map(e=>e.task):doc.tasks).filter(visible);
    patchMatrix(quadrants.map(q=>{const list=shown.filter(t=>t.quadrant===q.id).sort((a,b)=>Number(a.done)-Number(b.done)||Date.parse(a.createdAt)-Date.parse(b.createdAt));const empty=search?`${icon('search')}<span>没有匹配的任务</span>`:`<span>${!ready?'正在连接本地数据…':filter==='trash'?'没有删除的任务':filter==='processing'?'暂无处理中的任务':filter==='done'?'暂无已完成的任务':q.hint}</span>`;return `<section class="quadrant ${q.id}" data-quadrant="${q.id}" aria-label="${q.title}：${q.priority}"><div class="quadrant-heading"><span class="quadrant-icon">${icon(q.icon)}</span><h2>${q.title}</h2><span class="quadrant-count">${list.length}</span></div><div class="task-list" tabindex="0" role="region" aria-label="${q.title}任务列表">${list.map(row).join('')}${list.length?'':`<div class="empty-quadrant">${empty}</div>`}</div></section>`;}).join(''));
    document.querySelectorAll('.quadrant').forEach(q=>q.querySelector('.task-list').scrollTop=q.dataset.quadrant===reset?0:scrolls[q.dataset.quadrant]||0);
    document.querySelectorAll('[data-send]').forEach(b=>{b.disabled=!ready||sending;b.classList.toggle('last-target',b.dataset.send===lastTarget);});
    window.workboardMotion?.synchronize();
    renderTaskMenu();
    renderDeleted();
    if(focused&&document.activeElement!==active){
      const card=Array.from(document.querySelectorAll('.task-card')).find(node=>node.dataset.id===focused.id);
      const panel=$('#task-menu'),popupTarget=!panel.hidden&&panel.dataset.id===focused.id&&Array.from(panel.querySelectorAll?.('[data-action]')||[]).find(node=>node.dataset.action===focused.action);
      const target=popupTarget||card&&(Array.from(card.querySelectorAll('[data-action]')).find(node=>node.dataset.action===focused.action)||card.querySelector('.more-task'));
      (target||$(`.quadrant[data-quadrant="${focused.quadrant}"] .task-list`))?.focus({preventScroll:true});
    }
  }
  function focusEdit(){const input=$('.inline-input');if(input){input.focus();input.setSelectionRange(input.value.length,input.value.length);}}
  async function finishEdit(cancel=false){
    if(!editing)return;const draft=editing;editing=null;
    if(cancel){render();return;}
    const t=doc.tasks.find(t=>t.id===draft.id),text=draft.text.trim();
    if(!t||text===t.text){render();return;}
    if(!text){note('任务内容不能为空，已保留原内容');render();return;}
    try{await change(`/api/tasks/${encodeURIComponent(t.id)}`,'PATCH',{text},()=>note('内容已保存'));}catch{if(!editing){editing=draft;render();focusEdit();}}
  }
  async function send(target){
    lastTarget=target;const text=$('#task-input').value.trim();
    if(!text){note(`写下任务后，点「${qTitle(target)}」发送`);$('#task-input').focus();return;}
    if(!ready||sending)return;sending=true;render();
    try{const result=await change('/api/tasks','POST',{text,quadrant:target},()=>{if($('#task-input').value.trim()===text)$('#task-input').value='';if(filter==='done'||filter==='trash'||filter==='processing')filter='pending';search='';$('#search-input').value='';note(`已发送到「${qTitle(target)}」`);});render();const targetList=$(`.quadrant[data-quadrant="${target}"] .task-list`);if(targetList){const createdCard=Array.from(targetList.querySelectorAll?.('.task-card')||[]).find(card=>card.dataset.id===result.result.id);if(createdCard?.scrollIntoView)createdCard.scrollIntoView({block:'nearest'});else targetList.scrollTop=targetList.scrollHeight;window.workboardMotion?.flyIn(result.result.id,targetList,$('#task-input').getBoundingClientRect?.());}$('#task-input').focus();}catch{}finally{sending=false;document.querySelectorAll('[data-send]').forEach(b=>b.disabled=!ready);}
  }
  $('.send-targets').innerHTML=['q1','q2','q3','q4'].map(id=>quadrants.find(q=>q.id===id)).map(q=>`<button type="button" data-send="${q.id}" class="send-target ${q.id}" aria-label="发送到${q.title}">${icon(q.icon)}<span>${q.title}</span></button>`).join('');
  $('.send-targets').addEventListener('click',e=>{const b=e.target.closest('[data-send]');if(b)send(b.dataset.send);});
  $('#task-form').addEventListener('submit',e=>{e.preventDefault();send(lastTarget);});
  $('#matrix').addEventListener('input',e=>{if(e.target.matches('.inline-input')&&editing){editing.text=e.target.value;e.target.style.setProperty('--input-ch',Math.min(60,Math.max(5,Array.from(e.target.value).reduce((n,c)=>n+(c.charCodeAt(0)>255?2:1),0))));}});
  $('#matrix').addEventListener('keydown',e=>{if(!e.target.matches('.inline-input')||e.isComposing)return;if(e.key==='Enter'){e.preventDefault();finishEdit();}if(e.key==='Escape'){e.preventDefault();finishEdit(true);}});
  $('#matrix').addEventListener('focusout',e=>{if(e.target.matches('.inline-input')&&!e.target.closest('.task-card').contains(e.relatedTarget))finishEdit();});
  async function handleTaskAction(e){
    const b=e.target.closest('[data-action]');if(!b)return;const card=b.closest('[data-id]'),id=card.dataset.id,t=(filter==='trash'?doc.trash.map(x=>x.task):doc.tasks).find(t=>t.id===id);if(!t)return;
    const action=b.dataset.action;
    if(action==='save'){finishEdit();return;}if(action==='cancel'){finishEdit(true);return;}
    if(action==='edit'){if(editing?.id===id)return;if(editing)await finishEdit();editing={id,text:t.text};menu=null;moveMenu=null;render();focusEdit();return;}
    if(action==='menu'){if(editing)await finishEdit();menu=menu===id?null:id;moveMenu=null;render();return;}
    if(action==='move-menu'){moveMenu=moveMenu===id?null:id;render();focusTaskMenu();return;}
    try{
      if(action==='delete'){menu=null;moveMenu=null;await change(`/api/tasks/${encodeURIComponent(id)}`,'DELETE',{});}
      if(action==='restore'){menu=null;await change(`/api/tasks/${encodeURIComponent(id)}/restore`,'POST',{});}
      if(action==='progress'){menu=null;moveMenu=null;await change(`/api/tasks/${encodeURIComponent(id)}`,'PATCH',{inProgress:!t.inProgress});}
      if(action==='toggle'){menu=null;moveMenu=null;await change(`/api/tasks/${encodeURIComponent(id)}`,'PATCH',{done:!t.done});}
      if(action==='move'){menu=null;moveMenu=null;await change(`/api/tasks/${encodeURIComponent(id)}`,'PATCH',{quadrant:b.dataset.q});render(b.dataset.q);}
    }catch{}
  }
  $('#matrix').addEventListener('click',handleTaskAction);
  $('#task-menu').addEventListener('click',handleTaskAction);
  $('#task-menu').addEventListener('keydown',e=>{
    if(!['ArrowDown','ArrowUp','Home','End'].includes(e.key))return;
    e.preventDefault();const buttons=Array.from($('#task-menu').querySelectorAll('button:not([disabled])')),index=buttons.indexOf(document.activeElement);
    const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(index+(e.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length;
    buttons[next]?.focus({preventScroll:true});
  });
  $('#matrix').addEventListener('keydown',async e=>{
    if(!e.target.matches('.more-task')||!['ArrowDown','ArrowUp'].includes(e.key))return;
    e.preventDefault();if(menu!==e.target.closest('[data-id]').dataset.id)await handleTaskAction({target:e.target});focusTaskMenu(e.key==='ArrowUp');
  });
  $('#task-menu').addEventListener('focusout',e=>{if(menu&&e.relatedTarget&&!$('#task-menu').contains(e.relatedTarget)&&!e.relatedTarget.closest?.('.more-task'))closeTaskMenu();});
  document.addEventListener('pointerdown',e=>{if(menu&&!e.target.closest('#task-menu')&&!e.target.closest('.more-task'))closeTaskMenu();});
  document.addEventListener('focusin',e=>{if(menu&&!e.target.closest('#task-menu')&&!e.target.closest('.more-task'))closeTaskMenu();});
  document.addEventListener('scroll',e=>{if(menu&&e.target.classList?.contains('task-list'))closeTaskMenu();},true);
  window.addEventListener?.('resize',positionTaskMenu);
  window.visualViewport?.addEventListener('resize',positionTaskMenu);
  window.visualViewport?.addEventListener('scroll',positionTaskMenu);
  $('#matrix').addEventListener('dragstart',e=>{const card=e.target.closest('.task-card');if(!card||card.draggable===false){e.preventDefault();return;}dragId=card.dataset.id;e.dataTransfer.setData('text/plain',dragId);e.dataTransfer.effectAllowed='move';card.classList.add('dragging');});
  const stopDrag=()=>{dragId=null;document.querySelectorAll('.drop-active,.dragging').forEach(e=>e.classList.remove('drop-active','dragging'));};
  $('#matrix').addEventListener('dragover',e=>{const q=e.target.closest('[data-quadrant]');if(dragId&&q){e.preventDefault();document.querySelectorAll('.drop-active').forEach(x=>x.classList.remove('drop-active'));q.classList.add('drop-active');}});
  $('#matrix').addEventListener('dragleave',e=>{const q=e.target.closest('[data-quadrant]');if(q&&!q.contains(e.relatedTarget))q.classList.remove('drop-active');});
  $('#matrix').addEventListener('drop',async e=>{e.preventDefault();const q=e.target.closest('[data-quadrant]'),t=doc.tasks.find(t=>t.id===dragId);stopDrag();if(q&&t&&q.dataset.quadrant!==t.quadrant){try{await change(`/api/tasks/${encodeURIComponent(t.id)}`,'PATCH',{quadrant:q.dataset.quadrant},()=>note(`已移动到「${qTitle(q.dataset.quadrant)}」`));render(q.dataset.quadrant);}catch{}}});
  $('#matrix').addEventListener('dragend',stopDrag);
  document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',async()=>{await finishEdit();filter=b.dataset.filter;menu=null;moveMenu=null;render();}));
  $('#trash-toggle').addEventListener('click',async()=>{await finishEdit();closeTaskMenu();if(deletedOpen){closeDeletedDrawer();return;}deletedOpen=true;renderDeleted();$('#close-deleted').focus({preventScroll:true});});
  $('#close-deleted').addEventListener('click',closeDeletedDrawer);
  $('#drawer-backdrop').addEventListener('pointerdown',e=>e.preventDefault());
  $('#drawer-backdrop').addEventListener('click',closeDeletedDrawer);
  $('#clear-deleted').addEventListener('click',()=>{if(deletedBusy||!doc.trash.length)return;pendingPurge=null;confirmClear=!confirmClear;renderDeleted();if(confirmClear)$('#confirm-clear-deleted').focus({preventScroll:true});});
  $('#cancel-clear-deleted').addEventListener('click',()=>{confirmClear=false;renderDeleted();$('#clear-deleted').focus({preventScroll:true});});
  $('#confirm-clear-deleted').addEventListener('click',()=>{if(confirmClear)return purgeDeleted();});
  $('#deleted-list').addEventListener('click',async e=>{
    const button=e.target.closest('[data-restore],[data-purge],[data-confirm-purge],[data-cancel-purge]');if(!button||deletedBusy)return;
    if(button.dataset.purge){pendingPurge=button.dataset.purge;confirmClear=false;renderDeleted();$('#deleted-list').querySelector?.('[data-confirm-purge]')?.focus({preventScroll:true});return;}
    if(button.dataset.cancelPurge!==undefined){pendingPurge=null;renderDeleted();$('#close-deleted').focus({preventScroll:true});return;}
    if(button.dataset.confirmPurge){if(pendingPurge===button.dataset.confirmPurge)await purgeDeleted(pendingPurge);return;}
    if(!button.dataset.restore)return;
    deletedBusy=true;renderDeleted();
    try{await change(`/api/tasks/${encodeURIComponent(button.dataset.restore)}/restore`,'POST',{},()=>{pendingPurge=null;confirmClear=false;});}catch{}
    finally{deletedBusy=false;renderDeleted();($('#deleted-list').querySelector?.('[data-restore]')||$('#close-deleted')).focus({preventScroll:true});}
  });
  $('#search-input').addEventListener('input',e=>{search=e.target.value.trim().toLocaleLowerCase();render();document.querySelectorAll('.task-list').forEach(x=>x.scrollTop=0);});
  document.addEventListener('keydown',e=>{
    if(e.defaultPrevented||e.isComposing)return;
    if(e.key==='Escape'&&menu){e.preventDefault();if(moveMenu){moveMenu=null;render();focusTaskMenu();}else closeTaskMenu(true);return;}
    if(e.key==='Escape'&&deletedOpen){
      e.preventDefault();
      if(confirmClear||pendingPurge){confirmClear=false;pendingPurge=null;renderDeleted();$('#close-deleted').focus({preventScroll:true});}else closeDeletedDrawer();
      return;
    }
    if(e.key==='Tab'&&(deletedOpen||drawerAnimation)){
      const panel=$('#recent-deleted');
      const stops=Array.from(panel.querySelectorAll?.('button:not([disabled]),[href],input:not([disabled]),[tabindex]:not([tabindex="-1"])')||[]).filter(node=>!node.closest('[hidden]'));
      const first=stops[0],last=stops[stops.length-1],active=document.activeElement;
      if(!deletedOpen||!first){e.preventDefault();return;}
      if(e.shiftKey&&(active===first||!panel.contains(active))){e.preventDefault();last.focus({preventScroll:true});}
      else if(!e.shiftKey&&(active===last||!panel.contains(active))){e.preventDefault();first.focus({preventScroll:true});}
      return;
    }
    if(deletedOpen||drawerAnimation)return;
    if(e.ctrlKey||e.metaKey||e.altKey||['INPUT','TEXTAREA'].includes(document.activeElement.tagName))return;
    if(e.key==='/'){e.preventDefault();$('#search-input').focus();}
    if(e.key==='n'||e.key==='N'){e.preventDefault();$('#task-input').focus();}
  });
  setInterval(async()=>{if(saving||editing||document.hidden||!ready)return;try{const value=await request('/api/data');if(value.revision!==doc.revision||value.updatedAt!==doc.updatedAt){doc=value;render();status('已同步 本地数据库');}}catch{status('本地服务未连接',true);}},3000);
  render();load();
})();
