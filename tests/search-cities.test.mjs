import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureAutonomousSearch,observeSearch,requestSearch,searchCityCoverage} from '../server/search.mjs';

const state=cities=>({config:{
  running:true,autoSearchEnabled:true,autoBrowse:true,crawlEnabled:true,
  limits:{hoursStart:0,hoursEnd:24},
  profile:{cities,titles:['游戏策划'],earlyCareerOnly:true}
}});
const cityCode=search=>new URL(search.url).searchParams.get('city');

test('搜索覆盖区分可自动搜索和仅保存偏好的城市，保留配置顺序',()=>{
  assert.deepEqual(searchCityCoverage({cities:['自定义地点','成都','上海','上海','武汉','上海市']}),{
    supported:['成都','上海','武汉'],unsupported:['自定义地点','上海市']
  });
  assert.deepEqual(searchCityCoverage(),{supported:[],unsupported:[]});
  const mixed=state(['自定义地点','上海']);
  assert.throws(()=>requestSearch(mixed,{city:'自定义地点'},1000),/尚未核对 BOSS 自动搜索入口/);
  assert.throws(()=>requestSearch(mixed,{city:'成都'},1000),/当前求职偏好/);
  assert.equal(cityCode(requestSearch(mixed,{},1000)),'101020100');
});

test('自动搜索按配置轮换上海、成都、武汉和实习校招，不查询未支持的偏好',()=>{
  const selection=state(['上海','自定义地点','成都','武汉']);
  const observed=[];
  for(let index=0;index<6;index++){
    const now=1000000+index*180000;
    const search=ensureAutonomousSearch(selection,now);
    observed.push([search.city,cityCode(search),search.stage]);
    observeSearch(selection,{id:search.id,url:search.url,empty:true},now+100);
  }
  assert.deepEqual(observed,[
    ['上海','101020100','internship'],['上海','101020100','campus'],
    ['成都','101270100','internship'],['成都','101270100','campus'],
    ['武汉','101200100','internship'],['武汉','101200100','campus']
  ]);
  const custom=state(['自定义地点']);
  assert.equal(ensureAutonomousSearch(custom,1000000),null);
  assert.equal(custom.searches,undefined);
  assert.deepEqual(custom.config.profile.cities,['自定义地点']);
});

test('搜索回传严格核对原请求 URL 的城市与关键词，拒绝歧义及非官方页面',()=>{
  const selection=state(['成都']);
  const search=requestSearch(selection,{city:'成都',query:'游戏策划'},1000),original=new URL(search.url);
  const changes=[
    url=>url.searchParams.set('city','101020100'),
    url=>url.searchParams.set('query','系统策划'),
    url=>url.searchParams.append('city','101270100'),
    url=>url.searchParams.append('query','系统策划'),
    url=>{url.username='fixture';},
    url=>{url.hostname='www.zhipin.com.example.test';},
    url=>{url.pathname='/web/geek/chat';}
  ];
  for(const change of changes){
    const observed=new URL(original);
    change(observed);
    assert.throws(()=>observeSearch(selection,{id:search.id,url:observed.href,cards:3},1100),/与请求条件不一致/);
    assert.equal(search.status,'queued');
  }
  // Persisted requests can outlive the current display label and profile.
  search.city='旧显示标签';
  selection.config.profile.cities=['上海'];
  original.pathname='/web/geek/jobs';
  original.searchParams.set('page','2');
  observeSearch(selection,{id:search.id,url:original.href,cards:2},1200);
  assert.equal(search.status,'observed');
  assert.equal(search.cards,2);
});
