import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {createAccountRecheck} from '../server/account-recheck.mjs';
import {defaults} from '../server/core.mjs';
import {testPort} from './port.mjs';

const boss='https://www.zhipin.com';
const chat=boss+'/web/geek/chat';
const signIn=boss+'/web/user/';
const profile={...defaults.profile,name:'测试主人',titles:['游戏策划'],cities:['北京'],facts:'游戏策划实习测试资料'};
const chatProof={page:chat,accountForeground:true,accountSignal:'chat-workspace'};
const priorConversation={peerId:'boss:old-profile',header:'测试会话',job:{title:'游戏策划'},messages:[
  {id:'old-self',role:'self',text:'旧账号已经联系过这个岗位。'},
  {id:'new-hr',role:'hr',text:'您好，请介绍一下项目经历。'}
]};

async function start(t,local,extra={}){
  const port=await testPort(),app=createApplication({local,port,key:'fixture',resumeOnStart:true,
    inference:async()=>({action:'send_text',text:'可以介绍主人的游戏设计项目。',reason:'测试',score:90}),...extra});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  const close=async()=>{if(app.server.listening){const closed=once(app.server,'close');app.shutdown();await closed;}};
  t.after(close);
  const base='http://127.0.0.1:'+port;
  const session=await(await fetch(base+'/api/session')).json();
  let externalToken;
  async function pairExternal(){
    const challenge=app.prepareExternalBrowserPairing();challenge.activate();
    const response=await fetch(base+'/api/desktop-pair',{method:'POST',headers:{'Content-Type':'application/json',Origin:'chrome-extension://'+'a'.repeat(32)},body:JSON.stringify({code:challenge.code})});
    const body=await response.json();assert(response.ok,body.error);externalToken=body.extensionToken;
  }
  async function call(path,data,role='owner'){
    const token=role==='owner'?session.token:role==='embedded'?app.embeddedToken:externalToken||session.extensionToken;
    const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},
      ...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  }
  async function ok(...args){const result=await call(...args);assert(result.status<300,result.body.error);return result.body;}
  return {app,call,ok,close,pairExternal};
}

test('新工作区登录不要求核对原账号；已联系的旧档只接受可信站点与明确登录证据',()=>{
  let clock=1000;
  const state={config:{browserCalibrated:false},tasks:[],memories:{}};
  const check=createAccountRecheck(state,()=>clock);
  assert.deepEqual(check.observe({page:signIn},'external'),{login:true,locked:false});
  assert.equal(check.status().required,false);
  assert.equal(state.accountRecheck,undefined);
  state.memories.old={history:[{role:'self',id:'old-id'}]};
  assert.deepEqual(check.observe({page:chat,accountForeground:true,accountSignal:'captcha'},'external'),{});
  assert.deepEqual(check.observe({page:'https://www.zhipin.com.example.test/web/user/'},'external'),{});
  assert.deepEqual(check.observe({page:signIn,accountForeground:false},'external'),{});
  assert.equal(check.observe({page:signIn,accountForeground:false,accountSignal:'login-navigation'},'external').locked,true);
  assert.equal(check.status().reason,'login_observed');
  assert.throws(()=>check.confirm(true),/打开已有聊天/);
  assert.deepEqual(check.observe({...chatProof,accountForeground:false},'external'),{});
  assert.equal(check.status().canConfirm,false);
  check.observe(chatProof,'external');
  assert.equal(check.status().canConfirm,true);
  check.observe({page:boss+'/web/geek/job',accountForeground:true},'external');
  assert.equal(check.status().canConfirm,false);
  check.observe(chatProof,'external');
  clock+=45000;
  assert.equal(check.status().canConfirm,false);
  check.observe(chatProof,'external');
  assert.throws(()=>check.confirm(false),/全新工作区/);
  assert.equal(check.confirm(true).required,false);
  assert.equal(check.status().confirmedAt,clock);
  assert.equal(state.config.browserCalibrated,false);
  assert.deepEqual(state.memories.old.history,[{role:'self',id:'old-id'}]);
});

test('已核验的工作区看到登录时停用通道、撤销租约并保留旧历史；重启后仍需主人确认',async t=>{
  const local=mkdtempSync(join(tmpdir(),'boss-account-recheck-'));
  const first=await start(t,local);
  await first.ok('/api/config',{profile,backend:'api',mode:'auto',browserCalibrated:true,limits:{hoursStart:0,hoursEnd:24}});
  await first.ok('/api/channels',{jobSearch:true,hrInbox:true});
  const {task}=await first.ok('/api/prepare',{...priorConversation,kind:'reply',trigger:'new_hr_message'},'external');
  const {lease}=await first.ok('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'external');
  assert(lease);
  await first.ok('/api/heartbeat',{page:chat,accountForeground:true,accountSignal:'captcha'},'external');
  await first.ok('/api/heartbeat',{page:signIn},'owner');
  assert.equal(first.app.state.config.browserCalibrated,true);
  assert.equal((await first.ok('/api/check',{id:task.id,lease},'external')).allowed,true);
  const login=await first.ok('/api/heartbeat',{page:chat,accountForeground:true,accountSignal:'sign-in-ui',diagnostics:{peerId:'new-profile-private'}},'external');
  assert.equal(login.accountRecheck.required,true);
  assert.deepEqual(first.app.state.config.channels,{jobSearch:false,hrInbox:false});
  assert.equal(first.app.state.config.browserCalibrated,false);
  assert.equal(first.app.state.tasks.find(row=>row.id===task.id).status,'uncertain');
  assert.equal(first.app.state.tasks.find(row=>row.id===task.id).lease,undefined);
  assert.equal((await first.ok('/api/check',{id:task.id,lease},'external')).allowed,false);
  for(const [path,data,role] of [
    ['/api/observe',{...priorConversation,peerId:'boss:new-profile'},'external'],
    ['/api/claim',{id:task.id},'external'],
    ['/api/complete',{id:task.id,lease,success:true,evidence:'错误账号证据'},'external'],
    ['/api/search',{query:'游戏策划'},'owner']
  ])assert.equal((await first.call(path,data,role)).status,409);
  for(const [path,data] of [['/api/channels',{hrInbox:true}],['/api/config',{browserCalibrated:true}],['/api/config',{channels:{jobSearch:true}}],['/api/run',{running:true}]])assert.match((await first.call(path,data)).body.error,/核对当前 BOSS/);
  assert.equal((await first.call('/api/account-recheck',{sameAccount:true},'external')).status,403);
  assert.equal((await first.call('/api/account-recheck',{sameAccount:true})).status,400);
  assert.deepEqual(Object.keys((await first.ok('/api/state')).heartbeat.diagnostics),[]);
  await first.ok('/api/heartbeat',chatProof,'external');
  assert.equal((await first.ok('/api/state')).accountRecheck.canConfirm,true);
  const before=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));
  assert.equal(before.accountRecheck.required,true);
  assert.equal(before.accountRecheck.canConfirm,undefined);
  assert.deepEqual(Object.keys(before.memories),[priorConversation.peerId]);
  await first.close();

  const second=await start(t,local);
  assert.equal(second.app.state.accountRecheck.required,true);
  assert.deepEqual(second.app.state.config.channels,{jobSearch:false,hrInbox:false});
  assert.equal((await second.ok('/api/state')).accountRecheck.canConfirm,false);
  await second.ok('/api/heartbeat',chatProof,'external');
  assert.equal((await second.call('/api/account-recheck',{sameAccount:false})).status,400);
  assert.equal((await second.ok('/api/account-recheck',{sameAccount:true})).accountRecheck.required,false);
  assert.equal(second.app.state.config.browserCalibrated,false);
  assert.equal(second.app.state.config.running,false);
  assert.equal(second.app.state.memories[priorConversation.peerId].history[0].id,'old-self');
  await second.ok('/api/config',{browserCalibrated:true});
  assert.equal(second.app.state.config.browserCalibrated,true);
});

test('桌面版切换浏览器时仅旧已校准工作区需要复核，旧桥接凭据失效',async t=>{
  const local=mkdtempSync(join(tmpdir(),'boss-bridge-account-'));
  const first=await start(t,local,{desktop:true});
  await first.pairExternal();
  assert.equal((await first.ok('/api/state')).accountRecheck.required,false);
  await first.ok('/api/config',{profile,browserCalibrated:true});
  assert(first.app.selectBrowserBridge('embedded'));
  assert.equal((await first.ok('/api/state')).accountRecheck.reason,'bridge_switch');
  assert.equal((await first.call('/api/heartbeat',chatProof,'external')).status,401);
  await first.ok('/api/heartbeat',chatProof,'embedded');
  assert.equal((await first.ok('/api/account-recheck',{sameAccount:true})).accountRecheck.required,false);
  await first.ok('/api/config',{browserCalibrated:true});
  await first.pairExternal();
  await first.ok('/api/heartbeat',chatProof,'external');
  await first.ok('/api/account-recheck',{sameAccount:true});
  await first.close();

  const restarted=await start(t,local,{desktop:true});
  assert.equal(restarted.app.activeBrowserBridge(),'embedded');
  assert.equal((await restarted.ok('/api/state')).accountRecheck.reason,'bridge_switch');
});
