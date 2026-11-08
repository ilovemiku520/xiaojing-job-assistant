import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';

const temp=realpathSync(tmpdir()),local=realpathSync(mkdtempSync(join(temp,'xiaojing-hr-queue-ui-')));
assert.equal(dirname(local),temp);
const port=await testPort(),base=`http://127.0.0.1:${port}`,now=Date.now();
const desktop=process.env.XIAOJING_HR_QUEUE_DESKTOP!=='0';
let generated=0;
const app=createApplication({port,local,desktop,key:'fixture',inference:async()=>{generated++;throw Error('模拟模型暂时不可用');}});
const state=app.state;
state.config.profile={...state.config.profile,name:'测试主人',titles:['策划'],cities:['北京'],facts:'虚构资料'};
Object.assign(state.config,{mode:'review',running:true,channels:{jobSearch:false,hrInbox:true},browserCalibrated:false,learningEnabled:false});

function contact(id,name){
  const peerId=`fixture:${id}`;
  state.memories[peerId]={peerId,header:`${name} · 模拟公司`,domIdentity:{name},job:{company:'模拟公司',title:'策划实习'},history:[],sends:[],decisions:[],revision:1,updatedAt:now,lastSeenAt:now};
  return peerId;
}
function row(id,name,status,data={}){
  const peerId=contact(id,name);
  state.replyQueue.push({id,peerId,name,company:'模拟公司',status,queuedAt:now-22000,...data});
  return peerId;
}
function linked(id,name,status){
  const peerId=row(id,name,'ready',{taskId:`task-${id}`,startedAt:now-15000,timing:{queuedMs:7000,generationMs:4500}});
  state.tasks.push({id:`task-${id}`,peerId,kind:'reply',job:{company:'模拟公司',title:'策划实习'},status,action:'send_text',text:`${name} 的模拟回复`,createdAt:now-8000,updatedAt:now-2000,...(status==='executing'?{reservedAt:now-5000}:{})});
}
linked('review','待审甲','pending');
linked('browser','浏览器乙','approved');
linked('executing','执行丙','executing');
row('generating','拟写丁','generating',{startedAt:now-11000});
row('queued','排队戊','queued');
row('old','旧失败己','failed',{retryAt:now+60000,reason:'旧数据缺少重试输入'});
linked('sent','已送达庚','sent');

app.server.listen(port,'127.0.0.1');await once(app.server,'listening');
const session=await(await fetch(base+'/api/session')).json();
async function api(path,data){
  const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'X-Boss-Token':session.token,'Content-Type':'application/json'},...(data?{body:JSON.stringify(data)}:{})});
  const value=await response.json();assert(response.ok,value.error);return value;
}
const browser=await chromium.launch({headless:true,channel:'msedge'});
try{
  await api('/api/replies/enqueue',{peerId:'fixture:retry',kind:'reply',trigger:'new_hr_message',header:'重试辛 · 模拟公司',label:{name:'重试辛',company:'模拟公司'},job:{title:'策划实习'},messages:[{id:'incoming-retry',role:'hr',text:'您好，什么时候方便了解项目？'}]});
  let retry;
  for(let attempt=0;attempt<80;attempt++){
    retry=state.replyQueue.find(item=>item.peerId==='fixture:retry');
    if(retry?.retryAt)break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert(retry?.retryAt);
  retry.retryAt=Date.now()+60000;
  retry.reason='上次拟写未完成 sk-fixture-private-key-0123456789\n'+ '细'.repeat(180);
  assert.equal((await api('/api/state')).replyQueue.find(item=>item.id===retry.id).retryScheduled,true);

  const page=await browser.newPage({viewport:{width:1440,height:960}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://www.zhipin.com/**',route=>route.abort());
  if(desktop)await page.addInitScript(()=>{window.xiaojingDesktop={onBrowserProgress(){},onEmbeddedState(){},onJobLink(){}};});
  await page.goto(base+'/#hr-channel');
  const queue=page.locator('#hr-channel-queue'),items=queue.locator('.channel-queue-row');
  await queue.waitFor();
  assert.equal(await items.count(),5);
  assert.equal(await page.locator('#hr-queue-count').innerText(),'5 / 6');
  assert.match(await queue.locator('[data-stage="review"]').innerText(),/待审核/);
  assert.match(await queue.locator('[data-stage="browser"]').innerText(),/待浏览器执行[\s\S]*站内发送尚未校准/);
  assert.match(await queue.locator('[data-stage="executing"]').innerText(),/站内执行中[\s\S]*等待站内回显/);
  assert.match(await queue.locator('[data-stage="generating"]').innerText(),/入队至拟写[\s\S]*拟写 \d+ 秒/);
  const retryRow=queue.locator('[data-stage="retry"]');
  assert.match(await retryRow.innerText(),/最早 \d{2}:\d{2}:\d{2} 重试/);
  assert.match(await retryRow.innerText(),/凭据已隐藏/);
  assert.doesNotMatch(await queue.innerText(),/sk-fixture|旧失败己|已送达庚/);
  assert((await retryRow.locator('.channel-queue-reason').textContent()).length<=130);
  assert.match(await page.locator('#hr-channel-activity').innerText(),/已送达庚/);
  assert.doesNotMatch(await page.locator('#hr-channel-activity').innerText(),/待审甲|浏览器乙/);

  const browserRow=queue.locator('[data-stage="browser"]');
  if(desktop){
    const jump=browserRow.getByRole('button',{name:/浏览器乙/});
    assert.equal(await jump.evaluate(node=>getComputedStyle(node).gridColumnStart),'2');
    assert.equal(await page.locator('.channel-empty p').last().evaluate(node=>getComputedStyle(node).color),'rgb(136, 136, 136)');
    await jump.focus();await page.evaluate(()=>refresh());
    assert.equal(await jump.evaluate(node=>node===document.activeElement),true);
    await jump.click();await page.locator('#memory-thread-title').filter({hasText:'浏览器乙'}).waitFor();
    await page.locator('#main-nav [data-panel="hr-channel"]').click();
  }
  state.config.mode='auto';state.tasks.find(task=>task.id==='task-executing').status='sent';
  await page.evaluate(()=>refresh());
  assert.equal(await queue.locator('[data-stage="review"]').count(),0);
  assert.equal(await queue.locator('[data-stage="browser"]').count(),2);
  assert.match(await queue.locator('[data-stage="queued"]').innerText(),/排队 \d+ 秒/);
  state.config.browserCalibrated=true;
  state.config.limits={...state.config.limits,hoursStart:0,hoursEnd:24,intervalSeconds:0,dailyMessages:1};
  state.tasks.find(task=>task.id==='task-executing').reservedAt=Date.now();
  await api('/api/heartbeat',{page:'https://www.zhipin.com/web/geek/chat'});await page.evaluate(()=>refresh());
  assert.match(await queue.locator('[data-stage="browser"]').first().innerText(),/已达到当日站内消息上限/);

  row('auth','认证辛','auth_blocked',{reason:'HR 回复模型认证失败（401）。请到「模型与联网」更新 API 密钥或更换回复模型。'});
  await page.evaluate(()=>refresh());
  const authRow=queue.locator('[data-stage="auth_blocked"]');
  assert.match(await authRow.innerText(),/待修复模型[\s\S]*已保留消息[\s\S]*模型与联网/);
  assert.doesNotMatch(await authRow.innerText(),/重试/);

  for(const width of [1440,768,390]){
    await page.setViewportSize({width,height:940});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(process.env.XIAOJING_HR_QUEUE_SCREENSHOTS){
      const output=process.env.XIAOJING_HR_QUEUE_SCREENSHOTS;mkdirSync(output,{recursive:true});
      await page.screenshot({path:join(output,`hr-queue-${width}.png`),fullPage:true});
    }
  }
  state.replyQueue.length=0;
  await page.evaluate(()=>refresh());await queue.waitFor({state:'hidden'});
  assert.equal(generated,1,'仅模拟了一次生成失败，测试不发送消息');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({desktop,activeLimit:true,reviewVsBrowser:true,retryEligibility:true,authBlock:true,timing:true,redactedReason:true,budgetReason:true,outcomesSeparate:true,emptyHidden:true,realHRsContacted:0}));
}finally{
  await browser.close();await app.shutdown();rmSync(local,{recursive:true,force:true});
}
