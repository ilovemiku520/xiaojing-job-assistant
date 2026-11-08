// Isolated DOM fixtures: no real BOSS account, Edge, or HR traffic.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
let inferenceCount=0;
const port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'whale-incoming-')),port,key:'fixture',inference:async()=>{inferenceCount++;return {action:'send_text',text:'主人主要关注系统和玩法策划，这边的具体职责是什么？',reason:'仅回复接入后真实新HR消息',score:90};}});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
const api=async(path,data,owner=true)=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 await api('/api/config',{mode:'auto',browserCalibrated:true,newMessagesOnly:true,historyRead:true,historySweepEnabled:true,autoBrowse:true,learningEnabled:false,profile:{name:'测试主人',facts:'虚构本科生资料',titles:['游戏策划'],cities:['北京']},limits:{hoursStart:0,hoursEnd:24}});await api('/api/run',{running:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const html=`<!doctype html><html><head><meta charset="utf-8"></head><body>
 <div class="friend-list"><div id="a" class="friend-content selected"><div class="title-box"><span class="name-text">甲女士</span><span>测试游戏甲</span></div><span class="time">10月01日</span><span class="last-msg-text">旧的历史邀约</span></div><div id="b" class="friend-content"><div class="title-box"><span class="name-text">乙女士</span><span>测试游戏乙</span></div><span class="time">10月02日</span><span class="last-msg-text">另一位HR的旧消息</span></div></div>
 <div class="chat-conversation"><div class="top-info-content">甲女士 测试游戏甲</div><div class="chat-position-content"><span class="position-name">游戏策划实习</span><span class="city">北京</span></div><div class="chat-record" id="messages"></div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send disabled">发送</button></div></div>
 <script>
 window.messagesByPeer={a:Array.from({length:100},(_,i)=>({id:'a'+i,role:'hr',text:'旧历史'+i})),b:[{id:'b1',role:'hr',text:'另一位HR的旧消息'}]};window.sendTargets=[];
 window.render=()=>{const id=document.querySelector('.friend-content.selected').id;document.querySelector('.top-info-content').textContent=id==='a'?'甲女士 测试游戏甲':'乙女士 测试游戏乙';document.querySelector('#messages').replaceChildren();for(const m of window.messagesByPeer[id]){const el=document.createElement('div');el.className='message-item '+(m.role==='hr'?'item-friend':'item-myself');el.dataset.mid=m.id;el.textContent=(m.role==='self'?'12:34 送达 ':'')+m.text;document.querySelector('#messages').append(el);}};
 document.querySelectorAll('.friend-content').forEach(e=>e.onclick=()=>{document.querySelectorAll('.friend-content').forEach(x=>x.classList.remove('selected'));e.classList.add('selected');window.render();});window.render();
 const editor=document.querySelector('#chat-input'),button=document.querySelector('button');editor.oninput=()=>button.classList.toggle('disabled',!editor.textContent.trim());
 button.onclick=()=>{if(button.classList.contains('disabled'))return;const id=document.querySelector('.friend-content.selected').id;window.sendTargets.push(id);window.messagesByPeer[id].push({id:'self-'+Date.now(),role:'self',text:editor.textContent});const peer=document.querySelector('#'+id);peer.querySelector('.last-msg-text').textContent=editor.textContent;const status=document.createElement('i');status.className='message-status status-delivery';peer.append(status);editor.textContent='';button.classList.add('disabled');window.render();};
 window.injectIncoming=()=>{window.messagesByPeer.a.push({id:'new-hr-a',role:'hr',text:'想了解一下系统玩法方向的实习吗？'});document.querySelector('#a .last-msg-text').textContent='想了解一下系统玩法方向的实习吗？';document.querySelector('#a .time').textContent='12:34';const badge=document.createElement('span');badge.className='notice-badge';badge.textContent='1';document.querySelector('#a').append(badge);if(document.querySelector('.friend-content.selected').id==='a')window.render();};
 </script></body></html>`;
 await page.route('https://www.zhipin.com/**',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.exposeFunction('fixtureApi',async m=>m.type==='chatMonitor'?{ok:true,result:{monitor:true}}:['worker','crawlWorker'].includes(m.type)?{ok:true,result:null}:m.type==='api'?{ok:true,result:await api(m.path,m.data,false)}:{ok:true,result:{ok:true}});
 await page.addInitScript(()=>{const fixtureValues={};window.chrome={storage:{local:{get:async key=>({[key]:fixtureValues[key]}),set:async patch=>Object.assign(fixtureValues,patch)}},runtime:{id:'fixture',sendMessage:m=>window.fixtureApi(m)}};});
 await page.goto('https://www.zhipin.com/web/geek/chat');await page.addScriptTag({content:['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n')});
 for(let i=0;i<50&&!Object.values(app.state.memories).some(c=>c.history.length===100);i++)await new Promise(r=>setTimeout(r,100));
 assert(Object.values(app.state.memories).some(c=>c.history.length===100),'应导入网页已有100条历史');assert.equal(app.state.tasks.length,0);assert.equal(inferenceCount,0,'历史基线不能触发旧消息回复');
 // Memory persistence precedes the asynchronous UI switch; wait for that outcome.
 await page.waitForFunction(()=>document.querySelector('.friend-content.selected')?.id==='b',null,{timeout:10000});
 assert.equal(await page.locator('.friend-content.selected').getAttribute('id'),'b','应在只读历史轮询中切换到另一位HR');
 await page.evaluate(()=>window.injectIncoming());
 for(let i=0;i<250&&!app.state.tasks.some(t=>t.status==='sent');i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(app.state.tasks.filter(t=>t.status==='sent').length,1);assert.equal(inferenceCount,1);assert.deepEqual(await page.evaluate(()=>window.sendTargets),['a']);
 const c=Object.values(app.state.memories).find(c=>c.domIdentity?.name==='甲女士');assert(c.history.length>=101);assert.equal(c.history[0].id,'a0');assert.equal(c.domIdentity.platformPeerIdKnown,false);assert.equal(c.sends[0].status,'sent');
 await page.waitForTimeout(6500);assert.equal(inferenceCount,1);assert.equal(app.state.tasks.length,1);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({historyImported:100,oldReplies:0,newHRReplies:1,correctPeer:true,duplicateReplies:0,realHRsContacted:0}));
}finally{await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
