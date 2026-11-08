// Tests the automatic BOSS consent path with a known filename and a non-message receipt.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {validateDecision} from '../server/core.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');const inferenceAnchors=[];
const port=await testPort(),app=createApplication({port,local:mkdtempSync(join(tmpdir(),'resume-consent-')),key:'fixture',inference:async(c,k,ctx)=>{inferenceAnchors.push(ctx.after_resume?.messageId||'');return validateDecision({action:'send_resume',text:'',reason:'新的附件请求',score:90},c,ctx);}});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(d?{body:JSON.stringify(d)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 await api('/api/config',{mode:'auto',autoResume:true,autoBrowse:false,browserCalibrated:true,learningEnabled:false,limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京'],resumeName:'游戏策划简历.pdf'}});await api('/api/run',{running:true});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));const html=`<!doctype html><html><meta charset="utf-8"><body><div class="friend-content selected"><div class="title-box"><span class="name-text">甲女士</span><span>测试游戏</span></div><span class="last-msg-text">你好</span></div><div class="chat-conversation"><div class="top-info-content">甲女士 测试游戏</div><div class="chat-record"><div class="message-item item-friend" data-mid="old">你好</div></div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send disabled">发送</button><div class="toolbar-btn unable">发简历</div></div></div><script>window.agreeClicks=0;window.newRequest=()=>{const el=document.createElement('div');el.className='message-item item-friend';el.dataset.mid='new-request';el.innerHTML='我想要一份您的附件简历，您是否同意<span class="resume-name" data-file-name="游戏策划简历.pdf">游戏策划简历.pdf</span><button>同意</button>';el.querySelector('button').onclick=()=>{agreeClicks++;const notice=document.createElement('div');notice.className='resume-notice';notice.textContent='您的附件简历 游戏策划简历.pdf 已发送给Boss点击查看附件';document.querySelector('.chat-record').append(notice);document.querySelector('.last-msg-text').textContent=notice.textContent;};document.querySelector('.chat-record').append(el);document.querySelector('.last-msg-text').textContent='我想要一份您的附件简历，您是否同意';};</script></body></html>`;
 await page.route('https://www.zhipin.com/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.exposeFunction('fixtureApi',async m=>m.type==='chatMonitor'?{ok:true,result:{monitor:true}}:['worker','crawlWorker'].includes(m.type)?{ok:true,result:null}:m.type==='api'?{ok:true,result:await api(m.path,m.data,false)}:{ok:true,result:{}});await page.addInitScript(()=>{const fixtureValues={};window.chrome={storage:{local:{get:async key=>({[key]:fixtureValues[key]}),set:async patch=>Object.assign(fixtureValues,patch)}},runtime:{id:'fixture',sendMessage:m=>window.fixtureApi(m)}};});await page.goto('https://www.zhipin.com/web/geek/chat');
 await page.evaluate(()=>{
  const quote='你这边是不是显示“您的附件简历 合成附件.pdf 已发送给Boss点击查看附件”？我这里没有收到，麻烦再发一下。';
  document.querySelector('[data-mid="old"]').textContent=quote;document.querySelector('.last-msg-text').textContent=quote;
 });
 await page.addScriptTag({content:['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n')});
 for(let i=0;i<60&&!Object.keys(app.state.memories).length;i++)await page.waitForTimeout(100);
 assert.equal(Object.values(app.state.memories)[0]?.resume?.status,'unknown');assert.equal(inferenceAnchors.length,0);await page.evaluate(()=>newRequest());
 for(let i=0;i<200&&!app.state.tasks.some(t=>t.status==='sent');i++)await page.waitForTimeout(100);
 const attachmentTask=app.state.tasks.find(task=>task.action==='send_resume');assert.equal(attachmentTask?.status,'sent',JSON.stringify(app.state.tasks));assert.equal(Object.values(app.state.memories)[0].resume.status,'sent');assert.equal(await page.evaluate(()=>agreeClicks),1);assert.deepEqual(errors,[]);
 await page.waitForTimeout(6500);assert.equal(await page.evaluate(()=>agreeClicks),1);assert.deepEqual(inferenceAnchors,['new-request'],'仅确认回执后的续答调用模型，附件同意直接执行');console.log(JSON.stringify({priorHRQuoteIgnored:true,newHRRequest:true,defaultFilenameVerified:true,consentClicks:1,nonMessageReceiptConfirmed:true,duplicateResumeSends:0,realHRsContacted:0}));
}finally{await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
