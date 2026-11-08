import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const resources=resolve(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)));
process.env.BOSS_KNOWLEDGE_DIR=join(resources,'desktop','starter');
const {createApplication}=await import(pathToFileURL(join(resources,'server','app.mjs')));
const {validateDecision}=await import(pathToFileURL(join(resources,'server','core.mjs')));
const {authorForMessage}=await import(pathToFileURL(join(resources,'server','message-authorship.mjs')));
const scripts=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(join(resources,'extension',name),'utf8')).join('\n');
const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-uncertain-reply58-')));
assert.equal(dirname(local),temp);
const peer='boss:late-receipt-fixture',reply='您好，主人还在看实习机会，感谢您联系。',nextReply='您好，可以继续介绍主人的卡牌原型和作品集。',modelCalls=[];
const port=await testPort(),app=createApplication({local,workspace:local,desktop:true,port,key:'fixture-only',
 inference:async(config,_key,context)=>{modelCalls.push(context.messages.at(-1)?.id);return validateDecision({action:'send_text',text:modelCalls.length===1?reply:nextReply,reason:'模拟回复',score:90},config,context);}
});
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
 const base='http://127.0.0.1:'+app.server.address().port,{token}=await(await fetch(base+'/api/session')).json();
 async function api(path,data,adapter=false,method=data?'POST':'GET'){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json','X-Boss-Token':adapter?app.embeddedToken:token},...(data?{body:JSON.stringify(data)}:{})});
  return {http:response.status,...await response.json()};
 }
 assert.equal((await api('/api/config',{mode:'auto',autoBrowse:false,browserCalibrated:true,learningEnabled:false,autoResume:false,
  limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'模拟求职者',facts:'模拟应届求职经历',titles:['游戏策划'],cities:['北京']}})).http,200);
 assert.equal((await api('/api/channels',{hrInbox:true})).http,200);
 const page=await browser.newPage(),calls=[],errors=[],chatURL='https://www.zhipin.com/web/geek/chat';
 page.on('pageerror',error=>errors.push(error.message));
 const html='<!doctype html><meta charset=utf-8><div class="friend-content selected" data-id="late-receipt-fixture"><div class="title-box"><span class="name-text">模拟招聘者</span><span>模拟游戏公司</span></div><span class="last-msg-text">你好</span></div><div class="chat-conversation"><div class="top-info-content">模拟招聘者 模拟游戏公司</div><div class="chat-record"><div class="message-item item-friend" data-mid="hr-baseline"><span class="text">你好</span></div></div><div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send">发送</button></div></div>';
 await page.route('**/*',route=>route.request().url()===chatURL?route.fulfill({contentType:'text/html',body:html}):route.abort());
 await page.exposeFunction('fixtureApi',async m=>{
  if(m.type==='chatMonitor')return {ok:true,result:{monitor:true}};
  if(m.type!=='api')return {ok:true,result:null};
  calls.push(m.path);const result=await api(m.path,m.data,true,m.method);
  return result.http<300?{ok:true,result}:{ok:false,error:result.error};
 });
 await page.addInitScript(()=>{
  const listeners=[],stored={};
  window.chrome={storage:{local:{get:async key=>({[key]:stored[key]}),set:async patch=>Object.assign(stored,patch)}},runtime:{
   id:'fixture-extension',onMessage:{addListener:listener=>listeners.push(listener)},sendMessage:m=>window.fixtureApi(m)
  }};
  window.fixtureTick=()=>new Promise(resolve=>listeners[0]({type:'assistant-read',command:'tick'},{id:'fixture-extension'},resolve));
  window.setInterval=()=>0;
  const timeout=window.setTimeout;
  window.setTimeout=(callback,ms,...args)=>ms===350||ms===1800&&callback.name==='tick'?0:timeout(callback,ms===10000?180:ms,...args);
 });
 await page.goto(chatURL);
 await page.evaluate(()=>{
  const record=document.querySelector('.chat-record'),preview=document.querySelector('.last-msg-text'),editor=document.querySelector('textarea'),send=document.querySelector('.btn-send');
  window.sends=[];
  function append(id,role,text){
   const row=document.createElement('div');row.className='message-item '+(role==='hr'?'item-friend':'item-myself');row.dataset.mid=id;
   const body=document.createElement('span');body.className='text';body.textContent=text;row.append(body);record.append(row);preview.textContent=text;
   const sidebar=preview.parentElement;sidebar.querySelector('.message-status')?.remove();
   if(role==='self'){const marker=document.createElement('span');marker.className='message-status status-delivery';marker.textContent='已送达';sidebar.append(marker);}
  }
  send.onclick=()=>{sends.push(editor.value);editor.value='';if(sends.length>1)append('self-next','self',sends.at(-1));};
  window.incoming=(id,text)=>append(id,'hr',text);
  window.deliver=()=>append('self-delayed','self',sends[0]);
 });
 await page.addScriptTag({content:scripts});
 const tick=()=>page.evaluate(()=>window.fixtureTick());
 async function until(predicate){for(let index=0;index<30;index++){await tick();if(predicate())return;await delay(40);}assert.fail('fixture did not reach expected state');}
 await tick();
 assert.equal(app.state.tasks.length,0);
 await page.evaluate(()=>incoming('hr-1','您好，还在找游戏策划实习吗？'));
 await until(()=>app.state.tasks.some(task=>task.peerId===peer&&task.status==='uncertain'));
 const task=app.state.tasks.find(t=>t.peerId===peer);
 assert.equal(task.kind,'reply');assert.equal(task.action,'send_text');assert.equal(task.autoReplyClaim?.tailId,'hr-1');assert.match(task.evidence,/点击后未在同一会话发现发送结果/);
 assert.equal(await page.evaluate(()=>sends.length),1);assert.deepEqual(modelCalls,['hr-1']);
 await page.evaluate(()=>incoming('hr-2','另外，这周方便继续沟通吗？'));
 await until(()=>app.state.replyQueue.some(row=>row.peerId===peer&&row.reason?.includes('保留其他会话')));
 assert.deepEqual(modelCalls,['hr-1']);
 await page.evaluate(()=>deliver());
 await until(()=>app.state.memories[peer].history.some(m=>m.id==='self-delayed'));
 const memory=app.state.memories[peer],observed=memory.history.find(m=>m.id==='self-delayed');
 assert.equal(observed.text,reply);assert.equal(observed.role,'self');assert.equal(observed.source,'boss_dom');
 assert.equal(authorForMessage(memory,observed).kind,'account_self_unknown');assert.equal(task.status,'skip');
 assert.equal(task.receipt.source,'account_message_observed');assert.equal(task.receipt.messageId,'self-delayed');
 assert.equal(memory.sends[0].status,'skip');assert.equal(memory.decisions[0].status,'skip');
 const diskTask=JSON.parse(readFileSync(join(local,'state.json'),'utf8')).tasks.find(row=>row.id===task.id);
 assert.equal(diskTask.status,'skip');assert.deepEqual(diskTask.receipt,task.receipt);assert.deepEqual(diskTask.autoReplyClaim.messageIds,task.autoReplyClaim.messageIds);
 assert.equal((await api('/api/chat/author-confirm',{peerId:peer,messageId:'self-delayed',kind:'owner_confirmed'})).http,200);
 assert.equal(authorForMessage(memory,observed).kind,'owner_confirmed');
 const oldFingerprint=memory.fingerprint;
 const replay=await api('/api/prepare',{kind:'reply',trigger:'new_hr_message',peerId:peer,header:'模拟招聘者 模拟游戏公司',messages:[{id:'hr-1',role:'hr',text:'您好，还在找游戏策划实习吗？',time:'20:15'}]},true);
 assert.equal(replay.http,200);assert.equal(replay.skipped,true);assert.match(replay.reason,/原回复已关闭/);assert.notEqual(memory.fingerprint,oldFingerprint);
 assert.deepEqual(modelCalls,['hr-1']);
 await page.evaluate(()=>incoming('hr-3','收到，谢谢。想问一下作品集。'));
 await until(()=>app.state.tasks.some(row=>row.peerId===peer&&row.id!==task.id&&row.status==='sent'));
 const nextTask=app.state.tasks.find(row=>row.peerId===peer&&row.id!==task.id&&row.status==='sent');
 assert.equal(Object.hasOwn(nextTask,'autoReplyClaim'),false);
 const filename='合成简历.pdf';
 assert.equal((await api('/api/config',{autoResume:true,profile:{resumeName:filename}})).http,200);
 const request='new-resume-request';
 const resume=await api('/api/prepare',{kind:'reply',trigger:'new_hr_message',peerId:peer,header:'模拟招聘者 模拟游戏公司',
  messages:[{id:'self-delayed',role:'self',text:reply},{id:request,role:'hr',text:'想要附件简历，是否同意？'},{id:'self-ack',role:'self',text:'好的。'}],
  resumeUI:{requestPending:true,agreeEnabled:true,requestMessageId:request,defaultResumeName:filename}},true);
 assert.equal(resume.http,200);assert.equal(resume.task?.action,'send_resume',resume.reason);
 assert.deepEqual(modelCalls,['hr-1','hr-3']);assert.deepEqual(await page.evaluate(()=>sends),[reply,nextReply]);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({lateReceiptSettled:true,settlementPersisted:true,authorRemainedUnknownUntilOwnerConfirmation:true,originalAnchorReplayBlocked:true,earlierHrBlocked:true,newHrResumed:true,newResumeRequestAfterSelfAcknowledgmentPrepared:true,firstReplyClicks:1,nextReplyClicks:1,realBossRequests:0,realModelCalls:0}));
}finally{await browser.close();await app.shutdown();assert.equal(dirname(realpathSync(local)),temp);rmSync(local,{recursive:true,force:true});}
