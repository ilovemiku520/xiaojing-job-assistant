// Two isolated console windows with real saves and no model or BOSS traffic.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-settings-edits-')));
const port=await testPort(),origin=`http://127.0.0.1:${port}`;
const forbidden=async()=>{throw Error('The settings fixture must not call a model');};
const app=createApplication({local,port,desktop:true,key:'fixture-only',inference:forbidden,ownerInference:forbidden});
app.server.listen(port,'127.0.0.1');
await once(app.server,'listening');
const token=readFileSync(join(local,'pairing-token'),'utf8').trim();

async function api(path,data){
  const response=await fetch(origin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':token},body:JSON.stringify(data)});
  assert.equal(response.status,200);
  return response.json();
}

let browser,releaseReads,releaseSave;
try{
  await api('/api/config',{browserCalibrated:true,limits:{hoursEnd:21,intervalSeconds:60}});
  browser=await chromium.launch({headless:true,channel:'msedge'});
  const context=await browser.newContext();
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  await context.addInitScript(()=>window.xiaojingDesktop={onEmbeddedState(){},onBrowserProgress(){},onVersionMismatch(){},embedded:async()=>({})});
  const a=await context.newPage(),b=await context.newPage(),errors=[];
  const field=(page,name)=>page.locator(`#settings-form [name="${name}"]`);
  const save=page=>page.locator('#settings-form button');
  const isSave=request=>request.url()===origin+'/api/config'&&request.method()==='POST';
  const snapshot=()=>{
    const {chatInput,browserCalibrated,limits}=app.state.config;
    return {chatInput,browserCalibrated,hoursEnd:limits.hoursEnd,intervalSeconds:limits.intervalSeconds};
  };
  for(const page of [a,b]){
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin+'/');
    await page.waitForFunction(()=>document.querySelector('#settings-form [name="intervalSeconds"]').value==='60');
    await page.locator('#desktop-settings-toggle').click();
    await page.locator('#desktop-settings-nav [data-panel="settings"]').click();
  }

  const holdReads=new Promise(resolve=>{releaseReads=resolve;});
  await a.route(url=>url.origin===origin&&url.pathname==='/api/state',async route=>{
    await holdReads;
    await route.continue();
  });
  await field(a,'intervalSeconds').fill('0');
  await field(b,'chatInput').uncheck();
  await field(b,'browserCalibrated').uncheck();
  const bRequest=b.waitForRequest(isSave);
  await save(b).click();
  assert.deepEqual((await bRequest).postDataJSON(),{chatInput:false,browserCalibrated:false});
  await b.getByText('运行设置已保存。',{exact:true}).waitFor();
  await api('/api/limits',{hoursEnd:23});
  assert.deepEqual(snapshot(),{chatInput:false,browserCalibrated:false,hoursEnd:23,intervalSeconds:60});
  assert.equal(await field(a,'hoursEnd').inputValue(),'21');
  assert.equal(await field(a,'chatInput').isChecked(),true);

  const holdSave=new Promise(resolve=>{releaseSave=resolve;});
  let markSaved;
  const saved=new Promise(resolve=>{markSaved=resolve;});
  await a.route(origin+'/api/config',async route=>{
    const response=await route.fetch();
    markSaved({status:response.status(),patch:route.request().postDataJSON()});
    await holdSave;
    await route.fulfill({response});
  },{times:1});
  await save(a).click();
  assert.deepEqual(await saved,{status:200,patch:{limits:{intervalSeconds:0}}});
  assert.deepEqual(snapshot(),{chatInput:false,browserCalibrated:false,hoursEnd:23,intervalSeconds:0});
  assert.equal(await save(a).isDisabled(),true);

  // Restore the previously displayed value while the changed save is in flight.
  await field(a,'intervalSeconds').fill('60');
  releaseReads();releaseSave();
  await a.getByText('已保存提交时的运行设置，之后的修改仍在编辑框。',{exact:true}).waitFor();
  await a.waitForFunction(()=>{
    const fields=document.querySelector('#settings-form').elements;
    return fields.hoursEnd.value==='23'&&!fields.chatInput.checked&&!fields.browserCalibrated.checked;
  });
  assert.equal(await field(a,'intervalSeconds').inputValue(),'60');

  const aRequest=a.waitForRequest(isSave);
  await save(a).click();
  assert.deepEqual((await aRequest).postDataJSON(),{limits:{intervalSeconds:60}});
  await a.getByText('运行设置已保存。',{exact:true}).waitFor();
  assert.deepEqual(snapshot(),{chatInput:false,browserCalibrated:false,hoursEnd:23,intervalSeconds:60});
  assert.deepEqual(errors,[]);
  console.log('Run settings preserve other windows, owner limits, and edits made during a save.');
}finally{
  releaseReads?.();releaseSave?.();
  if(browser)await browser.close();
  const closed=once(app.server,'close');app.shutdown();await closed;
  assert.equal(dirname(local),temp);
  rmSync(local,{recursive:true,force:true});
}
