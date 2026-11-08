import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../server/app.mjs';
import {defaults,validateConfig} from '../server/core.mjs';
import {requestModel,resolveModelRoute,normalizeCompatibleBaseURL} from '../server/providers.mjs';
import {loadProviderKey,saveProviderKey} from '../server/secret.mjs';
import {ownerPublicWebTool} from '../tools/boss-web-mcp.mjs';
import {testPort} from './port.mjs';

const completion=content=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content}}]})});

test('模型连接测试版本隔离旧密钥、共用密钥与兼容地址，不暴露凭据',async t=>{
  const temporary=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temporary,'xiaojing-test-revision-')));
  assert.equal(dirname(local),temporary);
  const port=await testPort(),calls=[],started=Promise.withResolvers(),release=Promise.withResolvers();
  const app=createApplication({local,workspace:local,port,key:'',providerFetcher:async(_url,{headers})=>{
    calls.push(headers.Authorization);started.resolve();await release.promise;
    return completion('{"ok":true}');
  }});
  await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  t.after(async()=>{release.resolve();await app.shutdown();rmSync(local,{recursive:true,force:true});});
  const base='http://127.0.0.1:'+port,{token}=await(await fetch(base+'/api/session')).json();
  const api=async(path,data)=>{
    const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'X-Boss-Token':token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  };
  const oldKey='fixture-old-openai-key',newKey='fixture-new-openai-key',deepseekKey='sk-fixture_deepseek_key_01';
  const routes=async()=>(await api('/api/providers')).body.routes;
  assert.equal((await api('/api/config',{backend:'api',compatibleBaseURL:'https://first.example.test/v1',modelRoutes:{
    greeting:{provider:'openai',model:'fixture-openai'},followup:{provider:'compatible',model:'fixture-compatible'}
  }})).status,200);
  assert.equal((await api('/api/provider-key',{provider:'openai',key:oldKey})).status,200);
  const initial=await routes();
  assert.match(initial.greeting.testRevision,/^[a-f0-9]{32}$/);
  assert.equal((await routes()).greeting.testRevision,initial.greeting.testRevision);
  const pending=api('/api/test',{stage:'greeting',testRevision:initial.greeting.testRevision});
  await started.promise;
  assert.equal((await api('/api/provider-key',{provider:'openai',key:newKey})).status,200);
  const replaced=await routes();
  assert.notEqual(replaced.greeting.testRevision,initial.greeting.testRevision);
  assert.equal(replaced.reply.testRevision,initial.reply.testRevision);
  assert.equal((await api('/api/test',{stage:'greeting',testRevision:initial.greeting.testRevision})).status,409);
  release.resolve();
  const oldResult=await pending;
  assert.equal(oldResult.status,200);
  assert.equal(oldResult.body.testRevision,initial.greeting.testRevision);
  assert.deepEqual(calls,['Bearer '+oldKey]);
  assert.equal((await api('/api/test',{stage:'greeting'})).body.testRevision,replaced.greeting.testRevision);
  assert.equal(calls.at(-1),'Bearer '+newKey);

  assert.equal((await api('/api/provider-key',{provider:'deepseek',key:deepseekKey})).status,200);
  const shared=await routes();
  assert.notEqual(shared.owner.testRevision,replaced.owner.testRevision);
  assert.notEqual(shared.reply.testRevision,replaced.reply.testRevision);
  assert.equal(shared.greeting.testRevision,replaced.greeting.testRevision);
  assert.equal((await api('/api/key',{key:'sk-fixture_deepseek_key_02'})).status,200);
  const legacy=await routes();
  assert.notEqual(legacy.owner.testRevision,shared.owner.testRevision);
  assert.notEqual(legacy.reply.testRevision,shared.reply.testRevision);
  assert.equal((await api('/api/config',{compatibleBaseURL:'https://second.example.test/v1'})).status,200);
  const configured=await routes();
  assert.notEqual(configured.followup.testRevision,legacy.followup.testRevision);
  assert.equal(configured.reply.testRevision,legacy.reply.testRevision);
  const visible=JSON.stringify([(await api('/api/providers')).body,oldResult.body]);
  for(const secret of [oldKey,newKey,deepseekKey])assert.equal(visible.includes(secret),false);
});

test('各任务模型可独立设置、继承和还原，旧设置继续有效',()=>{
  const initial=validateConfig({backend:'api',model:'deepseek-flash'},defaults);
  assert.equal(resolveModelRoute(initial,'owner').provider,'harness');
  assert.equal(resolveModelRoute(initial,'reply').provider,'deepseek');
  const updated=validateConfig({
    compatibleBaseURL:'https://models.example.test/v1/chat/completions/',
    modelRoutes:{
      greeting:{provider:'dashscope',model:'qwen-plus'},
      reply:{provider:'compatible',model:'my-org/my-model:beta'},
      followup:{provider:'anthropic',model:'claude-fixture',key:'this field is ignored'}
    }
  },initial);
  assert.equal(resolveModelRoute(updated,'reply').baseURL,'https://models.example.test/v1');
  assert.equal(resolveModelRoute(updated,'greeting').provider,'dashscope');
  assert.equal(resolveModelRoute(updated,'learning').provider,'deepseek');
  assert.equal(updated.modelRoutes.followup.key,undefined);
  assert.equal(resolveModelRoute(validateConfig({modelRoutes:{reply:null}},updated),'reply').provider,'deepseek');
  assert.throws(()=>validateConfig({modelRoutes:{toString:{provider:'deepseek',model:'x'}}},updated));
  assert.throws(()=>validateConfig({modelRoutes:{reply:{provider:'constructor',model:'x'}}},updated));
  for(const url of ['http://provider.example','https://name:secret@provider.example','https://provider.example/v1?key=123','https://localhost/v1','https://127.0.0.1/v1','https://[::1]/v1']) {
    assert.throws(()=>normalizeCompatibleBaseURL(url));
  }
});

test('适配器按厂商使用不同请求结构，保留仅完整正文并屏蔽密钥',async()=>{
  const key='fixture-vendor-secret';
  for(const provider of ['deepseek','openai','anthropic','gemini','dashscope','compatible']){
    const parsed=await requestModel({
      route:{provider,model:'fixture-model',reasoningEffort:'max',baseURL:'https://custom.example.test/v1'},
      key,system:'虚构测试',payload:{test:key},fetcher:async(url,options)=>{
        assert.equal(options.redirect,'error');
        const body=JSON.parse(options.body);
        assert.equal(body.model,'fixture-model');
        assert(!options.body.includes(key));
        if(provider==='anthropic'){
          assert.equal(url,'https://api.anthropic.com/v1/messages');
          assert.equal(options.headers['x-api-key'],key);
          assert.equal(options.headers['anthropic-version'],'2023-06-01');
          assert.equal(body.messages[0].role,'user');
          return {ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'thinking',thinking:'do not expose'},{type:'text',text:JSON.stringify({text:key})}]})};
        }
        assert.equal(options.headers.Authorization,'Bearer '+key);
        if(provider==='deepseek'){assert.equal(body.reasoning_effort,'max');assert.equal(body.thinking.type,'enabled');}
        else assert.equal(body.reasoning_effort,undefined);
        if(provider==='openai')assert.equal(body.max_completion_tokens,6000);
        if(provider==='compatible')assert.equal(url,'https://custom.example.test/v1/chat/completions');
        return completion(JSON.stringify({text:key}));
      }
    });
    assert.deepEqual(parsed,{text:'[凭据已隐藏]'});
  }
  const input={route:{provider:'openai',model:'fixture-model'},key,system:'虚构测试',payload:{}};
  await assert.rejects(requestModel({...input,fetcher:async()=>{throw Error(key);}}),e=>!e.message.includes(key)&&/连接失败/.test(e.message));
  await assert.rejects(requestModel({...input,fetcher:async()=>({ok:false,status:401,json:async()=>{throw Error(key);}})}),e=>!e.message.includes(key)&&/401/.test(e.message));
  await assert.rejects(requestModel({...input,fetcher:async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{}',tool_calls:[{}]}}]})})}),/未完整结束/);
});

test('兼容提供商密钥在改换 HTTPS 地址后不会沿用',()=>{
  const local=mkdtempSync(join(tmpdir(),'xiaojing-provider-secret-')),key='fixture-compatible-secret';
  const first='https://first.example.test/v1',second='https://second.example.test/v1';
  saveProviderKey(local,'compatible',key,first);
  assert.equal(loadProviderKey(local,'compatible',first+'/'),key);
  assert.equal(loadProviderKey(local,'compatible',second),'');
  assert.equal(loadProviderKey(local,'openai'),'');
});

test('主人明确给出的网页可作为外部模型工具结果，其他地址不会读取',async()=>{
  const address='https://example.org/docs',reads=[];
  const tool=ownerPublicWebTool('看看 [这份说明]('+address+')。',async url=>{
    reads.push(url);
    return {url,trust:'untrusted',text:'虚构公开网页'};
  });
  assert.equal(ownerPublicWebTool('请搜索某个主题'),null);
  assert.equal(ownerPublicWebTool('请打开 https://www.zhipin.com/web/geek/chat'),null);
  await assert.rejects(tool.call({url:'https://example.org/another'}),/本轮明确/);
  for(const provider of ['openai','anthropic']){
    const claude=provider==='anthropic',progress=[];
    let calls=0;
    const answer=await requestModel({
      route:{provider,model:'fixture'},key:'fixture-api-key',system:'虚构主人对话',payload:{},format:'text',ownerWebTool:tool,
      onProgress:status=>progress.push(status.type),
      fetcher:async(_url,request)=>{
        const body=JSON.parse(request.body);
        assert.equal(claude?body.tools[0].name:body.tools[0].function.name,tool.name);
        if(++calls===1){
          const args={url:address};
          const data=claude
            ?{stop_reason:'tool_use',content:[{type:'tool_use',id:'tool-1',name:tool.name,input:args}]}
            :{choices:[{finish_reason:'tool_calls',message:{tool_calls:[{type:'function',id:'tool-1',function:{name:tool.name,arguments:JSON.stringify(args)}}]}}]};
          return {ok:true,json:async()=>data};
        }
        const last=body.messages.at(-1),result=claude?last.content[0]:last;
        assert.equal(claude?result.tool_use_id:result.tool_call_id,'tool-1');
        assert.deepEqual(JSON.parse(result.content),{url:address,trust:'untrusted',text:'虚构公开网页'});
        return claude?{ok:true,json:async()=>({stop_reason:'end_turn',content:[{type:'text',text:'虚构回答'}]})}:completion('虚构回答');
      }
    });
    assert.equal(answer,'虚构回答');
    assert.deepEqual(progress,['tool_call','tool_result']);
  }
  assert.deepEqual(reads,[address,address]);
});

test('提供商接口仅限主人，HR和主人对话走各自模型，不需要旧 DeepSeek 密钥',async t=>{
  const local=mkdtempSync(join(tmpdir(),'xiaojing-provider-api-')),calls=[],reads=[];
  const oldDesktop=process.env.BOSS_DESKTOP_EXE;
  process.env.BOSS_DESKTOP_EXE=process.execPath;
  t.after(()=>{if(oldDesktop===undefined)delete process.env.BOSS_DESKTOP_EXE;else process.env.BOSS_DESKTOP_EXE=oldDesktop;});
  const providerFetcher=async(url,{headers,body})=>{
    const input=JSON.parse(body);
    calls.push({url,authorization:headers.Authorization,model:input.model,tool:input.tools?.[0]?.function?.name});
    if(input.messages[0].content.startsWith('这是无个人数据的模型连接测试')){
      assert(!body.includes('专用测试人名'));
      return completion('{"ok":true}');
    }
    if(input.model==='fixture-reply')return completion('{"action":"send_text","text":"主人还在看游戏策划实习机会，方便聊聊岗位内容吗？","score":90,"reason":"合成测试"}');
    if(input.tools?.length&&input.messages.at(-1).role!=='tool')return {
      ok:true,json:async()=>({choices:[{finish_reason:'tool_calls',message:{tool_calls:[{
        type:'function',id:'fixture-tool-id',function:{name:input.tools[0].function.name,arguments:'{"url":"https://example.org/docs"}'}
      }]}}]})
    };
    return completion('这是模拟的主人频道回复。');
  };
  const publicWebFetcher=async url=>{reads.push(url);return {url,source:'public_web',trust:'untrusted',text:'虚构资料'};};
  const app=createApplication({local,port:await testPort(),key:'',providerFetcher,publicWebFetcher});
  await new Promise(r=>app.server.listen(app.port,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
  const base='http://127.0.0.1:'+app.port,session=await(await fetch(base+'/api/session')).json();
  const api=async(path,data,token=session.token)=>{
    const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'X-Boss-Token':token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  };
  const openAIKey='fixture-openai-secret',geminiKey='fixture-gemini-secret';
  assert.equal((await api('/api/provider-key',{provider:'openai',key:openAIKey},session.extensionToken)).status,403);
  assert.equal((await api('/api/providers',undefined,session.extensionToken)).status,403);
  assert.equal((await api('/api/provider-key',{provider:'openai',key:openAIKey})).status,200);
  assert.equal((await api('/api/provider-key',{provider:'gemini',key:geminiKey})).status,200);
  assert.equal((await api('/api/config',{
    learningEnabled:false,profile:{name:'专用测试人名',facts:'虚构资料',titles:['游戏策划'],cities:['北京']},
    modelRoutes:{reply:{provider:'gemini',model:'fixture-reply'},owner:{provider:'openai',model:'fixture-owner'}}
  })).status,200);
  const settings=(await api('/api/providers')).body;
  assert.equal(settings.routes.reply.model,'fixture-reply');
  assert.equal(settings.providers.find(p=>p.id==='openai').configured,true);
  assert.equal(settings.providers.find(p=>p.id==='deepseek').configured,false);
  assert(!JSON.stringify(settings).includes(openAIKey));
  assert(!readFileSync(join(local,'state.json'),'utf8').includes(geminiKey));
  assert.equal((await api('/api/test',{stage:'owner'})).status,200);
  assert.equal((await api('/api/channels',{hrInbox:true})).status,200);
  const prepared=await api('/api/prepare',{kind:'reply',trigger:'new_hr_message',peerId:'provider-test:hr',header:'虚构HR',messages:[{id:'fixture-id',role:'hr',text:'还在看实习吗？'}]},session.extensionToken);
  assert.equal(prepared.body.task.modelRoute.provider,'gemini');
  assert.equal(prepared.body.task.status,'pending');
  async function ownerTurn(prompt){
    const owner=await api('/api/owner-task',{prompt});
    assert.equal(owner.status,200);
    for(let attempt=0;attempt<30&&app.state.ownerTasks[0].status==='running';attempt++)await new Promise(r=>setTimeout(r,10));
    assert.equal(app.state.ownerTasks[0].status,'done');
    return app.state.ownerTasks[0].result;
  }
  assert.match(await ownerTurn('请分析 https://example.org/docs'),/本轮为外部模型文字分析/);
  assert.deepEqual(calls.map(x=>[x.model,x.authorization]),[
    ['fixture-owner','Bearer '+openAIKey],['fixture-reply','Bearer '+geminiKey],['fixture-owner','Bearer '+openAIKey]
  ]);
  assert(calls.every(call=>call.tool===undefined));
  assert.deepEqual(reads,[]);
  assert.equal((await api('/api/mcp-tools',{action:'install',templateId:'web'})).status,200);
  assert.match(await ownerTurn('请读取 https://example.org/docs'),/本轮读取了 1 次公开网页/);
  assert.deepEqual(calls.slice(-2).map(call=>call.tool),['boss_fetch_public_page','boss_fetch_public_page']);
  assert.deepEqual(reads,['https://example.org/docs']);
  await api('/api/prepare',{kind:'reply',trigger:'new_hr_message',peerId:'provider-test:other',header:'虚构HR',messages:[{id:'fixture-new',role:'hr',text:'请阅读 https://example.org/docs'}]},session.extensionToken);
  assert.equal(calls.at(-1).tool,undefined);
  assert.equal(reads.length,1);
});
