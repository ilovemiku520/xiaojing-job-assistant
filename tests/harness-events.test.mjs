import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHarnessEvents} from '../server/harness-events.mjs';
import {invokeHarness} from '../server/harness.mjs';
const temp=()=>mkdtempSync(join(tmpdir(),'whale-harness-events-'));
const base={system:'虚构测试',payload:{instruction:'虚构本轮'},model:'deepseek-flash',reasoningEffort:'high',key:'fixture',channel:'owner'};
const fake=(body,inspect=()=>{})=>(exe,args,options)=>{inspect(args,options);return spawn(process.execPath,['-e',body],{...options,env:{ELECTRON_RUN_AS_NODE:'1'}});};
const js=`const out=x=>process.stdout.write(JSON.stringify(x)+'\\n');`;
test('流式投影只保留阶段与最终回答，不保存思考、工具参数或工具结果',()=>{
 const progress=[],stream=createHarnessEvents(p=>progress.push(p));
 const lines=[{type:'session',sessionId:'session-fixture'},{type:'thinking',text:'SECRET_REASONING'},{type:'tool_call',tool:'pwsh',input:{secret:'SECRET_ARGUMENT'}},{type:'tool_result',result:'SECRET_RESULT'},{type:'status',phase:'turn_end',reason:{kind:'completed'}},{type:'final',text:'小鲸已返回'}].map(e=>JSON.stringify(e)+'\n').join('');
 stream.push(lines.slice(0,30));stream.push(lines.slice(30));const result=stream.finish();assert.equal(result.text,'小鲸已返回');assert.equal(result.sessionId,'session-fixture');assert.equal(result.toolCalls,1);assert(!JSON.stringify({progress,result}).includes('SECRET_'));
});
test('使用原生会话续接参数，凭据仅在环境中，旧版final无reason时核对turn_end',async()=>{
 const progress=[];const r=await invokeHarness({...base,local:temp(),sessionId:'session-fixture',onProgress:p=>progress.push(p)},fake(js+`out({type:'session',sessionId:'session-fixture'});out({type:'status',phase:'turn_end',reason:{kind:'completed'}});out({type:'final',text:'完成'});`,(args,options)=>{assert(args.includes('--json'));assert(args.includes('--session-id'));assert(!args.includes('fixture'));assert.equal(options.env.DEEPSEEK_API_KEY,'fixture');}));
 assert.equal(r.text,'完成');assert.equal(r.sessionId,'session-fixture');assert(progress.some(p=>p.type==='session'));
});
test('真实进度延续空闲计时，诊断输出和未知事件不会延续',async t=>{
 const local=realpathSync(temp()),tempRoot=realpathSync(tmpdir()),cli=join(local,'synthetic-progress.mjs');
 const previous=process.env.BOSS_HARNESS_CLI;
 t.after(()=>{
  if(previous===undefined)delete process.env.BOSS_HARNESS_CLI;else process.env.BOSS_HARNESS_CLI=previous;
  assert.equal(dirname(local),tempRoot);rmSync(local,{recursive:true,force:true});
 });
 process.env.BOSS_HARNESS_CLI=cli;
 writeFileSync(cli,String.raw`
 let input='';for await(const chunk of process.stdin)input+=chunk;
 const {onlyDiagnostics}=JSON.parse(input);
 const out=event=>process.stdout.write(JSON.stringify(event)+'\n');
 out({type:'session',sessionId:'session-progress-fixture'});
 const diagnostics=setInterval(()=>{
  process.stdout.write('synthetic diagnostic line\n');
  out({type:'fixture_unknown_event'});
 },50);
 if(!onlyDiagnostics){
  let step=0;
  const progress=setInterval(()=>{
   out({type:'status',phase:'step_start',step:++step});
   if(step===5){
    clearInterval(diagnostics);clearInterval(progress);
    out({type:'final',text:'连续进度完成',reason:{kind:'completed'}});
   }
  },350);
 }
 `);
 const options={...base,local,toolEntries:[],timeoutMs:6500,idleTimeoutMs:1200};
 const diagnostics=[];
 await assert.rejects(invokeHarness({...options,payload:{onlyDiagnostics:true},onProgress:event=>diagnostics.push(event.type)}),error=>{
  assert.equal(error.code,'HARNESS_TIMEOUT');assert.equal(error.timeoutKind,'idle');
  assert.equal(error.sessionId,'session-progress-fixture');assert(Number.isFinite(error.timing.processClosedAt));
  return true;
 });
 assert.deepEqual(diagnostics,['session','stopping']);
 const progress=[];
 const result=await invokeHarness({...options,payload:{onlyDiagnostics:false},onProgress:event=>progress.push(event.type)});
 assert.equal(result.text,'连续进度完成');assert(result.timing.totalMs>options.idleTimeoutMs);
 assert.deepEqual(progress,['session','status','status','status','status','status','final']);
});
test('无新进展超时后等待实际进程退出，并保留续接编号；不会自动重试原请求',async()=>{
 let child,calls=0;const spawnImpl=(...args)=>{calls++;child=fake(js+`out({type:'session',sessionId:'session-idle'});setInterval(()=>{},1000);`)(...args);return child;};
 // A real Windows child can take over 400ms to start under the full parallel
 // suite. Give it time to emit its session, then still require an idle timeout,
 // a closed process, and exactly one invocation rather than weakening those checks.
 await assert.rejects(invokeHarness({...base,local:temp(),timeoutMs:7000,idleTimeoutMs:1500},spawnImpl),e=>{assert.equal(e.code,'HARNESS_TIMEOUT');assert.equal(e.timeoutKind,'idle');assert.equal(e.sessionId,'session-idle');assert(child.exitCode!==null||child.signalCode!==null);return true;});assert.equal(calls,1);
});
test('最长时限仍能停止持续占用任务，failed final或缺少final不能冒充完成',async()=>{
 await assert.rejects(invokeHarness({...base,local:temp(),timeoutMs:500,idleTimeoutMs:1000},fake(js+`out({type:'session',sessionId:'session-long'});setInterval(()=>out({type:'status',phase:'step_start'}),50);`)),e=>e.code==='HARNESS_TIMEOUT'&&e.timeoutKind==='total');
 for(const body of [js+`out({type:'status',phase:'turn_end',reason:{kind:'error'}});out({type:'final',text:'并未完成'});`,js+`out({type:'session',sessionId:'session-no-final'});`])await assert.rejects(invokeHarness({...base,local:temp()},fake(body)),e=>e.code==='HARNESS_RUN_FAILED');
});
