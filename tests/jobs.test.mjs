import test from 'node:test';
import assert from 'node:assert/strict';
import {observeJobs,claimJob,completeJob,jobURL} from '../server/jobs.mjs';
import {defaults} from '../server/core.mjs';
const config=()=>({...structuredClone(defaults),running:true,profile:{titles:['游戏策划'],cities:['北京']}});
const entry={title:'游戏策划实习',company:'虚构公司',city:'北京',salary:'面议',url:'https://www.zhipin.com/job_detail/fixture01.html?src=fixture'};
test('岗位按官方详情链接去重，非法站点不进入队列',()=>{const s={config:config()};observeJobs(s,[entry,entry,{...entry,url:'https://evil.example/job_detail/x.html'}]);assert.equal(Object.keys(s.jobs).length,1);assert.throws(()=>jobURL('https://www.zhipin.com@evil.example/job_detail/x.html'));});
test('只读取符合岗位城市的详情，同时只有一个采集任务',()=>{const s={config:config()};observeJobs(s,[entry,{...entry,title:'销售',url:'https://www.zhipin.com/job_detail/sales.html'}]);const job=claimJob(s);assert(job);assert.equal(claimJob(s),null);assert.equal(job.title,entry.title);});
test('采集需匹配凭据和同一详情页，正文不足不能标为已读取',()=>{const s={config:config()};observeJobs(s,[entry]);const job=claimJob(s);assert.throws(()=>completeJob(s,{id:job.id,lease:'wrong',url:job.url}));const r=completeJob(s,{id:job.id,lease:job.lease,url:job.url,success:true,job:{description:'短文本'}});assert.equal(r.status,'needs_adaptation');});
test('有效正文保存为已读取，暂停和关闭采集不继续领取',()=>{const s={config:config()};observeJobs(s,[entry]);s.config.running=false;assert.equal(claimJob(s),null);s.config.running=true;const j=claimJob(s);const r=completeJob(s,{id:j.id,lease:j.lease,url:j.url,success:true,job:{description:'游戏系统与玩法策划实习职责、原型设计、卡牌规则、经济循环、关卡体验、协作与文档维护，需要真实项目基础。'}});assert.equal(r.status,'ready');assert(r.description.includes('游戏'));});

const description='游戏系统与玩法策划实习职责、原型设计、卡牌规则、经济循环、关卡体验、协作与文档维护，需要真实项目基础。';

test('收藏和搜索重扫不覆盖已验证的详情，也不会再领取同一个已读岗位',()=>{
  const state={config:config()};
  const now=1000000;
  const [id]=observeJobs(state,[entry],{now});
  const reading=claimJob(state,now);
  const job=completeJob(state,{id,lease:reading.lease,url:reading.url,success:true,job:{
    title:'游戏策划实习生',company:'详情公司',city:'北京市',experience:'在校/应届',description
  }});
  observeJobs(state,[{...entry,company:'列表招聘人',city:'广州',experience:'5-10年',salary:'200-250元/天',description:'列表摘要'}],
    {source:'favorite',page:'https://www.zhipin.com/web/geek/recommend?tab=4',now:now+1000});
  assert.equal(job.status,'ready');
  assert.equal(job.title,'游戏策划实习生');
  assert.equal(job.company,'详情公司');
  assert.equal(job.city,'北京市');
  assert.equal(job.experience,'在校/应届');
  assert.equal(job.description,description);
  assert.equal(job.salary,'200-250元/天','详情未读取到的字段仍可由列表补充');
  assert.deepEqual(job.sources,['search','favorite']);
  assert.equal(job.lastSeenAt,now+1000);
  assert.equal(job.favoriteSourcePage,'https://www.zhipin.com/web/geek/recommend?tab=4');
  assert.equal(claimJob(state,now+16000,{jobId:id,authorized:true}),null);
  const [next]=observeJobs(state,[{...entry,url:'https://www.zhipin.com/job_detail/fixture02.html'}],{now:now+16000});
  assert.equal(claimJob(state,now+16000).id,next);
});

test('旧版已读详情保留现有字段，缺少本次正文时不能用旧列表摘要标记详情已读',()=>{
  const state={config:config()};
  const [id]=observeJobs(state,[{...entry,description}]);
  const old=state.jobs[id];
  old.status='ready';
  delete old.company;
  observeJobs(state,[{...entry,title:'列表岗位标题',description:'列表摘要'}]);
  assert.equal(old.title,entry.title);
  assert.equal(old.company,entry.company);
  assert.equal(old.description,description);
  const [other]=observeJobs(state,[{...entry,url:'https://www.zhipin.com/job_detail/list-only.html',description}]);
  const reading=claimJob(state);
  const result=completeJob(state,{id:other,lease:reading.lease,url:reading.url,success:true,job:{company:'有公司名但无详情'}});
  assert.equal(result.status,'needs_adaptation');
  assert.equal(result.detailFields,undefined);
});
