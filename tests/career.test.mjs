import test from 'node:test';
import assert from 'node:assert/strict';
import {earlyCareer} from '../server/career.mjs';
import {defaults,validateConfig,matchJob,canRun} from '../server/core.mjs';
import {observeJobs,claimJob} from '../server/jobs.mjs';
import {greetingCriteria,potentialGreeting} from '../server/greetings.mjs';
import {projectJobRows} from '../server/job-exports.mjs';
import {ensureAutonomousSearch} from '../server/search.mjs';
test('校招、实习可入选，工作经验或资深要求不能被关键词盖过',()=>{
 assert.equal(earlyCareer({title:'2027校招游戏策划'}).status,'eligible');assert.equal(earlyCareer({title:'游戏策划',experience:'在校/应届'}).status,'eligible');
 for(const j of [{title:'游戏策划实习',experience:'5-10年'},{title:'资深系统策划'},{title:'游戏策划',description:'校招信息：要求3年以上游戏策划经验'}])assert.equal(earlyCareer(j).status,'ineligible');
 assert.equal(earlyCareer({title:'游戏策划',experience:'经验不限'}).status,'unknown');
 assert.equal(earlyCareer({title:'游戏策划实习',experience:'3个月',description:'可实习3个月。要求3个月实习经验。'}).status,'eligible');
 assert.equal(earlyCareer({title:'游戏策划实习',description:'要求3个月以上全职工作经验。'}).status,'ineligible');
});
test('不明确的岗位先允许读详情，但不发招呼，已准备的旧任务也重新检查',()=>{
 const c=validateConfig({browserCalibrated:true,profile:{name:'测试',facts:'测试',titles:['游戏策划'],cities:['北京'],earlyCareerOnly:true},mode:'auto',limits:{hoursStart:0,hoursEnd:24}},defaults);c.running=true;
 const job={title:'游戏策划',company:'虚构公司',city:'北京',url:'https://www.zhipin.com/job_detail/earlycareer.html'},s={config:c,tasks:[],jobs:{}};
 observeJobs(s,[job]);assert(claimJob(s));assert(matchJob(job,c.profile).includes('未确认'));
 assert.equal(matchJob({...job,title:'游戏策划实习'},c.profile),'');
 assert(canRun(s,{kind:'greeting',job,status:'pending',action:'send_text'}).includes('校招或实习'));
});

test('经验上限按最低要求计算，列表、详情和发送使用同一规则',()=>{
 const config=validateConfig({browserCalibrated:true,profile:{name:'测试',facts:'虚构资料',titles:['游戏策划'],cities:['北京'],experiencePolicy:'max',maxExperienceYears:1},mode:'auto',limits:{hoursStart:0,hoursEnd:24}},defaults);
 config.running=true;
 const base={title:'游戏策划',company:'虚构公司',city:'北京'};
 const suitable={...base,experience:'1—3年',url:'https://www.zhipin.com/job_detail/junior.html'};
 const unsuitable={...base,experience:'3年及以上',url:'https://www.zhipin.com/job_detail/senior.html'};
 assert.equal(matchJob(suitable,config.profile),'');
 assert.match(matchJob(unsuitable,config.profile),/至少 3 年.*1 年/);
 assert.equal(matchJob({...suitable,description:'3年工作经验优先。'},config.profile),'');
 assert.match(matchJob({...suitable,description:'具备 2 年以上相关工作经验。'},config.profile),/至少 2 年/);
 assert.match(matchJob({...suitable,description:'工作经验：2 年及以上。'},config.profile),/至少 2 年/);
 assert.equal(potentialGreeting(suitable,config.profile),true);
 assert.equal(potentialGreeting(unsuitable,config.profile),false);
 const state={config,tasks:[],jobs:{}};
 observeJobs(state,[unsuitable,suitable]);assert.equal(claimJob(state).url,suitable.url);
 assert.equal(canRun(state,{kind:'greeting',job:suitable,status:'pending',action:'send_text'}),'');
 assert.match(canRun(state,{kind:'greeting',job:unsuitable,status:'pending',action:'send_text'}),/超过设定/);
});

test('仅按地点首段核对城市，详情、发送和导出使用同一规则',()=>{
 const config=validateConfig({browserCalibrated:true,profile:{name:'测试',facts:'虚构资料',titles:['游戏策划'],cities:['北京','苏黎世','New York']},mode:'auto',limits:{hoursStart:0,hoursEnd:24}},defaults);
 config.running=true;
 const job=(city,id)=>({title:'游戏策划实习',company:'虚构公司',city,url:'https://www.zhipin.com/job_detail/city-'+id+'.html'});
 const state={config,tasks:[],jobs:{}};
 const task=j=>({kind:'greeting',job:j,status:'pending',action:'send_text'});
 const allowed=['北京','北京市','北京·海淀区·中关村','北京市 — 朝阳区','工作地点：北京（海淀区）','苏黎世','Ｎｅｗ　Ｙｏｒｋ · Manhattan'];
 const rejected=['广州·越秀·北京路','广州 · 在校/应届 · 本科 · 可到北京','工作地点：广州（北京路）','北京路','New York Mills','工作地点：'];
 for(const [index,city] of allowed.entries()){
  const j=job(city,index);
  assert.equal(potentialGreeting(j,config.profile),true,city);
  assert.equal(matchJob(j,config.profile),'',city);
  assert.equal(canRun(state,task(j)),'',city);
 }
 for(const [index,city] of rejected.entries()){
  const j=job(city,'wrong-'+index);
  assert.equal(potentialGreeting(j,config.profile),false,city);
  assert.match(canRun(state,task(j)),/城市不匹配/,city);
 }
 const missing=job('','missing');
 assert.equal(potentialGreeting(missing,config.profile),true);
 assert.equal(potentialGreeting({...missing,status:'ready'},config.profile),false);
 assert.match(canRun(state,task(missing)),/城市不匹配/);
 const suitable=job(allowed[2],'suitable'),unsuitable=job(rejected[0],'unsuitable');
 observeJobs(state,[unsuitable,suitable]);
 assert.equal(claimJob(state).url,suitable.url);
 const exportState={config,jobs:{suitable:{...suitable,id:'suitable',status:'ready'},unsuitable:{...unsuitable,id:'unsuitable',status:'ready'}}};
 assert.deepEqual(projectJobRows(exportState,{fit:'matched'}).map(row=>row.city),[suitable.city]);
 assert.deepEqual(projectJobRows(exportState,{fit:'unmatched'}).map(row=>row.city),[unsuitable.city]);
});

test('允许正式岗及资深岗是独立选择，开启校招实习后以严格资格为准',()=>{
 const job={title:'高级游戏策划',company:'虚构公司',city:'北京',experience:'5–10年',url:'https://www.zhipin.com/job_detail/experienced.html'};
 const configured=validateConfig({profile:{titles:['游戏策划'],cities:['北京'],experiencePolicy:'any'}});
 assert.match(matchJob(job,configured.profile),/资深或管理岗/);
 const broad=validateConfig({profile:{excludeSenior:false}},configured);
 assert.equal(matchJob(job,broad.profile),'');
 assert.equal(potentialGreeting(job,broad.profile),true);
 const strict=validateConfig({profile:{earlyCareerOnly:true}},broad);
 assert.match(matchJob({...job,title:'游戏策划实习'},strict.profile),/正式工作经验/);
 assert.match(matchJob({...job,experience:'经验不限'},strict.profile),/资深或负责人/);
 assert.equal(matchJob({...job,experience:'经验不限',title:'游戏策划校招'},strict.profile),'');
 assert.throws(()=>validateConfig({profile:{experiencePolicy:'arbitrary'}}));
 assert.throws(()=>validateConfig({profile:{maxExperienceYears:1.5}}));
 assert.throws(()=>validateConfig({profile:{excludeSenior:'false'}}));
});

test('保留旧版有效设置的去重指纹，正式岗筛选加入普通搜索',()=>{
 const config=validateConfig({autoSearchEnabled:true,profile:{titles:['游戏策划'],cities:['北京']}});
 config.running=true;
 const legacy=structuredClone(config);
 for(const name of ['experiencePolicy','maxExperienceYears','excludeSenior'])delete legacy.profile[name];
 assert.equal(greetingCriteria(legacy),greetingCriteria(config));
 assert.equal(ensureAutonomousSearch({config},Date.UTC(2026,10,1,4)).stage,'internship');
 const broad=validateConfig({profile:{experiencePolicy:'any',excludeSenior:false}},config);
 assert.notEqual(greetingCriteria(broad),greetingCriteria(config));
 const search=ensureAutonomousSearch({config:broad},Date.UTC(2026,10,1,4));
 assert.equal(search.stage,'general');
 assert.equal(new URL(search.url).searchParams.get('query'),'游戏策划');
 const strict=validateConfig({profile:{earlyCareerOnly:true}},broad);
 assert.equal(ensureAutonomousSearch({config:strict},Date.UTC(2026,10,1,4)).stage,'internship');
 assert.equal(greetingCriteria(strict),greetingCriteria(validateConfig({profile:{experiencePolicy:'legacy',excludeSenior:true}},strict)));
});
