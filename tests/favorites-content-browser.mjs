// Full content-script integration in a fresh headless Edge profile. Every
// browser request is intercepted; there is no BOSS login or real HR traffic.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');

const ownerURL='https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4',publicJobURL='https://www.zhipin.com/job_detail/fixture-favorite-content.html';
const frameHTML=`<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:20px}.job-card-wrapper{padding:20px;border:1px solid #ccc}</style></head><body>
 <article class="job-card-wrapper"><a class="job-name" href="${publicJobURL}?securityId=fixture-never-persisted">游戏系统策划实习生</a><span class="boss-name">虚构收藏游戏工作室</span><span class="company-location">北京</span><span class="job-salary">200-250元/天</span><ul class="tag-list"><li>在校生</li><li>本科</li></ul><button id="per-job-interest">感兴趣</button></article>
 </body></html>`;
const html=`<!doctype html><html><head><meta charset="utf-8"></head><body>
 <div id="hidden-chat-decoy" style="display:none"><div class="friend-list"><div class="friend-content selected" data-id="not-a-real-peer"><div class="title-box"><span class="name-text">旧HR诱饵</span><span>虚构历史公司</span></div></div></div><div class="chat-conversation"><div class="top-info-content">旧HR诱饵 虚构历史公司</div><div class="message-item item-friend" data-mid="old-message"><span class="text">请发一下简历</span></div><div class="chat-editor"><textarea id="chat-input"></textarea><button id="decoy-send" class="btn-send">发送</button></div></div></div>
 <iframe id="collection-frame" title="实际收藏内容" style="display:block;width:960px;height:460px;border:0"></iframe>
 <script>window.fixtureSends=0;window.fixtureEditorChanges=0;window.fixtureInterestClicks=0;document.querySelector('#decoy-send').onclick=()=>fixtureSends++;document.querySelector('#chat-input').oninput=()=>fixtureEditorChanges++;document.querySelector('#collection-frame').srcdoc=${JSON.stringify(frameHTML)};</script>
 </body></html>`;
const calls=[],messages=[],errors=[],mockErrors=[],requests=[],blockedRequests=[];
const config={running:true,readingEnabled:true,mode:'auto',chatRead:true,chatInput:true,newMessagesOnly:true,historyRead:true,historySweepEnabled:false,favoritesFirst:true,crawlEnabled:true,autoBrowse:true,browserCalibrated:true,watchEpoch:1,selectors:{favoriteCollectionURL:ownerURL},profile:{resumeName:'虚构指定简历.pdf'},ownerChat:null,singleTest:null};
const favoriteState={enabled:true,due:true,status:'queued',requestId:'fixture-favorite-request',lastJobIds:[],navigation:{url:ownerURL,label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job',observedAt:1}};
async function fixtureMessage(message){
 messages.push(structuredClone(message));
 if(message.type==='api'){
  calls.push(structuredClone(message));
  const respond=value=>({ok:true,result:structuredClone(value)});
  if(message.path==='/api/browser-state'||message.path==='/api/heartbeat')return respond({config,favorites:favoriteState,search:null});
  if(message.path==='/api/favorites/state')return respond(favoriteState);
  if(message.path==='/api/favorites/observe'){
   if(message.data?.kind!=='list'){mockErrors.push('Unexpected favorite navigation from confirmed owner URL');return {ok:false,error:'本测试仅允许采集已确认来源'};}
   favoriteState.due=false;favoriteState.status='observed';favoriteState.lastJobIds=['fixture-collected-job'];return respond({ok:true,ids:favoriteState.lastJobIds,status:'observed'});
  }
  if(message.path==='/api/inspection')return respond({ok:true});
  mockErrors.push('Unexpected API: '+message.path);return {ok:false,error:'测试不允许调用 '+message.path};
 }
 if(['worker','crawlWorker','chatJobWorker'].includes(message.type))return {ok:true,result:null};
 if(message.type==='chatMonitor')return {ok:true,result:{monitor:false}};
 mockErrors.push('Unexpected runtime message: '+message.type);return {ok:false,error:'测试不允许此后台动作'};
}

const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const context=await browser.newContext({serviceWorkers:'block'});
 // Catch all traffic, not just zhipin.com, before opening any page.
 await context.route('**/*',async route=>{
  const url=route.request().url();requests.push(url);
  if(url===ownerURL&&route.request().resourceType()==='document')return route.fulfill({contentType:'text/html; charset=utf-8',body:html});
  blockedRequests.push(url);return route.abort('blockedbyclient');
 });
 const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.exposeFunction('fixtureMessage',fixtureMessage);
 await page.addInitScript(()=>{
  const values={};window.fixtureReadListeners=[];
  window.chrome={storage:{local:{get:async keys=>typeof keys==='string'?{[keys]:values[keys]}:Object.fromEntries((Array.isArray(keys)?keys:Object.keys(values)).map(key=>[key,values[key]])),set:async patch=>Object.assign(values,patch)}},runtime:{id:'favorite-content-fixture',sendMessage:message=>window.fixtureMessage(message),onMessage:{addListener:listener=>window.fixtureReadListeners.push(listener)}}};
 });
 await page.goto(ownerURL,{waitUntil:'load'});await page.frameLocator('#collection-frame').locator('.job-card-wrapper').waitFor({state:'visible'});
 await page.evaluate(()=>document.querySelector('#collection-frame').contentDocument.querySelector('#per-job-interest').addEventListener('click',()=>window.fixtureInterestClicks++));
 const shape=await page.evaluate(()=>({topJobCards:document.querySelectorAll('.job-card-wrapper').length,hiddenChat:document.querySelector('#hidden-chat-decoy').getClientRects().length===0,frameURL:document.querySelector('#collection-frame').contentDocument.URL,frameCards:document.querySelector('#collection-frame').contentDocument.querySelectorAll('.job-card-wrapper').length}));
 assert.equal(shape.topJobCards,0);assert.equal(shape.hiddenChat,true);assert.equal(shape.frameURL,'about:srcdoc');assert.equal(shape.frameCards,1);
 // Use the real module order. No methods of BossFavorites or the content
 // adapter are replaced; only the extension's transport is a controlled shim.
 for(const name of ['realtime.js','resume-ui.js','favorites.js','content.js'])await page.addScriptTag({content:readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')});
 const command=async name=>await page.evaluate(name=>new Promise((resolve,reject)=>{
  const listener=window.fixtureReadListeners.at(-1);if(!listener){reject(Error('content listener was not registered'));return;}
  const timeout=setTimeout(()=>reject(Error('assistant-read did not respond')),7000);const keep=listener({type:'assistant-read',command:name,allowNavigate:false},{id:chrome.runtime.id},response=>{clearTimeout(timeout);resolve(response);});if(keep!==true){clearTimeout(timeout);reject(Error('assistant-read did not retain its response channel'));}
 }),name);
 const scanned=await command('favorites-scan');assert.equal(scanned.error,undefined,scanned.error);assert.equal(scanned.confirmedList,true);assert.equal(scanned.jobs,1);assert.equal(scanned.empty,false);
 const observations=calls.filter(call=>call.path==='/api/favorites/observe');assert.equal(observations.length,1);const observed=observations[0].data;assert.equal(observed.kind,'list');assert.equal(observed.url,ownerURL);assert.equal(observed.confirmedList,true);assert.equal(observed.jobs.length,1);
 const job=observed.jobs[0];assert.equal(job.url,publicJobURL);assert.equal(job.title,'游戏系统策划实习生');assert.equal(job.company,'虚构收藏游戏工作室');assert.equal(job.city,'北京');assert.equal(job.salary,'200-250元/天');assert.equal(job.experience,'在校生');assert.equal(job.source,'favorite');assert.equal(job.sourceBasis,'owner_confirmed_url');assert.equal(job.sourceURL,ownerURL);assert(!JSON.stringify(job).includes('securityId'));
 const evidence=JSON.parse(observed.evidence);assert.equal(evidence.sourceBasis,'owner_confirmed_url');assert.equal(evidence.sourcePageURL,ownerURL);assert.equal(evidence.ownerCollectionURL,ownerURL);assert.equal(evidence.visibleCards,1);assert.equal(Object.hasOwn(evidence,'heading'),false);assert.notEqual(evidence.documentURL,ownerURL,'iframe自身URL不能冒充顶层收藏来源');
 // Exercise the normal tick as well: it must traverse the same documents,
 // reuse the observation and never treat hidden chat DOM as a live HR task.
 const ticked=await command('tick');assert.equal(ticked.error,undefined,ticked.error);assert.equal(calls.filter(call=>call.path==='/api/favorites/observe').length,1,'相同真实收藏结果不重复提交');assert(!calls.some(call=>/\/api\/(?:prepare|claim|complete|review|chat\/resolve|chat\/history|owner-chat\/prepare|single-test\/prepare)$/.test(call.path)));assert(!calls.some(call=>call.path==='/api/jobs/observe'),'已确认收藏不退回普通搜索采集');
 assert.deepEqual(await page.evaluate(()=>({sends:fixtureSends,edits:fixtureEditorChanges,interest:fixtureInterestClicks})),{sends:0,edits:0,interest:0});assert.deepEqual(mockErrors,[]);assert.deepEqual(errors,[]);assert(requests.includes(ownerURL));assert.equal(await page.url(),ownerURL);
 console.log(JSON.stringify({sameOriginIframeCards:1,favoritesObserved:1,sourceBasis:'owner_confirmed_url',topSourcePagePreserved:true,fullContentTickPassed:true,hrPrepareCalls:0,hrClaims:0,sends:0,actualWebsiteRequests:0,interceptedRequests:requests.length,blockedRequests:blockedRequests.length}));
 await context.close();
}finally{await browser.close();}
