// Mocked owner inference, local UI only. No real recruiter messages or paid calls.
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
const desktop=process.env.XIAOJING_OWNER_DESKTOP==='1';
let firstRelease,firstSignal;const calls=[];
const app=createApplication({port:await testPort(),local:mkdtempSync(join(tmpdir(),'whale-owner-dialog-ui-')),desktop,key:'fixture',ownerInference:async(payload,signal,meta)=>{
 calls.push({conversationId:payload.conversationId,prompt:payload.owner_instruction,sessionId:meta.sessionId});
 if(payload.owner_instruction==='先分析系统策划方向'){firstSignal=signal;meta.onProgress({type:'session',stage:'thinking',sessionId:'session-ui-first',lastActivityAt:Date.now()});return await new Promise(r=>firstRelease=r);}
 if(payload.owner_instruction==='核对数值策划岗位要求'){meta.onProgress({type:'session',stage:'thinking',sessionId:'session-ui-timeout',lastActivityAt:Date.now()});const e=Error('本轮等待较长，已保存上下文');e.code='HARNESS_TIMEOUT';e.sessionId='session-ui-timeout';throw e;}
 if(payload.owner_instruction==='整理旧会话摘要')return await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Error('停止本轮')),{once:true}));
 return {text:payload.owner_instruction.includes('继续')?'已核对已有记录，可以继续处理尚未完成的部分。没有重复发送。':'已保留北京实习条件。后续筛选按这个要求继续。',sessionId:meta.sessionId};
}});
if(desktop)app.state.config.modelRoutes.owner={provider:'harness',model:app.state.config.model};
await new Promise(r=>app.server.listen(app.port,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.port}`,browser=await chromium.launch({headless:true,channel:'msedge'});
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 if(desktop)await page.addInitScript(()=>{window.xiaojingDesktop={onEmbeddedState(){},onBrowserProgress(){}};});
 await page.goto(base+'/#owner');await page.locator('#owner-submit').waitFor();
 await page.locator('#owner-prompt').fill('先分析系统策划方向');await page.locator('#owner-submit').click();await page.locator('#owner-thread-status').filter({hasText:'正在处理'}).waitFor();assert.equal(await page.locator('#owner-submit').isDisabled(),false);
 await page.locator('#owner-prompt').fill('补充：只看北京的实习岗位');await page.locator('#owner-submit').click();await page.locator('#owner-tasks').getByText('已收到这条补充，当前轮结束后依次处理。').waitFor();assert.equal(calls.length,1);assert.equal(firstSignal.aborted,false);
 firstRelease({text:'已经分析系统策划方向。可以继续补充岗位条件。',sessionId:'session-ui-first'});
 await page.locator('#owner-tasks').getByText('已保留北京实习条件。后续筛选按这个要求继续。').waitFor();assert.equal(calls.length,2);assert.equal(calls[0].conversationId,calls[1].conversationId);assert.equal(calls[1].sessionId,'session-ui-first');assert.equal(await page.locator('.owner-user').count(),2);
 const firstConversation=app.state.ownerTasks.find(t=>t.prompt==='先分析系统策划方向').conversationId;
 const firstThread=page.locator('.owner-thread').filter({hasText:'先分析系统策划方向'});
 await firstThread.focus();await page.evaluate(()=>refresh());
 assert.equal(await firstThread.evaluate(node=>node===document.activeElement),true,'定时刷新应保留任务导航焦点');
 if(desktop){
  const cached=await page.evaluate(()=>({unchanged:state.ownerTasksUnchanged,count:state.ownerTasks.length}));
  assert.deepEqual(cached,{unchanged:true,count:2},'状态刷新省略未变化正文时，当前对话仍保持完整');
 }
 await page.locator('#owner-new').click();await page.locator('#owner-prompt').fill('核对数值策划岗位要求');await page.locator('#owner-submit').click();await page.getByRole('button',{name:'从已有进度继续',exact:true}).waitFor();
 const timed=app.state.ownerTasks[0];assert.equal(timed.status,'timed_out');assert.notEqual(timed.conversationId,firstConversation);
 // Capture the honest timeout-and-resume state for the design inspector.
 const directory='.taste-skill/owner-after';mkdirSync(directory,{recursive:true});
 const html=await page.evaluate(()=>{const root=document.documentElement.cloneNode(true);root.querySelectorAll('script').forEach(e=>e.remove());root.querySelectorAll('input').forEach(e=>e.removeAttribute('value'));root.querySelectorAll('select').forEach((select,i)=>{const value=document.querySelectorAll('select')[i].value;[...select.options].forEach(option=>option.toggleAttribute('selected',option.value===value));});root.querySelector('link[rel="stylesheet"]').setAttribute('href','style.css');return '<!doctype html>'+root.outerHTML;});writeFileSync(directory+'/index.html',html);writeFileSync(directory+'/style.css',readFileSync('public/style.css'));
 const shortResult=timed.result;
 timed.result=Array.from({length:85},(_,index)=>`模拟历史第 ${index+1} 行。`).join('\n\n');
 await page.evaluate(()=>refresh());
 const transcript=page.locator('#owner-tasks');
 await transcript.getByText('模拟历史第 85 行。',{exact:true}).waitFor();
 await page.locator('#owner-conversations .owner-thread').last().focus();
 await page.keyboard.press('Tab');
 assert.equal(await page.evaluate(()=>document.activeElement.id),'owner-tasks','Tab 应聚焦长对话滚动区');
 await transcript.evaluate(node=>{node.scrollTop=0;});
 await page.keyboard.press('PageDown');
 await page.waitForFunction(()=>document.getElementById('owner-tasks').scrollTop>0);
 timed.result=shortResult;
 await page.evaluate(()=>refresh());
 assert.equal(await page.evaluate(()=>document.activeElement.id),'owner-tasks');
 const resume=page.getByRole('button',{name:'从已有进度继续',exact:true}),resumeDraft='未发送的补充：先核对模拟岗位  ';
 const retries={editor:[],continuation:[]};
 const trackRetry=async route=>{
  const payload=route.request().postDataJSON();
  const attempts=payload.prompt===resumeDraft.trim()?retries.editor:payload.prompt.startsWith('请从这个任务的已有进度继续')?retries.continuation:null;
  if(!attempts)return route.continue();
  attempts.push(payload);
  if(attempts.length===1)return route.abort();
  return route.continue();
 };
 await page.route('**/api/owner-task',trackRetry);
 async function failSubmit(button){
  const failed=page.waitForEvent('requestfailed',{predicate:request=>request.url()===base+'/api/owner-task'});
  await button.click();await failed;
  await page.waitForFunction(()=>!document.querySelector('#owner-submit').disabled);
 }
 await page.locator('#owner-prompt').fill(resumeDraft);
 await failSubmit(page.locator('#owner-submit'));
 await failSubmit(resume);
 assert.equal(await page.locator('#owner-prompt').inputValue(),resumeDraft,'continuation failure keeps unsent composer text');
 await resume.click();
 await page.locator('#owner-tasks').getByText('已核对已有记录，可以继续处理尚未完成的部分。没有重复发送。').waitFor();
 assert.equal(calls.at(-1).sessionId,'session-ui-timeout');assert.equal(calls.at(-1).conversationId,timed.conversationId);
 assert.equal(await page.locator('#owner-prompt').inputValue(),resumeDraft,'continuation success does not consume the composer draft');
 assert.equal(retries.continuation[0].requestId,retries.continuation[1].requestId);
 assert.notEqual(retries.editor[0].requestId,retries.continuation[0].requestId);
 assert.deepEqual(retries.continuation.map(item=>item.conversationId),[timed.conversationId,timed.conversationId]);
 await page.locator('#owner-submit').click();
 await page.locator('#owner-tasks').getByText(resumeDraft.trim(),{exact:true}).waitFor();
 assert.equal(retries.editor[0].requestId,retries.editor[1].requestId,'continuation preserves editor retry identity');
 assert.equal(calls.filter(call=>call.prompt===resumeDraft.trim()).length,1);
 await page.unroute('**/api/owner-task',trackRetry);
 await page.locator('.owner-thread').filter({hasText:'先分析系统策划方向'}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.owner-user').length===2);
 await page.reload();await page.locator('#owner-tasks').getByText('已保留北京实习条件。后续筛选按这个要求继续。').waitFor();assert.equal(await page.locator('.owner-user').count(),2);
 await page.locator('#owner-new').click();await page.locator('#owner-prompt').fill('整理旧会话摘要');await page.locator('#owner-submit').click();await page.locator('#owner-thread-status').filter({hasText:'正在处理'}).waitFor();await page.locator('#owner-prompt').fill('补充：先核对附件记录');await page.locator('#owner-submit').click();await page.locator('#owner-tasks').getByText('已收到这条补充，当前轮结束后依次处理。').waitFor();await page.locator('#owner-stop-task').click();
 await page.locator('#owner-tasks').getByText('已停止此任务中尚未执行的补充').waitFor();assert(!calls.some(c=>c.prompt==='补充：先核对附件记录'));assert.equal(app.state.tasks.length,0);
 await page.goto(base+'/?conversation='+encodeURIComponent(firstConversation)+'#owner');await page.locator('#owner-thread-title').filter({hasText:'先分析系统策划方向'}).waitFor();assert.equal(await page.locator('.owner-user').count(),2);
 const input=page.locator('#owner-prompt'),submit=page.locator('#owner-submit');
 async function delayedAck(raw,whilePending){
  let release,started;
  const held=new Promise(resolve=>release=resolve),accepted=new Promise(resolve=>started=resolve);
  const handler=async route=>{
   const payload=route.request().postDataJSON();
   if(payload.prompt!==raw.trim())return route.continue();
   const response=await route.fetch();started({payload,body:await response.json()});
   await held;await route.fulfill({response});
  };
  await page.route('**/api/owner-task',handler);
  try{
   await input.fill(raw);await submit.click();
   const ack=await accepted;assert(ack.body.task?.id,ack.body.error);
   await whilePending(ack);release();
   await page.waitForFunction(()=>!document.querySelector('#owner-submit').disabled);
   return ack.body.task.conversationId;
  }finally{release();await page.unroute('**/api/owner-task',handler);}
 }
 const typed='正在写的补充内容  ';
 await delayedAck('  测试延迟回执并继续输入  ',async ack=>{
  assert.equal(ack.payload.conversationId,firstConversation);
  assert.equal(ack.payload.prompt,'测试延迟回执并继续输入');
  await input.fill(typed);await page.evaluate(()=>refresh());
  assert.equal(await input.inputValue(),typed);
 });
 assert.equal(await input.inputValue(),typed,'已提交原文的回执不清除后来键入的补充');
 assert.equal(new URL(page.url()).searchParams.get('conversation'),firstConversation);

 const otherDraft='另一项已有任务的独立草稿',migrated='新任务发送后的补充';
 await page.locator('#owner-new').click();
 const created=await delayedAck('测试迟到的新任务回执',async ack=>{
  assert.equal(ack.payload.conversationId,undefined);
  await input.fill(migrated);
  await page.locator(`.owner-thread[data-thread-id="${timed.conversationId}"]`).click();
  await input.fill(otherDraft);await page.evaluate(()=>refresh());
 });
 assert.equal(new URL(page.url()).searchParams.get('conversation'),timed.conversationId);
 assert.equal(await input.inputValue(),otherDraft,'原任务的回执不覆盖后来选中的会话草稿');
 await page.locator(`.owner-thread[data-thread-id="${created}"]`).click();
 assert.equal(await input.inputValue(),migrated,'提交期间输入的补充跟随原新任务');

 const former='先发的新任务补充',later='后来新建的任务草稿';
 await page.locator('#owner-new').click();
 const earlier=await delayedAck('测试并行新草稿隔离',async()=>{
  await input.fill(former);await page.locator('#owner-new').click();
  assert.equal(await input.inputValue(),'');
  await input.fill(later);await page.evaluate(()=>refresh());
 });
 assert.equal(await page.locator('#owner-thread-title').textContent(),'新任务');
 assert.equal(await input.inputValue(),later);
 await page.locator(`.owner-thread[data-thread-id="${earlier}"]`).click();
 assert.equal(await input.inputValue(),former);
 await page.locator('#owner-new').click();assert.equal(await input.inputValue(),later);

 const retryDraft='回执丢失的模拟补充',independentDraft='另一个会话的模拟补充',retryRequests=[];
 let originalTurn;
 const dropAcknowledgment=async route=>{
  const payload=route.request().postDataJSON();
  if(payload.prompt!==retryDraft)return route.continue();
  retryRequests.push(payload);
  if(retryRequests.length!==1)return route.continue();
  const response=await route.fetch();assert.equal(response.status(),200);
  originalTurn=(await response.json()).task;
  await route.abort();
 };
 const chooseThread=id=>page.locator(`.owner-thread[data-thread-id="${id}"]`).click();
 const submitAndRead=async()=>{
  const response=page.waitForResponse(result=>result.url()===base+'/api/owner-task'&&result.request().method()==='POST');
  await submit.click();
  const ack=await response;assert.equal(ack.status(),200);
  const {task}=await ack.json();
  await page.waitForFunction(()=>!document.querySelector('#owner-submit').disabled);
  return task;
 };
 await page.route('**/api/owner-task',dropAcknowledgment);
 try{
  await chooseThread(firstConversation);
  await input.fill(retryDraft);await failSubmit(submit);
  assert.equal(originalTurn.conversationId,firstConversation);
  assert.equal(await input.inputValue(),retryDraft);
  assert.equal(calls.filter(call=>call.prompt===retryDraft).length,1);
  await chooseThread(timed.conversationId);
  await input.fill(independentDraft);
  assert.equal((await submitAndRead()).conversationId,timed.conversationId);
  await chooseThread(firstConversation);
  assert.equal(await input.inputValue(),retryDraft);
  assert.equal((await submitAndRead()).id,originalTurn.id);
  assert.equal(retryRequests[1].requestId,retryRequests[0].requestId);
  assert.equal(calls.filter(call=>call.prompt===retryDraft).length,1);
  assert.equal(await input.inputValue(),'');
  await input.fill(retryDraft);
  assert.notEqual((await submitAndRead()).id,originalTurn.id);
  assert.notEqual(retryRequests[2].requestId,retryRequests[0].requestId);
  assert.equal(calls.filter(call=>call.prompt===retryDraft).length,2);
 }finally{await page.unroute('**/api/owner-task',dropAcknowledgment);}

 async function retryAfterReload({prompt,existingThread,restoreNew=false}){
  const payloads=[];let accepted;
  const handler=async route=>{
   const payload=route.request().postDataJSON();
   if(payload.prompt!==prompt)return route.continue();
   payloads.push(payload);
   if(payloads.length!==1)return route.continue();
   const result=await route.fetch();assert.equal(result.status(),200);
   accepted=(await result.json()).task;await route.abort();
  };
  await page.route('**/api/owner-task',handler);
  try{
   if(existingThread)await chooseThread(existingThread);else await page.locator('#owner-new').click();
   await input.fill(prompt);await failSubmit(submit);
   assert(accepted?.requestId);
   assert.equal(payloads[0].conversationId,existingThread);
   const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('xiaojing-owner-pending-requests')));
   assert.deepEqual(pending.map(record=>Object.keys(record).sort()),[['digest','id']]);
   assert.equal(pending[0].id,accepted.requestId);
   assert.equal(pending[0].digest,createHash('sha256').update(JSON.stringify(['editor',existingThread||'',prompt])).digest('hex'));
   assert(!JSON.stringify(pending).includes(prompt),'an unresolved request stores no instruction text');

   await page.reload();
   if(restoreNew){
    await page.locator('#owner-thread-title').filter({hasText:'新任务'}).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('conversation'),'~new');
    assert.equal(await page.evaluate(()=>ownerDialogSelection()),'~new');
   }else{
    await chooseThread(accepted.conversationId);
    await page.locator('#owner-tasks').getByText(prompt,{exact:true}).waitFor();
   }
   assert.equal(payloads.length,1,'reload never automatically resubmits');
   assert.equal(await input.inputValue(),'');
   if(!existingThread&&!restoreNew){
    // An identical explicit turn in another task is independent.
    await chooseThread(firstConversation);await input.fill(prompt);
    assert.notEqual((await submitAndRead()).id,accepted.id);
    assert.notEqual(payloads.at(-1).requestId,accepted.requestId);
    await chooseThread(accepted.conversationId);

    const detailRoute='**/api/owner-conversations/detail';
    const loseProof=route=>route.abort();
    await page.route(detailRoute,loseProof);
    try{
     const failed=page.waitForEvent('requestfailed',{predicate:request=>request.url().endsWith('/api/owner-conversations/detail')});
     await input.fill(prompt);await submit.click();await failed;
     await page.waitForFunction(()=>!document.querySelector('#owner-submit').disabled);
     assert.equal(payloads.length,2,'unavailable receipt lookup must not start a fresh request');
    }finally{await page.unroute(detailRoute,loseProof);}
   }
   await input.fill(prompt);
   assert.equal((await submitAndRead()).id,accepted.id);
   assert.equal(payloads.at(-1).requestId,accepted.requestId);
   assert.equal(payloads.at(-1).conversationId,existingThread);
   assert.equal(await input.inputValue(),'');
   assert.deepEqual(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('xiaojing-owner-pending-requests'))),[]);
   await input.fill(prompt);
   assert.notEqual((await submitAndRead()).id,accepted.id,'explicit turn after acknowledgement is new');
  }finally{await page.unroute('**/api/owner-task',handler);}
 }
 await retryAfterReload({prompt:'刷新后核对同一会话的回执',existingThread:firstConversation});
 await retryAfterReload({prompt:'刷新后仍在新任务编辑器核对回执',restoreNew:true});
 await retryAfterReload({prompt:'刷新后核对首次提交的回执'});

 for(const width of [1440,768,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'对话页不应横向溢出');if(width<1050)assert.equal(await page.locator('#owner-thread-select').isVisible(),true);}
 assert.deepEqual(errors,[]);console.log(JSON.stringify({multiRoundSameTask:true,queuedSupplements:true,activeRoundNotInterrupted:true,nativeSessionReuse:true,timeoutContinuation:true,continuationPreservesDraftAndRetry:true,refreshRestoresTranscript:true,newTaskIsolation:true,stopCancelsOnlySelectedTask:true,delayedAckPreservesTypedDraft:true,delayedAckPreservesSelection:true,separateNewDrafts:true,threadRetryDoesNotDuplicate:true,intentionalRepeatAfterAck:true,reloadReusesExactFirstAndExistingTurn:true,unavailableReceiptProofDoesNotSubmit:true,responsiveWidths:[1440,768,390],paidModelCalls:0,realHRsContacted:0}));
}finally{await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
