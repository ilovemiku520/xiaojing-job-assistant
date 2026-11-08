import {channelRunning} from './channels.mjs';
import {randomUUID} from 'node:crypto';
const successDelay=15*60000,failureDelay=5*60000;
const collectionLabel=/^(?:我的收藏(?:职位|岗位)?|我收藏的(?:职位|岗位)|收藏的(?:职位|岗位)|收藏(?:职位|岗位)?|职位收藏|岗位收藏|感兴趣(?:的职位)?|收藏夹)(?:\s*[（(]?\d+[）)]?)?$/;
export function bossPage(value){const u=new URL(String(value));if(u.origin!=='https://www.zhipin.com'||!u.pathname.startsWith('/web/geek/'))throw Error('收藏入口必须是实际观察到的BOSS求职页面');u.hash='';return u.href;}
function pageScope(value,firstPage=false){
 try{
  const url=new URL(bossPage(value)),pages=url.searchParams.getAll('page');
  if(url.username||url.password||/^\/web\/geek\/chat\/?$/.test(url.pathname)||firstPage&&(pages.length>1||pages.some(page=>page!=='1')))return '';
  url.searchParams.delete('page');url.searchParams.sort();return url.href;
 }catch{return '';}
}
const collectionScope=state=>pageScope(state.config.selectors?.favoriteCollectionURL||state.favorites?.navigation?.url);
export function favoritePriorityCutoff(state){
 const empty=state.favorites?.confirmedEmpty;
 return Number.isSafeInteger(empty?.at)&&empty.at>0&&empty.scope&&empty.scope===collectionScope(state)?empty.at:0;
}
function verifiedEmptyScope(state,page,data){
 const scope=collectionScope(state);
 if(!scope||pageScope(page,true)!==scope||data.confirmedList!==true||data.empty!==true)return '';
 let evidence;
 try{evidence=JSON.parse(data.evidence);}catch{return '';}
 if(evidence?.sourceBasis==='visible_page_evidence'&&[evidence.heading,evidence.selectedLabel].some(label=>typeof label==='string'&&collectionLabel.test(label)))return scope;
 if(evidence?.sourceBasis==='owner_confirmed_url'&&evidence.explicitEmpty===true&&evidence.visibleCards===0&&
   [evidence.ownerCollectionURL,evidence.sourcePageURL,evidence.documentURL].every(url=>pageScope(url,true)===scope))return scope;
 return '';
}
export function favoritesState(state,now=Date.now()){
 const f=state.favorites??={status:'queued',requestedAt:now,nextScanAt:0,lastScanAt:0,lastJobIds:[]};
 const enabled=state.config.favoritesFirst!==false;f.enabled=enabled;
 if(!enabled||!channelRunning(state.config,'jobSearch'))return {...f,enabled,due:false};
 if(['queued','discovering'].includes(f.status)&&now-(f.requestedAt||now)>60000){f.status='unavailable';f.reason='本轮未识别到收藏页面，继续搜索其他岗位，稍后再查收藏入口';f.nextScanAt=now+failureDelay;}
 const due=channelRunning(state.config,'jobSearch')&&now>=(f.nextScanAt||0);
 if(due&&!['queued','discovering'].includes(f.status)){f.status='queued';f.requestedAt=now;f.requestId=randomUUID();}
 if(due&&!f.requestId){f.requestId=randomUUID();f.requestedAt=now;}
 return {...f,due:!!due};
}
export function observeFavorites(state,data,observeJobs,now=Date.now()){
 const f=state.favorites??={status:'queued',lastJobIds:[]};
 if(data.kind==='navigation'){
  const n=data.navigation||{},url=bossPage(n.url),sourcePage=bossPage(n.sourcePage||data.pageURL);
  if(!collectionLabel.test(String(n.label||'')))throw Error('未提供明确收藏导航标题');
  f.navigation={url,label:String(n.label).slice(0,100),sourcePage,observedAt:now};f.status='discovering';f.requestedAt=now;f.nextScanAt=now;return {ok:true,navigation:f.navigation};
 }
 if(data.kind!=='list'||data.confirmedList===false||!String(data.evidence||'').trim())throw Error('收藏列表需要实际页面识别证据');
 const page=bossPage(data.url||data.pageURL),jobs=Array.isArray(data.jobs)?data.jobs:[];
 if(!jobs.length&&data.empty!==true)throw Error('未读取岗位也没有明确的收藏空列表提示');
 const ids=observeJobs(state,jobs,{source:'favorite',page,now});
 if(jobs.length&&!ids.length)throw Error('收藏岗位链接无效，未确认收藏为空');
 const emptyScope=!jobs.length&&verifiedEmptyScope(state,page,data);
 if(emptyScope)f.confirmedEmpty={scope:emptyScope,at:now};
 f.status=ids.length?'observed':'empty';f.lastScanAt=now;f.nextScanAt=now+successDelay;f.lastJobIds=[...new Set(ids)];f.lastPage=page;f.evidence=String(data.evidence).slice(0,500);
 f.reason=ids.length?`已读取${ids.length}个收藏岗位，优先进入岗位队列`:emptyScope?'已确认收藏首页为空，历史收藏保留来源并按普通岗位排序':'当前页面明确显示暂无收藏岗位，继续搜索';
 return {ok:true,ids,status:f.status};
}
export function failFavorites(state,data,now=Date.now()){
 const f=state.favorites??={lastJobIds:[]};f.status='unavailable';f.reason=String(data.reason||'未找到明确的收藏列表入口').slice(0,500);f.phase=String(data.phase||'discovery').slice(0,80);f.nextScanAt=now+failureDelay;f.failedAt=now;return {ok:true,status:f.status,reason:f.reason};
}
