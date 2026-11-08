// Launches the real Electron app. Its embedded partition is served a local
// synthetic document at the production origin, with all network I/O intercepted.
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {testPort} from './port.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const temporary=realpathSync(tmpdir());
const profile=realpathSync(mkdtempSync(join(temporary,'xiaojing-embedded-test-')));
assert.equal(dirname(profile),temporary);
const packagedExe=process.argv[2];
const executablePath=packagedExe||join(root,'tools','cache','electron','runtime','electron.exe');
const launchArgs=packagedExe?[]:[resolve(root)];
const port=await testPort(),appURL='http://127.0.0.1:'+port,chatURL='https://www.zhipin.com/web/geek/chat';
const jobURL='https://www.zhipin.com/job_detail/embedded-fixture-position.html';
const jobTitle='模拟系统策划实习';
const modelEndpoint='https://models.fixture.invalid/v1/chat/completions';
const text='您好，想替主人问一下，简历目前的筛选进度如何？';
const html=readFileSync(new URL('./fixtures/desktop-embedded-chat.html',import.meta.url),'utf8');
let app;

async function until(check,description,timeout=26000){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const value=await check();
    if(value)return value;
    await new Promise(r=>setTimeout(r,130));
  }
  throw Error(description+' did not settle in '+timeout+' ms');
}

try{
  app=await electron.launch({executablePath,args:launchArgs,env:{...process.env,XIAOJING_DESKTOP_HOME:profile,XIAOJING_DESKTOP_PORT:String(port)},timeout:25000});
  const win=await app.firstWindow({timeout:25000});
  const navigation=win.locator('#main-nav');
  await navigation.getByRole('button',{name:'工作台',exact:true}).waitFor();
  await app.evaluate(({session},{html,chatURL,jobURL,modelEndpoint,text,appURL})=>{
    const browserSession=session.fromPartition('persist:xiaojing-boss');
    globalThis.embeddedTestFixture={pageLoads:0,jobLoads:0,modelCalls:0};
    browserSession.protocol.handle('https',request=>{
      const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'};
      if(request.url===chatURL){
        globalThis.embeddedTestFixture.pageLoads++;
        return new Response(html,{headers});
      }
      if(request.url===jobURL){
        globalThis.embeddedTestFixture.jobLoads++;
        return new Response('<!doctype html><meta charset="utf-8"><title>模拟 BOSS 职位详情</title><main id="fixture-job">合成岗位正文</main>',{headers});
      }
      return new Response('',{status:403});
    });
    browserSession.protocol.handle('http',()=>new Response('',{status:403}));
    const fetch=globalThis.fetch;
    globalThis.fetch=async (input,options)=>{
      const url=new URL(typeof input==='string'?input:input.url||input.href);
      if(url.href===modelEndpoint){
        globalThis.embeddedTestFixture.modelCalls++;
        return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({action:'send_text',text,reason:'合成验证',score:96})}}]});
      }
      if(url.origin===appURL)return fetch(input,options);
      throw Error('Fixture blocked external network');
    };
  },{html,chatURL,jobURL,modelEndpoint,text,appURL});

  const session=await(await fetch(appURL+'/api/session')).json();
  async function request(path,data,token=session.token){
    const response=await fetch(appURL+path,{
      method:data?'POST':'GET',headers:{'X-Boss-Token':token,'Content-Type':'application/json'},
      ...(data?{body:JSON.stringify(data)}:{})
    });
    return {status:response.status,value:await response.json()};
  }
  async function api(path,data){
    const {status,value}=await request(path,data);
    assert(status<300,value.error);
    return value;
  }
  async function pageSnapshot(){
    return app.evaluate(async({webContents},chatURL)=>{
      const view=webContents.getAllWebContents().find(contents=>contents.getURL()===chatURL);
      if(!view)return null;
      return view.executeJavaScript('window.fixture ? {clicks:window.fixture.clicks,switches:window.fixture.switches,peers:window.fixture.peers,privileged:typeof require!=="undefined"||typeof window.xiaojingDesktop!=="undefined"||typeof window.xiaojingBossTransport!=="undefined"||Boolean(window.chrome?.runtime?.id)} : null');
    },chatURL);
  }

  const empty=await api('/api/state');
  assert.equal(empty.config.profile.name,'');
  assert.equal(Object.keys(empty.memories).length,0);
  assert.equal(empty.config.running,false);
  await api('/api/provider-key',{provider:'compatible',baseURL:'https://models.fixture.invalid/v1',key:'fixture-embedded-key'});
  await api('/api/config',{
    learningEnabled:false,limits:{hoursStart:0,hoursEnd:24,intervalSeconds:0},
    profile:{name:'测试用户',facts:'合成测试资料',titles:['游戏策划'],cities:['北京']},
    modelRoutes:{followup:{provider:'compatible',model:'fixture-model'}}
  });
  await navigation.getByRole('button',{name:'内置浏览器',exact:true}).click();
  await win.getByRole('button',{name:'打开内置浏览器',exact:true}).click();
  await win.locator('#embedded-workspace').waitFor();
  const loaded=await until(pageSnapshot,'Fixture embedded browser');
  assert.equal(loaded.privileged,false,'BOSS page main world must not expose Node or the desktop bridge');
  const source=await until(async()=>{
    const state=await api('/api/state');
    const browser=await win.evaluate(()=>window.xiaojingDesktop.embedded('state'));
    return browser?.ready&&state.workerHealth?.at&&state.workerHealth.extensionVersion;
  },'Embedded worker heartbeat');
  assert(source);
  const browserFrame = await win.locator('#embedded-workspace').evaluate(element => {
    const style=getComputedStyle(element);
    return {background:style.backgroundColor,border:style.borderTopColor,radius:style.borderRadius};
  });
  assert.deepEqual(browserFrame,{background:'rgb(23, 23, 23)',border:'rgb(42, 42, 42)',radius:'0px'});
  mkdirSync(join(root,'work','desktop-qa'),{recursive:true});
  await win.screenshot({path:join(root,'work','desktop-qa','browser-frame.png')});
  await api('/api/config',{browserCalibrated:true});
  const extension=await request('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/chat'},session.extensionToken);
  assert(extension.status===401||extension.status===403,'old external extension token must not act on the embedded bridge');

  async function followup(id,suffix=''){
    const input={
      kind:'followup',requestId:'fixture-'+id+suffix,instruction:'询问之前提交的简历目前筛选进度如何',
      targets:[loaded.peers[id]]
    };
    const {plan}=await api('/api/owner-chat',input);
    const finished=await until(async()=>{
      const state=await api('/api/state');
      const current=state.ownerChats.find(item=>item.id===plan.id);
      return current&&current.status!=='queued'?{plan:current,task:state.tasks.find(task=>task.id===current.targets[0].taskId)}:null;
    },'Followup '+id+suffix);
    return {...finished,input};
  }

  const exact=await followup('exact');
  assert.equal(exact.task.status,'sent');
  assert.match(exact.task.evidence,/fixture-new-mid-exact/);
  assert.equal(exact.task.text,text);
  assert.deepEqual((await pageSnapshot()).clicks.map(item=>item.peer),['exact']);
  assert.equal((await pageSnapshot()).clicks[0].text,text);

  const duplicate=await followup('exact','-repeat');
  assert.equal(duplicate.task.status,'skip');
  assert.equal(duplicate.task.duplicateOf,exact.task.id);
  assert.deepEqual((await pageSnapshot()).clicks.map(item=>item.peer),['exact']);

  const moved=await followup('moved');
  assert.equal(moved.task.status,'uncertain');
  assert.equal((await pageSnapshot()).switches,1);
  assert.deepEqual((await pageSnapshot()).clicks.map(item=>item.peer),['exact']);

  const silent=await followup('silent');
  assert.equal(silent.task.status,'uncertain');
  assert.deepEqual((await pageSnapshot()).clicks.map(item=>item.peer),['exact','silent']);
  const blocked=await request('/api/owner-chat',{...silent.input,requestId:'fixture-silent-retry'});
  assert.equal(blocked.status,400);
  assert.match(blocked.value.error,/结果待核对/);

  const altered=await followup('altered');
  assert.equal(altered.task.status,'uncertain','a longer body containing the draft is not an exact receipt');
  assert.deepEqual((await pageSnapshot()).clicks.map(item=>item.peer),['exact','silent','altered']);
  const metrics=await app.evaluate(()=>globalThis.embeddedTestFixture);
  assert(metrics.pageLoads>0);
  assert.equal(metrics.modelCalls,5);
  await win.evaluate(()=>window.xiaojingDesktop.embedded('reload'));
  await until(async()=>await app.evaluate(()=>globalThis.embeddedTestFixture.pageLoads)>metrics.pageLoads,'Synthetic tab reload');
  await until(async()=>{
    const view=await win.evaluate(()=>window.xiaojingDesktop.embedded('state'));
    return view?.ready&&await pageSnapshot();
  },'Reconnected fixture');
  await new Promise(r=>setTimeout(r,2200));
  assert.deepEqual((await pageSnapshot()).clicks,[]);
  assert.equal(await app.evaluate(()=>globalThis.embeddedTestFixture.modelCalls),metrics.modelCalls);
  const final=await api('/api/state');
  assert.equal(final.config.running,false);
  assert.equal(final.tasks.filter(task=>task.status==='sent').length,1);

  const browserState=()=>win.evaluate(()=>window.xiaojingDesktop.embedded('state'));
  const initialChat=(await browserState()).tabs.find(tab=>tab.url===chatURL);
  assert(initialChat?.ready);
  await api('/api/jobs/observe',{jobs:[{title:jobTitle,company:'模拟游戏公司',city:'北京',url:jobURL}]});
  async function openJobFromTable(){
    const hide=win.locator('#embedded-hide');
    if(await hide.isVisible())await hide.click();
    await navigation.getByRole('button',{name:'岗位资料库',exact:true}).click();
    await win.getByRole('button',{name:jobTitle,exact:true}).click();
    const original=win.locator('#jobs-original');
    await original.waitFor({state:'visible'});
    assert.equal(await original.getAttribute('href'),jobURL);
    await original.click();
    return until(async()=>{
      const browser=await browserState();
      return browser?.visible&&browser.ready&&browser.url===jobURL&&browser;
    },'Embedded job from table');
  }
  const firstJob=await openJobFromTable();
  assert.equal(firstJob.tabs.filter(tab=>tab.url===jobURL).length,1);
  assert.equal(firstJob.tabs.find(tab=>tab.url===chatURL)?.id,initialChat.id);
  assert.equal(await win.locator('#jobs-detail').isVisible(),false);
  const embeddedDocument=await app.evaluate(async({session,webContents},{chatURL,jobURL})=>{
    const partition=session.fromPartition('persist:xiaojing-boss');
    const views=webContents.getAllWebContents();
    const chat=views.find(contents=>contents.getURL()===chatURL);
    const job=views.find(contents=>contents.getURL()===jobURL);
    return {sharedPartition:chat?.session===partition&&job?.session===partition,jobText:await job?.executeJavaScript('document.querySelector("#fixture-job")?.textContent')};
  },{chatURL,jobURL});
  assert.deepEqual(embeddedDocument,{sharedPartition:true,jobText:'合成岗位正文'});
  await win.evaluate(id=>window.xiaojingDesktop.embedded('select',id),initialChat.id);
  assert.equal((await browserState()).url,chatURL);
  const secondJob=await openJobFromTable();
  assert.equal(secondJob.activeTabId,firstJob.activeTabId);
  assert.equal(secondJob.tabs.filter(tab=>tab.url===jobURL).length,1);
  assert.equal(secondJob.tabs.find(tab=>tab.url===chatURL)?.id,initialChat.id);
  assert.equal(await app.evaluate(()=>globalThis.embeddedTestFixture.jobLoads),1);
  await win.evaluate(id=>window.xiaojingDesktop.embedded('select',id),initialChat.id);
  async function showFixtureDialog(markup){
    return app.evaluate(async({webContents},{chatURL,markup})=>{
      const view=webContents.getAllWebContents().find(contents=>contents.getURL()===chatURL);
      await view.executeJavaScript(`document.querySelector('#fixture-account-dialog')?.remove();
        document.body.insertAdjacentHTML('beforeend',${JSON.stringify(markup)});`);
    },{chatURL,markup});
  }
  await showFixtureDialog('<div id="fixture-account-dialog" class="captcha-container" role="dialog">请完成安全验证<input placeholder="验证码"><button>确认</button></div>');
  const previousHeartbeat=(await api('/api/state')).heartbeat.at;
  await until(async()=>(await api('/api/state')).heartbeat.at>previousHeartbeat,'Captcha fixture heartbeat');
  assert.equal((await api('/api/state')).accountRecheck.required,false);
  await showFixtureDialog('<div id="fixture-account-dialog" class="login-dialog" role="dialog">手机号登录<input type="tel" placeholder="手机号"><button>登录</button></div>');
  const recheck=await until(async()=>{
    const state=await api('/api/state');
    return state.accountRecheck.required&&state;
  },'Visible sign-in account recheck');
  assert.equal(recheck.accountRecheck.reason,'login_observed');
  assert.equal(recheck.accountRecheck.canConfirm,false);
  assert.equal(recheck.config.browserCalibrated,false);
  assert.equal(recheck.tasks.filter(task=>task.status==='sent').length,1);
  assert.equal((await request('/api/account-recheck',{sameAccount:true})).status,400);
  await showFixtureDialog('');
  await until(async()=>(await api('/api/state')).accountRecheck.canConfirm,'Visible chat account confirmation proof');
  assert.equal((await api('/api/account-recheck',{sameAccount:true})).accountRecheck.required,false);
  assert.equal((await api('/api/state')).config.browserCalibrated,false);
  await api('/api/config',{browserCalibrated:true});
  const intercepted=await app.evaluate(({net})=>{
    const original=net.fetch;
    net.fetch=async()=>new Response('',{status:503});
    return net.fetch!==original;
  });
  assert.equal(intercepted,true,'Managed browser fixture must intercept network before launch');
  await win.locator('#embedded-hide').click();
  await assert.rejects(win.evaluate(()=>window.xiaojingDesktop.openBrowser('managed')),/无法从 Google 获取/);
  assert.equal((await api('/api/state')).config.browserCalibrated,true,'Failed fallback leaves the embedded calibration intact');
  assert.equal((await api('/api/state')).accountRecheck.required,false);
  assert.equal((await browserState()).tabs.find(tab=>tab.url===chatURL)?.id,initialChat.id);
  await win.getByRole('button',{name:'打开内置浏览器',exact:true}).click();
  assert.equal((await browserState()).activeTabId,initialChat.id);
  console.log(JSON.stringify({embeddedFixture:true,wrongRecipientBlocked:true,exactBodyAndMID:true,missingAndAlteredReceiptUncertain:true,retryAndDuplicateBlocked:true,jobOpensInSharedPartition:true,chatTabPreserved:true,jobTabReused:true,captchaDoesNotLatch:true,visibleSignInRequiresAccountRecheck:true,failedFallbackPreservesEmbedded:true,realRecruitersContacted:0}));
}finally{
  if(app)await app.close();
  rmSync(profile,{recursive:true,force:true});
}
