import test from 'node:test';import assert from 'node:assert/strict';
import {favoritesState,observeFavorites,failFavorites,favoritePriorityCutoff} from '../server/favorites.mjs';
import {observeJobs} from '../server/jobs.mjs';
import {ensureAutonomousSearch,observeSearch} from '../server/search.mjs';
import {defaults} from '../server/core.mjs';
const config=()=>({...structuredClone(defaults),running:true,favoritesFirst:true,autoSearchEnabled:true,profile:{...structuredClone(defaults.profile),titles:['系统策划','数值策划'],cities:['北京','杭州']},limits:{...defaults.limits,hoursStart:0,hoursEnd:24}});
const entry={url:'https://www.zhipin.com/job_detail/favorite_fixture.html',title:'系统策划实习',company:'虚构游戏',city:'北京'};
test('实际收藏导航和列表保留来源；单个收藏按钮、外部页面和伪造空列表不能导入',()=>{
 const state={config:config()};favoritesState(state,1000);
 assert.throws(()=>observeFavorites(state,{kind:'navigation',navigation:{url:'https://evil.example/',label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job'}},observeJobs));
 assert.throws(()=>observeFavorites(state,{kind:'list',url:'https://www.zhipin.com/web/geek/job',jobs:[entry]},observeJobs));
 assert.throws(()=>observeFavorites(state,{kind:'list',url:'https://www.zhipin.com/web/geek/fixture',jobs:[],evidence:'只有标题'},observeJobs));
 observeFavorites(state,{kind:'navigation',navigation:{url:'https://www.zhipin.com/web/geek/fixture',label:'我的收藏',sourcePage:'https://www.zhipin.com/web/geek/job'}},observeJobs,1100);
 const result=observeFavorites(state,{kind:'list',url:'https://www.zhipin.com/web/geek/fixture',confirmedList:true,jobs:[entry],evidence:'实际收藏标题与已选导航'},observeJobs,1200);
 assert.equal(state.jobs[result.ids[0]].favorite,true);assert.equal(state.favorites.status,'observed');assert.equal(favoritesState(state,1300).due,false);
});
test('收藏探测失败会退避并搜索，空列表也是已核验结果；读取状态本身不延长探测',()=>{
 const state={config:config()};favoritesState(state,1000);favoritesState(state,2000);assert.equal(state.favorites.requestedAt,1000);
 failFavorites(state,{reason:'未发现入口'},2100);assert.equal(favoritesState(state,2200).due,false);assert(ensureAutonomousSearch(state,220000));
 observeFavorites(state,{kind:'list',url:'https://www.zhipin.com/web/geek/fixture',empty:true,evidence:'收藏列表明确为空'},observeJobs,240000);assert.equal(state.favorites.status,'empty');assert.equal(state.favorites.nextScanAt,1140000);
});
test('只有同一范围内实际确认的收藏首页为空才改变优先级依据',()=>{
 const state={config:config()},first='https://www.zhipin.com/web/geek/recommend?tab=4&page=1&tag=4',later=first.replace('page=1','page=2'),other=first.replace('tab=4','tab=3');
 state.config.selectors.favoriteCollectionURL=first;
 const evidence=documentURL=>JSON.stringify({sourceBasis:'owner_confirmed_url',ownerCollectionURL:first,sourcePageURL:first,documentURL,visibleCards:0,explicitEmpty:true});
 const empty={kind:'list',url:first,confirmedList:true,empty:true,jobs:[],evidence:evidence(first)};
 for(const input of [{...empty,url:later},{...empty,url:other},{...empty,confirmedList:undefined},{...empty,evidence:evidence(later)},{...empty,evidence:'只有旧版空列表描述'}]){
  observeFavorites(state,input,observeJobs,1000);
  assert.equal(favoritePriorityCutoff(state),0);
 }
 assert.throws(()=>observeFavorites(state,{...empty,empty:false,jobs:[{url:'https://invalid.example/job_detail/not-a-job.html'}]},observeJobs,2000),/未确认收藏为空/);
 assert.equal(favoritePriorityCutoff(state),0);
 const reordered='https://www.zhipin.com/web/geek/recommend?tag=4&page=1&tab=4';
 observeFavorites(state,{...empty,url:reordered,evidence:evidence(reordered)},observeJobs,3000);
 assert.equal(favoritePriorityCutoff(state),3000);
 failFavorites(state,{reason:'模拟本轮未加载'},3100);assert.equal(favoritePriorityCutoff(state),3000);
 state.config.selectors.favoriteCollectionURL=other;assert.equal(favoritePriorityCutoff(state),0);
});
test('主动搜索不依赖模型临时起意，轮换岗位城市与实习校招，暂停和短间隔不导航',()=>{
 const state={config:config(),favorites:{enabled:true,status:'empty',lastScanAt:1}};
 state.config.running=false;assert.equal(ensureAutonomousSearch(state,1000000),null);state.config.running=true;
 const first=ensureAutonomousSearch(state,1000000);assert.equal(first.source,'autonomous_rotation');assert.equal(first.stage,'internship');assert.equal(first.city,'北京');
 assert.equal(ensureAutonomousSearch(state,1100000),null);
 const actualURL=new URL(first.url);actualURL.pathname='/web/geek/jobs';observeSearch(state,{id:first.id,url:actualURL.href,cards:3},1100000);assert.equal(first.status,'observed');
 const second=ensureAutonomousSearch(state,1200000);assert.equal(second.stage,'campus');assert.equal(second.query,'系统策划');
 observeSearch(state,{id:second.id,url:second.url,empty:true},1200100);
 const third=ensureAutonomousSearch(state,1400000);assert.equal(third.query,'数值策划');assert.equal(third.stage,'internship');
});
test('收藏初探只短暂让搜索等待，45秒后无结果仍继续找岗',()=>{
 const state={config:config(),favorites:{enabled:true,status:'discovering',requestedAt:1000000,lastScanAt:0}};
 assert.equal(ensureAutonomousSearch(state,1010000),null);assert(ensureAutonomousSearch(state,1050000));
});
