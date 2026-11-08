(()=>{
 const names={jobSearch:'自主求职',hrInbox:'HR 实时回复'},pending=new Set(),signatures=new Map();
 const journal=createTurnRequestJournal('xiaojing-channel-pending-requests');
 let snapshot,hrActivityKey='',hrQueueKey='';
 const enabled=(s,key)=>s.config.channels?.[key]??s.config.running;
 const conversation=(s,key)=>s.channelConversations?.[key]||(key==='jobSearch'?s.autonomy?.conversationId:null);
 const timestamp=value=>value?new Date(value).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit'}):'';
 const retryClock=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const queueStages={executing:'站内执行中',generating:'拟写中',auth_blocked:'待修复模型',review:'待审核',browser:'待浏览器执行',retry:'等待重试',queued:'待拟写',hold:'需你处理'};
 const queuePriority=Object.keys(queueStages);
 const answerText=text=>{try{const v=JSON.parse(text);if(typeof v.summary==='string')return v.summary;}catch{}return text;};
 window.setChannelRunning=async(key,value)=>{
  if(!snapshot||pending.has(key))return;
  if(value===undefined)value=!enabled(snapshot,key);
  pending.add(key);window.renderChannels(snapshot);
  try{await api('/api/channels',{[key]:value});await refresh();notice(`${names[key]}已${value?'开启':'关闭'}。另一个功能的开关保持原样。`);}
  finally{pending.delete(key);if(snapshot)window.renderChannels(snapshot);}
 };
 function renderConversation(s,key){
  const id=conversation(s,key),box=$('channel-log-'+key),turns=(s.ownerTasks||[]).filter(t=>id&&t.conversationId===id).sort((a,b)=>(a.turnIndex||0)-(b.turnIndex||0));
  $('channel-conversation-'+key).textContent=id?'上下文单独保存':'发送第一条指令后建立对话';
  const signature=JSON.stringify([id,turns.map(t=>[t.id,t.prompt,t.status,t.result,t.progress?.stage])]);
  if(signatures.get(key)!==signature){
   const nearEnd=box.scrollHeight-box.scrollTop-box.clientHeight<70,position=box.scrollTop;box.replaceChildren();
   if(!turns.length){const empty=el('div','channel-empty');empty.append(el('h4','',key==='jobSearch'?'和小鲸安排下一步求职':'单独交代 HR 沟通'),el('p','',key==='jobSearch'?'这里保留找岗、收藏筛选和投递安排的对话。':'这里保留新消息回复、简历请求和沟通安排的指令。'));box.append(empty);}
   for(const t of turns.slice(-24)){
    const user=el('article','channel-message channel-user');user.append(el('div','channel-message-meta',(t.source==='autonomy'?'自主工作回合':'你')+' · '+timestamp(t.at)),el('p','',t.prompt));
    const bot=el('article','channel-message channel-bot');bot.append(el('div','channel-message-meta','小鲸 · '+({running:'处理中',queued:'已收到，等待处理',done:'已回复',timed_out:'本轮超时',interrupted:'已停止',cancelled:'已取消',error:'需要处理'})[t.status]));
    if(t.status==='running')bot.append(el('p','','正在处理这条指令，运行中的功能会继续按各自的开关工作。'));
    else if(t.status==='queued')bot.append(el('p','','这条补充会在当前轮结束后处理。'));
    else bot.append(renderOwnerAnswer(answerText(t.result||'本轮未返回文字。')));
    box.append(user,bot);
   }
   box.scrollTop=nearEnd||!signatures.has(key)?box.scrollHeight:position;signatures.set(key,signature);
  }
  $('channel-submit-'+key).disabled=pending.has('turn-'+key);
  $('channel-send-state-'+key).textContent=pending.has('turn-'+key)?'正在提交…':enabled(s,key)?'指令只进入这个功能的对话。':'当前已关闭；可询问状态或调整指令，持续操作需开启这个功能。';
 }
 function queueStage(row,task,config){
  if(task){
   if(task.status==='executing')return 'executing';
   if(task.status==='pending')return config.mode!=='auto'||task.action==='send_resume'&&!config.autoResume?'review':'browser';
   if(task.status==='approved')return 'browser';
   return task.status==='hold'?'hold':'';
  }
  if(row.status==='failed'&&row.retryScheduled===true&&Number.isFinite(row.retryAt)&&row.retryAt>0)return 'retry';
  if(row.status==='ready')return 'browser';
  return ['queued','generating','hold','auth_blocked'].includes(row.status)?row.status:'';
 }
 function queueReason(s,row,task,stage,now,busy,reservedToday){
  if(stage==='review')return '草稿已生成，等待你在工作台审核。';
  if(stage==='executing')return '浏览器正在处理，等待站内回显。';
  if(stage==='retry'||stage==='hold'||stage==='queued'||stage==='auth_blocked')return row.reason||task?.reason||'';
  if(stage!=='browser')return '';
  if(s.accountRecheck?.required)return '需要核对当前登录的 BOSS 账号。';
  if(!enabled(s,'hrInbox'))return 'HR 实时回复已关闭。';
  if(s.config.chatRead===false||s.config.chatInput===false)return '聊天读取或输入权限已关闭。';
  if(task?.stableMessageIds===false)return '当前会话未识别到稳定的消息编号。';
  if(s.config.browserCalibrated===false)return '站内发送尚未校准。';
  if(now-(s.heartbeat?.at||0)>=45000)return '最近 45 秒未收到 BOSS 页面回传。';
  if(busy)return '有一条站内发送正在执行。';
  const {hoursStart,hoursEnd,intervalSeconds,dailyMessages}=s.config.limits||{};
  const hour=new Date(now+8*3600000).getUTCHours();
  if(hour<hoursStart||hour>=hoursEnd)return '当前不在设定的发送时段。';
  if(intervalSeconds>0&&now-(s.lastAction||0)<intervalSeconds*1000)return '发送间隔尚未结束。';
  if(Number.isFinite(dailyMessages)&&reservedToday>=dailyMessages)return '已达到当日站内消息上限。';
  return task?.waitingReason||'';
 }
 function safeQueueReason(value){
  return String(value).replace(/PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*[^\s"']+|sk-[\w-]+|Bearer\s+[\w.\/-]+|\b[a-f0-9]{64}\b/gi,'[凭据已隐藏]').replace(/\s+/g,' ').trim().slice(0,110);
 }
 function queueDuration(ms){
  const seconds=Math.floor(Math.max(0,ms)/1000);
  if(seconds>=3600)return `${Math.floor(seconds/3600)} 小时 ${Math.floor(seconds%3600/60)} 分`;
  return seconds>=60?`${Math.floor(seconds/60)} 分 ${seconds%60} 秒`:`${seconds} 秒`;
 }
 function queueTiming(row,task,stage,now){
  if(stage==='auth_blocked')return row.queuedAt?`${timestamp(row.queuedAt)} 已保留消息`:'已保留消息';
  const parts=[];
  if(Number.isFinite(row.queuedAt)&&row.queuedAt>0){
   const wait=stage==='queued'?now-row.queuedAt:row.timing?.queuedMs??(row.startedAt?row.startedAt-row.queuedAt:null);
   parts.push(Number.isFinite(wait)?`${stage==='queued'?'排队':'入队至拟写'} ${queueDuration(wait)}`:`${timestamp(row.queuedAt)} 入队`);
  }
  const generation=stage==='generating'&&row.startedAt?now-row.startedAt:row.timing?.generationMs;
  if(Number.isFinite(generation))parts.push(`拟写 ${queueDuration(generation)}`);
  if(stage==='retry')parts.push(row.retryAt>now?`最早 ${retryClock.format(row.retryAt)} 重试`:'已到重试时间');
  if(stage==='browser'&&Number.isFinite(task?.createdAt))parts.push(`草稿等待 ${queueDuration(now-task.createdAt)}`);
  if(stage==='executing'&&Number.isFinite(task?.reservedAt))parts.push(`执行 ${queueDuration(now-task.reservedAt)}`);
  return parts.join(' · ');
 }
 function chatLink(item,dataKey){
  if(!item.peerId)return null;
  const jump=el('button','channel-link channel-memory-link','打开会话');
  jump.type='button';jump.dataset[dataKey]=item.id;
  jump.setAttribute('aria-label',`打开 ${item.name} 的会话记忆`);
  jump.onclick=()=>window.showMemoryConversation?.(item.peerId);
  return jump;
 }
 function renderHRQueue(s){
  const now=Date.now(),day=value=>Math.floor((value+8*3600000)/86400000),today=day(now),tasks=new Map();
  let busy=false,reservedToday=0;
  for(const task of s.tasks||[]){
   tasks.set(task.id,task);if(task.status==='executing')busy=true;
   if(task.reservedAt&&day(task.reservedAt)===today)reservedToday++;
  }
  busy=s.taskStats?.executing??busy;
  reservedToday=s.taskStats?.reservedToday??reservedToday;
  const counts=new Map(),activeTaskIds=new Set(),all=[];
  for(const row of s.replyQueue||[]){
   const task=tasks.get(row.taskId),stage=queueStage(row,task,s.config);
   if(!stage)continue;
   counts.set(stage,(counts.get(stage)||0)+1);
   if(row.taskId)activeTaskIds.add(row.taskId);
   const contact=s.memories?.[row.peerId];
   all.push({id:row.id,peerId:window.xiaojingDesktop&&contact?row.peerId:'',name:contact?.domIdentity?.name||row.name||row.company||'HR 会话',company:contact?.job?.company||row.company||'',
    stage,queuedAt:row.queuedAt||0,reason:safeQueueReason(queueReason(s,row,task,stage,now,busy,reservedToday)),timing:queueTiming(row,task,stage,now)});
  }
  const summary=queuePriority.filter(stage=>counts.has(stage)).map(stage=>`${counts.get(stage)} 条${queueStages[stage]}`).join(' · ')||'当前没有待处理的回复。';
  if($('hr-channel-summary').textContent!==summary)$('hr-channel-summary').textContent=summary;
  const items=all.sort((a,b)=>queuePriority.indexOf(a.stage)-queuePriority.indexOf(b.stage)||a.queuedAt-b.queuedAt).slice(0,5);
  const section=$('hr-channel-queue'),box=$('hr-queue-list');
  section.hidden=!items.length;
  const total=all.length>items.length?`${items.length} / ${all.length}`:`${items.length} 条`;
  if($('hr-queue-count').textContent!==total)$('hr-queue-count').textContent=total;
  const key=JSON.stringify(items.map(({timing,...item})=>item));
  if(key!==hrQueueKey){
   hrQueueKey=key;
   const focused=box.contains(document.activeElement)?document.activeElement.dataset.queueId:'';
   box.replaceChildren();
   for(const item of items){
    const row=el('li','channel-queue-row'),identity=el('div','channel-queue-contact');row.dataset.stage=item.stage;
    identity.append(el('strong','',item.name));
    if(item.company&&item.company!==item.name)identity.append(el('span','',item.company));
    row.append(identity,el('span','channel-queue-stage',queueStages[item.stage]),el('div','channel-queue-time'));
    const jump=chatLink(item,'queueId');if(jump){row.classList.add('with-memory-link');row.append(jump);}
    if(item.reason){const reason=el('p','channel-queue-reason',item.reason);reason.title=item.reason;row.append(reason);}
    box.append(row);
   }
   if(focused)[...box.querySelectorAll('[data-queue-id]')].find(button=>button.dataset.queueId===focused)?.focus({preventScroll:true});
  }
  for(const [index,item] of items.entries()){
   const time=box.children[index].querySelector('.channel-queue-time');
   if(time.textContent!==item.timing)time.textContent=item.timing;
  }
  return activeTaskIds;
 }
 function renderHRActivity(s){
  const active=renderHRQueue(s);
  const items=(s.tasks||[]).filter(t=>t.kind==='reply'&&!active.has(t.id)).sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt)).slice(0,5).map(task=>{
   const contact=s.memories?.[task.peerId];
   return {id:task.id,peerId:window.xiaojingDesktop&&contact?task.peerId:'',name:contact?.domIdentity?.name||task.job?.company||'HR 会话',status:task.status,text:task.text||task.reason||'正在处理',at:task.updatedAt||task.createdAt};
  });
  const box=$('hr-channel-activity'),key=JSON.stringify(items);
  if(key===hrActivityKey)return;
  hrActivityKey=key;
  const focused=box.contains(document.activeElement)?document.activeElement.dataset.activityId:'';
  box.replaceChildren();
  if(!items.length){box.append(el('p','channel-empty-note','还没有新消息处理记录。收到 HR 来信后，会在这里显示实际结果。'));return;}
  for(const item of items){
   const row=el('article','channel-activity-row');
   row.append(el('strong','',item.name),el('span','channel-activity-status',labels[item.status]||item.status),el('p','',item.text),el('small','',timestamp(item.at)));
   const jump=chatLink(item,'activityId');if(jump)row.append(jump);
   box.append(row);
  }
  if(focused)[...box.querySelectorAll('[data-activity-id]')].find(button=>button.dataset.activityId===focused)?.focus({preventScroll:true});
 }
 window.renderChannels=s=>{
  snapshot=s;
  for(const key of Object.keys(names)){
   const running=enabled(s,key);document.querySelectorAll(`[data-channel-status="${key}"]`).forEach(e=>{e.textContent=running?'运行中':'已关闭';e.classList.toggle('on',running);});
   document.querySelectorAll(`[data-channel-toggle="${key}"]`).forEach(e=>{e.textContent=(running?'关闭':'开启')+' '+names[key];e.setAttribute('aria-checked',String(running));e.disabled=pending.has(key);});
   const view=key==='jobSearch'?'job-channel':'hr-channel';
   if(!window.xiaojingDesktop||document.body.dataset.view===view&&(!s.ownerTaskScope||s.ownerTaskScope===view))renderConversation(s,key);
  }
  if(!window.xiaojingDesktop||document.body.dataset.view==='hr-channel'&&(!s.ownerTaskScope||s.ownerTaskScope==='hr-channel'))renderHRActivity(s);
 };
 for(const button of document.querySelectorAll('[data-channel-toggle]'))button.onclick=guard(()=>window.setChannelRunning(button.dataset.channelToggle));
 for(const key of Object.keys(names))$('channel-form-'+key).onsubmit=guard(async()=>{
  const turn='turn-'+key;
  if(pending.has(turn))return;
  const input=$('channel-prompt-'+key),raw=input.value,prompt=raw.trim();if(!prompt)return;
  const current=snapshot||state,conversationId=current&&conversation(current,key);
  if(!conversationId){notice('对话正在载入，请稍后重试。');return;}
  pending.add(turn);if(snapshot)window.renderChannels(snapshot);
  try{
   const digest=await journal.digest('channel:'+key,conversationId,prompt);
   const {id:requestId}=journal.getOrCreate(digest);
   const result=await api('/api/channels/turn',{channel:key,conversationId,prompt,requestId});
   if(result?.conversationId!==conversationId||!result.task?.id)throw Error('未收到此对话的任务回执，请重试。');
   journal.acknowledge(requestId);
   if(input.value===raw)input.value='';
   await refresh();
  }finally{pending.delete(turn);if(snapshot)window.renderChannels(snapshot);}
 });
 $('nav-toggle').onclick=()=>{const open=document.body.classList.toggle('nav-open');$('nav-toggle').setAttribute('aria-expanded',String(open));};
})();
