import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {canRun} from '../server/core.mjs';
import {createSingleTest,verifyTestSelection,singleTestAllowed,verifySingleTestReceipt} from '../server/single-test.mjs';
import {testPort} from './port.mjs';
const request={name:'周女士',company:'测试游戏公司',text:'你好，我是DeepSeek小鲸，帮主人了解游戏策划实习机会。'};
const selection=id=>({planId:id,...request,uniquePeer:true,header:'周女士 测试游戏公司 HR',job:{title:'游戏策划实习',city:'北京'},messages:[{id:'hr-unique-1',role:'hr',text:'你好，感兴趣聊聊吗？'}]});
test('单条测试绑定唯一可见目标、岗位和消息编号，不接受拒绝后的打扰',()=>{
 const plan=createSingleTest(request);assert.equal(verifyTestSelection(plan,selection(plan.id)).company,request.company);
 for(const patch of [{company:'其他公司'},{header:'同名HR 其他公司'},{uniquePeer:false},{messages:[{id:'',role:'hr',text:'你好'}]},{job:{title:'高级策划'}},{messages:[{id:'x',role:'hr',text:'暂不考虑，请勿打扰'}]}])assert.throws(()=>verifyTestSelection(plan,{...selection(plan.id),...patch}));
 assert.throws(()=>verifyTestSelection(plan,selection(plan.id),plan.expiresAt+1));
});
test('重新核对必须来自新鲜的同一目标会话、新消息编号和完整正文',()=>{
 const now=Date.now(),plan={...createSingleTest(request,now),taskId:'task'},task={id:'task',singleTestPlanId:plan.id,status:'uncertain',peerId:'test',text:request.text,reservedAt:now-1000};
 const state={singleTest:plan,memories:{test:{window:[{id:'old'}]}}},inspection={url:'https://www.zhipin.com/web/geek/chat',at:now,nodes:[{attrs:{class:'friend-content selected'}},{attrs:{class:'name-text'},text:'周女士'},{attrs:{},text:'测试游戏公司'},{attrs:{class:'chat-conversation'}}],selfMessages:[{node:{attrs:{'data-mid':'new'}},text:'19:44 送达 '+request.text}]};
 assert.equal(verifySingleTestReceipt(state,task,inspection,now).messageId,'new');
 for(const patch of [{at:now-100000},{nodes:[]},{selfMessages:[{node:{attrs:{'data-mid':'old'}},text:request.text}]},{selfMessages:[{node:{attrs:{'data-mid':'new'}},text:'别的正文'}]}])assert.throws(()=>verifySingleTestReceipt(state,task,{...inspection,...patch},now));
 const onlySubstring={...inspection.selfMessages[0],text:'19:44 送达 '+request.text+'另有文字。'};
 assert.throws(()=>verifySingleTestReceipt(state,task,{...inspection,selfMessages:[onlySubstring]},now));
 assert.throws(()=>verifySingleTestReceipt(state,task,{...inspection,selfMessages:[...inspection.selfMessages,onlySubstring]},now));
});
async function fixture(t){
 const port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'whale-one-test-')),port,key:'fixture',inference:async()=>({action:'skip',text:'',reason:'fixture',score:0})});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 const api=async(path,data,owner=true)=>{const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});return {status:r.status,...await r.json()};};
 await api('/api/config',{profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京']},limits:{hoursStart:0,hoursEnd:24}});
 return {app,api};
}
test('仅主人可授权一条测试；使用原领取与核对队列，完成后暂停且不能再次领取',async t=>{
 const {app,api}=await fixture(t);assert.equal((await api('/api/single-test/start',request,false)).status,403);
 const {test:plan}=await api('/api/single-test/start',request),{task}=await api('/api/single-test/prepare',selection(plan.id),false);
 assert(task);assert.equal(app.state.config.browserCalibrated,false);assert(singleTestAllowed(app.state,task));
 assert.equal((await api('/api/single-test/prepare',selection(plan.id),false)).task.id,task.id);assert.equal(app.state.tasks.length,1);
 assert.equal(app.state.config.running,false);assert.equal(app.state.config.channels.jobSearch,false);assert.equal(app.state.config.channels.hrInbox,false);
 assert.equal(canRun(app.state,{...task,id:'unrelated',singleTestPlanId:undefined}),'已暂停');
 assert.equal((await api('/api/claim',{id:task.id,peerId:'wrong',fingerprint:task.fingerprint},false)).status,400);
 const lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);assert(lease.lease);
 assert((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false)).blocked);
 assert.equal((await api('/api/check',{id:task.id,lease:lease.lease},false)).allowed,true);
 await api('/api/complete',{id:task.id,lease:lease.lease,success:true,evidence:'同一目标会话出现本次文字'},false);
 assert.equal(app.state.singleTest.status,'sent');assert.equal(app.state.config.running,false);assert.equal(app.state.tasks[0].status,'sent');
 assert.equal(app.state.memories[task.peerId].sends.length,1);assert.match(app.state.memories[task.peerId].identityKind,/single-owner-test/);
 assert((await api('/api/single-test/prepare',selection(plan.id),false)).blocked);assert.equal(singleTestAllowed(app.state,task),false);
});
test('发送结果不明确时单条测试留为待核对，暂停后不会重发',async t=>{
 const {app,api}=await fixture(t),{test:plan}=await api('/api/single-test/start',request),{task}=await api('/api/single-test/prepare',selection(plan.id),false);
 const lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);
 await api('/api/complete',{id:task.id,lease:lease.lease,success:false,evidence:'会话变化，未确认发送'},false);
 assert.equal(app.state.singleTest.status,'uncertain');assert.equal(app.state.config.running,false);assert.equal(app.state.tasks[0].status,'uncertain');
 assert.equal(singleTestAllowed(app.state,task),false);assert((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false)).blocked);
});
