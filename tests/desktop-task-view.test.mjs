import assert from 'node:assert/strict';
import test from 'node:test';
import {desktopTaskView} from '../server/desktop-task-view.mjs';

const now=Date.UTC(2026,10,8,2),description='合成岗位详情'.repeat(1000);
const task=(id,status,fields={})=>({id,status,kind:'reply',text:`合成回复 ${id}`,job:{title:'游戏策划实习',description},updatedAt:now,...fields});

test('按页面裁剪任务明细，工作台各筛选顺序和全量计数仍准确',()=>{
  const tasks=['sent','pending','uncertain','hold'].flatMap(status=>Array.from({length:120},(_,index)=>task(`${status}-${index}`,status)));
  const overview=desktopTaskView(tasks,[],'overview',now);
  assert.equal(overview.tasks.length,300);
  assert.deepEqual(overview.taskStats,{attention:360,sent:120});
  assert.deepEqual(overview.tasks.slice(0,100).map(row=>row.id),tasks.slice(0,100).map(row=>row.id));
  assert.equal(overview.tasks.find(row=>row.status==='uncertain').id,'uncertain-0');
  assert(!overview.tasks.some(row=>Object.hasOwn(row.job,'description')));
  const jobs=desktopTaskView(tasks,[],'jobs',now);
  assert.deepEqual(jobs,{tasks:[],taskStats:{attention:360,sent:120}});
});

test('HR页仅保留活跃回复和五条最近记录，额度和执行锁来自完整任务库',()=>{
  const queue=[{taskId:'queued-review'},{taskId:'sent-from-queue'},{taskId:'queued-approval'}];
  const tasks=[task('queued-review','pending',{updatedAt:now+20}),task('queued-approval','approved',{updatedAt:now+19}),
    task('sent-from-queue','sent',{updatedAt:now+12,reservedAt:now}),task('other-channel','executing',{kind:'greeting',reservedAt:now}),
    task('yesterday','uncertain',{kind:'greeting',reservedAt:now-86400000}),
    ...Array.from({length:7},(_,index)=>task(`recent-${index}`,'sent',{updatedAt:now-index}))];
  const view=desktopTaskView(tasks,queue,'hr-channel',now);
  assert.deepEqual(view.tasks.map(row=>row.id),['queued-review','queued-approval','sent-from-queue','recent-0','recent-1','recent-2','recent-3']);
  assert.deepEqual(view.taskStats,{attention:2,sent:8,reservedToday:2,executing:true});
});
