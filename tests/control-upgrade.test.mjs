import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,appendFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createControlStore,operationRows,operationBoard,cancelPlan} from '../server/control.mjs';
import {createContinuityStore} from '../server/continuity.mjs';
import {createLearningStore} from '../server/learning.mjs';
import {buildProjectMap} from '../server/project-map.mjs';
import {createApplication} from '../server/app.mjs';
import {createOwnerChat} from '../server/owner-chat.mjs';
import {testPort} from './port.mjs';
const temp=name=>mkdtempSync(join(tmpdir(),name));
const bare=()=>({config:{running:true,backend:'harness',model:'deepseek-flash',limits:{hoursStart:8,hoursEnd:23}},tasks:[],ownerTasks:[],ownerChats:[],memories:{}});
test('任务观察记录可跨重启检索，重复观察不重复追加，不保存执行令牌',()=>{
 const dir=temp('control-journal-'),store=createControlStore(dir),state=bare();state.ownerTasks.push({id:'task-1',prompt:'测试 sk-abcdefghijklmnop',status:'running',at:10});state.tasks.push({id:'msg-1',kind:'reply',status:'approved',job:{title:'策划实习'},lease:'PRIVATE_LEASE',at:20});store.reconcile(state);store.reconcile(state);assert.equal(store.events().events.length,2);
 state.ownerTasks[0].status='done';state.ownerTasks[0].result='报告声称发了，但没有回显';state.ownerTasks[0].finishedAt=30;store.reconcile(state);assert.equal(store.events().events.length,3);assert.match(operationRows(state).find(r=>r.id==='task-1').reason,/回显/);
 const raw=readFileSync(join(dir,'events.jsonl'),'utf8');assert(!raw.includes('PRIVATE_LEASE'));assert(!raw.includes('sk-abcdefghijklmnop'));
 appendFileSync(join(dir,'events.jsonl'),'bad partial line\n');const recovered=createControlStore(dir);recovered.reconcile(state);assert.equal(recovered.events().events.length,3);state.tasks[0].status='sent';recovered.reconcile(state);assert.equal(recovered.events({kind:'message',id:'msg-1',after:3}).events[0].sequence,4);
});
test('停止指定委托不取消其他任务；执行中的发送不能被伪称撤回',()=>{
 const state=bare(),input=id=>({requestId:id,kind:'followup',instruction:'追问进展',targets:[{name:id,company:'测试游戏'}]}),a=createOwnerChat(input('甲')),b=createOwnerChat(input('乙'));state.ownerChats=[a,b];a.targets[0].status='generating';a.targets[0].peerId='boss:a';state.tasks=[{id:'a',ownerChatPlanId:a.id,status:'approved'},{id:'b',ownerChatPlanId:b.id,status:'approved'}];assert.deepEqual(cancelPlan(state,a),['boss:a']);assert.equal(b.status,'queued');assert.equal(state.tasks[1].status,'approved');assert.equal(state.config.running,true);assert.equal(state.tasks[0].status,'stale');
 state.tasks[1].status='executing';assert.throws(()=>cancelPlan(state,b),/发送/);assert.equal(b.status,'queued');
});
test('跨会话检查点来自实际记录，旧报告只保存短摘要，重启后保留',()=>{
 const dir=temp('continuity-'),store=createContinuityStore(dir),s=bare();s.ownerTasks=[{id:'old',prompt:'上次任务',result:'sk-abcdefghijklmnop '+'长报告'.repeat(5000),status:'done',at:1}];s.tasks=[{id:'receipt',status:'sent'},{id:'unknown',status:'uncertain'}];const c=store.capture(s);assert.equal(c.counts.verifiedSends,1);assert.equal(c.counts.unconfirmedSends,1);assert(c.recentOwnerTasks[0].resultPreview.length<=400);assert(!JSON.stringify(c).includes('sk-'));assert.equal(createContinuityStore(dir).get().counts.verifiedSends,1);assert.equal(store.capture(s).savedAt,c.savedAt);
});
test('记忆先返回索引再读取详情，HR观察按会话筛选，停用条目不进入默认召回',()=>{
 const store=createLearningStore(temp('recall-'));const note=store.ownerNote('主人希望优先了解游戏关卡策划和真实职责。');
 for(const id of ['boss:a','boss:b']){store.enqueue('conversation',id,{header:id,messages:[{text:'这个HR明确表示更重视关卡设计和地图原型经验。'}]});const q=store.next(10);store.begin(q);store.finish(q,{notes:[{category:'hr_context',text:'该HR更重视关卡设计和地图原型经验。',evidence:'这个HR明确表示更重视关卡设计和地图原型经验。'}]});}
 const found=store.search({query:'关卡',peerId:'boss:a'});assert(found.items.some(n=>n.id===note.id));assert(found.items.every(n=>!n.scope.peerId||n.scope.peerId==='boss:a'));assert(found.items.every(n=>!Object.hasOwn(n,'evidence')));assert.equal(store.get(note.id).evidence,'主人在本地控制台直接填写');store.review(note.id,'disabled');assert(!store.search({query:'关卡'}).items.some(n=>n.id===note.id));
 const ctx=store.ownerContext('关卡');assert([...ctx.owner_notes,...ctx.observations].reduce((n,x)=>n+x.text.length+x.evidence.length+200,0)<=3000);
});
test('工程地图根据实际源码生成，接口有调用方，密钥和聊天目录不参与扫描',()=>{
 const root=new URL('../',import.meta.url).pathname.replace(/^\/([A-Z]:)/i,'$1');const map=buildProjectMap(root);assert(map.files.some(f=>f.id==='server/control.mjs'));assert(map.edges.some(e=>e.from==='server/app.mjs'&&e.to==='server/control.mjs'));assert(map.endpoints.some(e=>e.path==='/api/operations'&&e.access==='仅本机用户'&&e.callers.includes('public/control.js')));assert(map.files.every(f=>/^(server|public|extension)\//.test(f.path)));assert(map.flows.every(f=>f.steps.every(id=>map.files.some(n=>n.id===id))));
});
async function appFixture(t,options={}){
 const local=temp('control-api-'),port=await testPort(),app=createApplication({local,port,key:'fixture',inference:async()=>({action:'hold',text:'',reason:'测试不发送',score:90}),...options});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(d?{body:JSON.stringify(d)}:{})});return {status:r.status,...await r.json()};};await api('/api/config',{learningEnabled:false,profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京']}});return {app,api,local};
}
test('任务中心先筛选全量记录再分页，保留进行中优先和同一时间的原始顺序',()=>{
 const state=bare();
 const statuses=['running','queued','reading','generating','ready','pending','approved','executing','uncertain','hold','error','failed','interrupted','finished_with_issues','timed_out','expired','stale','rejected'];
 state.tasks=statuses.map((status,index)=>({id:status,status,at:index+2,reason:'共同原因'}));
 state.tasks.push(...Array.from({length:45},(_,index)=>({id:'archive-'+index,status:'sent',at:100+index,reason:'普通历史任务'})));
 state.ownerTasks=[{id:'owner-first',status:'running',prompt:'相同时间的主人任务',at:2}];
 state.tasks.push({id:'old',status:'sent',at:1,job:{title:'Archive'},reason:'Oldest match sk-abcdefghijklmnop'});
 const first=operationBoard(state),middle=operationBoard(state,{page:2}),last=operationBoard(state,{page:900});
 const full=operationRows(state);
 assert.equal(first.total,65);assert.equal(first.active,9);assert.equal(first.matched,65);assert.equal(first.pages,3);
 assert.deepEqual([first.items.length,middle.items.length,last.items.length],[30,30,5]);
 assert.deepEqual([...first.items,...middle.items,...last.items],full);
 assert.deepEqual(first.items.slice(7,9).map(row=>row.id),['owner-first','running']);
 assert.equal(last.page,3);assert.equal(last.items.at(-1).id,'old');
 assert.deepEqual(operationBoard(state,{filter:'active'}).items.map(row=>row.id),full.slice(0,9).map(row=>row.id));
 assert.deepEqual(operationBoard(state,{filter:'attention'}).items.map(row=>row.status),['pending','timed_out','finished_with_issues','interrupted','failed','error','hold','uncertain']);
 const search=operationBoard(state,{q:'  回复hr OLDEST  ',page:99});
 assert.equal(search.page,1);assert.equal(search.total,65);assert.equal(search.active,9);assert.deepEqual(search.items.map(row=>row.id),['old']);
 assert.deepEqual(operationBoard(state,{q:'sk-abcdefghijklmnop',page:-4}),{items:[],total:65,active:9,matched:0,page:1,pages:1});
});
test('任务中心分页仅主人可用，未分页清单及跨页详情保留完整数据',async t=>{
 const {app,api}=await appFixture(t);
 app.state.ownerChats.push({id:'plan-old',status:'finished_with_issues',kind:'read',createdAt:1,targets:[{id:'target',company:'测试公司',name:'测试联系人',status:'failed',reason:'只在详细记录显示的内容'}]});
 app.state.greetingPlans.push({id:'greet-old',status:'finished_with_issues',requested:1,sent:0,createdAt:2,targets:[{id:'greet-target',company:'另一公司',title:'策划',status:'failed',reason:'招呼详情'}]});
 app.state.tasks.push(...Array.from({length:30},(_,index)=>({id:'recent-'+index,status:'sent',at:3+index})));
 const path='/api/operations?view=board';
 assert.equal((await api(path,undefined,false)).status,403);
 const first=await api(path);assert.equal(first.status,200);assert.equal(first.total,32);assert.equal(first.items.length,30);assert.equal(first.pages,2);
 const legacy=await api('/api/operations');assert.equal(legacy.version,1);assert.equal(legacy.items.length,32);
 assert(legacy.items.find(row=>row.id==='plan-old').targets.length);assert(legacy.items.find(row=>row.id==='greet-old').targets.length);
 const detail=await api('/api/operations/detail',{kind:'plan',id:'plan-old'});
 assert.equal(detail.operation.targets[0].reason,'只在详细记录显示的内容');
 const second=await api(path+'&page=2');assert.equal(second.page,2);assert.deepEqual(second.items.map(row=>row.id),['greet-old','plan-old']);assert(second.items.every(row=>!Object.hasOwn(row,'targets')));
});
test('MCP任务摘要先筛类型后限制数量，仅返回可共享的字段且仍需主人认证',async t=>{
 const {app,api}=await appFixture(t);
 app.state.tasks.push(...Array.from({length:55},(_,index)=>({id:'message-'+index,status:'sent',at:3+index,reason:'私聊回显和发送原因'})));
 app.state.ownerTasks.push({id:'owner-old',status:'error',prompt:'主人指令原文',result:'主人任务报告原文',at:1,finishedAt:2},{id:'owner-current',status:'running',prompt:'本轮主人指令',at:1});
 app.state.ownerChats.push({id:'old-plan',kind:'read',status:'finished_with_issues',createdAt:1,targets:[{id:'target',company:'测试公司',name:'历史联系人姓名',status:'failed',reason:'历史联系人私聊内容'}]});
 const path='/api/operations?view=summary';
 assert.equal((await api(path,undefined,false)).status,403);
 assert.equal((await api(path+'&kind=unknown')).status,400);
 const owner=await api(path+'&kind=owner&limit=1');
 assert.deepEqual(owner,{status:200,version:1,total:2,items:[{id:'owner-current',kind:'owner',status:'running',title:'主人任务',updatedAt:1,done:0,total:1,active:true}]});
 const plan=await api(path+'&kind=plan');
 assert.deepEqual(plan,{status:200,version:1,total:1,items:[{id:'old-plan',kind:'plan',status:'finished_with_issues',title:'会话委托',updatedAt:1,done:1,total:1,active:false}]});
 const all=await api(path);assert.equal(all.total,58);assert.equal(all.items.length,20);assert.equal(all.items[0].id,'owner-current');
 const capped=await api(path+'&kind=message&limit=900');assert.equal(capped.total,55);assert.equal(capped.items.length,50);
 assert.deepEqual(capped.items[0],{id:'message-54',kind:'message',status:'sent',title:'回复HR',updatedAt:57,done:1,total:1,active:false});
 assert.equal((await api(path+'&kind=message&limit=0')).items.length,1);
 const unscoped=await api('/api/operations');assert.equal(unscoped.items.length,58);assert(unscoped.items.some(row=>row.title==='主人指令原文'&&row.reason==='主人任务报告原文'));assert(unscoped.items.some(row=>row.targets?.some(target=>target.name==='历史联系人姓名')));
 const board=await api('/api/operations?view=board');assert.equal(board.items[0].title,'本轮主人指令');
});
test('控制与项目记忆接口仅主人可用，任务停止有独立范围且主人请求重试幂等',async t=>{
 let calls=0,payload;const {app,api,local}=await appFixture(t,{ownerInference:async(p,signal)=>{calls++;payload=p;await new Promise((r,j)=>signal.addEventListener('abort',()=>j(Error('cancelled')),{once:true}));return {text:'不应返回'};}});await api('/api/run',{running:true});
 for(const path of ['/api/operations','/api/context','/api/project-map'])assert.equal((await api(path,undefined,false)).status,403);
 for(const path of ['/api/operations/cancel','/api/operations/detail','/api/operations/events','/api/context/search','/api/context/note','/api/context/timeline'])assert.equal((await api(path,{},false)).status,403);
 const req=id=>({requestId:id,kind:'read',instruction:'只读',targets:[{name:id,company:'测试游戏'}]});const {plan:unrelated}=await api('/api/owner-chat',req('unrelated'));
 const body={prompt:'检查项目状态',requestId:'repeat-owner'};const {task}=await api('/api/owner-task',body);assert.equal((await api('/api/owner-task',body)).task.id,task.id);assert.equal(calls,1);assert(payload.project_checkpoint);assert(payload.previous_owner_dialogue.every(x=>!Object.hasOwn(x,'result')));
 assert.equal((await api('/api/owner-task',{...body,prompt:'另一条指令'})).status,400);assert.equal(calls,1);
 const {plan:linked}=await api('/api/owner-chat',req('linked'));assert.equal(linked.ownerTaskId,task.id);
 assert.equal((await api('/api/operations/cancel',{kind:'owner',id:task.id})).status,200);await new Promise(r=>setTimeout(r,20));assert.equal(app.state.ownerTasks[0].status,'interrupted');assert.equal(app.state.ownerChats.find(p=>p.id===linked.id).status,'finished_with_issues');assert.equal(app.state.ownerChats.find(p=>p.id===unrelated.id).status,'queued');assert.equal(app.state.config.running,true);assert.equal(app.state.tasks.length,0);
 assert((await api('/api/operations')).items.some(r=>r.id===task.id));assert((await api('/api/operations/events',{kind:'owner',id:task.id})).events.length>=2);assert.equal(JSON.parse(readFileSync(join(local,'memory/project/latest.json'))).counts.verifiedSends,0);
});
test('重启会记录任务中断和发送待核对，保留既有回执，不恢复未核对发送',async t=>{
 const local=temp('control-restart-'),port=await testPort(),first=createApplication({port,local,key:'fixture',inference:async()=>({action:'hold',text:'',reason:'测试',score:0})});await new Promise(r=>first.server.listen(port,'127.0.0.1',r));const base=`http://127.0.0.1:${port}`,{token}=await(await fetch(base+'/api/session')).json();
 first.state.ownerTasks.push({id:'owner-crashed',prompt:'上次的任务',status:'running',at:1});first.state.tasks.push({id:'old-send',kind:'reply',status:'sent',job:{title:'策划实习'},at:1},{id:'incomplete',kind:'reply',status:'executing',lease:'OLD_LEASE',reservedAt:Date.now(),job:{title:'策划实习'},at:2});
 await fetch(base+'/api/limits',{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':token},body:JSON.stringify({intervalSeconds:30})});await new Promise(r=>{first.server.close(r);first.server.closeAllConnections();});
 const recovered=createApplication({port:await testPort(),local,key:'fixture'});t.after(()=>recovered.server.close());assert.equal(recovered.state.ownerTasks[0].status,'interrupted');assert.equal(recovered.state.tasks.find(t=>t.id==='old-send').status,'sent');assert.equal(recovered.state.tasks.find(t=>t.id==='incomplete').status,'uncertain');assert.equal(recovered.state.tasks.find(t=>t.id==='incomplete').lease,undefined);assert.equal(recovered.state.config.running,false);
 const events=readFileSync(join(local,'control/events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert(events.some(e=>e.id==='incomplete'&&e.previousStatus==='executing'&&e.status==='uncertain'));assert(events.some(e=>e.id==='owner-crashed'&&e.status==='interrupted'));assert.equal(JSON.parse(readFileSync(join(local,'memory/project/latest.json'))).counts.verifiedSends,1);
});
