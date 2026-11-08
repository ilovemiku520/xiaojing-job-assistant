// Visible UI -> public job link -> separately read detail page -> same-HR memory.
// All pages are isolated fixtures; no actual BOSS account or recruiter is used.
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const title='游戏系统/战斗/关卡策划实习生',company='测试网易游戏',description='岗位职责：参与战斗与关卡设计，维护玩法规则，制作策划文档并跟进原型测试。任职要求：2027届在校本科生，热爱游戏，熟悉关卡编辑与数据分析。';
const port=await testPort(),app=createApplication({port,local:mkdtempSync(join(tmpdir(),'position-link-browser-')),key:'fixture',inference:async()=>{throw Error('读取职位不应生成对外消息');}});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(d?{body:JSON.stringify(d)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 await api('/api/config',{mode:'auto',autoBrowse:false,learningEnabled:false,profile:{name:'测试主人',facts:'2027届本科',titles:['游戏策划'],cities:['杭州']}});await api('/api/run',{running:true});
 await api('/api/owner-chat',{kind:'read',requestId:'read-fixture-link',instruction:'读取当前聊天对应的职位详情',targets:[{name:'刘女士',company}]});
 const context=await browser.newContext(),source=await context.newPage();let read=null,detailPage,openedURL='';
 const chat=`<!doctype html><meta charset="utf-8"><body><div class="friend-content selected"><div class="title-box"><span class="name-text">刘女士</span><span>${company}</span></div></div><div class="chat-conversation"><div class="top-info-content">刘女士 ${company}</div><div class="chat-position-content"><span class="position-name">${title}</span><span class="city">杭州</span><span class="salary">200-250元/天</span><div class="right-content"><span id="view">查看职位</span></div></div><div class="message-item item-myself" data-mid="old-self">您好，了解实习岗位。</div><div class="chat-editor"><div id="chat-input" contenteditable="true"></div><button class="btn-send">发送</button></div></div><script>window.originalOpen=window.open;document.querySelector('#view').onclick=()=>window.open('https://www.zhipin.com/job_detail/bridge-fixture.html?securityId=do-not-store');</script></body>`;
 const job=`<!doctype html><meta charset="utf-8"><body><div class="job-banner"><div class="name"><h1>${title}</h1></div><span class="salary">200-250元/天</span></div><div class="company-info"><span class="company-name">${company}</span></div><div class="job-detail-section"><div class="job-sec-text">${description}</div></div><div class="job-detail-section job-detail-company"><div class="job-sec-text fold-text">公司介绍与职位职责分开，不能混入此岗位的要求。</div></div></body>`;
 await context.route('https://www.zhipin.com/**',r=>r.fulfill({contentType:'text/html',body:r.request().url().includes('/job_detail/')?job:chat}));
 const content=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n');
 const setup=async(page,isDetail=false)=>{
   await page.exposeFunction('fixtureApi',async m=>{
     if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};if(m.type==='api')return {ok:true,result:await api(m.path,m.data,false)};
     if(m.type==='chatJobOpen'){read={...m.read,at:Date.now()};return {ok:true,result:{}};}
     if(m.type==='chatJobNavigate'){
       assert.equal(m.requestId,read.requestId);openedURL=m.url;assert.equal(openedURL,'https://www.zhipin.com/job_detail/bridge-fixture.html');
       detailPage=await context.newPage();await setup(detailPage,true);await detailPage.goto(openedURL);await detailPage.addScriptTag({content});return {ok:true,result:{pending:true}};
     }
     if(m.type==='chatJobWorker')return {ok:true,result:isDetail?read:null};
     if(m.type==='chatJobDone'){read=null;return {ok:true,result:{}};}
     return {ok:true,result:null};
   });await page.addInitScript(()=>{const fixtureValues={};window.chrome={storage:{local:{get:async key=>({[key]:fixtureValues[key]}),set:async patch=>Object.assign(fixtureValues,patch)}},runtime:{id:'fixture',sendMessage:m=>window.fixtureApi(m)}};});
 };
 await setup(source);await source.goto('https://www.zhipin.com/web/geek/chat');await source.addScriptTag({content:readFileSync(new URL('../extension/position-link.js',import.meta.url),'utf8')});await source.addScriptTag({content});
 for(let i=0;i<180&&!Object.values(app.state.memories).some(c=>c.jobDetail?.status==='read');i++)await source.waitForTimeout(100);
 const c=Object.values(app.state.memories)[0];assert.equal(c.jobDetail.status,'read');assert.equal(c.job.description,description);assert.equal(c.job.url,openedURL);assert.equal(app.state.tasks.length,0);assert.equal(context.pages().length,2,'没有额外弹窗');assert(await source.evaluate(()=>window.open===window.originalOpen));
 console.log(JSON.stringify({buttonGeneratedURLCaptured:true,queryNotStored:true,fullJDReadFromOwnDetailTab:true,sameHRMemory:true,originalWindowOpenRestored:true,HRMessagesSent:0}));
}finally{await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
