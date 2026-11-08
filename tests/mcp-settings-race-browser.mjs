import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';
const resources=resolve(process.argv[2]||fileURLToPath(new URL('../',import.meta.url)));
process.env.BOSS_KNOWLEDGE_DIR=join(resources,'desktop','starter');
const {createApplication}=await import(pathToFileURL(join(resources,'server','app.mjs')));
const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-mcp-race64-'))),port=await testPort();
assert.equal(dirname(local),temp);
let browser,releasePending,modelCalls=0;
const forbidden=async()=>{modelCalls++;throw Error('fixture must not call a model');};
const app=createApplication({local,workspace:local,desktop:true,port,key:'fixture-only',inference:forbidden,ownerInference:forbidden});
try{
 app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
 const base='http://127.0.0.1:'+port,endpoint=base+'/api/mcp-tools',{token}=await(await fetch(base+'/api/session')).json();
 const api=async data=>{
  const response=await fetch(endpoint,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{})});
  const result=await response.json();assert(response.ok,result.error);return result;
 };
 const name='fixture_only',label='模拟 MCP 工具';
 await api({action:'add',server:{name,label,command:process.execPath,args:['--fixture-must-never-launch']}});
 const actual=async()=> (await api()).servers.find(server=>server.name===name);
 assert.equal((await actual()).enabled,true);
 browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage(),errors=[],foreign=[];
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',request=>{if(new URL(request.url()).origin!==base)foreign.push(request.url());});
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.addInitScript(()=>window.xiaojingDesktop={onEmbeddedState(){},onBrowserProgress(){},onVersionMismatch(){},embedded:async()=>({})});
 await page.goto(base+'/');
 const gear=page.locator('#desktop-settings-toggle'),mcp=page.locator('#desktop-settings-nav [data-panel="mcp"]'),close=page.locator('#desktop-settings-close');
 const row=page.locator('#desktop-tools .desktop-row').filter({hasText:label});
 const pause=row.getByRole('button',{name:'暂停',exact:true}),enable=row.getByRole('button',{name:'启用',exact:true});
 async function holdResponse(matches){
  const entered=Promise.withResolvers(),held=Promise.withResolvers(),delivered=Promise.withResolvers();
  releasePending=held.resolve;
  let taken=false;
  const handler=async route=>{
   if(taken||!matches(route.request())){await route.continue();return;}
   taken=true;
   const response=await route.fetch();
   entered.resolve(await response.json());await held.promise;await route.fulfill({response});delivered.resolve();
  };
  await page.route(endpoint,handler);
  return {snapshot:entered.promise,finish:async()=>{
   held.resolve();await delivered.promise;await page.unroute(endpoint,handler);
   await page.evaluate(()=>new Promise(requestAnimationFrame));
  }};
 }
 await gear.click();
 const reopening=await holdResponse(request=>request.method()==='GET');
 await mcp.click();
 assert.equal((await reopening.snapshot).servers.find(server=>server.name===name).enabled,true);
 await close.click();
 await api({action:'toggle',name,enabled:false});
 await gear.click();await enable.waitFor();
 assert.equal((await actual()).enabled,false);
 await reopening.finish();
 assert.equal(await enable.count(),1,'a closed drawer read must not restore the old enabled state');
 assert.equal(await pause.count(),0);
 assert.equal((await actual()).enabled,false);

 await close.click();
 await api({action:'toggle',name,enabled:true});
 const mutation=await holdResponse(request=>request.method()==='GET');
 await gear.click();
 assert.equal((await mutation.snapshot).servers.find(server=>server.name===name).enabled,true);
 await row.getByRole('button',{name:'移除',exact:true}).click();
 await row.waitFor({state:'detached'});
 assert.equal(await actual(),undefined);
 await mutation.finish();
 assert.equal(await row.count(),0,'a pre-remove read must not recreate the removed row');
 assert.equal(await actual(),undefined);

 const first={name:'fixture_first',label:'模拟工具一',command:process.execPath,args:[]},second={name:'fixture_second',label:'模拟工具二',command:process.execPath,args:[]};
 await api({action:'add',server:first});await api({action:'add',server:second});
 await close.click();await gear.click();
 const toolRow=tool=>page.locator('#desktop-tools .desktop-row').filter({hasText:tool.label});
 const toolButton=(tool,caption)=>toolRow(tool).getByRole('button',{name:caption,exact:true});
 await toolButton(first,'暂停').waitFor();await toolButton(second,'暂停').waitFor();
 const actionRequests=[];
 page.on('request',request=>{if(request.url()===endpoint&&request.method()==='POST')actionRequests.push(request.postDataJSON());});
 const heldWrite=await holdResponse(request=>request.method()==='POST'&&request.postDataJSON().name===first.name);
 await toolButton(first,'暂停').click();await heldWrite.snapshot;
 await toolButton(second,'暂停').click();
 await page.evaluate(()=>new Promise(requestAnimationFrame));
 assert.deepEqual(actionRequests.map(request=>request.name),[first.name]);
 await heldWrite.finish();await toolButton(second,'启用').waitFor();
 assert.deepEqual(actionRequests.map(request=>request.name),[first.name,second.name]);
 assert.equal(await toolButton(first,'启用').count(),1);

 const saved={name:'fixture_saved',label:'模拟提交工具',command:process.execPath,args:[]},draft={name:'fixture_draft',label:'编辑中的工具',command:process.execPath,args:[]};
 const field=page.locator('#desktop-mcp-json');
 const heldAdd=await holdResponse(request=>request.method()==='POST'&&request.postDataJSON().action==='add');
 await field.fill(JSON.stringify(saved));
 await page.getByRole('button',{name:'添加 MCP 工具',exact:true}).click();await heldAdd.snapshot;
 await field.fill(JSON.stringify(draft));await heldAdd.finish();
 await page.getByText('MCP 工具配置已保存。',{exact:true}).waitFor();
 assert.equal(await field.inputValue(),JSON.stringify(draft));
 const after=await api();assert.equal(after.servers.some(server=>server.name===saved.name),true);assert.equal(after.servers.some(server=>server.name===draft.name),false);
 assert.deepEqual(errors,[]);assert.deepEqual(foreign,[]);assert.equal(modelCalls,0);
 console.log(JSON.stringify({staleReopenDiscarded:true,staleRemovalDiscarded:true,parallelWritesSerialized:true,unsavedJsonPreserved:true,toolLaunches:0,realModelCalls:0,foreignRequests:0}));
}finally{
 releasePending?.();if(browser)await browser.close();await app.shutdown();
 assert.equal(dirname(realpathSync(local)),temp);rmSync(local,{recursive:true,force:true});
}
