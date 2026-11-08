// Real Electron renderer loss with an isolated BOSS fixture. No live site or model traffic.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=realpathSync(tmpdir());
const profile=realpathSync(mkdtempSync(join(temporary,'xiaojing-crash-send-test-')));
assert.equal(dirname(profile),temporary);
const packagedExe=process.argv[2],executablePath=packagedExe||join(root,'tools','cache','electron','runtime','electron.exe');
const port=await testPort(),origin='http://127.0.0.1:'+port;
const chat='https://www.zhipin.com/web/geek/chat',model='https://models.fixture.invalid/v1';
const html=readFileSync(new URL('./fixtures/desktop-embedded-chat.html',import.meta.url),'utf8');
const text='您好，想替主人问一下，简历目前的筛选进度如何？';
let app;

async function until(check,description,timeout=15000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){const value=await check();if(value)return value;await wait(100);}
  throw Error(description+' did not settle');
}

try{
  app=await electron.launch({executablePath,args:packagedExe?[]:[resolve(root)],env:{...process.env,XIAOJING_DESKTOP_HOME:profile,XIAOJING_DESKTOP_PORT:String(port)},timeout:25000});
  const win=await app.firstWindow({timeout:25000});
  await win.locator('#main-nav').getByRole('button',{name:'工作台',exact:true}).waitFor();
  await app.evaluate(({session},{html,chat,model,origin,text})=>{
    globalThis.crashFixture={chatLoads:0,modelCalls:0};
    const partition=session.fromPartition('persist:xiaojing-boss');
    partition.protocol.handle('https',request=>{
      if(request.url!==chat)return new Response('',{status:403});
      crashFixture.chatLoads++;
      return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
    });
    partition.protocol.handle('http',()=>new Response('',{status:403}));
    const fetchOriginal=globalThis.fetch;
    globalThis.fetch=(input,options)=>{
      const endpoint=new URL(typeof input==='string'?input:input.href||input.url);
      if(endpoint.origin===origin)return fetchOriginal(input,options);
      if(endpoint.href!==model+'/chat/completions')throw Error('Fixture blocked external network');
      crashFixture.modelCalls++;
      return Promise.resolve(Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'send_text',text,reason:'仅合成验证',score:96})}}]}));
    };
  },{html,chat,model,origin,text});

  const {token}=await(await fetch(origin+'/api/session')).json();
  async function request(path,data){
    const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{})});
    return {ok:response.ok,status:response.status,value:await response.json()};
  }
  async function api(path,data){const response=await request(path,data);assert(response.ok,response.value.error);return response.value;}
  const browser=()=>win.evaluate(()=>window.xiaojingDesktop.embedded('state'));
  const chatFixture=id=>app.evaluate(async({webContents},id)=>{
    const view=webContents.fromId(id);
    return view&&!view.isCrashed()?view.executeJavaScript('window.fixture'):null;
  },id);
  async function taskFor(plan){
    const state=await api('/api/state');
    const target=state.ownerChats.find(item=>item.id===plan.id)?.targets[0];
    return state.tasks.find(task=>task.id===target?.taskId);
  }
  await api('/api/provider-key',{provider:'compatible',baseURL:model,key:'fixture-embedded-key'});
  const route={provider:'compatible',model:'fixture-model'};
  await api('/api/config',{learningEnabled:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},profile:{name:'测试用户',facts:'合成测试资料',titles:['游戏策划'],cities:['北京']},modelRoutes:{reply:route,followup:route}});
  await win.locator('#main-nav').getByRole('button',{name:'内置浏览器',exact:true}).click();
  await win.getByRole('button',{name:'打开内置浏览器',exact:true}).click();
  const original=await until(async()=>{const state=await browser();return state?.ready&&state.url===chat&&state.activeTabId;},'Original chat');
  const fixture=await chatFixture(original);
  await api('/api/config',{browserCalibrated:true});
  await api('/api/channels',{hrInbox:true});
  await until(async()=>{const state=await api('/api/state');return state.heartbeat?.page===chat&&state.workerHealth?.phase==='仅保持HR新消息监听';},'Initial monitor');
  const input=(peer,requestId)=>({kind:'followup',requestId,instruction:'询问之前提交的简历目前筛选进度如何',targets:[fixture.peers[peer]]});
  const {plan}=await api('/api/owner-chat',input('silent','fixture-crash'));
  await until(async()=>{const page=await chatFixture(original);return page?.clicks.some(item=>item.peer==='silent');},'Synthetic click without receipt');
  assert.equal((await taskFor(plan)).status,'executing');
  await app.evaluate(({webContents},id)=>new Promise(resolve=>{
    const view=webContents.fromId(id);
    view.once('render-process-gone',()=>resolve());
    view.forcefullyCrashRenderer();
  }),original);
  const crashedAt=Date.now();
  const uncertain=await until(async()=>{const task=await taskFor(plan);return task?.status==='uncertain'&&task;},'Crashed send released without timeout',5000);
  assert.match(uncertain.evidence,/待核对/);
  const releasedAfterMs=Date.now()-crashedAt;
  const replacement=await until(async()=>{const state=await browser();return state.tabs.find(tab=>tab.url===chat&&tab.id!==original&&tab.ready);},'Replacement monitor');
  assert.equal((await browser()).tabs.find(tab=>tab.id===original).unavailable,true);
  assert.equal(replacement.active,false);
  assert.deepEqual((await chatFixture(replacement.id)).clicks,[]);
  const duplicate=await request('/api/owner-chat',input('silent','fixture-crash-retry'));
  assert.equal(duplicate.status,400);assert.match(duplicate.value.error,/结果待核对/);

  const unrelated=await api('/api/owner-chat',input('exact','fixture-crash-other-peer'));
  const sent=await until(async()=>{const task=await taskFor(unrelated.plan);return task?.status==='sent'&&task;},'Unrelated recipient sends after crash');
  assert.match(sent.evidence,/fixture-new-mid-exact/);
  assert.deepEqual((await chatFixture(replacement.id)).clicks.map(item=>item.peer),['exact']);
  assert.equal((await taskFor(plan)).status,'uncertain');
  assert.deepEqual(await app.evaluate(()=>globalThis.crashFixture),{chatLoads:2,modelCalls:2});
  console.log(JSON.stringify({actualElectronCrash:true,releasedAfterMs,exactCrashedSendUncertain:true,unrelatedSyntheticSendConfirmed:true,oldSendNeverRepeated:true,actualRecruitersContacted:0}));
}finally{
  if(app)await app.close().catch(()=>{});
  rmSync(profile,{recursive:true,force:true});
}
