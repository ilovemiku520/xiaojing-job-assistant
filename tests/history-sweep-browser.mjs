// Full content adapter, synthetic HTML and a local mock API only. No account,
// real BOSS request, recruiter message, model call, or live browser session.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const config={running:true,readingEnabled:true,watchEpoch:1,mode:'auto',autoBrowse:true,chatRead:true,chatInput:true,newMessagesOnly:true,historyRead:true,selectors:{}};
const calls=[],history=[],preparations=[],ownerReads=[];
const settle=async(predicate,message)=>{for(let i=0;i<80&&!await predicate();i++)await new Promise(r=>setTimeout(r,100));assert(await predicate(),message);};
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=`<!doctype html><html><head><meta charset="utf-8"><style>.chat-record{height:150px;overflow-y:auto}.message-item{min-height:20px}</style></head><body>
 <div class="friend-list">${['a','b','c'].map((id,i)=>`<div id="${id}" data-id="fixture-${id}" class="friend-content ${i===0?'selected':''}"><div class="title-box"><span class="name-text">HR${id}</span><span>虚构游戏${id}</span></div><span class="time">10月01日</span><span class="last-msg-text">过往消息${id}</span></div>`).join('')}</div>
 <div class="chat-conversation"><div class="top-info-content"></div><div class="chat-record"></div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send">发送</button></div></div>
 <script>
 window.peerClicks=[];window.scrollEvents=[];window.sent=0;
 window.byPeer=Object.fromEntries(['a','b','c'].map(id=>[id,Array.from({length:100},(_,i)=>({id:id+'-'+i,text:'过往历史'+id+i}))]));
 window.render=()=>{const id=document.querySelector('.friend-content.selected').id;document.querySelector('.top-info-content').textContent='HR'+id+' 虚构游戏'+id;const record=document.querySelector('.chat-record');record.replaceChildren();for(const m of byPeer[id]){const el=document.createElement('div');el.className='message-item item-friend';el.dataset.mid=m.id;el.textContent=m.text;record.append(el);}record.scrollTop=record.scrollHeight;};
 for(const peer of document.querySelectorAll('.friend-content'))peer.onclick=()=>{peerClicks.push(peer.id);for(const item of document.querySelectorAll('.friend-content'))item.classList.remove('selected');peer.classList.add('selected');render();};
 document.querySelector('.chat-record').addEventListener('scroll',()=>scrollEvents.push(document.querySelector('.friend-content.selected').id));document.querySelector('button').onclick=()=>sent++;render();
 window.injectIncoming=()=>{byPeer.b.push({id:'b-new-hr',text:'你好，想了解下这个实习方向吗？'});document.querySelector('#b .last-msg-text').textContent='你好，想了解下这个实习方向吗？';document.querySelector('#b .time').textContent='12:34';const badge=document.createElement('span');badge.className='notice-badge';badge.textContent='1';document.querySelector('#b').append(badge);};
 </script></body></html>`;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.exposeFunction('historyFixture',async m=>{
  if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};
  if(['worker','crawlWorker','chatJobWorker'].includes(m.type))return {ok:true,result:null};
  if(m.type!=='api')return {ok:true,result:{}};
  calls.push({path:m.path,data:m.data});let result={};
  if(m.path==='/api/heartbeat')result={config};
  if(m.path==='/api/tasks')result={tasks:[]};if(m.path==='/api/replies/state')result={items:[]};
  if(m.path==='/api/chat/history')history.push(m.data);
  if(m.path==='/api/chat/job/start')result={cached:true};
  if(m.path==='/api/replies/enqueue'){preparations.push(m.data);result={reply:{id:'skip-fixture',peerId:m.data.peerId,...m.data.label,status:'skip',reason:'synthetic fixture acknowledgement'}};}
  if(m.path==='/api/owner-chat/prepare'){ownerReads.push(m.data);config.ownerChat=null;result={task:null};}
  return {ok:true,result};
 });
 await page.addInitScript(()=>{
  window.clockOffset=0;const actualNow=Date.now;Date.now=()=>actualNow()+window.clockOffset;
  const values={};window.chrome={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}},runtime:{id:'history-fixture',sendMessage:m=>window.historyFixture(m),onMessage:{addListener:fn=>window.extensionWake=fn}}};
  const nativeInterval=window.setInterval;window.setInterval=(fn,ms,...args)=>[1500,6000].includes(ms)?0:nativeInterval(fn,ms,...args);
 });
 await page.goto('https://www.zhipin.com/web/geek/chat');
 await page.addScriptTag({content:['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n')});
 const tick=async()=>{await page.evaluate(()=>{window.clockOffset+=25000;});await page.evaluate(()=>new Promise(resolve=>window.extensionWake({type:'assistant-read',command:'tick'},{id:'history-fixture'},resolve)));};
 await page.waitForTimeout(2200);await settle(()=>calls.some(c=>c.path==='/api/tasks'),'content adapter should be ready');
 const initialScrolls=await page.evaluate(()=>scrollEvents.length);
 for(let i=0;i<5;i++)await tick();
 assert.equal(history.length,0,'historyRead permission alone must not scroll/import full histories');
 assert.equal(await page.locator('.friend-content.selected').getAttribute('id'),'a');
 assert.deepEqual(await page.evaluate(()=>peerClicks),[],'idle ticks must not tour the sidebar');
 assert.equal(await page.evaluate(()=>scrollEvents.length),initialScrolls);assert.equal(preparations.length,0);

 // A real sidebar/DOM change is still observed without a manual wake. The
 // incoming conversation gets context from its visible window and cached state.
 await page.evaluate(()=>window.injectIncoming());
 await settle(()=>preparations.length===1,'new HR message must still wake and prepare a reply');
 assert.equal(preparations[0].peerId,'boss:fixture-b');assert.equal(preparations[0].trigger,'new_hr_message');
 assert.equal(preparations[0].messages.at(-1).id,'b-new-hr');assert.equal(history.length,0,'new incoming reply must not await a whole-history sweep');
 assert.equal(await page.locator('.friend-content.selected').getAttribute('id'),'b');

 config.historySweepEnabled=true;await tick();
 assert(history.some(h=>h.peerId==='boss:fixture-b'),'explicit sweep may import current history');
 assert.equal(await page.locator('.friend-content.selected').getAttribute('id'),'c','explicit sweep may select another unvisited history');
 await tick();assert(history.some(h=>h.peerId==='boss:fixture-c'));

 // Turning the sweep off does not revoke the explicit owner read operation.
 config.historySweepEnabled=false;
 config.ownerChat={planId:'owner-read',targetId:'target-a',kind:'read',name:'HRa',company:'虚构游戏a'};
 await tick();await tick();
 assert.equal(ownerReads.length,1);assert.equal(ownerReads[0].peerId,'boss:fixture-a');assert.equal(ownerReads[0].kind,'read');
 assert.equal(new Set(history.filter(h=>h.peerId==='boss:fixture-a').flatMap(h=>h.messages.map(m=>m.id))).size,100);
 const historyAfterOwner=history.length;await tick();await tick();assert.equal(history.length,historyAfterOwner,'disabled sweep stays idle after explicit read completes');
 assert.equal(preparations.length,1);assert.equal(await page.evaluate(()=>sent),0);assert(!calls.some(c=>c.path==='/api/claim'));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({defaultHistoryTour:false,idleScrolls:0,newHRWakePreserved:true,explicitHistorySweep:true,ownerReadPreserved:true,realHRsContacted:0}));
}finally{await browser.close();}
