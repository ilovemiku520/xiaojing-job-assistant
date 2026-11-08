import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createJobExportEngine} from '../server/job-export-engine.mjs';
import {exportJobRows,filterJobRows,projectJobRows} from '../server/job-exports.mjs';

const generatedAt=Date.parse('2026-11-08T12:00:00.000Z');
const profile={titles:['游戏策划'],cities:['北京'],earlyCareerOnly:true,exclusions:[]};
const job=(index,description='岗位面向在校学生，使用 Unity 制作玩法原型。')=>({
  id:'fixture'+index,url:'https://www.zhipin.com/job_detail/fixture-'+index+'.html',title:'游戏策划实习'+index,
  company:'测试工作室',city:'北京',status:'ready',source:index%2?'favorite':'search',
  lastSeenAt:generatedAt+index,description,
});
const jobs={one:job(1),two:job(2)};

test('后台投影保持类型、顺序和哈希，只复制岗位筛选配置',async t=>{
  const engine=createJobExportEngine();
  t.after(()=>engine.close());
  const withPrivateFields={
    ...profile,
    get facts(){throw Error('不应读取主人简历资料');},
    get name(){throw Error('不应读取主人姓名');},
  };
  const first=await engine.project({jobs,profile:withPrivateFields});
  assert.deepEqual(first.rows,projectJobRows({jobs,config:{profile}}));
  assert.match(first.signature,/^[0-9a-f]{64}$/);
  assert.equal((await engine.project({jobs:{two:jobs.two,one:jobs.one},profile})).signature,first.signature);
  assert.notEqual((await engine.project({jobs:{...jobs,one:{...jobs.one,salary:'15-20K'}},profile})).signature,first.signature);
});

test('后台筛选复用岗位投影，实际传输 Excel、CSV、JSON 字节且不改变原排序',async t=>{
  const engine=createJobExportEngine();
  t.after(()=>engine.close());
  const {rows}=await engine.project({jobs,profile});
  const filters={source:'favorite',q:'UNITY',sort:'title',direction:'asc'};
  const selected=filterJobRows(rows,filters);
  assert.deepEqual(selected.map(row=>row.id),['fixture1']);
  assert.deepEqual(rows.map(row=>row.id),['fixture2','fixture1']);
  for(const format of ['xlsx','csv','json']){
    const result=await engine.export(rows,format,{filters,generatedAt});
    assert(Buffer.isBuffer(result.body));
    assert.deepEqual(result,exportJobRows(selected,format,{generatedAt}));
  }
  await assert.rejects(engine.export(rows,'exe'),/岗位导出参数无效/);
  await assert.rejects(engine.export(rows,'csv',{filters:{sort:'未知字段'}}),/排序参数无效/);
  assert.equal((await engine.export(rows,'csv')).extension,'csv','普通参数错误不应杀死后台');
});

test('后台工作线程可惰性建立、限制积压、在故障后重建，并主动清理关闭',async()=>{
  class FixtureWorker extends EventEmitter{
    postMessage(message){this.message=message;}
    ref(){}
    unref(){}
    async terminate(){this.terminated=true;}
  }
  const workers=[];
  const engine=createJobExportEngine({
    maxPending:1,
    workerFactory:()=>{const worker=new FixtureWorker();workers.push(worker);return worker;},
  });
  assert.equal(workers.length,0);
  const first=engine.project({jobs,profile});
  const failed=assert.rejects(first,/后台异常退出/);
  await assert.rejects(engine.project({jobs,profile}),/处理其他岗位导出/);
  workers[0].emit('error',Error('synthetic worker exit'));
  await failed;
  const next=engine.project({jobs,profile});
  const rebuilt=workers[1];
  const value={rows:[],signature:'a'.repeat(64)};
  rebuilt.emit('message',{id:rebuilt.message.id,ok:true,result:value});
  assert.deepEqual(await next,value);
  const active=engine.project({jobs,profile});
  const cancelled=assert.rejects(active,/服务已关闭/);
  await engine.close();
  await cancelled;
  assert.equal(workers.length,2);
  assert(workers.every(worker=>worker.terminated));
  await assert.rejects(engine.project({jobs,profile}),/服务已关闭/);
});

test('超过一千个岗位的投影和 Excel 导出期间主线程计时器可继续运行',{timeout:20000},async t=>{
  const engine=createJobExportEngine();
  t.after(()=>engine.close());
  await engine.project({jobs:{},profile});
  const largeDescription='职责与需求：处理游戏规则、玩法和项目文档。'.repeat(400);
  const largeJobs=Object.fromEntries(Array.from({length:1200},(_,index)=>[index,job(index,largeDescription)]));
  let ticks=0;
  const pulse=setInterval(()=>ticks++,5);
  try{
    const {rows}=await engine.project({jobs:largeJobs,profile});
    assert.equal(rows.length,1200);
    assert(ticks>=3,'大批量投影期间主线程仍应处理计时器');
    const beforeExport=ticks;
    const {body}=await engine.export(rows,'xlsx',{generatedAt});
    assert.equal(body.readUInt32LE(0),0x04034b50);
    assert(ticks-beforeExport>=3,'工作簿生成期间主线程仍应处理计时器');
  }finally{clearInterval(pulse);}
});
