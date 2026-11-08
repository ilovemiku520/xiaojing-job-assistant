// The desktop settings view is exercised against a synthetic model endpoint.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const {chromium}=createRequire(import.meta.url)(process.env.BOSS_PLAYWRIGHT||'../tools/node/node_modules/playwright');
const port=await testPort(),calls=[];
let heldTest;
const app=createApplication({port,local:mkdtempSync(join(tmpdir(),'xiaojing-providers-browser-')),key:'',providerFetcher:async(url,request)=>{
  const payload=JSON.parse(request.body);
  calls.push({url,model:payload.model,authorization:request.headers.Authorization});
  const held=heldTest;heldTest=undefined;
  if(held){
    held.entered.resolve();await held.gate.promise;
    if(held.fail)return new Response('{}',{status:401});
  }
  return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})};
}});
// Existing API clients can set an effort on an external provider even though its UI field is disabled.
app.state.config.modelRoutes={...app.state.config.modelRoutes,greeting:{provider:'openai',model:'fixture-existing-route',reasoningEffort:'max'}};
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,channel:'msedge'});
let releaseSave,releaseTest;
try{
  const base='http://127.0.0.1:'+port,errors=[];
  async function settingsPage(){
    const page=await browser.newPage({viewport:{width:1440,height:900}});
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
    await page.goto(base);
    await page.locator('[data-panel="providers"]').click();
    await page.locator('#providers').getByRole('heading',{name:'任务模型',exact:true}).waitFor();
    return page;
  }
  const page=await settingsPage(),other=await settingsPage();
  const settings=page.locator('#providers');
  assert.equal(await settings.locator('[data-model-stage]').count(),6);
  const credentials=settings.locator('.provider-credential-form');
  const vendor=credentials.getByLabel('提供商',{exact:true}),secret=credentials.getByLabel('API 密钥',{exact:true});
  assert.equal(await credentials.getByLabel('兼容 API 基础地址').isVisible(),false);
  await vendor.selectOption('openai');
  await secret.fill('fixture-openai-browser-secret');
  await credentials.getByRole('button',{name:'保存密钥',exact:true}).click();
  await credentials.getByText('密钥已保存',{exact:true}).waitFor();
  assert.equal(await secret.inputValue(),'');

  const reply=settings.locator('[data-model-stage="reply"]');
  const replyTest=reply.getByRole('button',{name:'测试HR 回复'}),feedback=reply.locator('.provider-inline-feedback');
  await reply.getByRole('combobox',{name:'HR 回复提供商'}).selectOption('openai');
  await reply.getByRole('textbox',{name:'HR 回复模型 ID'}).fill('fixture-hr-model');
  assert(await reply.getByRole('button',{name:'测试HR 回复'}).isDisabled());
  await settings.getByRole('button',{name:'保存模型设置',exact:true}).click();
  await settings.getByText('模型设置已保存',{exact:true}).waitFor();
  assert.equal(app.state.config.modelRoutes.reply.model,'fixture-hr-model');
  await reply.getByRole('button',{name:'测试HR 回复'}).click();
  await reply.getByText('fixture-hr-model 连接成功',{exact:true}).waitFor();
  assert.equal(calls.length,1);
  assert.equal(calls[0].model,'fixture-hr-model');
  assert.equal(calls[0].authorization,'Bearer fixture-openai-browser-secret');

  function holdModelTest(fail=false){
    const entered=Promise.withResolvers(),gate=Promise.withResolvers();
    heldTest={entered,gate,fail};releaseTest=gate.resolve;
    return {entered:entered.promise,async release(){
      const response=page.waitForResponse(item=>item.url()===base+'/api/test');
      gate.resolve();await (await response).finished();
      await page.waitForFunction(()=>!document.querySelector('[data-model-stage="reply"] button').disabled);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    }};
  }
  async function saveFixtureKey(form,provider,key){
    await form.getByLabel('提供商',{exact:true}).selectOption(provider);
    await form.getByLabel('API 密钥',{exact:true}).fill(key);
    await form.getByRole('button',{name:'保存密钥',exact:true}).click();
    await form.getByText('密钥已保存',{exact:true}).waitFor();
  }
  const sameWindow=holdModelTest();
  await replyTest.click();await sameWindow.entered;
  await saveFixtureKey(credentials,'openai','fixture-openai-browser-replacement');
  assert.equal(await feedback.textContent(),'');
  await sameWindow.release();
  assert.equal(await feedback.textContent(),'');
  assert.equal(calls.at(-1).authorization,'Bearer fixture-openai-browser-secret');
  await replyTest.click();await reply.getByText('fixture-hr-model 连接成功',{exact:true}).waitFor();
  assert.equal(calls.at(-1).authorization,'Bearer fixture-openai-browser-replacement');

  const otherWindow=holdModelTest(true);
  await replyTest.click();await otherWindow.entered;
  await saveFixtureKey(other.locator('.provider-credential-form'),'openai','fixture-openai-browser-other-window');
  await otherWindow.release();
  assert.equal(await feedback.textContent(),'');
  assert.equal(calls.at(-1).authorization,'Bearer fixture-openai-browser-replacement');

  await other.getByLabel('对话提供商',{exact:true}).selectOption('gemini');
  await other.getByLabel('对话模型 ID',{exact:true}).fill('fixture-owner-model');
  const otherWrite=other.waitForRequest(request=>request.method()==='POST'&&request.url()===base+'/api/config');
  await other.getByRole('button',{name:'保存模型设置',exact:true}).click();
  await other.getByText('模型设置已保存',{exact:true}).waitFor();
  assert.deepEqual((await otherWrite).postDataJSON(),{modelRoutes:{owner:{provider:'gemini',model:'fixture-owner-model'}}});
  assert.equal(app.state.config.modelRoutes.reply.model,'fixture-hr-model');

  const oldModel=holdModelTest();
  await replyTest.click();await oldModel.entered;

  let notifySave;
  const hold=new Promise(resolve=>releaseSave=resolve),committed=new Promise(resolve=>notifySave=resolve);
  await page.route(base+'/api/config',async route=>{
    const response=await route.fetch();
    assert.equal(response.status(),200);
    notifySave(route.request().postDataJSON());
    await hold;
    await route.fulfill({response});
  },{times:1});
  const replyModel=reply.getByRole('textbox',{name:'HR 回复模型 ID'});
  await replyModel.fill('fixture-reply-submitted');
  assert.equal(await feedback.textContent(),'');
  await settings.getByRole('button',{name:'保存模型设置',exact:true}).click();
  assert.deepEqual(await committed,{modelRoutes:{reply:{provider:'openai',model:'fixture-reply-submitted'}}});
  await replyModel.fill('fixture-reply-still-editing');
  await page.getByLabel('学习整理提供商',{exact:true}).selectOption('anthropic');
  await page.getByLabel('学习整理模型 ID',{exact:true}).fill('fixture-learning-still-editing');
  releaseSave();
  await settings.getByText('本次提交已保存，之后的修改仍待保存',{exact:true}).waitFor();
  assert.equal(await replyModel.inputValue(),'fixture-reply-still-editing');
  assert.equal(await page.getByLabel('学习整理模型 ID',{exact:true}).inputValue(),'fixture-learning-still-editing');
  assert.equal(await page.getByLabel('对话模型 ID',{exact:true}).inputValue(),'fixture-owner-model');
  assert.equal(app.state.config.modelRoutes.reply.model,'fixture-reply-submitted');
  assert.equal(app.state.config.modelRoutes.learning,undefined);
  assert(await reply.getByRole('button',{name:'测试HR 回复'}).isDisabled());
  await settings.getByRole('button',{name:'保存模型设置',exact:true}).click();
  await settings.getByText('模型设置已保存',{exact:true}).waitFor();
  assert.equal(app.state.config.modelRoutes.reply.model,'fixture-reply-still-editing');
  assert.equal(app.state.config.modelRoutes.learning.model,'fixture-learning-still-editing');
  await oldModel.release();
  assert.equal(await feedback.textContent(),'');

  await vendor.selectOption('compatible');
  const address=credentials.getByLabel('兼容 API 基础地址');
  await address.fill('https://compatible.example.test/v1');
  await secret.fill('fixture-compatible-browser-secret');
  await credentials.getByRole('button',{name:'保存密钥',exact:true}).click();
  await credentials.getByText('密钥已保存',{exact:true}).waitFor();
  assert.equal(app.state.config.compatibleBaseURL,'https://compatible.example.test/v1');
  assert.equal(await secret.inputValue(),'');

  if(process.env.BOSS_PROVIDER_SCREENSHOTS==='1'){
    const output=join(process.cwd(),'work','providers-ui');
    mkdirSync(output,{recursive:true});
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:900});
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.screenshot({path:join(output,`models-${width}.png`),fullPage:true});
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal page overflow');
    }
  }
  await reply.getByRole('combobox',{name:'HR 回复提供商'}).selectOption('');
  const reset=page.waitForRequest(request=>request.method()==='POST'&&request.url()===base+'/api/config');
  await settings.getByRole('button',{name:'保存模型设置',exact:true}).click();
  await settings.getByText('模型设置已保存',{exact:true}).waitFor();
  assert.deepEqual((await reset).postDataJSON(),{modelRoutes:{reply:null}});
  assert.equal(app.state.config.modelRoutes.reply,undefined);
  assert.match(await reply.locator('.provider-route-current').textContent(),/^跟随默认/);
  assert.equal(app.state.config.modelRoutes.owner.model,'fixture-owner-model');
  assert.equal(app.state.config.modelRoutes.learning.model,'fixture-learning-still-editing');
  assert.deepEqual(app.state.config.modelRoutes.greeting,{provider:'openai',model:'fixture-existing-route',reasoningEffort:'max'});

  await saveFixtureKey(credentials,'deepseek','sk-fixture_shared_model_key_01');
  const followup=settings.locator('[data-model-stage="followup"]'),autonomy=settings.locator('[data-model-stage="autonomy"]');
  await followup.getByLabel('主动跟进提供商').selectOption('deepseek');
  await followup.getByLabel('主动跟进模型 ID').fill('fixture-deepseek-model');
  await settings.getByRole('button',{name:'保存模型设置',exact:true}).click();
  await settings.getByText('模型设置已保存',{exact:true}).waitFor();
  const sharedTestRoute=async route=>{
    const {stage,testRevision}=route.request().postDataJSON();
    assert(['autonomy','followup'].includes(stage));
    await route.fulfill({json:{testRevision,model:stage==='autonomy'?'fixture-harness-model':'fixture-deepseek-model'}});
  };
  await page.route(base+'/api/test',sharedTestRoute);
  await autonomy.getByRole('button',{name:'测试自主规划'}).click();
  await autonomy.getByText('fixture-harness-model 连接成功',{exact:true}).waitFor();
  await followup.getByRole('button',{name:'测试主动跟进'}).click();
  await followup.getByText('fixture-deepseek-model 连接成功',{exact:true}).waitFor();
  await saveFixtureKey(credentials,'deepseek','sk-fixture_shared_model_key_02');
  assert.equal(await autonomy.locator('.provider-inline-feedback').textContent(),'');
  assert.equal(await followup.locator('.provider-inline-feedback').textContent(),'');
  await page.unroute(base+'/api/test',sharedTestRoute);
  assert.equal(app.state.tasks.length,0);
  assert.deepEqual(errors,[]);
  console.log('模型设置浏览器测试通过。模型切换、跨窗口密钥替换与共用密钥使旧反馈失效，延迟保存的编辑和恢复默认已核对。');
}finally{
  releaseSave?.();
  releaseTest?.();
  await browser.close();
  await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});
}
