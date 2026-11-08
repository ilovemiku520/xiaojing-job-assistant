// Local isolated UI verification; no real BOSS page or recruiter is contacted.
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const {chromium}=createRequire(import.meta.url)('../tools/node/node_modules/playwright');
const port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'control-ui-')),port,key:'fixture',inference:async()=>{throw Error('界面测试不调用付费模型');}});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
const base=`http://127.0.0.1:${port}`,{token}=await(await fetch(base+'/api/session')).json(),api=async(p,d)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(d?{body:JSON.stringify(d)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;};
const browser=await chromium.launch({headless:true,channel:'msedge'});
const releasePending=[];
try{
 await api('/api/config',{learningEnabled:false,profile:{name:'测试主人',facts:'2027届本科',titles:['游戏策划'],cities:['北京']}});await api('/api/run',{running:true});
 for(const name of ['甲女士','乙女士'])await api('/api/owner-chat',{requestId:name,kind:'read',instruction:'仅测试独立任务停止',targets:[{name,company:'模拟游戏公司'}]});
 const aText='alpha 主人更关注关卡策划，需要先核对岗位的真实职责。';
 const bText='beta 模拟主人记忆，优先核对数值约束。';
 const cText='gamma 这条模拟记忆关联一段原始对话。';
 const {note:aNote}=await api('/api/learning/note',{text:aText});
 await api('/api/learning/note',{text:bText});
 const peerId='fixture:context-timeline',sourceMessage='模拟对话中明确说明先核对团队的开发方向。';
 const history=[{id:'fixture-context-mid',role:'hr',text:sourceMessage}];
 app.state.memories[peerId]={peerId,header:'模拟对话',revision:1,history,sends:[],decisions:[]};
 app.learning.enqueue('conversation',peerId,{header:'模拟对话',messages:history});
 const extraction=app.learning.next(20);app.learning.begin(extraction);
 assert.equal(app.learning.finish(extraction,{notes:[{category:'hr_context',text:cText,evidence:sourceMessage}]}),1);
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>document.querySelector('#agent-state').textContent.includes('High')||document.querySelector('#agent-state').textContent.includes('HIGH'));
 await page.locator('[data-panel="control"]').click();await page.locator('#operation-board .op-card').first().waitFor();assert.equal(await page.locator('#operation-board .op-card').count(),2);
 const first=page.locator('#operation-board .op-card').filter({hasText:'甲女士'});await first.getByRole('button',{name:'停止此任务',exact:true}).click();await page.waitForFunction(()=>document.querySelector('#notice').textContent.includes('已提交停止'));
 assert.equal(app.state.ownerChats.find(p=>p.requestId==='甲女士').status,'finished_with_issues');assert.equal(app.state.ownerChats.find(p=>p.requestId==='乙女士').status,'queued');assert.equal(app.state.config.running,true);
 await page.locator('[data-panel="context"]').click();await page.locator('#project-checkpoint h3').waitFor();
 const results=page.locator('#context-results'),contextDetail=page.locator('#context-detail'),query=page.locator('#context-query');
 const [a,b,c]=[aText,bText,cText].map(name=>results.getByRole('button',{name,exact:true}));
 const search=async text=>{await query.fill(text);await page.getByRole('button',{name:'检索记忆',exact:true}).click();};
 async function holdResponse(path,matches,error){
   const gate=Promise.withResolvers(),entered=Promise.withResolvers(),pattern='**'+path;
   releasePending.push(gate.resolve);
   const handler=async route=>{
     if(!matches(route.request().postDataJSON())){await route.continue();return;}
     entered.resolve();await gate.promise;
     if(error)await route.fulfill({status:503,json:{error}});
     else await route.continue();
   };
   await page.route(pattern,handler);
   return {entered:entered.promise,async release(){
     const received=page.waitForResponse(response=>new URL(response.url()).pathname===path&&matches(response.request().postDataJSON()));
     gate.resolve();await (await received).finished();
     await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
     await page.unroute(pattern,handler);
   }};
 }
 await search('关卡');await a.click();await contextDetail.getByText('主人在本地控制台直接填写',{exact:true}).waitFor();
 await search('');await b.waitFor();assert.equal(await contextDetail.isVisible(),false);

 const oldNote=await holdResponse('/api/context/note',data=>data.id===aNote.id);
 await a.click();await oldNote.entered;
 await b.click();await contextDetail.getByText(bText,{exact:true}).waitFor();
 await oldNote.release();
 assert.equal(await contextDetail.getByText(aText,{exact:true}).count(),0);
 assert.equal(await b.evaluate(node=>node===document.activeElement),true);

 const oldSearch=await holdResponse('/api/context/search',data=>data.query==='alpha');
 await search('alpha');await oldSearch.entered;
 await search('beta');await a.waitFor({state:'detached'});await b.waitFor();
 await oldSearch.release();assert.equal(await a.count(),0);assert.equal(await query.inputValue(),'beta');

 const oldSearchError='较早检索请求返回的模拟错误';
 const failedSearch=await holdResponse('/api/context/search',data=>data.query==='alpha',oldSearchError);
 await search('alpha');await failedSearch.entered;
 await search('gamma');await c.waitFor();
 await failedSearch.release();assert.equal(await b.count(),0);
 assert.equal((await page.locator('#notice').textContent()).includes(oldSearchError),false);

 await search('');await b.waitFor();await c.click();
 const raw=contextDetail.getByRole('button',{name:'读取对应原始对话'});
 const oldTimeline=await holdResponse('/api/context/timeline',data=>data.peerId===peerId);
 await raw.click();await oldTimeline.entered;
 await b.click();await contextDetail.getByText(bText,{exact:true}).waitFor();
 await oldTimeline.release();assert.equal(await contextDetail.getByText(sourceMessage,{exact:false}).count(),0);
 await c.click();await raw.click();
 await contextDetail.getByText(`HR：${sourceMessage}`,{exact:true}).waitFor();

 const oldNoteError='离开项目记忆后才返回的模拟错误';
 const hiddenNote=await holdResponse('/api/context/note',data=>data.id===aNote.id,oldNoteError);
 await a.click();await hiddenNote.entered;
 await page.locator('[data-panel="project-map"]').click();
 await hiddenNote.release();
 assert.equal((await page.locator('#notice').textContent()).includes(oldNoteError),false);
 await page.locator('[data-panel="project-map"]').click();await page.locator('#map-groups button').filter({hasText:'任务管家'}).click();assert((await page.locator('#map-detail').innerText()).includes('server/control.mjs'));assert((await page.locator('#map-detail').innerText()).includes('改动会直接影响'));await page.locator('#map-query').fill('记忆');assert((await page.locator('#map-groups').innerText()).includes('长期记忆与检索'));
 assert.deepEqual(errors,[]);assert.equal(app.state.tasks.length,0);console.log(JSON.stringify({independentTaskCancel:true,checkpointVisible:true,memoryIndexAndEvidence:true,latestSearchAndDetailWin:true,oldErrorsIgnored:true,timelineStaysWithSelectedNote:true,interactiveSourceMap:true,paidModelCalls:0,HRMessagesSent:0}));
}finally{for(const release of releasePending)release();await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
