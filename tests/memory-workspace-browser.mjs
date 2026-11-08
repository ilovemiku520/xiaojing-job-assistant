import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const port=await testPort();
const temporary=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temporary,'xiaojing-memory-ui-')));
assert.equal(dirname(local),temporary);
const app=createApplication({port,desktop:true,local,key:'',inference:()=>{throw Error('会话阅读无需模型');}});
app.state.config.learningEnabled=false;
const now=Date.now();
const title='系统策划实习生',knownText='收到，附件已经送达，请问接下来还有哪些流程？';
const fixtureMessage=(index,role='hr',text=`历史第 ${index+1} 条。您好，想进一步沟通实习方向和团队的项目情况。`)=>({id:`fixture-mid-${index}`,eventId:`fixture-event-${index}`,role,text,observedAt:now+index*60000});
const company='逐浪游戏';
for(let index=0;index<13;index++){
  const peerId=`fixture:hr-${index}`,name=index===0?'林女士':`模拟联系人 ${index}`;
  app.state.memories[peerId]={peerId,header:`${name} · 招聘方`,domIdentity:{name,company:index===0?company:`模拟公司 ${index}`},revision:1,lastSeenAt:now-index*60000,updatedAt:now-index*60000,
    job:{title:index===0?title:'实习岗位',company:index===0?company:`模拟公司 ${index}`,city:'北京'},history:[fixtureMessage(index)],sends:[],decisions:[]};
}
const first=app.state.memories['fixture:hr-0'];
first.history=Array.from({length:36},(_,index)=>fixtureMessage(index));
app.state.memories['fixture:hr-1'].history=Array.from({length:36},(_,index)=>fixtureMessage(100+index));
const partial=app.state.memories['fixture:hr-2'];
partial.history=Array.from({length:77},(_,index)=>fixtureMessage(200+index));
first.history[5]=fixtureMessage(5,'self','这条较早的我方消息还未确认作者。');
first.history[32]=fixtureMessage(32,'self','我目前重点关注系统和玩法策划实习。');
first.history[33]=fixtureMessage(33,'self',knownText);
first.history[34]=fixtureMessage(34,'self',knownText);
first.history[35]=fixtureMessage(35,'hr','谢谢，今天会转给项目负责人确认。');
first.authorConfirmations={'fixture-mid-32':{kind:'owner_confirmed',source:'authenticated_owner',at:now,text:first.history[32].text}};
first.sends=[{taskId:'fixture-send',status:'sent',text:knownText,evidence:'站内回显包含完整正文',receipt:{messageId:'fixture-mid-33'}}];
first.resume={status:'sent',receipts:[{id:'receipt',raw:'您的附件简历已发送给 Boss'}]};
first.historyCoverage={complete:false};
app.state.ownerDecisions=[{id:'fixture-decision',header:'林女士',summary:'确认下周面试时间',status:'needs_owner_decision'}];
app.state.tasks.push({id:'fixture-activity',kind:'reply',peerId:'fixture:hr-12',status:'sent',text:'合成回复',job:{company:'模拟公司 12'},updatedAt:now});

app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
const browser=await chromium.launch({headless:true,channel:'msedge'});
let releaseOlder,releaseCurrentOlder,releaseExpandedOlder,releaseRangedLatest;
try{
  const page=await browser.newPage({viewport:{width:1440,height:930}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/memory/conversation')requests.push(url.searchParams);});
  await page.route('https://www.zhipin.com/**',route=>route.abort());
  await page.addInitScript(()=>{window.xiaojingDesktop={onBrowserProgress(){},onEmbeddedState(){},onJobLink(){}};});
  await page.goto(`http://127.0.0.1:${port}`);
  await page.locator('.nav[data-panel="memory"]').click();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-messages li').length===30);
  const list=page.locator('#memory-thread-list'),messages=page.locator('#memory-messages');
  assert.equal(await list.locator('button').count(),10);
  assert.equal(await page.locator('#memory-thread-title').innerText(),'林女士');
  assert.equal(requests.length,1,'首屏只请求一段选中的会话历史');
  assert.match(await messages.locator('[data-author="owner_confirmed"]').innerText(),/本人确认[\s\S]*消息编号 fixture-mid-32/);
  assert.match(await messages.locator('[data-author="bot_verified"]').innerText(),/已核对发送回执[\s\S]*消息编号 fixture-mid-33/);
  assert.match(await messages.locator('[data-author="account_self_unknown"]').innerText(),/作者未确认/);
  assert.match(await messages.locator('[data-author="hr"]').last().innerText(),/招聘方/);

  if(process.env.XIAOJING_MEMORY_SCREENSHOTS){
    const folder=process.env.XIAOJING_MEMORY_SCREENSHOTS;mkdirSync(folder,{recursive:true});
    for(const width of [1440,768,390]){
      await page.setViewportSize({width,height:930});
      if(await list.isVisible())await list.getByRole('button',{name:/林女士/}).click();
      await page.screenshot({path:join(folder,`memory-${width}.png`),fullPage:true});
    }
    await page.setViewportSize({width:1440,height:930});
  }
  await page.locator('#memory-page-next').click();
  assert.equal(await list.locator('button').count(),3);
  assert.equal(await page.locator('#memory-thread-title').innerText(),'林女士','分页不清除已选择的联系人');
  await page.locator('#memory-search').fill('逐浪 系统策划');
  assert.equal(await list.locator('button').count(),1);
  assert.match(await list.innerText(),/林女士/);
  await page.locator('#memory-search').fill('');

  const earlier=page.locator('#memory-older');
  const select=list.getByRole('button',{name:/林女士/});
  const importHistory=(c,rows)=>page.evaluate(data=>api('/api/chat/history',data),{peerId:c.peerId,...c.domIdentity,messages:rows});
  const timeline=page.locator('#memory-timeline');
  const readingPosition=()=>timeline.evaluate(node=>node.querySelector('[data-message-anchor="fixture-event-8"]').getBoundingClientRect().top-node.getBoundingClientRect().top);
  const olderHeld=new Promise(resolve=>{releaseOlder=resolve;});
  let intercepted;
  const olderIntercepted=new Promise(resolve=>{intercepted=resolve;});
  const isFirstOlder=url=>{
    const query=new URL(url).searchParams;
    return query.get('peerId')==='fixture:hr-0'&&query.has('before');
  };
  const holdOlder=async route=>{
    if(isFirstOlder(route.request().url())){intercepted();await olderHeld;}
    await route.continue();
  };
  const olderRoute='**/api/memory/conversation?**';
  await page.route(olderRoute,holdOlder);
  await earlier.click();await olderIntercepted;
  await list.locator('[data-memory-peer="fixture:hr-1"]').click();
  await messages.locator('li').first().filter({hasText:'历史第 107 条'}).waitFor();
  assert.equal(await earlier.isEnabled(),true,'旧会话加载不阻塞另一位联系人');
  await earlier.click();
  await messages.locator('li').first().filter({hasText:'历史第 101 条'}).waitFor();
  await select.click();
  await messages.locator('li').first().filter({hasText:'历史第 7 条'}).waitFor();
  const late=page.waitForResponse(response=>isFirstOlder(response.url()));
  releaseOlder();await (await late).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await messages.locator('li').count(),30,'切回原联系人也不追加上次已经失效的加载');
  await page.unroute(olderRoute,holdOlder);
  await earlier.click();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-messages li').length===36);
  assert.equal(requests.at(-1).get('before'),'6');
  assert.match(await messages.locator('li').first().innerText(),/历史第 1 条/);
  assert(await page.locator('#memory-timeline').evaluate(node=>node.scrollTop)>0,'加载更早消息后保留当前阅读位置');
  await select.focus();
  await page.evaluate(()=>refresh());
  const sameVersionCount=requests.length;
  await page.evaluate(()=>refresh());
  assert.equal(requests.length,sameVersionCount,'未改变的选中会话不重新请求历史');
  first.history.push(fixtureMessage(36,'hr','这是新的模拟消息。'));
  first.revision++;first.updatedAt=now+86400000;
  const appendResponse=page.waitForResponse(response=>new URL(response.url()).searchParams.get('from')==='~all');
  await page.evaluate(()=>refresh());
  await page.waitForFunction(()=>document.querySelector('#memory-messages').textContent.includes('这是新的模拟消息'));
  assert.equal((await (await appendResponse).json()).history.length,30,'普通新消息只请求最近一页');
  assert.equal(await select.evaluate(button=>button===document.activeElement),true);
  assert.equal(await messages.locator('li').count(),37,'刷新最新历史保留已加载的旧消息');
  assert.equal(await page.locator('#memory-thread-title').innerText(),'林女士');

  await timeline.evaluate(node=>{
    const row=node.querySelector('[data-message-anchor="fixture-event-8"]');
    node.scrollTop+=row.getBoundingClientRect().top-node.getBoundingClientRect().top-8;
  });
  const previousPosition=await readingPosition();
  const insertedBefore=fixtureMessage(-1,'hr','新补录的历史开头。');
  const insertedBetween=fixtureMessage(1000,'hr','新补录到两条已保存消息之间。');
  const edited={...first.history[0],text:'补录后修正的正文。'};
  assert.equal((await importHistory(first,[insertedBefore,edited,insertedBetween,first.history[1]])).added,2);
  await page.evaluate(()=>refresh());
  await messages.getByText(insertedBetween.text,{exact:true}).waitFor();
  assert.equal(await messages.locator('li').count(),39);
  assert.equal(await messages.locator('li').first().locator('.memory-message-text').textContent(),insertedBefore.text);
  assert.equal(await messages.locator('[data-message-anchor="fixture-event-0"]').count(),1);
  assert.equal(await messages.getByText(edited.text,{exact:true}).count(),1);
  assert.equal(await earlier.isVisible(),false);
  assert.ok(Math.abs(await readingPosition()-previousPosition)<=2,'补录时保留阅读锚点');

  await page.evaluate(()=>api('/api/chat/author-confirm',{peerId:'fixture:hr-0',messageId:'fixture-mid-5',kind:'owner_confirmed'}));
  await page.evaluate(()=>refresh());
  await messages.locator('[data-message-anchor="fixture-event-5"][data-author="owner_confirmed"]').waitFor();
  await messages.locator('[data-message-anchor="fixture-event-34"]').getByRole('button',{name:'标为本人发送',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-messages [data-author="owner_confirmed"]').length===3);
  assert.equal(first.authorConfirmations['fixture-mid-34'].kind,'owner_confirmed');
  await page.locator('[data-memory-tab="job"]').click();
  assert.match(await page.locator('#memory-job').innerText(),/您的附件简历已发送给 Boss/);
  await page.locator('[data-memory-tab="receipts"]').click();
  assert.match(await page.locator('#memory-receipts').innerText(),/站内回显包含完整正文/);
  await page.locator('#memory-pending-label').click();
  assert.match(await page.locator('#memory-pending-items').innerText(),/确认下周面试时间/);

  await list.locator('[data-memory-peer="fixture:hr-2"]').click();
  await messages.locator('li').first().filter({hasText:'历史第 248 条'}).waitFor();
  await earlier.click();
  await messages.locator('li').first().filter({hasText:'历史第 218 条'}).waitFor();
  const currentOlderHeld=new Promise(resolve=>{releaseCurrentOlder=resolve;});
  let currentIntercepted;
  const currentOlderIntercepted=new Promise(resolve=>{currentIntercepted=resolve;});
  const isCurrentOlder=url=>{const query=new URL(url).searchParams;return query.get('peerId')===partial.peerId&&query.has('before');};
  const holdCurrentOlder=async route=>{
    if(!isCurrentOlder(route.request().url())){await route.continue();return;}
    const response=await route.fetch();currentIntercepted();await currentOlderHeld;await route.fulfill({response});
  };
  await page.route(olderRoute,holdCurrentOlder);
  await earlier.click();await currentOlderIntercepted;
  const beforePartial=fixtureMessage(1001,'hr','部分范围起点之前的新消息。');
  const insidePartial=fixtureMessage(1002,'hr','部分范围内的新消息。');
  assert.equal((await importHistory(partial,[beforePartial,partial.history[17],insidePartial,partial.history[18]])).added,2);
  await page.evaluate(()=>refresh());
  await messages.getByText(insidePartial.text,{exact:true}).waitFor();
  assert.equal(requests.at(-1).get('from'),'event:fixture-event-217');
  assert.equal(await messages.locator('li').count(),61);
  assert.equal(await messages.getByText(beforePartial.text,{exact:true}).count(),0);
  assert.equal(await earlier.isEnabled(),true,'版本更新会释放旧请求占用的按钮');
  const stale=page.waitForResponse(response=>isCurrentOlder(response.url()));
  releaseCurrentOlder();await (await stale).finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await messages.locator('li').count(),61,'旧版本的早期历史不能覆盖新的范围');
  await page.unroute(olderRoute,holdCurrentOlder);

  const heldOlder=new Promise(resolve=>{releaseExpandedOlder=resolve;});
  const heldLatest=new Promise(resolve=>{releaseRangedLatest=resolve;});
  let heldOlderReady,heldLatestReady;
  const olderCaptured=new Promise(resolve=>{heldOlderReady=resolve;});
  const latestCaptured=new Promise(resolve=>{heldLatestReady=resolve;});
  const holdOverlappingRanges=async route=>{
    const url=route.request().url(),query=new URL(url).searchParams;
    if(query.get('peerId')===partial.peerId&&(query.has('before')||query.get('from')==='event:fixture-event-217')){
      const response=await route.fetch();
      if(query.has('before')){heldOlderReady();await heldOlder;}
      else{heldLatestReady();await heldLatest;}
      await route.fulfill({response});return;
    }
    await route.continue();
  };
  await page.route(olderRoute,holdOverlappingRanges);
  await earlier.click();await olderCaptured;
  const newlyEarliest=fixtureMessage(1003,'hr','重叠请求期间补录到历史开头。');
  await importHistory(partial,[newlyEarliest,partial.history[0]]);
  await page.evaluate(()=>refresh());await latestCaptured;
  releaseExpandedOlder();
  await page.waitForFunction(()=>document.querySelectorAll('#memory-messages li').length===79);
  releaseRangedLatest();
  await messages.locator('li').first().filter({hasText:newlyEarliest.text}).waitFor();
  assert.equal(await messages.locator('li').count(),80,'刷新期间加载更早成功时保留扩展后的范围');
  await page.unroute(olderRoute,holdOverlappingRanges);

  await select.click();
  await list.locator('[data-memory-peer="fixture:hr-2"]').click();
  await messages.locator('li').first().filter({hasText:'历史第 248 条'}).waitFor();
  await earlier.click();
  await messages.locator('li').first().filter({hasText:insidePartial.text}).waitFor();
  partial.history=Array.from({length:1000},(_,index)=>fixtureMessage(3000+index));
  partial.revision++;
  await page.evaluate(()=>refresh());
  await messages.locator('li').first().filter({hasText:'历史第 3971 条'}).waitFor();
  assert.equal(await messages.locator('li').count(),30,'锚点被淘汰时回到最近一页');
  assert.equal(await messages.getByText(insidePartial.text,{exact:true}).count(),0);

  await earlier.click();
  await messages.locator('li').first().filter({hasText:'历史第 3941 条'}).waitFor();
  const newRetained=fixtureMessage(4000,'hr','保留上限滚动时的新消息。');
  partial.history.shift();partial.history.push(newRetained);partial.revision++;
  const retainedResponse=page.waitForResponse(response=>new URL(response.url()).searchParams.get('from')==='event:fixture-event-3940');
  await page.evaluate(()=>refresh());
  await messages.getByText(newRetained.text,{exact:true}).waitFor();
  assert.equal((await (await retainedResponse).json()).history.length,30);
  assert.equal(await messages.locator('li').count(),61);
  assert.match(await messages.locator('li').first().textContent(),/历史第 3941 条/);

  await select.click();
  await page.setViewportSize({width:390,height:850});
  assert.equal(await page.locator('#memory-back').isVisible(),true);
  assert.equal(await list.isVisible(),false);
  await page.locator('#memory-back').click();
  assert.equal(await list.isVisible(),true);
  assert.equal(await page.locator('#memory-thread').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  await page.setViewportSize({width:1440,height:930});
  await page.locator('#main-nav [data-panel="hr-channel"]').click();
  const jump=page.getByRole('button',{name:'打开 模拟联系人 12 的会话记忆'});
  await jump.focus();
  await page.evaluate(()=>refresh());
  assert.equal(await jump.evaluate(node=>node===document.activeElement),true);
  await jump.click();
  await page.waitForFunction(()=>document.querySelector('#memory-thread-title').textContent==='模拟联系人 12');
  assert.equal(await page.locator('#memory-page-label').textContent(),'2 / 2');
  await page.waitForFunction(()=>document.querySelector('#memory-messages').textContent.includes('历史第 13 条'));
  assert.equal(requests.at(-1).get('peerId'),'fixture:hr-12');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({searchAndPaging:true,selectedHistoryOnly:true,olderCursor:true,olderIsolatedByContact:true,pollKeepsFocusAndSelection:true,exactAuthors:true,mobileNavigation:true,appendFetchesOnePage:true,importPreservesFullRangeAndScroll:true,earlierAuthorRefresh:true,partialRangeRefresh:true,staleOlderIgnored:true,concurrentRangeExpansionPreserved:true,evictedAnchorFallback:true,retentionAppendFetchesOnePage:true,realHRsContacted:0}));
}finally{
  releaseOlder?.();releaseCurrentOlder?.();releaseExpandedOlder?.();releaseRangedLatest?.();
  await browser.close();await app.shutdown();rmSync(local,{recursive:true,force:true});
}
