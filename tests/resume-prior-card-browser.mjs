// Production adapter and service, with intercepted chat documents and a disposable profile.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const resources=process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('../',import.meta.url));
process.env.BOSS_KNOWLEDGE_DIR=join(resources,'desktop','starter');
const {createApplication}=await import(pathToFileURL(join(resources,'server','app.mjs')).href);
const {validateDecision}=await import(pathToFileURL(join(resources,'server','core.mjs')).href);
const scripts=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(join(resources,'extension',name),'utf8')).join('\n');
const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-resume-prior-card-')));
assert.equal(dirname(local),temp);
const chatURL='https://www.zhipin.com/web/geek/chat',filename='模拟游戏策划附件.pdf',priorMid='prior-manual-attachment';
const priorPeer='boss:fixture-prior-card',freshPeer='boss:fixture-first-attachment';
const proposals=[];
let service,browser;

async function startService(){
  const port=await testPort();
  const app=createApplication({port,local,workspace:local,desktop:true,key:'fixture-only',inference:async(config,_key,context)=>{
    proposals.push({peerId:context.memory?.peerId,resumeStatus:context.memory?.resume?.status});
    return validateDecision({action:'send_resume',text:'',reason:'模拟重复发送提议',score:90},config,context);
  }});
  service=app;
  app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
  const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json();
  const api=async(path,data,adapter=false,method=data?'POST':'GET')=>{
    const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Boss-Token':adapter?app.embeddedToken:token},
      ...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json();
    if(!response.ok)throw Error(result.error||`本地模拟接口失败 ${response.status}`);
    return result;
  };
  await api('/api/config',{mode:'auto',autoResume:true,autoBrowse:false,allowSiteDefaultResume:false,browserCalibrated:true,learningEnabled:false,
    limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'模拟求职者',facts:'模拟应届求职资料',titles:['游戏策划'],cities:['北京'],resumeName:filename}});
  await api('/api/channels',{hrInbox:true});
  return api;
}

async function chatPage(api,peerId,{oldCard=false,request=''}={}){
  const page=await browser.newPage(),calls=[],errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const name=peerId===priorPeer?'模拟招聘者甲':'模拟招聘者乙',company='模拟游戏公司';
  const html=`<!doctype html><meta charset="utf-8"><div class="friend-content selected" data-id="${peerId.slice(5)}"><div class="title-box"><span class="name-text">${name}</span><span>${company}</span></div><span class="last-msg-text">您好</span></div>
    <div class="chat-conversation"><div class="top-info-content">${name} ${company}</div><div class="chat-position-content"><span class="position-name">游戏策划实习</span><span class="city">北京</span></div>
    <div class="chat-record"><div class="message-item item-friend" data-mid="baseline">您好</div></div>
    <div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send disabled">发送</button><div class="toolbar-btn unable">发简历</div></div></div>`;
  await page.route('**/*',route=>route.request().url()===chatURL?route.fulfill({contentType:'text/html',body:html}):route.abort());
  await page.exposeFunction('fixtureApi',async message=>{
    if(message.type==='chatMonitor')return {ok:true,result:{monitor:true}};
    if(message.type!=='api')return {ok:true,result:null};
    calls.push({path:message.path,data:message.data});
    try{return {ok:true,result:await api(message.path,message.data,true,message.method)};}
    catch(error){errors.push(`${message.path} ${error.message}`);return {ok:false,error:error.message};}
  });
  await page.addInitScript(()=>{
    const listeners=[],stored={};
    window.fixture={consents:0,stored};
    window.chrome={storage:{local:{get:async key=>({[key]:stored[key]}),set:async patch=>Object.assign(stored,patch)}},runtime:{
      id:'fixture-extension',onMessage:{addListener:listener=>listeners.push(listener)},sendMessage:message=>window.fixtureApi(message)
    }};
    window.fixtureTick=()=>new Promise(resolve=>listeners[0]({type:'assistant-read',command:'tick'},{id:'fixture-extension'},resolve));
    window.setInterval=()=>0;
    const timeout=window.setTimeout;
    window.setTimeout=(callback,ms,...args)=>ms===350||ms===1800&&callback.name==='tick'?0:timeout(callback,ms,...args);
  });
  await page.goto(chatURL);
  await page.evaluate(({filename,oldCard,priorMid,request})=>{
    const record=document.querySelector('.chat-record'),preview=document.querySelector('.last-msg-text');
    function appendCard(mid){
      const row=document.createElement('div');row.className='message-item item-myself';row.dataset.mid=mid;
      const card=document.createElement('div');card.className='resume-card';
      const name=document.createElement('span');name.className='resume-name';name.textContent=filename;
      card.append(name);row.append(card);record.append(row);
    }
    window.appendFixtureRequest=mid=>{
      const row=document.createElement('div');row.className='message-item item-friend';row.dataset.mid=mid;row.dataset.resumeName=filename;
      const prompt='我想要一份您的附件简历，您是否同意';
      const agree=document.createElement('button');agree.textContent='同意';
      agree.onclick=()=>{window.fixture.consents++;appendCard(mid+'-attachment');};
      row.append(prompt,agree);record.append(row);preview.textContent=prompt;
    };
    if(oldCard){
      appendCard(priorMid);
      for(let index=0;index<80;index++){
        const message=document.createElement('div');message.className='message-item item-myself';message.dataset.mid=`intervening-${index}`;
        message.textContent=`模拟普通往来消息 ${index}`;record.append(message);
      }
    }
    if(request)window.appendFixtureRequest(request);
  },{filename,oldCard,priorMid,request});
  await page.addScriptTag({content:scripts});
  const tick=async()=>assert.equal((await page.evaluate(()=>window.fixtureTick())).ok,true);
  const consents=()=>page.evaluate(()=>window.fixture.consents);
  const addRequest=mid=>page.evaluate(mid=>window.appendFixtureRequest(mid),mid);
  return {page,calls,errors,tick,consents,addRequest};
}

async function tickUntil(chat,done){
  for(let index=0;index<18;index++){
    await chat.tick();
    if(done())return;
    await delay(70);
  }
  assert.fail('模拟聊天未在预期轮次内完成');
}

try{
  let api=await startService();
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const prior=await chatPage(api,priorPeer,{oldCard:true,request:'new-request-with-prior-card'});
  await prior.tick();
  const priorMemory=service.state.memories[priorPeer],priorReceipt=priorMemory?.resume?.receipts[0];
  assert.equal(priorMemory?.resume?.status,'sent');
  assert.equal(priorMemory.window.length,80);
  assert.equal(priorMemory.window.some(message=>message.id===priorMid),false);
  const observed=prior.calls.find(call=>call.data?.resumeUI?.attachmentCardAnchors?.length);
  assert.deepEqual(observed?.data.resumeUI.attachmentCardAnchors,[{id:priorMid,role:'self',filenameLabel:filename}]);
  assert.equal(priorReceipt?.source,'self_attachment_card');
  assert.equal(priorReceipt.messageId,priorMid);
  assert.equal(priorReceipt.filenameLabel,filename);
  assert.deepEqual(await prior.page.evaluate(()=>window.fixture.stored['boss-realtime-v1']?.events),[]);
  assert.equal(prior.calls.some(call=>call.path==='/api/replies/enqueue'||call.path==='/api/claim'),false);
  assert.equal(await prior.consents(),0);
  assert.deepEqual(prior.errors,[]);
  assert.equal(service.state.tasks.length,0,'读取旧卡片没有产生新发送任务');
  assert.deepEqual(service.state.memories[priorPeer].sends,[]);
  await prior.page.close();await service.shutdown();

  api=await startService();
  const reopened=await chatPage(api,priorPeer);
  await reopened.tick();
  assert.equal(await reopened.page.locator('.resume-card').count(),0,'重启后的当前窗口没有旧卡片');
  assert.equal(service.state.memories[priorPeer].resume.receipts[0].id,priorReceipt.id);
  await reopened.addRequest('request-after-restart');
  await tickUntil(reopened,()=>service.state.replyQueue.some(row=>row.peerId===priorPeer&&row.status==='skip'));
  assert.deepEqual(proposals,[{peerId:priorPeer,resumeStatus:'sent'}]);
  assert.equal(await reopened.consents(),0);
  assert.equal(service.state.tasks.some(task=>task.peerId===priorPeer&&task.action==='send_resume'),false);
  assert.deepEqual(service.state.memories[priorPeer].resume.receipts.map(receipt=>receipt.source),['self_attachment_card']);
  assert.deepEqual(reopened.errors,[]);
  await reopened.page.close();

  const fresh=await chatPage(api,freshPeer);
  await fresh.tick();
  assert.equal(service.state.memories[freshPeer].resume.status,'unknown');
  await fresh.addRequest('first-real-request-fixture');
  await tickUntil(fresh,()=>service.state.tasks.some(task=>task.peerId===freshPeer&&task.action==='send_resume'&&task.status==='sent'));
  const sent=service.state.tasks.find(task=>task.peerId===freshPeer&&task.action==='send_resume');
  assert.equal(await fresh.consents(),1);
  assert.match(sent.evidence,/站内附件简历卡片/);
  assert.equal(await fresh.page.locator('[data-mid="first-real-request-fixture-attachment"] .resume-card').count(),1);
  assert.ok(service.state.memories[freshPeer].resume.receipts.some(receipt=>receipt.source==='execution_receipt'));
  assert.deepEqual(fresh.errors,[]);
  console.log(JSON.stringify({priorCardOutsideReplyWindow:true,replyWindowSize:80,priorCardPersisted:true,initialWatcherSuppressed:true,restartCardAbsent:true,priorConsentClicks:0,freshConsentClicks:1,freshCardProvesSend:true,realBossRequests:0,realModelCalls:0}));
}finally{
  if(browser)await browser.close();
  if(service)await service.shutdown();
  rmSync(local,{recursive:true,force:true});
}
