// Production adapter on intercepted synthetic pages only; no live HR/model/site traffic.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const config={running:false,jobSearchRunning:false,hrInboxRunning:false,readingEnabled:false,watchEpoch:1,mode:'auto',autoBrowse:true,chatRead:true,chatInput:true,newMessagesOnly:true,historyRead:false,historySweepEnabled:false,favoritesFirst:false,crawlEnabled:true,selectors:{}};
const calls=[],rows=[],tasks=[],sent=[];let chat,jobs;
const flags=(job,hr)=>Object.assign(config,{running:job||hr,jobSearchRunning:job,hrInboxRunning:hr});
const content=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n');
const chatHTML=`<!doctype html><html><head><meta charset="utf-8"></head><body><div class="friend-list"><div class="friend-content selected" data-id="fixture-split"><div class="title-box"><span class="name-text">甲女士</span><span>虚构游戏</span></div><span class="last-msg-text">过往问题</span><span class="time">10月01日</span></div></div><div class="chat-conversation"><div class="top-info-content">甲女士 虚构游戏</div><div class="chat-record"><div class="message-item item-friend" data-mid="old-hr"><span class="text">过往问题</span></div></div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send disabled">发送</button></div></div><script>
window.inject=(id,text)=>{const el=document.createElement('div');el.className='message-item item-friend';el.dataset.mid=id;const span=document.createElement('span');span.className='text';span.textContent=text;el.append(span);document.querySelector('.chat-record').append(el);document.querySelector('.last-msg-text').textContent=text;document.querySelector('.time').textContent='12:34';let badge=document.querySelector('.notice-badge');if(!badge){badge=document.createElement('span');badge.className='notice-badge';document.querySelector('.friend-content').append(badge);}badge.textContent='1';};
const editor=document.querySelector('#chat-input'),button=document.querySelector('.btn-send');editor.oninput=()=>button.classList.toggle('disabled',!editor.textContent);button.onclick=()=>{const el=document.createElement('div');el.className='message-item item-myself';el.dataset.mid='self-final';const text=document.createElement('span');text.className='text';text.textContent=editor.textContent;el.append(text);document.querySelector('.chat-record').append(el);editor.textContent='';button.classList.add('disabled');document.querySelector('.notice-badge')?.remove();};
</script></body></html>`;
const jobsHTML=`<!doctype html><html><head><meta charset="utf-8"></head><body><div class="job-card-wrapper"><a href="https://www.zhipin.com/job_detail/split-fixture.html"><span class="job-name">游戏策划实习</span></a><span class="boss-name">虚构游戏</span><span class="company-location">北京</span><span class="job-salary">200元/天</span><ul class="tag-list"><li>在校</li></ul></div></body></html>`;
async function tick(page){await page.evaluate(()=>new Promise(resolve=>window.extensionWake({type:'assistant-read',command:'tick'},{id:'split-fixture'},resolve)));}
async function until(fn,message){const end=Date.now()+5000;while(Date.now()<end){if(await fn())return;await tick(chat);await chat.waitForTimeout(30);}assert(await fn(),message+' '+JSON.stringify(calls.slice(-6).map(c=>({path:c.path,reason:c.data?.reason}))));}
try{
 const context=await browser.newContext();await context.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname.includes('/chat')?chatHTML:jobsHTML}));
 const errors=[];
 await context.exposeBinding('splitFixture',async({page},m)=>{
  if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};
  if(m.type!=='api')return {ok:true,result:null};calls.push({path:m.path,data:m.data,page:page===chat?'chat':'jobs'});let result={};
  if(m.path==='/api/heartbeat'||m.path==='/api/browser-state')result={config};
  if(m.path==='/api/replies/state')result={items:rows};
  if(m.path==='/api/tasks')result={tasks:tasks.filter(t=>t.status==='approved')};
  if(m.path==='/api/replies/enqueue'){const data=m.data,anchor=data.messages.at(-1).id;let row=rows.find(r=>r.anchor===anchor);if(!row){row={id:'q-'+anchor,peerId:data.peerId,...data.label,anchor,status:'generating'};rows.push(row);}result={reply:row};}
  if(m.path==='/api/claim'){const task=tasks.find(t=>t.id===m.data.id);assert.equal(task.peerId,m.data.peerId);task.status='executing';result={task,lease:'lease'};}
  if(m.path==='/api/check')result={allowed:true};
  if(m.path==='/api/complete'){const task=tasks.find(t=>t.id===m.data.id);task.status=m.data.success?'sent':'uncertain';rows.find(r=>r.taskId===task.id).status='done';sent.push(m.data);}
  if(m.path==='/api/owner-chat/prepare'){config.ownerChat=null;result={read:true};}
  if(m.path==='/api/single-test/prepare')result={blocked:'isolated test preparation observed'};
  return {ok:true,result};
 });
 await context.addInitScript(()=>{window.splitStorage={};window.chrome={storage:{local:{get:async key=>({[key]:splitStorage[key]}),set:async values=>Object.assign(splitStorage,values)}},runtime:{id:'split-fixture',onMessage:{addListener:fn=>window.extensionWake=fn},sendMessage:m=>window.splitFixture(m)}};window.setInterval=()=>0;});
 chat=await context.newPage();jobs=await context.newPage();for(const [page,url] of [[chat,'https://www.zhipin.com/web/geek/chat'],[jobs,'https://www.zhipin.com/web/geek/job']]){page.on('pageerror',e=>errors.push(e.message));await page.goto(url);await page.addScriptTag({content});await tick(page);}
 const autoPaths=['/api/observe','/api/tasks','/api/replies/state','/api/replies/enqueue','/api/jobs/observe'];assert(!calls.some(c=>autoPaths.includes(c.path)),'both closed keeps only diagnostics');
 flags(true,false);await tick(jobs);await tick(chat);assert(calls.some(c=>c.path==='/api/jobs/observe'));assert(!calls.some(c=>c.path==='/api/tasks'));
 await chat.evaluate(()=>inject('new-1','请介绍系统策划项目'));await tick(chat);assert.equal(rows.length,0,'job-only must not process HR');
 const jobScans=calls.filter(c=>c.path==='/api/jobs/observe').length;flags(false,true);await tick(jobs);await until(()=>rows.length===1,'HR-only enqueues unread message');assert.equal(jobScans,calls.filter(c=>c.path==='/api/jobs/observe').length);
 const pending=await chat.evaluate(()=>splitStorage['boss-realtime-v1']?.events?.length);assert.equal(pending,1);flags(false,false);const inboxCalls=calls.filter(c=>c.path==='/api/replies/enqueue').length;for(let i=0;i<3;i++)await tick(chat);assert.equal(await chat.evaluate(()=>splitStorage['boss-realtime-v1']?.events?.length),1,'HR-off must not acknowledge durable event');assert.equal(calls.filter(c=>c.path==='/api/replies/enqueue').length,inboxCalls);
 rows[0].status='stale';await chat.evaluate(()=>inject('new-2','补充一个新的项目问题'));flags(true,false);await tick(chat);await tick(jobs);assert.equal(rows.length,1);flags(true,true);config.watchEpoch=2;await until(()=>rows.length===2,'re-enabled HR recovers newer unread without clearing pending');
 const latest=rows[1];latest.status='ready';latest.taskId='send-latest';tasks.push({id:latest.taskId,peerId:latest.peerId,kind:'reply',status:'approved',fingerprint:'latest',action:'send_text',text:'主人做过系统策划练习，先介绍这一项。'});flags(false,true);await until(()=>sent.length===1,'HR reply remains sendable while job channel is closed');assert(sent[0].success);
 flags(false,false);config.ownerChat={kind:'read',planId:'manual-read',targetId:'manual-target',name:'甲女士',company:'虚构游戏'};await until(()=>calls.some(c=>c.path==='/api/owner-chat/prepare'),'manual owner read remains independent of both auto switches');
 config.singleTest={id:'manual-single',status:'selecting',target:{name:'甲女士',company:'虚构游戏'}};await until(()=>calls.some(c=>c.path==='/api/single-test/prepare'),'manual single test reaches prepare with both automatic channels off');assert.equal(config.jobSearchRunning,false);assert.equal(config.hrInboxRunning,false);assert.equal(sent.length,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({fourModes:true,jobOnlyNoHRReply:true,hrOnlyNoJobScan:true,pendingSurvivesHRStop:true,jobToggleDoesNotStopHRSend:true,manualDelegatesIndependent:true,realHRsContacted:0,realModelCalls:0}));
}finally{await browser.close();}
