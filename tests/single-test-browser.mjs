// All pages here are local fixtures; this never touches a real HR or Edge session.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 for(const changeDuringInput of [false,true]){
  const port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'whale-one-browser-')),port,key:'fixture',inference:async()=>({action:'skip',text:'',reason:'fixture',score:0})});
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`;
  try{
   const session=await(await fetch(base+'/api/session')).json();
   const api=async(path,data,owner=true)=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
   await api('/api/config',{profile:{name:'测试主人',facts:'2027届',titles:['游戏策划'],cities:['北京']},limits:{hoursStart:0,hoursEnd:24}});
   await api('/api/single-test/start',{name:'周女士',company:'测试游戏公司',text:'你好，我是DeepSeek小鲸，想了解游戏策划实习机会。'});
   const page=await browser.newPage();
   const html=`<!doctype html><html><head><meta charset="utf-8"></head><body>
   <div class="friend-list"><div class="friend-content selected" id="a"><div class="title-box"><span class="name-text">其他HR</span><span>其他公司</span></div></div><div class="friend-content" id="b"><div class="title-box"><span class="name-text">周女士</span><span>测试游戏公司</span></div></div></div>
   <div class="chat-conversation"><div class="top-info-content">其他HR 其他公司</div><div class="chat-position-content"><span class="position-name">游戏策划实习</span><span class="city">北京</span></div><div id="messages"><div class="message-item item-friend" data-mid="a1"><span class="text">你好</span></div></div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send disabled">发送</button></div></div>
   <script>window.sendClicks=0;window.targetAtSend=[];const editor=document.querySelector('#chat-input'),button=document.querySelector('button');
   document.querySelectorAll('.friend-content').forEach(e=>e.onclick=()=>{document.querySelectorAll('.friend-content').forEach(x=>x.classList.remove('selected'));e.classList.add('selected');document.querySelector('.top-info-content').textContent=e.id==='b'?'周女士 测试游戏公司':'其他HR 其他公司';document.querySelector('#messages').innerHTML='<div class="message-item item-friend" data-mid="'+e.id+'1"><span class="text">你好，感兴趣聊聊吗？</span></div>';});
   editor.oninput=()=>{button.classList.toggle('disabled',!editor.textContent.trim());${changeDuringInput?"document.querySelector('#a').click();":''}};
   button.onclick=()=>{if(button.classList.contains('disabled'))return;window.sendClicks++;window.targetAtSend.push(document.querySelector('.friend-content.selected').id);const m=document.createElement('div');m.className='message-item item-myself';m.dataset.mid='self-'+Date.now();const stamp=document.createElement('span');stamp.textContent='19:44 送达 ';const t=document.createElement('span');t.className='boss-body';t.textContent=editor.textContent;m.append(stamp,t);document.querySelector('#messages').append(m);editor.textContent='';button.classList.add('disabled');};</script></body></html>`;
   await page.route('https://www.zhipin.com/**',r=>r.fulfill({contentType:'text/html',body:html}));
   await page.exposeFunction('fixtureApi',async m=>m.type==='chatMonitor'?{ok:true,result:{monitor:true}}:['worker','crawlWorker'].includes(m.type)?{ok:true,result:null}:m.type==='api'?{ok:true,result:await api(m.path,m.data,false)}:{ok:true,result:{ok:true}});
   await page.addInitScript(()=>{const fixtureValues={};window.chrome={storage:{local:{get:async key=>({[key]:fixtureValues[key]}),set:async patch=>Object.assign(fixtureValues,patch)}},runtime:{id:'fixture',sendMessage:m=>window.fixtureApi(m)}};});
   await page.goto('https://www.zhipin.com/web/geek/chat');await page.addScriptTag({content:['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n')});
   for(let i=0;i<160&&['selecting','ready','executing'].includes(app.state.singleTest.status);i++)await new Promise(r=>setTimeout(r,100));
   assert.equal(app.state.config.running,false,'单条测试必须自行停止');
   if(!['sent','uncertain'].includes(app.state.singleTest.status))console.log(JSON.stringify({fixtureFailure:app.state.singleTest,events:app.state.events.slice(0,3)}));
   if(changeDuringInput){assert.equal(app.state.singleTest.status,'uncertain');assert.equal(await page.evaluate(()=>window.sendClicks),0);}
   else{assert.equal(app.state.singleTest.status,'sent');assert.equal(await page.evaluate(()=>window.sendClicks),1);assert.deepEqual(await page.evaluate(()=>window.targetAtSend),['b']);assert.equal(app.state.config.browserCalibrated,false);}
   await page.close();console.log(JSON.stringify({fixture:true,changeDuringInput,status:app.state.singleTest.status,realHRsContacted:0}));
  }finally{await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
 }
}finally{await browser.close();}
