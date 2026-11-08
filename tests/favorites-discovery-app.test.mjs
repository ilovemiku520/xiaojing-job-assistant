import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {claimJob} from '../server/jobs.mjs';
import {autonomyFingerprint} from '../server/autonomy.mjs';
import {testPort} from './port.mjs';

const page='https://www.zhipin.com/web/geek/favorites-fixture',home='https://www.zhipin.com/web/geek/job';
const job=id=>({url:`https://www.zhipin.com/job_detail/${id}.html`,title:'游戏策划实习',company:'虚构游戏工作室',city:'北京',experience:'在校生',salary:'面议'});
async function fixture(t){
 const local=mkdtempSync(join(tmpdir(),'whale-favorite-app-'));let modelCalls=0;
 const app=createApplication({local,port:await testPort(),key:'fixture-key',inference:async()=>{modelCalls++;return {action:'send_text',text:'你好呀，主人目前在找实习，方便了解一下岗位的工作内容吗？',reason:'虚构普通回复',score:85};},autonomyIntervalMs:600000,learningIntervalMs:600000,greetingIntervalMs:600000});await new Promise(r=>app.server.listen(app.port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${app.port}`,session=await(await fetch(base+'/api/session')).json();
 async function api(path,data,role='owner'){
  const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':role==='owner'?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});return {http:response.status,...await response.json()};
 }
 const configured=await api('/api/config',{mode:'auto',browserCalibrated:true,autoGreet:false,learningEnabled:false,historyRead:true,historySweepEnabled:false,favoritesFirst:true,autoSearchEnabled:true,limits:{hoursStart:0,hoursEnd:24},profile:{name:'虚构主人',titles:['游戏策划'],cities:['北京'],facts:'虚构2027届学生',resumeName:'指定简历.pdf'}});assert.equal(configured.http,200);return {app,api,local,calls:()=>modelCalls};
}

test('扩展可读取收藏调度、上报实际导航与列表，岗位来源及采集结果持久化',async t=>{
 const {app,api,local,calls}=await fixture(t);const paused=await api('/api/favorites/state',undefined,'browser');assert.equal(paused.http,200);assert.equal(paused.due,false);await api('/api/run',{running:true});
 const due=await api('/api/favorites/state',undefined,'browser');assert.equal(due.due,true);assert(due.requestId);
 const navigation=await api('/api/favorites/observe',{kind:'navigation',navigation:{url:page,label:'我的收藏',sourcePage:home}},'browser');assert.equal(navigation.http,200);assert.equal(navigation.navigation.url,page);
 const list=await api('/api/favorites/observe',{kind:'list',url:page,confirmedList:true,evidence:'虚构测试页面明确显示收藏列表和一个带详情链接的卡片',jobs:[job('favorite001')]},'browser');assert.equal(list.http,200);assert.equal(list.status,'observed');assert.equal(list.ids.length,1);
 const observed=app.state.jobs[list.ids[0]];assert.equal(observed.favorite,true);assert.equal(observed.source,'favorite');assert(observed.sources.includes('favorite'));assert.equal(observed.favoriteSourcePage,page);const saved=JSON.parse(readFileSync(join(local,'memory/jobs/index.json'),'utf8'));assert.equal(saved.jobs[0].source,'favorite');assert.deepEqual(app.state.favorites.lastJobIds,list.ids);assert.equal(calls(),0);
});

test('非BOSS页面、缺少证据、明确未确认列表或未证明空列表都不能制造收藏来源',async t=>{
 const {app,api,calls}=await fixture(t),valid={kind:'list',url:page,confirmedList:true,evidence:'虚构收藏列表DOM证据',jobs:[job('invalidfavorite')]};
 const invalid=[{...valid,url:'https://example.com/web/geek/favorites'},{...valid,evidence:''},{...valid,confirmedList:false},{...valid,jobs:[],empty:false},{...valid,jobs:[]}];
 for(const body of invalid){const response=await api('/api/favorites/observe',body,'browser');assert.equal(response.http,400,response.error);assert.equal(Object.keys(app.state.jobs).length,0);assert.equal(app.state.favorites?.lastScanAt||0,0);}
 const badNavigation=await api('/api/favorites/observe',{kind:'navigation',navigation:{url:'https://example.com/web/geek/favorites',sourcePage:home,label:'我的收藏'}},'browser');assert.equal(badNavigation.http,400);
 const empty=await api('/api/favorites/observe',{kind:'list',url:page,confirmedList:true,empty:true,evidence:'虚构页面明确显示暂无收藏职位',jobs:[]},'browser');assert.equal(empty.http,200);assert.equal(empty.status,'empty');assert.equal(Object.keys(app.state.jobs).length,0);assert.deepEqual(app.state.favorites.lastJobIds,[]);assert.equal(calls(),0);
});

test('普通岗位上报不能伪造favorite属性；真实收藏候选优先于先采到的搜索候选',async t=>{
 const {app,api}=await fixture(t);await api('/api/run',{running:true});
 const searched=await api('/api/jobs/observe',{source:'favorite',jobs:[{...job('searchfirst'),favorite:true,source:'favorite',sources:['favorite']}]},'browser');assert.equal(searched.http,200);const ordinary=app.state.jobs[searched.ids[0]];assert.equal(ordinary.source,'search');assert.equal(ordinary.favorite,undefined);assert(!ordinary.sources.includes('favorite'));
 const favorite=await api('/api/favorites/observe',{kind:'list',url:page,confirmedList:true,evidence:'虚构收藏列表中的另一岗位',jobs:[job('favoritesecond')]},'browser');assert.equal(favorite.http,200);assert.equal(Object.keys(app.state.jobs)[0],ordinary.id);const selected=claimJob(app.state);assert.equal(selected.id,favorite.ids[0]);assert.equal(selected.source,'favorite');assert.equal(ordinary.status,'listed');
});

test('收藏首页明确为空仍保留历史收藏来源和导出',async t=>{
 const {app,api,calls}=await fixture(t),first=page+'?page=1';
 const evidence=JSON.stringify({sourceBasis:'visible_page_evidence',heading:'我的收藏'});
 await api('/api/favorites/observe',{kind:'navigation',navigation:{url:first,label:'我的收藏',sourcePage:home}},'browser');
 const list=await api('/api/favorites/observe',{kind:'list',url:first,confirmedList:true,evidence,jobs:[job('fixture-archive')]},'browser');
 assert.equal(list.http,200);
 const empty=await api('/api/favorites/observe',{kind:'list',url:first,confirmedList:true,empty:true,evidence,jobs:[]},'browser');
 assert.equal(empty.status,'empty');assert.match(app.state.favorites.reason,/收藏首页为空/);assert(app.state.favorites.confirmedEmpty.at>0);
 const table=await api('/api/jobs/table?source=favorite&page=1');
 const exported=await api('/api/jobs/export?source=favorite&format=json');
 assert.equal(table.counts.favorite,1);assert.deepEqual(table.rows[0].sources,['favorite']);
 assert.equal(exported.total,1);assert.equal(exported.jobs[0].id,list.ids[0]);assert.equal(calls(),0);
});

test('主人关闭历史巡检但保留必要历史读取，收藏优先和自主搜索设置传给浏览器，扩展无权改设置',async t=>{
 const {app,api}=await fixture(t);const browser=await api('/api/browser-state',undefined,'browser');assert.equal(browser.http,200);assert.equal(browser.config.historyRead,true);assert.equal(browser.config.historySweepEnabled,false);assert.equal(browser.config.favoritesFirst,true);assert.equal(browser.config.autoSearchEnabled,true);
 const forbidden=await api('/api/config',{historySweepEnabled:true,favoritesFirst:false,autoSearchEnabled:false},'browser');assert.equal(forbidden.http,403);assert.equal(app.state.config.historySweepEnabled,false);assert.equal(app.state.config.favoritesFirst,true);
 const unavailable=await api('/api/favorites/fail',{reason:'虚构页面暂未发现明确收藏入口',phase:'navigation'},'browser');assert.equal(unavailable.http,200);assert.equal(unavailable.status,'unavailable');assert.equal(app.state.favorites.status,'unavailable');assert.equal(Object.keys(app.state.jobs).length,0);assert.equal(app.state.config.historyRead,true);
});

test('只有真实new_hr_message派发记录incoming，历史补读和重复采集不会记新事件',async t=>{
 const {app,api,calls}=await fixture(t);await api('/api/run',{running:true});const identity={name:'虚构HR',company:'虚构游戏',uniquePeer:true,header:'虚构HR 虚构游戏 招聘者',job:{title:'游戏策划实习',company:'虚构游戏',city:'北京'},messages:[{id:'known-old',role:'hr',text:'之前的岗位问题'}]};
 const resolved=await api('/api/chat/resolve',identity,'browser');assert.equal(resolved.http,200);const peerId=resolved.peerId;assert.deepEqual(app.state.autonomy.incomingAnchors,{});const before=autonomyFingerprint(app.state);
 const history=await api('/api/chat/history',{peerId,name:identity.name,company:identity.company,messages:[{id:'older',role:'hr',text:'更早的历史问题'},...identity.messages],reachedStart:true},'browser');assert.equal(history.http,200);assert.equal(history.added,1);assert.equal(app.state.memories[peerId].historyCoverage.complete,true);assert.deepEqual(app.state.autonomy.incomingAnchors,{});assert.equal(autonomyFingerprint(app.state),before);assert.equal(calls(),0);
 const input={kind:'reply',trigger:'new_hr_message',peerId,header:identity.header,job:identity.job,messages:[...identity.messages,{id:'genuine-new',role:'hr',text:'你好，现在还在找游戏策划实习吗？'}]};const prepared=await api('/api/prepare',input,'browser');assert.equal(prepared.task?.action,'send_text');assert.equal(app.state.autonomy.incomingAnchors[peerId]?.messageId,'genuine-new');const anchor=structuredClone(app.state.autonomy.incomingAnchors[peerId]);assert.notEqual(autonomyFingerprint(app.state),before);assert.equal(calls(),1);
 const repeated=await api('/api/prepare',input,'browser');assert(repeated.skipped);assert.equal(calls(),1);assert.deepEqual(app.state.autonomy.incomingAnchors[peerId],anchor);assert.equal(Object.keys(app.state.autonomy.incomingAnchors).length,1);
});
