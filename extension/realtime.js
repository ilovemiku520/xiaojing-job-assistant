/* Incremental, persistent HR inbox cursors. Page text is data, never authority. */
(()=>{
 const norm=value=>String(value??'').replace(/\s+/g,'').toLowerCase();
 const systemNotice=value=>{
  const text=norm(value);
  if(/^(?:boss安全提示|系统消息|系统提示|请文明沟通|谨防诈骗)/i.test(text))return true;
  // These are BOSS ranking/PK widgets, not ordinary HR questions about competitors.
  if(/[?？]/.test(text)||/^(?:请问|能否|能不能|怎么|如何|你觉得|你认为|请你)/.test(text))return false;
  return /^(?:竞争者pk情况|(?:与|和)竞争者的?pk情况)/.test(text)||/^[你您]的?.{0,60}(?:超过|领先|击败|排名|优于).{0,40}竞争者/.test(text)&&/查看详细分析|优秀竞争者|\d+(?:%|％|位|名)/.test(text);
 };
 const short=value=>String(value??'').slice(0,500);
 function create({storage,now=Date.now,key='boss-realtime-v1',bootstrapUnread=true}={}){
  const threads=new Map(),events=new Map();let epoch='',hydrating=true,saveQueued=false,loadingError='',pendingSave=Promise.resolve();
  function trim(){
   if(threads.size<=400)return;
   const oldest=[...threads].sort((a,b)=>Number(events.has(a[0]))-Number(events.has(b[0]))||(a[1].seenAt||0)-(b[1].seenAt||0));
   for(const [id] of oldest.slice(0,threads.size-400)){threads.delete(id);events.delete(id);}
  }
  function snapshot(){trim();return {version:1,savedAt:now(),threads:[...threads].map(([id,t])=>[id,{...t,handled:(t.handled||[]).slice(-30),resumeHandled:(t.resumeHandled||[]).slice(-20)}]),events:[...events].slice(-400)};}
  function save(){if(hydrating||saveQueued||!storage?.set)return;saveQueued=true;pendingSave=pendingSave.then(async()=>{saveQueued=false;try{await storage.set({[key]:snapshot()});loadingError='';}catch(e){loadingError=String(e?.message||e).slice(0,200);}});}
  function queue(id,event){
   const old=events.get(id);
   if(old&&Object.entries(event).every(([field,value])=>old[field]===value))return false;
   const next={...old,...event,at:old?.at||now(),updatedAt:now()};
   if(old&&old.kind==='resume_request'&&event.kind!=='resume_request')Object.assign(next,{kind:old.kind,requestMessageId:old.requestMessageId});
   events.set(id,next);save();return !old;
  }
  async function load(){
   hydrating=true;
   try{
    await pendingSave;
    const raw=storage?.get?(await storage.get(key))?.[key]:null;
    threads.clear();events.clear();
    if(raw?.version===1){
     for(const entry of Array.isArray(raw.threads)?raw.threads:[])if(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[1]&&typeof entry[1]==='object'){
      // Old snapshots retained the entire loaded ID window. Incremental
      // observation uses the last message anchor and confirmed actions.
      const thread={...entry[1]};delete thread.ids;threads.set(entry[0],thread);
     }
     for(const entry of Array.isArray(raw.events)?raw.events:[])if(Array.isArray(entry)&&entry.length===2&&typeof entry[0]==='string'&&entry[1]&&typeof entry[1]==='object')events.set(entry[0],entry[1]);
    }
    loadingError='';return true;
   }catch(e){loadingError=String(e?.message||e).slice(0,200);return false;}finally{hydrating=false;}
  }
  const ready=load();
  async function refresh(){await ready;return load();}
  function reset(nextEpoch){epoch=String(nextEpoch??'');/* A run/reload changes observation epoch, not the durable inbox cursor. */return events;}
  const ambiguous=id=>threads.get(id)?.ambiguous===true;
  function migrateLabel(item,id,current){
   const alias=short(item.legacyKey);if(!alias||alias===id)return false;
   const old=threads.get(alias),event=events.get(alias),bound=old?.peerId===id;
   const unique=item.uniqueLabel===true&&!ambiguous(alias);
   let changed=false;
   if(bound&&!threads.has(id)){
    const {sidebar,ambiguous:legacyAmbiguous,...window}=old;
    threads.set(id,{...window,...(unique&&sidebar?{sidebar}:{})});changed=true;
   }
   if(!event)return changed;
   // Old sidebar events carried no trustworthy row ID. Require its exact
   // preview and timestamp on a single label before moving it to a row.
   const exactEvent=event.peerId===id&&(event.source==='message'&&event.messageId||event.source==='resume_request'&&event.requestMessageId);
   const exactPreview=unique&&(!old?.peerId||bound)&&event.source==='sidebar'&&event.time&&event.time===current.time&&current.preview&&norm(event.preview)===norm(current.preview);
   if(!exactEvent&&!exactPreview)return changed;
   if(!events.has(id))events.set(id,{...event,peerId:id});
   events.delete(alias);return true;
  }
  function observeSidebar(items){
   let added=0,touched=false;
   for(const item of (Array.isArray(items)?items:[]).slice(0,400)){
    const alias=short(item.legacyKey);
    if(alias&&item.duplicateLabel===true&&!ambiguous(alias)){threads.set(alias,{...threads.get(alias),ambiguous:true,seenAt:now()});touched=true;}
    const id=short(item.key);if(!id||ambiguous(id))continue;
    const current={preview:short(item.preview),time:short(item.time),unread:Math.max(0,Number(item.unread)||0),outgoing:item.outgoing===true};
    if(migrateLabel(item,id,current))touched=true;
    const t=threads.get(id)||{handled:[],resumeHandled:[]},old=t.sidebar;
    if(old&&Object.keys(current).every(field=>old[field]===current[field]))continue;
    touched=true;
    const freshUnread=current.unread>0&&/^\d{1,2}:\d{2}$/.test(current.time);
    const changed=old&&(norm(old.preview)!==norm(current.preview)||current.unread>old.unread||current.time!==old.time&&freshUnread);
    if(current.preview&&!systemNotice(current.preview)&&(!current.outgoing||current.unread>0)&&(changed||!old&&bootstrapUnread&&freshUnread))added+=Number(queue(id,{kind:'message',source:'sidebar',preview:current.preview,time:current.time}));
    // Reading a row clears the badge; that does not consume an unresolved event.
    t.sidebar=current;t.seenAt=now();threads.set(id,t);
   }
   if(touched)save();return {added,pending:events.size};
  }
  function observeWindow({key:id,peerId='',messages=[],resumeUI}={}){
   id=short(id);if(!id)return {added:0,pending:events.size};const t=threads.get(id)||{handled:[],resumeHandled:[]},oldTail=t.tailId;
   const list=messages.filter(m=>m&&m.id).slice(-80),tail=list.at(-1),boundary=oldTail?list.findIndex(m=>m.id===oldTail):-1;let added=0,touched=!threads.has(id);
   if(tail?.role==='self'&&events.get(id)?.kind!=='resume_request')touched=events.delete(id)||touched;
   if(tail&&systemNotice(tail.text)&&events.get(id)?.kind!=='resume_request')touched=events.delete(id)||touched;
   const incoming=boundary>=0?list.slice(boundary+1).filter(m=>m.role==='hr'&&!systemNotice(m.text)):[];
   const newest=incoming.at(-1);
   if(newest&&tail?.role==='hr'&&!(t.handled||[]).includes(String(tail.id)))added+=Number(queue(id,{kind:'message',source:'message',messageId:String(tail.id),preview:short(tail.text),peerId}));
   // Resume request cards are actionable even after an acknowledgement/self tail.
   const requestId=String(resumeUI?.requestMessageId||'');
   if(resumeUI?.requestPending&&resumeUI.agreeEnabled&&!resumeUI.receipts?.length&&requestId&&!(t.resumeHandled||[]).includes(requestId))added+=Number(queue(id,{kind:'resume_request',source:'resume_request',requestMessageId:requestId,peerId}));
   if(tail){const tailId=String(tail.id);touched=touched||t.tailId!==tailId||t.tailRole!==tail.role;t.tailId=tailId;t.tailRole=tail.role;}
   if(peerId&&t.peerId!==peerId){t.peerId=peerId;touched=true;}
   if(touched){t.seenAt=now();threads.set(id,t);save();}return {added,pending:events.size};
  }
  function acknowledge(id,{messageId,status='sent'}={}){
   if(!['sent','skip','handled','hold'].includes(status))return false;
   // A busy backend or owner decision must leave the original event available.
   if(status==='hold')return events.has(id);
   const event=events.get(id),t=threads.get(id)||{handled:[],resumeHandled:[]},mid=String(messageId||event?.messageId||t.tailId||'');
   if(mid)t.handled=[...new Set([...(t.handled||[]),mid])].slice(-30);
   if(event?.requestMessageId)t.resumeHandled=[...new Set([...(t.resumeHandled||[]),event.requestMessageId])].slice(-20);
   threads.set(id,t);events.delete(id);save();return true;
  }
  function matchesPreview(id,messages){const event=events.get(id);if(!event)return false;if(event.kind==='resume_request')return true;const tail=messages?.at(-1);if(!tail||tail.role!=='hr'||systemNotice(tail.text))return false;if(event.source==='message'&&event.messageId)return String(tail.id)===event.messageId;const preview=norm(event.preview).replace(/[.…]+$/,'');return !preview||norm(tail.text).includes(preview);}
  return {ready,refresh,events,reset,observeSidebar,observeWindow,acknowledge,matchesPreview,ambiguous,snapshot,isSystemNotice:systemNotice,get epoch(){return epoch;},get error(){return loadingError;}};
 }
 function createWakeScheduler(callback,{delayMs=350,setTimer=setTimeout,clearTimer=clearTimeout,onError=()=>{}}={}){
  let timer=null,running=false,again=false,disposed=false;
  function wake(){if(disposed)return;if(running){again=true;return;}if(timer!==null)return;timer=setTimer(async()=>{timer=null;if(disposed)return;running=true;again=false;try{await callback();}catch(error){onError(error);}finally{running=false;if(again)wake();}},Math.max(0,Number(delayMs)||0));}
  return {wake,dispose(){disposed=true;if(timer!==null)clearTimer(timer);timer=null;},get pending(){return timer!==null||running;}};
 }
 globalThis.BossRealtime={create,createWakeScheduler,isSystemNotice:systemNotice};
})();
