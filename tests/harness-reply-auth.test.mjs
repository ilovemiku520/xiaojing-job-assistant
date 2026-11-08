import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {testPort} from './port.mjs';

test('Harness 的明确 401 等待换密钥，429 保留退避重试和原生会话',async t=>{
 const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-harness-reply-auth-')));
 const knowledge=join(local,'knowledge'),cli=join(local,'fixture-cli.mjs');
 const environment=['BOSS_HARNESS_CLI','BOSS_KNOWLEDGE_DIR','DEEPSEEK_API_KEY'];
 const previous=Object.fromEntries(environment.map(name=>[name,process.env[name]]));
 let app;
 t.after(async()=>{
  if(app?.server.listening){const closed=once(app.server,'close');app.shutdown();await closed;}
  for(const name of environment)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name];
  assert.equal(dirname(local),temp);rmSync(local,{recursive:true,force:true});
 });
 mkdirSync(knowledge);
 for(const name of ['12_人格与主人权限.txt','01_系统规则.txt'])writeFileSync(join(knowledge,name),'合成测试规则');
 for(const name of ['13_机器人与主人记忆.json','02_个人事实.json','03_求职偏好.json','04_项目与游戏记忆.json'])writeFileSync(join(knowledge,name),'{}');
 const oldKey='sk-fixture-rejected-native-key',newKey='sk-fixture-repaired-native-key';
 const privateBody='fixture-private-provider-body';
 writeFileSync(cli,String.raw`
  import {appendFileSync} from 'node:fs';
  import {join} from 'node:path';
  let input='';for await(const chunk of process.stdin)input+=chunk;
  const peer=JSON.parse(input).memory.peerId,sessionArgument=process.argv.indexOf('--session-id');
  const prior=sessionArgument<0?null:process.argv[sessionArgument+1];
  const sessionId=prior||'session-'+peer;
  const repaired=process.env.DEEPSEEK_API_KEY===${JSON.stringify(newKey)};
  const status=!repaired?401:peer==='fixture-rate'&&!prior?429:200;
  const reason=status===200?{kind:'completed'}:{kind:'error',error:{code:status===401?'AUTH':'RATE_LIMIT',status,message:${JSON.stringify(privateBody)}}};
  const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
  appendFileSync(join(process.env.BOSS_DATA_DIR,'attempts.jsonl'),JSON.stringify({peer,prior,status})+'\n');
  out({type:'session',sessionId});
  out({type:'status',phase:'turn_end',turn:1,reason});
  const text=status===200?JSON.stringify({action:'send_text',text:'合成回复',reason:'合成测试',score:90}):'';
  out({type:'final',sessionId,reason,text});
  process.exitCode=status===200?0:1;
 `);
 process.env.BOSS_HARNESS_CLI=cli;process.env.BOSS_KNOWLEDGE_DIR=knowledge;
 delete process.env.DEEPSEEK_API_KEY;
 const realNow=Date.now;let advance=0;t.mock.method(Date,'now',()=>realNow()+advance);
 const {createApplication}=await import('../server/app.mjs');
 const port=await testPort(),origin=`http://127.0.0.1:${port}`;
 app=createApplication({desktop:true,port,local,workspace:local,key:oldKey,replyIntervalMs:10,providerFetcher:async()=>{throw Error('Unexpected network request');}});
 app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
 const session=await(await fetch(origin+'/api/session')).json();
 async function api(path,body,token=session.token){
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(body?{body:JSON.stringify(body)}:{})});
  const value=await response.json();assert(response.ok,value.error);return value;
 }
 async function row(id,status){
  for(let attempt=0;attempt<200;attempt++){
   const match=(await api('/api/replies/state')).items.find(item=>item.id===id&&item.status===status);
   if(match)return match;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw Error(`测试回复没有进入 ${status}`);
 }
 const enqueue=peerId=>api('/api/replies/enqueue',{peerId,kind:'reply',trigger:'new_hr_message',messages:[{id:'incoming-'+peerId,role:'hr',text:'合成 HR 消息'}]},app.embeddedToken);
 const attempts=()=>readFileSync(join(local,'attempts.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 await api('/api/config',{learningEnabled:false,modelRoutes:{reply:{provider:'harness',model:'fixture-native'}},profile:{name:'合成主人',facts:'合成资料',titles:['游戏策划'],cities:['北京']}});
 await api('/api/channels',{hrInbox:true});
 const a=(await enqueue('fixture-a')).reply;
 const blocked=await row(a.id,'auth_blocked');
 assert.match(blocked.reason,/401.*模型与联网/);
 assert.equal(Object.hasOwn(blocked,'retryAt'),false);
 const b=(await enqueue('fixture-b')).reply;
 await row(b.id,'auth_blocked');
 advance=600000;await new Promise(resolve=>setTimeout(resolve,40));
 assert.deepEqual(attempts(),[{peer:'fixture-a',prior:null,status:401}]);

 await api('/api/provider-key',{provider:'deepseek',key:newKey});
 await row(a.id,'ready');await row(b.id,'ready');
 const rate=(await enqueue('fixture-rate')).reply;
 const retrying=await row(rate.id,'failed');
 assert.equal(retrying.retryScheduled,true);
 assert(retrying.retryAt>Date.now());
 advance+=16000;
 await row(rate.id,'ready');
 const calls=attempts();
 assert.deepEqual(calls.filter(call=>call.peer==='fixture-a').map(({prior,status})=>[prior,status]),[[null,401],['session-fixture-a',200]]);
 assert.deepEqual(calls.filter(call=>call.peer==='fixture-b').map(call=>call.status),[200]);
 assert.deepEqual(calls.filter(call=>call.peer==='fixture-rate').map(({prior,status})=>[prior,status]),[[null,429],['session-fixture-rate',200]]);
 const saved=readFileSync(join(local,'state.json'),'utf8');
 for(const privateValue of [oldKey,newKey,privateBody])assert(!saved.includes(privateValue));
});
