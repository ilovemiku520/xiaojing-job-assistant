import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {defaults} from '../server/core.mjs';
import {testPort} from './port.mjs';

const marker='0.11.0-favorites-priority',filename='authorized-upgrade-0.11.0.json';
const mandate=()=>({id:marker,source:'authenticated_owner_request'});
function seed(){
 const local=mkdtempSync(join(tmpdir(),'whale-favorites-upgrade-')),config=structuredClone(defaults);Object.assign(config,{running:true,mode:'review',minScore:68,historyRead:false,historySweepEnabled:true,favoritesFirst:false,autoSearchEnabled:false});Object.assign(config.profile,{name:'虚构主人',titles:['游戏策划'],cities:['北京','深圳'],facts:'主人已核实的原资料',resumeName:'主人指定的简历.pdf'});config.limits={dailyGreetings:17,dailyMessages:57,intervalSeconds:45,hoursStart:8,hoursEnd:23};
 const ownerConversations=[{id:'owner-conversation',title:'主人原任务',createdAt:1,updatedAt:2,turnsAssigned:0,harnessSessionId:'session-owner-before-upgrade'},{id:'autonomy-conversation',title:'原长期目标',createdAt:1,updatedAt:2,turnsAssigned:0,harnessSessionId:'session-autonomy-before-upgrade',autonomyGoalId:'original-goal'}];
 writeFileSync(join(local,'state.json'),JSON.stringify({config,tasks:[],events:[],snapshots:{},lastAction:0,ownerTasks:[],ownerConversations,autonomy:{id:'original-goal',conversationId:'autonomy-conversation',enabled:false,goal:'主人原来的校招实习目标',nextSteps:[],history:[],status:'disabled',nextWakeAt:0},favorites:{status:'unavailable',lastJobIds:['already-known-favorite'],nextScanAt:1234}}));
 mkdirSync(join(local,'agent-context'));writeFileSync(join(local,'agent-context/hr-index.json'),JSON.stringify({version:1,records:{fixture:{peerId:'boss:existing-hr',profile:'hr',signature:'fixture-before-upgrade',generation:1,status:'idle',sessionId:'session-hr-before-upgrade',turns:3,messageKeys:[]}}}));writeFileSync(join(local,filename),JSON.stringify(mandate()));return {local,config};
}
async function start(t,local){
 const app=createApplication({local,port:await testPort(),key:'fixture-key',inference:async()=>{throw Error('升级测试不能调用真实模型');},autonomyIntervalMs:600000,learningIntervalMs:600000,greetingIntervalMs:600000});await new Promise(r=>app.server.listen(app.port,'127.0.0.1',r));let closed=false;const close=async()=>{if(closed)return;closed=true;await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});};t.after(close);
 const base=`http://127.0.0.1:${app.port}`,session=await(await fetch(base+'/api/session')).json();const config=async body=>{const response=await fetch(base+'/api/config',{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':session.token},body:JSON.stringify(body)});return {http:response.status,...await response.json()};};return {app,close,config};
}
const ownerNotes=local=>JSON.parse(readFileSync(join(local,'memory/learning/index.json'),'utf8')).notes.filter(note=>note.trust==='owner_direct');
function assertNativePointers(app,local){
 assert.equal(app.state.ownerConversations.find(c=>c.id==='owner-conversation').harnessSessionId,'session-owner-before-upgrade');assert.equal(app.state.ownerConversations.find(c=>c.id==='autonomy-conversation').harnessSessionId,'session-autonomy-before-upgrade');assert.equal(app.state.autonomy.conversationId,'autonomy-conversation');assert.equal(app.state.autonomy.id,'original-goal');assert.equal(JSON.parse(readFileSync(join(local,'agent-context/hr-index.json'),'utf8')).records.fixture.sessionId,'session-hr-before-upgrade');
}

test('实际0.11授权暂存文件应用收藏主线并归档，资料、额度、native会话与总暂停均保留',async t=>{
 const {local,config}=seed(),{app}=await start(t,local);assert.equal(app.state.config.historySweepEnabled,false);assert.equal(app.state.config.historyRead,true);assert.equal(app.state.config.favoritesFirst,true);assert.equal(app.state.config.autoSearchEnabled,true);assert.equal(app.state.config.running,false);assert.equal(app.state.config.mode,'review');assert.equal(app.state.config.minScore,68);assert.deepEqual(app.state.config.profile,config.profile);assert.deepEqual(app.state.config.limits,config.limits);assertNativePointers(app,local);
 assert.equal(app.state.autonomy.enabled,false);assert.equal(app.state.autonomy.primaryWork,'favorites_then_search');assert.equal(app.state.favorites.status,'queued');assert.deepEqual(app.state.favorites.lastJobIds,['already-known-favorite']);assert.equal(app.state.appliedUpgrades.filter(id=>id===marker).length,1);assert(!existsSync(join(local,filename)));assert(existsSync(join(local,filename.replace('.json','.applied.json'))));assert.equal(ownerNotes(local).length,1);
 const persisted=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));assert.equal(persisted.config.historySweepEnabled,false);assert.equal(persisted.config.autoSearchEnabled,true);assert.equal(persisted.config.running,false);assert(persisted.appliedUpgrades.includes(marker));assert.deepEqual(persisted.config.limits,config.limits);
});

test('重复启动或同一暂存文件再出现不会重复写主人记忆，也不会覆盖后续设置',async t=>{
 const {local}=seed(),first=await start(t,local),noteIds=ownerNotes(local).map(note=>note.id);const changed=await first.config({historySweepEnabled:true,historyRead:false,favoritesFirst:false,autoSearchEnabled:false,profile:{facts:'主人后续修改的资料'},limits:{intervalSeconds:60}});assert.equal(changed.http,200);await first.close();
 writeFileSync(join(local,filename),JSON.stringify(mandate()));const second=await start(t,local);assert.equal(second.app.state.config.historySweepEnabled,true);assert.equal(second.app.state.config.historyRead,false);assert.equal(second.app.state.config.favoritesFirst,false);assert.equal(second.app.state.config.autoSearchEnabled,false);assert.equal(second.app.state.config.profile.facts,'主人后续修改的资料');assert.equal(second.app.state.config.limits.intervalSeconds,60);assert.equal(second.app.state.config.running,false);assert.deepEqual(ownerNotes(local).map(note=>note.id),noteIds);assert.equal(second.app.state.appliedUpgrades.filter(id=>id===marker).length,1);assertNativePointers(second.app,local);assert(!existsSync(join(local,filename)));
});

test('错误来源或升级编号不能应用收藏配置、授权记忆或已应用标记',()=>{
 for(const invalid of [{source:'hr_message'},{source:'webpage'},{source:''},{id:'unknown-version'}]){
  const {local,config}=seed();writeFileSync(join(local,filename),JSON.stringify({...mandate(),...invalid}));assert.throws(()=>createApplication({local,port:0,key:'fixture-key',inference:async()=>{throw Error('不能调用模型');},autonomyIntervalMs:600000,learningIntervalMs:600000,greetingIntervalMs:600000}),/收藏优先升级来源不明确/);
  const saved=JSON.parse(readFileSync(join(local,'state.json'),'utf8'));assert.equal(saved.config.historySweepEnabled,true);assert.equal(saved.config.historyRead,false);assert.equal(saved.config.favoritesFirst,false);assert.equal(saved.config.autoSearchEnabled,false);assert.deepEqual(saved.config.profile,config.profile);assert.deepEqual(saved.config.limits,config.limits);assert(!saved.appliedUpgrades?.includes(marker));assert.equal(ownerNotes(local).length,0);assert(existsSync(join(local,filename)));assert(!existsSync(join(local,filename.replace('.json','.applied.json'))));
 }
});
