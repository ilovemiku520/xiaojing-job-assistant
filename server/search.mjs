import {channelRunning} from './channels.mjs';
import {randomUUID} from 'node:crypto';

// City codes from the visible 游戏策划 links on the official city homepages,
// such as https://www.zhipin.com/shanghai/ and https://www.zhipin.com/chengdu/.
const cities={
 北京:'101010100',深圳:'101280600',广州:'101280100',杭州:'101210100',
 上海:'101020100',成都:'101270100',武汉:'101200100',南京:'101190100',
 西安:'101110100',苏州:'101190400',重庆:'101040100',天津:'101030100',
 长沙:'101250100',合肥:'101220100',青岛:'101120200',厦门:'101230200',
 宁波:'101210400',福州:'101230100',郑州:'101180100',东莞:'101281600',
 佛山:'101280800',济南:'101120100',昆明:'101290100',南昌:'101240100',石家庄:'101090100',
};
const stageWords={internship:'实习',campus:'校招',general:''};
const origin='https://www.zhipin.com';

export function searchCityCoverage(profile){
 const configured=[...new Set(Array.isArray(profile?.cities)?profile.cities:[])];
 return {supported:configured.filter(city=>Object.hasOwn(cities,city)),unsupported:configured.filter(city=>!Object.hasOwn(cities,city))};
}

function searchEvidence(value){
 try{
  const url=new URL(value);
  if(url.origin!==origin||url.username||url.password||!/^\/web\/geek\/jobs?$/.test(url.pathname))return null;
  const query=url.searchParams.getAll('query'),city=url.searchParams.getAll('city');
  if(query.length!==1||!query[0]||city.length!==1||!/^\d{9}$/.test(city[0]))return null;
  return {query:query[0],city:city[0]};
 }catch{return null;}
}

export function requestSearch(state,input,now=Date.now()){
 const profile=state.config.profile,{supported,unsupported}=searchCityCoverage(profile);
 const query=String(input.query||profile.titles?.[0]||'').trim(),city=String(input.city||supported[0]||unsupported[0]||''),stage=input.stage||'internship',requestId=String(input.requestId||'').slice(0,150);
 if(!query||query.length>80||!profile.cities.includes(city)||!Object.hasOwn(stageWords,stage))throw Error('搜索需要属于当前求职偏好的城市、1—80字关键词及有效招聘类型');
 if(!Object.hasOwn(cities,city))throw Error('已保存的城市“'+city+'”尚未核对 BOSS 自动搜索入口');
 state.searches??=[];const prior=requestId&&state.searches.find(s=>s.requestId===requestId);if(prior){if(prior.query!==query||prior.city!==city||prior.stage!==stage)throw Error('搜索编号已用于另一组条件');return prior;}
 if(state.searches.some(s=>['queued','opening'].includes(s.status)&&now-s.at<180000))throw Error('已有搜索正在打开，先查看其结果');
 const u=new URL('/web/geek/job',origin);u.searchParams.set('query',[query,stageWords[stage]].filter(Boolean).join(' '));u.searchParams.set('city',cities[city]);
 const search={id:randomUUID(),requestId,query,city,stage,url:u.href,status:'queued',at:now};state.searches.push(search);state.searches=state.searches.slice(-30);return search;
}
export function observeSearch(state,data,now=Date.now()){
 const search=state.searches?.find(s=>s.id===data.id);if(!search||!['queued','opening'].includes(search.status))return {ignored:true};
 const requested=searchEvidence(search.url),observed=searchEvidence(data.url);
 if(!requested||!observed||observed.query!==requested.query||observed.city!==requested.city)throw Error('搜索结果页与请求条件不一致');
 search.status=data.blocked?'blocked':Number(data.cards)>0?'observed':data.empty===true?'empty':'needs_adaptation';search.cards=Math.max(0,Math.min(50,Number(data.cards)||0));search.observedAt=now;search.reason=search.status==='observed'?'已读取真实岗位卡片；是否适合仍以JD核对':search.status==='blocked'?'页面需要登录或验证':search.status==='empty'?'页面明确显示暂无岗位':'页面已打开，尚未识别岗位列表或空结果';return {search};
}
export function ensureAutonomousSearch(state,now=Date.now()){
 if(!channelRunning(state.config,'jobSearch')||state.config.autoSearchEnabled!==true||!state.config.autoBrowse||!state.config.crawlEnabled)return null;
 const hour=new Date(now+8*3600000).getUTCHours(),limits=state.config.limits;
 if(limits&&(hour<limits.hoursStart||hour>=limits.hoursEnd))return null;
 if(state.searches?.some(s=>['queued','opening'].includes(s.status)&&now-s.at<180000))return null;
 const f=state.favorites;if(state.config.favoritesFirst!==false&&f?.enabled&&['queued','discovering'].includes(f.status)&&now-(f.requestedAt||now)<45000)return null;
 const profile=state.config.profile,{supported}=searchCityCoverage(profile),titles=profile.titles.filter(Boolean);
 if(!supported.length||!titles.length)return null;
 const broad=!profile.earlyCareerOnly&&(['max','any'].includes(profile.experiencePolicy)||profile.excludeSenior===false);
 const stages=broad?['general','internship','campus']:['internship','campus'];
 const combinations=supported.flatMap(city=>titles.flatMap(query=>stages.map(stage=>({city,query,stage}))));
 const signature=JSON.stringify(combinations);let d=state.jobDiscovery;
 if(!d||d.signature!==signature)d=state.jobDiscovery={signature,cursor:0,lastRequestedAt:0,status:'ready'};
 if(now-(d.lastRequestedAt||0)<180000)return null;
 const slot=combinations[d.cursor%combinations.length];
 const search=requestSearch(state,{...slot,requestId:'autonomous-search:'+signature.length+':'+now},now);search.source='autonomous_rotation';
 d.cursor=(d.cursor+1)%combinations.length;d.lastRequestedAt=now;d.status='searching';d.currentSearchId=search.id;d.lastCriteria=slot;d.reason='收藏之外，按当前城市、岗位与招聘类型自动寻找新岗位';return search;
}
