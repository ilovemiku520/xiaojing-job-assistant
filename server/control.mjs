import {mkdirSync,readFileSync,writeFileSync,renameSync,appendFileSync,openSync,readSync,closeSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';

export const clean=v=>String(v??'').replace(/PLAYWRIGHT_MCP_EXTENSION_TOKEN\s*=\s*[^\s"']+|sk-[\w-]{12,}|Bearer\s+[\w.\/-]{16,}|\b[a-f0-9]{64}\b/gi,'[凭据已隐藏]');
const active=new Set(['running','queued','reading','generating','ready','pending','approved','executing']);
const attention=new Set(['pending','uncertain','hold','error','failed','interrupted','finished_with_issues','timed_out']);
const operationKinds=new Set(['owner','plan','greeting','message']);
const boardPageSize=30;
export function operationRows(state,{includeTargets=true,summary=false,kind}={}){
 const rows=[];
 const source=(type,items)=>!kind||kind===type?items||[]:[];
 for(const t of source('owner',state.ownerTasks))rows.push({id:t.id,kind:'owner',title:summary?'主人任务':clean(t.prompt).slice(0,180),status:t.status,at:t.at,updatedAt:t.finishedAt||t.at,done:['done','error','interrupted','timed_out','cancelled'].includes(t.status)?1:0,total:1,reason:summary?'':t.cancelRequestedAt&&t.status==='running'?'正在停止此主人任务':t.status==='running'?'正在处理本轮；对话和进度持续保存':t.status==='queued'?'补充已排队，将在同一任务继续':t.status==='done'?'小鲸已返回报告；实际投递和发送以关联委托及回显证据为准。':clean(t.result).slice(0,240),canCancel:['running','queued'].includes(t.status)&&!t.cancelRequestedAt,parentId:t.conversationId||''});
 for(const p of source('plan',state.ownerChats)){
   const done=p.targets.filter(t=>!active.has(t.status)).length;
   const row={id:p.id,kind:'plan',title:summary?'会话委托':(p.kind==='read'?'读取岗位与历史':'主动跟进')+' · '+p.targets.map(t=>t.company+' '+t.name).join('、'),status:p.status,at:p.createdAt,updatedAt:p.finishedAt||Math.max(p.createdAt,...p.targets.map(t=>t.finishedAt||t.readAt||0)),done,total:p.targets.length,reason:summary?'':p.targets.find(t=>t.waitingReason)?.waitingReason||p.targets.find(t=>t.reason)?.reason||'',canCancel:p.status==='queued',parentId:p.ownerTaskId||''};
   if(includeTargets&&!summary)row.targets=p.targets.map(t=>({id:t.id,name:t.name,company:t.company,status:t.status,reason:clean(t.waitingReason||t.reason||t.evidence||''),taskId:t.taskId||''}));
   rows.push(row);
 }
 for(const p of source('greeting',state.greetingPlans)){
   const row={id:p.id,kind:'greeting',title:'向 '+p.requested+' 位新HR打招呼',status:p.status,at:p.createdAt,updatedAt:p.finishedAt||p.createdAt,done:p.sent||0,total:p.requested,reason:summary?'':p.waitingReason||'',canCancel:p.status==='queued',parentId:p.ownerTaskId||''};
   if(includeTargets&&!summary)row.targets=p.targets.map(t=>({id:t.id,name:t.title,company:t.company,status:t.status,reason:clean(t.reason||''),taskId:t.taskId||''}));
   rows.push(row);
 }
 for(const t of source('message',state.tasks))rows.push({id:t.id,kind:'message',title:[t.job?.company,t.job?.title,t.kind==='greeting'?'打招呼':t.kind==='followup'?'主动追问':'回复HR'].filter(Boolean).join(' · '),status:t.status,at:t.at||t.createdAt||t.updatedAt||0,updatedAt:t.updatedAt||t.at||t.createdAt||0,done:active.has(t.status)?0:1,total:1,reason:summary?'':clean(t.evidence||t.reason).slice(0,300),canCancel:['pending','approved','hold'].includes(t.status),parentId:t.ownerChatPlanId||t.greetingPlanId||''});
 return rows.map(r=>({...r,title:clean(r.title),reason:clean(r.reason),active:active.has(r.status)})).sort((a,b)=>Number(b.active)-Number(a.active)||b.updatedAt-a.updatedAt);
}

export function operationBoard(state,{filter,q='',page}={}){
 const rows=operationRows(state,{includeTargets:false});
 const query=q.trim().toLowerCase();
 let activeCount=0;
 const matched=rows.filter(row=>{
   if(row.active)activeCount++;
   if(filter==='active'&&!row.active||filter==='attention'&&!attention.has(row.status))return false;
   return !query||`${row.title} ${row.reason}`.toLowerCase().includes(query);
 });
 const pages=Math.max(1,Math.ceil(matched.length/boardPageSize));
 const current=Math.min(pages,Math.max(1,Math.trunc(Number(page)||1)));
 const start=(current-1)*boardPageSize;
 return {items:matched.slice(start,start+boardPageSize),total:rows.length,active:activeCount,matched:matched.length,page:current,pages};
}

export function operationSummary(state,{kind,limit}={}){
 if(kind!=null&&!operationKinds.has(kind))throw Error('任务类型无效');
 const requested=Number(limit==null||limit===''?20:limit);
 const size=Number.isFinite(requested)?Math.min(50,Math.max(1,Math.trunc(requested))):20;
 const rows=operationRows(state,{summary:true,kind});
 const items=rows.slice(0,size).map(row=>({
   id:clean(row.id).slice(0,160),kind:row.kind,status:clean(row.status).slice(0,40),title:row.title.slice(0,180),
   updatedAt:Number(row.updatedAt)||null,done:Number(row.done)||0,total:Number(row.total)||0,active:row.active,
 }));
 return {version:1,total:rows.length,items};
}

const maxEvents=200,maxScopes=32;
function scanJournal(file,visit){
 let fd;
 try{fd=openSync(file,'r');}catch(error){if(error.code==='ENOENT')return;throw error;}
 const decoder=new StringDecoder('utf8'),buffer=Buffer.allocUnsafe(64*1024);
 let remaining='';
 function line(text){
   if(!text)return;
   let event;try{event=JSON.parse(text);}catch{return;}
   if(event&&typeof event==='object'&&!Array.isArray(event)&&['number','string'].includes(typeof event.sequence)&&Number.isFinite(Number(event.sequence)))visit(event);
 }
 try{
   let bytes;
   while((bytes=readSync(fd,buffer,0,buffer.length,null))>0){
     const lines=(remaining+decoder.write(buffer.subarray(0,bytes))).split('\n');
     remaining=lines.pop();
     for(const text of lines)line(text);
   }
   line(remaining+decoder.end());
 }finally{closeSync(fd);}
}

function journalMetadata(file){
 try{return statSync(file,{bigint:true});}catch(error){if(error.code==='ENOENT')return null;throw error;}
}
const sameFile=(a,b)=>a?.dev===b?.dev&&a?.ino===b?.ino;
const sameSnapshot=(a,b)=>sameFile(a,b)&&a?.size===b?.size&&a?.mtimeNs===b?.mtimeNs&&a?.ctimeNs===b?.ctimeNs;
const scopeMatches=(scope,event)=>(!scope.kind||event.kind===scope.kind)&&(!scope.id||event.id===scope.id);
function keepRecent(scope,event){
 if(scope.rows.length===maxEvents)scope.droppedThrough=Math.max(scope.droppedThrough,Number(scope.rows.shift().sequence));
 scope.rows.push(event);
}
function lineSeparator(file,metadata){
 if(!metadata?.size)return '';
 let fd;
 try{fd=openSync(file,'r');}catch(error){if(error.code==='ENOENT')return '';throw error;}
 const byte=Buffer.alloc(1);
 try{return readSync(fd,byte,0,1,Number(metadata.size-1n))===1&&byte[0]!==10?'\n':'';}
 finally{closeSync(fd);}
}

export function createControlStore(directory){
 mkdirSync(directory,{recursive:true});const index=join(directory,'index.json'),journal=join(directory,'events.jsonl');
 let previous={},sequence=0;try{const saved=JSON.parse(readFileSync(index,'utf8'));previous=saved.rows||{};sequence=Number.isSafeInteger(saved.sequence)&&saved.sequence>=0?saved.sequence:0;}catch{}
 scanJournal(journal,event=>{sequence=Math.max(sequence,Number(event.sequence));});
 const scopes=new Map();let snapshot=journalMetadata(journal);
 function checkJournal(){
   const current=journalMetadata(journal);
   if(!sameSnapshot(snapshot,current))scopes.clear();
   snapshot=current;return current;
 }
 const save=()=>{writeFileSync(index+'.tmp',JSON.stringify({version:1,sequence,rows:previous}),{mode:0o600});renameSync(index+'.tmp',index);};
 function reconcile(state){let start,bytesWritten=0;for(const row of operationRows(state)){
   const key=row.kind+':'+row.id,value={...row};delete value.active;
   const fingerprint=createHash('sha256').update(JSON.stringify(value)).digest('hex');if(previous[key]?.fingerprint===fingerprint)continue;
   let separator='';if(!bytesWritten){start=checkJournal();separator=lineSeparator(journal,start);}
   const event={sequence:sequence+1,at:Date.now(),kind:row.kind,id:row.id,type:previous[key]?'updated':'observed',previousStatus:previous[key]?.status||'',status:row.status,title:row.title,done:row.done,total:row.total,reason:row.reason};
   const line=separator+JSON.stringify(event)+'\n';
   appendFileSync(journal,line,{mode:0o600});bytesWritten+=Buffer.byteLength(line);sequence=event.sequence;
   for(const scope of scopes.values())if(scopeMatches(scope,event))keepRecent(scope,event);
   previous[key]={fingerprint,status:row.status};
 }if(bytesWritten){
   const end=journalMetadata(journal);
   if(end?.size!==(start?.size??0n)+BigInt(bytesWritten)||start&&!sameFile(start,end))scopes.clear();
   snapshot=end;save();
 }}
 function events({kind,id,after=0,limit=60}={}){
   const start=checkJournal();
   if(!start||kind&&typeof kind!=='string'||id&&typeof id!=='string')return {events:[],cursor:sequence};
   const size=Math.trunc(Math.min(maxEvents,Math.max(1,Number(limit)||60))),boundary=Number(after);
   const key=JSON.stringify([kind||null,id||null]);
   const cached=scopes.get(key);
   let scope=cached;
   if(cached)scopes.delete(key);
   else{
     scope={kind,id,rows:[],droppedThrough:-Infinity};
     scanJournal(journal,event=>{if(scopeMatches(scope,event))keepRecent(scope,event);});
   }
   if(key.length<=1024&&(cached||sameSnapshot(start,checkJournal()))){
     scopes.set(key,scope);
     if(scopes.size>maxScopes)scopes.delete(scopes.keys().next().value);
   }
   let rows=scope.rows.filter(event=>event.sequence>boundary).slice(-size);
   // Normal journals increase by sequence. An externally edited file can put
   // older physical lines above the cursor while newer lines fall below it.
   if(rows.length<size&&scope.droppedThrough>boundary){
     rows=[];
     scanJournal(journal,event=>{
       if(!scopeMatches(scope,event)||!(event.sequence>boundary))return;
       if(rows.length===size)rows.shift();
       rows.push(event);
     });
   }
   return {events:structuredClone(rows),cursor:sequence};
 }
 return {reconcile,events};
}

export function cancelPlan(state,plan,reason='主人停止了此任务'){
 if(!plan||plan.status!=='queued')throw Error('此委托已结束');
 const linked=state.tasks.filter(t=>t.ownerChatPlanId===plan.id);
 if(linked.some(t=>t.status==='executing')||plan.targets.some(t=>t.status==='executing'))throw Error('此任务正在站内发送，请先等待发送结果');
 const peers=[];for(const target of plan.targets)if(active.has(target.status)){target.status='cancelled';target.reason=reason;if(target.peerId)peers.push(target.peerId);}
 for(const t of linked)if(['pending','approved','hold'].includes(t.status)){t.status='stale';t.reason=reason;}
 plan.status='finished_with_issues';plan.finishedAt=Date.now();return peers;
}
