import {channelRunning} from './channels.mjs';
import {createHash,randomBytes} from 'node:crypto';
import {day} from './core.mjs';
import {favoriteJob,favoriteDiscoveryPending,greetingPreviouslyHandled,jobPriority,potentialGreeting,prioritizedFavorite} from './greetings.mjs';
import {favoritePriorityCutoff} from './favorites.mjs';
import {favoriteSourceURL,jobURL} from './job-match.mjs';
export {jobURL};
const jobFields=['title','company','city','salary','experience','description'];

function mergeObservedFields(job,input,preserve=[]){
  const observed=[];
  for(const field of jobFields){
    const value=String(input?.[field]||'').trim().slice(0,field==='description'?16000:1000);
    if(!value)continue;
    if(!preserve.includes(field)||!job[field])job[field]=value;
    observed.push(field);
  }
  return observed;
}

export function observeJobs(state,items,{source='search',page='',now=Date.now()}={}){
  source=source==='favorite'?'favorite':'search';now=Number.isFinite(Number(now))?Number(now):Date.now();
  let sourcePage='';try{const u=new URL(page);if(u.origin==='https://www.zhipin.com')sourcePage=u.origin+u.pathname;}catch{}
  const collectionPage=source==='favorite'?favoriteSourceURL(page):'';
  state.jobs??={};const ids=[];
  for(const input of (Array.isArray(items)?items:[]).slice(0,50)){
    let url;try{url=jobURL(input.url);}catch{continue;}
    const id=createHash('sha256').update(url).digest('hex').slice(0,24);
    const j=state.jobs[id]??={id,url,status:'listed',firstSeenAt:now,source:'boss_visible_dom'};
    // A card rescan is lower-confidence than completed detail-page fields.
    // Older ready records lack per-field provenance, so retain their values.
    const verified=j.status==='ready'?(Array.isArray(j.detailFields)?j.detailFields:jobFields):[];
    mergeObservedFields(j,input,verified);
    j.sources=[...new Set([...(Array.isArray(j.sources)?j.sources:[]),...(favoriteJob(j)?['favorite']:[]),source])];
    if(source==='favorite'){
      j.favorite=true;j.favoriteObservedAt=now;
      if(sourcePage)j.favoriteSourcePage=collectionPage||favoriteSourceURL(j.favoriteSourcePage)||sourcePage;
    }else if(favoriteJob(j))j.favorite=true;
    j.source=favoriteJob(j)?'favorite':'search';if(sourcePage){j.sourcePage=sourcePage;j.sourcePages=[...new Set([...(j.sourcePages||[]),sourcePage])].slice(-10);}
    j.lastSeenAt=now;ids.push(id);
  }return ids;
}
export function claimJob(state,now=Date.now(),selection){
  if((!channelRunning(state.config,'jobSearch')||state.config.crawlEnabled===false)&&!selection?.authorized)return null;
  for(const j of Object.values(state.jobs||{}))if(j.status==='reading'&&now-j.reservedAt>180000){j.status='needs_adaptation';j.evidence='读取超时，等待页面适配，不反复打开同一岗位';delete j.lease;}
  if(Object.values(state.jobs||{}).some(j=>j.status==='reading'))return null;
  const today=Object.values(state.jobs||{}).filter(j=>j.reservedAt&&day(j.reservedAt)===day(now));
  if(today.length>=(state.config.crawlDailyLimit||30))return null;
  if(now-(state.lastCrawlAt||0)<15000)return null;
  const profile=state.config.profile;
  const waiting=!selection?.jobId&&favoriteDiscoveryPending(state,now),cutoff=selection?.jobId?0:favoritePriorityCutoff(state);
  const job=Object.values(state.jobs||{}).filter(j=>(!selection?.jobId||j.id===selection.jobId)&&j.status==='listed'&&(!waiting||prioritizedFavorite(j,cutoff))&&!greetingPreviouslyHandled(state,j)&&potentialGreeting(j,profile)).sort((a,b)=>jobPriority(state.config,a,b,cutoff))[0];
  if(!job)return null;
  job.status='reading';job.reservedAt=now;state.lastCrawlAt=now;job.lease=randomBytes(24).toString('hex');return job;
}
export function completeJob(state,data){
  const j=state.jobs?.[data.id];if(!j||j.status!=='reading'||j.lease!==data.lease)throw Error('岗位采集凭据无效');
  if(jobURL(data.url)!==j.url)throw Error('详情页与待采集岗位不一致');
  const observed=mergeObservedFields(j,data.job);
  const complete=data.success===true&&observed.includes('description')&&j.description.length>=40;
  if(complete)j.detailFields=observed;else delete j.detailFields;
  j.status=complete?'ready':'needs_adaptation';j.detailObservedAt=Date.now();j.evidence=String(data.evidence||'').slice(0,500);delete j.lease;return j;
}
