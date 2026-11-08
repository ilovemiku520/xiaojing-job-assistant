// Isolated browser fixture: never connects to BOSS or sends to a real HR.
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.BOSS_PLAYWRIGHT||'../tools/node/node_modules/playwright');
import {mkdtempSync,readFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {testPort} from './port.mjs';
import assert from 'node:assert/strict';
import {createApplication} from '../server/app.mjs';

const port=await testPort();
const app=createApplication({local:mkdtempSync(join(tmpdir(),'whale-browser-')),port,key:'fixture',inference:async()=>({action:'send_text',text:'你好呀，小鲸收到啦，想了解下岗位的具体玩法方向。',reason:'虚构页面验证',score:90})});
await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
const base=`http://127.0.0.1:${port}`;
const session=await(await fetch(base+'/api/session')).json();
async function api(path,data,owner=true){const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
const browser=await chromium.launch({headless:true,...(process.env.BOSS_TEST_BROWSER?{executablePath:process.env.BOSS_TEST_BROWSER}:{channel:'msedge'})});
try{
 await api('/api/config',{browserCalibrated:true,newMessagesOnly:false,historyRead:false,mode:'review',limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试主人',titles:['游戏策划'],cities:['北京'],facts:'虚构资料，只供自动测试'}});await api('/api/run',{running:true});
 const page=await browser.newPage();
 const fixtureHTML=`<!doctype html><html><body>
 <div class="friend-list"><div class="friend-item active" data-id="fixture-hr"><div class="title-box"><span class="name-box"><span class="name-text">测试 HR</span></span><span>测试公司</span></div></div></div>
 <div class="chat-conversation"><h2 class="chat-title">测试 HR · 测试公司</h2><div id="messages"><div class="message-item item-friend" data-mid="hr-1"><span class="text">你好，了解下玩法策划吗？</span></div></div></div>
 <div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send" disabled>发送</button></div>
 <script>const editor=document.querySelector('textarea'),button=document.querySelector('button');editor.addEventListener('input',()=>button.disabled=!editor.value);button.addEventListener('click',()=>{const m=document.createElement('div');m.className='message-item item-myself';m.dataset.mid='self-'+Date.now();const text=document.createElement('span');text.className='text';text.textContent=editor.value;m.append(text);document.querySelector('#messages').append(m);editor.value='';button.disabled=true;});</script></body></html>`;
 await page.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:fixtureHTML}));
 await page.exposeFunction('fixtureApi',async m=>['worker','crawlWorker'].includes(m.type)?{ok:true,result:null}:m.type==='chatMonitor'?{ok:true,result:{monitor:true}}:m.type==='api'?{ok:true,result:await api(m.path,m.data,false)}:{ok:true,result:{ok:true}});
 await page.addInitScript(()=>{const values={};window.chrome={storage:{local:{get:async k=>({[k]:values[k]}),set:async v=>Object.assign(values,v)}},runtime:{sendMessage:m=>window.fixtureApi(m)}};});
 await page.goto('https://www.zhipin.com/web/geek/chat');for(const name of ['realtime.js','resume-ui.js','content.js'])await page.addScriptTag({content:readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')});
 await page.waitForFunction(async()=>document.querySelector('textarea')?.value==='',null,{timeout:3000});
 let task;for(let i=0;i<30;i++){task=app.state.tasks[0];if(task)break;await new Promise(r=>setTimeout(r,200));}
 assert(task,'扩展应从DOM采集HR消息并生成草稿');assert.equal(task.peerId,'boss:fixture-hr');assert.equal(task.status,'pending');assert.equal(await page.locator('.item-myself').count(),0);
 await api('/api/review',{id:task.id,approve:true});
 await page.locator('.item-myself').waitFor({timeout:15000});
 for(let i=0;i<30&&task.status!=='sent';i++)await new Promise(r=>setTimeout(r,100));
 assert.equal(task.status,'sent');assert.equal(app.state.memories[task.peerId].sends.length,1);
 assert.equal(await page.locator('.item-myself').count(),1);
 // Verify the local UI loads, switches backend controls, and displays memory without script errors.
 const ui=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];ui.on('pageerror',e=>errors.push(e.message));
 await ui.goto(base);await ui.locator('#running').filter({hasText:'两项都在运行'}).waitFor();
 await ui.getByRole('button',{name:'连接与诊断',exact:true}).click();
 await ui.locator('#browser-token').fill('PLAYWRIGHT_MCP_EXTENSION_TOKEN='+'D'.repeat(43));await ui.locator('#browser-token-form button.primary').click();
 await ui.locator('#browser-auth-state').filter({hasText:'已加密保存'}).waitFor();assert.equal(await ui.locator('#browser-token').inputValue(),'');
 await ui.locator('#browser-token-clear').click();await ui.locator('#browser-auth-state').filter({hasText:'当前逐次连接'}).waitFor();
 await ui.getByRole('button',{name:'会话记忆',exact:true}).click();await ui.locator('#memories summary').waitFor();
 assert.equal(await ui.locator('#memories summary').count(),1);
 await ui.getByRole('button',{name:'运行设置',exact:true}).click();assert.equal(await ui.locator('[name=backend]').inputValue(),'harness');
 await ui.getByRole('button',{name:'学习记录',exact:true}).click();
 await ui.locator('#learning-note').fill('界面验证记忆：聊项目时先讲规则设计');await ui.locator('#learning-note-form button.primary').click();
 await ui.locator('#learning-notes summary').filter({hasText:'界面验证记忆'}).waitFor();
 await ui.locator('#learning-notes details').first().locator('summary').click();await ui.locator('#learning-notes').getByRole('button',{name:'修改',exact:true}).click();
 await ui.locator('#learning-note').fill('更正后的界面验证记忆：先讲玩法设计');await ui.locator('#learning-note-form button.primary').click();
 await ui.locator('#learning-notes summary').filter({hasText:'更正后的界面验证记忆'}).waitFor();
 await ui.locator('#learning-notes').getByRole('button',{name:'停用这条记忆',exact:true}).click();await ui.locator('#learning-notes .empty').waitFor();
 await ui.locator('#learning-filter').selectOption('all');await ui.locator('#learning-notes summary').filter({hasText:'已停用'}).waitFor();
 await ui.getByRole('button',{name:'工作台',exact:true}).click();
 const screenshot=process.env.BOSS_SCREENSHOT;if(screenshot){mkdirSync(join(screenshot,'..'),{recursive:true});await ui.screenshot({path:screenshot,fullPage:true});}
 assert.deepEqual(errors,[]);
 // The actual website may embed its chat in a same-origin iframe.
 await api('/api/config',{mode:'auto',chatRead:true,chatInput:false});await api('/api/run',{running:true});app.state.lastAction=0;
 const framed=await browser.newPage();
 await framed.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname==='/web/geek/chat'?'<html><body><h1>BOSS导航</h1><iframe src="/web/chat/fixture" style="width:1000px;height:600px"></iframe></body></html>':fixtureHTML.replace('data-id="fixture-hr"','data-id="fixture-framed"')}));
 await framed.exposeFunction('fixtureApi',async m=>['worker','crawlWorker'].includes(m.type)?{ok:true,result:null}:m.type==='chatMonitor'?{ok:true,result:{monitor:true}}:m.type==='api'?{ok:true,result:await api(m.path,m.data,false)}:{ok:true,result:{ok:true}});
 await framed.addInitScript(()=>{const values={};window.chrome={storage:{local:{get:async k=>({[k]:values[k]}),set:async v=>Object.assign(values,v)}},runtime:{sendMessage:m=>window.fixtureApi(m)}};});
 await framed.goto('https://www.zhipin.com/web/geek/chat');for(const name of ['realtime.js','resume-ui.js','content.js'])await framed.addScriptTag({content:readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')});
 let framedTask;for(let i=0;i<40;i++){framedTask=app.state.tasks.find(t=>t.peerId==='boss:fixture-framed');if(framedTask)break;await new Promise(r=>setTimeout(r,200));}
 assert(framedTask,'应读到嵌入页面中的聊天');assert.equal(await framed.frameLocator('iframe').locator('.item-myself').count(),0);
 await api('/api/config',{chatInput:true});await api('/api/run',{running:true});app.state.lastAction=0;
 await framed.frameLocator('iframe').locator('.item-myself').waitFor({timeout:18000});
 for(let i=0;i<30&&!app.state.memories['boss:fixture-framed']?.sends.some(s=>s.status==='sent');i++)await new Promise(r=>setTimeout(r,100));
 assert(app.state.memories['boss:fixture-framed'].sends.some(s=>s.status==='sent'));assert.equal(await framed.frameLocator('iframe').locator('.item-myself').count(),1);
 console.log('浏览器闭环通过：审核/自动发送、嵌入聊天读取、HR独立记忆；学习页面保存/更正/停用记忆；工作台无脚本错误。');
}finally{await browser.close();await new Promise(r=>{app.server.close(r);app.server.closeAllConnections();});}
