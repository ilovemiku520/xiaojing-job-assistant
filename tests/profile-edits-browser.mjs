// Real console scripts in an isolated local browser. No real profile or model.
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {once} from 'node:events';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const temp=realpathSync(tmpdir());
const local=realpathSync(mkdtempSync(join(temp,'xiaojing-profile-edits-')));
const port=await testPort();
const app=createApplication({local,port,desktop:true,key:'fixture-only',inference:async()=>{throw Error('fixture must never call a model');}});
app.server.listen(port,'127.0.0.1');
await once(app.server,'listening');
const origin=`http://127.0.0.1:${port}`,token=readFileSync(join(local,'pairing-token'),'utf8').trim();
async function api(path,data){
  const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{})});
  assert.equal(response.status,200);
  return response.json();
}

let browser,releaseLibrary;
try {
  await api('/api/library/persona',{persona:'原人格',rules:'原规则'});
  await api('/api/config',{profile:{name:'虚构测试',facts:'原经历',resumeName:'old.pdf',titles:['游戏策划'],cities:['北京']}});
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(()=>window.xiaojingDesktop={onEmbeddedState(){},onBrowserProgress(){},onVersionMismatch(){},embedded:async()=>({})});
  const a=await context.newPage(),b=await context.newPage();
  const errors=[];
  for(const page of [a,b]){
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/');
    await page.locator('#summary').filter({hasText:'虚构测试'}).waitFor();
  }
  async function panel(page,name){
    if(!(await page.locator('#desktop-settings-drawer').isVisible()))await page.locator('#desktop-settings-toggle').click();
    await page.locator(`#desktop-settings-nav [data-panel="${name}"]`).click();
  }
  const profile=(page,name)=>page.locator(`#profile-form [name="${name}"]`);
  async function save(page,path,button){
    const request=page.waitForRequest(req=>req.url()===origin+path&&req.method()==='POST');
    await page.getByRole('button',{name:button,exact:true}).click();
    return (await request).postDataJSON();
  }

  const holdLibrary=new Promise(resolve=>releaseLibrary=resolve);
  let notifyLibrary;
  const libraryWaiting=new Promise(resolve=>notifyLibrary=resolve);
  await a.route(origin+'/api/library',async route=>{
    const response=await route.fetch();
    notifyLibrary();
    await holdLibrary;
    await route.fulfill({response});
  },{times:1});
  await panel(a,'library');await libraryWaiting;
  assert.equal(await a.locator('#desktop-rules').inputValue(),'');
  await a.locator('#desktop-persona').fill('先修改人格');
  assert.deepEqual(await save(a,'/api/library/persona','保存人格与规则'),{persona:'先修改人格'});
  await a.getByText('人格和沟通规则已保存。',{exact:true}).waitFor();
  assert.equal((await api('/api/library')).rules,'原规则');
  const delayed=a.waitForResponse(response=>response.url()===origin+'/api/library');
  releaseLibrary();await (await delayed).finished();
  await a.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await a.locator('#desktop-persona').inputValue(),'先修改人格');
  assert.equal(await a.locator('#desktop-rules').inputValue(),'原规则');

  await panel(b,'library');await b.waitForFunction(()=>document.querySelector('#desktop-rules').value==='原规则');
  await b.locator('#desktop-rules').fill('窗口 B 更新规则');
  assert.deepEqual(await save(b,'/api/library/persona','保存人格与规则'),{rules:'窗口 B 更新规则'});
  await b.getByText('人格和沟通规则已保存。',{exact:true}).waitFor();
  await a.locator('#desktop-persona').fill('窗口 A 更新人格');
  assert.deepEqual(await save(a,'/api/library/persona','保存人格与规则'),{persona:'窗口 A 更新人格'});
  await a.getByText('人格和沟通规则已保存。',{exact:true}).waitFor();
  assert.equal((await api('/api/library')).rules,'窗口 B 更新规则');

  for(const page of [a,b])await panel(page,'profile');
  await profile(b,'facts').fill('窗口 B 更新经历');
  assert.deepEqual(await save(b,'/api/config','保存资料'),{profile:{facts:'窗口 B 更新经历'}});
  await b.getByText(/求职资料和筛选标准已保存/).waitFor();
  await profile(a,'name').fill('窗口 A 更新姓名');
  assert.deepEqual(await save(a,'/api/config','保存资料'),{profile:{name:'窗口 A 更新姓名'}});
  await a.getByText(/求职资料和筛选标准已保存/).waitFor();
  assert.equal(app.state.config.profile.facts,'窗口 B 更新经历');
  await a.waitForFunction(()=>document.querySelector('#profile-form [name="facts"]').value==='窗口 B 更新经历');

  const oversized='甲'.repeat(16000)+'应当保留的末段';
  await profile(a,'facts').fill(oversized);
  await save(a,'/api/config','保存资料');
  await a.getByText(/经历与能力最多 16,000 字/).waitFor();
  assert.equal(await profile(a,'facts').inputValue(),oversized);
  assert.equal(app.state.config.profile.facts,'窗口 B 更新经历');
  assert.equal(JSON.parse(readFileSync(join(local,'state.json'),'utf8')).config.profile.facts,'窗口 B 更新经历');
  assert.equal(JSON.parse(readFileSync(join(local,'owner-library.json'),'utf8')).rules,'窗口 B 更新规则');
  assert.deepEqual(errors,[]);
  console.log('Profile and persona edit isolation verified with delayed reads and two local windows.');
} finally {
  releaseLibrary?.();
  if(browser)await browser.close();
  const closed=once(app.server,'close');app.shutdown();await closed;
  assert.equal(dirname(local),temp);
  rmSync(local,{recursive:true,force:true});
}
