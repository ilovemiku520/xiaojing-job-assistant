import test from 'node:test';
import assert from 'node:assert/strict';
import {defaults} from '../server/core.mjs';
import {observeJobs,claimJob} from '../server/jobs.mjs';
import {observeFavorites,favoritePriorityCutoff} from '../server/favorites.mjs';
import {ensureAutomaticGreeting,greetingCriteria,nextGreetingTarget,refreshGreeting,createGreetingPlan,resumeGreeting,favoriteDiscoveryPending,prioritizedFavorite} from '../server/greetings.mjs';

const now=Date.now();
const input=id=>({title:'游戏策划实习生',company:'虚构游戏'+id,city:'北京',experience:'在校/应届',url:`https://www.zhipin.com/job_detail/favorite-${id}.html`,description:'面向2027届在校实习生，参与系统玩法设计、原型规则验证、文档整理和关卡体验测试。'});
function state(){const config=structuredClone(defaults);Object.assign(config,{running:true,autoGreet:true,mode:'auto',minScore:55,favoritesFirst:true,profile:{...config.profile,name:'测试主人',facts:'虚构2027届本科生资料',titles:['游戏策划'],cities:['北京'],earlyCareerOnly:true}});return {config,jobs:{},tasks:[],greetingPlans:[],memories:{},lastCrawlAt:0};}
function add(s,id,{favorite=false,ready=false}={}){const [key]=observeJobs(s,[input(id)],{source:favorite?'favorite':'search',page:favorite?'https://www.zhipin.com/web/geek/favorite?fixture=1':'https://www.zhipin.com/web/geek/job?query=game',now});const j=s.jobs[key];if(ready)j.status='ready';return j;}
function block(s,j,status){s.tasks.push({id:'task-'+j.id,kind:'greeting',job:j,status,criteriaHash:greetingCriteria(s.config)});}

test('收藏来源持久累积，普通搜索重采不抹收藏，岗位按去参数详情链接去重',()=>{
 const s=state(),favorite=add(s,'one',{favorite:true}),first=favorite.id;
 observeJobs(s,[{...input('one'),url:input('one').url+'?tracking=fixture'}],{source:'search',page:'https://www.zhipin.com/web/geek/job?query=game',now:now+1000});
 assert.equal(Object.keys(s.jobs).length,1);assert.equal(favorite.id,first);assert.equal(favorite.favorite,true);assert.equal(favorite.source,'favorite');assert.deepEqual(favorite.sources,['favorite','search']);assert.equal(favorite.favoriteObservedAt,now);assert.equal(favorite.lastSeenAt,now+1000);assert.equal(favorite.favoriteSourcePage,'https://www.zhipin.com/web/geek/favorite');assert(favorite.sourcePages.includes('https://www.zhipin.com/web/geek/favorite'));
 const [ordinary]=observeJobs(s,[{...input('not-favorite'),favorite:true,source:'favorite'}],{source:'search',page:'https://evil.example/collect',now});assert.equal(s.jobs[ordinary].favorite,undefined);assert.equal(s.jobs[ordinary].sourcePage,undefined);
});

test('自动招呼候选收藏优先再按 ready 优先；收藏 listed 先于搜索 ready',()=>{
 const s=state(),search=add(s,'search',{ready:true}),favorite=add(s,'listed-favorite',{favorite:true}),readyFavorite=add(s,'ready-favorite',{favorite:true,ready:true});
 const plan=ensureAutomaticGreeting(s,now);assert.deepEqual(plan.jobIds,[readyFavorite.id,favorite.id,search.id]);assert.equal(nextGreetingTarget(s,plan).job.id,readyFavorite.id);
 block(s,readyFavorite,'skip');refreshGreeting(s,plan,now);assert.equal(nextGreetingTarget(s,plan).job.id,favorite.id);
});

test('普通详情采集同样先领取收藏，显式有限目标保持精确 jobId',()=>{
 const s=state(),search=add(s,'search'),favorite=add(s,'favorite',{favorite:true});assert.equal(claimJob(s,now).id,favorite.id);
 favorite.status='ready';delete favorite.lease;s.lastCrawlAt=0;assert.equal(claimJob(s,now+16000,{jobId:search.id,authorized:true}).id,search.id);
});

test('favoritesFirst 关闭后恢复 ready 优先，不因收藏初探阻塞搜索',()=>{
 const s=state(),search=add(s,'search',{ready:true}),favorite=add(s,'favorite',{favorite:true});s.config.favoritesFirst=false;s.favorites={enabled:true,status:'discovering',requestedAt:now,lastScanAt:0};
 const plan=ensureAutomaticGreeting(s,now);assert.equal(plan.jobIds[0],search.id);assert.equal(nextGreetingTarget(s,plan).job.id,search.id);assert.equal(favoriteDiscoveryPending(s,now),false);assert(plan.jobIds.includes(favorite.id));
});

test('初次收藏探测的45秒窗口不先抢搜索岗位，但已读到的收藏可先建队列',()=>{
 const s=state(),search=add(s,'search',{ready:true});s.favorites={enabled:true,due:true,status:'queued',requestedAt:now,lastScanAt:0,lastJobIds:[]};
 assert.equal(favoriteDiscoveryPending(s,now+44999),true);assert.equal(ensureAutomaticGreeting(s,now+44999),null);assert.equal(claimJob(s,now+44999),null);
 const favorite=add(s,'favorite',{favorite:true});const plan=ensureAutomaticGreeting(s,now+44999);assert(plan);assert.deepEqual(plan.jobIds,[favorite.id]);assert.equal(nextGreetingTarget(s,plan).job.id,favorite.id);assert(!plan.jobIds.includes(search.id));
});

test('empty/unavailable、超过45秒或缺少开始时间都可回退搜索，不会永久卡空收藏',()=>{
 for(const favorites of [
  {enabled:true,status:'empty',requestedAt:now,lastScanAt:now,lastJobIds:[]},
  {enabled:true,status:'unavailable',requestedAt:now,lastScanAt:0},
  {enabled:true,status:'discovering',requestedAt:now-45001,lastScanAt:0},
  {enabled:true,status:'queued',lastScanAt:0},
  {enabled:true,status:'queued',requestedAt:now,lastScanAt:now-86400000},
  {enabled:false,status:'discovering',requestedAt:now,lastScanAt:0}
 ]){
  const s=state(),search=add(s,'search');s.favorites=favorites;assert.equal(favoriteDiscoveryPending(s,now),false,JSON.stringify(favorites));const plan=ensureAutomaticGreeting(s,now);assert(plan);assert.equal(nextGreetingTarget(s,plan).job.id,search.id);
 }
});

test('已确认收藏首页为空时让当前搜索继续，保留历史来源和明确指定的岗位',()=>{
 const s=state(),old=add(s,'archived',{favorite:true}),search=add(s,'fresh',{ready:true});
 const first='https://www.zhipin.com/web/geek/favorites?page=1',later=first.replace('page=1','page=2');
 observeFavorites(s,{kind:'navigation',navigation:{url:first,label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job'}},observeJobs,now);
 const evidence=JSON.stringify({sourceBasis:'visible_page_evidence',heading:'我的收藏'});
 const observe=(url,jobs,empty,at)=>observeFavorites(s,{kind:'list',url,jobs,empty,confirmedList:true,evidence},observeJobs,at);
 const plan=ensureAutomaticGreeting(s,now);assert.equal(nextGreetingTarget(s,plan).job.id,old.id);
 observe(later,[input('partial')],false,now+10);
 observe(later,[],true,now+20);assert.equal(favoritePriorityCutoff(s),0);
 assert.equal(nextGreetingTarget(s,plan).job.id,old.id,'局部页没有清除历史收藏优先');
 observe(first,[],true,now+30);
 assert.equal(favoritePriorityCutoff(s),now+30);assert.deepEqual(s.favorites.lastJobIds,[]);
 assert.equal(nextGreetingTarget(s,plan).job.id,search.id);
 assert.deepEqual(old.sources,['favorite']);assert.equal(old.favorite,true);
 const crawl=structuredClone(s);crawl.jobs[search.id].status='listed';
 assert.equal(claimJob(crawl,now+40).id,search.id);
 const explicit=structuredClone(s);explicit.greetingPlans=[];
 const owner=createGreetingPlan(explicit,{requestId:'owner-archive',instruction:'仅处理主人明确指定的岗位',count:1,jobIds:[old.id]},'owner',now+40);
 assert.equal(nextGreetingTarget(explicit,owner).job.id,old.id);
 assert.deepEqual(owner.jobIds,[old.id]);
 observeJobs(s,[input('archived')],{source:'search',now:now+50});
 assert.equal(prioritizedFavorite(old,favoritePriorityCutoff(s)),false);
 observe(first,[input('archived')],false,now+60);
 assert.equal(prioritizedFavorite(old,favoritePriorityCutoff(s)),true);
 assert.equal(nextGreetingTarget(s,plan).job.id,old.id);
});

test('已创建 standing 计划吸纳后发现收藏并优先，有限 owner jobIds 绝不扩容',()=>{
 const automatic=state(),search=add(automatic,'search',{ready:true}),plan=ensureAutomaticGreeting(automatic,now),favorite=add(automatic,'favorite',{favorite:true});
 refreshGreeting(automatic,plan,now);assert(plan.jobIds.includes(favorite.id));assert.equal(nextGreetingTarget(automatic,plan).job.id,favorite.id);assert(plan.jobIds.includes(search.id));
 const finite=state(),chosen=add(finite,'chosen',{ready:true}),owner=createGreetingPlan(finite,{requestId:'owner-one',instruction:'仅处理指定岗位',count:1,jobIds:[chosen.id]},'owner-task',now);refreshGreeting(finite,owner,now);const extra=add(finite,'not-authorized',{favorite:true});refreshGreeting(finite,owner,now);
 assert.deepEqual(owner.jobIds,[chosen.id]);assert(!owner.targets.some(t=>t.jobId===extra.id));assert.equal(nextGreetingTarget(finite,owner).job.id,chosen.id);
});

test('收藏优先不覆盖已联系、sent、uncertain、同criteria skip 和旧取消记录',()=>{
 for(const status of ['sent','uncertain','skip','contacted','cancelled']){
  const s=state(),favorite=add(s,'blocked',{favorite:true}),search=add(s,'fresh');
  if(status==='contacted')s.memories.hr={job:{url:favorite.url},history:[{role:'self',text:'之前实际沟通过这个岗位'}]};
  else if(status==='cancelled')s.greetingPlans.push({id:'old-owner',status:'cancelled',targets:[{jobId:favorite.id,status:'cancelled'}]});
  else block(s,favorite,status);
  const plan=ensureAutomaticGreeting(s,now);assert(plan,status);assert.deepEqual(plan.jobIds,[search.id],status);assert.equal(nextGreetingTarget(s,plan).job.id,search.id);assert.equal(claimJob(s,now).id,search.id);
 }
});

test('收藏 skip 在当前条件不反复分析，minScore变化后才允许重新评估',()=>{
 const s=state(),favorite=add(s,'favorite',{favorite:true});block(s,favorite,'skip');assert.equal(ensureAutomaticGreeting(s,now),null);assert.equal(claimJob(s,now),null);
 s.config.minScore=45;const plan=ensureAutomaticGreeting(s,now);assert(plan);assert.equal(nextGreetingTarget(s,plan).job.id,favorite.id);assert.equal(claimJob(s,now).id,favorite.id);
});

test('一百个未开始搜索目标不会占满并阻塞后发现收藏，既有执行目标不被替换',()=>{
 const s=state();for(let i=0;i<100;i++)add(s,'search'+i);const plan=ensureAutomaticGreeting(s,now);assert.equal(plan.targets.length,100);
 const first=plan.targets[0];first.status='generating';const favorite=add(s,'late-favorite',{favorite:true});refreshGreeting(s,plan,now);
 assert.equal(plan.targets.length,100);assert(plan.targets.some(t=>t.jobId===favorite.id));assert(plan.targets.includes(first));assert.equal(nextGreetingTarget(s,plan),null,'already generating target remains serialized');
});

test('主人显式继续同一取消批仍可恢复确定未开始目标，不将它当自动重试',()=>{
 const s=state(),favorite=add(s,'favorite',{favorite:true}),plan=createGreetingPlan(s,{requestId:'finite',instruction:'仅这个收藏',count:1,jobIds:[favorite.id]},'owner-task',now);refreshGreeting(s,plan,now);
 const target=plan.targets[0],task={id:'rejected-before-send',kind:'greeting',status:'rejected',job:favorite,criteriaHash:greetingCriteria(s.config),greetingPlanId:plan.id};s.tasks.push(task);target.taskId=task.id;target.status='cancelled';plan.status='cancelled';
 assert.equal(ensureAutomaticGreeting(s,now),null);resumeGreeting(s,plan,now);assert.equal(nextGreetingTarget(s,plan).job.id,favorite.id);
});
