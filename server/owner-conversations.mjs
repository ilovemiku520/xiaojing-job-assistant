import {createHash,randomUUID} from 'node:crypto';
import {clean} from './control.mjs';

export function initializeOwnerConversations(state){
 state.ownerConversations??=[];
 // Import visible prior turns without adopting or replaying unknown native logs.
 for(const task of [...state.ownerTasks].reverse()){
  task.conversationId??='legacy-'+task.id;
  let conversation=state.ownerConversations.find(c=>c.id===task.conversationId);
  if(!conversation){conversation={id:task.conversationId,title:clean(task.prompt).slice(0,50),createdAt:task.at,updatedAt:task.finishedAt||task.at,turnsAssigned:0};state.ownerConversations.push(conversation);}
  task.turnIndex??=++conversation.turnsAssigned;
  conversation.turnsAssigned=Math.max(conversation.turnsAssigned||0,task.turnIndex);
  if(task.status==='queued'){task.status='interrupted';task.result='服务已重启，这条补充尚未执行；可以在此任务继续，不会自动重发。';}
 }
}
export function enqueueOwnerTurn(state,prompt,requestId,conversationId,now=Date.now()){
 let conversation=conversationId&&state.ownerConversations.find(c=>c.id===conversationId);
 if(conversationId&&!conversation)throw Error('任务对话不存在，请选择已有任务或新建');
 if(state.ownerTasks.filter(t=>t.status==='queued').length>=20)throw Error('等待处理的补充已达20条，请等待现有轮次完成');
 if(!conversation){conversation={id:randomUUID(),title:clean(prompt).slice(0,50),createdAt:now,updatedAt:now,turnsAssigned:0};state.ownerConversations.push(conversation);}
 const task={id:randomUUID().replaceAll('-',''),...(requestId?{requestId}:{}),conversationId:conversation.id,turnIndex:++conversation.turnsAssigned,prompt,status:'queued',at:now,result:'',progress:{stage:'queued',lastActivityAt:now}};
 state.ownerTasks.unshift(task);conversation.updatedAt=now;
 return {task,conversation};
}
export function conversationHistory(state,conversationId,currentTaskId){
 const turns=state.ownerTasks.filter(t=>t.conversationId===conversationId&&t.id!==currentTaskId&&t.status!=='queued').sort((a,b)=>a.turnIndex-b.turnIndex).slice(-10);
 let budget=14000;const history=[];
 for(const t of turns.reverse()){
  const prompt=clean(t.prompt).slice(0,Math.min(3000,budget)),result=clean(t.result).slice(0,Math.min(3500,Math.max(0,budget-prompt.length)));
  history.unshift({turn:t.turnIndex,owner:prompt,assistant:result,status:t.status});budget-=prompt.length+result.length;if(budget<=0)break;
 }return history;
}
export function conversationRows(state){
 return state.ownerConversations.map(c=>{
  const turns=state.ownerTasks.filter(t=>t.conversationId===c.id).sort((a,b)=>a.turnIndex-b.turnIndex),last=turns.at(-1),running=turns.find(t=>t.status==='running'),queued=turns.filter(t=>t.status==='queued');
  return {id:c.id,title:c.title,createdAt:c.createdAt,updatedAt:c.updatedAt,status:running?'running':queued.length?'queued':last?.status||'empty',turnCount:c.turnsAssigned,queued:queued.length,lastTaskId:last?.id,nativeContextSaved:!!c.harnessSessionId};
 }).sort((a,b)=>b.updatedAt-a.updatedAt);
}

const threadOf=task=>task.conversationId||'legacy-'+task.id;
const turnOrder=task=>task.turnIndex||task.at||0;
const orderedTurns=turns=>turns.sort((a,b)=>turnOrder(a)-turnOrder(b));
function desktopTurn(task){
 const {id,conversationId,turnIndex,prompt,result,status,at,startedAt,finishedAt,source,sourceChannel,progress}=task;
 return {id,conversationId:conversationId||threadOf(task),turnIndex,prompt,result,status,at,startedAt,finishedAt,source,sourceChannel,
  progress:progress&&{stage:progress.stage,toolCalls:progress.toolCalls,lastActivityAt:progress.lastActivityAt}};
}

function withTurnRevision(view,knownRevision){
 const {ownerTaskScope,ownerTaskThread}=view;
 if(!ownerTaskThread)return view;
 const {ownerTasks,...summary}=view;
 const ownerTaskRevision=createHash('sha256').update(JSON.stringify([ownerTaskScope,ownerTaskThread,ownerTasks])).digest('hex');
 if(knownRevision===ownerTaskRevision)return {...summary,ownerTaskRevision,ownerTasksUnchanged:true};
 return {...summary,ownerTaskRevision,ownerTasks};
}

export function desktopOwnerTaskView(state,panel,thread,knownRevision){
 const scope={ownerTaskScope:panel,ownerTaskThread:'',ownerTaskIndex:[],ownerTasks:[]};
 const channel=panel==='job-channel'?'jobSearch':panel==='hr-channel'?'hrInbox':null;
 if(panel!=='owner'&&!channel)return scope;
 const channelIds={
  jobSearch:state.channelConversations?.jobSearch||state.autonomy?.conversationId,
  hrInbox:state.channelConversations?.hrInbox
 };
 if(channel){
  const id=channelIds[channel];
  if(!id)return scope;
  const recorded=state.ownerConversations.find(conversation=>conversation.id===id)?.sourceChannel;
  const other=channel==='jobSearch'?'hrInbox':'jobSearch';
  if(recorded&&recorded!==channel||!recorded&&channelIds[other]===id)return scope;
  const turns=state.ownerTasks.filter(task=>threadOf(task)===id&&(!task.sourceChannel||task.sourceChannel===channel)&&
   (channel==='jobSearch'||task.source!=='autonomy'));
  return withTurnRevision({...scope,ownerTaskThread:id,ownerTasks:orderedTurns(turns).slice(-24).map(desktopTurn)},knownRevision);
 }

 const dedicated=new Set([channelIds.jobSearch,channelIds.hrInbox,state.autonomy?.conversationId]);
 for(const conversation of state.ownerConversations)if(conversation.sourceChannel||conversation.autonomyGoalId)dedicated.add(conversation.id);
 const groups=new Map(state.ownerConversations.filter(conversation=>!dedicated.has(conversation.id)).map(conversation=>
  [conversation.id,{id:conversation.id,title:conversation.title,updatedAt:conversation.updatedAt||conversation.createdAt||0,turns:[]}]));
 for(const task of state.ownerTasks){
  const id=threadOf(task);
  if(dedicated.has(id)||task.sourceChannel||task.source==='autonomy')continue;
  let group=groups.get(id);
  if(!group){group={id,title:clean(task.prompt).slice(0,50),updatedAt:0,turns:[]};groups.set(id,group);}
  group.turns.push(task);
  group.updatedAt=Math.max(group.updatedAt||0,task.finishedAt||task.at||0);
 }
 const ownerTaskIndex=[...groups.values()].map(({id,title,updatedAt,turns})=>{
  let last,queued=0,running=false;
  for(const turn of turns){
   if(!last||turnOrder(turn)>=turnOrder(last))last=turn;
   if(turn.status==='queued')queued++;
   if(turn.status==='running')running=true;
  }
  return {id,title,updatedAt,status:running?'running':queued?'queued':last?.status||'empty',turnCount:turns.length,queued};
 }).sort((a,b)=>b.updatedAt-a.updatedAt);
 const selected=thread==='~new'?null:groups.get(thread)||groups.get(ownerTaskIndex[0]?.id);
 return withTurnRevision({...scope,ownerTaskIndex,ownerTaskThread:selected?.id||'',ownerTasks:selected?orderedTurns(selected.turns).map(desktopTurn):[]},knownRevision);
}
