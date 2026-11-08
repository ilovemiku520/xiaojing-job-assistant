import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {defaults} from '../server/core.mjs';
import {testPort} from './port.mjs';

const marker='0.10.0-owner-autonomy',filename='authorized-upgrade-0.10.0.json';
const upgrade=()=>({id:marker,source:'authenticated_owner_request',enablePlanner:true,config:{mode:'auto',running:true,autoResume:true,autoGreet:true,allowSiteDefaultResume:true,proactiveResume:true,chatRead:true,chatInput:true,historyRead:true,newMessagesOnly:true,autoBrowse:true,crawlEnabled:true,minScore:55}});
function seed({goal='',running=false,existingConversation=false}={}){
 const local=mkdtempSync(join(tmpdir(),'whale-authorized-upgrade-')),config=structuredClone(defaults);Object.assign(config,{running,minScore:80,chatRead:false,chatInput:false});config.profile={...config.profile,name:'虚构测试求职者',titles:['游戏策划'],cities:['北京'],facts:'虚构测试资料',resumeName:'主人指定简历.pdf'};
 const autonomy={enabled:false,goal,nextSteps:[{id:'legacy-approval',status:'planned',description:'等待主人授权发简历'},{id:'read-role',status:'planned',description:'读取新岗位的实际要求'}],history:[],status:'disabled',nextWakeAt:0};
 const ownerConversations=existingConversation?[{id:'existing-autonomy-conversation',title:'原长期求职',createdAt:1,updatedAt:1,turnsAssigned:0,autonomyGoalId:'existing-goal',harnessSessionId:'session-existing-goal'}]:[];
 if(existingConversation)Object.assign(autonomy,{id:'existing-goal',conversationId:'existing-autonomy-conversation'});
 writeFileSync(join(local,'state.json'),JSON.stringify({config,tasks:[],events:[],snapshots:{},lastAction:0,ownerTasks:[],ownerConversations,autonomy}));writeFileSync(join(local,filename),JSON.stringify(upgrade()));return local;
}
async function start(t,local){
 const app=createApplication({local,port:await testPort(),key:'fixture-key',inference:async()=>{throw Error('升级测试不能调用模型');},autonomyIntervalMs:600000,learningIntervalMs:600000,greetingIntervalMs:600000});await new Promise(r=>app.server.listen(app.port,'127.0.0.1',r));
 let closed=false;const close=async()=>{if(closed)return;closed=true;await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});};t.after(close);return {app,close};
}
const notes=local=>JSON.parse(readFileSync(join(local,'memory/learning/index.json'),'utf8')).notes.filter(n=>n.trust==='owner_direct');

test('主人授权的暂存升级只载入新自主设置，保留总暂停与现有求职资料',async t=>{
 for(const running of [false,true]){
  const local=seed({running}),{app}=await start(t,local);assert.equal(app.state.config.running,false);assert.equal(app.state.config.mode,'auto');assert.equal(app.state.config.minScore,55);
  for(const flag of ['autoResume','autoGreet','allowSiteDefaultResume','proactiveResume','chatRead','chatInput','historyRead','newMessagesOnly','autoBrowse','crawlEnabled'])assert.equal(app.state.config[flag],true,flag);
  assert.equal(app.state.config.profile.resumeName,'主人指定简历.pdf');assert.deepEqual(app.state.config.profile.titles,['游戏策划']);assert(app.state.appliedUpgrades.includes(marker));assert(!existsSync(join(local,filename)));assert(existsSync(join(local,filename.replace('.json','.applied.json'))));assert.equal(notes(local).length,1);
  // With no owner-supplied long-term goal, enabling features cannot invent one.
  assert.equal(app.state.autonomy.enabled,false);assert.equal(app.state.ownerConversations.length,0);assert.equal(app.state.ownerTasks.length,0);
 }
});

test('已有长期目标时启用规划并建立持久任务上下文，旧附件审批等待被持续授权取代',async t=>{
 const goal='为主人持续寻找游戏策划校招和实习岗位',local=seed({goal}),{app}=await start(t,local),a=app.state.autonomy;assert.equal(a.goal,goal);assert.equal(a.enabled,true);assert.equal(a.status,'ready');assert(a.id);assert(a.conversationId);
 const conversation=app.state.ownerConversations.find(c=>c.id===a.conversationId);assert(conversation);assert.equal(conversation.autonomyGoalId,a.id);assert.equal(conversation.harnessSessionId,undefined);assert.equal(a.nextSteps.find(step=>step.id==='legacy-approval').status,'superseded');assert.equal(a.nextSteps.find(step=>step.id==='read-role').status,'planned');assert.equal(app.state.config.running,false);assert.equal(app.state.ownerTasks.length,0);
 const saved=JSON.parse(readFileSync(join(local,'memory/agent/goal.json'),'utf8'));assert.equal(saved.enabled,true);assert.equal(saved.conversationId,a.conversationId);assert.equal(saved.goal,goal);
});

test('二次启动不重复主人记忆，也不覆盖主人后续设置或原生对话上下文',async t=>{
 const local=seed({goal:'主人已确认的长期目标',existingConversation:true}),first=await start(t,local);assert.equal(first.app.state.autonomy.conversationId,'existing-autonomy-conversation');assert.equal(first.app.state.ownerConversations[0].harnessSessionId,'session-existing-goal');const noteIds=notes(local).map(note=>note.id);await first.close();
 const saved=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));Object.assign(saved.config,{mode:'review',autoResume:false,autoGreet:false,allowSiteDefaultResume:false,proactiveResume:false,minScore:67});saved.autonomy.enabled=false;saved.autonomy.status='disabled';writeFileSync(join(local,'state.json'),JSON.stringify(saved));
 // Even a stale staged file copied back after an update is not a new mandate.
 writeFileSync(join(local,filename),JSON.stringify(upgrade()));const second=await start(t,local);assert.equal(second.app.state.config.mode,'review');assert.equal(second.app.state.config.minScore,67);for(const flag of ['autoResume','autoGreet','allowSiteDefaultResume','proactiveResume'])assert.equal(second.app.state.config[flag],false,flag);assert.equal(second.app.state.autonomy.enabled,false);assert.equal(second.app.state.config.running,false);
 assert.deepEqual(notes(local).map(note=>note.id),noteIds);assert.equal(second.app.state.appliedUpgrades.filter(id=>id===marker).length,1);assert.equal(second.app.state.ownerConversations.length,1);assert.equal(second.app.state.ownerConversations[0].harnessSessionId,'session-existing-goal');assert(!existsSync(join(local,filename)));
});

test('未证明来自认证主人的升级或错误版本标识被拒绝，不写入授权记忆或已应用标记',()=>{
 for(const change of [{source:'hr_message'},{source:'webpage'},{id:'unrecognized-upgrade'}]){
  const local=seed(),data={...upgrade(),...change};writeFileSync(join(local,filename),JSON.stringify(data));assert.throws(()=>createApplication({local,port:0,key:'fixture-key',inference:async()=>{throw Error('不能调用模型');},autonomyIntervalMs:600000,learningIntervalMs:600000,greetingIntervalMs:600000}),/来源不明确/);
  const saved=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));assert.equal(saved.config.minScore,80);assert(!saved.appliedUpgrades?.includes(marker));assert.equal(notes(local).length,0);assert(existsSync(join(local,filename)));assert(!existsSync(join(local,filename.replace('.json','.applied.json'))));
 }
});
