import {createHash,randomUUID} from 'node:crypto';
import {normalizeMessages} from './memory.mjs';
const same=(a,b)=>String(a||'').replace(/\s+/g,'')===String(b||'').replace(/\s+/g,'');
export function resolveDomConversation(memories,input){
 const name=String(input.name||'').trim(),company=String(input.company||'').trim(),messages=normalizeMessages(input.messages);
 if(!name||name.length>100||!company||company.length>150||input.uniquePeer!==true)throw Error('需要唯一可见的HR及公司');
 if(!messages.length||messages.some(m=>!m.id)||new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('消息编号不足，暂不建立自动回复会话');
 const header=String(input.header||'').replace(/\s/g,''),companyLabel=company.replace(/\s/g,''),companyPrefix=companyLabel.replace(/(?:\.{3}|…+)$/,'');
 if(!header.includes(name.replace(/\s/g,''))||!(header.includes(companyLabel)||(companyPrefix.length>=4&&companyPrefix!==companyLabel&&header.includes(companyPrefix))))throw Error('会话标题与列表目标不一致');
 const ids=new Set(messages.map(m=>m.id));
 const matches=Object.values(memories).filter(c=>{
  const identity=c.domIdentity||c.testTarget;
  return identity&&same(identity.name,name)&&same(identity.company,company)&&(c.history||[]).some(m=>ids.has(m.id));
 });
 if(matches.length>1)throw Error('消息锚点对应多个记录，需要核对后再合并');
 const anchor=messages[0].id,peerId=matches[0]?.peerId||'boss-dom:'+createHash('sha256').update(JSON.stringify({name,company,anchor})).digest('hex').slice(0,40);
 return {peerId,identity:{kind:'visible_label_and_overlapping_message_ids',name,company,anchorMessageId:matches[0]?.domIdentity?.anchorMessageId||anchor,platformPeerIdKnown:false},messages};
}
export function importDomHistory(conversation,input,now=Date.now()){
 const messages=normalizeMessages(input.messages);if(!messages.length||messages.some(m=>!m.id)||new Set(messages.map(m=>m.id)).size!==messages.length)throw Error('历史消息需包含稳定编号');
 const history=conversation.history;let added=0,edited=false;
 for(let i=0;i<messages.length;i++){
  const message=messages[i],known=history.find(m=>m.id===message.id);
  if(known){if(known.text!==message.text||known.role!==message.role){known.previousVersions=[...(known.previousVersions||[]),{text:known.text,role:known.role,at:known.observedAt}].slice(-5);Object.assign(known,message,{observedAt:now});edited=true;}continue;}
  const entry={...message,eventId:randomUUID(),observedAt:now,source:'boss_dom_history'};
  const next=messages.slice(i+1).map(m=>history.findIndex(h=>h.id===m.id)).find(index=>index>=0);
  if(next!==undefined)history.splice(next,0,entry);
  else{const previous=i?history.findIndex(h=>h.id===messages[i-1].id):-1;if(previous>=0)history.splice(previous+1,0,entry);else history.push(entry);}
  added++;
 }
 conversation.history=history.slice(-1000);conversation.historyCoverage={...(conversation.historyCoverage||{}),lastReadAt:now,storedMessages:conversation.history.length,complete:input.reachedStart===true||conversation.historyCoverage?.complete===true,note:'仅记录网页实际加载且带编号的消息；未发现站内历史起点标记时不声称完整'};
 if(added||edited)conversation.historyImportRevision=(conversation.historyImportRevision||0)+1;
 return added;
}
