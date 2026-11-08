// A new owner request ID or a self-message changes the DOM fingerprint, but
// neither represents a new HR question. Keep content dedup tied to that question.
const canonicalBody=value=>String(value||'').normalize('NFC').replace(/\s+/g,' ').trim();
const receiptPrefix=/^(?:(?:今天|昨天)\s+)?(?:[01]?\d|2[0-3])[:：][0-5]\d\s+(?:已送达|已发送|未读|已读|送达)\s+/;
export function matchesReceiptBody(observed,expected){
 const body=canonicalBody(observed),wanted=canonicalBody(expected);
 return !!wanted&&(body===wanted||body.replace(receiptPrefix,'')===wanted);
}

export function outgoingText(value=''){
 const lines=String(value).normalize('NFKC').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
 const decoration=s=>/^(?:已读|未读|送达|已送达|已发送|发送中|\d{1,2}[:：]\d{2}|今天|昨天|\d{1,2}[-月/]\d{1,2}日?)$/.test(s);
 while(lines.length&&decoration(lines[0]))lines.shift();
 while(lines.length&&decoration(lines.at(-1)))lines.pop();
 return lines.join('').replace(/\s+/g,'').replace(/[，,。.!！?？;；:：、]/g,'').toLowerCase();
}
export const hrAnchor=c=>(c?.history||c?.window||[]).filter(m=>m.role==='hr'&&m.id).at(-1)?.id||'';
function taskAnchor(task,c){
 if(task.replyAnchor!==undefined)return task.replyAnchor;
 if(task.messageIdsBefore?.length){const before=new Set(task.messageIdsBefore);return (c?.history||[]).filter(m=>m.role==='hr'&&before.has(m.id)).at(-1)?.id||'';}
 const at=task.reservedAt||task.createdAt;
 return at?(c?.history||[]).filter(m=>m.role==='hr'&&m.id&&m.observedAt<=at).at(-1)?.id||'':'';
}
export function duplicateOutgoing(state,task){
 if(task?.action!=='send_text'||!task.peerId)return null;
 const value=outgoingText(task.text);if(!value)return null;
 const c=state.memories?.[task.peerId],anchor=task.replyAnchor??hrAnchor(c);
 const prior=(state.tasks||[]).find(t=>t.id!==task.id&&t.peerId===task.peerId&&t.action==='send_text'&&['pending','approved','executing','sent','uncertain'].includes(t.status)&&outgoingText(t.text)===value&&(t.status==='uncertain'||taskAnchor(t,c)===anchor));
 if(prior)return {reason:prior.status==='uncertain'?'相同消息已有发送结果待核对，不重复发送':'同一HR来信之后已准备或发送过相同内容，不重复发送',taskId:prior.id};
 const history=c?.history||[],at=anchor?history.findLastIndex(m=>m.role==='hr'&&m.id===anchor):-1;
 const observed=history.slice(at+1).find(m=>m.role==='self'&&outgoingText(m.text)===value);
 if(observed)return {reason:'同一HR来信之后网页已有相同的我方消息，不重复发送',messageId:observed.id};
 return null;
}
export function applyOutgoingDedup(state,task){
 const duplicate=duplicateOutgoing(state,task);if(!duplicate)return task;
 return {...task,action:'skip',text:'',status:'skip',reason:duplicate.reason,duplicateOf:duplicate.taskId||duplicate.messageId,updatedAt:Date.now()};
}
