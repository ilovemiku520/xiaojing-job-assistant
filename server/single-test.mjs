import {randomUUID} from 'node:crypto';
import {riskyOutgoing} from './core.mjs';
import {matchesReceiptBody} from './outgoing-dedup.mjs';

export function createSingleTest(input,now=Date.now()){
 const name=String(input.name||'').trim(),company=String(input.company||'').trim(),text=String(input.text||'').trim();
 if(!name||name.length>80||!company||company.length>120)throw Error('单条测试需要明确HR和公司');
 if(!text||text.length>300||riskyOutgoing(text))throw Error('测试消息为空、过长或包含需主人处理的信息');
 return {id:randomUUID(),target:{name,company},text,reason:String(input.reason||'主人委托小鲸挑选一位HR测试发送').slice(0,500),status:'selecting',createdAt:now,expiresAt:now+15*60000};
}
export function singleTestAllowed(state,task,now=Date.now()){
 const plan=state.singleTest;
 return !!(plan&&['ready','executing'].includes(plan.status)&&plan.expiresAt>now&&plan.taskId===task.id&&task.singleTestPlanId===plan.id&&task.action==='send_text'&&task.text===plan.text&&task.job?.company===plan.target.company);
}
export function verifyTestSelection(plan,input,now=Date.now()){
 const normalized=x=>String(x||'').replace(/\s+/g,'');
 if(!plan||plan.id!==input.planId||plan.expiresAt<=now)throw Error('单条测试已过期或目标不匹配');
 if(input.name!==plan.target.name||input.company!==plan.target.company||input.uniquePeer!==true)throw Error('未能唯一识别选定HR');
 const header=normalized(input.header);
 if(!header.includes(normalized(plan.target.name))||!header.includes(normalized(plan.target.company)))throw Error('会话标题与小鲸选择的HR不一致');
 const title=String(input.job?.title||'');
 if(!/策划/.test(title)||(/资深|高级|主策|负责人|总监/.test(title)&&!/实习|校招|应届|管培|助理/.test(title)))throw Error('当前会话岗位不适合这次策划校招/实习测试');
 const lastHR=input.messages?.filter(m=>m.role==='hr').at(-1)?.text||'';
 if(/不(?:太)?(?:合适|适合)|暂不考虑|不再招聘|请勿打扰|不要再(?:联系|发)|不感兴趣/.test(lastHR))throw Error('HR已表示不合适或不希望继续沟通');
 if(!Array.isArray(input.messages)||!input.messages.length||input.messages.some(m=>!m.id)||new Set(input.messages.map(m=>m.id)).size!==input.messages.length)throw Error('缺少稳定消息编号，不能完成单条测试');
 return {title,company:plan.target.company,city:String(input.job?.city||'').slice(0,100)};
}
export function verifySingleTestReceipt(state,task,inspection,now=Date.now()){
 const plan=state.singleTest,normalize=x=>String(x||'').replace(/\s+/g,'');
 if(!plan||plan.taskId!==task?.id||task.singleTestPlanId!==plan.id||task.status!=='uncertain')throw Error('没有待核对的单条测试');
 if(inspection.url!=='https://www.zhipin.com/web/geek/chat'||inspection.at<task.reservedAt||now-inspection.at>90000||inspection.at>now+5000)throw Error('需要该次发送之后的新鲜聊天页记录');
 const nodes=inspection.nodes||[],selected=nodes.map((n,i)=>({n,i})).filter(({n})=>/(?:^|\s)friend-content(?:\s|$)/.test(n.attrs?.class||'')&&/(?:^|\s)selected(?:\s|$)/.test(n.attrs?.class||''));
 if(selected.length!==1)throw Error('不能唯一核对当前选中的HR');
 const start=selected[0].i;let end=start+1;while(end<nodes.length&&!/(?:^|\s)friend-content(?:\s|$)|chat-conversation/.test(nodes[end].attrs?.class||''))end++;
 const fields=nodes.slice(start,end),name=fields.find(n=>n.attrs?.class==='name-text')?.text;
 if(name!==plan.target.name||!fields.some(n=>normalize(n.text)===normalize(plan.target.company)))throw Error('当前选中的会话与测试目标不一致');
 const before=new Set(state.memories[task.peerId]?.window?.map(m=>m.id)||[]);
 const selfMessages=inspection.selfMessages||[];
 const found=selfMessages.filter(m=>{
  const id=m.node?.attrs?.['data-mid'];
  return id&&!before.has(id)&&selfMessages.filter(other=>other.node?.attrs?.['data-mid']===id).length===1&&matchesReceiptBody(m.text,task.text);
 });
 if(found.length!==1)throw Error('未唯一发现本次发送的新消息');
 const message=found[0];return {messageId:message.node.attrs['data-mid'],observedText:message.text,inspectedAt:inspection.at,evidence:/送达|已读/.test(message.text)?'已核对同一HR会话的新消息编号、完整正文及页面送达/已读标记':'已核对同一HR会话的新消息编号及完整正文'};
}
