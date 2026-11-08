// Synthetic contacts UI and mock extension API: no live site/account/HR traffic.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const scripts=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const configs=[];
async function outcome(f,predicate,message){
 // A mutation-triggered tick may already own the adapter's working lock. The
 // explicit wake then returns immediately; await the UI/API outcome, not that
 // wake's callback. Keep real observers enabled to exercise this interleaving.
 const deadline=Date.now()+8000;
 while(Date.now()<deadline){if(await predicate())return;await f.tick();await f.page.waitForTimeout(25);}
 assert(await predicate(),message);
}
async function fixture({fullGroup=true,selected='unread',pending=true,draft=false,restore=true,duplicate=false,mode='auto'}={}){
 const page=await browser.newPage(),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));
 const config={running:false,readingEnabled:true,mode,autoBrowse:true,chatRead:true,chatInput:true,newMessagesOnly:true,historyRead:true,watchEpoch:1,selectors:{}};configs.push(config);
 const group=(suffix='')=>`<div class="contact-filters" role="tablist"><button id="all${suffix}" class="${selected==='all'?'active':''}">全部</button><button id="unread${suffix}" class="${selected==='unread'?'active':''}">未读<span>1</span></button>${fullGroup?'<button>新招呼</button><button>仅沟通</button>':''}</div>`;
 const html=`<!doctype html><html><meta charset="utf-8"><body><aside class="sidebar">${group()}${duplicate?group('2'):''}<div class="friend-list"></div></aside><main class="chat-conversation"><div class="top-info-content">HRb 虚构游戏b</div><div class="chat-record"><div class="message-item item-friend" data-mid="new-message-b">方便聊聊游戏策划实习吗？</div></div><button id="unrelated-all">全部</button><div class="chat-editor"><div id="chat-input" contenteditable="true">${draft?'主人未完成的草稿':''}</div><button class="btn-send">发送</button></div></main><script>
 window.filterClicks=0;window.unrelatedClicks=0;window.sent=0;
 window.row=()=>{const peer=document.createElement('div');peer.id='b';peer.className='friend-content selected';peer.dataset.id='fixture-b';peer.innerHTML='<div class="title-box"><span class="name-text">HRb</span><span>虚构游戏b</span></div><span class="last-msg-text">方便聊聊游戏策划实习吗？</span><span class="time">${pending?'12:34':'10月01日'}</span>${pending?'<span class="notice-badge">1</span>':''}';peer.onclick=()=>peer.remove();return peer;};
 document.querySelector('.friend-list').append(row());
 for(const all of document.querySelectorAll('.contact-filters button[id^="all"]'))all.onclick=()=>{filterClicks++;if(${restore}){for(const e of document.querySelectorAll('.contact-filters button'))e.classList.remove('active');all.classList.add('active');const peer=row();peer.querySelector('.notice-badge')?.remove();peer.onclick=()=>{};document.querySelector('.friend-list').append(peer);}};
 document.querySelector('#unrelated-all').onclick=()=>unrelatedClicks++;document.querySelector('.btn-send').onclick=()=>sent++;
 </script></body></html>`;
 await page.route('**/*',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.exposeFunction('unreadFixture',async m=>{
  if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};
  if(['worker','crawlWorker','chatJobWorker'].includes(m.type))return {ok:true,result:null};
  if(m.type!=='api')return {ok:true,result:{}};
  calls.push({path:m.path,data:m.data});let result={};
  if(m.path==='/api/heartbeat')result={config};if(m.path==='/api/tasks')result={tasks:[]};if(m.path==='/api/replies/state')result={items:[]};
  if(m.path==='/api/replies/enqueue')result={reply:{id:'skip-fixture',peerId:m.data.peerId,...m.data.label,status:'skip',reason:'synthetic no-send result'}};
  return {ok:true,result};
 });
 await page.addInitScript(pending=>{
  const now=Date.now;window.offset=0;Date.now=()=>now()+window.offset;window.fixtureValues={};
  // Start from an event already recorded before the owner switched filters.
  // The initial HR channel is paused, so it cannot discover this itself.
  if(pending)fixtureValues['boss-realtime-v1']={version:1,threads:[],events:[['HRb\u001f虚构游戏b',{kind:'message',source:'sidebar',preview:'方便聊聊游戏策划实习吗？',time:'12:34',at:now()}]]};
  window.chrome={storage:{local:{get:async key=>({[key]:fixtureValues[key]}),set:async patch=>Object.assign(fixtureValues,patch)}},runtime:{id:'unread-fixture',sendMessage:m=>window.unreadFixture(m),onMessage:{addListener:fn=>window.extensionWake=fn}}};
  const interval=window.setInterval;window.setInterval=(fn,ms,...args)=>[1500,6000].includes(ms)?0:interval(fn,ms,...args);
 },pending);
 await page.goto('https://www.zhipin.com/web/geek/chat');await page.addScriptTag({content:scripts});
 const tick=()=>page.evaluate(()=>new Promise(resolve=>window.extensionWake({type:'assistant-read',command:'tick'},{id:'unread-fixture'},resolve)));
 await tick();await page.locator('#b').click();assert.equal(await page.locator('.friend-content.selected').count(),0);config.running=true;
 const advance=ms=>page.evaluate(ms=>window.offset+=ms,ms);
 return {page,config,calls,errors,tick,advance,async close(){assert.equal(await page.evaluate(()=>unrelatedClicks),0);assert.equal(await page.evaluate(()=>sent),0);assert(!calls.some(c=>c.path==='/api/claim'));assert.deepEqual(errors,[]);await page.close();}};
}
try{
 const success=await fixture();
 await success.tick();assert.equal(await success.page.evaluate(()=>filterClicks),0,'recent real user click is protected for 60 seconds');
 await success.advance(61000);await success.tick();await outcome(success,()=>success.page.evaluate(()=>filterClicks>0),'pending message must restore the contact filter');assert.equal(await success.page.evaluate(()=>filterClicks),1);
 await success.advance(2500);await success.tick();
 await outcome(success,()=>success.calls.some(c=>c.path==='/api/replies/enqueue'),'restored pending conversation must reach reply preparation');
 const prepared=success.calls.filter(c=>c.path==='/api/replies/enqueue');assert.equal(prepared.length,1);assert.equal(prepared[0].data.peerId,'boss:fixture-b');assert.equal(prepared[0].data.messages.at(-1).id,'new-message-b');
 await outcome(success,()=>success.page.evaluate(()=>fixtureValues['boss-realtime-v1'].events.length===0),'skip result must acknowledge the original pending event');
 assert.equal(await success.page.evaluate(()=>fixtureValues['boss-realtime-v1'].events.length),0,'original pending event is consumed only after the fixture result');await success.close();

 const review=await fixture({mode:'review'});await review.advance(61000);
 await outcome(review,()=>review.calls.some(c=>c.path==='/api/replies/enqueue'),'review mode should restore and read the hidden unread contact');
 assert.equal(await review.page.evaluate(()=>filterClicks),1);await review.close();

 for(const options of [{fullGroup:false},{selected:'all'},{pending:false},{duplicate:true}]){
  const negative=await fixture(options);await negative.advance(61000);await negative.tick();await negative.advance(3000);await negative.tick();assert.equal(await negative.page.evaluate(()=>filterClicks),0,JSON.stringify(options));assert.equal(negative.calls.filter(c=>c.path==='/api/replies/enqueue').length,0);await negative.close();
 }
 const drafting=await fixture({draft:true});await drafting.advance(61000);await drafting.tick();assert.equal(await drafting.page.evaluate(()=>filterClicks),0,'drafts prevent filter recovery');
 await drafting.page.evaluate(()=>document.querySelector('#chat-input').textContent='');await drafting.tick();await outcome(drafting,()=>drafting.page.evaluate(()=>filterClicks>0),'recovery remains available after the draft is cleared');assert.equal(await drafting.page.evaluate(()=>filterClicks),1);await drafting.close();

 const stalled=await fixture({restore:false});await stalled.advance(61000);await outcome(stalled,()=>stalled.page.evaluate(()=>filterClicks>0),'the stalled UI should receive one recovery attempt');for(let i=0;i<5;i++){await stalled.tick();await stalled.advance(3000);}
 assert.equal(await stalled.page.evaluate(()=>filterClicks),1,'same pending event gets only one recovery attempt');
 assert.equal(await stalled.page.evaluate(()=>fixtureValues['boss-realtime-v1'].events.length),1,'missing row does not lose or acknowledge the pending event');assert.equal(stalled.calls.filter(c=>c.path==='/api/replies/enqueue').length,0);await stalled.close();
 console.log(JSON.stringify({rowDisappearancePreservesPending:true,strictContactFilterRecovery:true,reviewFilterRecovery:true,recentUserAndDraftProtected:true,ambiguousFiltersRejected:true,recoveryClicksPerEvent:1,realHRsContacted:0}));
}finally{await browser.close();}
