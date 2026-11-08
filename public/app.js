const $=id=>document.getElementById(id);let token='',extensionToken='',state,loaded=false,ownerSubmitRequest=null,refreshVersion=0,periodicPending=false;
async function api(path,data){const r=await fetch(path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
function notice(s,error=false){$('notice').textContent=s;$('notice').className=error?'error':'';$('notice').hidden=false;}
const ownerBaseTitle=document.querySelector('main header h1')?.textContent,ownerBaseEyebrow=document.querySelector('main header .eyebrow')?.textContent;
const mainNav=$('main-nav'),navToggle=$('nav-toggle'),workspaceHeading=$('heading');
function closeMainMenu(){document.body.classList.remove('nav-open');navToggle.setAttribute('aria-expanded','false');}
$('workspace-skip').addEventListener('click',event=>{event.preventDefault();workspaceHeading.focus();});
document.addEventListener('keydown',event=>{
  if(event.key!=='Escape'||!document.body.classList.contains('nav-open')||!(mainNav.contains(event.target)||event.target===navToggle))return;
  event.preventDefault();closeMainMenu();navToggle.focus();
});
function panel(name){
  if(window.openDesktopSettings?.(name))return;
  const fromOpenMenu=document.body.classList.contains('nav-open')&&mainNav.contains(document.activeElement);
  document.body.dataset.view=name;
  $('agent-state').hidden=['jobs','library','providers','mcp','browser-setup','memory'].includes(name);
  if(!$('notice').classList.contains('error'))$('notice').hidden=true;
  document.body.classList.toggle('owner-screen',name==='owner');
  document.body.classList.toggle('channel-screen',['job-channel','hr-channel','overview'].includes(name));
  closeMainMenu();
  const eyebrow=document.querySelector('main header .eyebrow');
  workspaceHeading.textContent=({'job-channel':'自主求职','hr-channel':'HR 实时回复',owner:'和小鲸一起求职',jobs:'岗位资料库',memory:'会话记忆',control:'任务中心',library:'人格与资料库',providers:'模型与联网',mcp:'MCP 工具',connection:'连接与诊断','browser-setup':'内置浏览器'})[name]||ownerBaseTitle;
  if(eyebrow)eyebrow.textContent=name==='owner'?'小鲸 · 对话':window.xiaojingDesktop?'本地工作区':ownerBaseEyebrow;
  setTimeout(()=>window.refreshControl?.().catch(e=>notice(e.message,true)),0);
  document.querySelectorAll('.panel').forEach(e=>{if(!e.closest('#desktop-settings-drawer'))e.hidden=e.id!==name;});
  if(window.xiaojingDesktop)window.scrollTo(0,0);
  mainNav.querySelectorAll('.nav').forEach(button=>{
    const active=button.dataset.panel===name;
    button.classList.toggle('active',active);
    if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  });
  if(fromOpenMenu)workspaceHeading.focus();
  if(window.xiaojingDesktop){renderCurrentContent();refreshVisiblePanel(name);}
}
document.querySelectorAll('[data-panel]').forEach(e=>e.onclick=()=>panel(e.dataset.panel));document.querySelectorAll('[data-goto]').forEach(e=>e.onclick=()=>panel(e.dataset.goto));
const labels={pending:'待审核',approved:'已批准，待执行',hold:'需要你处理',skip:'已跳过',sent:'已发送',uncertain:'待核对',failed:'未执行成功',executing:'执行中',stale:'旧草稿已失效',rejected:'已拒绝'};
function el(tag,cls,content){const e=document.createElement(tag);if(cls)e.className=cls;if(content!==undefined)e.textContent=content;return e;}
function renderOwnerAnswer(text){
  const box=el('div','owner-answer');
  let code=null,list=null;
  function appendInline(node,line){
    let offset=0;
    for(const match of line.matchAll(/\*\*[^*\n]+\*\*|`[^`\n]+`/g)){
      node.append(document.createTextNode(line.slice(offset,match.index)));
      const bold=match[0].startsWith('**');
      node.append(el(bold?'strong':'code','',match[0].slice(bold?2:1,bold?-2:-1)));
      offset=match.index+match[0].length;
    }
    node.append(document.createTextNode(line.slice(offset)));
  }
  for(const line of String(text).split(/\r?\n/)){
    if(/^```/.test(line)){
      if(code)code=null;
      else{const pre=el('pre');code=el('code');pre.append(code);box.append(pre);}
      list=null;continue;
    }
    if(code){code.append(document.createTextNode(line+'\n'));continue;}
    if(!line.trim()){list=null;continue;}
    const item=line.match(/^\s*(?:[-*]|(\d{1,9})\.)\s+(.+)/);
    if(item){
      const tag=item[1]?'ol':'ul';
      if(list?.localName!==tag){list=el(tag);if(item[1])list.start=Number(item[1]);box.append(list);}
      const row=el('li');appendInline(row,item[2]);list.append(row);continue;
    }
    list=null;
    const heading=line.match(/^#{1,4}\s+(.+)/),row=el(heading?'h4':'p');
    appendInline(row,heading?heading[1]:line);box.append(row);
  }
  return box;
}
const reviewDrafts=new Map(),reviewPending=new Set(),editableReview=new Set(['pending','hold','approved']);
const reviewVersion=task=>JSON.stringify([task.status,task.action,task.text,task.memoryRevision,task.fingerprint]);
let renderedReview='';
function renderTasks(){
  const box=$('tasks');
  if(!box||!state||window.xiaojingDesktop&&state.ownerTaskScope&&state.ownerTaskScope!=='overview')return;
  for(const [id,draft] of reviewDrafts){
    const task=state.tasks.find(item=>item.id===id);
    if(!task||reviewVersion(task)!==draft.version)reviewDrafts.delete(id);
  }
  const filter=$('filter').value;
  const tasks=state.tasks.filter(t=>filter==='all'||filter==='todo'&&['pending','approved','hold','executing','uncertain'].includes(t.status)||filter===t.status).slice(0,100);
  const signature=JSON.stringify([filter,state.config.profile.resumeName,tasks.map(t=>{
    const {title,company,city,salary,url}=t.job||{};
    return [t.id,t.kind,title,company,city,salary,url,reviewVersion(t),t.reason,t.evidence,t.reservedAt,t.createdAt,t.timing?.generationMs,reviewPending.has(t.id)];
  })]);
  if(signature===renderedReview)return;
  renderedReview=signature;
  const active=document.activeElement,focus=box.contains(active)?active.closest('[data-review-task]'):null;
  const selection=active?.tagName==='TEXTAREA'?[active.selectionStart,active.selectionEnd,active.selectionDirection]:null;
  let restoreFocus;
  box.replaceChildren();
  if(!tasks.length){const d=el('div','empty');d.append(el('strong','',filter==='todo'?'暂时没有待处理消息':'没有对应记录'),el('span','','连接浏览器，打开岗位列表或 HR 聊天页后，记录会出现在这里。'));box.append(d);return;}
  for(const t of tasks){
    const article=el('article','task'),top=el('div','task-top'),title=el('div'),job=t.job||{};
    const version=reviewVersion(t),editable=editableReview.has(t.status);
    article.dataset.reviewTask=t.id;article.dataset.reviewVersion=version;
    title.append(el('h3','',job.title||'HR 会话'),el('small','',[job.company,job.city,job.salary,t.kind==='greeting'?'打招呼':t.kind==='followup'?'主动追问':'回复 HR'].filter(Boolean).join(' · ')));top.append(title,el('span','badge '+t.status,labels[t.status]||t.status));
    article.append(top,el('p','reason',t.reason||''));
    let text;
    if(t.action==='send_text'||t.status==='hold'){
      text=el('textarea');text.value=reviewDrafts.get(t.id)?.text??t.text??'';text.maxLength=300;
      text.placeholder='填写你确认要发送的消息';text.readOnly=!editable||reviewPending.has(t.id);text.dataset.reviewControl='text';
      text.setAttribute('aria-label',editable?'消息草稿':'消息正文');
      if(editable)text.oninput=()=>reviewDrafts.set(t.id,{version,text:text.value});
      article.append(text);
    }
    else if(t.action==='send_resume')article.append(el('p','','将发送站内附件：'+state.config.profile.resumeName));
    if(t.evidence)article.append(el('p','muted',t.evidence));
    if(Number.isFinite(t.timing?.generationMs))article.append(el('p','muted',`拟写用时 ${(t.timing.generationMs/1000).toFixed(1)} 秒${t.reservedAt&&t.createdAt?' · 等待发送 '+(Math.max(0,t.reservedAt-t.createdAt)/1000).toFixed(1)+' 秒':''}`));
    if(job.url){const a=el('a','','查看岗位 ↗');a.href=job.url;a.target='_blank';a.rel='noreferrer';a.dataset.reviewControl='job';article.append(a);}
    if(editable){
      const buttons=el('div','task-buttons');
      for(const [caption,approve,cls] of [['批准发送',true,'primary'],['跳过',false,'']]){
        const b=el('button',cls,caption);b.disabled=reviewPending.has(t.id);b.dataset.reviewControl=approve?'approve':'skip';
        b.onclick=async()=>{
          if(reviewPending.has(t.id))return;
          reviewPending.add(t.id);for(const button of buttons.children)button.disabled=true;
          if(text)text.readOnly=true;
          try{
            await api('/api/review',{id:t.id,approve,...(text?{text:text.value}:{})});
            reviewDrafts.delete(t.id);notice(approve?'已批准发送。':'已跳过这条消息。');
            await refresh();
          }
          catch(error){notice(error.message,true);}
          finally{reviewPending.delete(t.id);for(const button of buttons.children)button.disabled=false;if(text)text.readOnly=false;if(document.body.dataset.view==='overview')renderTasks();}
        };
        buttons.append(b);
      }
      article.append(buttons);
    }
    if(focus?.dataset.reviewTask===t.id&&focus.dataset.reviewVersion===version){
      restoreFocus=[...article.querySelectorAll('[data-review-control]')].find(control=>control.dataset.reviewControl===active.dataset.reviewControl);
    }
    box.append(article);
  }
  restoreFocus?.focus({preventScroll:true});
  if(selection&&restoreFocus?.tagName==='TEXTAREA')restoreFocus.setSelectionRange(...selection);
}
const profileLists=new Set(['titles','cities','exclusions']);
const profileNumbers=new Set(['salaryMin','salaryMax','maxExperienceYears']);
const profileFields=new Set(['name','facts','resumeName','experiencePolicy','earlyCareerOnly','excludeSenior',...profileLists,...profileNumbers]);
const dirtyProfile=new Set(),savedProfile=new Map();
let savingProfile=false;
const profileFieldValue=field=>field.type==='checkbox'?field.checked:field.value;
function populateProfile(profile){
  const fields=$('profile-form').elements;
  for(const key of profileFields){
    if(dirtyProfile.has(key)||!Object.hasOwn(profile,key))continue;
    const field=fields[key],value=profile[key];
    if(field.type==='checkbox')field.checked=value===true;
    else{
      const display=Array.isArray(value)?value.join('，'):String(value??'');
      if(field.value!==display)field.value=display;
    }
    savedProfile.set(key,profileFieldValue(field));
  }
  updateScreeningFields();
}
const settingsForm=$('settings-form');
const settingsLimits=new Set(['dailyGreetings','dailyMessages','intervalSeconds','hoursStart','hoursEnd']);
const dirtySettings=new Set(),savedSettings=new Map();
let pendingSettings;
const settingValue=field=>field.type==='checkbox'?field.checked:field.value;
function populateSettings(config){
  for(const field of settingsForm.elements){
    const key=field.name,source=settingsLimits.has(key)?config.limits:config;
    if(!key||dirtySettings.has(key)||!Object.hasOwn(source,key))continue;
    if(field.type==='checkbox')field.checked=source[key]===true;
    else if(field.value!==String(source[key]))field.value=source[key];
    savedSettings.set(key,settingValue(field));
  }
}
function populate(){
  const c=state.config;
  populateProfile(c.profile);
  populateSettings(c);
  $('selectors').value=JSON.stringify(c.selectors,null,2);
}
function renderSearchCoverage(){
  const coverage=state.searchCities, node=$('profile-search-coverage');
  if(!coverage||!node)return;
  const {supported,unsupported}=coverage;
  node.hidden=!supported.length&&!unsupported.length;
  node.textContent=[supported.length?`自动搜索支持 ${supported.join('、')}。`:'',
    unsupported.length?`${unsupported.join('、')}可用于筛选已采集或收藏的岗位，暂未进入自动搜索轮换。`:''].join('');
}
function renderMemory(){
  const decisions=$('owner-decisions');if(decisions){decisions.replaceChildren();const pending=(state.ownerDecisions||[]).filter(d=>d.status==='needs_owner_decision');for(const d of pending){const row=el('p','',`${d.header||'HR'}：${d.summary}`);const done=el('button','','已处理');done.onclick=guard(async()=>{await api('/api/owner-decision',{id:d.id});await refresh();});row.append(done);decisions.append(row);}if(!pending.length)decisions.append(el('p','muted','暂时没有需要你决定的事项。'));}
  const box=$('memories'),open=new Set([...box.querySelectorAll('details[open]')].map(item=>item.dataset.peerId));box.replaceChildren();
  const conversations=Object.values(state.memories||{}).sort((a,b)=>b.lastSeenAt-a.lastSeenAt);
  $('memory-count').textContent=`已保存 ${conversations.length} 个独立 HR 会话；目录：${state.memoryDirectory||'本机资料目录'}。草稿和实际发送记录分开保存。`;
  for(const c of conversations){
    const item=el('details','card'),summary=el('summary','',`${c.header||c.peerId} · ${c.history.length} 条观察记录`);item.dataset.peerId=c.peerId;item.open=open.has(c.peerId);item.append(summary,el('p','muted',`会话：${c.peerId} · ${c.stableMessageIds?'消息编号可识别':'消息编号待校准，仅生成草稿'}`));
    if(c.historyCoverage)item.append(el('p','muted',c.historyCoverage.complete?'网页历史起点已确认':`已保存 ${c.history.length} 条实际加载的对话；尚未确认历史完整。`));
    if(c.job?.title){item.append(el('h3','',c.job.title),el('p','muted',[c.job.company,c.job.city,c.job.salary].filter(Boolean).join(' · ')));const d=c.jobDetail;item.append(el('p','muted',d?.status==='read'?`已从聊天的“查看职位”读取 · ${new Date(d.observedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`:d?.status==='unavailable'?`职位正文未读到：${d.reason}`:'目前已保存聊天顶部的岗位信息'));if(d?.status==='read')item.append(el('pre','',c.job.description));}
    if(c.resume){const r=c.resume;item.append(el('p','',r.status==='sent'?(r.followup?.status==='sent'?'附件简历已发送；已跟进，等待HR回复':'附件简历已发送；进入筛选进度跟进'):'附件发送状态尚未确认'),el('p','muted',r.capabilities?.toolbarEnabled?'网站当前开放“发简历”入口':'网站当前未开放主动发简历入口；不表示此前没有发过附件'));for(const proof of (r.receipts||[]).slice(-4))item.append(el('p','muted',`${proof.source==='owner_confirmation'?'本人确认':'网页发送提示'}：${proof.raw}${proof.filenameComplete?'':'（文件名可能被截断，不推断全名）'}`));}
    for(const m of c.history.slice(-30)){
      const row=el('p','',`${m.author?.kind==='owner_confirmed'?'本人确认':(m.author?.label||(m.role==='hr'?'HR':'账号我方（归属待确认）'))}：${m.text}`);
      if(m.role==='self'&&m.author?.kind==='account_self_unknown'&&m.id){const confirm=el('button','','标为本人发送');confirm.onclick=guard(async()=>{await api('/api/chat/author-confirm',{peerId:c.peerId,messageId:m.id,kind:'owner_confirmed'});await refresh();});row.append(confirm);}
      item.append(row);
    }
    for(const send of c.sends.slice(-10))item.append(el('p','muted',`${send.status==='sent'?'已确认发送':'发送待核对'}：${send.text||'附件简历'} · ${send.evidence}`));
    box.append(item);
  }
}
function renderOwner(){
  if(window.renderOwnerDialog){window.renderOwnerDialog(state);return;}
  $('owner-tasks').replaceChildren();
  for(const p of (state.ownerChats||[]).slice(-10).reverse()){
    const card=el('article','card');card.append(el('h3','',p.kind==='read'?'会话读取进度':'主动追问进度'));
    const names={queued:'等待读取',reading:'读取中',generating:'根据真实历史拟写中',ready:'待发送',executing:'发送中',read:'已读取',sent:'已确认发送',skip:'已跳过',hold:'需要你处理',failed:'未执行',uncertain:'发送结果待核对',expired:'已过期',cancelled:'已停止'};
    for(const t of p.targets)card.append(el('p','',`${t.company} · ${t.name}：${names[t.status]||t.status}${t.waitingReason?'（'+t.waitingReason+'）':''}`),el('small','',t.evidence||t.reason||''));$('owner-tasks').append(card);
  }
  for(const t of (state.ownerTasks||[]).slice(0,10)){const card=el('article','card');card.append(el('h3','',({running:'小鲸正在处理',done:'已返回结果',interrupted:'已中断',error:'需要处理'})[t.status]||t.status),el('p','',t.prompt),el('pre','',t.result||'正在调用 Harness，请稍候…'));$('owner-tasks').append(card);}
  $('owner-submit').disabled=(state.ownerTasks||[]).some(t=>t.status==='running');
}
function renderJobs(){window.renderJobsTable?.(state);}
function renderDesktopSetup(){
  const setup=state.desktopSetup, box=$('desktop-setup');
  if(!box||!setup)return;
  const modelReady=setup.jobModel&&setup.replyModel;
  const rows=[
    ['setup-profile',setup.profile,setup.profile?'岗位、城市和经历已填写':'填写姓名、目标岗位、城市和可引用的经历'],
    ['setup-models',modelReady,modelReady?'招呼和 HR 回复的模型均已配置':setup.jobModel?'还需配置 HR 回复模型':setup.replyModel?'还需配置岗位招呼模型':'先为岗位招呼和 HR 回复配置可用模型'],
    ['setup-browser',setup.page,setup.signIn?'请在已连接的 BOSS 页面完成登录':setup.page?'已收到 BOSS 求职页面回传':setup.bridge?'桥接在线，等待打开 BOSS 求职页面':'打开内置浏览器，在页面内登录 BOSS'],
    ['setup-calibration',setup.calibrated,setup.calibrated?'已确认发送流程':'校准前可读取岗位或生成草稿；核对后再启用发送']
  ];
  const completed=rows.filter(([,ready])=>ready).length;
  box.hidden=completed===rows.length;
  $('desktop-setup-progress').textContent=`${completed}/${rows.length} 已准备`;
  for(const [id,ready,label] of rows){
    const element=$(id);
    element.textContent=label;
    element.closest('li').classList.toggle('ready',ready);
  }
}
function renderAccountRecheck(){
  const check=state.accountRecheck,box=$('desktop-account-check');
  if(!box)return;
  box.hidden=check?.required!==true;
  if(box.hidden)return;
  $('desktop-account-message').textContent=check.canConfirm
    ?'请核对当前登录账号和之前保存的会话。确认同一账号后，再重新校准站内发送。'
    :'请在 BOSS 登录原账号并选中一个聊天。小鲸收到该页回传后，可确认账号。';
  $('desktop-account-confirm').disabled=!check.canConfirm;
}
function renderCurrentContent(){
  if(!state)return;
  const desktop=!!window.xiaojingDesktop,view=document.body.dataset.view,settingsView=window.activeDesktopSettings?.();
  renderAgentState(view);
  if(!desktop||view==='overview'){renderAccountRecheck();renderDesktopSetup();renderTasks();}
  if(view==='profile'||settingsView==='profile')populateProfile(state.config.profile);
  if(view==='settings'||settingsView==='settings')populateSettings(state.config);
  if(!desktop||view==='profile'||settingsView==='profile')renderSearchCoverage();
  if(!desktop||view==='jobs')renderJobs();
  if(!desktop||view==='owner'&&(!state.ownerTaskScope||state.ownerTaskScope==='owner'))renderOwner();
  else if(view==='job-channel')window.renderAutonomy?.(state);
  if(!desktop||view==='learning')renderLearning();
  if(desktop&&view==='memory')window.renderMemoryWorkspace?.(state);
  else if(!desktop&&!$('memories').contains(document.activeElement))renderMemory();
  window.renderChannels?.(state);
}
function refreshVisiblePanel(view){
  if(!token)return;
  const thread=view==='owner'?window.ownerDialogSelection?.():null;
  if(state?.ownerTaskScope!==view||thread&&thread!=='~new'&&state.ownerTaskThread!==thread)void refresh().catch(error=>notice(error.message,true));
}
function renderAgentState(view){
  const c=state.config,stage={owner:'owner','job-channel':'greeting','hr-channel':'reply'}[view]||'owner';
  const selectedModel=state.desktopModels?.[stage];
  const modelLabel=selectedModel?`${({owner:'对话',greeting:'岗位招呼',reply:'HR 回复'})[stage]} · ${selectedModel.label} / ${selectedModel.model}`:`${c.backend==='harness'?'DeepSeek Harness':'DeepSeek API'} · ${c.model} / ${(c.reasoningEffort||'high').toUpperCase()}`;
  const status=state.accountRecheck?.required?'等待核对 BOSS 账号':state.generating?'正在生成 '+state.generating+' 个草稿':c.browserCalibrated?'发送流程已校准':'发送待校准';
  $('agent-state').textContent=`${modelLabel} · ${status}`;
}
function renderLearning(){
  const l=state.learning,box=$('learning-notes');if(!l){$('learning-summary').textContent='学习功能等待本地服务更新。';return;}
  const status=!state.config.learningEnabled?'自主学习已关闭':l.running?'正在整理资料':!state.config.running?'随求职任务暂停':'等待新资料或求职任务空闲';
  $('learning-summary').textContent=`${status}。正在使用 ${l.active} 条记忆，${l.queued} 份资料等待整理；今日整理调用 ${l.usage.calls}/${state.config.learningDailyLimit} 次。保存位置：${l.directory}。`+(l.failed?` ${l.failed} 份整理失败，已保留来源。`:'')+(l.lastError?` 最近整理未完成：${l.lastError}`:'');
  $('learning-retry').hidden=!l.failed;
  const open=new Set([...box.querySelectorAll('details[open]')].map(e=>e.dataset.noteId));box.replaceChildren();
  const categories={owner_note:'手动补充',job_requirement:'岗位要求',domain_observation:'领域观察',hr_context:'HR 会话上下文',communication_observation:'沟通观察'};
  const statuses={active:'正在使用',disabled:'已停用',superseded:'已被新资料替代'};
  for(const n of l.notes.filter(n=>$('learning-filter').value==='all'||n.status==='active')){
    const item=el('details','card');item.dataset.noteId=n.id;item.open=open.has(n.id);item.append(el('summary','',`${categories[n.category]||n.category} · ${statuses[n.status]||n.status} · ${n.text.slice(0,55)}`),el('p','',n.text),el('p','muted',`来源：${n.trust==='owner_direct'?'本机用户填写':(n.source.title||n.source.id)} · ${new Date(n.updatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`),el('p','muted',n.scope.peerId?'适用范围：仅此 HR 会话':n.scope.jobUrl?'适用范围：相关岗位，引用时保留来源归属':'适用范围：手动补充的记忆'),el('pre','',n.evidence));
    if(/^https:\/\/www\.zhipin\.com\/job_detail\/[\w-]+\.html$/.test(n.source.url||'')){const a=el('a','','查看来源岗位');a.href=n.source.url;a.target='_blank';a.rel='noreferrer';item.append(a);}
    const buttons=el('div','task-buttons'),toggle=el('button','',n.status==='active'?'停用这条记忆':'重新使用');toggle.onclick=guard(async()=>{await api('/api/learning/review',{id:n.id,status:n.status==='active'?'disabled':'active'});await refresh();});buttons.append(toggle);
    if(n.trust==='owner_direct'){const edit=el('button','','修改');edit.onclick=()=>{$('learning-note-id').value=n.id;$('learning-note').value=n.text;$('learning-note').focus();};buttons.append(edit);}
    item.append(buttons);box.append(item);
  }
  if(!box.childElementCount)box.append(el('p','empty','收到可整理的岗位详情或 HR 对话后，学习笔记会出现在这里；也可以先补充记忆。'));
}
async function refresh(forceTurns=false){
  const previous=state;
  const requestedPanel=window.xiaojingDesktop?(document.body.dataset.view||'overview'):null;
  let path='/api/state';
  if(requestedPanel){
    const panel=requestedPanel;
    const params=new URLSearchParams({view:'desktop',panel});
    const thread=panel==='owner'?window.ownerDialogSelection?.():null;
    if(thread)params.set('thread',thread);
    if(!forceTurns&&previous?.ownerTaskScope===panel&&previous.ownerTaskRevision&&
       (!thread||thread===previous.ownerTaskThread)&&Array.isArray(previous.ownerTasks)){
      params.set('turnsRevision',previous.ownerTaskRevision);
    }
    path+='?'+params;
  }
  const version=++refreshVersion;
  const isCurrent=()=>version===refreshVersion&&(!requestedPanel||requestedPanel===(document.body.dataset.view||'overview'));
  let next;
  try{next=await api(path);}
  catch(error){if(isCurrent())throw error;return;}
  if(!isCurrent())return;
  if(next.ownerTasksUnchanged===true){
    if(previous?.ownerTaskRevision!==next.ownerTaskRevision||previous?.ownerTaskScope!==next.ownerTaskScope||
       previous?.ownerTaskThread!==next.ownerTaskThread||!Array.isArray(previous?.ownerTasks)){
      if(forceTurns)throw Error('本机对话版本不一致，请刷新');
      return refresh(true);
    }
    next.ownerTasks=previous.ownerTasks;
  }
  state=next;const c=state.config;if(state.desktopVersion)$('app-version').textContent='桌面版 '+state.desktopVersion;
  const directed=(state.ownerChats||[]).some(p=>p.status==='queued'),jobOn=c.channels?.jobSearch??c.running,hrOn=c.channels?.hrInbox??c.running;$('running').textContent=jobOn&&hrOn?'两项都在运行':jobOn?'仅自主求职运行':hrOn?'仅 HR 实时回复运行':directed?'委托处理中':state.ownerBusy?'小鲸正在处理对话任务':'两项都已关闭';$('running').classList.toggle('on',jobOn||hrOn||directed||state.ownerBusy);$('run').disabled=jobOn&&hrOn;
  const summary=$('summary'),profileReady=state.desktopSetup?.profile??!!(c.profile.name&&c.profile.facts&&c.profile.titles.length&&c.profile.cities.length);
  summary.hidden=profileReady;
  summary.textContent=profileReady?'':'请先填写求职资料。';
  if($('discovery-status')){
    const f=state.favorites||{},coverage=state.searchCities;
    const search=coverage?.supported?.length===0?'尚未配置支持自动搜索的城市':'使用已配置的筛选条件';
    $('discovery-status').textContent=`优先读取收藏岗位，再搜索新岗位。收藏 ${f.reason||'等待下一次读取'}。搜索 ${search}。${c.historySweepEnabled?'旧会话巡检已手动开启。':'HR 新消息按独立开关处理。'}`;
  }
  $('mode-label').textContent=c.mode==='auto'?'自动发送':'审核后发送';
  $('m-jobs').textContent=state.jobCount??Object.keys(state.jobs||{}).length;
  $('m-review').textContent=state.taskStats?.attention??state.tasks.filter(t=>['pending','hold','uncertain'].includes(t.status)).length;
  $('m-sent').textContent=state.taskStats?.sent??state.tasks.filter(t=>t.status==='sent').length;
  const setup=state.desktopSetup,connected=setup?.page??(Date.now()-(state.heartbeat.at||0)<45000);
  const extensionOnline=setup?.bridge??(Date.now()-(state.workerHealth?.at||0)<45000);
  $('m-browser').textContent=state.accountRecheck?.required?'待核对':setup?.signIn?'待登录':connected?'已连接':extensionOnline?(setup?'桥接在线':'扩展在线'):'未连接';
  $('key-state').textContent=state.keyConfigured?'已保存 API 密钥':'尚未配置 API 密钥';
  $('browser-auth-state').textContent=state.browserAutoConnectConfigured?'已加密保存自动连接配置。若在微软扩展中重新生成了令牌，请在这里更新。':'当前逐次连接；保存微软扩展令牌后可自动重连。';
  $('harness-state').textContent=state.harness.available?'已找到本机 Harness':'未找到本机 Harness，可检查安装或切换 API 后端';
  const bridge=window.xiaojingDesktop?'内置浏览器桥接':'浏览器扩展';
  $('browser-state').textContent=state.accountRecheck?.required?'请核对当前 BOSS 登录账号。':setup?.signIn?`${bridge}已连接，请在 BOSS 页面完成登录。`:connected?`已连接 ${state.heartbeat.page}`:extensionOnline?`${bridge}已连接${c.running?'，等待 BOSS 页面回传。':'，两个自动功能均已关闭。'}`:`等待${bridge}连接。`;
  $('tools-state').replaceChildren();for(const tool of state.tools||[]){$('tools-state').append(el('p','',`${tool.label} ${tool.version} · ${tool.installed?'已安装':'待安装'}；${tool.connection}`));}if(!state.tools?.length)$('tools-state').append(el('p','muted','尚未载入新工具配置，等待本地服务更新。'));
  $('diagnostics').textContent=JSON.stringify(state.heartbeat.diagnostics||{},null,2);
  $('events').replaceChildren();if(!state.events.length)$('events').append(el('span','muted','操作记录会显示在这里。'));
  state.events.slice(0,12).forEach(e=>{const d=el('div','event '+e.kind);d.append(el('time','',new Date(e.at).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai'})),el('span','',e.message));$('events').append(d);});
  renderCurrentContent();void window.refreshControl?.().catch(e=>notice(e.message,true));if(!loaded){populate();loaded=true;}
}
function guard(fn){return async e=>{e?.preventDefault();try{await fn(e);}catch(e){notice(e.message||'操作失败',true);}};}
$('desktop-account-confirm').onclick=guard(async()=>{
  $('desktop-account-confirm').disabled=true;
  try{
    await api('/api/account-recheck',{sameAccount:true});
    notice('已确认账号。重新核对站内发送后，可开启需要的通道。');
  }finally{await refresh();}
});
$('run').onclick=guard(async()=>{await api('/api/run',{running:true});notice('自主求职和 HR 实时回复都已开启。请保持本地服务和 BOSS 页面打开。');await refresh();});
$('stop').onclick=guard(async()=>{await api('/api/run',{running:false});notice('已暂停。执行中的操作以站内结果为准。');await refresh();});
$('refresh').onclick=guard(()=>refresh(true));$('filter').onchange=renderTasks;
const parts=s=>s.split(/[,，\n]/).map(x=>x.trim()).filter(Boolean);
function updateScreeningFields(){
  const fields=$('profile-form').elements;
  const campus=fields.earlyCareerOnly.checked;
  fields.experiencePolicy.disabled=campus;
  fields.maxExperienceYears.disabled=campus||fields.experiencePolicy.value!=='max';
  fields.excludeSenior.disabled=campus;
  $('profile-filter-hint').textContent=campus?'校招模式优先，会排除要求正式工作经验的岗位。':'按这里的经验与资历条件筛选。最低匹配分可在“运行设置”调整。';
}
$('profile-form').elements.earlyCareerOnly.addEventListener('change',updateScreeningFields);
$('profile-form').elements.experiencePolicy.addEventListener('change',updateScreeningFields);
function trackProfileEdit({target}){
  const key=target.name;
  if(!profileFields.has(key))return;
  if(!savingProfile&&profileFieldValue(target)===savedProfile.get(key))dirtyProfile.delete(key);
  else dirtyProfile.add(key);
}
$('profile-form').addEventListener('input',trackProfileEdit);
$('profile-form').addEventListener('change',trackProfileEdit);
$('profile-form').onsubmit=guard(async event=>{
  if(savingProfile)return;
  if(!dirtyProfile.size){notice('求职资料没有修改。');return;}
  const form=event.currentTarget,button=form.querySelector('button');
  const submitted=[...dirtyProfile].map(key=>[key,profileFieldValue(form.elements[key])]);
  const profile=Object.fromEntries(submitted.map(([key,value])=>[key,profileLists.has(key)?parts(value):profileNumbers.has(key)?Number(value):value]));
  savingProfile=button.disabled=true;
  try{
    await api('/api/config',{profile});
    for(const [key,value] of submitted)if(profileFieldValue(form.elements[key])===value)dirtyProfile.delete(key);
    notice(dirtyProfile.size?'已保存提交时的资料，之后的修改仍在编辑框。':'求职资料和筛选标准已保存，旧草稿已失效。');
    await refresh();
  }finally{savingProfile=button.disabled=false;}
});
function trackSettingsEdit({target}){
  const key=target.name;
  if(!key)return;
  if(!pendingSettings?.has(key)&&settingValue(target)===savedSettings.get(key))dirtySettings.delete(key);
  else dirtySettings.add(key);
}
settingsForm.addEventListener('input',trackSettingsEdit);
settingsForm.addEventListener('change',trackSettingsEdit);
settingsForm.onsubmit=guard(async()=>{
  const button=settingsForm.querySelector('button');
  if(button.disabled)return;
  if(!state){notice('运行设置正在载入。');return;}
  if(!dirtySettings.size){notice('运行设置没有修改。');return;}
  const submitted=new Map(),patch={},limits={};
  for(const key of dirtySettings){
    const field=settingsForm.elements[key],value=settingValue(field);
    submitted.set(key,value);
    const destination=settingsLimits.has(key)?limits:patch;
    destination[key]=field.type==='number'?Number(value):value;
  }
  if(Object.keys(limits).length)patch.limits=limits;
  pendingSettings=submitted;
  button.disabled=true;
  try{
    await api('/api/config',patch);
    pendingSettings=undefined;
    for(const [key,value] of submitted){
      savedSettings.set(key,value);
      if(settingValue(settingsForm.elements[key])===value)dirtySettings.delete(key);
    }
    notice(dirtySettings.size?'已保存提交时的运行设置，之后的修改仍在编辑框。':'运行设置已保存。');
    await refresh();
  }finally{
    pendingSettings=undefined;
    button.disabled=false;
  }
});
$('owner-form').onsubmit=guard(async()=>{const prompt=$('owner-prompt').value;if(!ownerSubmitRequest||ownerSubmitRequest.prompt!==prompt)ownerSubmitRequest={prompt,requestId:crypto.randomUUID()};await api('/api/owner-task',ownerSubmitRequest);ownerSubmitRequest=null;$('owner-prompt').value='';notice('任务已交给小鲸；普通HR回复继续处理，网页发送依次执行。');await refresh();});
$('learning-filter').onchange=renderLearning;
$('learning-retry').onclick=guard(async()=>{const r=await api('/api/learning/retry',{});notice(`已重新排队 ${r.count} 份资料，仍遵循每日整理上限。`);await refresh();});
$('learning-note-clear').onclick=()=>{$('learning-note-id').value='';$('learning-note').value='';};
$('learning-note-form').onsubmit=guard(async()=>{await api('/api/learning/note',{text:$('learning-note').value,...($('learning-note-id').value?{id:$('learning-note-id').value}:{})});$('learning-note-clear').click();notice('小鲸已记住，后续任务将按适用范围调用；相关旧草稿已失效。');await refresh();});
$('key-form').onsubmit=guard(async()=>{await api('/api/key',{key:$('key').value});$('key').value='';notice('密钥已加密保存。');await refresh();});
$('browser-token-form').onsubmit=guard(async()=>{await api('/api/browser-token',{token:$('browser-token').value});$('browser-token').value='';notice('浏览器自动连接配置已加密保存，下次对话任务生效。');await refresh();});
$('browser-token-clear').onclick=guard(async()=>{await api('/api/browser-token',{clear:true});$('browser-token').value='';notice('已清除本地自动连接配置。');await refresh();});
$('test').onclick=guard(async()=>{const b=$('test');b.disabled=true;b.textContent='测试中…';try{const r=await api('/api/test',{});notice(`${r.backend==='harness'?'Harness → DeepSeek':'DeepSeek API'} 连接成功，已收到有效 JSON。`);}finally{b.disabled=false;b.textContent='测试连接';}});
function showPairToken(show){
  $('pair-token').type=show?'text':'password';$('show-token').textContent=show?'隐藏':'显示';$('show-token').setAttribute('aria-pressed',String(show));
}
function selectPairToken(){const field=$('pair-token');field.focus();field.select();field.setSelectionRange(0,field.value.length);}
$('show-token').onclick=()=>{const show=$('pair-token').type==='password';showPairToken(show);if(show)selectPairToken();};
$('pair-token').onclick=selectPairToken;
$('copy').onclick=guard(async()=>{
  if(!extensionToken)throw Error('配对码尚未载入，请刷新控制台。');
  try{if(!navigator.clipboard?.writeText)throw Error('无法使用剪贴板');await navigator.clipboard.writeText(extensionToken);$('pair-help').textContent='已复制。打开 Edge 工具栏的求职助手弹窗，粘贴到“本地配对码”，点击“保存并连接”。';}
  catch{
    const wasHidden=$('pair-token').type==='password';showPairToken(true);selectPairToken();let copied=false;
    try{copied=document.execCommand('copy');}catch{}
    if(copied){showPairToken(!wasHidden);$('pair-help').textContent='已复制。打开求职助手弹窗，粘贴到“本地配对码”，点击“保存并连接”。';}
    else{$('pair-help').textContent='浏览器未允许自动复制，已显示并选中配对码。请按 Ctrl+C，再到求职助手弹窗按 Ctrl+V。';}
  }
});
$('save-selectors').onclick=guard(async()=>{const selectors=JSON.parse($('selectors').value);await api('/api/config',{selectors});notice('页面规则已保存，请刷新 BOSS 页面。');await refresh();});
(async()=>{try{const session=await(await fetch('/api/session')).json();token=session.token;extensionToken=session.extensionToken;$('pair-token').value=extensionToken;await refresh();const initial=location.hash.slice(1);if(['control','context','project-map','owner','job-channel','hr-channel'].includes(initial))panel(initial);}catch(e){notice('本地服务连接失败：'+e.message,true);}})();
async function pollState(){
  if(!token||periodicPending||window.xiaojingDesktop&&document.visibilityState==='hidden')return;
  periodicPending=true;
  try{await refresh();}catch(e){notice('本地服务连接中断：'+e.message,true);}
  finally{periodicPending=false;}
}
setInterval(pollState,5000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')void pollState();});
