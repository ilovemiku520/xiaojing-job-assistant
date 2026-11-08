// All BOSS-shaped URLs are intercepted fixtures in an isolated Edge process.
// No real account, recruiter, browser profile, or website request is used.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const source=readFileSync(new URL('../extension/favorites.js',import.meta.url),'utf8'),browser=await chromium.launch({headless:true,channel:'msedge'}),summary=[];
try{
 for(const scenario of ['per-job-interest','actual-anchor-search','confirmed-list','sidebar-heading-search','known-url-search','unique-button','my-menu','avatar-hover','div-short-collection','ambiguous-controls','external-anchor','empty-list']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><body></body>'}));
  const url=scenario==='avatar-hover'?'https://www.zhipin.com/job_detail/fixture-interest.html':'https://www.zhipin.com/web/geek/'+(scenario==='confirmed-list'||scenario==='empty-list'?'fixture-saved':'job');await page.goto(url);
  await page.evaluate(scenario=>{
   const card='<div class="job-card-wrapper"><a class="job-name" href="/job_detail/fixture-favorite.html">游戏策划实习生</a><a class="btn-interest" href="javascript:;">感兴趣</a></div>';
   document.body.innerHTML=(scenario==='per-job-interest'?'<div class="job-banner"><a class="btn-interest" href="javascript:;">感兴趣</a></div>':'')+card;
   window.fixture={navClicks:0,myClicks:0,avatarHovers:0,avatarClicks:0,interestClicks:0,settingsClicks:0};
   document.querySelectorAll('.btn-interest').forEach(e=>e.onclick=()=>fixture.interestClicks++);
   if(['actual-anchor-search','confirmed-list','sidebar-heading-search','empty-list'].includes(scenario)){
    document.body.insertAdjacentHTML('afterbegin','<nav><a '+(['confirmed-list','empty-list'].includes(scenario)?'aria-current="page"':'')+' href="/web/geek/fixture-saved"><span>我的收藏</span></a></nav>');
    if(scenario!=='actual-anchor-search')document.body.insertAdjacentHTML('afterbegin','<h1>我的收藏</h1>');
   }
   if(scenario==='known-url-search')document.body.insertAdjacentHTML('afterbegin','<h1>全部岗位</h1>');
   if(scenario==='empty-list'){document.querySelector('.job-card-wrapper').remove();document.body.insertAdjacentHTML('beforeend','<p>还没有收藏的职位</p>');}
   const openCollection=button=>{fixture.navClicks++;history.pushState({},'', '/web/geek/fixture-button-saved');button.setAttribute('aria-selected','true');document.body.insertAdjacentHTML('afterbegin','<h1>收藏职位</h1>');};
   if(scenario==='unique-button'||scenario==='ambiguous-controls'){
    document.body.insertAdjacentHTML('afterbegin','<nav><button id="favorite"><span>收藏职位</span></button>'+ (scenario==='ambiguous-controls'?'<button>我的收藏</button>':'')+'</nav>');document.querySelector('#favorite').onclick=e=>openCollection(e.currentTarget);
   }
   if(scenario==='my-menu'){
    document.body.insertAdjacentHTML('afterbegin','<header><button id="my">我的</button></header>');document.querySelector('#my').onclick=()=>{fixture.myClicks++;document.body.insertAdjacentHTML('beforeend','<div role="menu"><button id="favorite">收藏的职位</button></div>');document.querySelector('#favorite').onclick=e=>openCollection(e.currentTarget);};
   }
   if(scenario==='avatar-hover'){
    document.body.insertAdjacentHTML('afterbegin','<div class="header-v2"><div class="nav"></div><div class="user-nav"><li class="nav-figure"><a id="avatar" href="https://www.zhipin.com/web/geek/recommend"><span class="label-text">测试昵称</span><img alt="头像"></a></li></div></div>');
    document.querySelector('#avatar').onclick=e=>{e.preventDefault();fixture.avatarClicks++;};
    document.querySelector('.nav-figure').onmouseenter=()=>{fixture.avatarHovers++;document.querySelector('.user-nav').insertAdjacentHTML('beforeend','<div class="header-nav-group"><a href="/web/geek/fixture-avatar-saved"><span>收藏</span></a><a id="privacy" href="/web/geek/fixture-privacy">隐私设置</a></div>');document.querySelector('#privacy').onclick=e=>{e.preventDefault();fixture.settingsClicks++;};};
   }
   if(scenario==='div-short-collection')document.body.insertAdjacentHTML('afterbegin','<div class="header-v2"><div class="nav"><a href="/web/geek/fixture-div-saved"><span>感兴趣</span></a></div></div>');
   if(scenario==='external-anchor'){document.body.insertAdjacentHTML('afterbegin','<nav><a id="bad" href="https://external.invalid/collection">我的收藏</a></nav>');document.querySelector('#bad').onclick=e=>{e.preventDefault();fixture.navClicks++;};}
  },scenario);
  await page.addScriptTag({content:source});
  const result=await page.evaluate(async scenario=>{
   const options={root:document,url:location.href,knownCollectionURL:scenario==='known-url-search'?location.href:'',parseCard:node=>({url:node.querySelector('a').href,title:node.querySelector('a').textContent}),allowNavigate:true};
   const value=await BossFavorites.scan(options);return {...value,fixture};
  },scenario);
  assert.deepEqual(errors,[]);
  assert.equal(result.fixture.interestClicks,0);assert.equal(result.fixture.avatarClicks,0);assert.equal(result.fixture.settingsClicks,0);
  if(['per-job-interest','sidebar-heading-search','known-url-search','ambiguous-controls','external-anchor'].includes(scenario)){assert.equal(result.confirmedList,false,scenario);assert.equal(result.jobs.length,0);assert.equal(result.fixture.navClicks,0);}
  if(scenario==='actual-anchor-search'){assert.equal(result.navigation.url,'https://www.zhipin.com/web/geek/fixture-saved');assert.equal(result.confirmedList,false);assert.equal(result.jobs.length,0);}
  if(['confirmed-list','unique-button','my-menu'].includes(scenario)){assert.equal(result.confirmedList,true);assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].source,'favorite');assert.equal(result.jobs[0].sourceURL,result.url);}
  if(['unique-button','my-menu'].includes(scenario)){assert.equal(result.fixture.navClicks,1);assert.equal(result.navigation.method,'visible_control');assert.equal(result.navigation.url,'https://www.zhipin.com/web/geek/fixture-button-saved');}
  if(scenario==='my-menu')assert.equal(result.fixture.myClicks,1);
  if(scenario==='avatar-hover'){assert.equal(result.fixture.avatarHovers,1);assert.equal(result.navigation.url,'https://www.zhipin.com/web/geek/fixture-avatar-saved');assert.equal(result.confirmedList,false);assert.equal(result.jobs.length,0);assert.equal(result.navigation.method,'visible_anchor');}
  if(scenario==='div-short-collection'){assert.equal(result.navigation.url,'https://www.zhipin.com/web/geek/fixture-div-saved');assert.equal(result.confirmedList,false);assert.equal(result.jobs.length,0);}
  if(scenario==='empty-list'){assert.equal(result.confirmedList,true);assert.equal(result.empty,true);assert.equal(result.jobs.length,0);}
  summary.push({scenario,confirmedList:result.confirmedList,jobs:result.jobs.length,navigationClicks:result.fixture.navClicks});await page.close();
 }
 const ownerURL='https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4';
 for(const scenario of ['owner-confirmed-no-heading','owner-wrong-params','owner-fallback-link','owner-iframe-source','owner-chat-iframe','owner-chat-card','owner-empty','owner-no-data']){
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8"><body></body>'}));
  await page.goto(scenario==='owner-wrong-params'?ownerURL.replace('tab=4','tab=3'):ownerURL);
  await page.evaluate(async scenario=>{
   const card='<div class="job-card-wrapper"><a class="job-name" href="https://www.zhipin.com/job_detail/fixture-owned.html?securityId=not-persisted">游戏策划实习生</a></div>';
   document.body.innerHTML=card;
   if(scenario==='owner-fallback-link')document.body.innerHTML='<article class="actual-card-from-site"><a href="https://www.zhipin.com/job_detail/fixture-owned.html?securityId=not-persisted">查看职位</a></article>';
   if(scenario==='owner-chat-card')document.body.innerHTML='<div class="chat-conversation">'+card+'</div>';
   if(scenario==='owner-empty')document.body.innerHTML='<p>暂无感兴趣的职位</p>';
   if(scenario==='owner-no-data'){document.body.innerHTML='<p>页面正在加载</p><nav><button>我的收藏</button></nav>';window.ownerNavigationClicks=0;document.querySelector('button').onclick=()=>ownerNavigationClicks++;}
   if(scenario==='owner-iframe-source'){
    document.body.innerHTML='<iframe title="收藏内容"></iframe>';const iframe=document.querySelector('iframe');iframe.contentDocument.body.innerHTML=card;
   }
   if(scenario==='owner-chat-iframe'){
    document.body.innerHTML='<iframe title="聊天内容" src="https://www.zhipin.com/web/geek/chat"></iframe>';const iframe=document.querySelector('iframe');await new Promise(resolve=>iframe.onload=resolve);iframe.contentDocument.body.innerHTML=card;
   }
  },scenario);
  await page.addScriptTag({content:source});
  const result=await page.evaluate(async({scenario,ownerURL})=>{
   const doc=scenario.includes('iframe')?document.querySelector('iframe').contentDocument:document;
   const options={root:doc,url:doc.URL,sourcePageURL:location.href,ownerCollectionURL:ownerURL,parseCard:node=>scenario==='owner-fallback-link'?{}:{url:node.querySelector('a')?.href||'',title:node.querySelector('.job-name')?.textContent||''}};
   const result=scenario==='owner-no-data'?await BossFavorites.scan({...options,allowNavigate:true}):BossFavorites.collect(options);return {...result,ownerNavigationClicks:window.ownerNavigationClicks||0};
  },{scenario,ownerURL});
  assert.deepEqual(errors,[]);
  if(['owner-wrong-params','owner-chat-iframe','owner-chat-card','owner-no-data'].includes(scenario)){assert.equal(result.confirmedList,false,scenario);assert.equal(result.jobs.length,0);}
  else{assert.equal(result.confirmedList,true);assert.equal(result.sourceBasis,'owner_confirmed_url');assert.equal(result.evidence.sourceBasis,'owner_confirmed_url');assert.equal(Object.hasOwn(result.evidence,'heading'),false);}
  if(['owner-confirmed-no-heading','owner-fallback-link','owner-iframe-source'].includes(scenario)){assert.equal(result.jobs.length,1);assert.equal(result.jobs[0].url,'https://www.zhipin.com/job_detail/fixture-owned.html');assert.equal(result.jobs[0].sourceBasis,'owner_confirmed_url');assert.equal(result.jobs[0].sourceURL,ownerURL);}
  if(scenario==='owner-fallback-link'){assert.equal(result.jobs[0].title,undefined);assert.equal(result.jobs[0].company,undefined);assert.equal(result.jobCardCount,0);assert.equal(result.detailLinkCount,1);}
  if(scenario==='owner-empty'){assert.equal(result.empty,true);assert.equal(result.jobs.length,0);}
  if(scenario==='owner-chat-iframe')assert.match(result.reason,/聊天文档/);
  if(scenario==='owner-no-data'){assert.equal(result.ownerSourceMatched,true);assert.equal(result.ownerNavigationClicks,0);assert.match(result.reason,/等待实际岗位卡片/);}
  summary.push({scenario,confirmedList:result.confirmedList,jobs:result.jobs.length,sourceBasis:result.sourceBasis});await page.close();
 }
 console.log(JSON.stringify({cases:summary,actualWebsiteRequests:0,realHRsContacted:0}));
}finally{await browser.close();}
