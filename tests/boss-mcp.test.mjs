import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,readFileSync,rmdirSync,rmSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const script=fileURLToPath(new URL('../tools/boss-mcp.mjs',import.meta.url));
const protocolVersion='2025-11-25';
const initialize={protocolVersion,capabilities:{},clientInfo:{name:'boss-mcp-fixture',version:'1.0.0'}};

function client(t,env,args=[]){
  const child=spawn(process.execPath,[script,...args],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout})[Symbol.asyncIterator]();
  const exited=new Promise((done,fail)=>{child.once('close',done);child.once('error',fail);});
  t.after(async()=>{child.stdin.end();assert.equal(await exited,0);});
  let sequence=0;
  const send=body=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...body})+'\n');
  async function invoke(method,params){
    const id=++sequence;
    send({id,method,params});
    const line=await lines.next();
    assert.equal(line.done,false);
    const response=JSON.parse(line.value);
    assert.equal(response.jsonrpc,'2.0');
    assert.equal(response.id,id);
    return response;
  }
  return {invoke,send,tool:(name,args)=>invoke('tools/call',{name,arguments:args})};
}

async function fixture(t){
  const local=mkdtempSync(join(tmpdir(),'whale-mcp-')),port=await testPort();
  const app=createApplication({port,local,key:'synthetic-key',inference:async()=>({action:'skip',reason:'fixture',score:0}),autonomyIntervalMs:10000000});
  await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
  t.after(async()=>{
    await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});
    rmSync(local,{recursive:true,force:true});
  });
  const token=readFileSync(join(local,'pairing-token'),'utf8').trim();
  const extensionToken=readFileSync(join(local,'extension-token'),'utf8').trim();
  async function api(path,data,credential=token){
    return fetch(`http://127.0.0.1:${port}`+path,{
      method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':credential},
      ...(data?{body:JSON.stringify(data)}:{}),
    });
  }
  const config=await api('/api/config',{mode:'auto',backend:'api',browserCalibrated:true,learningEnabled:false,autoGreet:false,profile:{name:'虚构主人',facts:'仅用于测试',titles:['游戏策划'],cities:['北京']}});
  assert.equal(config.status,200);
  await config.body.cancel();
  return {app,api,token,extensionToken,env:{BOSS_DATA_DIR:local,PORT:String(port)}};
}

test('MCP 独立握手和工具声明，只通过主人认证更改指定通道', {timeout:15000}, async t=>{
  const {api,app,extensionToken,env}=await fixture(t);
  const conn=client(t,env);
  assert.equal((await conn.invoke('server/discover')).error.code,-32601);
  assert.equal((await conn.invoke('tools/list')).error.code,-32000);
  const started=await conn.invoke('initialize',initialize);
  assert.equal(started.result.protocolVersion,protocolVersion);
  assert.deepEqual(started.result.capabilities,{tools:{listChanged:false}});
  conn.send({method:'notifications/initialized'});
  const listed=(await conn.invoke('tools/list')).result.tools;
  assert.equal(listed.length,5);
  assert(listed.find(tool=>tool.name==='boss_set_channel').annotations.destructiveHint);
  assert(listed.find(tool=>tool.name==='boss_status').annotations.readOnlyHint);
  const denied=await api('/api/status',undefined,extensionToken);
  assert.equal(denied.status,403);
  await denied.body.cancel();
  conn.send({method:'tools/call',params:{name:'boss_set_channel',arguments:{channel:'jobSearch',running:true}}});
  await conn.invoke('ping');
  assert.equal(app.state.config.running,false);
  assert((await conn.tool('boss_set_channel',{channel:'jobSearch',running:'true'})).result.isError);
  assert((await conn.tool('boss_set_channel',{channel:'jobSearch',running:true,hrInbox:true})).result.isError);
  assert.equal(app.state.config.running,false);
  const first=(await conn.tool('boss_set_channel',{channel:'jobSearch',running:true})).result.structuredContent;
  assert.deepEqual(first.channels,{jobSearch:true,hrInbox:false});
  const second=(await conn.tool('boss_set_channel',{channel:'hrInbox',running:true})).result.structuredContent;
  assert.deepEqual(second.channels,{jobSearch:true,hrInbox:true});
  const third=(await conn.tool('boss_set_channel',{channel:'jobSearch',running:false})).result.structuredContent;
  assert.deepEqual(third.channels,{jobSearch:false,hrInbox:true});
  const status=(await conn.tool('boss_status')).result.structuredContent;
  assert(status.online);
  assert.deepEqual(status.channels,{jobSearch:false,hrInbox:true});
  assert.deepEqual(status.browser,{pageOnline:false,extensionOnline:false,calibrated:true,extensionVersion:''});
});

test('MCP 只读配置和摘要不外露凭据、主人指令、私聊及岗位跟踪参数', {timeout:15000}, async t=>{
  const {app,token,extensionToken,env}=await fixture(t);
  app.state.jobs={
    matched:{id:'matched',url:'https://www.zhipin.com/job_detail/mcp-fixture.html?securityId=fixture-private-url',title:'游戏策划实习',company:'模拟公司',city:'北京',status:'ready'},
    other:{id:'other',url:'https://other.example/job_detail/fixture.html',title:'高级游戏策划',company:'模拟公司',city:'其他',status:'listed'},
  };
  app.state.ownerTasks.push({id:'owner-fixture',at:Date.now(),status:'done',prompt:'fixture-private-prompt',result:'fixture-private-answer'});
  app.state.memories['fixture-peer']={history:[{text:'fixture-private-chat'}]};
  const conn=client(t,env,['--read-only']);
  await conn.invoke('initialize',initialize);
  conn.send({method:'notifications/initialized'});
  assert.equal((await conn.invoke('tools/list')).result.tools.length,4);
  assert.equal((await conn.tool('boss_set_channel',{channel:'jobSearch',running:true})).error.code,-32602);
  assert.equal(app.state.config.running,false);
  const status=await conn.tool('boss_status');
  assert(status.result.structuredContent.online);
  const candidates=await conn.tool('boss_job_candidates',{limit:1,matchedOnly:true});
  assert.equal(candidates.result.structuredContent.total,1);
  assert.equal(candidates.result.structuredContent.jobs[0].url,'https://www.zhipin.com/job_detail/mcp-fixture.html');
  const operations=await conn.tool('boss_operations',{kind:'owner'});
  assert.equal(operations.result.structuredContent.items[0].title,'主人任务');
  const output=JSON.stringify([status,candidates,operations]);
  for(const secret of [token,extensionToken,'synthetic-key','fixture-private-url','fixture-private-prompt','fixture-private-answer','fixture-private-chat'])assert(!output.includes(secret));
});

test('MCP 任务摘要限制服务返回条数，兼容忽略筛选参数的旧版服务', {timeout:15000}, async t=>{
  const local=mkdtempSync(join(tmpdir(),'whale-mcp-operations-')),port=await testPort();
  const tokenPath=join(local,'pairing-token'),token='a'.repeat(64);
  writeFileSync(tokenPath,token,{mode:0o600});
  const base={status:'done',updatedAt:100,done:1,total:1,active:false,reason:'fixture-private-operation-reason'};
  const records=[{...base,id:'message-1',kind:'message',title:'虚构岗位 · 回复HR'},...Array.from({length:24},(_,i)=>({
    ...base,id:'owner-'+i,kind:'owner',title:'fixture-private-operation-title',targets:[{name:'fixture-private-target'}],
  }))];
  const requests=[];
  let respond=query=>{
    const filtered=records.filter(row=>!query.has('kind')||row.kind===query.get('kind'));
    return {version:1,total:filtered.length,items:filtered.slice(0,Number(query.get('limit')))};
  };
  const server=createServer((req,res)=>{
    assert.equal(req.method,'GET');assert.equal(req.headers['x-boss-token'],token);
    const url=new URL(req.url,'http://127.0.0.1');
    assert.equal(url.pathname,'/api/operations');
    requests.push(Object.fromEntries(url.searchParams));
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(respond(url.searchParams)));
  });
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  t.after(async()=>{
    await new Promise(r=>{server.close(r);server.closeAllConnections();});
    rmSync(tokenPath);rmdirSync(local);
  });
  const conn=client(t,{PORT:String(port),BOSS_DATA_DIR:local},['--read-only']);
  await conn.invoke('initialize',initialize);
  conn.send({method:'notifications/initialized'});
  for(const args of [{limit:0},{limit:51},{limit:'1'},{kind:'all'},{kind:'owner',includeTargets:true}]){
    assert.equal((await conn.tool('boss_operations',args)).result.isError,true);
  }
  assert.deepEqual(requests,[]);
  const scoped=(await conn.tool('boss_operations',{kind:'owner',limit:1})).result.structuredContent;
  assert.deepEqual(scoped,{total:24,items:[{id:'owner-0',kind:'owner',status:'done',title:'主人任务',updatedAt:100,done:1,total:1,active:false}]});
  const defaults=(await conn.tool('boss_operations')).result.structuredContent;
  assert.equal(defaults.total,25);assert.equal(defaults.items.length,20);
  assert.deepEqual(requests,[{view:'summary',limit:'1',kind:'owner'},{view:'summary',limit:'20'}]);
  for(const legacy of [{version:1,items:records,running:false},{items:records}]){
    respond=()=>legacy;
    assert.deepEqual((await conn.tool('boss_operations',{kind:'owner',limit:1})).result.structuredContent,scoped);
  }
  respond=()=>({version:1,total:1,items:[records[0]]});
  assert.equal((await conn.tool('boss_operations',{kind:'owner',limit:1})).result.isError,true);
});

test('MCP 岗位表使用控制台分页、筛选和已记录进展，只返回允许的字段', {timeout:15000}, async t=>{
  const {app,api,token,extensionToken,env}=await fixture(t);
  const at=Date.now();
  app.state.jobs=Object.fromEntries(Array.from({length:26},(_,index)=>{
    const number=index+1,id='job-'+number;
    return [id,{
      id,title:'游戏策划实习 '+number,company:'模拟+研发',city:'北京',salary:'200元/天',experience:'在校',status:'ready',
      source:number===26?'favorite':'search',lastSeenAt:at,
      url:'https://www.zhipin.com/job_detail/'+id+'.html?securityId=fixture-table-tracking#tracking',
      description:'fixture-table-private-description',contactName:'fixture-table-private-hr',sourcePage:'file:///fixture/local/path',
    }];
  }));
  const target=app.state.jobs['job-26'];
  app.state.tasks.unshift({id:'fixture-table-progress',kind:'greeting',action:'hold',status:'hold',job:{url:target.url}});
  const reviewed=await api('/api/review',{id:'fixture-table-progress',approve:true,text:'fixture-table-private-draft'});
  assert.equal(reviewed.status,200);
  await reviewed.body.cancel();

  const denied=await api('/api/jobs/table?page=1',undefined,extensionToken);
  assert.equal(denied.status,403);
  await denied.body.cancel();
  const conn=client(t,env,['--read-only']);
  await conn.invoke('initialize',initialize);
  conn.send({method:'notifications/initialized'});
  const tool=(await conn.invoke('tools/list')).result.tools.find(tool=>tool.name==='boss_jobs_table');
  assert.deepEqual(tool.annotations,{readOnlyHint:true,openWorldHint:false});
  assert.equal(tool.inputSchema.additionalProperties,false);
  assert.deepEqual(tool.inputSchema.properties.pageSize.enum,[25,50,100]);

  for(const args of [null,[],{page:0},{page:'1'},{pageSize:20},{q:'鲸'.repeat(301)},{stage:'toString'},{sort:'description'},{direction:'DESC'},{includeDescription:true}]){
    const invalid=await conn.tool(tool.name,args);
    assert.equal(invalid.result.isError,true,JSON.stringify(args));
    assert.match(invalid.result.content[0].text,/岗位表参数/);
  }
  const second=(await conn.tool(tool.name,{page:2,sort:'title',direction:'asc'})).result.structuredContent;
  assert.deepEqual({page:second.page,pageSize:second.pageSize,pages:second.pages,offset:second.offset,total:second.total},{page:2,pageSize:25,pages:2,offset:25,total:26});
  assert.deepEqual(second.rows.map(row=>row.id),[target.id]);
  const filtered=(await conn.tool(tool.name,{page:9,pageSize:50,q:'模拟+研发',source:'favorite',status:'ready',fit:'matched',stage:'pending',sort:'stage',direction:'desc'})).result.structuredContent;
  assert.deepEqual({page:filtered.page,pageSize:filtered.pageSize,pages:filtered.pages,offset:filtered.offset,total:filtered.total},{page:1,pageSize:50,pages:1,offset:0,total:1});
  assert.deepEqual(filtered.counts,{all:26,favorite:1,search:25});
  assert.equal(filtered.trust,'untrusted');
  assert.equal(filtered.updatedAt,at);
  assert.deepEqual(filtered.rows,[{
    id:target.id,title:target.title,company:target.company,city:target.city,salary:target.salary,experience:target.experience,
    sources:['favorite'],status:'ready',fit:'matched',lastSeenAt:at,url:'https://www.zhipin.com/job_detail/job-26.html',
    progress:{status:'pending',at:app.state.tasks[0].updatedAt,contact:'unknown',resume:'unknown',pending:'pending',uncertain:false},
  }]);
  const output=JSON.stringify([second,filtered]);
  for(const secret of [token,extensionToken,env.BOSS_DATA_DIR,'fixture-table-private-description','fixture-table-private-hr','fixture-table-private-draft','fixture-table-tracking','fixture/local/path'])assert(!output.includes(secret));
  assert.equal(app.state.config.running,false);
});

test('服务关闭时 MCP 保持连接并指示如何恢复', {timeout:15000}, async t=>{
  const conn=client(t,{BOSS_DATA_DIR:join(tmpdir(),'nonexistent-mcp-test-data'),PORT:String(await testPort())});
  const started=await conn.invoke('initialize',{...initialize,protocolVersion:'2025-03-26'});
  assert.equal(started.result.protocolVersion,'2025-03-26');
  conn.send({method:'notifications/initialized'});
  const status=(await conn.tool('boss_status')).result;
  assert.equal(status.structuredContent,undefined);
  const summary=JSON.parse(status.content[0].text);
  assert.equal(summary.online,false);
  assert.match(summary.diagnosis,/桌面端启动服务/);
  assert((await conn.tool('boss_job_candidates')).result.isError);
  assert((await conn.tool('boss_jobs_table')).result.isError);
  assert.deepEqual((await conn.invoke('ping')).result,{});
});
