import {createHash} from 'node:crypto';
import {annotateMessages} from './message-authorship.mjs';

const pageSize=30, maxLoaded=1000;
const anchorOf=entry=>entry.eventId?`event:${entry.eventId}`:entry.id?`message:${entry.id}`:'';
const validAnchor=value=>typeof value==='string'&&/^(?:event|message):.{1,250}$/s.test(value);
function uniqueAnchorIndex(history,anchor){
  const index=history.findIndex(entry=>anchorOf(entry)===anchor);
  return index>=0&&!history.some((entry,i)=>i>index&&anchorOf(entry)===anchor)?index:-1;
}

function versionFor(c){
  const {jobDetail,resume,sends=[],historyCoverage}=c;
  // Reading the same page updates lastSeenAt, but does not change its content.
  const data=[c.revision,c.historyImportRevision,c.header,c.job?.url,jobDetail?.status,jobDetail?.observedAt,
    c.history?.length,historyCoverage?.complete,resume?.status,resume?.signature,
    resume?.receipts?.at(-1)?.id,resume?.followup?.status,
    sends.length,sends.at(-1)?.taskId,sends.at(-1)?.status,sends.at(-1)?.at];
  return createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,24);
}

export function memorySummaries(memories){
  return Object.fromEntries(Object.entries(memories).map(([id,c])=>[id,{
    peerId:c.peerId||id,header:c.header,domIdentity:{name:c.domIdentity?.name},
    job:{title:c.job?.title,company:c.job?.company,city:c.job?.city},
    historyCount:c.history?.length||0,lastSeenAt:c.lastSeenAt,updatedAt:c.updatedAt,
    version:versionFor(c),
  }]));
}

export function memoryConversation(c,before,{from,through,rangeRevision}={}){
  const history=c.history||[];
  if(before!==null&&before!==undefined&&!/^\d{1,6}$/.test(String(before)))throw Error('历史位置无效');
  const total=history.length;
  const end=before===null||before===undefined?total:Math.min(total,Number(before));
  const latestOffset=Math.max(0,total-pageSize),currentRangeRevision=String(c.historyImportRevision||0);
  let offset=Math.max(0,end-pageSize),rangeReplaced=false;
  if(from!=null){
    if(before!=null||(from!=='~all'&&!validAnchor(from))||(through&&!validAnchor(through)))throw Error('历史消息锚点无效');
    const earliest=Math.max(0,total-maxLoaded);
    const start=from==='~all'?earliest:uniqueAnchorIndex(history,from);
    const previousTail=through?uniqueAnchorIndex(history,through):-1;
    if(start<earliest||rangeRevision!==currentRangeRevision||previousTail<Math.max(start,latestOffset)){
      rangeReplaced=true;
      if(start>=earliest)offset=start;
    }
  }
  const messages=history.slice(offset,end).map(({id,eventId,role,text,time,observedAt})=>({id,eventId,role,text,time,observedAt}));
  return {peerId:c.peerId,header:c.header,job:c.job,jobDetail:c.jobDetail,
    stableMessageIds:c.stableMessageIds,historyCoverage:c.historyCoverage,resume:c.resume,
    history:annotateMessages(c,messages),sends:(c.sends||[]).slice(-10),total,offset,latestOffset,
    rangeRevision:currentRangeRevision,...(rangeReplaced?{rangeReplaced:true}:{}),version:versionFor(c)};
}
