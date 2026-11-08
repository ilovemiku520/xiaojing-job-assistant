import {randomUUID} from 'node:crypto';
import {matchesReceiptBody} from './outgoing-dedup.mjs';

const active=new Set(['queued','reading','generating','ready']);
const clause=String.raw`[^，,。！？!?；;\r\n]`;
const recipientPrefix=String.raw`(?:(?:这|那|该|此|任何|任意|所有|上述)(?:一)?(?:位|个|名|些)?|[0-9一二两三四五六七八九十]{1,3}\s*(?:位|个|名))`;
const recipient=String.raw`(?:${recipientPrefix}\s*)?(?:HR|人事|招聘(?:者|方|人员)?|对方|负责人|他(?:们)?|她(?:们)?|[^\s，,。！？!?；;]{1,12}(?:女士|先生))`;
const addressed=String.raw`(?:(?:向|给|对|跟|找)\s*${recipient}\s*)?`;
const attachment=String.raw`(?!(?:\s*(?:这份|同一份|新的|原来的|之前发过的|旧的|一份|(?:任何|任意)(?:一份)?))?\s*(?:附件|简历|作品集|材料|文件))`;
const messageObject=String.raw`(?:(?:任何|任意)(?:一条)?|(?:这|那|该|一)条)?\s*(?:消息|信息)`;
const endOfAction=String.raw`(?=[\s，,。！？!?；;]|$)`;
const noDirective=String.raw`(?:不要|别|先不(?:要)?|暂(?:时)?不|无需|不必|不用|不许|禁止|不能|不(?=发))\s*(?:(?:现在|实际|真的|自动|直接|立即|马上|再|去|替我|代我|在\s*BOSS(?:直聘)?\s*上)\s*){0,2}`;
const outgoingAction=String.raw`(?:发送${attachment}|发出${attachment}|发(?:\s*${messageObject}|出去|给\s*${recipient}|${endOfAction})${attachment}|联系(?!\s*(?:其他|别的|另一位|更多))|打扰|回复(?:\s*(?:${recipient}|${messageObject})|${endOfAction})|追问(?:\s*(?:${recipient}|进度|进展|结果)|${endOfAction})|问(?:问|一下)?\s*${recipient})`;
const noFollowupSend=new RegExp(noDirective+addressed+outgoingAction,'iu');
const ownerApproval=/(?:等(?:我|主人)[^，,。！？!?；;\n]{0,14}(?:确认|审核|批准|同意|点头|看过)|(?:我|主人)(?:确认|审核|批准|同意)(?:了)?(?:之后|以后|后)再(?:发|联系|追问|问))/u;
const approvalWaived=/(?:不用|无需|不必|不需要)\s*(?:再\s*)?等(?:我|主人)\s*(?:确认|审核|批准|同意|点头|看过)/gu;
const followupDraft=/(?:只|仅)(?:需|要)?(?:写|拟|起草|准备|生成)|(?:起草|草拟|拟稿|草稿|文案|话术)|(?:写|拟|准备|整理|生成|润色|改写|审阅)[^，,。！？!?；;\n]{0,36}(?:消息|回复|询问进度)/u;
const inspectFollowup=/(?:挑选?|选(?:出|好)?|筛选|找出|查看|看看|看一下|读取|阅读|查阅|核对|汇总|整理)[^，,。！？!?；;\n]{0,36}(?:HR|招聘|人事|聊天|会话|对话|历史|记录|回复|回执|进度)/iu;
const askProgress=String.raw`(?:询问|追问|问问|问一下|问)(?=\s*(?:${recipient}|筛选|简历|岗位|进度|进展|结果|反馈|目前|现在|是否|还有|能否|有没有|什么时候|一下|吧|[，,。！!；;]|$))`;
const sendToRecipient=String.raw`发(?:送)?\s*给\s*${recipient}`;
const commandStart=String.raw`(?:^|[，,。！？!?；;\n]|并且?|然后|之后|以后|接着|再|随后|顺便|直接)\s*(?:(?:请你?|帮我|替我|麻烦你?|先|再|直接)\s*){0,4}`;
const followupStep=new RegExp(commandStart+String.raw`(?:${addressed}${askProgress}|${sendToRecipient}|发(?:送)?出去|发送(?=\s*[。！!；;]?$)|联系\s*${recipient})`,'iu');
const progressStep=new RegExp(commandStart+String.raw`(?:主动\s*)?跟进\s*(?:${recipient}\s*的?\s*(?:简历\s*)?(?:筛选\s*)?|(?:简历\s*)?筛选\s*)(?:进度|进展)(?=\s*(?:一下|吧|[，,。！？!?；;]|$))`,'iu');
const quotedText=/“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"/gu;
const selectedThenAsk=new RegExp(String.raw`(?:挑选?|选(?:出|好)?|筛选|找出)${clause}{0,36}?${recipient}\s*${askProgress}`,'iu');
const sendPreparedDraft=new RegExp(String.raw`(?:把|将)${clause}{1,46}?(?:${sendToRecipient}|发(?:送)?出去)`,'iu');

export function followupReadOnlyIntent(prompt){
 const text=String(prompt||'').trim();
 if(noFollowupSend.test(text)||ownerApproval.test(text.replace(approvalWaived,'')))return true;
 return (followupDraft.test(text)||inspectFollowup.test(text))&&
  !followupStep.test(text)&&!selectedThenAsk.test(text)&&!sendPreparedDraft.test(text)&&!progressStep.test(text.replace(quotedText,' '));
}

export function requireFollowupIntent(actor){
 if(actor?.source!=='autonomy'&&followupReadOnlyIntent(actor?.prompt))throw Error('主人本轮只要求读取或准备追问，未授权发送');
}

export function createOwnerChat(input,ownerTaskId,now=Date.now()){
 const kind=input.kind||'followup',instruction=String(input.instruction||'').trim(),requestId=String(input.requestId||'').trim();
 if(!['read','followup'].includes(kind)||!requestId||requestId.length>150)throw Error('需要 read/followup 类型及唯一 requestId');
 if(!instruction||instruction.length>2000)throw Error('需要说明本次读取或追问目的（最多2000字）');
 if(!Array.isArray(input.targets)||input.targets.length<1||input.targets.length>5)throw Error('每次选择1—5位HR');
 const seen=new Set(),targets=input.targets.map(t=>{
  const name=String(t.name||'').trim(),company=String(t.company||'').trim(),label=name+'\u001f'+company;
  if(!name||name.length>100||!company||company.length>150||seen.has(label))throw Error('HR和公司需要明确且不重复');seen.add(label);
  return {id:randomUUID(),name,company,status:'queued'};
 });
 return {id:randomUUID(),requestId,ownerTaskId,kind,instruction,targets,status:'queued',createdAt:now,expiresAt:now+24*3600000};
}
export function refreshOwnerChat(plan){
 if(plan.targets.some(t=>active.has(t.status)||t.status==='executing'))plan.status='queued';
 else{plan.status=plan.targets.every(t=>['sent','read'].includes(t.status))?'done':'finished_with_issues';plan.finishedAt??=Date.now();}
}
export function nextOwnerChat(state,now=Date.now()){
 for(const p of state.ownerChats||[]){
  if(p.status!=='queued')continue;
  if(p.expiresAt<=now){for(const t of p.targets)if(active.has(t.status))t.status='expired';refreshOwnerChat(p);continue;}
  const target=p.targets.find(t=>active.has(t.status));if(target)return {plan:p,target};
 }return null;
}
export function cancelOwnerChats(state,reason){
 for(const p of state.ownerChats||[]){if(p.status!=='queued')continue;for(const t of p.targets)if(active.has(t.status)||t.status==='executing'){t.status=t.status==='executing'?'uncertain':'cancelled';t.reason=reason;}refreshOwnerChat(p);}
}
export function ownerChatAllowed(state,task,now=Date.now()){
 const p=state.ownerChats?.find(p=>p.id===task.ownerChatPlanId),t=p?.targets.find(t=>t.id===task.ownerChatTargetId);
 return !!(p&&p.kind==='followup'&&p.status==='queued'&&p.expiresAt>now&&t&&['ready','executing'].includes(t.status)&&t.taskId===task.id&&t.peerId===task.peerId&&task.kind==='followup'&&task.action==='send_text');
}
export function verifyOwnerChatReceipt(state,task){
 const p=state.ownerChats?.find(p=>p.id===task?.ownerChatPlanId),t=p?.targets.find(t=>t.id===task?.ownerChatTargetId),c=state.memories[task?.peerId];
 if(!p||!t||task.status!=='uncertain'||!task.reservedAt||c?.domIdentity?.name!==t.name||c?.domIdentity?.company!==t.company)throw Error('没有符合目标身份的待核对追问');
 const before=new Set(task.messageIdsBefore||c.history.filter(m=>m.observedAt<task.reservedAt).map(m=>m.id));
 const matches=c.history.filter(m=>m.role==='self'&&m.id&&!before.has(m.id)&&m.observedAt>=task.reservedAt&&m.source==='boss_dom'&&!m.previousVersions?.some(v=>v.at<task.reservedAt)&&matchesReceiptBody(m.text,task.text));
 if(matches.length!==1)throw Error('未唯一发现本次完整正文的新消息编号，保持待核对，不重发');
 const m=matches[0];return {messageId:m.id,observedAt:m.observedAt,observedText:m.text,evidence:'已核对同一HR会话、发送后新增稳定消息编号 '+m.id+' 及完整正文'+(/送达|已读/.test(m.text)?'，页面显示送达/已读':'')};
}
