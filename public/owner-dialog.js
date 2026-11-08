/* Authenticated owner conversations. Transcript content is rendered as DOM text. */
(()=>{
 const names={queued:'等待处理',running:'小鲸正在处理',done:'本轮已返回',timed_out:'本轮超时，可继续',interrupted:'本轮已停止',error:'本轮需要处理',cancelled:'已撤回'};
 const stages={starting:'正在准备会话',ready:'会话已就绪',thinking:'小鲸正在思考',working:'正在处理本轮要求',tool:'正在执行本轮操作',checking:'正在核对操作结果',writing:'正在整理回复',saving:'正在保存本轮记录',stopping:'正在结束本轮进程'};
 const initialThread=new URLSearchParams(location.search).get('conversation');
 let newTask=initialThread==='~new',selected=newTask?'':initialThread||localStorage.getItem('xiaojing-owner-conversation')||'',lastState,signature='',navigationSignature='',sending=false;
 let selectionGeneration=0,newDraftKey=Symbol('owner-new'),pendingDraftKey;
 const drafts=new Map();
 const journal=createTurnRequestJournal('xiaojing-owner-pending-requests');
 const continuationPrompt='请从这个任务的已有进度继续。先核对已完成的操作和发送回执，处理尚未完成的部分，不要重复发送。';
 const draftKey=()=>newTask||!selected?newDraftKey:selected;
 const threadOf=t=>t.conversationId||'legacy-'+t.id;
 const time=at=>new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
 const duration=ms=>{const seconds=Math.max(0,Math.floor(ms/1000));return seconds<60?seconds+'秒':Math.floor(seconds/60)+'分'+seconds%60+'秒';};
 async function requestForTurn(mode,conversationId,prompt){
  const digest=await journal.digest(mode,conversationId,prompt);
  let record=journal.find(digest);
  if(!record&&conversationId&&mode==='editor'&&journal.size){
   const initialDigest=await journal.digest(mode,undefined,prompt);
   const initial=journal.find(initialDigest);
   if(initial){
    // An accepted new composer may be the selected thread after a reload.
    // Only its authenticated first-turn receipt can identify that old request.
    const {turns}=await api('/api/owner-conversations/detail',{conversationId});
    if(turns.some(turn=>turn.turnIndex===1&&turn.requestId===initial.id&&turn.prompt===prompt))return {requestId:initial.id,prompt};
   }
  }
  record??=journal.getOrCreate(digest);
  return {requestId:record.id,prompt,...(conversationId?{conversationId}:{})};
 }
 function threads(s){
  if(s.ownerTaskScope==='owner'&&Array.isArray(s.ownerTaskIndex)){
   return s.ownerTaskIndex.map(thread=>({...thread,rounds:thread.id===s.ownerTaskThread?s.ownerTasks:[]}));
  }
  // Dedicated workflow conversations belong to their own panes. An empty
  // channel must never become the default destination of a general owner task.
  const dedicated=new Set([...Object.values(s.channelConversations||{}),...(s.ownerConversations||[]).filter(c=>c.sourceChannel||c.autonomyGoalId).map(c=>c.id),s.autonomy?.conversationId].filter(Boolean));
  const groups=new Map((s.ownerConversations||[]).filter(c=>!dedicated.has(c.id)).map(c=>[c.id,{...c,rounds:[]}]));
  for(const task of s.ownerTasks||[]){
   const id=threadOf(task);
   if(dedicated.has(id))continue;
   if(!groups.has(id))groups.set(id,{id,title:task.prompt.slice(0,50),updatedAt:task.finishedAt||task.at,createdAt:task.at,rounds:[]});
   const group=groups.get(id);
   group.rounds.push(task);
   group.updatedAt=Math.max(group.updatedAt||0,task.finishedAt||task.at);
  }
  for(const group of groups.values()){
   const rounds=group.rounds;
   rounds.sort((a,b)=>(a.turnIndex||a.at)-(b.turnIndex||b.at));
   group.status=rounds.some(t=>t.status==='running')?'running':rounds.some(t=>t.status==='queued')?'queued':rounds.at(-1)?.status;
  }
  return [...groups.values()].sort((a,b)=>b.updatedAt-a.updatedAt);
 }
 function choose(id,isNew=false){
  const input=$('owner-prompt');drafts.set(draftKey(),input.value);
  if(isNew&&pendingDraftKey===newDraftKey)newDraftKey=Symbol('owner-new');
  selected=id;newTask=isNew;selectionGeneration++;signature='';
  rememberSelection(id,isNew);input.value=drafts.get(draftKey())||'';
  if(lastState&&(!lastState.ownerTaskIndex||isNew||lastState.ownerTaskIndex.some(thread=>thread.id===id)))window.renderOwnerDialog(lastState);
  if(window.xiaojingDesktop&&document.body.dataset.view==='owner'&&!isNew&&lastState?.ownerTaskThread!==id)void refresh().catch(error=>notice(error.message,true));
 }
 window.ownerDialogSelection=()=>newTask?'~new':selected;
 function rememberSelection(id,isNew=false){
  const url=new URL(location.href);url.hash='owner';
  if(isNew)url.searchParams.set('conversation','~new');
  else if(id){localStorage.setItem('xiaojing-owner-conversation',id);url.searchParams.set('conversation',id);}
  else url.searchParams.delete('conversation');
  history.replaceState(null,'',url);
 }
 function progress(task){
  const p=el('p','owner-progress'),stage=stages[task.progress?.stage]||'正在处理本轮要求';p.append(document.createTextNode(stage+' · '));
  const elapsed=el('span','owner-elapsed');elapsed.dataset.started=String(task.startedAt||task.at);p.append(elapsed);
  if(task.progress?.toolCalls)p.append(document.createTextNode(' · 已调用 '+task.progress.toolCalls+' 次操作工具'));return p;
 }
 async function continueTask(){
  await submitOwnerTurn('continuation');
 }
 function renderNavigation(all,currentId){
  const next=JSON.stringify([currentId,all.map(c=>[c.id,c.title,c.status,c.turnCount??c.rounds.length])]);
  if(next===navigationSignature)return;
  navigationSignature=next;
  const list=$('owner-conversations'),picker=$('owner-thread-select');
  const focused=list.contains(document.activeElement)?document.activeElement.dataset.threadId:'';
  list.replaceChildren();picker.replaceChildren();
  const empty=el('option','','选择已有任务');empty.value='';picker.append(empty);
  for(const conversation of all){
   const active=conversation.id===currentId;
   const running=['running','queued'].includes(conversation.status);
   const button=el('button','owner-thread'+(active?' selected':''));
   button.type='button';button.dataset.threadId=conversation.id;
   button.append(el('strong','',conversation.title),el('span','',`${conversation.turnCount??conversation.rounds.length} 轮对话 · ${names[conversation.status]||'可继续'}`));
   button.onclick=()=>choose(conversation.id);button.setAttribute('aria-pressed',String(active));list.append(button);
   const option=el('option','',conversation.title+(running?' · 处理中':''));option.value=conversation.id;picker.append(option);
  }
  if(!all.length)list.append(el('p','muted','还没有任务对话。'));
  picker.value=currentId||'';
  if(focused)[...list.children].find(button=>button.dataset.threadId===focused)?.focus({preventScroll:true});
 }
 window.chooseOwnerConversation=id=>{const key=Object.keys(lastState?.channelConversations||{}).find(k=>lastState.channelConversations[k]===id);if(key){panel(key==='jobSearch'?'job-channel':'hr-channel');return;}choose(id);panel('owner');};
 window.renderOwnerDialog=s=>{window.renderAutonomy?.(s);
  lastState=s;const all=threads(s);
  if(!sending&&!newTask&&!all.some(c=>c.id===selected)){
   const fallback=all[0]?.id||'';
   if(fallback!==selected){
    const input=$('owner-prompt');drafts.set(draftKey(),input.value);
    selected=fallback;selectionGeneration++;input.value=drafts.get(draftKey())||'';
   }
  }
  const current=!newTask&&all.find(c=>c.id===selected),rounds=current?.rounds||[];
  const loading=!!(current&&s.ownerTaskScope==='owner'&&s.ownerTaskThread!==current.id);
  renderNavigation(all,current?.id);
  $('owner-thread-title').textContent=current?.title||'新任务';
  const running=rounds.find(t=>t.status==='running'),queued=rounds.filter(t=>t.status==='queued');
  $('owner-thread-status').textContent=loading?'正在读取本机对话…':running?`第 ${running.turnIndex||rounds.indexOf(running)+1} 轮正在处理${queued.length?' · '+queued.length+' 条补充等待处理':''}`:queued.length?queued.length+' 条补充等待处理':rounds.length?rounds.length+' 轮对话已保留':'把一项求职任务交给小鲸';
  $('owner-stop-turn').hidden=!running;$('owner-stop-turn').onclick=guard(async()=>{await api('/api/operations/cancel',{kind:'owner',id:running.id});await refresh();});
  const ids=new Set(rounds.map(t=>t.id)),plans=[...(s.greetingPlans||[]),...(s.ownerChats||[])].filter(p=>ids.has(p.ownerTaskId)&&['queued','uncertain'].includes(p.status));
  $('owner-execution').replaceChildren();for(const p of plans){const caption=p.kind==='greeting'?`招呼已确认 ${p.sent||0}/${p.requested} 位 HR`:`会话委托：${p.targets.filter(t=>['sent','read'].includes(t.status)).length}/${p.targets.length} 位已处理`;$('owner-execution').append(el('span','',caption));}
  if(plans.length){const b=el('button','owner-link','查看实际执行');b.type='button';b.onclick=()=>panel('control');$('owner-execution').append(b);}
  $('owner-stop-task').hidden=!(running||queued.length||plans.some(p=>p.status==='queued'));$('owner-stop-task').onclick=guard(async()=>{await api('/api/owner-conversations/stop',{conversationId:current.id});await refresh();});
  const nextSignature=JSON.stringify({id:current?.id,loading,rounds:rounds.map(t=>[t.id,t.prompt,t.status,t.result,t.progress?.stage,t.progress?.toolCalls,t.finishedAt])});
  if(signature!==nextSignature){
   const box=$('owner-tasks'),nearEnd=box.scrollHeight-box.scrollTop-box.clientHeight<70,oldTop=box.scrollTop;box.replaceChildren();
   if(!rounds.length){const empty=el('div','owner-empty');empty.append(el('h3','',loading?'正在读取对话':'这件事，和小鲸接着聊'));if(!loading)empty.append(el('p','','发出要求后，可以在同一任务里补充、纠正或追问进度。'));box.append(empty);}
   for(const task of rounds){
    const user=el('article','owner-message owner-user');user.append(el('div','owner-meta',(task.source==='autonomy'?'自主唤醒 · ':'你 · ')+time(task.at)),el('p','',task.prompt));box.append(user);
    const bot=el('article','owner-message owner-bot');bot.append(el('div','owner-meta','小鲸 · '+(names[task.status]||task.status)));
    if(task.status==='running')bot.append(progress(task));else if(task.status==='queued'){bot.append(el('p','owner-progress','已收到这条补充，当前轮结束后依次处理。'));const cancel=el('button','owner-link','撤回这条补充');cancel.type='button';cancel.onclick=guard(async()=>{await api('/api/operations/cancel',{kind:'owner',id:task.id});await refresh();});bot.append(cancel);}
    else{bot.append(renderOwnerAnswer(task.result||'本轮没有返回文字。'));if(['timed_out','error','interrupted'].includes(task.status)&&task===rounds.at(-1)){const b=el('button','owner-continue','从已有进度继续');b.type='button';b.onclick=guard(continueTask);bot.append(b);}}
    box.append(bot);
   }
   box.scrollTop=nearEnd||signature===''?box.scrollHeight:oldTop;signature=nextSignature;
  }
  $('owner-send-state').textContent=sending?'正在提交…':running||queued.length?'补充消息会排队，保留同一任务的上下文。':current?'继续这件事，或新建另一项任务。':'第一条消息会建立新任务。';
  $('owner-submit').disabled=sending;$('owner-submit').textContent=running?'补充到当前任务':current?'发送补充':'发送';
  updateElapsed();
 };
 function updateElapsed(){for(const span of document.querySelectorAll('#owner .owner-elapsed'))span.textContent='已用 '+duration(Date.now()-Number(span.dataset.started));}
 function acknowledgeDraft(input,{key,raw,generation},id){
  const activeKey=draftKey(),active=activeKey===key;
  const current=active?input.value:drafts.get(key)||'';
  const remainder=current===raw?'':current;
  const follow=active&&selectionGeneration===generation&&document.body.dataset.view==='owner';
  if(key===id){
   if(current===raw){drafts.delete(key);if(active)input.value='';}
  }else{
   const targetDraft=activeKey===id?input.value:drafts.get(id)||'';
   // A retry can return a conversation that already has a separate draft.
   if(remainder&&targetDraft)return;
   if(remainder){drafts.set(id,remainder);if(activeKey===id)input.value=remainder;}
   drafts.delete(key);
   const next=follow?remainder||targetDraft:'';
   if(active&&input.value!==next)input.value=next;
  }
  if(follow){selected=id;newTask=false;rememberSelection(id);signature='';}
 }
 async function submitOwnerTurn(mode){
  if(sending)return;
  const continuation=mode==='continuation';
  const input=$('owner-prompt'),raw=input.value,prompt=continuation?continuationPrompt:raw.trim(),key=draftKey(),conversationId=newTask?undefined:selected||undefined;
  if(!prompt||continuation&&!conversationId)return;
  const submission={key,raw,generation:selectionGeneration};
  sending=true;pendingDraftKey=continuation?undefined:key;if(lastState)window.renderOwnerDialog(lastState);
  try{
   const request=await requestForTurn(mode,conversationId,prompt);
   const response=await api('/api/owner-task',request);
   const id=response.task.conversationId||'legacy-'+response.task.id;
   journal.acknowledge(request.requestId);
   if(!continuation)acknowledgeDraft(input,submission,id);
   if(!$('notice').classList.contains('error'))$('notice').hidden=true;await refresh();
  }finally{sending=false;pendingDraftKey=undefined;if(lastState)window.renderOwnerDialog(lastState);}
 }
 window.submitOwnerTurn=()=>submitOwnerTurn('editor');
 $('owner-new').onclick=()=>{choose('',true);$('owner-prompt').focus();};$('owner-thread-select').onchange=()=>{if($('owner-thread-select').value)choose($('owner-thread-select').value);};
 $('owner-form').onsubmit=guard(window.submitOwnerTurn);$('owner-prompt').addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();guard(window.submitOwnerTurn)();}});
 setInterval(updateElapsed,1000);if(typeof state!=='undefined'&&state)window.renderOwnerDialog(state);
})();
