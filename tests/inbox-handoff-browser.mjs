import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';

const resources=process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('../',import.meta.url));
const scripts=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(join(resources,'extension',name),'utf8')).join('\n');
const url='https://www.zhipin.com/web/geek/chat';
const config={running:true,hrInboxRunning:true,chatRead:true,chatInput:false,newMessagesOnly:true,autoBrowse:false,watchEpoch:1,mode:'review',selectors:{}};
const local={},queued=[],errors=[];
let monitor='primary';
const html=`<!doctype html><meta charset="utf-8">
<div class="friend-list">
  <div class="friend-content selected" data-id="fixture-a"><div class="title-box"><span class="name-text">模拟甲</span><span>公司甲</span></div><span class="last-msg-text">旧消息甲</span><span class="time">10月1日</span></div>
  <div class="friend-content" data-id="fixture-b"><div class="title-box"><span class="name-text">模拟乙</span><span>公司乙</span></div><span class="last-msg-text">旧消息乙</span><span class="time">10月1日</span></div>
</div>
<div class="chat-conversation"><div class="top-info-content">模拟甲 公司甲</div><div class="chat-record"><div class="message-item item-friend" data-mid="old-a">旧消息甲</div></div><div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send disabled">发送</button></div></div>`;
const browser=await chromium.launch({headless:true,channel:'msedge'});

async function pageFor(id){
  const page=await browser.newPage();
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>route.request().url()===url?route.fulfill({contentType:'text/html',body:html}):route.abort());
  await page.exposeFunction('storageGet',key=>({[key]:local[key]}));
  await page.exposeFunction('storageSet',patch=>{Object.assign(local,structuredClone(patch));});
  await page.exposeFunction('localMessage',message=>{
    if(message.type==='chatMonitor')return {ok:true,result:{monitor:monitor===id}};
    if(message.type!=='api')return {ok:true,result:null};
    let result={};
    if(message.path==='/api/heartbeat')result={config};
    if(message.path==='/api/replies/state')result={items:[]};
    if(message.path==='/api/tasks')result={tasks:[]};
    if(message.path==='/api/replies/enqueue'){
      queued.push({page:id,peerId:message.data.peerId,mid:message.data.messages.at(-1).id});
      result={reply:{id:'fixture-reply',peerId:message.data.peerId,status:'skip'}};
    }
    return {ok:true,result};
  });
  await page.addInitScript(()=>{
    window.chrome={storage:{local:{get:key=>window.storageGet(key),set:patch=>window.storageSet(patch)}},runtime:{id:'handoff-fixture',onMessage:{addListener:callback=>{window.receiveFixture=callback;}},sendMessage:message=>window.localMessage(message)}};
    const now=Date.now;
    let elapsed=0;
    Date.now=()=>now()+elapsed;
    window.setInterval=()=>0;
    const timeout=window.setTimeout;
    window.setTimeout=(fn,ms,...args)=>[350,1800].includes(ms)?0:timeout(fn,ms,...args);
    window.tickFixture=()=>{elapsed+=2500;return new Promise(resolve=>window.receiveFixture({type:'assistant-read',command:'tick'},{id:'handoff-fixture'},resolve));};
  });
  await page.goto(url);
  await page.evaluate(()=>{
    const target=document.querySelector('[data-id="fixture-b"]');
    target.onclick=()=>{
      document.querySelector('.friend-content.selected').classList.remove('selected');
      target.classList.add('selected');
      target.querySelector('.notice-badge')?.remove();
      document.querySelector('.top-info-content').textContent='模拟乙 公司乙';
      document.querySelector('.chat-record').innerHTML='<div class="message-item item-friend" data-mid="old-b">旧消息乙</div><div class="message-item item-friend" data-mid="new-b">新的模拟问题</div>';
    };
    window.incoming=badge=>{
      target.querySelector('.last-msg-text').textContent='新的模拟问题';
      target.querySelector('.time').textContent='10:34';
      if(badge){const count=document.createElement('span');count.className='notice-badge';count.textContent='1';target.append(count);}
    };
  });
  await page.addScriptTag({content:scripts});
  return page;
}

try{
  const primary=await pageFor('primary'),backup=await pageFor('backup');
  const tick=async page=>assert.equal((await page.evaluate(()=>window.tickFixture())).ok,true);
  await tick(backup);
  await tick(primary);
  await primary.evaluate(()=>window.incoming(true));
  await tick(primary);
  const snapshot=()=>local['boss-realtime-v1'];
  assert.equal(snapshot().events.length,1);
  assert.equal(snapshot().events[0][0],'boss:fixture-b');
  assert.deepEqual(queued,[]);
  await backup.evaluate(()=>window.incoming(false));
  await primary.close();
  monitor='backup';config.autoBrowse=true;
  for(let turn=0;turn<6;turn++)await tick(backup);
  assert.deepEqual(queued,[{page:'backup',peerId:'boss:fixture-b',mid:'new-b'}]);
  assert.equal(snapshot().events.length,0);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({warmBackup:true,badgeAlreadyCleared:true,persistedEventRecovered:true,queuedOnce:true,realBossRequests:0,modelCalls:0}));
}finally{await browser.close();}
