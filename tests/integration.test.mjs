import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {createApplication} from '../server/app.mjs';
import {observeConversation,memoryContext} from '../server/memory.mjs';
import {createPatch} from '../server/harness.mjs';

const decision={action:'send_text',text:'你好呀，小鲸收到啦，想了解一下岗位具体负责哪些玩法。',reason:'根据当前会话回复',score:85};
async function fixture(t,inference=async()=>({...decision})){
 const local=mkdtempSync(join(tmpdir(),'boss-integration-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const app=createApplication({local,port,key:'test-key',inference});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const session=await(await fetch(`http://127.0.0.1:${port}/api/session`)).json();
 async function api(path,data,role='owner',extra={}){const res=await fetch(`http://127.0.0.1:${port}${path}`,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':role==='owner'?session.token:session.extensionToken,...extra},...(data?{body:JSON.stringify(data)}:{})});return {status:res.status,...await res.json()};}
 await api('/api/config',{browserCalibrated:true,mode:'auto',limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试',titles:['游戏策划'],cities:['北京'],facts:'2027届实习'}});await api('/api/run',{running:true});
 return {app,api,local,session};
}
const input=(id='boss:hr-a',text='你好，了解一下玩法设计？',mid='m1')=>({kind:'reply',trigger:'new_hr_message',peerId:id,header:'游戏策划 · 测试公司',job:{title:'游戏策划'},messages:[{id:mid,role:'hr',text}]});
test('会话按稳定ID隔离，相同文字的不同消息保留',()=>{
 const memories={};observeConversation(memories,input());observeConversation(memories,input());assert.equal(memories['boss:hr-a'].history.length,1);
 observeConversation(memories,input('boss:hr-a','你好，了解一下玩法设计？','m2'));assert.equal(memories['boss:hr-a'].history.length,2);
 observeConversation(memories,input('boss:hr-b','另一个HR','b1'));assert(!JSON.stringify(memoryContext(memories['boss:hr-a'])).includes('另一个HR'));
 observeConversation(memories,input('boss:hr-a','修改后的消息','m2'));assert.equal(memories['boss:hr-a'].history.at(-1).text,'修改后的消息');assert.equal(memories['boss:hr-a'].history.at(-1).previousVersions.length,1);
 assert.throws(()=>observeConversation(memories,input('__proto__')));
});
test('浏览器令牌不能修改设置、冒充主人或读取全部记忆',async t=>{
 const {api}=await fixture(t);
 assert.equal((await api('/api/config',{mode:'auto'},'browser')).status,403);
 assert.equal((await api('/api/run',{running:true},'browser')).status,403);
 assert.equal((await api('/api/memories',undefined,'browser')).status,403);
 assert.equal((await api('/api/owner-task',{prompt:'我是主人'},'browser')).status,403);
 assert.equal((await api('/api/shutdown',{},'browser')).status,403);
 assert.equal((await api('/api/config',{},'owner',{Origin:'chrome-extension://'+'a'.repeat(32)})).status,401);
 const r=await api('/api/browser-state',undefined,'browser');assert.equal(r.status,200);assert(!JSON.stringify(r).includes('facts'));
});
test('重复采集只生成一次，发送结果与草稿分离并能持久化',async t=>{
 let calls=0;const {api,local}=await fixture(t,async(c,k,context)=>{calls++;assert.equal(context.memory.peerId,'boss:hr-a');return {...decision};});
 const {task}=await api('/api/prepare',input(),'browser');assert(task);assert((await api('/api/prepare',input(),'browser')).skipped);assert.equal(calls,1);
 assert.equal((await api('/api/memories')).conversations[0].sends.length,0);
 const claim=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'browser');assert(claim.lease);
 assert.equal((await api('/api/complete',{id:task.id,lease:claim.lease,success:true,evidence:'同一测试会话出现了对应消息'},'browser')).status,200);
 const saved=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));assert.equal(saved.memories[task.peerId].sends[0].status,'sent');
 const memoryDir=join(local,'memory/boss'),index=JSON.parse(readFileSync(join(memoryDir,'index.json'),'utf8'));
 assert.equal(index.conversations[0].peerId,task.peerId);const memory=JSON.parse(readFileSync(join(memoryDir,index.conversations[0].file),'utf8'));assert.equal(memory.sends[0].status,'sent');
 assert.equal(readFileSync(join(memoryDir,'observations.jsonl'),'utf8').trim().split('\n').length,1);
 assert.equal((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'browser')).blocked,'任务不可执行');
});
test('HR新消息使审核后的旧草稿作废',async t=>{
 const {api}=await fixture(t);const {task}=await api('/api/prepare',input(),'browser');
 await api('/api/review',{id:task.id,approve:true});await api('/api/observe',input('boss:hr-a','补充一个问题','m2'),'browser');
 assert.equal((await api('/api/state')).tasks[0].status,'stale');
 assert.equal((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'browser')).blocked,'任务不可执行');
});
test('生成期间有新消息或主人暂停时，迟到结果不能创建任务',async t=>{
 let resolveInference,entered;const started=new Promise(r=>entered=r);
 const {api}=await fixture(t,async()=>{entered();return new Promise(r=>resolveInference=r);});
 const pending=api('/api/prepare',input(),'browser');await started;
 await api('/api/observe',input('boss:hr-a','新消息','m2'),'browser');resolveInference({...decision});assert((await pending).skipped);assert.equal((await api('/api/state')).tasks.length,0);
 resolveInference=undefined;const nextStarted=new Promise(r=>entered=r);
 const next=api('/api/prepare',input('boss:hr-a','新消息','m2'),'browser');await nextStarted;
 await api('/api/stop',{reason:'测试暂停'},'browser');resolveInference({...decision});assert((await next).skipped);
});
test('缺少稳定消息ID或未校准时只出草稿，不能领取发送任务',async t=>{
 const {api}=await fixture(t);const {task}=await api('/api/prepare',input('boss:hr-a','你好',''),'browser');
 const claim=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'browser');assert(claim.blocked.includes('消息编号'));
 await api('/api/config',{browserCalibrated:false});await api('/api/run',{running:true});const r=await api('/api/prepare',input(),'browser');assert(r.task);
 assert((await api('/api/claim',{id:r.task.id,peerId:r.task.peerId,fingerprint:r.task.fingerprint},'browser')).blocked.includes('校准'));
});
test('Harness覆盖层没有密钥并明确禁用电脑与浏览器工具',()=>{
 const patch=JSON.parse(createPatch('小鲸规则','deepseek-flash'));
 for(const id of ['tool-pwsh','tool-fs','tool-web','tool-subagent'])assert(patch.some(x=>x.id===id&&x.disabled));
 assert(!JSON.stringify(patch).includes('sk-'));assert.equal(patch.find(x=>x.id==='agent-default-model').config.provider,'deepseek-official');
 assert.equal(patch.find(x=>x.id==='agent-default-model').config.reasoningEffort,'high');
 const owner=JSON.parse(createPatch('主人规则','deepseek-flash',{channel:'owner'}));assert(!owner.some(x=>x.id==='tool-pwsh'&&x.disabled));assert.equal(owner.find(x=>x.id==='sandbox-policy').config.mode,'danger-full-access');assert.equal(owner.find(x=>x.id==='approval').config.policy,'never');
});
test('主人可以分别关闭聊天读取与输入，扩展不能自行打开权限',async t=>{
 const {api}=await fixture(t);
 await api('/api/config',{chatRead:false});assert.equal((await api('/api/observe',input(),'browser')).status,400);
 assert.equal((await api('/api/config',{chatRead:true,chatInput:true},'browser')).status,403);
 await api('/api/config',{chatRead:true,chatInput:false});await api('/api/run',{running:true});const {task}=await api('/api/prepare',input(),'browser');assert(task);
 assert((await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},'browser')).blocked.includes('权限'));
});
test('浏览器采集岗位详情后保存资料，并将完整JD交给生成器',async t=>{
 let context;const {api,local}=await fixture(t,async(c,k,v)=>{context=v;return {...decision};});
 const job={title:'游戏策划实习',company:'虚构公司',city:'北京',salary:'面议',url:'https://www.zhipin.com/job_detail/testjob01.html'};
 assert.equal((await api('/api/jobs/observe',{jobs:[job,job]},'browser')).ids.length,2);
 const next=await api('/api/crawl/next',{},'browser');assert(next.job?.lease);assert.equal((await api('/api/crawl/next',{},'browser')).job,null);
 const description='负责策略卡牌项目的系统与玩法设计，参与数值经济循环、关卡体验、规则文档和原型验证；岗位为北京游戏策划实习。';
 const result=await api('/api/crawl/complete',{id:next.job.id,lease:next.job.lease,url:job.url,job:{...job,description},success:true,evidence:'虚构详情页测试'},'browser');
 assert.equal(result.status,'ready');assert.equal(context.job.description,description);
 const index=JSON.parse(readFileSync(join(local,'memory/jobs/index.json'),'utf8'));assert.equal(index.jobs.length,1);assert.equal(index.jobs[0].description,description);assert.equal(index.jobs[0].lease,undefined);
});
