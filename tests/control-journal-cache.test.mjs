import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync,mkdtempSync,realpathSync,renameSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createControlStore} from '../server/control.mjs';

function fixture(t){
  const temp=realpathSync(tmpdir()),directory=realpathSync(mkdtempSync(join(temp,'xiaojing-journal-cache-')));
  assert.equal(dirname(directory),temp);
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,file:join(directory,'events.jsonl')};
}
const row=(sequence,kind,id,title='模拟记录')=>({sequence,kind,id,title,status:'pending'});
const lines=rows=>rows.map(event=>JSON.stringify(event)+'\n').join('');
const seq=reply=>reply.events.map(event=>event.sequence);

test('追加任务事件时更新已读取的四种范围，游标始终是全局序号',t=>{
  const {directory,file}=fixture(t);
  writeFileSync(file,lines([row(1,'owner','same-id'),row(2,'message','same-id'),row(3,'plan','other-id')]));
  const store=createControlStore(directory);
  const options=[{}, {kind:'message'}, {id:'same-id'}, {kind:'message',id:'same-id'}];
  assert.deepEqual(options.map(query=>seq(store.events(query))),[[1,2,3],[2],[1,2],[2]]);
  const task={id:'same-id',kind:'reply',status:'approved',job:{title:'模拟岗位'},createdAt:10};
  const state={tasks:[task]};
  store.reconcile(state);task.status='sent';store.reconcile(state);
  assert.deepEqual(options.map(query=>seq(store.events(query))),[[1,2,3,4,5],[2,4,5],[1,2,4,5],[2,4,5]]);
  assert.deepEqual(store.events({kind:'owner',id:'same-id',after:3}),{events:[],cursor:5});
  assert.deepEqual(seq(store.events({kind:'message',after:'3',limit:1})),[5]);
  const cached=store.events({kind:'message'});cached.events[0].title='篡改返回结果';
  assert.equal(store.events({kind:'message'}).events[0].title,'模拟记录');
});

test('同大小替换、外部截断和追加会使旧缓存失效，重启从有效记录恢复序号',t=>{
  const {directory,file}=fixture(t);
  writeFileSync(file,lines([row(8,'message','chosen','原记录')]));
  const store=createControlStore(directory);
  assert.equal(store.events({id:'chosen'}).events[0].title,'原记录');
  const previous=statSync(file),replacement=join(directory,'replacement');
  writeFileSync(replacement,lines([row(9,'message','chosen','新记录')]));
  utimesSync(replacement,previous.atime,previous.mtime);assert.equal(statSync(replacement).size,previous.size);
  renameSync(replacement,file);
  assert.equal(store.events({id:'chosen'}).events[0].title,'新记录');
  assert.equal(store.events().cursor,8,'外部修改不会向后重置或自行改动当前进程的游标');
  writeFileSync(file,'');assert.deepEqual(store.events({id:'chosen'}),{events:[],cursor:8});
  appendFileSync(file,lines([row(17,'message','chosen','外部追加')]));
  assert.deepEqual(seq(store.events({id:'chosen'})),[17]);
  assert.equal(createControlStore(directory).events().cursor,17);
});

test('分块扫描保留完整中文，忽略损坏记录，追加不会粘到残缺尾行',t=>{
  const {directory,file}=fixture(t);
  const long='中'.repeat(24000);
  writeFileSync(file,lines([row(1,'message','first',long)])+'null\n{"sequence":{"toString":null}}\n'+lines([row(2,'owner','second')])+'{"sequence":3');
  const store=createControlStore(directory);
  assert.deepEqual(seq(store.events()),[1,2]);
  assert.equal(store.events({id:'first'}).events[0].title,long);
  store.reconcile({tasks:[{id:'new',kind:'reply',status:'pending',job:{title:'后续记录'},createdAt:20}]});
  const reopened=createControlStore(directory);
  assert.deepEqual(seq(reopened.events()),[1,2,3]);
  assert.equal(reopened.events({id:'new'}).events[0].title,'后续记录 · 回复HR');
});

test('保留最新物理顺序和返回数量上限，非递增序号仍按游标正确筛选',t=>{
  const {directory,file}=fixture(t);
  const rows=[row(1000,'owner','selected'),...Array.from({length:250},(_,index)=>row(index+1,'owner','selected'))];
  writeFileSync(file,lines(rows));
  const store=createControlStore(directory),query={kind:'owner',id:'selected'};
  const tail=store.events({...query,limit:1000});
  assert.equal(tail.events.length,200);assert.equal(tail.events[0].sequence,51);assert.equal(tail.cursor,1000);
  assert.deepEqual(seq(store.events({...query,after:900})),[1000]);
  assert.deepEqual(seq(store.events({...query,after:248,limit:2.7})),[249,250]);
  for(let i=0;i<35;i++)store.events({id:`empty-${i}`});
  assert.equal(store.events({...query,limit:0}).events.length,60);
  assert.deepEqual(seq(store.events({...query,after:249})),[1000,250]);
});
