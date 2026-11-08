import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Readable} from 'node:stream';
import {createInterface} from 'node:readline';
import {fetchPublicPage,ownerPublicWebTool,ownerPublicWebUrls,serveBossWebMcp} from '../tools/boss-web-mcp.mjs';

const publicAnswer={address:'93.184.216.34',family:4};
const lookup=async()=>[publicAnswer];
const denyRequest=()=>assert.fail('a disallowed target reached HTTPS');
function fixture(responses,inspect=()=>{}){
  const calls=[];
  function request(url,options,callback){
    calls.push({url:url.href,options});
    inspect(url,options);
    const req=new EventEmitter();
    req.end=()=>{
      const response=responses.shift();
      assert(response,'unexpected additional HTTPS request');
      const stream=Readable.from(response.body===undefined?[]:[Buffer.from(response.body)]);
      stream.statusCode=response.statusCode||200;
      stream.headers=response.headers||{'content-type':'text/plain'};
      queueMicrotask(()=>callback(stream));
    };
    return req;
  }
  return {request,calls};
}

test('公开 HTTPS 页面只按核验的 DNS 地址建立连接并输出可见正文',async()=>{
  const {request,calls}=fixture([{
    body:'<!doctype html><head><title>Hidden</title></head><body><h1>测试 &amp; &#x6D4B;&#35797;</h1><script>私密脚本</script><style>不可见样式</style><p>页面信息</p></body>',
    headers:{'content-type':'text/html; charset=utf-8'},
  }],(url,options)=>{
    assert.equal(url.hostname,'www.example.com');
    assert.equal(options.method,'GET');
    assert.equal(options.agent,false);
    assert(options.rejectUnauthorized);
    assert.equal(options.family,4);
    assert.equal(options.autoSelectFamily,false);
    assert(!Object.keys(options.headers).some(key=>/authorization|cookie/i.test(key)));
    options.lookup(url.hostname,{},(error,address,family)=>{
      assert.equal(error,null);
      assert.equal(address,publicAnswer.address);
      assert.equal(family,4);
    });
    options.lookup('rebind.other.com',{},error=>assert(error));
  });
  const page=await fetchPublicPage('https://www.example.com/news#top',{lookup,request});
  assert.equal(calls.length,1);
  assert.equal(page.url,'https://www.example.com/news');
  assert.equal(page.source,'public_web');
  assert.equal(page.trust,'untrusted');
  assert.match(page.text,/测试 & 测试/);
  assert.match(page.text,/页面信息/);
  assert.doesNotMatch(page.text,/私密脚本|不可见样式|Hidden/);
});

test('本机、私网、保留地址、元数据、BOSS、明文协议和凭据地址在连接前拒绝',async()=>{
  for(const url of [
    'http://www.example.com','https://www.example.com:8443','https://alice:password@www.example.com',
    'https://www.example.com/?access_token=fiction','https://www.example.com/?%61pi_key=fiction',
    'https://LOCALHOST','https://0x7f000001','https://127.1','https://10.0.0.1','https://169.254.169.254','https://100.100.100.200',
    'https://168.63.129.16','https://192.0.2.1','https://198.18.0.1','https://255.255.255.255',
    'https://[::1]','https://[::ffff:7f00:1]','https://[64:ff9b::7f00:1]','https://[2002:7f00:1::]','https://[2001:db8::1]',
    'https://metadata.google.internal','https://metadata.goog','https://zhipin.com.','https://www.zhipin.com/web/geek/chat',
  ]){
    await assert.rejects(fetchPublicPage(url,{lookup,request:denyRequest}),e=>e.code==='url'||e.code==='target',url);
  }
  for(const answer of [{address:'127.0.0.1',family:4},{address:'::ffff:192.168.1.1',family:6},{address:'93.184.216.34',family:6}]){
    await assert.rejects(fetchPublicPage('https://www.example.com',{lookup:async()=>[publicAnswer,answer],request:denyRequest}),{code:'target'});
  }
});

test('每次跳转重新解析并检查所有目标地址，拒绝 DNS 重绑定和无限跳转',async()=>{
  const privateRedirect=fixture([{statusCode:302,headers:{location:'https://[::1]/private'}}]);
  await assert.rejects(fetchPublicPage('https://www.example.com',{lookup,request:privateRedirect.request}),{code:'target'});
  assert.equal(privateRedirect.calls.length,1);
  let resolutions=0;
  const rebind=fixture([{statusCode:302,headers:{location:'/follow'}}]);
  await assert.rejects(fetchPublicPage('https://www.example.com',{lookup:async()=>++resolutions===1?[publicAnswer]:[{address:'127.0.0.1',family:4}],request:rebind.request}),{code:'target'});
  assert.equal(resolutions,2);
  assert.equal(rebind.calls.length,1);
  const loop=fixture(Array.from({length:4},()=>({statusCode:302,headers:{location:'/repeat'}})));
  await assert.rejects(fetchPublicPage('https://www.example.com',{lookup,request:loop.request}),{code:'redirect'});
  assert.equal(loop.calls.length,4);
});

test('主人本轮范围在跳转时同样生效，独立读取仍允许公开跳转',async()=>{
  const first='https://example.org/start',next='https://example.net/end';
  const redirect={statusCode:302,headers:{location:next}};
  const blocked=fixture([redirect]);
  const ownerTool=ownerPublicWebTool(first,(url,options)=>fetchPublicPage(url,{...options,lookup,request:blocked.request}));
  await assert.rejects(ownerTool.call({url:first}),{code:'scope'});
  assert.deepEqual(blocked.calls.map(call=>call.url),[first]);
  for(const allowed of [undefined,new Set([first,next])]){
    const permitted=fixture([redirect,{body:'synthetic destination'}]);
    assert.equal((await fetchPublicPage(first,{lookup,request:permitted.request,allowed})).url,next);
    assert.deepEqual(permitted.calls.map(call=>call.url),[first,next]);
  }
});

test('主人网页范围排除明文、编码和混合转义的受保护凭据',()=>{
  const secret='sk-fixture-protected-key',encoded='%73'+secret.slice(1),safe='https://example.org/public';
  const urls=[
    'https://example.org/'+secret,
    'https://example.org/'+encoded,
    'https://example.org/%FF%zz'+encoded,
    'https://example.org/?q='+encoded,
    'https://example.org/?q=%25'+encoded.slice(1),
    'https://example.org/?'+encoded+'=news',
    'https://example.org/?q=another+fixture',
    'https://example.org/'+'鲸'.repeat(230),
    safe+'#view',
    safe,
  ];
  assert.deepEqual(ownerPublicWebUrls(urls.join(' '),[secret,'another fixture']),[safe]);
  assert.equal(ownerPublicWebTool(urls[3],denyRequest,[secret]),null);
});

test('网页读取限制正文类型、字节数及回传长度，允许取消待解析请求',async()=>{
  const invalid=[
    [{headers:{'content-type':'image/png'}},'type'],
    [{headers:{'content-type':'text/html','content-encoding':'gzip'}},'encoding'],
    [{headers:{'content-type':'text/plain','content-length':String(256*1024+1)}},'size'],
    [{body:'X'.repeat(256*1024+1)},'size'],
  ];
  for(const [response,code] of invalid){
    await assert.rejects(fetchPublicPage('https://www.example.com',{lookup,request:fixture([response]).request}),{code});
  }
  const large=fixture([{body:'鲸'.repeat(12001)}]);
  const page=await fetchPublicPage('https://www.example.com',{lookup,request:large.request});
  assert.equal(page.text.length,12000);
  assert(page.truncated);
  const controller=new AbortController();
  const pending=fetchPublicPage('https://www.example.com',{lookup:()=>new Promise(()=>{}),request:denyRequest,signal:controller.signal});
  controller.abort();
  await assert.rejects(pending);
});

test('公开网页 MCP 独立握手并只公开一个读取工具',async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const lines=createInterface({input:output})[Symbol.asyncIterator]();
  const closed=serveBossWebMcp({input,output});
  const send=body=>input.write(JSON.stringify({jsonrpc:'2.0',...body})+'\n');
  send({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'web-fixture',version:'1'}}});
  assert.equal(JSON.parse((await lines.next()).value).result.serverInfo.name,'xiaojing-public-web');
  send({method:'notifications/initialized'});
  send({id:2,method:'tools/list'});
  const {tools}=JSON.parse((await lines.next()).value).result;
  assert.deepEqual(tools.map(tool=>tool.name),['boss_fetch_public_page']);
  assert.equal(tools[0].annotations.readOnlyHint,true);
  send({id:3,method:'tools/call',params:{name:'boss_fetch_public_page',arguments:{url:'https://127.0.0.1'}}});
  assert.equal(JSON.parse((await lines.next()).value).result.isError,true);
  input.end();
  await closed;
  output.end();
});

test('托管公开网页 MCP 只读取允许的本轮地址，空或无效范围均拒绝',async t=>{
  const listed='https://example.org/this-turn',unlisted='https://example.org/another-turn';
  for(const scope of [JSON.stringify([listed]),'','malformed',JSON.stringify([listed,'https://127.0.0.1/'])]){
    const input=new PassThrough(),output=new PassThrough(),reads=[];
    const lines=createInterface({input:output})[Symbol.asyncIterator]();
    const closed=serveBossWebMcp({input,output,scope,read:async(url,options)=>{
      reads.push(url);
      assert.deepEqual([...options.allowed],[listed]);
      return {url,text:'synthetic authorized page'};
    }});
    t.after(async()=>{input.end();await closed;output.end();});
    const send=body=>input.write(JSON.stringify({jsonrpc:'2.0',...body})+'\n');
    send({id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'web-fixture',version:'1'}}});
    assert.equal(JSON.parse((await lines.next()).value).id,1);
    send({method:'notifications/initialized'});
    const call=async(id,url)=>{
      send({id,method:'tools/call',params:{name:'boss_fetch_public_page',arguments:{url}}});
      return JSON.parse((await lines.next()).value).result;
    };
    assert.equal((await call(2,unlisted)).isError,true);
    const valid=scope===JSON.stringify([listed]);
    const result=await call(3,listed+'#read');
    if(valid)assert.match(JSON.stringify(result),/synthetic authorized page/);
    else assert.equal(result.isError,true);
    assert.deepEqual(reads,valid?[listed]:[]);
  }
});
