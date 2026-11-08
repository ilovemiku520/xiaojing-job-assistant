/* Public DOM adapter. The dedicated link bridge only captures the URL produced
 * by 查看职位; no cookie reading, private API or captcha bypass. */
(()=>{
  if(globalThis.__bossAssistant)return;globalThis.__bossAssistant=true;
  const S={
    jobCard:'.job-card-wrapper, .job-card-box',jobTitle:'.job-name',company:'.boss-info, .boss-name, .company-name',city:'.company-location, .job-area, .job-area-wrapper',salary:'.job-salary, .salary',jobLink:'a[href*="/job_detail/"]',
    detailTitle:'.job-banner .name h1, .job-banner h1',detailCompany:'.sider-company .company-info a, .company-info .company-name',detailCity:'.job-banner .text-city, .job-banner .info-primary p',detailSalary:'.job-banner .salary',description:'.job-sec-text:not(.fold-text)',
    contact:'.job-banner .btn-startchat, .job-op .btn-startchat',
    activePeer:'.friend-content.selected, .friend-list .friend-item.active, .friend-list .friend-item.selected, .user-list .user-item.active',peerItem:'.friend-content, .friend-item, .user-item',unread:'.badge, .red-dot, .unread-num',
    chatRoot:'.chat-conversation, .chat-window, .chat-container',chatHeader:'.chat-conversation .top-info-content, .chat-conversation .chat-title, .chat-window .chat-title, .chat-container .chat-header',
    hrMessage:'.message-item.item-friend, .message-item.friend, .message-item.received',selfMessage:'.message-item.item-myself, .message-item.myself, .message-item.sent',messageText:'.text, .text-content, .message-text',
    editor:'.chat-editor [contenteditable="true"], #chat-input, textarea.chat-input',send:'.chat-editor .btn-send, .chat-input .btn-send',
    resumeOpen:'.chat-op .btn-resume, .chat-toolbar [data-action="resume"]',resumeDialog:'.resume-dialog, .dialog-resume, [role="dialog"]',resumeRow:'.resume-item, .resume-list li',resumeConfirm:'.btn-primary, .btn-sure',
    resumeName:'.resume-name, .file-name, .name',
    resumeSent:'.message-item.item-myself .resume-card, .message-item.sent .resume-card',
    blocked:'.geetest_panel, .captcha-container, .verify-dialog, .login-dialog'
  };
  let config,working=false,lastSwitch=0,claimed=null,inlineGreeting,lastError='',worker=null,activeDocument=document,lastInspection=0;
  const jobRunning=()=>typeof config?.jobSearchRunning==='boolean'?config.jobSearchRunning:!!config?.running;
  const hrRunning=()=>typeof config?.hrInboxRunning==='boolean'?config.hrInboxRunning:!!config?.running;
  const greetingEnabled=()=>jobRunning()||!!(config?.ownerGreeting&&(!worker?.greetingPlanId||config.ownerGreeting.id===worker.greetingPlanId));
  const manualWork=()=>!!(config?.readingEnabled||config?.ownerChat||config?.ownerGreeting||['selecting','ready','executing'].includes(config?.singleTest?.status));
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function api(path,data,method){const r=await chrome.runtime.sendMessage({type:'api',path,data,method});if(!r?.ok)throw Error(r?.error||'扩展连接中断');return r.result;}
  const visible=e=>!!e&&e.getClientRects().length>0&&e.ownerDocument.defaultView.getComputedStyle(e).visibility!=='hidden'&&e.ownerDocument.defaultView.getComputedStyle(e).display!=='none';
  function documents(){
    const found=[document];
    for(let i=0;i<found.length&&found.length<8;i++)for(const f of found[i].querySelectorAll('iframe'))try{if(visible(f)&&f.contentDocument?.body&&!found.includes(f.contentDocument))found.push(f.contentDocument);}catch{}
    return found;
  }
  function selectDocument(){
    const score=d=>{
      let n=0;
      for(const [key,weight] of [['editor',30],['chatRoot',15],['activePeer',15],['hrMessage',2],['jobCard',1]])n+=Math.min(d.querySelectorAll(config?.selectors?.[key]||S[key]).length,30)*weight;
      if(d!==document&&/\/chat\b/.test(new URL(d.URL).pathname))n+=10;
      return n;
    };
    activeDocument=documents().sort((a,b)=>score(b)-score(a))[0];
  }
  function list(key,root=activeDocument){return [...root.querySelectorAll(config?.selectors?.[key]||S[key])].filter(visible);}
  function one(key,root=activeDocument){const a=list(key,root);return a.length===1?a[0]:null;}
  const isChatPage=()=>/\/chat(?:\/|$)/.test(location.pathname)||/\/chat(?:\/|$)/.test(new URL(activeDocument.URL).pathname);
  const txt=e=>(e?.innerText||e?.textContent||'').trim();
  const text=(key,root=activeDocument)=>txt(one(key,root));
  const messageId=e=>e.getAttribute('data-mid')||e.getAttribute('data-msg-id')||e.getAttribute('data-message-id')||'';
  const receiptText=value=>String(value||'').normalize('NFC').replace(/\s+/g,' ').trim();
  const receiptBody=e=>receiptText(text('messageText',e)||txt(e).replace(/^(?:(?:今天|昨天)\s+)?(?:[01]?\d|2[0-3])[:：][0-5]\d\s+(?:已送达|已发送|未读|已读|送达)\s+/,''));
  function fieldText(key,root){const values=[...new Set(list(key,root).map(txt).filter(Boolean))];return values.length===1?values[0]:(values.find(v=>values.every(x=>v.includes(x)))||'');}
  const norm=s=>String(s).replace(/\s+/g,'').toLowerCase();
  const enabled=e=>!!e&&!e.disabled&&e.getAttribute('aria-disabled')!=='true'&&!e.closest('[disabled],[aria-disabled="true"],.disabled,.unable,.is-disabled');
  function resumeUI(root,selectedPeer){return window.BossResumeUI.inspect({root,selectedPeer,config});}
  const realtime=window.BossRealtime.create({storage:chrome.storage.local});
  const bindings=new WeakMap(),incomingLabels=realtime.events,visitedLabels=new Set(),historyReadIds=new Set();
  let monitor=false,replyRows=[];
  const replySubmissions=new Map(),legacyBlockedReplies=new Map();
  const replyEventKey=key=>JSON.stringify(incomingLabels.get(key)||null);
  const sameReplyLabel=(row,label)=>row.name===label.name&&norm(row.company)===norm(label.company);
  const replyGenerating=row=>row.status==='queued'||row.status==='generating';
  const queueBusy=row=>replyGenerating(row)||row.status==='failed'&&(!row.retryAt||row.retryAt>Date.now());
  function updateReplyRow(row){if(!row?.id||!row.peerId)return;replyRows=replyRows.filter(item=>item.id!==row.id);replyRows.push(row);}
  async function readReplyQueue(){
    const result=await api('/api/replies/state',undefined,'GET');
    if(!Array.isArray(result.items))throw Error('异步回复组件尚未连接，请更新本地服务');
    return result.items;
  }
  async function refreshReplyQueue(){
    replyRows=await readReplyQueue();
    const now=Date.now();for(const [id,until] of legacyBlockedReplies)if(until<=now)legacyBlockedReplies.delete(id);
  }
  const replyInputAllowed=()=>config.chatInput!==false&&config.browserCalibrated!==false;
  let watchEpoch=0,historyReading=false,botEditor=null,humanEditingAt=0,humanPageAt=0,jobReading=false;
  function safeJobURL(value){try{const u=new URL(value,location.href);return u.origin==='https://www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(u.pathname)?u.origin+u.pathname:'';}catch{return '';}}
  function chatPosition(c){
    const strips=[...c.root.querySelectorAll('.chat-position-content')].filter(visible);if(strips.length!==1)return {};
    const strip=strips[0],urls=[...new Set([...strip.querySelectorAll('a[href]')].map(e=>safeJobURL(e.href)).filter(Boolean))];
    return {title:txt(strip.querySelector('.position-name')),company:peerLabel(c.selectedPeer).company,city:txt(strip.querySelector('.city')),salary:txt(strip.querySelector('.salary')),url:urls.length===1?urls[0]:''};
  }
  function peerLabel(peer){
    const name=txt(peer?.querySelector('.name-text'));
    const company=peer?[...peer.querySelectorAll('.title-box span')].find(e=>!e.matches('.name-box,.name-text')&&!e.querySelector('span')&&txt(e)&&txt(e)!==name):null;
    return {name,company:txt(company),key:name&&company?name+'\u001f'+txt(company):''};
  }
  const leafPeers=()=>list('peerItem').filter(p=>!list('peerItem',p).length);
  function nativePeerId(peer,peers){
    for(let n=peer,level=0;n&&level<4&&n!==activeDocument.body;n=n.parentElement,level++){
      if(n!==peer&&peers.some(other=>other!==peer&&n.contains(other)))break;
      const val=n.getAttribute('data-id')||n.getAttribute('data-uid')||n.getAttribute('data-friend-id')||n.getAttribute('data-boss-id')||n.dataset.bossPeer;
      if(val&&/^[\w:.-]{3,200}$/.test(val))return 'boss:'+val;
    }
    const href=peer?.querySelector('a[href]')?.getAttribute('href');
    if(href)try{const u=new URL(href,location.href),v=u.searchParams.get('friendId')||u.searchParams.get('encryptBossId');if(u.origin===location.origin&&v&&/^[\w.-]{3,200}$/.test(v))return 'boss:'+v;}catch{}
    return '';
  }
  function peerRows(){
    const peers=leafPeers(),labels=new Map(),ids=new Map();
    const rows=peers.map(peer=>{
      const {name,company,key:legacyKey}=peerLabel(peer),stableId=nativePeerId(peer,peers),match=legacyKey?name+'\u001f'+norm(company):'';
      if(match)labels.set(match,(labels.get(match)||0)+1);
      if(stableId)ids.set(stableId,(ids.get(stableId)||0)+1);
      return {peer,identity:{name,company,legacyKey,stableId},match};
    });
    for(const {identity,match} of rows){
      const {legacyKey,stableId}=identity,duplicateLabel=labels.get(match)>1;
      const uniqueLabel=!!legacyKey&&!duplicateLabel&&!realtime.ambiguous(legacyKey);
      Object.assign(identity,{uniqueLabel,duplicateLabel,key:legacyKey?(stableId?(ids.get(stableId)===1?stableId:''):(uniqueLabel?legacyKey:'')):''});
    }
    return rows;
  }
  function identityOf(peer,rows){
    if(!peer)return null;
    rows??=peerRows();
    const matches=rows.filter(row=>row.peer===peer||peer.contains(row.peer)||row.peer.contains(peer));
    return matches.length===1?matches[0].identity:null;
  }
  function notifyInbox(result){if(result?.added)void chrome.runtime.sendMessage({type:'chatEvent'}).catch(()=>{});}
  const sidebarOutgoing=peer=>!!peer?.querySelector('.message-status.status-delivery, .message-status.status-read');
  function watchSidebar(rows){
    const items=rows.map(({peer:p,identity})=>({...identity,preview:txt(p.querySelector('.last-msg-text')),time:txt(p.querySelector('.time')),outgoing:sidebarOutgoing(p),unread:Number(txt(p.querySelector('.notice-badge')))||0}));
    notifyInbox(realtime.observeSidebar(items));
  }
  function seedWatcher(rows=peerRows()){if(watchEpoch!==config.watchEpoch){watchEpoch=config.watchEpoch;realtime.reset(watchEpoch);}watchSidebar(rows);}
  function trackWindow(c){
    const key=c.identity?.key;if(!key||one('activePeer')!==c.selectedPeer)return false;
    const signal=incomingLabels.get(key),tail=c.messages.at(-1);
    // A fresh sidebar preview can lead the chat body. Its old outgoing tail
    // is not evidence that this incoming event has already been answered.
    if(signal?.source==='sidebar'&&(tail?.role==='self'||realtime.isSystemNotice(tail?.text))&&
      norm(txt(c.selectedPeer?.querySelector('.last-msg-text')))===norm(signal.preview)&&!sidebarOutgoing(c.selectedPeer))return false;
    notifyInbox(realtime.observeWindow({key,peerId:c.id,messages:c.messages,resumeUI:c.resumeUI}));return true;
  }
  function peerId(){
    const p=one('activePeer');if(!p)return '';
    const identity=identityOf(p);if(!identity?.key)return '';
    if(identity.stableId)return identity.stableId;
    const binding=bindings.get(p),label=peerLabel(p);
    if(binding&&binding.label===label.key&&[...list('hrMessage'),...list('selfMessage')].some(m=>binding.ids.has(m.getAttribute('data-mid')||m.getAttribute('data-msg-id')||m.getAttribute('data-message-id'))))return binding.id;
    return '';
  }
  function readMessages(root,limit=80){
    const hr=new Set(list('hrMessage',root)),self=new Set(list('selfMessage',root));
    const nodes=[...new Set([...hr,...self])].sort((a,b)=>a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1);
    if(nodes.some(e=>hr.has(e)&&self.has(e)))throw Error('消息方向选择器存在重叠，请修正');
    return nodes.map(e=>({id:messageId(e),role:hr.has(e)?'hr':'self',text:(text('messageText',e)||txt(e)).slice(0,4000),time:e.getAttribute('data-time')||''})).filter(m=>m.text).slice(-limit);
  }
  function chat(forcedId){
    let root=one('chatRoot');const id=forcedId||peerId();
    if(!root){const editor=one('editor'),all=[...list('hrMessage'),...list('selfMessage')];for(let n=editor?.parentElement;n&&n!==activeDocument.body;n=n.parentElement)if(all.length&&all.every(e=>n.contains(e))){root=n;break;}}
    if(!root||!id)return null;
    const messages=readMessages(root);
    const selectedPeer=one('activePeer');return {id,messages,header:text('chatHeader')||txt(selectedPeer).split('\n').slice(0,2).join(' '),root,selectedPeer,resumeUI:resumeUI(root,selectedPeer)};
  }
  let lastUnreadRecovery='';
  function recoverUnreadFilter(){
    if(!monitor||!hrRunning()||!isChatPage()||!incomingLabels.size||one('activePeer')||config.autoBrowse===false||config.ownerChat||worker||claimed||jobReading||historyReading)return false;
    if(Date.now()-humanPageAt<60000||Date.now()-humanEditingAt<60000)return false;
    const editor=one('editor');if((editor?.value||editor?.innerText||'').trim())return false;
    const signature=JSON.stringify([...incomingLabels].map(([key,event])=>[key,event.at]).sort((a,b)=>a[0].localeCompare(b[0])));if(signature===lastUnreadRecovery)return false;
    const selector='button,a,li,span,div,[role="tab"],[role="button"]';
    const filterName=element=>txt(element).replace(/\s+/g,'').match(/^(全部|未读|新招呼|仅沟通)(?:[（(]?\d+\+?[)）]?)?$/)?.[1]||'';
    const chatRoot=one('chatRoot'),scopes=new Set();
    // Only inspect the contact-list branch. A similarly named button inside
    // a message, job detail or the main navigation is never a recovery target.
    for(const listRoot of activeDocument.querySelectorAll('.friend-list,.chat-list,.chat-user,.user-list'))for(let n=listRoot,depth=0;n&&n!==activeDocument.body&&depth<3;n=n.parentElement,depth++)if(visible(n)&&(!chatRoot||!n.contains(chatRoot)))scopes.add(n);
    const bars=new Map();
    for(const scope of scopes){
      const leaves=[...scope.querySelectorAll(selector)].filter(visible).filter(e=>filterName(e)&&![...e.querySelectorAll(selector)].some(child=>filterName(child)));
      for(const all of leaves.filter(e=>filterName(e)==='全部'))for(let bar=all.parentElement,depth=0;bar&&scope.contains(bar)&&depth<4;bar=bar.parentElement,depth++){
        const group=leaves.filter(e=>bar.contains(e));if(group.length!==4||!['全部','未读','新招呼','仅沟通'].every(name=>group.filter(e=>filterName(e)===name).length===1))continue;
        const selected=e=>{for(let n=e;n&&n!==bar;n=n.parentElement)if(n.getAttribute('aria-selected')==='true'||n.getAttribute('aria-current')==='page'||/(?:^|\s)(?:active|selected|current|checked|cur)(?:\s|$)/.test(String(n.className)))return true;return false;};
        const unread=group.find(e=>filterName(e)==='未读');if(!selected(unread)||group.some(e=>e!==unread&&selected(e))||!enabled(all))continue;
        bars.set(all,bar);break;
      }
    }
    if(bars.size!==1)return false;
    lastUnreadRecovery=signature;[...bars.keys()][0].click();lastSwitch=Date.now();return true;
  }
  let displayedThread=null,waitingThread=null;
  async function resolveCurrent(rows){
    const selected=one('activePeer');if(!selected){recoverUnreadFilter();return null;}
    const selectedLabel=identityOf(selected,rows),header=one('chatHeader');
    // BOSS can select the sidebar row before replacing the conversation body.
    // Do not attribute that old window to the newly selected stable peer ID.
    if(!selectedLabel?.key||!header||!norm(txt(header)).includes(norm(selectedLabel.name))||!norm(txt(header)).includes(norm(selectedLabel.company)))return null;
    if(selectedLabel.stableId){
      const current=chat(selectedLabel.stableId);if(!current)return null;
      const ids=new Set(current.messages.map(m=>m.id).filter(Boolean));
      if(displayedThread&&displayedThread.id!==current.id&&sameReplyLabel(displayedThread,selectedLabel)&&
        (!ids.size||[...ids].some(id=>displayedThread.ids.has(id)))){
        if(waitingThread?.id!==current.id)waitingThread={id:current.id,at:Date.now()};
        return null;
      }
      waitingThread=null;
      if(ids.size)displayedThread={id:current.id,name:selectedLabel.name,company:selectedLabel.company,ids};
      return {...current,identity:selectedLabel};
    }
    const label=peerLabel(selected),c=chat('boss:pending');if(!label.key||!c?.messages.length)return null;
    const job=chatPosition(c),signature=JSON.stringify([c.messages,c.resumeUI,job]),old=bindings.get(selected);
    if(old?.signature===signature&&old.label===label.key){const current=chat(old.id);return current&&{...current,identity:selectedLabel};}
    const result=await api('/api/chat/resolve',{name:label.name,company:label.company,uniquePeer:true,header:c.header,job,messages:c.messages,resumeUI:c.resumeUI});
    const latest=identityOf(selected);
    if(one('activePeer')!==selected||latest?.key!==label.key)return null;
    bindings.set(selected,{id:result.peerId,label:label.key,signature,ids:new Set(c.messages.map(m=>m.id))});
    const current=chat(result.peerId);return current&&{...current,identity:latest};
  }
  async function readHistory(c){
    const label=peerLabel(c.selectedPeer);if(config.historyRead===false||!label.key||historyReadIds.has(c.id))return;
    historyReading=true;
    try{
      const record=c.root.querySelector('.chat-record'),scrollers=[];for(let n=record;n&&c.root.contains(n);n=n.parentElement)if(n.scrollHeight>n.clientHeight+50&&/(auto|scroll)/.test(n.ownerDocument.defaultView.getComputedStyle(n).overflowY))scrollers.push(n);
      const scroll=scrollers[0],distance=scroll?scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop:0;let count=readMessages(c.root,500).length;
      if(scroll)for(let i=0;i<3;i++){
        if(one('activePeer')!==c.selectedPeer||txt(one('editor')))break;
        scroll.scrollTop=0;scroll.dispatchEvent(new Event('scroll',{bubbles:true}));await sleep(900);
        const next=readMessages(c.root,500).length;if(next<=count)break;count=next;
      }
      if(one('activePeer')!==c.selectedPeer)throw Error('读取历史时会话发生变化');
      const messages=readMessages(c.root,500).filter(m=>m.id);
      for(let end=messages.length;end>0;end-=79){const chunk=messages.slice(Math.max(0,end-80),end);if(!chunk.length)break;await api('/api/chat/history',{peerId:c.id,...label,messages:chunk,reachedStart:false});if(end<=80)break;}
      if(scroll){scroll.scrollTop=Math.max(0,scroll.scrollHeight-scroll.clientHeight-distance);await sleep(200);}historyReadIds.add(c.id);visitedLabels.add(identityOf(c.selectedPeer)?.key||label.key);
    }finally{historyReading=false;}
  }
  function experienceOf(card){
    const items=[...card.querySelectorAll('.tag-list li, .job-card-footer .tag-list li')].map(txt).filter(Boolean);
    return items.find(t=>/应届|在校|经验不限|无经验|^\s*(?:\d{1,2}(?:\.\d+)?\s*(?:[-–—~～至到]\s*\d{1,2}(?:\.\d+)?\s*)?)(?:年|个?月)/.test(t))||'';
  }
  function jobCard(card){
    const links=[...(card.matches('a[href*="/job_detail/"]')?[card]:[]),...list('jobLink',card)];
    const urls=[...new Set(links.map(a=>new URL(a.getAttribute('href'),location.href)).filter(u=>u.origin==='https://www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(u.pathname)).map(u=>u.origin+u.pathname))];
    const link=urls.length===1?links.find(a=>new URL(a.getAttribute('href'),location.href).pathname===new URL(urls[0]).pathname):null;
    return {title:fieldText('jobTitle',card)||(link?txt(link).split('\n')[0].slice(0,200):''),company:fieldText('company',card),city:fieldText('city',card),salary:fieldText('salary',card),experience:experienceOf(card),url:urls.length===1?urls[0]:''};
  }
  function detail(){
    const root=[...activeDocument.querySelectorAll('.job-detail-container,.job-detail-box')].find(visible),plain=s=>/[\uE000-\uF8FF]/.test(s)?'':s;
    const first=selector=>[...activeDocument.querySelectorAll(selector)].filter(visible).map(txt).find(Boolean)||'';
    return {title:fieldText('detailTitle',activeDocument)||txt(root?.querySelector('.job-name')),company:fieldText('detailCompany',activeDocument)||first('.job-detail-company .company-name,.job-detail-company .company-info a,.company-info .company-name,.sider-company .name'),city:first('.job-banner .text-city,.job-detail-container .job-area,.job-detail-box .job-area')||fieldText('detailCity',activeDocument),experience:experienceOf(root||activeDocument.body),salary:plain(fieldText('detailSalary',activeDocument)||txt(root?.querySelector('.job-salary'))),description:fieldText('description',activeDocument)||txt(root?.querySelector('.job-detail-body .desc')),url:location.href};
  }
  const jobViewSelector='.job-detail-dialog,.dialog-wrap,.dialog-container,.dialog-content,.ui-dialog,.boss-popup,.boss-popup__wrapper,[role="dialog"],.position-detail,.job-detail,.job-detail-box,.job-detail-container,.job-detail-content,.job-detail-wrap,.job-detail-body';
  const jobDescriptionSelector='.job-sec-text,.job-detail-description,.job-description,.job-desc,.job-duty,.job-require,.job-detail-body .desc';
  function jobViews(){
    return documents().flatMap(d=>[...d.querySelectorAll(config?.selectors?.chatJobView||jobViewSelector)].filter(visible).map(root=>({root,doc:d}))).filter(v=>!v.root.matches(S.chatRoot));
  }
  function readPositionView(expected,view){
    const {root,doc}=view;
    const headings=[...root.querySelectorAll(config?.selectors?.chatJobTitle||'h1,h2,h3,.job-name,.job-title,.position-name,.name,.title')].filter(visible);
    const heading=headings.find(e=>norm(txt(e))===norm(expected.title));if(!heading)return null;
    let descriptions=[...root.querySelectorAll(config?.selectors?.chatJobDescription||jobDescriptionSelector)].filter(visible).filter(e=>!e.closest('.job-detail-company'));
    descriptions=descriptions.filter(e=>!descriptions.some(other=>e!==other&&other.contains(e)));
    if(!descriptions.length){
      const labels=[...root.querySelectorAll('h2,h3,h4,.title,.job-sec-title')].filter(visible).filter(e=>/^(?:职位描述|岗位职责|任职要求|职位要求)[：:]?$/.test(txt(e)));
      descriptions=labels.map(e=>e.parentElement).filter(e=>txt(e).length>=40&&txt(e).length<16000);
    }
    const description=[...new Set(descriptions.map(txt))].join('\n\n').slice(0,12000);if(!description)return null;
    const value=selector=>{const items=[...new Set([...root.querySelectorAll(selector)].filter(visible).map(txt).filter(Boolean))];return items.length===1?items[0]:'';};
    const urls=[...new Set([...root.querySelectorAll('a[href]')].map(a=>safeJobURL(a.href)).filter(Boolean))];
    return {title:txt(heading),description,company:value('.company-name,.company-info .name,.sider-company .company-info a'),salary:value('.salary'),city:value('.text-city,.job-city'),url:safeJobURL(doc.URL)||(urls.length===1?urls[0]:'')};
  }
  function closePositionView(view){
    for(let root=view.root,n=0;root&&root!==view.doc.body&&n<7;root=root.parentElement,n++){
      const closes=[...root.querySelectorAll('.dialog-close,.boss-popup__close,.boss-popup__close-icon,.boss-popup-close,.close-dialog,.job-detail-close,.icon-close,.close-icon,[aria-label="关闭"],[aria-label="Close"],.close')].filter(visible);
      if(closes.length===1){closes[0].click();return true;}
    }return false;
  }
  function waitPositionView(role,stillHere){
    // Observe rendering directly. Repeated short timers can stall for minutes in a background tab.
    return new Promise(resolve=>{
      let done=false,timer;const observers=[],docs=documents();
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);for(const o of observers)o.disconnect();for(const d of docs)d.removeEventListener('load',scan,true);resolve(value);};
      const scan=()=>{if(!stillHere()){finish(null);return;}const view=jobViews().find(v=>readPositionView(role,v));if(view)finish(view);};
      for(const d of docs){const o=new MutationObserver(scan);o.observe(d.body,{childList:true,subtree:true,characterData:true});observers.push(o);d.addEventListener('load',scan,true);}
      timer=setTimeout(()=>finish(null),6500);scan();
    });
  }
  async function completePosition(read,job,reason=''){
    return api('/api/chat/job/complete',{requestId:read.requestId,lease:read.lease,peerId:read.peerId,success:!!job,job:job||{},reason});
  }
  function openPositionEntry(role,entry){
    return new Promise(resolve=>{
      const id=crypto.randomUUID();let done=false,accepted=false;
      const finish=value=>{if(done)return;done=true;clearTimeout(timer);window.removeEventListener('boss-assistant-position-link-result',receive);resolve(value);};
      const receive=e=>{if(e.detail?.id!==id)return;if(e.detail.ready){accepted=true;return;}finish(safeJobURL(e.detail.url));};
      window.addEventListener('boss-assistant-position-link-result',receive);
      const timer=setTimeout(()=>finish(''),5500);
      window.dispatchEvent(new CustomEvent('boss-assistant-read-position-link',{detail:{id,title:role.title}}));
      // Older installs without the bridge still support ordinary in-page dialogs.
      if(!accepted&&!done){entry.click();finish('');}
    });
  }
  async function readChatPosition(c){
    const role=chatPosition(c),label=peerLabel(c.selectedPeer);if(!role.title||!label.key)return true;
    const editor=one('editor');if((editor?.value||editor?.innerText||'').trim()||Date.now()-humanEditingAt<60000)return false;
    const read=await api('/api/chat/job/start',{peerId:c.id,...label,uniquePeer:true,header:c.header,messages:c.messages,resumeUI:c.resumeUI,job:role});
    if(read.cached)return true;if(read.busy)return false;
    if(read.role?.url)role.url=safeJobURL(read.role.url);
    const stillHere=()=>one('activePeer')===c.selectedPeer&&peerLabel(c.selectedPeer).key===label.key&&norm(chatPosition(c).title)===norm(role.title);
    if(!stillHere()){await completePosition(read,null,'读取前用户已切换会话');return false;}
    jobReading=true;const at=Date.now(),before=new Set(jobViews().map(v=>v.root));let opened=false;
    try{
      let view=jobViews().find(v=>readPositionView(role,v));
      if(!view&&role.url){const result=await chrome.runtime.sendMessage({type:'chatJobOpen',read,url:role.url});if(!result?.ok)throw Error(result?.error||'职位读取页未打开');return false;}
      if(!view){
        const strip=c.root.querySelector('.chat-position-content');
        const entries=[...strip.querySelectorAll('a,button,span,div,[role="button"]')].filter(visible).filter(e=>/^查看职位\s*[>›»]?\s*$/.test(txt(e))&&![...e.children].some(n=>/^查看职位\s*[>›»]?\s*$/.test(txt(n))));
        if(entries.length!==1){await completePosition(read,null,'未能唯一识别聊天顶部的查看职位入口');return true;}
        const result=await chrome.runtime.sendMessage({type:'chatJobOpen',read});if(!result?.ok)throw Error(result?.error||'读取准备失败');
        if(!stillHere()){await completePosition(read,null,'点击前会话已变化');return false;}
        const url=await openPositionEntry(role,entries[0]);opened=true;
        if(url){
          const result=await chrome.runtime.sendMessage({type:'chatJobNavigate',requestId:read.requestId,url});if(!result?.ok)throw Error(result?.error||'职位详情页未打开');return false;
        }
      }
      view=view||await waitPositionView(role,stillHere);
      if(!stillHere()){await completePosition(read,null,'读取期间会话已切换，未关联详情');return false;}
      if(view){const job=readPositionView(role,view);await completePosition(read,job);if(opened&&!before.has(view.root)&&humanPageAt<at)closePositionView(view);return true;}
      const tab=await chrome.runtime.sendMessage({type:'chatJobFind',requestId:read.requestId});if(tab?.result?.pending)return false;
      await reportInspection(true);await completePosition(read,null,'查看职位后尚未识别完整正文，可能岗位下线或页面结构需要校准');return true;
    }catch(e){await completePosition(read,null,e.message).catch(()=>{});lastError='职位读取：'+e.message;return true;}
    finally{if(opened&&humanPageAt<at){const own=jobViews().find(v=>!before.has(v.root));if(own)closePositionView(own);}jobReading=false;if(!role.url)await chrome.runtime.sendMessage({type:'chatJobRelease',requestId:read.requestId}).catch(()=>{});}
  }
  async function chatPositionWorker(){
    const r=await chrome.runtime.sendMessage({type:'chatJobWorker'}),read=r?.result;if(!read?.requestId||!read.peerId)return false;
    try{const job=detail();if(!job.title||!job.description){await reportInspection();if(Date.now()-read.at<45000)return true;await completePosition(read,null,'职位页面未显示完整说明或已下线');}
    else await completePosition(read,job);}catch(e){await completePosition(read,null,e.message).catch(()=>{});lastError='职位读取：'+e.message;}
    await chrome.runtime.sendMessage({type:'chatJobDone',requestId:read.requestId});return true;
  }
  async function reportInspection(force=false){
    if(!force&&Date.now()-lastInspection<20000)return;lastInspection=Date.now();
    const describe=e=>({tag:e.tagName,attrs:Object.fromEntries([...e.attributes].filter(a=>/^(?:class|id|name|role|contenteditable|href|data-[\w-]*(?:id|uid|key|time))$/.test(a.name)).map(a=>[a.name,a.value.slice(0,300)])),text:e.children.length?'':txt(e).slice(0,150)});
    const ancestry=e=>{const result=[];for(let n=e,i=0;n&&i<5;n=n.parentElement,i++)result.push(describe(n));return result;};
    const c=chat();
    if(c)await api('/api/inspection',{url:location.origin+location.pathname,documentURL:activeDocument.URL.split('?')[0],peerId:c.id,header:c.header,jobUI:{position:chatPosition(c),entry:[...c.root.querySelectorAll('.chat-position-content *')].filter(visible).map(e=>({...describe(e),text:txt(e).slice(0,300)})),views:jobViews().slice(0,5).map(v=>({root:describe(v.root),text:txt(v.root).slice(0,16000),nodes:[...v.root.querySelectorAll('*')].filter(visible).slice(0,150).map(describe)}))},selected:ancestry(c.selectedPeer),editor:ancestry(one('editor')),hrMessages:list('hrMessage').slice(-10).map(e=>({node:describe(e),parents:ancestry(e),text:txt(e).slice(0,2000)})),selfMessages:list('selfMessage').slice(-10).map(e=>({node:describe(e),text:txt(e).slice(0,2000)})),messages:c.messages,resumeUI:c.resumeUI,resumeNodes:[...c.root.querySelectorAll('*')].filter(visible).filter(e=>/简历|附件|同意|拒绝/.test(txt(e))&&txt(e).length<1500).slice(-50).map(e=>({...describe(e),text:txt(e).slice(0,1500)})),nodes:[...activeDocument.body.querySelectorAll('*')].filter(visible).filter(e=>!/^(SCRIPT|STYLE|PATH|SVG|NOSCRIPT)$/i.test(e.tagName)).slice(0,1100).map(describe)});
    if(c)return;
    await api('/api/inspection',{url:location.origin+location.pathname,documentURL:activeDocument.URL.split('?')[0],selected:ancestry(one('activePeer')),editor:ancestry(one('editor')),hrMessages:list('hrMessage').slice(-10).map(e=>({node:describe(e),parents:ancestry(e),text:txt(e).slice(0,2000)})),selfMessages:list('selfMessage').slice(-10).map(e=>({node:describe(e),text:txt(e).slice(0,2000)})),messages:c?.messages||[],peerId:c?.id||'',header:c?.header||'',nodes:[...activeDocument.body.querySelectorAll('*')].filter(visible).filter(e=>!/^(SCRIPT|STYLE|PATH|SVG|NOSCRIPT)$/i.test(e.tagName)).slice(0,1100).map(describe)});
  }
  let lastJobObservation,jobObservation;
  const jobObservationRefresh=60000;
  async function scanJobs(searchId){
    if(jobObservation){
      await jobObservation.catch(()=>{});
      return scanJobs(searchId);
    }
    const sourceDocument=activeDocument,page=location.href;
    const jobs=list('jobCard').slice(0,50).map(jobCard).filter(job=>job.url&&job.title);
    if(!jobs.length){lastJobObservation=undefined;return jobs;}
    const signature=JSON.stringify([...jobs].sort((a,b)=>a.url.localeCompare(b.url)));
    const scope=JSON.stringify([page,sourceDocument.URL,config?.watchEpoch,config?.bridgeEpoch]);
    const previous=lastJobObservation;
    const sameList=previous?.scope===scope&&previous.sourceDocument===sourceDocument&&previous.signature===signature;
    if(sameList&&(!searchId||previous.searchId===searchId)&&Date.now()-previous.at<jobObservationRefresh)return jobs;
    const request=api('/api/jobs/observe',{jobs});
    jobObservation=request;
    try{
      await request;
      lastJobObservation={scope,sourceDocument,signature,searchId:searchId||(sameList?previous.searchId:undefined),at:Date.now()};
    }finally{jobObservation=undefined;}
    return jobs;
  }
  let lastFavoriteObservation='';
  async function scanFavorites({allowNavigate=false}={}){
    if(!window.BossFavorites)return {confirmedList:false,reason:'收藏读取组件尚未载入'};
    const state=await api('/api/favorites/state',undefined,'GET');
    const opts=root=>({root,url:root.URL,sourcePageURL:location.href,ownerCollectionURL:config?.selectors?.favoriteCollectionURL||'',knownCollectionURL:state.navigation?.url||'',selectors:config?.selectors||{},parseCard:jobCard});
    const docs=documents().filter(d=>!/^\/web\/geek\/chat\/?$/.test(new URL(d.URL,location.href).pathname));
    const observations=[];for(const doc of docs)observations.push(await window.BossFavorites.scan({...opts(doc),allowNavigate:false}));
    let result=observations.filter(r=>r.confirmedList).sort((a,b)=>b.jobs.length-a.jobs.length)[0]||observations.find(r=>r.navigation)||observations[0]||{confirmedList:false,jobs:[],reason:'当前没有可读的收藏页面'};
    if(!result.confirmedList&&!result.navigation&&allowNavigate){
      if(Date.now()-humanPageAt<15000)return {...result,jobs:0,deferred:'human_active',reason:'主人刚操作了这个页面，短暂延后收藏导航'};
      for(const doc of [...new Set([document,activeDocument])].filter(d=>docs.includes(d))){const probe=await window.BossFavorites.scan({...opts(doc),allowNavigate:true});result=probe;if(probe.confirmedList||probe.navigation)break;}
    }
    if(result.navigation&&result.navigation.url!==state.navigation?.url)await api('/api/favorites/observe',{kind:'navigation',navigation:result.navigation,pageURL:activeDocument.URL});
    const signature=JSON.stringify([result.url,result.jobs.map(j=>[j.url,j.title,j.company,j.city,j.salary,j.experience]),result.empty]);
    if(result.confirmedList&&(result.jobs.length||result.empty)&&(state.due||signature!==lastFavoriteObservation)){await api('/api/favorites/observe',{kind:'list',url:result.url,jobs:result.jobs,empty:result.empty,confirmedList:true,evidence:JSON.stringify(result.evidence)});lastFavoriteObservation=signature;}
    return {confirmedList:result.confirmedList,empty:result.empty,jobs:result.jobs.length,navigation:result.navigation,reason:result.reason};
  }
  async function crawlDetail(){
    const r=await chrome.runtime.sendMessage({type:'crawlWorker'});const crawl=r?.result;if(!crawl)return false;
    if(!location.pathname.startsWith('/job_detail/'))return true;
    const job=detail();if(!job.description){await reportInspection();return true;}
    await api('/api/crawl/complete',{id:crawl.jobId,lease:crawl.lease,url:location.href,job,success:true,evidence:'已从对应岗位详情页可见内容读取'});
    await chrome.runtime.sendMessage({type:'crawlDone'});return true;
  }
  function nextChat(){
    const ready=replyInputAllowed()?replyRows.filter(row=>row.status==='ready'&&row.taskId&&
      (row.sendEligible===true||row.sendEligible===undefined&&config.mode==='auto'&&!legacyBlockedReplies.has(row.taskId))):[];
    const canSweep=config.mode==='auto'&&config.historySweepEnabled===true&&config.historyRead!==false&&!replyRows.some(queueBusy);
    if(!ready.length&&!incomingLabels.size&&!canSweep)return;
    if(jobReading||jobViews().length||config.autoBrowse===false||Date.now()-lastSwitch<(incomingLabels.size||ready.length?2000:20000))return;
    const focus=activeDocument.activeElement;if(focus?.matches('input,textarea,[contenteditable="true"]')&&Date.now()-humanEditingAt<60000)return;
    const editor=one('editor');if((editor?.value||editor?.innerText||'').trim())return;
    const peers=peerRows(),active=one('activePeer'),activeIdentity=identityOf(active,peers);if(!peers.length)return;
    if(waitingThread&&waitingThread.id===activeIdentity?.stableId&&Date.now()-waitingThread.at<6000)return;
    const uniquePeer=row=>{
      const exact=peers.filter(({identity})=>identity.stableId===row.peerId);
      const matches=exact.length?exact:peers.filter(({identity})=>!identity.stableId&&sameReplyLabel(row,identity));
      return matches.length===1&&matches[0].identity.key&&sameReplyLabel(row,matches[0].identity)?matches[0]:null;
    };
    // Selection only locates the visible row. Sending still claims the
    // resolved peer ID and current message fingerprint.
    const drafted=flag=>ready.filter(row=>row.sendEligible===flag).map(uniquePeer).find(p=>p&&p.identity!==activeIdentity);
    const pending=peers.find(({identity:label})=>{
      if(label===activeIdentity||!label.key||!incomingLabels.has(label.key))return false;
      const submitted=replySubmissions.get(label.key),unchanged=submitted?.eventKey===replyEventKey(label.key);
      return !unchanged||!replyRows.some(row=>row.id===submitted.id&&row.peerId===submitted.peerId&&sameReplyLabel(row,label)&&row.status!=='stale');
    });
    const history=canSweep?peers.find(({identity})=>identity!==activeIdentity&&identity.key&&!visitedLabels.has(identity.key)):null;
    const next=drafted(true)||pending||drafted(undefined)||history;if(next){next.peer.click();lastSwitch=Date.now();}
  }
  let calibrationAt=0,calibrationCache={};
  function calibrationDiagnostics(){
    const describe=e=>({tag:e.tagName,class:String(e.className||''),attrs:Object.fromEntries([...e.attributes].filter(a=>/^(?:id|data-(?:id|uid|friend-id|mid|msg-id|message-id|time)|contenteditable|role|name)$/.test(a.name)).map(a=>[a.name,a.value.slice(0,120)])),text:e.children.length?'':txt(e).slice(0,65)});
    const report={documentPath:new URL(activeDocument.URL).pathname,focusedEditor:!!activeDocument.activeElement?.matches('input,textarea,[contenteditable="true"]'),humanEditingRecent:Date.now()-humanEditingAt<60000,frames:JSON.stringify([...document.querySelectorAll('iframe')].map(f=>({id:f.id,class:f.className,path:f.src?new URL(f.src,location.href).pathname:'',visible:visible(f)}))).slice(0,490)};
    if(isChatPage()&&Date.now()-calibrationAt>=30000){
      calibrationAt=Date.now();
      const nodes=[...activeDocument.body.querySelectorAll('*')].filter(visible).filter(e=>!/^(SCRIPT|STYLE|SVG|PATH|IMG|BR)$/.test(e.tagName));
      for(let i=0;i<6;i++)report['chatShape'+i]=JSON.stringify(nodes.slice(i*6,i*6+6).map(describe)).slice(0,490);
      report.chatVisibleText=txt(activeDocument.body).slice(0,490);
      const candidates=nodes.filter(e=>/message|conversation|editor|friend|chat-input/i.test(String(e.className||''))||e.matches('textarea,[contenteditable="true"]'));
      for(let i=0;i<3;i++)report['chatCandidates'+i]=JSON.stringify(candidates.slice(i*4,i*4+4).map(describe)).slice(0,490);
      calibrationCache=Object.fromEntries(Object.entries(report).filter(([key])=>/^chat(?:Shape|Candidates|VisibleText)/.test(key)));
    }else if(isChatPage())Object.assign(report,calibrationCache);
    for(const [i,card] of list('jobCard').slice(0,2).entries()){
      report[`card${i}_fields`]=JSON.stringify(Object.fromEntries(['jobTitle','company','city','salary','jobLink'].map(k=>[k,list(k,card).length])));
      report[`card${i}_links`]=JSON.stringify([...card.querySelectorAll('a[href]')].slice(0,4).map(e=>({class:e.className,path:new URL(e.getAttribute('href'),location.href).pathname,text:txt(e).slice(0,50)}))).slice(0,490);
      report[`card${i}_structure`]=JSON.stringify([card,...card.querySelectorAll('*')].filter(visible).slice(0,13).map(e=>({tag:e.tagName,class:e.className,text:e.children.length?'':txt(e).slice(0,55)}))).slice(0,490);
      report[`card${i}_text`]=txt(card).slice(0,300);
    }
    return report;
  }
  const loginPage=()=>/^\/web\/user\/?$/.test(location.pathname);
  function visibleSignIn(){
    const selector='.login-dialog,.login-register-dialog,.login-container,[role="dialog"]';
    return documents().some(doc=>[...doc.querySelectorAll(selector)].some(dialog=>{
      if(!visible(dialog))return false;
      const caption=txt(dialog).replace(/\s+/g,'');
      const loginAction=[...dialog.querySelectorAll('button,a,[role="button"]')].some(button=>
        visible(button)&&/^(?:登录|去登录|立即登录|登录\s*\/\s*注册|获取验证码)$/.test(txt(button)));
      const phoneField=[...dialog.querySelectorAll('input[type="tel"],input[placeholder*="手机号"]')].some(visible);
      return /扫码登录|手机(?:号)?登录|验证码登录/.test(caption)&&(phoneField||loginAction)||
        /请(?:先)?登录|登录BOSS|登录\/注册/i.test(caption)&&loginAction;
    }));
  }
  function visibleChatWorkspace(){
    if(!/^\/web\/geek\/chat\/?$/.test(location.pathname))return false;
    return documents().some(doc=>{
      const has=key=>[...doc.querySelectorAll(S[key])].some(visible);
      return !has('blocked')&&has('chatRoot')&&has('peerItem')&&(has('activePeer')||has('chatHeader'));
    });
  }
  const restrictionText=/安全验证|访问异常|操作过于频繁|今日沟通人数已达上限/;
  function blockedDocument(doc){
    if(list('blocked',doc).length)return true;
    const body=doc.body;
    if(!restrictionText.test(body?.innerText?.slice(0,18000)||''))return false;
    // A recruiter, job listing, or file name can quote the same words as a
    // site notice. Look for the text outside those data-bearing regions.
    const content=new Set(['peerItem','hrMessage','selfMessage','chatHeader','jobCard','detailTitle','description','resumeRow']
      .flatMap(key=>list(key,doc)));
    for(const region of doc.querySelectorAll('.chat-position-content'))content.add(region);
    const walker=doc.createTreeWalker(body,NodeFilter.SHOW_TEXT);
    let previousRegion=null,recent='';
    for(let node=walker.nextNode();node;node=walker.nextNode()){
      const element=node.parentElement;
      let ancestor=element;
      while(ancestor&&ancestor!==body&&!content.has(ancestor))ancestor=ancestor.parentElement;
      if(ancestor!==body||element.closest('script,style,template,noscript,textarea,[contenteditable]')||!visible(element)){
        previousRegion=null;recent='';continue;
      }
      const region=element.closest('div,p,li,section,article,header,aside,button,h1,h2,h3')||body;
      const text=(region===previousRegion?recent:'')+(node.nodeValue||'');
      if(restrictionText.test(text))return true;
      previousRegion=region;recent=text.slice(-16);
    }
    return false;
  }
  function blocked(){return loginPage()||visibleSignIn()||blockedDocument(activeDocument);}
  async function ensure(){
    if(visibleSignIn()||loginPage()){
      await api('/api/heartbeat',{page:location.origin+location.pathname,accountSignal:'sign-in-ui'});
      throw Error('页面显示 BOSS 登录入口');
    }
    const r=await api('/api/check',{id:claimed.id,lease:claimed.lease});if(!r.allowed)throw Error('任务已暂停或执行凭据失效');
    if(blocked())throw Error('页面出现登录、验证或限制提示');
  }
  async function finish(success,evidence,{notStarted=false,alreadyPresent=false,outcome}={}){if(claimed){await api('/api/complete',{id:claimed.id,lease:claimed.lease,success,evidence,notStarted,alreadyPresent,...(outcome?{outcome}:{})});claimed=null;}if(worker){await chrome.runtime.sendMessage({type:'workerDone',taskId:worker.taskId});worker=null;}}
  const visibleMatches=(root,selector)=>[...root.querySelectorAll(selector)].filter(visible);
  const inlineDialogs=()=>visibleMatches(document,'.startchat-dialog');
  const inlineEditor='.startchat-content .edit-area > textarea.input-area';
  const inlineSend='.startchat-content .edit-area > .send-message';
  function inlineGreetingChat(id){
    const dialogs=inlineDialogs();
    if(!dialogs.length)return null;
    const binding=inlineGreeting;
    if(dialogs.length!==1||binding?.id!==claimed?.id||!binding?.name||safeJobURL(location.href)!==binding.url)throw Error('无法核对岗位弹窗与本次招呼的招聘方');
    const [root]=dialogs;
    const names=visibleMatches(root,'.startchat-title .boss-info > .name');
    const positions=visibleMatches(root,'.startchat-title .boss-info > .position');
    const histories=visibleMatches(root,'.startchat-content .message > .message-list');
    if(names.length!==1||positions.length!==1||histories.length!==1)throw Error('未能唯一识别岗位弹窗中的招聘方和消息区');
    const name=txt(names[0]);
    const [company,title,...extra]=txt(positions[0]).split('·').map(value=>value.trim());
    if(name!==binding.name||norm(company)!==norm(binding.company)||!title||extra.length)throw Error('岗位弹窗中的招聘方与岗位不一致');
    const rows=[...histories[0].children];
    if(rows.some(row=>!row.matches('li.message-item')))throw Error('岗位弹窗消息区结构已变化');
    const messages=rows.map(row=>({id:row.id,role:'self',text:txt(row.querySelector(':scope > .text'))}));
    return {id,root,inline:true,label:{name,company},messages,rows};
  }
  async function sendText(task,before,forcedId){
    const inline=before.inline===true,read=()=>inline?inlineGreetingChat(forcedId):chat(forcedId);
    const targetLabel=peerLabel(before.selectedPeer),targetIdentity=forcedId&&!inline?identityOf(before.selectedPeer):null;
    const same=c=>c?.id===before.id&&(inline?c.root===before.root&&c.label.name===before.label.name&&c.label.company===before.label.company:c.selectedPeer===before.selectedPeer&&c.header===before.header)&&JSON.stringify(c.messages)===JSON.stringify(before.messages);
    const controls=(key,scope=activeDocument)=>inline?visibleMatches(before.root,key==='editor'?inlineEditor:inlineSend):list(key,scope);
    const control=key=>{const items=controls(key);return items.length===1?items[0]:null;};
    await ensure();if(!same(read()))throw Error('发送前会话或消息已变化');
    const editor=control('editor'),initialButton=control('send');let button=initialButton;if(!editor||!button)throw Error('未能唯一识别聊天输入框和发送按钮');
    if((editor.value||editor.innerText||'').trim())throw Error('输入框中已有文字，留给本人处理');
    const {waitForDOM}=window.BossResumeUI,doc=editor.ownerDocument;
    const buttonAvailable=element=>element&&!element.disabled&&!element.classList.contains('disabled')&&element.getAttribute('aria-disabled')!=='true'&&(!inline||!element.classList.contains('disable'));
    const interactionEvents=['pointerdown','keydown','click','input','submit'];let humanAction='',ambiguousControls=false;
    const trackInteraction=event=>{
      if(!event.isTrusted)return;
      const editors=controls('editor',doc),buttons=controls('send',doc);
      if(editors.length!==1||editors[0]!==editor||buttons.length!==1||buttons[0]!==initialButton)ambiguousControls=true;
      const editorControls=[editor,...editors],inEditor=editorControls.some(control=>control.contains(event.target));
      const activation=event.type==='click'||event.type==='pointerdown'&&event.button===0||event.type==='keydown'&&['Enter',' '].includes(event.key);
      if((activation&&[initialButton,button,...buttons].some(control=>control?.contains(event.target)))||
          (inEditor&&event.type==='keydown'&&event.key==='Enter')||
          (event.type==='submit'&&editorControls.some(control=>event.target.contains(control))))humanAction='send';
      else if(inEditor)humanAction||='edit';
    };
    for(const event of interactionEvents)doc.addEventListener(event,trackInteraction,true);
    try{
      editor.focus();botEditor=editor;
      if(editor.matches('textarea,input')){const setter=Object.getOwnPropertyDescriptor(editor.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;setter.call(editor,task.text);}
      else editor.textContent=task.text;
      editor.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:task.text}));
      button=await waitForDOM(()=>{const current=control('send');return buttonAvailable(current)?current:null;},doc,6000,500)||control('send');
      await ensure();
      if(humanAction==='send')throw Error('人工发送可能已经开始，已停止自动发送，请核对站内结果');
      const latest=read();
      if(!same(latest))throw Error('填写期间会话发生变化');
      if(!editor.isConnected||!button?.isConnected||control('editor')!==editor||control('send')!==button)throw Error('发送前聊天输入框或发送按钮已变化，本轮未点击发送');
      if(humanAction==='edit'){
        const error=Error('人工接手聊天输入，本轮未点击发送');
        const claim=claimed?.task?.autoReplyClaim;
        if(!ambiguousControls&&button===initialButton&&claim?.peerId===latest.id&&claim.tailId===latest.messages.at(-1)?.id)error.outcome='manual_editor_takeover';
        throw error;
      }
      if(ambiguousControls)throw Error('发送期间聊天输入框或发送按钮识别不唯一，本轮未点击发送');
      if((editor.value||editor.innerText||'').trim()!==task.text||!buttonAvailable(button))throw Error('输入框未接受消息');
      if(inline)inlineGreeting.attempted=true;
      button.click();
    }finally{for(const event of interactionEvents)doc.removeEventListener(event,trackInteraction,true);}
    const oldIds=new Set(before.messages.map(m=>m.id)),boundary=before.messages.at(-1)?.id;
    const receipt=await waitForDOM(async()=>{
      let after=read();
      if(!forcedId&&(!after||after.selectedPeer!==before.selectedPeer))after=await resolveCurrent();
      if(after?.id!==before.id)return null;
      if(inline){
        if(after.root!==before.root||after.label.name!==before.label.name||after.label.company!==before.label.company||after.rows.length!==1)return null;
        const [row]=after.rows,[message]=after.messages;
        const status=row.querySelector(':scope > .status.success');
        return /^[^\s\u0000-\u001f\u007f]{1,250}$/u.test(message.id)&&visible(row)&&txt(status)==='已发送'&&receiptText(message.text)===receiptText(task.text)?message.id:null;
      }
      const afterLabel=peerLabel(after.selectedPeer);
      if(targetLabel.key?afterLabel.key!==targetLabel.key:after.header!==before.header)return null;
      if(targetIdentity?.stableId&&identityOf(after.selectedPeer)?.stableId!==targetIdentity.stableId)return null;
      const index=boundary?after.messages.findIndex(m=>m.id===boundary):-1;if(boundary&&index<0)return null;
      const selfNodes=list('selfMessage',after.root);
      const sent=after.messages.slice(index+1).filter(m=>{
        if(m.role!=='self'||!m.id||oldIds.has(m.id)||after.messages.filter(other=>other.id===m.id).length!==1)return false;
        const nodes=selfNodes.filter(node=>messageId(node)===m.id);
        return nodes.length===1&&receiptBody(nodes[0])===receiptText(task.text);
      });
      return sent.length===1?sent[0].id:null;
    },doc,10000,500);
    if(!receipt)throw Error('点击后未在同一会话发现发送结果，请人工核对');
    await finish(true,'同一会话出现新消息编号 '+receipt+' 及本次完整正文（忽略时间与送达标签）');
  }
  async function sendResume(task,before){
    return window.BossResumeUI.execute({task,before,config,getCurrent:()=>chat(),resolveCurrent,ensure,finish});
  }
  async function greeting(){
    if(!worker)return false;
    if(!claimed){
      if(!location.pathname.startsWith('/job_detail/'))return true;
      const d=detail();if(!d.title||!norm(d.title).includes(norm(worker.job.title)))throw Error('岗位详情标题与待执行任务不一致');
      const button=one('contact');if(!button)throw Error('未能唯一识别“立即沟通”按钮');
      const r=await api('/api/claim',{id:worker.taskId,url:location.href});if(r.blocked)return true;
      claimed={id:r.task.id,lease:r.lease,task:r.task};
      // Persist across same-tab navigation. No credentials are placed in page DOM or URL.
      const saved=await chrome.runtime.sendMessage({type:'saveClaim',claimed});if(!saved.ok)throw Error(saved.error);
      await ensure();
      const url=safeJobURL(location.href),job=claimed.task.job;
      if(!button.isConnected||one('contact')!==button||!url||url!==safeJobURL(job.url)||inlineDialogs().length)throw Error('打开沟通前岗位或弹窗已变化');
      const names=visibleMatches(document,'.job-boss-info h2.name');
      const name=names.length===1?[...names[0].childNodes].filter(node=>node.nodeType===Node.TEXT_NODE).map(node=>node.textContent).join('').trim():'';
      inlineGreeting=txt(button)==='立即沟通'&&button.getAttribute('data-isfriend')!=='true'&&name&&norm(detail().company)===norm(job.company)?{id:claimed.id,url,name,company:job.company,attempted:false}:null;
      if(button.matches('a'))button.target='_self';button.click();return true;
    }
    // The chat DOM exposes no stable conversation id; the greeting is bound to the job page it started from.
    const forcedId='job:'+claimed.task.job.url;
    if(inlineGreeting?.id===claimed.id&&inlineGreeting.attempted)throw Error('本次招呼已点击发送，待核对回执');
    const c=inlineDialogs().length?inlineGreetingChat(forcedId):chat(forcedId);if(!c)return true;
    const expected=worker.job.company;
    if(!expected||!c.inline&&!norm(c.header).includes(norm(expected)))throw Error('聊天标题无法确认目标公司，请人工核对');
    if(claimed.task.greetingPlanId){
      const label=c.inline?c.label:peerLabel(c.selectedPeer);
      const check=await api('/api/greetings/target',{id:claimed.id,lease:claimed.lease,name:label.name,company:label.company,messages:c.messages});
      if(check.skipped){claimed=null;await chrome.runtime.sendMessage({type:'workerDone',taskId:worker.taskId});worker=null;return true;}
    }
    if(c.inline&&c.messages.length)throw Error('岗位弹窗已有发出消息，本轮不再发送');
    if(c.messages.some(m=>m.role==='self'&&m.text===claimed.task.text)){await finish(false,'站内已有相同招呼正文，本轮未点击发送',{alreadyPresent:true});return true;}
    await sendText(claimed.task,c,forcedId);return true;
  }
  async function reply(){
    if(config.chatRead===false||!monitor||!hrRunning())return;
    await refreshReplyQueue();
    const rows=peerRows();seedWatcher(rows);
    let c;try{c=await resolveCurrent(rows);}catch(e){lastError=e.message;nextChat();return;}
    if(!c){nextChat();return;}
    if(!trackWindow(c)){nextChat();return;}
    const label=c.identity;visitedLabels.add(label.key);
    const editor=one('editor');if((editor?.value||editor?.innerText||'').trim()||Date.now()-humanEditingAt<60000)return;
    // Reconcile the visible anchor before taking a prepared draft. A new HR
    // message may have arrived while this peer was generating in the queue.
    const observedJob=chatPosition(c),observedSignature=JSON.stringify([c.id,c.messages,c.resumeUI,observedJob]);
    if(observedSignature!==lastObserved){await api('/api/observe',{peerId:c.id,header:c.header,job:observedJob,messages:c.messages,resumeUI:c.resumeUI});lastObserved=observedSignature;}
    if(one('activePeer')!==c.selectedPeer||text('chatHeader')!==c.header)return;
    const backlog=await api('/api/tasks',{peerId:c.id});let tasks=backlog.tasks;
    const signal=incomingLabels.get(label.key);
    const trigger=backlog.continuation?'resume_sent_reply':'new_hr_message';
    const signature=JSON.stringify([c.id,c.messages,c.resumeUI,trigger]);
    if(!tasks.length){
      if(config.newMessagesOnly!==false&&!signal&&!backlog.continuation){
        if(config.mode==='auto'&&!incomingLabels.size&&!replyRows.some(queueBusy)&&config.historySweepEnabled===true&&config.historyRead!==false)await readHistory(c);
        nextChat();return;
      }
      if(config.newMessagesOnly!==false&&!backlog.continuation&&signal?.kind!=='resume_request'&&!realtime.matchesPreview(label.key,c.messages)){nextChat();return;}
      if(!backlog.continuation&&c.messages.at(-1)?.role!=='hr'&&!c.resumeUI?.requestPending){nextChat();return;}
      const submitted=replySubmissions.get(label.key);
      const previous=replyRows.find(row=>row.id===submitted?.id&&row.peerId===c.id);
      if(submitted?.signature===signature&&previous&&previous.status!=='stale'){
        if(previous.status==='skip')realtime.acknowledge(label.key,{messageId:c.messages.at(-1)?.id,status:'skip'});
        nextChat();return;
      }
      // Queue insertion returns before inference. The only DOM lease remains
      // in the existing claim/send path, so another HR can be read meanwhile.
      if(one('activePeer')!==c.selectedPeer||identityOf(c.selectedPeer)?.key!==label.key||text('chatHeader')!==c.header)return;
      const r=await api('/api/replies/enqueue',{kind:'reply',trigger,peerId:c.id,label,header:c.header,job:chatPosition(c),messages:c.messages,resumeUI:c.resumeUI});
      if(!r.reply?.id)throw Error('异步回复未入队，消息仍保留待处理');
      updateReplyRow(r.reply);replySubmissions.set(label.key,{id:r.reply.id,peerId:c.id,signature,eventKey:replyEventKey(label.key)});
      if(r.reply.status==='skip')realtime.acknowledge(label.key,{messageId:c.messages.at(-1)?.id,status:'skip'});
      if(r.reply.status==='ready')tasks=(await api('/api/tasks',{peerId:c.id})).tasks;
      else {nextChat();return;}
    }
    for(const t of tasks){
      if(!['pending','approved'].includes(t.status)||t.peerId!==c.id)continue;
      const queued=replyRows.find(row=>row.taskId===t.id);
      if(queued&&(queued.peerId!==c.id||!sameReplyLabel(queued,label)||queued.status!=='ready'))continue;
      const matchesSignal=signal?.kind==='resume_request'
        ?c.resumeUI?.requestPending&&c.resumeUI.requestMessageId===signal.requestMessageId
        :signal&&realtime.matchesPreview(label.key,c.messages);
      if(queued&&matchesSignal)replySubmissions.set(label.key,{id:queued.id,peerId:c.id,signature,eventKey:replyEventKey(label.key)});
      if(!replyInputAllowed()||queued?.sendEligible===false)continue;
      if(queued?.sendEligible===undefined&&(legacyBlockedReplies.has(t.id)||config.mode==='review'&&t.status!=='approved'))continue;
      if(one('activePeer')!==c.selectedPeer||identityOf(c.selectedPeer)?.key!==label.key||text('chatHeader')!==c.header)return;
      const latest=chat();if(!latest||latest.id!==c.id||JSON.stringify(latest.messages)!==JSON.stringify(c.messages))return;
      const lease=await api('/api/claim',{id:t.id,peerId:c.id,fingerprint:t.fingerprint});
      if(lease.blocked){if(queued?.sendEligible===undefined)legacyBlockedReplies.set(t.id,Date.now()+10000);continue;}
      claimed={id:t.id,lease:lease.lease,task:lease.task};
      if(t.action==='send_resume')await sendResume(t,c);else await sendText(t,c);
      realtime.acknowledge(label.key,{messageId:c.messages.at(-1)?.id,status:'sent'});return;
    }
    nextChat();
  }
  let testWaitingId='',testWaitingAt=0;
  let ownerWaitingId='',ownerWaitingAt=0;
  async function ownerChat(){
    const plan=config.ownerChat;if(!plan)return false;if(!isChatPage())return true;
    if(ownerWaitingId!==plan.targetId){ownerWaitingId=plan.targetId;ownerWaitingAt=Date.now();}
    const editor=one('editor');if((editor?.value||editor?.innerText||'').trim()||Date.now()-humanEditingAt<60000){ownerWaitingAt=Date.now();return true;}
    if(Date.now()-ownerWaitingAt>180000){await api('/api/owner-chat/fail',{...plan,reason:'未能稳定完成目标读取，请查看页面与会话状态'});return true;}
    const matches=list('peerItem').filter(p=>!list('peerItem',p).length).filter(p=>{const label=peerLabel(p);return label.name===plan.name&&norm(label.company)===norm(plan.company);});
    if(matches.length!==1){await api('/api/owner-chat/fail',{...plan,reason:'当前已加载列表不能唯一找到目标HR，未发送'});return true;}
    if(matches[0]!==one('activePeer')){matches[0].click();return true;}
    let c=await resolveCurrent();if(!c||c.messages.length===0)return true;await readHistory(c);c=chat();if(!c||c.selectedPeer!==matches[0])return true;
    if(!await readChatPosition(c)||(plan.kind!=='read'&&jobViews().length))return true;c=chat();if(!c||c.selectedPeer!==matches[0])return true;
    const label=peerLabel(c.selectedPeer);await reportInspection();const result=await api('/api/owner-chat/prepare',{...plan,...label,uniquePeer:true,peerId:c.id,header:c.header,messages:c.messages,resumeUI:c.resumeUI,job:chatPosition(c)});
    if(!result.task||!['pending','approved'].includes(result.task.status))return true;
    const latest=chat();if(!latest||latest.id!==c.id||latest.selectedPeer!==c.selectedPeer||JSON.stringify(latest.messages)!==JSON.stringify(c.messages))return true;
    if(config.chatInput===false)return true;
    const t=result.task,lease=await api('/api/claim',{id:t.id,peerId:c.id,fingerprint:t.fingerprint});
    if(lease.blocked){lastError=lease.blocked;ownerWaitingAt=Date.now();return true;}
    claimed={id:t.id,lease:lease.lease,task:lease.task};if(t.action==='send_resume')await sendResume(t,c);else await sendText(t,c);lastError='';return true;
  }
  async function singleTest(){
    const plan=config.singleTest;if(!plan||!['selecting','ready','executing'].includes(plan.status))return false;
    if(plan.status==='executing'||!isChatPage())return true;
    if(testWaitingId!==plan.id){testWaitingId=plan.id;testWaitingAt=Date.now();}
    if(Date.now()-testWaitingAt>45000)throw Error('单条测试未能稳定打开目标会话，已停止');
    if(blocked())throw Error('页面出现登录、验证或访问限制');
    const peers=list('peerItem').filter(p=>!list('peerItem',p).length);
    const matches=peers.filter(p=>{
      const name=txt(p.querySelector('.name-text'));
      const company=[...p.querySelectorAll('.title-box span')].find(e=>!e.matches('.name-box,.name-text')&&!e.querySelector('span')&&txt(e)&&txt(e)!==name);
      return name===plan.target.name&&norm(txt(company))===norm(plan.target.company);
    });
    if(matches.length!==1)throw Error('不能唯一找到小鲸选定的HR');
    const target=matches[0],active=one('activePeer');
    const editor=one('editor');if((editor?.value||editor?.innerText||'').trim())throw Error('聊天输入框已有文字，已停止单条测试');
    if(target!==active){target.click();return true;}
    const c=chat('boss-test:'+plan.id.replaceAll('-',''));
    if(!c||!c.header.includes(plan.target.name)||!norm(c.header).includes(norm(plan.target.company)))return true;
    const title=txt(activeDocument.querySelector('.chat-position-content .position-name')),city=txt(activeDocument.querySelector('.chat-position-content .city'));
    await reportInspection(true);
    const prepared=await api('/api/single-test/prepare',{planId:plan.id,...plan.target,uniquePeer:true,header:c.header,job:{title,city},messages:c.messages});
    if(prepared.blocked)return true;
    const task=prepared.task;
    const lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint});
    if(lease.blocked){if(!/执行中|任务不可执行/.test(lease.blocked))throw Error(lease.blocked);return true;}
    claimed={id:task.id,lease:lease.lease,task:lease.task};await sendText(task,c,c.id);return true;
  }
  async function tick(){
    if(working)return;working=true;
    try {
      const signIn=visibleSignIn()||loginPage();
      const accountSignal=signIn?'sign-in-ui':visibleChatWorkspace()?'chat-workspace':undefined;
      const page=location.origin+location.pathname;
      const diagnostics={cards:0,peerId:'',hrMessages:0,editor:0,error:lastError};
      // The configuration heartbeat also proves which page adapter sent it.
      if(!signIn)diagnostics.adapter='0.13.3';
      // Refresh config before evaluating selectors.
      const h=await api('/api/heartbeat',{page,accountSignal,diagnostics}).catch(error=>{lastJobObservation=undefined;throw error;});config=h.config;const search=h.search;
      if(signIn||h.accountRecheck?.required){lastJobObservation=undefined;monitor=false;claimed=null;worker=null;return;}
      worker=(await chrome.runtime.sendMessage({type:'worker'})).result;
      if(worker&&!claimed)claimed=worker.claimed||null;
      selectDocument();attachMessageWatcher();
      diagnostics.cards=list('jobCard').length;diagnostics.peerId=peerId();diagnostics.hrMessages=list('hrMessage').length;diagnostics.editor=list('editor').length;
      Object.assign(diagnostics,calibrationDiagnostics());
      const current=diagnostics.peerId?chat(diagnostics.peerId):null;diagnostics.stableMessageIds=!!current?.messages.length&&current.messages.every(m=>m.id);diagnostics.sendingEnabled=config.browserCalibrated;
      const checked=await api('/api/heartbeat',{page,accountSignal,diagnostics}).catch(error=>{lastJobObservation=undefined;throw error;});config=checked.config||config;
      if(checked.accountRecheck?.required){lastJobObservation=undefined;monitor=false;claimed=null;worker=null;return;}
      if(!isChatPage()||!hrRunning()||config.chatRead===false)monitor=false;
      if(!jobRunning()||config.crawlEnabled===false)lastJobObservation=undefined;
      if(!jobRunning()&&!hrRunning()&&!manualWork())return;
      await realtime.ready;
      if(isChatPage()&&hrRunning()&&config.chatRead!==false){
        const selection=await chrome.runtime.sendMessage({type:'chatMonitor'});
        const selected=(selection?.result||selection)?.monitor===true;
        // A tab may have loaded before the previous monitor saved its cursor.
        if(selected&&!monitor){monitor=await realtime.refresh();if(!monitor)lastError=realtime.error;}
        else if(!selected)monitor=false;
      }
      if(monitor&&hrRunning()&&(config.ownerChat||config.singleTest||worker))seedWatcher();
      if(blocked()){await api('/api/stop',{reason:'检测到登录、验证或访问限制，请本人处理后恢复'});return;}
      if(await chatPositionWorker())return;
      if(await ownerChat())return;
      if(await singleTest())return;
      if(worker&&greetingEnabled()){await greeting();return;}
      if((jobRunning()||config.ownerGreeting?.automatic===false&&location.pathname.startsWith('/job_detail/'))&&await crawlDetail())return;
      if(isChatPage()){if(!monitor||!hrRunning())return;await reply();if(config.chatRead!==false)await reportInspection();return;}
      if(jobRunning()&&config.crawlEnabled!==false){
        const favorites=config.favoritesFirst!==false?await scanFavorites():null;
        const actual=new URL(location.href),requested=search&&new URL(search.url);
        const matchesSearch=requested&&actual.searchParams.get('query')===requested.searchParams.get('query')&&actual.searchParams.get('city')===requested.searchParams.get('city');
        const jobs=favorites?.confirmedList?[]:await scanJobs(matchesSearch?search.id:undefined);
        const empty=/暂无(?:相关)?职位|没有找到相关职位/.test(activeDocument.body?.innerText||'');
        if(matchesSearch&&(jobs.length||empty||Date.now()-search.at>60000))await api('/api/search/observed',{id:search.id,url:location.href,cards:jobs.length,empty});
        await reportInspection();
      }
      // Observe loaded cards. Autonomous search navigation is handled once per persisted search request.
    } catch(e) {
      lastError=e.message;
      if(claimed){await finish(false,e.message,{notStarted:e.resumeTransmissionStarted===false,outcome:e.outcome}).catch(()=>{});}
      else if(config?.ownerChat){await api('/api/owner-chat/fail',{...config.ownerChat,reason:e.message}).catch(()=>{});}
      else if(config?.singleTest&&['selecting','ready'].includes(config.singleTest.status)){await api('/api/single-test/fail',{planId:config.singleTest.id,reason:e.message}).catch(()=>{});}
      else if(worker){await api('/api/worker/fail',{taskId:worker.taskId,reason:e.message}).catch(()=>{});await chrome.runtime.sendMessage({type:'workerDone',taskId:worker.taskId}).catch(()=>{});worker=null;}
      console.warn('[BOSS 助手]',e.message);
    } finally {working=false;}
  }
  function monitorDestination(){
    const page=location.origin+location.pathname;
    const clear=!!document.body&&document.readyState!=='loading'&&!loginPage()&&!visibleSignIn()&&!documents().some(blockedDocument);
    return {page,clear};
  }
  chrome.runtime.onMessage?.addListener((m,sender,respond)=>{
    if(sender.id!==chrome.runtime.id||m.type!=='assistant-read')return false;
    (async()=>{if(m.command==='tick'){await tick();return {ok:true};}if(m.command==='monitor-destination')return monitorDestination();if(m.command==='favorites-scan'){config=(await api('/api/browser-state')).config;if(!jobRunning())return {paused:true};selectDocument();return scanFavorites({allowNavigate:m.allowNavigate===true});}if(!config?.running&&!config?.readingEnabled)return {paused:true};selectDocument();if(m.command==='scan-jobs'){if(!jobRunning())return {paused:true};return {jobs:(await scanJobs()).length};}if(m.command==='inspect'){await reportInspection(true);return {ok:true};}throw Error('未知读取任务');})().then(r=>respond(r)).catch(e=>respond({error:e.message}));return true;
  });
  // Keep observing while Harness is generating, so a newer HR message cancels its old draft.
  let observing=false,lastObserved='';
  async function observeCurrent(){
    if(!monitor||!hrRunning()||observing||historyReading||jobReading||config.chatRead===false||!isChatPage()||visibleSignIn()||['selecting','ready','executing'].includes(config.singleTest?.status))return;
    observing=true;
    try{await realtime.ready;if(!monitor||!hrRunning())return;const rows=peerRows();seedWatcher(rows);const c=await resolveCurrent(rows);if(!monitor||!hrRunning()||!c||!trackWindow(c))return;const job=chatPosition(c),signature=JSON.stringify([c.id,c.messages,c.resumeUI,job]);if(signature===lastObserved)return;
      await api('/api/observe',{peerId:c.id,header:c.header,job,messages:c.messages,resumeUI:c.resumeUI});lastObserved=signature;
    }catch(e){lastError=e.message;}finally{observing=false;}
  }
  const incomingWake=window.BossRealtime.createWakeScheduler(async()=>{if(!hrRunning())return;await observeCurrent();if(incomingLabels.size)void tick();},{delayMs:350});
  const watchedDocuments=new WeakSet();
  function attachMessageWatcher(){
    if(!activeDocument.body||watchedDocuments.has(activeDocument))return;watchedDocuments.add(activeDocument);
    for(const event of ['pointerdown','keydown'])activeDocument.addEventListener(event,e=>{if(e.isTrusted&&e.target?.closest?.('input,textarea,[contenteditable="true"]')){humanEditingAt=Date.now();botEditor=null;}},true);
    for(const event of ['pointerdown','keydown'])activeDocument.addEventListener(event,e=>{if(e.isTrusted)humanPageAt=Date.now();},true);
    new MutationObserver(()=>{if(!hrRunning()||!isChatPage()||historyReading)return;incomingWake.wake();}).observe(activeDocument.body,{childList:true,subtree:true,characterData:true});
  }
  setInterval(observeCurrent,1500);
  setInterval(tick,6000);setTimeout(tick,1800);
  let checkingReplyStatus=false;
  const canCheckReplyStatus=()=>monitor&&hrRunning()&&config.chatRead!==false&&isChatPage()&&!working;
  async function checkActiveReplyStatus(){
    if(checkingReplyStatus||!canCheckReplyStatus()||!replyRows.some(replyGenerating))return;
    const previous=replyRows,previousConfig=config;
    const current=()=>canCheckReplyStatus()&&replyRows===previous&&config===previousConfig;
    checkingReplyStatus=true;
    try{
      const selection=await chrome.runtime.sendMessage({type:'chatMonitor'});
      if(!current())return;
      if((selection?.result||selection)?.monitor!==true){monitor=false;return;}
      const rows=await readReplyQueue();
      if(!current())return;
      replyRows=rows;
      const pending=new Set(previous.filter(replyGenerating).map(row=>row.id));
      if(rows.some(row=>pending.has(row.id)&&(row.status==='ready'||row.status==='skip')))void tick();
    }catch(error){lastError=error.message;}finally{checkingReplyStatus=false;}
  }
  // Status polling does not scan the page or perform a send. A fresh business
  // tick still rechecks the channel, conversation and lease before any action.
  setInterval(()=>void checkActiveReplyStatus(),250);
  setInterval(()=>{if(monitor&&hrRunning()&&replyRows.some(row=>row.status==='ready'))void tick();},1000);
})();
