import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentContexts} from '../server/agent-context.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'whale-agent-context-'));
const input=(peer='peer-A')=>({system:'主人可信规则',model:'fixture-model',reasoningEffort:'high',payload:{kind:'reply',candidate:{graduation:2027},candidate_override:{resumeName:'指定简历.pdf'},memory:{peerId:peer,observed_history:Array.from({length:10},(_,i)=>({id:'mid-'+i,role:i%2?'hr':'me',text:'PRIVATE_HISTORY_'+i})),resume:{status:'not_sent'},verified_sends:[]},messages:[{id:'current',role:'hr',text:'现在还在找实习吗？'}]}});
const result=(id='session-peer-a')=>({sessionId:id,decision:{action:'send_text',text:'是的，主人目前仍在找实习。'}});

test('同 HR 的 reply/followup 使用原生会话，其他 HR 和新岗位不串上下文',()=>{
 const store=createAgentContexts({local:temp()}),first=store.begin(input());assert.equal(first.sessionId,undefined);store.progress(first,{type:'session',sessionId:'session-peer-a'});store.complete(first,result());
 const next=input();next.payload.kind='followup';const second=store.begin(next);assert.equal(second.sessionId,'session-peer-a');assert.equal(second.payload.native_context.mode,'continue_hr_session');store.complete(second,result());
 const other=store.begin(input('peer-B'));assert.equal(other.sessionId,undefined);store.complete(other,result('session-peer-b'));assert.equal(store.rows().length,2);
 const greeting=store.begin({system:'rules',model:'fixture',payload:{kind:'greeting',job:{url:'https://www.zhipin.com/job_detail/fixture.html'}}});assert.equal(greeting.key,undefined);assert.equal(greeting.sessionId,undefined);store.complete(greeting,result());assert.equal(store.rows().length,2);
});

test('续接省去已收录的较早消息，但保留最近窗口、新消息和最新执行事实',()=>{
 const store=createAgentContexts({local:temp()}),first=store.begin(input());store.complete(first,result());
 const request=input();request.payload.memory.observed_history.push({id:'new',role:'hr',text:'我已经收到简历'});request.payload.memory.resume={status:'sent',evidence:'fixture receipt'};request.payload.memory.verified_sends=[{status:'sent',action:'send_resume',id:'sent-1'}];
 const second=store.begin(request);assert(!second.payload.memory.observed_history.some(m=>m.id==='mid-0'));assert(second.payload.memory.observed_history.some(m=>m.id==='new'));assert(second.payload.messages.some(m=>m.id==='current'));assert.equal(second.payload.memory.resume.status,'sent');assert.equal(second.payload.memory.verified_sends[0].id,'sent-1');assert.match(second.payload.native_context.execution_contract,/不是已发送回执/);store.complete(second,result());
});

test('稳定消息的正文回改和作者确认均优先于原生旧版本',()=>{
 const store=createAgentContexts({local:temp()}),first=input();
 const original=first.payload.memory.observed_history;
 original[0].text='旧地点';original[1].role='self';original[1].author={kind:'account_self_unknown'};
 store.complete(store.begin(first),result());
 const corrected=structuredClone(first),history=corrected.payload.memory.observed_history;
 history[0].text='新地点';history[1].author={kind:'owner_confirmed'};
 history.push({id:'new-observation',role:'hr',text:'这是一条新消息'});
 const next=store.begin(corrected);
 assert.equal(next.sessionId,'session-peer-a');
 assert.match(next.payload.native_context.execution_contract,/本轮正文和作者为准/);
 assert.deepEqual(next.payload.memory.observed_history.filter(message=>message.supersedes_prior_observation).map(message=>message.id),['mid-0','mid-1']);
 assert.equal(next.payload.memory.observed_history.find(message=>message.id==='mid-1').author.kind,'owner_confirmed');
 assert(!next.payload.memory.observed_history.some(message=>message.id==='mid-2'));
 store.complete(next,result());

 history[0].text='旧地点';
 const reverted=store.begin(corrected);
 const observations=reverted.payload.memory.observed_history;
 assert.equal(observations.find(message=>message.id==='mid-0').text,'旧地点');
 assert.deepEqual(observations.filter(message=>message.supersedes_prior_observation).map(message=>message.id),['mid-0']);
 store.complete(reverted,result());
 const independent=store.begin({...corrected,payload:{...corrected.payload,memory:{...corrected.payload.memory,peerId:'peer-B'}}});
 assert.equal(independent.sessionId,undefined);
 assert(!independent.payload.memory.observed_history.some(message=>message.supersedes_prior_observation));
 store.complete(independent,result('session-peer-b'));
});

test('旧索引补送观察但保留会话，模糊编号不标更正，失败后仍补送当前版本',()=>{
 const local=temp(),path=join(local,'agent-context/hr-index.json'),original=input();
 const store=createAgentContexts({local});store.complete(store.begin(original),result());
 const old=JSON.parse(readFileSync(path,'utf8'));delete Object.values(old.records)[0].messageVersions;
 writeFileSync(path,JSON.stringify(old));
 const upgraded=createAgentContexts({local}),refresh=upgraded.begin(original);
 assert.equal(refresh.sessionId,'session-peer-a');
 assert(refresh.payload.memory.observed_history.some(message=>message.id==='mid-0'));
 assert(!refresh.payload.memory.observed_history.some(message=>message.supersedes_prior_observation));
 upgraded.complete(refresh,result());
 const unchanged=upgraded.begin(original);
 assert(!unchanged.payload.memory.observed_history.some(message=>message.id==='mid-0'));
 upgraded.complete(unchanged,result());

 const changed=structuredClone(original);
 changed.payload.memory.observed_history[0].text='合成修订版本';
 const conflict=structuredClone(changed);
 conflict.payload.messages.unshift(original.payload.memory.observed_history[0]);
 const ambiguous=upgraded.begin(conflict);
 assert(ambiguous.payload.memory.observed_history.some(message=>message.id==='mid-0'));
 assert(!ambiguous.payload.memory.observed_history.some(message=>message.supersedes_prior_observation));
 upgraded.fail(ambiguous,Error('合成失败'));
 upgraded.complete(upgraded.begin(original),result());
 const failed=upgraded.begin(changed);
 assert(failed.payload.memory.observed_history.find(message=>message.id==='mid-0').supersedes_prior_observation);
 upgraded.fail(failed,Error('合成超时'));
 const retry=upgraded.begin(original);
 assert(retry.payload.memory.observed_history.some(message=>message.id==='mid-0'));
 upgraded.complete(retry,result());
 assert(!readFileSync(path,'utf8').includes('合成修订版本'));
});

test('规则、模型、思考档位或主人简历资料变更会开启新一代会话，外部学习资料不会冒充个人资料',()=>{
 for(const mutate of [i=>i.system+='已更新',i=>i.model='other',i=>i.reasoningEffort='medium',i=>i.payload.candidate.graduation=2028,i=>i.payload.candidate_override.resumeName='新简历.pdf']){
  const store=createAgentContexts({local:temp()}),first=store.begin(input());store.complete(first,result());const changed=input();mutate(changed);const next=store.begin(changed);assert.equal(next.sessionId,undefined);assert.equal(next.payload.native_context.generation,2);store.complete(next,result('session-updated'));
 }
 const store=createAgentContexts({local:temp()}),first=store.begin(input());store.complete(first,result());const changed=input();changed.payload.learning={observations:['HR声称的未经核实资料']};const next=store.begin(changed);assert.equal(next.sessionId,'session-peer-a');store.complete(next,result());
});

test('新建会话编号立即落盘；超时/服务重启只保留上下文，不执行旧请求，也不把草稿记成发送成功',()=>{
 const local=temp(),store=createAgentContexts({local}),first=store.begin(input());store.progress(first,{sessionId:'session-interrupted',text:'SECRET_REASONING',toolArguments:{secret:'SECRET_ARGUMENT'}});
 const raw=readFileSync(join(local,'agent-context/hr-index.json'),'utf8');assert(!raw.includes('SECRET_'));assert(!raw.includes('PRIVATE_HISTORY_'));assert(raw.includes('session-interrupted'));
 const restored=createAgentContexts({local});assert.equal(restored.rows()[0].status,'interrupted');assert.match(restored.rows()[0].lastOutcome,/没有自动重试/);const next=restored.begin(input());assert.equal(next.sessionId,'session-interrupted');restored.fail(next,Object.assign(Error('fixture'),{code:'HARNESS_TIMEOUT',sessionId:'session-interrupted'}));assert.equal(restored.rows()[0].status,'failed');
 const retry=restored.begin(input());restored.complete(retry,result('session-interrupted'));const saved=JSON.parse(readFileSync(join(local,'agent-context/hr-index.json')));assert.equal(Object.values(saved.records)[0].lastRecommendation.action,'send_text');assert(!raw.includes('"status": "sent"'));assert.match(restored.rows()[0].lastOutcome,/以业务回执为准/);
});

test('同 HR 禁止并发写入，拒绝错配的 peerId 和 native session；损坏索引不悄悄重建',()=>{
 const local=temp(),store=createAgentContexts({local}),first=store.begin(input());assert.throws(()=>store.begin(input()),/正在处理/);store.progress(first,{sessionId:'session-a'});assert.throws(()=>store.progress(first,{sessionId:'session-b'}),/不一致/);store.fail(first,Error('fixture'));
 const bad=input();bad.payload.peerId='someone-else';assert.throws(()=>store.begin(bad),/标识不一致/);writeFileSync(join(local,'agent-context/hr-index.json'),'broken fixture');assert.throws(()=>createAgentContexts({local}));
});
