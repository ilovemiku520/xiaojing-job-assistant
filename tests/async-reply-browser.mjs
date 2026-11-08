// Full production content adapter with a synthetic contacts page and mock API.
// No real site traffic, account, model, or HR message is used.
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
const config={running:true,readingEnabled:true,watchEpoch:1,mode:'auto',autoBrowse:true,chatRead:true,chatInput:true,newMessagesOnly:true,historyRead:true,historySweepEnabled:false,selectors:{}};
const rows=[],tasks=[],calls=[],claims=[],completions=[];
const expected={a:{name:'甲女士',company:'虚构游戏甲'},b:{name:'乙女士',company:'虚构游戏乙'}};
let page;
async function tick(){await page.evaluate(()=>window.clockOffset+=2500);await page.evaluate(()=>new Promise(resolve=>window.extensionWake({type:'assistant-read',command:'tick'},{id:'async-fixture'},resolve)));}
async function outcome(predicate,message){const end=Date.now()+8000;while(Date.now()<end){if(await predicate())return;await tick();await page.waitForTimeout(30);}assert(await predicate(),message);}
function ready(row,text){row.status='ready';row.taskId='task-'+row.id;tasks.push({id:row.taskId,peerId:row.peerId,kind:'reply',status:'approved',fingerprint:row.id,action:'send_text',text});}
try{
 page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=`<!doctype html><html><head><meta charset="utf-8"></head><body><div class="friend-list">${Object.entries(expected).map(([id,label],i)=>`<div id="${id}" data-id="fixture-${id}" class="friend-content ${i===0?'selected':''}"><div class="title-box"><span class="name-text">${label.name}</span><span>${label.company}</span></div><span class="last-msg-text">过往消息${id}</span><span class="time">10月01日</span></div>`).join('')}</div><div class="chat-conversation"><div class="top-info-content"></div><div class="chat-record"></div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send disabled">发送</button></div></div><script>
 window.byPeer={a:[{id:'old-a',role:'hr',text:'过往消息a'}],b:[{id:'old-b',role:'hr',text:'过往消息b'}]};window.sent=[];window.clicks=[];window.delayedSwitches=0;
 window.render=()=>{const id=document.querySelector('.friend-content.selected').id;document.querySelector('.top-info-content').textContent=id==='a'?'甲女士 虚构游戏甲':'乙女士 虚构游戏乙';const record=document.querySelector('.chat-record');record.replaceChildren();for(const m of byPeer[id]){const el=document.createElement('div');el.className='message-item '+(m.role==='hr'?'item-friend':'item-myself');el.dataset.mid=m.id;const text=document.createElement('span');text.className='text';text.textContent=m.text;el.append(text);record.append(el);}};
 for(const p of document.querySelectorAll('.friend-content'))p.onclick=()=>{clicks.push(p.id);for(const peer of document.querySelectorAll('.friend-content'))peer.classList.remove('selected');p.classList.add('selected');p.querySelector('.notice-badge')?.remove();delayedSwitches++;setTimeout(()=>{if(p.classList.contains('selected'))render();},1200);};
 const editor=document.querySelector('#chat-input'),button=document.querySelector('.btn-send');editor.oninput=()=>button.classList.toggle('disabled',!editor.textContent.trim());button.onclick=()=>{if(button.classList.contains('disabled'))return;const id=document.querySelector('.friend-content.selected').id,text=editor.textContent;sent.push({id,text});byPeer[id].push({id:'self-'+sent.length,role:'self',text});const peer=document.querySelector('#'+id);peer.querySelector('.last-msg-text').textContent=text;peer.querySelector('.notice-badge')?.remove();const out=document.createElement('i');out.className='message-status status-delivery';peer.append(out);editor.textContent='';button.classList.add('disabled');render();};
 window.inject=(id,mid,text)=>{byPeer[id].push({id:mid,role:'hr',text});const p=document.querySelector('#'+id);p.querySelector('.last-msg-text').textContent=text;p.querySelector('.time').textContent='12:34';p.querySelector('.message-status')?.remove();let badge=p.querySelector('.notice-badge');if(!badge){badge=document.createElement('span');badge.className='notice-badge';p.append(badge);}badge.textContent='1';if(p.classList.contains('selected'))render();};render();
 </script></body></html>`;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));
 await page.exposeFunction('asyncFixture',async m=>{
  if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};
  if(m.type!=='api')return {ok:true,result:null};calls.push({path:m.path,data:m.data,at:Date.now()});let result={};
  if(m.path==='/api/heartbeat')result={config};
  if(m.path==='/api/replies/state')result={items:rows};
  if(m.path==='/api/tasks')result={tasks:tasks.filter(t=>t.peerId===m.data.peerId&&t.status==='approved')};
  if(m.path==='/api/observe')for(const row of rows.filter(r=>r.peerId===m.data.peerId&&r.anchor!==m.data.messages.at(-1)?.id&&['queued','generating','ready'].includes(r.status))){row.status='stale';const task=tasks.find(t=>t.id===row.taskId);if(task)task.status='stale';}
  if(m.path==='/api/replies/enqueue'){
   const data=m.data,mid=data.messages.at(-1).id;assert.equal(data.messages[0].id,data.peerId.endsWith('-a')?'old-a':'old-b','delayed old conversation body must not bind to newly selected HR');let row=rows.find(r=>r.peerId===data.peerId&&r.anchor===mid);
   if(!row){for(const old of rows.filter(r=>r.peerId===data.peerId)){old.status='stale';const task=tasks.find(t=>t.id===old.taskId);if(task)task.status='stale';}row={id:'reply-'+mid,peerId:data.peerId,...data.label,status:'generating',anchor:mid,queuedAt:Date.now()};rows.push(row);}result={reply:row};
  }
  if(m.path==='/api/claim'){
   const task=tasks.find(t=>t.id===m.data.id);assert(task,'claim must reference prepared task');assert.equal(m.data.peerId,task.peerId);assert.equal(m.data.fingerprint,task.fingerprint);
   const selected=await page.locator('.friend-content.selected').getAttribute('data-id');assert.equal(m.data.peerId,'boss:'+selected,'must resolve current stable peer, not label alone');claims.push(m.data);task.status='executing';result={task,lease:'lease-'+task.id};
  }
  if(m.path==='/api/check')result={allowed:true};
  if(m.path==='/api/complete'){completions.push(m.data);const task=tasks.find(t=>t.id===m.data.id);task.status=m.data.success?'sent':'uncertain';const row=rows.find(r=>r.taskId===task.id);row.status='done';result={ok:true};}
  if(m.path==='/api/prepare')throw Error('synchronous model request is forbidden');
  if(m.path==='/api/chat/history'||m.path==='/api/chat/job/start')throw Error('incoming reply cannot wait for history/JD');
  return {ok:true,result};
 });
 await page.addInitScript(()=>{const realNow=Date.now;window.clockOffset=0;Date.now=()=>realNow()+window.clockOffset;const values={};window.chrome={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}},runtime:{id:'async-fixture',onMessage:{addListener:fn=>window.extensionWake=fn},sendMessage:m=>window.asyncFixture(m)}};const native=window.setInterval;window.setInterval=(fn,ms,...args)=>[1000,1500,6000].includes(ms)?0:native(fn,ms,...args);});
 await page.goto('https://www.zhipin.com/web/geek/chat');await page.addScriptTag({content:['realtime.js','resume-ui.js','content.js'].map(n=>readFileSync(new URL('../extension/'+n,import.meta.url),'utf8')).join('\n')});
 await outcome(()=>calls.some(c=>c.path==='/api/tasks'),'adapter is ready');assert.equal(rows.length,0,'historical baseline stays silent');
 await page.evaluate(()=>inject('a','new-a-1','请介绍系统策划项目。'));await outcome(()=>rows.some(r=>r.anchor==='new-a-1'),'first HR must enqueue');
 const first=rows.find(r=>r.anchor==='new-a-1');assert.equal(first.status,'generating');
 await page.evaluate(()=>inject('b','new-b-1','也想了解主人做的玩法项目。'));await outcome(()=>rows.some(r=>r.anchor==='new-b-1'),'second HR must enqueue before first generation returns');assert.equal(first.status,'generating');assert.equal(claims.length,0);
 const b=rows.find(r=>r.anchor==='new-b-1');ready(b,'给主人沟通玩法项目，这里是乙的回复。');
 await outcome(()=>completions.length===1,'second HR can finish while first is still generating');assert.equal(first.status,'generating');assert.deepEqual(await page.evaluate(()=>sent.map(s=>s.id)),['b']);
 const beats=calls.filter(c=>c.path==='/api/heartbeat').length;await tick();await tick();assert(calls.filter(c=>c.path==='/api/heartbeat').length>beats,'heartbeats keep working during inference');
 ready(first,'这一条过时回复绝不能发送。');
 await page.evaluate(()=>inject('a','new-a-2','补充一下，更关注战斗系统。'));await outcome(()=>rows.some(r=>r.anchor==='new-a-2'),'new message must supersede old generation');assert.equal(first.status,'stale');
 const a=rows.find(r=>r.anchor==='new-a-2');ready(a,'给主人沟通战斗系统，这里是甲的最新回复。');await outcome(()=>completions.length===2,'latest A draft should send');
 assert.deepEqual(await page.evaluate(()=>sent),[{id:'b',text:'给主人沟通玩法项目，这里是乙的回复。'},{id:'a',text:'给主人沟通战斗系统，这里是甲的最新回复。'}]);assert(claims.every(c=>c.id!==first.taskId),'reconcile newest visible message before claiming an old ready task');assert(completions.every(c=>c.success));await tick();await tick();assert.equal(completions.length,2);assert((await page.evaluate(()=>delayedSwitches))>0,'exercise delayed body replacement');assert.deepEqual(errors,[]);
 // The current row can show an unread preview before its actual body has
 // arrived. Keep its event without making the rest of the inbox wait.
 const delayedText='甲的真实正文仍在加载';
 await page.evaluate(preview=>{
  byPeer.a=[{id:'old-a',role:'hr',text:'过往消息a'}];render();
  const peer=document.querySelector('#a');
  peer.querySelector('.last-msg-text').textContent=preview;
  peer.querySelector('.time').textContent='12:35';
  for(const old of peer.querySelectorAll('.notice-badge,.message-status'))old.remove();
  const badge=document.createElement('span');badge.className='notice-badge';badge.textContent='1';peer.append(badge);
  inject('b','new-b-2','乙的新问题可以先处理。');
 },delayedText);
 const pendingA=()=>page.evaluate(async()=>{
  const values=await chrome.storage.local.get('boss-realtime-v1');
  return values['boss-realtime-v1']?.events.some(([key,event])=>key==='boss:fixture-a'&&event.source==='sidebar');
 });
 const activeA=()=>page.evaluate(()=>document.querySelector('.friend-content.selected').id==='a');
 await outcome(()=>rows.some(r=>r.anchor==='new-b-2'),'stale A preview must not block B');
 assert(await pendingA());
 ready(rows.find(r=>r.anchor==='new-b-2'),'乙的第一条模拟回复。');
 await outcome(()=>completions.length===3,'B can be handled while A body is stale');
 await outcome(activeA,'unresolved A remains selectable');
 assert(await pendingA());
 await page.evaluate(()=>inject('b','new-b-3','乙还有一个问题。'));
 await outcome(()=>rows.some(r=>r.anchor==='new-b-3'),'A must not block later unread after B is handled');
 ready(rows.find(r=>r.anchor==='new-b-3'),'乙的第二条模拟回复。');
 await outcome(()=>completions.length===4,'later B message is independently handled');
 await outcome(activeA,'A can be selected again when its body arrives');
 assert(await pendingA());
 await page.evaluate(preview=>inject('a','new-a-3',preview),delayedText);
 await outcome(()=>rows.some(r=>r.anchor==='new-a-3'),'A retries when real body arrives');
 ready(rows.find(r=>r.anchor==='new-a-3'),'甲的延迟正文模拟回复。');
 await outcome(()=>completions.length===5,'A is handled once its actual message is observed');
 assert.deepEqual(await page.evaluate(()=>sent.slice(-3).map(s=>s.id)),['b','b','a']);
 assert(completions.every(c=>c.success));assert.deepEqual(errors,[]);
 console.log(JSON.stringify({independentGeneration:true,secondHRBeforeFirstResolved:true,latestMessageOnly:true,correctStablePeer:true,stalePreviewDoesNotBlockOthers:true,delayedMessageRecovered:true,duplicateSends:0,realHRsContacted:0,modelCalls:0}));
}finally{await browser.close();}
