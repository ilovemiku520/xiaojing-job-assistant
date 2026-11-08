import {day} from './core.mjs';

const todoStatuses=new Set(['pending','approved','hold','executing','uncertain']);
const attentionStatuses=new Set(['pending','hold','uncertain']);
const activeReplyStatuses=new Set(['pending','approved','executing','hold']);
const overviewLimit=100;

function taskRow(task){
  const {id,kind,action,status,text,reason,waitingReason,evidence,createdAt,updatedAt,reservedAt,peerId,memoryRevision,fingerprint,stableMessageIds}=task;
  const {title,company,city,salary,url}=task.job||{};
  return {id,kind,action,status,text,reason,waitingReason,evidence,createdAt,updatedAt,reservedAt,peerId,memoryRevision,fingerprint,stableMessageIds,
    job:{title,company,city,salary,url},...(task.timing?{timing:{generationMs:task.timing.generationMs}}:{})};
}

export function desktopTaskView(tasks,replies,panel,now=Date.now()){
  const stats={attention:0,sent:0};
  const overviewCounts={all:0,todo:0,sent:0,uncertain:0};
  const linked=panel==='hr-channel'?new Set(replies.map(row=>row.taskId).filter(Boolean)):null;
  const date=linked?day(now):'';
  if(linked)Object.assign(stats,{reservedToday:0,executing:false});
  const rows=[],recentReplies=[];
  for(const task of tasks){
    if(attentionStatuses.has(task.status))stats.attention++;
    if(task.status==='sent')stats.sent++;
    if(panel==='overview'){
      let include=overviewCounts.all++<overviewLimit;
      if(todoStatuses.has(task.status)&&overviewCounts.todo++<overviewLimit)include=true;
      if(task.status==='sent'&&overviewCounts.sent++<overviewLimit)include=true;
      if(task.status==='uncertain'&&overviewCounts.uncertain++<overviewLimit)include=true;
      if(include)rows.push(taskRow(task));
    }
    if(linked){
      if(task.status==='executing')stats.executing=true;
      if(task.reservedAt&&day(task.reservedAt)===date)stats.reservedToday++;
      if(linked.has(task.id)&&activeReplyStatuses.has(task.status))rows.push(taskRow(task));
      else if(task.kind==='reply')recentReplies.push(task);
    }
  }
  if(linked)rows.push(...recentReplies.sort((a,b)=>(b.updatedAt||b.createdAt)-(a.updatedAt||a.createdAt)).slice(0,5).map(taskRow));
  return {tasks:rows,taskStats:stats};
}
