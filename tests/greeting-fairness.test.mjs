import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const jobURL='https://www.zhipin.com/job_detail/greeting-fairness-fixture.html';
const replyResult={action:'send_text',text:'您好，小鲸已收到您的项目问题。',reason:'测试回复',score:95};
const greetingResult={action:'send_text',text:'您好，我是小鲸，帮主人了解这个游戏策划实习。',reason:'测试招呼',score:95};
const input=id=>({kind:'reply',trigger:'new_hr_message',peerId:'boss:fairness-'+id,
  label:{name:'合成 HR '+id,company:'合成游戏公司'},header:'合成游戏公司 招聘者',
  job:{title:'游戏策划实习'},messages:[{id:'hr-'+id,role:'hr',text:'您好，请介绍一下游戏设计经历。'}]});

async function until(predicate){
  for(let attempt=0;attempt<100;attempt++){
    const value=predicate();
    if(value)return value;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('测试状态未到达');
}

async function fixture(t){
  const port=await testPort(),calls=[];
  let active=0,maxActive=0;
  const app=createApplication({
    local:mkdtempSync(join(tmpdir(),'xiaojing-greeting-fairness-')),port,key:'fixture',greetingIntervalMs:60000,replyIntervalMs:10,
    inference:async(_config,_key,context,signal)=>{
      active++;
      maxActive=Math.max(maxActive,active);
      try{
        return await new Promise((resolve,reject)=>{
          calls.push({kind:context.kind,peerId:context.memory?.peerId,
            finish:()=>resolve(context.kind==='greeting'?greetingResult:replyResult)});
          signal.addEventListener('abort',()=>reject(Error('测试已关闭')),{once:true});
        });
      }finally{active--;}
    }
  });
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>{app.server.once('close',resolve);app.shutdown();app.server.closeAllConnections();}));
  const base='http://127.0.0.1:'+port,{token,extensionToken}=await(await fetch(base+'/api/session')).json();
  async function api(path,data,owner=false){
    const response=await fetch(base+path,{method:data?'POST':'GET',headers:{
      'Content-Type':'application/json','X-Boss-Token':owner?token:extensionToken
    },...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json();
    assert(response.ok,result.error);
    return result;
  }
  await api('/api/config',{backend:'api',mode:'auto',browserCalibrated:true,learningEnabled:false,autoResume:false,
    limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},
    profile:{name:'测试主人',facts:'已核实的模拟资料',titles:['游戏策划'],cities:['北京'],earlyCareerOnly:true}},true);
  await api('/api/run',{running:true},true);
  await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/job',diagnostics:{extensionVersion:'0.13.2',adapter:'0.13.2'}});
  async function plan({ready=true}={}){
    const {ids}=await api('/api/jobs/observe',{jobs:[{url:jobURL,title:'游戏策划实习',company:'合成游戏公司',
      city:'北京',experience:'在校实习',description:'游戏系统策划实习，包含玩法原型验证、游戏测试和数值设计，面向2027届本科在校学生。'}]});
    if(ready)app.state.jobs[ids[0]].status='ready';
    return (await api('/api/greetings',{requestId:'fairness-plan',instruction:'了解这份已筛选的实习岗位',count:1},true)).plan;
  }
  return {app,api,plan,calls,maxActive:()=>maxActive,enqueue:id=>api('/api/replies/enqueue',input(id))};
}

test('HR 一路生成时，另一空位可以生成招呼；站内执行依然只允许一个发送',async t=>{
  const {app,api,plan,calls,maxActive,enqueue}=await fixture(t),greeting=await plan();
  await enqueue('a');
  await until(()=>calls[0]);
  const work=api('/api/work');
  const greetingCall=await until(()=>calls.find(call=>call.kind==='greeting'));
  assert.equal(app.state.replyQueue[0].status,'generating');
  greetingCall.finish();
  const {task}=await work;
  assert.equal(task.greetingPlanId,greeting.id);
  assert.equal(maxActive(),2);
  calls[0].finish();
  const reply=await until(()=>app.state.tasks.find(row=>row.kind==='reply'));
  const claimed=await api('/api/claim',{id:reply.id,peerId:reply.peerId,fingerprint:reply.fingerprint});
  assert(claimed.lease);
  assert.match((await api('/api/claim',{id:task.id,url:jobURL})).blocked,/已有发送任务执行中/);
  assert.equal(app.state.tasks.filter(row=>row.status==='executing').length,1);
});

test('两路回复生成占满时，等待中的招呼在首个空位继续，队列里的 HR 仍会随后处理',async t=>{
  const {app,api,plan,calls,maxActive,enqueue}=await fixture(t);
  const greeting=await plan();
  for(const id of ['a','b','c','d'])await enqueue(id);
  await until(()=>calls.length===2);
  assert.equal((await api('/api/work')).task,null);
  assert.match(app.state.greetingPlans[0].waitingReason,/模型空出位置/);
  calls[0].finish();
  const next=await until(()=>calls[2]);
  assert.equal(next.kind,'greeting');
  assert.equal(app.state.replyQueue.filter(row=>row.status==='queued').length,2);
  next.finish();
  const following=await until(()=>calls[3]);
  assert.equal(following.peerId,'boss:fairness-c');
  calls[1].finish();
  const last=await until(()=>calls[4]);
  assert.equal(last.peerId,'boss:fairness-d');
  following.finish();
  last.finish();
  await until(()=>app.state.replyQueue.every(row=>row.status==='ready'));
  assert.equal((await api('/api/work')).task.greetingPlanId,greeting.id);
  assert.equal(maxActive(),2);
});

test('招呼委托在等待模型空位时被取消，下一条 HR 回复照常获得空位',async t=>{
  const {app,api,plan,calls,maxActive,enqueue}=await fixture(t);
  const greeting=await plan();
  for(const id of ['a','b','c'])await enqueue(id);
  await until(()=>calls.length===2);
  assert.equal((await api('/api/work')).task,null);
  await api('/api/operations/cancel',{kind:'greeting',id:greeting.id},true);
  calls[0].finish();
  const next=await until(()=>calls[2]);
  assert.equal(next.kind,'reply');
  assert.equal(next.peerId,'boss:fairness-c');
  calls[1].finish();
  next.finish();
  await until(()=>app.state.replyQueue.every(row=>row.status==='ready'));
  assert.equal(app.state.greetingPlans[0].status,'cancelled');
  assert.equal(maxActive(),2);
});
