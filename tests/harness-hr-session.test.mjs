import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,utimesSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {ensureHarnessProfile,findHarness,invokeHarness} from '../server/harness.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'whale-hr-native-'));
const base={system:'虚构测试规则',payload:{kind:'reply',memory:{peerId:'fixture-peer'}},model:'fixture',reasoningEffort:'high',key:'fixture-key',channel:'hr',returnSession:true};
const fake=(body,inspect=()=>{})=>(exe,args,options)=>{inspect(args,options);return spawn(process.execPath,['-e',body],{...options,env:{ELECTRON_RUN_AS_NODE:'1'}});};
const js=`const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');`;
const final=`out({type:'status',phase:'turn_end',reason:{kind:'completed'}});out({type:'final',text:JSON.stringify({action:'send_text',text:'主人还在找实习',reason:'虚构测试',score:80})});`;

test('跨平台 CLI 通过 Node 启动，沿用会话协议和独立数据目录',async t=>{
 const local=temp(),cli=join(local,'test-cli.mjs');
 const prior=process.env.BOSS_HARNESS_CLI,priorMode=process.env.ELECTRON_RUN_AS_NODE;
 t.after(()=>{
  if(prior===undefined)delete process.env.BOSS_HARNESS_CLI;else process.env.BOSS_HARNESS_CLI=prior;
  if(priorMode===undefined)delete process.env.ELECTRON_RUN_AS_NODE;else process.env.ELECTRON_RUN_AS_NODE=priorMode;
 });
 process.env.BOSS_HARNESS_CLI=cli;
 process.env.ELECTRON_RUN_AS_NODE='1';
 assert.equal(findHarness().available,false);
 writeFileSync(cli,`import {dirname} from 'node:path';`+js+`if(process.env.ELECTRON_RUN_AS_NODE||process.env.BOSS_DATA_DIR!==dirname(process.env.DSH_HOME))process.exit(1);out({type:'session',sessionId:process.argv[process.argv.indexOf('--session-id')+1]});`+final);
 assert.equal(findHarness().exe,process.execPath);
 const result=await invokeHarness({...base,local,sessionId:'session-portable'});
 assert.equal(result.sessionId,'session-portable');
 assert.equal(result.decision.action,'send_text');
});

const packagedRuntime=process.env.XIAOJING_TEST_HARNESS_RUNTIME;
const developmentRuntime=fileURLToPath(new URL('../tools/cache/electron/runtime/electron.exe',import.meta.url));
test('桌面 Electron 以 Node 模式启动配置的 Harness CLI',{
 skip:process.platform!=='win32'||!packagedRuntime&&!existsSync(developmentRuntime)
},t=>{
 const tempRoot=realpathSync(tmpdir()),local=realpathSync(temp()),cli=join(local,'synthetic-cli.mjs');
 t.after(()=>{assert.equal(dirname(local),tempRoot);rmSync(local,{recursive:true,force:true});});
 const exe=resolve(packagedRuntime||developmentRuntime);
 const runtimeRoot=packagedRuntime?join(dirname(exe),'resources','app'):fileURLToPath(new URL('../',import.meta.url));
 writeFileSync(cli,`import assert from 'node:assert/strict';
 assert.equal(process.env.ELECTRON_RUN_AS_NODE,'1');
 let input='';for await(const chunk of process.stdin)input+=chunk;
 assert.deepEqual(JSON.parse(input),{source:'fixture'});
 console.log(JSON.stringify({type:'session',sessionId:'session-portable-desktop'}));
 console.log(JSON.stringify({type:'final',text:'synthetic desktop owner result'}));
 `);
 const fixture=String.raw`
 import assert from 'node:assert/strict';
 import {spawn} from 'node:child_process';
 import {readFileSync} from 'node:fs';
 const {findHarness,invokeHarness}=await import(process.env.XIAOJING_FIXTURE_HARNESS);
 const installation=findHarness();
 assert.equal(installation.exe,process.execPath);
 assert.equal(installation.runtime,'node');
 const result=await invokeHarness({local:process.env.BOSS_DATA_DIR,system:'fixture',payload:{source:'fixture'},
  model:'fixture',key:'fixture-key',channel:'owner',toolEntries:[],timeoutMs:10000},(command,args,options)=>{
  // Verify the launcher before invoking it, even if the flag regresses. No GUI can start.
  assert.equal(command,process.execPath);
  assert.equal(options.env.ELECTRON_RUN_AS_NODE,'1');
  assert.equal(options.env.DSH_TELEMETRY_DISABLED,'1');
  const patch=JSON.parse(readFileSync(args[args.indexOf('--patch')+1],'utf8'));
  assert.equal(patch.find(item=>item.id==='session-log-deepseek').config.enabled,false);
  return spawn(command,args,options);
 });
 assert.equal(result.sessionId,'session-portable-desktop');
 assert.equal(result.text,'synthetic desktop owner result');
 console.log('fixture desktop CLI succeeded');
 `;
 const result=spawnSync(exe,['--input-type=module','-e',fixture],{
  env:{...process.env,ELECTRON_RUN_AS_NODE:'1',BOSS_HARNESS_CLI:cli,BOSS_DATA_DIR:local,
   XIAOJING_FIXTURE_HARNESS:pathToFileURL(join(runtimeRoot,'server','harness.mjs')).href},
  encoding:'utf8',windowsHide:true,timeout:15000,
 });
 assert.equal(result.status,0,result.error?.message||result.stderr);
 assert.equal(result.stdout.trim(),'fixture desktop CLI succeeded');
});

test('HR 使用原生会话续接和独立 profile，持久化/压缩基座保留，决策与会话编号分开返回',async()=>{
 const local=temp(),progress=[];const result=await invokeHarness({...base,local,sessionId:'session-peer',onProgress:p=>progress.push(p)},fake(js+`out({type:'session',sessionId:'session-peer'});`+final,(args,options)=>{
  assert(args.includes('--json'));assert.equal(args[args.indexOf('--session-id')+1],'session-peer');assert.equal(args[args.indexOf('--profile')+1],'hr');assert(!args.includes('fixture-key'));assert.equal(options.env.DEEPSEEK_API_KEY,'fixture-key');
  const patch=JSON.parse(readFileSync(args[args.indexOf('--patch')+1],'utf8'));assert(!patch.some(e=>e.insert));for(const id of ['tool-bash','tool-pwsh','tool-fs','tool-subagent','tool-web'])assert.equal(patch.find(e=>e.id===id).disabled,true);assert(!patch.some(e=>/compaction|session-persistence/.test(e.id)&&e.disabled));
 }));assert.equal(result.decision.action,'send_text');assert.equal(result.sessionId,'session-peer');assert.equal(result.toolCalls,0);assert(progress.some(p=>p.type==='session'));
});

test('原生 profile 文件内容不变时不重写，主人/自主 profile 名称保持兼容',()=>{
 const local=temp(),profile=ensureHarnessProfile(local,'hr'),path=join(profile.profile,'package.json'),old=new Date('2001-01-01');utimesSync(path,old,old);const stamp=statSync(path).mtimeMs;ensureHarnessProfile(local,'hr');assert.equal(statSync(path).mtimeMs,stamp);assert.equal(ensureHarnessProfile(local,'owner').profileName,'owner');assert.equal(ensureHarnessProfile(local,'autonomy').profileName,'autonomy');const manifest=JSON.parse(readFileSync(join(profile.home,'agent-manifest.json'),'utf8'));assert.equal(manifest.nativeLifecycle.resume,'agents.resume');assert.equal(manifest.channels.hr.localTools,false);assert.equal(manifest.nativeLifecycle.residentProcess,false);
});

test('HR 不能因采用持久会话而得到本地工具，异常工具事件停止后才交还控制',async()=>{
 let child,calls=0;const spawnImpl=(...args)=>{calls++;child=fake(js+`out({type:'session',sessionId:'session-safe'});out({type:'tool_call',tool:'pwsh',input:{command:'THIS_IS_ONLY_A_FIXTURE'}});setInterval(()=>{},1000);`)(...args);return child;};
 await assert.rejects(invokeHarness({...base,local:temp()},spawnImpl),e=>{assert.equal(e.code,'HARNESS_UNEXPECTED_TOOL');assert.equal(e.sessionId,'session-safe');assert(child.exitCode!==null||child.signalCode!==null);return true;});assert.equal(calls,1);
});

test('原生会话错配、无 session 或无效 JSON 都不能生成待发送任务，也不自动创建新会话重试',async()=>{
 let calls=0;await assert.rejects(invokeHarness({...base,local:temp(),sessionId:'session-expected'},(...args)=>{calls++;return fake(js+`out({type:'session',sessionId:'session-wrong'});`+final)(...args);}),e=>e.code==='HARNESS_SESSION_MISMATCH'&&e.sessionId==='session-expected');assert.equal(calls,1);
 await assert.rejects(invokeHarness({...base,local:temp()},fake(js+final)),e=>e.code==='HARNESS_RUN_FAILED');
 await assert.rejects(invokeHarness({...base,local:temp()},fake(js+`out({type:'session',sessionId:'session-invalid-json'});out({type:'final',reason:{kind:'completed'},text:'not json'});`)),e=>e.code==='HARNESS_INVALID_JSON'&&e.sessionId==='session-invalid-json');
});

test('只有匹配所请求会话且在运行前的明确缺失才可恢复',async t=>{
 const local=realpathSync(temp()),tempRoot=realpathSync(tmpdir()),cli=join(local,'fixture-cli.mjs');
 const previous=process.env.BOSS_HARNESS_CLI;
 writeFileSync(cli,'');process.env.BOSS_HARNESS_CLI=cli;
 t.after(()=>{
  if(previous===undefined)delete process.env.BOSS_HARNESS_CLI;else process.env.BOSS_HARNESS_CLI=previous;
  assert.equal(dirname(local),tempRoot);rmSync(local,{recursive:true,force:true});
 });
 const sessionId='session-missing-fixture';
 const missing=id=>`out({type:'error',message:${JSON.stringify(`session "${id}" does not exist; omit --session-id to start a new Session`)}});`;
 const options={...base,local,sessionId};
 await assert.rejects(invokeHarness(options,fake(js+missing(sessionId)+'process.exitCode=1;')),error=>{
  assert.equal(error.code,'HARNESS_SESSION_NOT_FOUND');
  assert.equal(error.sessionId,sessionId);
  assert.equal(error.timing.firstEventAt,null);
  assert(!error.message.includes(sessionId));
  return true;
 });
 const unrelated=[
  [options,missing('session-other')+'process.exitCode=1;'],
  [options,missing(sessionId)],
  [options,`out({type:'session',sessionId:${JSON.stringify(sessionId)}});`+missing(sessionId)+'process.exitCode=1;'],
  [{...options,sessionId:undefined},missing(sessionId)+'process.exitCode=1;']
 ];
 for(const [request,events] of unrelated)await assert.rejects(invokeHarness(request,fake(js+events)),error=>error.code==='HARNESS_RUN_FAILED');
});

test('Harness 认证分类要求真实的 AUTH 401 终止事件，忽略普通错误文字、其他状态和取消',async()=>{
 const options={...base,local:temp()};
 const session=`out({type:'session',sessionId:'session-auth-fixture'});`;
 const terminal=(code,status)=>{
  const reason=JSON.stringify({kind:'error',error:{code,status,message:'fixture-private-upstream-message'}});
  return `out({type:'status',phase:'turn_end',reason:${reason}});out({type:'final',text:'',reason:${reason}});process.exitCode=1;`;
 };
 for(const events of [terminal('AUTH',403),terminal('RATE_LIMIT',429),terminal('UNKNOWN',401),terminal('AUTH','401'),`out({type:'error',message:'fixture quotes AUTH 401'});process.exitCode=1;`]){
  await assert.rejects(invokeHarness(options,fake(js+session+events)),error=>error.code==='HARNESS_RUN_FAILED'&&error.httpStatus===undefined);
 }
 const controller=new AbortController();
 await assert.rejects(invokeHarness({...options,signal:controller.signal,onProgress:event=>{if(event.type==='final')controller.abort();}},fake(js+session+terminal('AUTH',401))),error=>error.code==='HARNESS_CANCELLED'&&error.httpStatus===undefined);
});

test('学习推理仍保留单轮纯 JSON 兼容接口，不能指定持久会话',async()=>{
 const result=await invokeHarness({...base,channel:'learning',returnSession:false,local:temp()},fake(`process.stdout.write(JSON.stringify({notes:[]}));`,args=>assert(!args.includes('--json'))));assert.deepEqual(result,{notes:[]});await assert.rejects(invokeHarness({...base,channel:'learning',sessionId:'session-denied',local:temp()}),/续接编号无效/);
});

test('记录模型输出与进程保存耗时，不提前释放原生会话或保存思考文本',async()=>{
 const progress=[];
 const body=js+`out({type:'session',sessionId:'session-timing'});out({type:'thinking',text:'PRIVATE_THINKING_FIXTURE'});setTimeout(()=>{out({type:'text',text:'PUBLIC_DRAFT_FIXTURE'});${final}setTimeout(()=>{},220);},100);`;
 const result=await invokeHarness({...base,local:temp(),onProgress:p=>progress.push(p)},fake(body));
 assert.equal(result.decision.action,'send_text');
 const t=result.timing;assert(t.startedAt<=t.spawnedAt);assert(t.spawnedAt<=t.firstEventAt);assert(t.firstEventAt<=t.firstTextAt);assert(t.firstTextAt<=t.completedAt);assert(t.completedAt<=t.processClosedAt);
 assert.equal(t.totalMs,t.processClosedAt-t.startedAt);assert(t.outputWaitMs>=150,'会话持久化前的进程收尾等待应单独记录');
 assert(!JSON.stringify({progress,timing:t}).includes('PRIVATE_THINKING_FIXTURE'));assert(!JSON.stringify({progress,timing:t}).includes('PUBLIC_DRAFT_FIXTURE'));
});
