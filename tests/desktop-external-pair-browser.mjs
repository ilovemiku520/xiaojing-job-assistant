// Real Electron pairing UI with a synthetic installed browser and a local extension identity.
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=realpathSync(tmpdir()),home=realpathSync(mkdtempSync(join(temporary,'xiaojing-external-pair-test-')));
assert.equal(dirname(home),temporary);
const programs=join(home,'programs'),edge=join(programs,'Microsoft','Edge','Application','msedge.exe');
mkdirSync(dirname(edge),{recursive:true});writeFileSync(edge,'fixture only');
const packagedExe=process.argv[2],exe=packagedExe||join(root,'tools','cache','electron','runtime','electron.exe');
const port=await testPort(),origin='http://127.0.0.1:'+port,chat='https://www.zhipin.com/web/geek/chat';
const challenge=join(home,'profile','browser','edge-extension','desktop-pairing.json');
let app;

try{
  app=await electron.launch({executablePath:exe,args:packagedExe?[]:[resolve(root)],env:{...process.env,XIAOJING_DESKTOP_HOME:home,XIAOJING_DESKTOP_PORT:String(port),ProgramFiles:programs},timeout:25000});
  const win=await app.firstWindow({timeout:25000});
  await win.locator('#main-nav').getByRole('button',{name:'工作台',exact:true}).waitFor();
  await app.evaluate(({session,clipboard},{chat,programs,edge})=>{
    process.env.ProgramFiles=programs;
    const childProcess=process.getBuiltinModule('node:child_process');
    const {EventEmitter}=process.getBuiltinModule('node:events');
    const {syncBuiltinESMExports}=process.getBuiltinModule('node:module');
    const originalSpawn=childProcess.spawn;
    globalThis.pairFixture={clipboard:'',launches:[],failLaunch:true};
    childProcess.spawn=(file,args,options)=>{
      if(file!==edge){
        if(/[/\\](?:msedge|chrome)\.exe$/i.test(String(file)))throw Error('fixture blocked real browser launch');
        return originalSpawn(file,args,options);
      }
      pairFixture.launches.push(args);
      const child=new EventEmitter();child.unref=()=>{};
      queueMicrotask(()=>pairFixture.failLaunch?child.emit('error',Error('synthetic launch failure')):child.emit('spawn'));
      return child;
    };
    syncBuiltinESMExports();
    clipboard.writeText=value=>{pairFixture.clipboard=value;};
    const partition=session.fromPartition('persist:xiaojing-boss');
    partition.protocol.handle('https',request=>request.url===chat?new Response('<!doctype html><meta charset="utf-8"><title>合成聊天页</title>',{headers:{'Content-Type':'text/html'}}):new Response('',{status:403}));
    partition.protocol.handle('http',()=>new Response('',{status:403}));
  },{chat,programs,edge});
  assert.equal(await app.evaluate(()=>process.env.ProgramFiles),programs);

  const session=await(await fetch(origin+'/api/session')).json();
  async function request(path,{data,token=session.token,extensionOrigin}={}){
    const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{'X-Boss-Token':token}:{}),...(extensionOrigin?{Origin:extensionOrigin}:{})},...(data?{body:JSON.stringify(data)}:{})});
    return {status:response.status,body:await response.json()};
  }
  const browser=()=>win.evaluate(()=>window.xiaojingDesktop.embedded('state'));
  const browserPanel=()=>win.locator('#main-nav').getByRole('button',{name:'内置浏览器',exact:true}).click();
  const pairingState=()=>win.evaluate(()=>window.xiaojingDesktop.externalBrowserState());
  const drawer=win.locator('#desktop-settings-drawer'),browserSettings=drawer.locator('#desktop-settings-nav [data-panel="browser-settings"]');
  const start=drawer.locator('#desktop-open-edge'),status=drawer.locator('#desktop-browser-status'),installPath=drawer.locator('#desktop-browser-path');
  async function externalPanel(){
    if(!await drawer.isVisible()){
      const embeddedToggle=win.locator('#embedded-settings-toggle');
      await (await embeddedToggle.isVisible()?embeddedToggle:win.locator('#desktop-settings-toggle')).click();
    }
    await browserSettings.click();
    if(!await start.isVisible())await drawer.getByText('使用外部 Chrome 或 Edge',{exact:true}).click();
    await start.waitFor();
  }
  async function openEmbedded(){
    if(await drawer.isVisible())await drawer.locator('#desktop-settings-close').click();
    await win.locator('#desktop-open-embedded').click();
  }
  const reloadPairingPanel=async()=>{await win.reload();await browserPanel();await externalPanel();};
  const nativeBrowser=()=>app.evaluate(({BrowserWindow},chat)=>{
    const view=BrowserWindow.getAllWindows()[0].contentView.children.find(child=>child.webContents?.getURL()===chat);
    return view?{id:view.webContents.id,visible:view.getVisible(),bounds:view.getBounds()}:null;
  },chat);
  await browserPanel();
  await openEmbedded();
  await win.getByText('桥接就绪',{exact:true}).waitFor();
  const original=(await browser()).activeTabId;
  const nativeBeforeReload=await nativeBrowser();
  assert.equal(nativeBeforeReload.visible,true);
  assert.ok(nativeBeforeReload.bounds.height>0);
  await win.reload();
  assert.equal(await win.locator('body').getAttribute('data-view'),'overview');
  assert.deepEqual(await nativeBrowser(),{...nativeBeforeReload,visible:false});
  assert.equal((await browser()).ready,true);
  await browserPanel();
  await openEmbedded();
  assert.equal((await browser()).activeTabId,original);
  assert.equal((await nativeBrowser()).visible,true);
  assert.equal((await request('/api/config',{data:{browserCalibrated:true}})).status,200);
  await externalPanel();
  assert.equal((await nativeBrowser()).visible,true);
  await start.click();await status.filter({hasText:'无法打开浏览器的扩展管理页'}).waitFor();
  assert.equal(existsSync(challenge),false);
  assert.equal((await browser()).activeTabId,original);
  assert.equal((await nativeBrowser()).visible,true);
  assert.equal((await request('/api/state')).body.config.browserCalibrated,true);

  await app.evaluate(()=>{pairFixture.failLaunch=false;});
  await start.click();await status.filter({hasText:'正在等待外部扩展配对'}).waitFor({timeout:7000}).catch(async()=>{
    throw Error('Expected pending pairing UI, got '+await status.textContent());
  });
  assert.equal((await browser()).activeTabId,original);
  assert.equal((await browser()).ready,true);
  assert.equal((await nativeBrowser()).visible,true);
  assert.equal((await request('/api/state')).body.config.browserCalibrated,true);
  const pending=await pairingState();
  assert.deepEqual(Object.keys(pending).sort(),['activeExternal','expiresAt','extensionPath','mode','phase','revision']);
  assert.equal(pending.phase,'pending');
  assert.equal(pending.mode,'edge');
  assert.equal(pending.activeExternal,false);
  assert.equal(pending.extensionPath,dirname(challenge));
  assert.ok(pending.expiresAt>Date.now());
  await reloadPairingPanel();
  await status.filter({hasText:'正在等待外部扩展配对'}).waitFor();
  assert.equal(await installPath.textContent(),dirname(challenge));
  assert.deepEqual(await pairingState(),pending);
  const extensionOrigin='chrome-extension://'+'a'.repeat(32);
  const cancelled=JSON.parse(readFileSync(challenge,'utf8')).code;
  await openEmbedded();
  assert.equal((await browser()).activeTabId,original);
  assert.equal((await request('/api/desktop-pair',{data:{code:cancelled},token:null,extensionOrigin})).status,403);
  assert.equal((await request('/api/state')).body.config.browserCalibrated,true);
  await win.locator('#embedded-hide').click();
  await externalPanel();
  await status.filter({hasText:'本次外部配对已取消'}).waitFor();
  assert.equal(await installPath.textContent(),'');
  await reloadPairingPanel();
  await status.filter({hasText:'本次外部配对已取消'}).waitFor();
  await win.evaluate(()=>window.xiaojingDesktop.onExternalBrowserState(snapshot=>{
    document.body.dataset.fixturePairingEvent=String(snapshot.revision);
  }));
  await app.evaluate(({BrowserWindow},snapshot)=>BrowserWindow.getAllWindows()[0].webContents.send('desktop:external-browser-state',snapshot),pending);
  await win.locator(`body[data-fixture-pairing-event="${pending.revision}"]`).waitFor();
  assert.match(await status.textContent(),/本次外部配对已取消/);
  assert.equal(await installPath.textContent(),'');
  await start.click();await status.filter({hasText:'正在等待外部扩展配对'}).waitFor();
  const {code}=JSON.parse(readFileSync(challenge,'utf8'));
  assert.notEqual(code,cancelled);
  const paired=await request('/api/desktop-pair',{data:{code},token:null,extensionOrigin});
  assert.equal(paired.status,200);
  await status.filter({hasText:'外部浏览器已配对'}).waitFor();
  assert.equal(await browser(),null);
  assert.equal((await request('/api/state')).body.accountRecheck.required,true);
  assert.equal((await request('/api/browser-state',{token:session.extensionToken,extensionOrigin})).status,401);
  assert.equal((await request('/api/browser-state',{token:paired.body.extensionToken,extensionOrigin})).status,200);
  assert.equal((await request('/api/worker-health',{data:{phase:'idle'},token:paired.body.extensionToken,extensionOrigin})).status,200);
  await reloadPairingPanel();
  await status.filter({hasText:'外部浏览器已配对'}).waitFor();
  assert.equal((await request('/api/state')).body.desktopSetup.bridge,true);
  assert.deepEqual(Object.keys(await pairingState()).sort(),['activeExternal','phase','revision']);
  assert.equal(await installPath.textContent(),'');

  await start.click();await status.filter({hasText:'正在等待外部扩展配对'}).waitFor();
  const expiring=await pairingState();
  assert.equal(expiring.activeExternal,true);
  const expiredCode=JSON.parse(readFileSync(challenge,'utf8')).code;
  await app.evaluate((_electron,expiresAt)=>{pairFixture.originalNow=Date.now;Date.now=()=>expiresAt+1;},expiring.expiresAt);
  try{
    await reloadPairingPanel();
    await status.filter({hasText:'本次外部配对已过期，原外部浏览器仍保持配对'}).waitFor();
    assert.equal(await installPath.textContent(),'');
    assert.equal((await request('/api/desktop-pair',{data:{code:expiredCode},token:null,extensionOrigin})).status,401);
    assert.equal((await request('/api/browser-state',{token:paired.body.extensionToken,extensionOrigin})).status,200);
  }finally{await app.evaluate(()=>{Date.now=pairFixture.originalNow;delete pairFixture.originalNow;});}
  await openEmbedded();
  await win.locator('#embedded-hide').click();
  await reloadPairingPanel();
  await status.filter({hasText:'选择浏览器开始'}).waitFor();
  assert.equal((await request('/api/browser-state',{token:paired.body.extensionToken,extensionOrigin})).status,401);
  const calls=await app.evaluate(()=>pairFixture);
  assert.deepEqual(calls.launches,Array.from({length:4},()=>['edge://extensions/']));
  assert.equal(calls.clipboard,dirname(challenge));
  console.log(JSON.stringify({reloadHidesNativeViewAndPreservesTab:true,syntheticLaunchFailurePreservesEmbedded:true,pendingPairPreservesEmbedded:true,explicitEmbeddedReopenCancelsPending:true,confirmedPairClosesEmbedded:true,knownAccountRecheck:true,pendingAndPathSurviveReload:true,cancelledSurvivesReload:true,ignoresOlderEvent:true,confirmedPairSurvivesReload:true,expiredReplacementPreservesPairedBrowser:true,actualBrowserProcessesStarted:0,actualBOSSRequests:0}));
}finally{
  if(app)await app.close().catch(()=>{});
  rmSync(home,{recursive:true,force:true});
}
