// Authorship is a projection of trusted local receipts/owner confirmations.
// A BOSS "self" bubble only identifies the account side, never its human author.
import {outgoingText} from './outgoing-dedup.mjs';
const normalizeText=outgoingText;
const messageId=value=>typeof value==='string'||typeof value==='number'?String(value):'';
const legacyReceipt=/^同一会话出现新消息编号 ([a-zA-Z0-9_.:-]{1,250}) 及本次完整正文（忽略时间与送达标签）$/u;

export function authorForMessage(conversation,message){
  if(message?.role==='hr')return {kind:'hr',label:'HR'};
  const id=messageId(message?.id),confirmations=conversation?.authorConfirmations;
  const confirmation=id&&confirmations&&Object.hasOwn(confirmations,id)?confirmations[id]:null;
  if(confirmation?.kind==='owner_confirmed'&&(!confirmation.source||confirmation.source==='authenticated_owner')&&(!Object.hasOwn(confirmation,'text')||normalizeText(confirmation.text)===normalizeText(message?.text)))return {kind:'owner_confirmed',label:'主人（本人确认）',evidence:{source:'authenticated_owner_confirmation',messageId:id,...(Number.isFinite(confirmation.at)?{confirmedAt:confirmation.at}:{})}};
  const text=normalizeText(message?.text);
  if(id&&text&&conversation?.peerId){
    for(const send of conversation.sends||[]){
      if(send?.status!=='sent'||(send.peerId&&send.peerId!==conversation.peerId))continue;
      const receipt=send.receipt;if(receipt?.peerId&&receipt.peerId!==conversation.peerId)continue;
      const receiptId=messageId(receipt?.messageId),directId=messageId(send.messageId),legacyId=String(send.evidence||'').match(legacyReceipt)?.[1]||'';
      const source=receiptId===id?'verified_send_receipt':directId===id?'verified_send_message_id':legacyId===id?'legacy_send_receipt':'';
      if(!source)continue;
      const sentText=normalizeText(send.text||receipt?.observedText);
      if(!sentText||sentText!==text)continue;
      return {kind:'bot_verified',label:'小鲸（有发送回执）',evidence:{source,messageId:id,...(send.taskId?{taskId:String(send.taskId)}:{})}};
    }
  }
  return {kind:'account_self_unknown',label:'站内我方（作者未确认）'};
}

export function annotateMessages(conversation,messages){
  return (Array.isArray(messages)?messages:[]).map(message=>({...message,author:authorForMessage(conversation,message)}));
}
