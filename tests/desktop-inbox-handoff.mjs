// Exercises the native browser's monitor election and durable inbox storage.
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=realpathSync(tmpdir());
const profile=realpathSync(mkdtempSync(join(temporary,'xiaojing-inbox-handoff-')));
assert.equal(dirname(profile),temporary);
const packaged=process.argv[2]&&resolve(process.argv[2]);
const executablePath=packaged||join(root,'tools','cache','electron','runtime','electron.exe');
const port=await testPort();
const local='http://127.0.0.1:'+port,chat='https://www.zhipin.com/web/geek/chat';
const job='https://www.zhipin.com/job_detail/native-inbox-fixture.html',model='https://models.fixture.invalid/v1/chat/completions';
const cursorFile=join(profile,'profile','embedded-realtime.json');
const html=`<!doctype html><meta charset="utf-8">
<div class="friend-list">
  <div class="friend-content selected" data-id="fixture-a"><div class="title-box"><span class="name-text">模拟甲</span><span>公司甲</span></div><span class="last-msg-text">旧消息甲</span><span class="time">10月1日</span></div>
  <div class="friend-content" data-id="fixture-b"><div class="title-box"><span class="name-text">模拟乙</span><span>公司乙</span></div><span class="last-msg-text">旧消息乙</span><span class="time">10月1日</span></div>
</div>
<div class="chat-conversation"><div class="top-info-content">模拟甲 公司甲</div><div class="chat-record"><div class="message-item item-friend" data-mid="old-a">旧消息甲</div></div><div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send disabled">发送</button></div></div>
<script>
const target=document.querySelector('[data-id="fixture-b"]');
window.incoming=badge=>{
  target.querySelector('.last-msg-text').textContent='新的模拟问题';
  target.querySelector('.time').textContent='10:34';
  if(badge){const count=document.createElement('span');count.className='notice-badge';count.textContent='1';target.append(count);}
};
window.fixture={switches:0,sends:0};
document.querySelector('.btn-send').onclick=()=>window.fixture.sends++;
target.onclick=()=>{
  window.fixture.switches++;
  document.querySelector('.friend-content.selected').classList.remove('selected');
  target.classList.add('selected');
  target.querySelector('.notice-badge')?.remove();
  document.querySelector('.top-info-content').textContent='模拟乙 公司乙';
  document.querySelector('.chat-record').innerHTML='<div class="message-item item-friend" data-mid="old-b">旧消息乙</div><div class="message-item item-friend" data-mid="new-b">新的模拟问题</div>';
};
</script>`;

async function until(check,label,timeout=17000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const value=await check();
    if(value)return value;
    await new Promise(done=>setTimeout(done,120));
  }
  throw Error(label);
}
function cursor(){
  try{return JSON.parse(readFileSync(cursorFile,'utf8'));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}

let app;
try{
  app=await electron.launch({executablePath,args:packaged?[]:[resolve(root)],env:{...process.env,XIAOJING_DESKTOP_HOME:profile,XIAOJING_DESKTOP_PORT:String(port)},timeout:25000});
  const win=await app.firstWindow({timeout:25000});
  await app.evaluate(({session},{html,chat,job,model,local})=>{
    const partition=session.fromPartition('persist:xiaojing-boss');
    partition.protocol.handle('https',request=>{
      const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'};
      if(request.url===chat)return new Response(html,{headers});
      if(request.url===job)return new Response('<!doctype html><title>模拟岗位</title>',{headers});
      return new Response('',{status:403});
    });
    partition.protocol.handle('http',()=>new Response('',{status:403}));
    const fetch=globalThis.fetch;
    globalThis.inboxModelCalls=0;
    globalThis.fetch=async(input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url||input.href);
      if(url.href===model){globalThis.inboxModelCalls++;return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'skip',text:'',reason:'合成验证',score:0})}}]});}
      if(url.origin===local)return fetch(input,options);
      throw Error('Fixture blocked external network');
    };
  },{html,chat,job,model,local});
  const session=await(await fetch(local+'/api/session')).json();
  async function api(path,data){
    const response=await fetch(local+path,{method:data?'POST':'GET',headers:{'X-Boss-Token':session.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    const value=await response.json();
    assert(response.ok,value.error);
    return value;
  }
  const browser=(action,value)=>win.evaluate(({action,value})=>window.xiaojingDesktop.embedded(action,value),{action,value});
  const runPage=(id,code)=>app.evaluate(({webContents},{id,chat,code})=>{
    const contents=webContents.fromId(id);
    if(contents?.getURL()!==chat)throw Error('Synthetic chat tab is unavailable');
    return contents.executeJavaScript(code);
  },{id,chat,code});
  await api('/api/provider-key',{provider:'compatible',baseURL:'https://models.fixture.invalid/v1',key:'synthetic-only'});
  await api('/api/config',{learningEnabled:false,autoBrowse:false,chatInput:false,profile:{name:'模拟主人',facts:'合成测试资料',titles:['游戏策划'],cities:['北京']},modelRoutes:{reply:{provider:'compatible',model:'fixture-model'}}});
  await win.locator('#main-nav').getByRole('button',{name:'内置浏览器',exact:true}).click();
  await win.getByRole('button',{name:'打开内置浏览器',exact:true}).click();
  const primary=await until(async()=>(await browser('state')).tabs.find(tab=>tab.url===chat&&tab.ready),'Native primary chat did not load');
  const second=await browser('open-job',{url:job,bounds:{x:220,y:180,width:700,height:500}});
  assert.notEqual(second.activeTabId,primary.id);
  await until(async()=>(await browser('state')).tabs.find(tab=>tab.id===second.activeTabId&&tab.url===job&&tab.ready),'Second native tab did not settle');
  await browser('navigate','chat');
  const backup=await until(async()=>(await browser('state')).tabs.find(tab=>tab.id===second.activeTabId&&tab.url===chat&&tab.ready),'Warm backup chat did not load');
  await browser('select',primary.id);
  await api('/api/channels',{hrInbox:true});
  await until(()=>cursor()?.threads.find(([id,thread])=>id==='boss:fixture-a'&&thread.tailId==='old-a'),'Primary monitor did not persist its baseline');
  await runPage(primary.id,'window.incoming(true)');
  await until(()=>cursor()?.events.find(([id,event])=>id==='boss:fixture-b'&&event.preview==='新的模拟问题'),'Primary monitor did not persist the new unread event');
  assert.equal((await api('/api/replies/state')).items.length,0);
  await runPage(backup.id,'window.incoming(false)');
  assert.equal(await runPage(backup.id,'Boolean(document.querySelector(".notice-badge"))'),false);
  await browser('close-tab',primary.id);
  await api('/api/config',{autoBrowse:true});
  await until(async()=>(await api('/api/replies/state')).items.find(row=>row.peerId==='boss:fixture-b'&&row.status==='skip'),'Promoted native monitor did not recover the saved unread event');
  await until(()=>cursor()?.events.length===0,'Handled event was not removed from the durable inbox');
  assert.deepEqual(await runPage(backup.id,'window.fixture'),{switches:1,sends:0});
  assert.deepEqual((await api('/api/replies/state')).items.map(row=>row.peerId),['boss:fixture-b']);
  assert.equal(await app.evaluate(()=>globalThis.inboxModelCalls),1);
  console.log('Native monitor handoff recovered one durable unread event with no badge and no sends.');
}finally{
  if(app)await app.close();
  rmSync(profile,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
