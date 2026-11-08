import {channelRunning} from './channels.mjs';
import {randomUUID,createHash} from 'node:crypto';
import {careerRejection} from './career.mjs';
import {favoritePriorityCutoff} from './favorites.mjs';
import {matchesJobCity} from './job-match.mjs';

const activeTasks=new Set(['pending','approved','executing']);
const norm=value=>String(value||'').replace(/\s+/g,'').toLowerCase();
const url=value=>String(value||'').split('?')[0];
export function greetingCriteria(config){
 const {experiencePolicy='legacy',maxExperienceYears=0,excludeSenior=true,...profile}=config.profile;
 // Default and inactive settings keep the old stamp, so an upgrade does not
 // revisit candidates already evaluated under the same effective rules.
 if(!profile.earlyCareerOnly){
  if(experiencePolicy!=='legacy')profile.experiencePolicy=experiencePolicy;
  if(experiencePolicy==='max')profile.maxExperienceYears=maxExperienceYears;
  if(!excludeSenior)profile.excludeSenior=false;
 }
 return createHash('sha256').update(JSON.stringify({profile,minScore:config.minScore,policy:'0.10'})).digest('hex').slice(0,32);
}
export const favoriteJob=job=>job?.favorite===true||job?.source==='favorite'||Array.isArray(job?.sources)&&job.sources.includes('favorite');
export const prioritizedFavorite=(job,cutoff)=>favoriteJob(job)&&(!cutoff||job.favoriteObservedAt>cutoff);
const olderFavorite=(job,cutoff)=>favoriteJob(job)&&!(job.lastSeenAt>cutoff);
export function jobPriority(config,a,b,cutoff=0){
 const favorites=config.favoritesFirst!==false;
 return (favorites?Number(prioritizedFavorite(b,cutoff))-Number(prioritizedFavorite(a,cutoff)):0)||
  Number(b?.status==='ready')-Number(a?.status==='ready')||
  (favorites&&cutoff?Number(olderFavorite(a,cutoff))-Number(olderFavorite(b,cutoff)):0);
}
export function favoriteDiscoveryPending(state,now=Date.now()){
 const f=state.favorites;if(state.config.favoritesFirst===false||!f?.enabled||f.lastScanAt>0||!['queued','discovering'].includes(f.status))return false;
 const requestedAt=Number(f.requestedAt??f.startedAt??f.at);return Number.isFinite(requestedAt)&&requestedAt>0&&now>=requestedAt&&now-requestedAt<45000;
}

const simpleGreeting=/^(?:(?:小鲸(?:鱼)?|请你?|帮我|替我|麻烦你?|先|再|继续)[\s，,、]*){0,6}(?:向|给|跟|和|对)\s*([0-9]{1,2}|[一二]?十[一二三四五六七八九]?|[一二两三四五六七八九])\s*(?:位|个|名|家)\s*(?:(?:合适|匹配|符合条件|新)的?\s*)?(?:HR|招聘(?:者|人员|方)?|人事|公司)?\s*(?:打(?:个)?招呼|发(?:送)?(?:一?[个条]|些)?(?:招呼|问候)|问候)(?:一下)?(?:吧)?[。！!，,\s]*(?:谢谢[。！!\s]*)?$/iu;

// Only the whole simple imperative routes directly. Richer requests use the owner tool.
export function greetingRequest(prompt){
 const text=String(prompt||'').trim();
 if(text.length>90||/[\r\n]/.test(text))return null;
 const match=text.match(simpleGreeting);
 if(!match)return null;const map={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
 const raw=match[1],parts=raw.split('十');const count=/^\d+$/.test(raw)?Number(raw):raw.includes('十')?(parts[0]?map[parts[0]]:1)*10+(parts[1]?map[parts[1]]:0):map[raw];
 return count>=1&&count<=20?{count,instruction:text}:null;
}

const addressedRecruiter=String.raw`(?:(?:向|给|跟|和|对)\s*(?:(?!写|拟|草稿|准备|可以|适合|如何|怎么|文案|话术)[^，,。！？!?；;\n]){1,28}?\s*)?`;
const noGreetingSend=new RegExp(String.raw`(?:不要|别|暂不|先不(?:要)?|不必|无需|不用|不许|禁止|不能|(?<!不得)不(?=发|打招呼|联系|沟通))\s*(?:(?:现在|实际|真的|自动|直接|立即|马上|代我|再)\s*){0,2}${addressedRecruiter}(?:发(?:送|出|给|消息|招呼|(?=[\s，,。！？!?；;]|$))|打(?:个)?招呼|联系|沟通|打扰)`,'u');
const waitingForOwner=/(?:等(?:我|主人)[^，,。！？!?；;\n]{0,12}(?:确认|批准|同意)|(?:我|主人)(?:确认|批准|同意)(?:了)?(?:之后|以后|后)再(?:发|联系|打招呼))/u;
const ownerWaivesApproval=/(?:不用|无需|不必|不需要)\s*(?:再\s*)?等(?:我|主人)\s*(?:确认|批准|同意)/gu;
const greetingDraft=/(?:写|拟|准备|整理|生成|润色|修改|改写|审阅)[^，,。！？!?；;\n]{0,36}(?:招呼|问候|开场白|草稿|文案|话术)|(?:招呼|问候|开场白)[^，,。！？!?；;\n]{0,6}(?:草稿|文案|话术)/u;
const greetingSelection=/(?:挑选?|选出|筛选|找出?|推荐|列出|查看|看看|分析)[^，,。！？!?；;\n]{0,40}(?:HR|招聘|人事|岗位|职位|打招呼|问候)/iu;
const externalRecipient=String.raw`(?!(?:我|主人)\s*(?:看|确认|审核))[^，,。！？!?；;\n]{0,24}?(?:HR|人事|招聘(?:者|方|人员)|他们|她们|对方|负责人|女士|先生)`;
const sendToRecruiter=String.raw`发(?:送)?\s*给\s*${externalRecipient}`;
const explicitGreetingStep=new RegExp(String.raw`(?:^|[，,。！？!?；;]|并且?|然后|再|接着|随后|顺便|直接|之后|以后|后)\s*(?:(?:小鲸(?:鱼)?|请你?|帮我|替我|麻烦你?|先|再|直接)[\s，,、]*){0,6}${addressedRecruiter}(?:打(?:个)?招呼|发(?:送)?(?:一?[个条])?招呼(?:\s*给\s*${externalRecipient})?|${sendToRecruiter}|发(?:送)?出去|发送|联系(?:${externalRecipient})?)\s*(?=一下|吧|并|然后|再|[，,。！!；;]|$)`,'iu');
const selectedGreetingStep=/(?:挑选?|选出|筛选|找出)[^，,。！？!?；;\n]{1,38}?(?:HR|人事|招聘(?:者|方|人员)?)\s*(?:打(?:个)?招呼|发(?:送)?(?:一?[个条])?招呼)(?:一下)?(?:吧)?[。！!\s]*$/iu;
const forwardedGreetingStep=new RegExp(String.raw`(?:把|将)[^，,。！？!?；;\n]{1,46}?(?:${sendToRecruiter}|发(?:送)?出去)(?:吧)?[。！!\s]*$`,'iu');

// The authenticated owner turn is authoritative, even if its tool payload says to send.
export function greetingReadOnlyIntent(prompt){
 const text=String(prompt||'').trim();
 if(noGreetingSend.test(text)||waitingForOwner.test(text.replace(ownerWaivesApproval,'')))return true;
 return (greetingDraft.test(text)||greetingSelection.test(text))&&
  !explicitGreetingStep.test(text)&&!selectedGreetingStep.test(text)&&!forwardedGreetingStep.test(text);
}
export function potentialGreeting(job,profile={}){
 if(!job?.url||!profile.titles?.some(t=>norm(job.title).includes(norm(t))))return false;
 if(!matchesJobCity(job.city,profile.cities,{allowMissing:job.status!=='ready'}))return false;
 if(profile.exclusions?.some(t=>JSON.stringify(job).toLowerCase().includes(t.toLowerCase())))return false;
 return !careerRejection(job,profile,{allowUnknown:true});
}
export function contactedJob(state,job){
 const link=url(job.url);
 return Object.values(state.memories||{}).some(c=>url(c.job?.url)===link&&c.history?.some(m=>['self','hr'].includes(m.role)&&!/^快来与|向.{0,20}打招呼|对方还没有|开始沟通/.test(m.text||'')))||(state.tasks||[]).some(t=>t.kind==='greeting'&&url(t.job?.url)===link&&(['sent','uncertain','executing'].includes(t.status)||t.status==='skip'&&t.alreadyPresent===true));
}
export function greetingPreviouslyHandled(state,job,stamp=greetingCriteria(state.config)){
 return contactedJob(state,job)||(state.tasks||[]).some(t=>{
  const explicitlyResumed=t.status==='rejected'&&!t.reservedAt&&(state.greetingPlans||[]).some(p=>p.id===t.greetingPlanId&&p.status==='queued'&&(p.targets||[]).some(target=>target.jobId===job.id&&target.status==='queued'&&!target.taskId));
  return t.kind==='greeting'&&url(t.job?.url)===url(job.url)&&!explicitlyResumed&&(['pending','approved','hold','executing','sent','uncertain'].includes(t.status)||t.criteriaHash===stamp&&t.status!=='stale');
 })||(state.greetingPlans||[]).some(p=>p.status==='cancelled'&&(p.targets||[]).some(t=>t.jobId===job.id&&t.status==='cancelled'));
}
function automaticCandidates(state,now){
 const stamp=greetingCriteria(state.config),waiting=favoriteDiscoveryPending(state,now),cutoff=favoritePriorityCutoff(state);
 return Object.values(state.jobs||{}).filter(j=>potentialGreeting(j,state.config.profile)&&!greetingPreviouslyHandled(state,j,stamp)&&j.status!=='needs_adaptation'&&(!waiting||prioritizedFavorite(j,cutoff))).sort((a,b)=>jobPriority(state.config,a,b,cutoff));
}
function standingGreetingInstruction(profile){
 const scope=profile.earlyCareerOnly?'当前城市、岗位及校招或实习条件':'当前城市、岗位、经验和岗位级别条件';
 return `主人已授权持续自主求职。向符合${scope}的新 HR 发送针对性招呼，普通技能差距不作为拒绝沟通理由。`;
}
export function ensureAutomaticGreeting(state,now=Date.now()){
 if(!channelRunning(state.config,'jobSearch')||!state.config.autoGreet||state.config.mode!=='auto'||activeGreeting(state))return null;
 const today=new Date(now+8*3600000).toISOString().slice(0,10);
 const sent=state.tasks.filter(t=>t.reservedAt&&new Date(t.reservedAt+8*3600000).toISOString().slice(0,10)===today);
 if(sent.length>=state.config.limits.dailyMessages||sent.filter(t=>t.kind==='greeting').length>=state.config.limits.dailyGreetings)return null;
 const jobs=automaticCandidates(state,now);
 if(!jobs.length)return null;
 // A fresh one-contact plan expresses the standing goal. Cancelled finite
 // owner batches are never resumed, and uncertain recipients stay excluded.
 const plan={id:randomUUID(),requestId:'automatic:'+randomUUID(),kind:'greeting',origin:'standing_goal',instruction:standingGreetingInstruction(state.config.profile),requested:1,status:'queued',targets:[],jobIds:jobs.map(j=>j.id),createdAt:now,expiresAt:now+24*3600000,waitingReason:'自主招呼队列已建立'};
 state.greetingPlans??=[];state.greetingPlans.push(plan);state.greetingPlans=state.greetingPlans.slice(-100);refreshGreeting(state,plan,now);return plan;
}
export function createGreetingPlan(state,input,ownerTaskId,now=Date.now()){
 const requestId=String(input.requestId||'').trim(),instruction=String(input.instruction||'').trim(),count=Number(input.count);
 if(!requestId||requestId.length>150||!instruction||instruction.length>2000||!Number.isInteger(count)||count<1||count>20)throw Error('请指定1—20位HR、任务目的和唯一requestId');
 const old=(state.greetingPlans||[]).find(p=>p.requestId===requestId);
 if(old){if(old.requested!==count||old.instruction!==instruction)throw Error('相同requestId不能更换招呼数量或目的');return old;}
 if(state.greetingPlans?.some(p=>['queued','uncertain'].includes(p.status)))throw Error('已有未完成或待核对的招呼委托，请先核对任务中心');
 if(state.tasks.some(t=>t.status==='executing'))throw Error('正在站内发送，请等待回显后再提交');
 const plan={id:randomUUID(),requestId,ownerTaskId,kind:'greeting',instruction,requested:count,status:'queued',targets:[],createdAt:now,expiresAt:now+24*3600000,waitingReason:'等待读取岗位详情，尚未确认可投递数量'};
 if(input.jobIds!==undefined){if(!Array.isArray(input.jobIds)||!input.jobIds.length||input.jobIds.length>100||input.jobIds.some(id=>!state.jobs?.[id]))throw Error('岗位选择必须来自实际岗位资料库');plan.jobIds=[...new Set(input.jobIds)];}
 state.greetingPlans??=[];state.greetingPlans.push(plan);state.greetingPlans=state.greetingPlans.slice(-100);state.boundedGreetings=true;
 return plan;
}
export function activeGreeting(state){return state.greetingPlans?.find(p=>p.status==='queued')||null;}
export function refreshGreeting(state,plan,now=Date.now()){
 if(!plan)return plan;
 for(const target of plan.targets){const task=state.tasks.find(t=>t.id===target.taskId);if(task){if(task.status==='stale'&&plan.status==='queued'&&!task.reservedAt){target.status='queued';target.reason='资料或会话更新，重新生成尚未发送的招呼';delete target.taskId;}else{target.status=task.status==='approved'||task.status==='pending'?'ready':task.status;target.reason=task.evidence||task.reason||'';}}}
 const sent=plan.targets.filter(t=>t.status==='sent').length;plan.sent=sent;
 if(plan.status!=='queued')return plan;
 if(plan.targets.some(t=>t.status==='uncertain')){plan.status='uncertain';plan.waitingReason='发送结果待核对，已停止此批，不补发、不换人凑数';}
 else if(sent>=plan.requested){plan.status='done';plan.waitingReason='已达到本次指定数量，停止继续打招呼';}
 else if(now>=plan.expiresAt){plan.status='expired';plan.waitingReason='任务已到期，未完成部分不会自动重发';}
 if(plan.status!=='queued'){plan.finishedAt=now;return plan;}
 // Standing goals can accept newly discovered favorites. Explicit finite jobIds
 // remain an owner-selected scope and are never enlarged by a background scan.
 const standing=plan.origin==='standing_goal',cutoff=standing?favoritePriorityCutoff(state):0;
 if(standing){
  plan.instruction=standingGreetingInstruction(state.config.profile);
  plan.jobIds=[...new Set([...(plan.jobIds||[]),...automaticCandidates(state,now).map(j=>j.id)])].sort((a,b)=>jobPriority(state.config,state.jobs[a],state.jobs[b],cutoff));
 }
 const candidates=Object.values(state.jobs||{}).filter(j=>(!plan.jobIds||plan.jobIds.includes(j.id))&&potentialGreeting(j,state.config.profile)&&!greetingPreviouslyHandled(state,j)).sort((a,b)=>jobPriority(state.config,a,b,cutoff));
 for(const job of candidates)if(!plan.targets.some(t=>t.jobId===job.id)&&!contactedJob(state,job)){
  if(plan.targets.length>=100&&standing&&prioritizedFavorite(job,cutoff)){
   const replace=[...plan.targets].reverse().find(t=>t.status==='queued'&&!t.taskId&&!prioritizedFavorite(state.jobs[t.jobId],cutoff));if(replace)plan.targets.splice(plan.targets.indexOf(replace),1);
  }
  if(plan.targets.length<100)plan.targets.push({id:randomUUID(),jobId:job.id,title:job.title,company:job.company||'',status:'queued'});
 }
 if(standing&&plan.targets.length&&plan.targets.every(t=>['skip','hold','failed','stale','cancelled','rejected'].includes(t.status))){plan.status='exhausted';plan.finishedAt=now;plan.waitingReason='本批候选已处理，等待新的可沟通岗位';}
 return plan;
}
export function nextGreetingTarget(state,plan,onJobsChanged){
 refreshGreeting(state,plan);if(plan?.status!=='queued')return null;
 if(plan.targets.some(t=>['ready','executing','generating'].includes(t.status)))return null;
 const standing=plan.origin==='standing_goal',waiting=standing&&favoriteDiscoveryPending(state),cutoff=standing?favoritePriorityCutoff(state):0;
 let jobsChanged=false,next=null;
 for(const t of [...plan.targets].sort((a,b)=>jobPriority(state.config,state.jobs[a.jobId],state.jobs[b.jobId],cutoff))){if(!['queued','reading'].includes(t.status))continue;const job=state.jobs[t.jobId];
  if(!job||!potentialGreeting(job,state.config.profile)||greetingPreviouslyHandled(state,job)){t.status='skip';t.reason='岗位已沟通过、当前条件下已处理或不符合当前求职条件';continue;}
  if(waiting&&!prioritizedFavorite(job,cutoff))continue;
  if(job.status==='reading'&&Date.now()-job.reservedAt>180000){
   t.status='failed';t.reason='详情读取超时，不自动重复打开';job.status='needs_adaptation';delete job.lease;
   jobsChanged=true;
   continue;
  }
  if(job.status==='needs_adaptation'){t.status='failed';t.reason='未读取到完整岗位详情，不能作为合格岗位';continue;}
  t.company=job.company||t.company;t.title=job.title;
  next={target:t,job};break;
 }
 if(jobsChanged)onJobsChanged?.();
 return next;
}
export function greetingAllowed(state,task){
 const p=state.greetingPlans?.find(p=>p.id===task.greetingPlanId),target=p?.targets.find(t=>t.id===task.greetingTargetId);
 return !!(p&&(p.origin!=='standing_goal'||channelRunning(state.config,'jobSearch'))&&p.status==='queued'&&p.expiresAt>Date.now()&&(p.sent||0)<p.requested&&target&&['ready','executing'].includes(target.status)&&target.taskId===task.id&&task.kind==='greeting');
}
export function greetingSummary(state,plan){
 refreshGreeting(state,plan);
 return {id:plan.id,ownerTaskId:plan.ownerTaskId,status:plan.status,requested:plan.requested,sent:plan.sent||0,waitingReason:plan.waitingReason,candidates:plan.targets.length,verifiedCandidates:plan.targets.filter(t=>state.jobs[t.jobId]?.status==='ready').length,targets:plan.targets.map(t=>({...t})),createdAt:plan.createdAt};
}
export function greetingReport(state,plan){
 const p=greetingSummary(state,plan),lines=[`主人，这次招呼任务已建立：${p.sent}/${p.requested} 位 HR 已确认发送。`];
 if(p.status==='done')lines.push('已达到指定数量，本批不会再发。');
 else lines.push(p.waitingReason||'正在按岗位详情逐个筛选、拟写并核对发送结果。');
 lines.push(`本批已收录 ${p.candidates} 个候选；已读到完整详情 ${p.verifiedCandidates} 个。候选不等于合格岗位。`,'实际进度会显示在任务中心，无需再催问或重复下达同一条指令。');
 return lines.join('\n');
}
export function cancelGreeting(state,plan,reason='主人停止此批招呼'){
 if(!plan||plan.status!=='queued')throw Error('此批招呼已经结束或需要先核对');
 if(state.tasks.some(t=>t.greetingPlanId===plan.id&&t.status==='executing'))throw Error('此批正在站内发送，先等待结果');
 for(const task of state.tasks)if(task.greetingPlanId===plan.id&&activeTasks.has(task.status)){task.status='rejected';task.reason=reason;}
 for(const target of plan.targets)if(['queued','reading','generating','ready'].includes(target.status)){target.status='cancelled';target.reason=reason;}
 plan.status='cancelled';plan.waitingReason=reason;plan.finishedAt=Date.now();
}
export function resumeGreeting(state,plan,now=Date.now()){
 if(!plan||plan.status!=='cancelled'||plan.expiresAt<=now)throw Error('没有可继续的未执行招呼批次');
 if(state.greetingPlans.some(p=>p!==plan&&['queued','uncertain'].includes(p.status))||state.tasks.some(t=>t.status==='executing'))throw Error('还有未完成或待核对的发送，先核对实际记录');
 const targets=plan.targets.filter(t=>t.status==='cancelled'&&!state.tasks.find(task=>task.id===t.taskId)?.reservedAt);
 if(!targets.length)throw Error('没有确认尚未开始发送的目标，不重发已发或结果不明的消息');
 const ownerRead=!plan.sourceChannel&&plan.origin!=='standing_goal';
 if(ownerRead)plan.readRevision=(plan.readRevision??0)+1;
 for(const target of targets){
  target.status='queued';delete target.taskId;delete target.reason;
  const job=state.jobs?.[target.jobId];
  if(ownerRead&&job?.status==='reading'&&job.ownerGreetingPlanId===plan.id){
   job.status='listed';delete job.lease;delete job.ownerGreetingPlanId;
  }
 }
 plan.status='queued';delete plan.finishedAt;plan.waitingReason='继续此前确定未开始发送的目标；已发记录保持不变';refreshGreeting(state,plan,now);return plan;
}
