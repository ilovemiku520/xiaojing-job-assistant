import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runInNewContext} from 'node:vm';
import {createBrowserSetup,stableWin64Chrome} from '../desktop/browser-setup.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const extensionDir=fileURLToPath(new URL('../extension/',import.meta.url));
const version='145.0.7000.10';
const url=`https://storage.googleapis.com/chrome-for-testing-public/${version}/win64/chrome-win64.zip`;
const metadata={channels:{Stable:{version,downloads:{chrome:[{platform:'win64',url}]}}}};
const temp=()=>mkdtemp(join(tmpdir(),'boss-desktop-browser-'));
const windows=process.platform==='win32'&&['x64','arm64'].includes(process.arch);

test('Chrome 下载地址严格匹配官方 Stable win64 发布版本',()=>{
 assert.deepEqual(stableWin64Chrome(metadata),{version,url});
 for(const bad of ['http://'+new URL(url).host+new URL(url).pathname,url+'?redirect=1',url.replace('storage.googleapis.com','example.test'),url.replace(version,'144.0.7000.10')]){
  const data=structuredClone(metadata);data.channels.Stable.downloads.chrome[0].url=bad;
  assert.throws(()=>stableWin64Chrome(data),/下载地址/);
 }
});

async function managedCacheFixture(t,{cachedFile,validDownload=true}={}){
 const parent=await realpath(tmpdir()),runtimeDir=await realpath(await mkdtemp(join(parent,'xiaojing-chrome-cache-')));
 assert.equal(dirname(runtimeDir),parent);
 t.after(()=>rm(runtimeDir,{recursive:true,force:true}));
 const versions=join(runtimeDir,'managed-chrome'),original=join(versions,version);
 const originalExe=join(original,'chrome-win64','chrome.exe'),record=join(versions,'installed.json');
 const profile=join(runtimeDir,'managed-browser-profile');
 await mkdir(dirname(originalExe),{recursive:true});await mkdir(profile);
 const marker=join(original,'partial-marker'),profileMarker=join(profile,'fixture-login');
 await writeFile(marker,'old cache');await writeFile(profileMarker,'owner profile');
 const legacy=JSON.stringify({version})+'\n';
 await writeFile(record,legacy);
 if(cachedFile!==undefined)await writeFile(originalExe,cachedFile);
 const calls={download:0,verify:[],launch:[],pairing:0};
 let online=true;
 const setup=createBrowserSetup({runtimeDir,extensionDir,issuePairingCode:()=>{
  calls.pairing++;return {code:'a'.repeat(64),expiresAt:Date.now()+30000};
 }},{
  fetcher:async request=>{
   if(request===url){calls.download++;return new Response(validDownload?'good archive':'bad archive');}
   if(!online)throw Error('fixture metadata offline');
   return Response.json(metadata);
  },
  unzip:async(archive,destination)=>{
   const exe=join(destination,'chrome-win64','chrome.exe');
   await mkdir(dirname(exe),{recursive:true});
   await writeFile(exe,(await readFile(archive,'utf8'))==='good archive'?'fixture verified':'fixture invalid');
  },
  checkGoogleSignature:async exe=>{
   calls.verify.push(exe);
   if(await readFile(exe,'utf8')!=='fixture verified')throw Error('fixture signature rejected');
  },
  startBrowser:async(exe,args)=>{
   assert.equal(await readFile(exe,'utf8'),'fixture verified');
   assert(args.includes('--user-data-dir='+profile));
   calls.launch.push(exe);
  }
 });
 return {setup,calls,versions,originalExe,record,marker,profileMarker,legacy,offline:()=>{online=false;}};
}

for(const cachedFile of [undefined,'fixture corrupt']){
 const label=cachedFile?'签名无效':'缺少程序';
 test('稳定版旧缓存'+label+'时安装已验签的同版修复目录，重试和离线复用', {skip:!windows}, async t=>{
  const f=await managedCacheFixture(t,{cachedFile});
  const first=await f.setup.launch();
  assert.equal(first.version,version);
  const recorded=JSON.parse(await readFile(f.record,'utf8'));
  assert.equal(recorded.version,version);assert(recorded.slot.startsWith(version+'-repair-'));
  assert.match(recorded.slot.slice((version+'-repair-').length),/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/);
  const repairedExe=join(f.versions,recorded.slot,'chrome-win64','chrome.exe');
  assert.deepEqual(f.calls.launch,[repairedExe]);assert.equal(f.calls.download,1);assert.equal(f.calls.pairing,1);
  assert.equal(await readFile(f.marker,'utf8'),'old cache');
  assert.equal(await readFile(f.profileMarker,'utf8'),'owner profile');
  if(cachedFile)assert.equal(await readFile(f.originalExe,'utf8'),cachedFile);
  else assert.equal(await stat(f.originalExe,{throwIfNoEntry:false}),undefined);
  f.calls.verify.length=0;
  await f.setup.launch();f.offline();await f.setup.launch();
  assert.equal(f.calls.download,1);assert.equal(f.calls.pairing,3);
  assert.deepEqual(f.calls.verify,[repairedExe,repairedExe]);
  assert.deepEqual(f.calls.launch,[repairedExe,repairedExe,repairedExe]);
  assert(!(await readdir(f.versions)).some(name=>name.startsWith('.download-')));
 });
}

test('旧缓存和新下载均验签失败时保留旧目录、资料及安装记录，配对和启动均不执行', {skip:!windows}, async t=>{
 const f=await managedCacheFixture(t,{cachedFile:'fixture corrupt',validDownload:false});
 for(let attempt=0;attempt<2;attempt++)await assert.rejects(f.setup.launch(),/fixture signature rejected/);
 assert.equal(f.calls.download,2);assert.equal(f.calls.pairing,0);assert.deepEqual(f.calls.launch,[]);
 assert.deepEqual((await readdir(f.versions)).sort(),[version,'installed.json'].sort());
 assert.equal(await readFile(f.record,'utf8'),f.legacy);
 assert.equal(await readFile(f.marker,'utf8'),'old cache');
 assert.equal(await readFile(f.originalExe,'utf8'),'fixture corrupt');
 assert.equal(await readFile(f.profileMarker,'utf8'),'owner profile');
});

test('离线只接受本版本安全槽或旧版缓存记录，忽略伪造和跨目录槽名', {skip:!windows}, async t=>{
 const f=await managedCacheFixture(t,{cachedFile:'fixture verified'});
 f.offline();
 for(const slot of ['../outside','..\\outside',version+'-repair-bad','146.0.1.1-repair-a2d207e0-bf57-4a13-87dd-8334efb3ec6c',version+'-repair-a2d207e0-bf57-4a13-87dd-8334efb3ec6c/nested']){
  await writeFile(f.record,JSON.stringify({version,slot}));
  await assert.rejects(f.setup.launch(),/无法从 Google 获取 Chrome 安装信息/);
 }
 const linkedSlot=version+'-repair-a2d207e0-bf57-4a13-87dd-8334efb3ec6c';
 const outside=join(dirname(f.versions),'outside-versions');
 await mkdir(join(outside,'chrome-win64'),{recursive:true});
 await writeFile(join(outside,'chrome-win64','chrome.exe'),'fixture verified');
 await symlink(outside,join(f.versions,linkedSlot),'junction');
 await writeFile(f.record,JSON.stringify({version,slot:linkedSlot}));
 await assert.rejects(f.setup.launch(),/无法从 Google 获取 Chrome 安装信息/);
 assert.deepEqual(f.calls.verify,[]);assert.deepEqual(f.calls.launch,[]);
 await writeFile(f.record,f.legacy);
 await f.setup.launch();
 assert.deepEqual(f.calls.verify,[f.originalExe]);assert.deepEqual(f.calls.launch,[f.originalExe]);assert.equal(f.calls.download,0);
});

test('桌面扩展副本和配对使用指定回环端口，原扩展保持 17321',async()=>{
 const runtimeDir=await temp(),serviceOrigin='http://127.0.0.1:24681';
 for(const invalid of ['https://127.0.0.1:17322','http://localhost:17322','http://127.0.0.1:0','http://127.0.0.1:65536','http://127.0.0.1:17322/path','http://127.0.0.1:17322@outside.test']){
  assert.throws(()=>createBrowserSetup({runtimeDir,extensionDir,serviceOrigin:invalid}),/127\.0\.0\.1/);
 }
 const staged=await createBrowserSetup({runtimeDir,extensionDir,serviceOrigin}).prepare();
 const manifest=JSON.parse(await readFile(join(staged,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.host_permissions,['https://www.zhipin.com/*',serviceOrigin+'/*']);
 for(const name of ['background.js','desktop-background.js','popup.js']){
  const text=await readFile(join(staged,name),'utf8');
  assert(text.includes(serviceOrigin));assert(!text.includes('127.0.0.1:17321'));
 }
 assert((await readFile(join(extensionDir,'background.js'),'utf8')).includes('http://127.0.0.1:17321'));
});

test('专用浏览器成功启动后仅登记挑战，扩展完成配对才切换浏览器', {skip:!windows}, async t=>{
 const runtimeDir=await temp(),calls=[],issued=[];
 const port=await testPort(),app=createApplication({local:join(runtimeDir,'data'),port,key:'fixture',desktop:true});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const serviceOrigin=`http://127.0.0.1:${port}`;
 const pair=async code=>{
  const response=await fetch(serviceOrigin+'/api/desktop-pair',{
   method:'POST',headers:{'Content-Type':'application/json',Origin:'chrome-extension://'+'a'.repeat(32)},body:JSON.stringify({code})
  });
  await response.body.cancel();
  return response.status;
 };
 Object.assign(app.state.config,{running:true,channels:{jobSearch:true,hrInbox:true},browserCalibrated:true});
 const unchanged=()=>{
  assert.equal(app.activeBrowserBridge(),'embedded');
  assert.deepEqual(app.state.config.channels,{jobSearch:true,hrInbox:true});
  assert.equal(app.state.config.browserCalibrated,true);
 };
 let rejectSignature=true,rejectSpawn=true,leaseInFlight=false;
 const setup=createBrowserSetup({runtimeDir,extensionDir,serviceOrigin,issuePairingCode:()=>{
  const value=app.prepareExternalBrowserPairing();issued.push(value);return value;
 }},{
  fetcher:async(request,options)=>{
   assert.equal(options.redirect,'error');
   if(request===url){calls.push('download');return new Response('fixture-archive');}
   assert.equal(new URL(request).host,'googlechromelabs.github.io');return Response.json(metadata);
  },
  unzip:async(archive,destination)=>{
   assert.equal(await readFile(archive,'utf8'),'fixture-archive');
   const exe=join(destination,'chrome-win64','chrome.exe');await mkdir(dirname(exe),{recursive:true});await writeFile(exe,'fixture-signed-exe');
  },
  checkGoogleSignature:async exe=>{
   calls.push('verify');assert.equal(await readFile(exe,'utf8'),'fixture-signed-exe');
   if(rejectSignature)throw Error('fixture untrusted');
  },
  startBrowser:async(exe,args)=>{
   assert.equal(await readFile(exe,'utf8'),'fixture-signed-exe');calls.push('launch');
   assert(args.includes(`--user-data-dir=${join(runtimeDir,'managed-browser-profile')}`));
   assert(args.includes(`--load-extension=${join(runtimeDir,'browser-extension')}`));
   assert(!args.some(arg=>/remote-debugging|no-sandbox/.test(arg)));
   if(app.activeBrowserBridge()==='embedded'){
    unchanged();
    assert.equal(await stat(join(runtimeDir,'browser-extension','desktop-pairing.json'),{throwIfNoEntry:false}),undefined);
    assert.equal(await pair(issued.at(-1).code),403);
   }else assert.equal(await pair(issued.at(-1).code),401);
   if(rejectSpawn)throw Error('fixture spawn failed');
   if(leaseInFlight)app.state.tasks.push({id:'fixture-executing',status:'executing'});
  }
 });
 const staged=await setup.prepare();
 assert.equal((JSON.parse(await readFile(join(staged,'manifest.json'),'utf8'))).background.service_worker,'desktop-background.js');
 assert.equal(await stat(join(staged,'desktop-pairing.json'),{throwIfNoEntry:false}),undefined);
 await assert.rejects(setup.launch(),/fixture untrusted/);assert.deepEqual(calls,['download','verify']);assert.equal(issued.length,0);
 unchanged();
 rejectSignature=false;
 await assert.rejects(setup.launch(),/未能启动/);
 unchanged();assert.equal(await pair(issued[0].code),403);
 assert.equal(await stat(join(staged,'desktop-pairing.json'),{throwIfNoEntry:false}),undefined);
 rejectSpawn=false;leaseInFlight=true;
 await assert.rejects(setup.launch(),/等待回执再切换浏览器/);
 unchanged();assert.equal(await pair(issued[1].code),403);
 assert.equal(await stat(join(staged,'desktop-pairing.json'),{throwIfNoEntry:false}),undefined);
 app.state.tasks.pop();leaseInFlight=false;
 const first=await setup.launch();assert.equal(first.version,version);assert.equal(first.extensionPath,staged);
 unchanged();
 assert.equal(await pair(issued[0].code),401);assert.equal(await pair(issued[1].code),401);
 const {code,expiresAt}=issued[2];
 assert.deepEqual(JSON.parse(await readFile(join(staged,'desktop-pairing.json'),'utf8')),{code,expiresAt});
 assert(!JSON.stringify(first).includes(code));assert.equal(await pair(code),200);
 assert.equal(app.activeBrowserBridge(),'external');assert.equal(app.state.config.running,false);
 assert.equal(issued[2].activate(),false);assert.equal(await pair(code),401);
 await setup.launch();assert.deepEqual(calls,['download','verify','download','verify','launch','verify','launch','verify','launch','verify','launch']);
 assert.notEqual(code,issued[3].code);assert.equal(await pair(issued[3].code),200);
});

test('桌面从旧外部档案换到新档案须核对发送状态，完成配对才撤销旧凭据',async t=>{
 const local=await temp(),port=await testPort();let paired=0;
 const app=createApplication({local,port,key:'fixture',desktop:true,onExternalBrowserPaired:()=>paired++});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 const chrome='chrome-extension://'+'a'.repeat(32),edge='chrome-extension://'+'b'.repeat(32);
 async function call(path,{data,token,origin}={}){
  const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{'X-Boss-Token':token}:{}),...(origin?{Origin:origin}:{})},...(data?{body:JSON.stringify(data)}:{})});
  return {status:r.status,body:await r.json()};
 }
 const pair=(pending,origin)=>call('/api/desktop-pair',{data:{code:pending.code},origin});
 const extension=(token,origin)=>call('/api/browser-state',{token,origin});
 const first=app.prepareExternalBrowserPairing();first.activate();
 assert.equal(app.activeBrowserBridge(),'embedded');assert.equal(paired,0);
 assert.equal((await extension(app.embeddedToken)).status,200);
 const old=await pair(first,chrome);assert.equal(old.status,200);assert.equal(paired,1);
 const oldToken=old.body.extensionToken;
 assert.notEqual(oldToken,session.extensionToken);
 assert.equal((await extension(oldToken,chrome)).status,200);
 assert.equal((await extension(session.extensionToken,chrome)).status,401);
 assert.equal((await extension(app.embeddedToken)).status,401);
 const configured=await call('/api/config',{token:session.token,data:{profile:{name:'合成用户',facts:'合成资料',titles:['游戏策划'],cities:['北京']},browserCalibrated:true}});
 assert.equal(configured.status,200);
 Object.assign(app.state.config,{running:true,channels:{jobSearch:true,hrInbox:true}});
 const executing={id:'fixture-sending',kind:'greeting',status:'executing',reservedAt:Date.now(),job:{url:'https://www.zhipin.com/job_detail/synthetic.html'}};
 app.state.tasks.push(executing);
 assert.throws(()=>app.prepareExternalBrowserPairing(),/等待回执/);
 assert.equal((await extension(oldToken,chrome)).body.config.hrInboxRunning,true);
 app.state.tasks.pop();
 const replacement=app.prepareExternalBrowserPairing();replacement.activate();
 assert.equal((await extension(oldToken,chrome)).body.config.hrInboxRunning,true);
 assert.equal(app.state.config.browserCalibrated,true);
 app.state.tasks.push(executing);
 assert.equal((await pair(replacement,edge)).status,409);
 assert.equal((await extension(oldToken,chrome)).status,200);
 assert.equal(paired,1);
 app.state.tasks.pop();
 const fresh=await pair(replacement,edge);assert.equal(fresh.status,200);
 assert.notEqual(fresh.body.extensionToken,oldToken);
 assert.equal(paired,2);
 assert.equal((await extension(oldToken,chrome)).status,401);
 assert.equal((await extension(fresh.body.extensionToken,chrome)).status,401);
 const allowed=await extension(fresh.body.extensionToken,edge);
 assert.equal(allowed.status,200);
 assert.equal(allowed.body.accountRecheck.required,true);
 assert.equal(allowed.body.config.hrInboxRunning,false);
 assert.equal(app.state.config.browserCalibrated,false);
 assert.equal((await pair(replacement,edge)).status,401);
});

test('启动已有浏览器失败时保留上一次配对文件，不激活新挑战', {skip:process.platform!=='win32'}, async t=>{
 const runtimeDir=await temp(),programFiles=join(runtimeDir,'programs');
 const savedProgramFiles=process.env.ProgramFiles;
 process.env.ProgramFiles=programFiles;
 t.after(()=>{if(savedProgramFiles===undefined)delete process.env.ProgramFiles;else process.env.ProgramFiles=savedProgramFiles;});
 const edge=join(programFiles,'Microsoft','Edge','Application','msedge.exe');
 await mkdir(dirname(edge),{recursive:true});await writeFile(edge,'synthetic exe');
 let attempt=0;const activated=[];
 const setup=createBrowserSetup({runtimeDir,extensionDir,issuePairingCode:()=>{
  const id=++attempt;
  return {code:id.toString(16).padStart(64,'0'),expiresAt:Date.now()+120000,activate:()=>activated.push(id)};
 }},{startBrowser:async(exe,args)=>{
  assert.equal(exe,edge);assert.deepEqual(args,['edge://extensions/']);
  assert(!activated.includes(attempt));
  if(attempt===2)throw Error('fixture launch failed');
 }});
 const first=await setup.openFallback('edge');
 const challenge=join(first.extensionPath,'desktop-pairing.json'),content=await readFile(challenge,'utf8');
 assert.deepEqual(activated,[1]);
 await assert.rejects(setup.openFallback('edge'),/无法打开浏览器/);
 assert.deepEqual(activated,[1]);assert.equal(await readFile(challenge,'utf8'),content);
});

test('扩展只把一次性挑战交换成扩展令牌并保存到自己的存储',async()=>{
 const code='a'.repeat(64),extensionToken='b'.repeat(64),serviceOrigin='http://127.0.0.1:24682';
 const staged=await createBrowserSetup({runtimeDir:await temp(),extensionDir,serviceOrigin}).prepare();
 const script=await readFile(join(staged,'desktop-background.js'),'utf8');
 let saved,save;
 const completed=new Promise(r=>{save=r;});
 runInNewContext(script,{
  importScripts:path=>assert.equal(path,'background.js'),
  chrome:{runtime:{getURL:path=>'chrome-extension://'+'c'.repeat(32)+'/'+path},alarms:{create(){},onAlarm:{addListener(){}}},storage:{local:{get:async()=>({}),set:async data=>{saved=data;save();}}}},
  AbortSignal,
  fetch:async(path,options)=>{
   if(path.startsWith('chrome-extension://'))return Response.json({code,expiresAt:Date.now()+50000});
   assert.equal(path,serviceOrigin+'/api/desktop-pair');
   assert.deepEqual(JSON.parse(options.body),{code});return Response.json({extensionToken});
  }
 });
 await completed;
 assert.equal(saved.token,extensionToken);
});

test('桌面配对只允许扩展兑换当前挑战一次，永远不返回主人令牌',async t=>{
 const local=await temp(),port=await testPort(),app=createApplication({local,port,key:'fixture'});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const base=`http://127.0.0.1:${port}`;
 const session=await(await fetch(base+'/api/session')).json();
 const pair=(code,Origin)=>fetch(base+'/api/desktop-pair',{method:'POST',headers:{'Content-Type':'application/json',...(Origin?{Origin}:{})},body:JSON.stringify({code})});
 const extensionOrigin='chrome-extension://'+'a'.repeat(32);
 const old=app.issueBrowserPairing(),current=app.issueBrowserPairing();
 assert.equal((await pair(current.code)).status,403);
 assert.equal((await pair(current.code,'https://www.zhipin.com')).status,403);
 assert.equal((await pair(old.code,extensionOrigin)).status,401);
 const responses=await Promise.all([pair(current.code,extensionOrigin),pair(current.code,extensionOrigin)]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,401]);
 assert.deepEqual(await responses.find(r=>r.ok).json(),{extensionToken:session.extensionToken});
 const expired=app.issueBrowserPairing(),now=Date.now();t.mock.method(Date,'now',()=>now+121000);
 assert.equal((await pair(expired.code,extensionOrigin)).status,401);
});

test('未激活或已过期的桌面预配对不会切换浏览器',async t=>{
 const local=await temp(),port=await testPort(),app=createApplication({local,port,key:'fixture',desktop:true});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const challenge=app.prepareExternalBrowserPairing();
 assert.equal(app.activeBrowserBridge(),'embedded');
 t.mock.method(Date,'now',()=>challenge.expiresAt);
 assert.throws(()=>challenge.activate(),/配对已过期/);
 assert.equal(app.activeBrowserBridge(),'embedded');
});

test('显式继续使用内置浏览器会取消待发布与已发布的外部配对，并保留当前执行',async t=>{
 const local=await temp(),port=await testPort(),app=createApplication({local,port,key:'fixture',desktop:true});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const published=app.prepareExternalBrowserPairing();published.activate();
 const inPreparation=app.prepareExternalBrowserPairing();
 const executing={id:'fixture-executing',status:'executing',kind:'greeting',job:{url:'https://www.zhipin.com/job_detail/fixture.html'},reservedAt:Date.now()};
 app.state.tasks.push(executing);
 assert.equal(app.selectBrowserBridge('embedded'),false);
 assert.equal(app.state.tasks[0].status,'executing');
 const denied=await fetch(`http://127.0.0.1:${port}/api/desktop-pair`,{method:'POST',headers:{'Content-Type':'application/json',Origin:'chrome-extension://'+'a'.repeat(32)},body:JSON.stringify({code:published.code})});
 assert.equal(denied.status,403);await denied.body.cancel();
 app.state.tasks.pop();
 assert.throws(()=>inPreparation.activate(),/配对已取消/);
});
