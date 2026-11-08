import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setImmediate} from 'node:timers/promises';
import {runInNewContext,Script} from 'node:vm';
import {bossNavigation,bossPartition,bossRuntimeId,createEmbeddedBrowser} from '../desktop/embedded-browser.mjs';

const boss='https://www.zhipin.com',extensionDir=fileURLToPath(new URL('../extension/',import.meta.url));

function fixture(local,onSettingsShortcut){
 let nextId=1;
 class Contents extends EventEmitter{
  constructor(){
   super();this.id=nextId++;this.url='about:blank';this.destroyed=false;this.zoom=1;this.mainFrame={processId:1,routingId:this.id,url:this.url};
   this.navigationHistory={canGoBack:()=>false,canGoForward:()=>false};
  }
  isDestroyed(){return this.destroyed;}
  getURL(){return this.url;}
  getZoomFactor(){return this.zoom;}
  setZoomFactor(factor){this.zoom=factor;}
  setZoomMode(mode){this.zoomMode=mode;}
  focus(){this.focused=true;}
  isFocused(){return this.focused===true;}
  setWindowOpenHandler(handler){this.open=handler;}
  async loadURL(url){
   this.emit('did-start-navigation',{url,isMainFrame:true,isSameDocument:false});
   this.url=url;this.mainFrame.url=url;await Promise.resolve();this.emit('dom-ready');this.emit('did-stop-loading');
  }
  reload(){void this.loadURL(this.url);}
  async executeJavaScript(code){this.mainCode=code;new Script(code);}
  async executeJavaScriptInIsolatedWorld(world,[source]){
   assert.equal(world,1104);new Script(source.code);
   if(source.code.startsWith('globalThis.xiaojingBossDeliver('))return {fixture:true};
   this.isolatedCode=source.code;return true;
  }
  close(){this.destroyed=true;this.emit('destroyed');}
 }
 class View{
  constructor(options){this.options=options;this.webContents=options.webContents||new Contents();}
  setBounds(bounds){this.bounds=bounds;}
  setVisible(visible){this.visible=visible;}
  getVisible(){return this.visible;}
 }
 const views=[],window=Object.assign(new EventEmitter(),{
  id:1,isDestroyed:()=>false,getContentSize:()=>[1000,700],contentView:{
   addChildView:view=>views.push(view),removeChildView:view=>views.splice(views.indexOf(view),1)
  }
 });
 const ses=new EventEmitter();
 ses.setPermissionCheckHandler=handler=>ses.checkPermission=handler;
 ses.setPermissionRequestHandler=handler=>ses.requestPermission=handler;
 const handlers=new Map(),messages=[];
 const electron={WebContentsView:View,session:{fromPartition(partition){assert.equal(partition,bossPartition);return ses;}},
  ipcMain:{handle:(name,handler)=>handlers.set(name,handler),removeHandler:name=>handlers.delete(name)}};
 const browser=createEmbeddedBrowser({window,extensionDir,local,onSettingsShortcut,onMessage:(message,sender)=>{messages.push({message,sender});return {ok:true};}},electron);
 return {browser,views,handlers,messages,ses};
}

function backgroundFixture(browser){
 let startup,receive,task,terminal='sent';
 const session={loadedVersion:'fixture'},calls=[];
 const storage=state=>({get:async key=>({[key]:structuredClone(state[key])}),set:async values=>Object.assign(state,structuredClone(values)),remove:async key=>delete state[key]});
 const chrome={runtime:{id:'fixture',getManifest:()=>({version:'fixture'}),onMessage:{addListener(fn){receive=fn;}},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
  storage:{session:storage(session),local:storage({token:'fixture'})},alarms:{create(){},onAlarm:{addListener(){}}},
  tabs:{...browser.tabs,onActivated:undefined,onUpdated:undefined}};
 const fetch=async(url,opts)=>{
  const path=new URL(url).pathname;calls.push(path);
  const value=path==='/api/browser-state'?{config:{hrInboxRunning:true,jobSearchRunning:true,chatRead:true}}:
   path==='/api/work'?{task}:path==='/api/check'?{allowed:true}:path==='/api/complete'?{ok:true,executionStatus:terminal}:{};
  return {ok:true,json:async()=>value};
 };
 const source=readFileSync(new URL('../extension/background.js',import.meta.url),'utf8');
 runInNewContext(source,{chrome,fetch,URL,AbortSignal,setTimeout:fn=>{startup=fn;},Date});
 const message=(m,tab)=>new Promise(resolve=>receive(m,{id:'fixture',tab:{id:tab.id},url:tab.url},resolve));
 return {session,calls,message,async start(next){task=next;await startup();await setImmediate();},terminal(status){terminal=status;}};
}

test('BOSS 导航限定 HTTPS 正确域名，拒绝仿冒、凭据和其他端口',()=>{
 assert.equal(bossNavigation(boss+'/web/geek/chat'),boss+'/web/geek/chat');
 assert.equal(bossNavigation('https://login.zhipin.com/'),'https://login.zhipin.com/');
 for(const url of ['about:blank','http://www.zhipin.com/','https://www.zhipin.com.evil.test/','https://a@www.zhipin.com/','https://www.zhipin.com:8000/','file:///C:/test','https://badzhipin.com/'])assert.equal(bossNavigation(url),'');
});

test('只有当前可见且获焦的 BOSS 标签响应 Ctrl+,，恢复焦点不会切换标签',async t=>{
 const shortcuts=[],{browser,views}=fixture(undefined,id=>{shortcuts.push(id);return true;});
 t.after(()=>browser.close());
 const {activeTabId}=browser.show({x:0,y:100,width:900,height:600});
 const active=views[0].webContents;
 const send=(contents,patch={})=>{
  let prevented=false;
  contents.emit('before-input-event',{preventDefault(){prevented=true;}},{type:'keyDown',key:',',control:true,...patch});
  return prevented;
 };
 assert.equal(send(active),false);
 active.focus();
 for(const patch of [{key:'Escape'},{type:'keyUp'},{alt:true},{shift:true},{meta:true},{control:false},{isAutoRepeat:true}])assert.equal(send(active,patch),false);
 assert.equal(send(active),true);
 const background=await browser.tabs.create({url:boss+'/web/geek/job',active:false});
 const backgroundContents=views[1].webContents;
 backgroundContents.focus();
 assert.equal(send(backgroundContents),false);
 assert.equal(browser.focusTab(background.id),false);
 assert.equal(browser.state().activeTabId,activeTabId);
 assert.equal(browser.focusTab(activeTabId),true);
 browser.hide();
 assert.equal(send(active),false);
 assert.equal(browser.focusTab(activeTabId),false);
 assert.deepEqual(shortcuts,[activeTabId]);
});

test('内置标签共享专用浏览器会话，处理 BOSS 弹窗并在孤立世界收发',async t=>{
 const {browser,views,ses}=fixture();t.after(()=>browser.close());
 assert.equal(views.length,0);
 const state=browser.show({x:30,y:110,width:1000,height:700});
 assert.equal(state.url,boss+'/web/geek/chat');
 assert.deepEqual(views[0].bounds,{x:30,y:110,width:970,height:590});
 assert.equal(views[0].options.webPreferences.sandbox,true);
 assert.equal(views[0].options.webPreferences.contextIsolation,true);
 assert.equal(views[0].options.webPreferences.nodeIntegration,false);
 assert.equal(views[0].webContents.zoomMode,'isolated');
 assert.equal(ses.checkPermission(),false);
 await setImmediate();
 const [first]=await browser.tabs.query({url:boss+'/*'});
 assert.equal(first.ready,true);
 assert(views[0].webContents.mainCode.includes('boss-assistant-read-position-link'));
 assert(!views[0].webContents.mainCode.includes('xiaojingBossTransport'));
 assert(views[0].webContents.isolatedCode.includes('xiaojingBossTransport'));
 assert.deepEqual(await browser.tabs.sendMessage(first.id,{type:'assistant-read',command:'tick'}),{fixture:true});
 await assert.rejects(browser.tabs.sendMessage(first.id,{type:'run-code',command:'tick'}),/请求不可用/);

 assert.equal(views[0].webContents.open({url:'https://example.test/'}).action,'deny');
 const popup=views[0].webContents.open({url:boss+'/job_detail/example.html'});
 assert.equal(popup.action,'allow');
 const child=popup.createWindow({});await setImmediate();
 assert.equal((await browser.tabs.get(child.id)).openerTabId,first.id);
 assert.equal(browser.state().activeTabId,child.id);
 browser.select(first.id);assert.equal(views[0].visible,true);assert.equal(views[1].visible,false);
 browser.hide();assert(views.every(v=>!v.visible));
 browser.closeTab(child.id);assert.equal(views.length,1);
});

test('内置页面崩溃单独标记并保留原标签，手动刷新后按正常加载重新接桥',async t=>{
 const {browser,views}=fixture();t.after(()=>browser.close());
 const changes=[];browser.tabs.onUpdated.addListener((id,change,tab)=>changes.push({id,change,tab}));
 const chat=await browser.tabs.create({url:boss+'/web/geek/chat'});await setImmediate();
 const job=await browser.tabs.create({url:boss+'/job_detail/manual.html'});await setImmediate();
 const view=views.find(item=>item.webContents.id===chat.id);
 view.webContents.emit('render-process-gone',{}, {reason:'crashed'});await setImmediate();
 const failed=await browser.tabs.get(chat.id);
 assert.equal(failed.unavailable,true);
 assert.equal(failed.ready,false);
 assert.equal(failed.url,chat.url);
 assert.equal(browser.state().activeTabId,job.id);
 assert.equal(changes.filter(item=>item.id===chat.id&&item.change.unavailable===true).length,1);
 await assert.rejects(browser.tabs.sendMessage(chat.id,{type:'assistant-read',command:'tick'}),/尚未连接/);
 browser.select(chat.id);
 assert.match(browser.state().error,/请刷新/);
 const loading=browser.reload();
 assert.equal(loading.loading,true);
 assert.equal(loading.tabs.find(tab=>tab.id===chat.id).unavailable,undefined);
 await setImmediate();
 assert.equal(browser.state().ready,true);
 assert.equal(browser.state().activeTabId,chat.id);
 assert.equal(browser.state().error,'');
});

test('批量内置招呼只清理已核实的闲置后台标签，保留当前标签、手动选过的标签和待核对的回执',async t=>{
 const {browser,views}=fixture(),background=backgroundFixture(browser);t.after(()=>browser.close());
 const chat=await browser.tabs.create({url:boss+'/web/geek/chat'});
 const manual=await browser.tabs.create({url:boss+'/job_detail/manual.html'});
 const popupURL=index=>boss+'/web/geek/chat?fixture='+index;
 async function greet(index,{status='sent',pinSource=false,pinReceipt=false,sameTab=false}={}){
  const task={id:'greeting-'+index,kind:'greeting',job:{url:`${boss}/job_detail/greeting-${index}.html`}};
  await background.start(task);
  const source=await browser.tabs.get(background.session.worker.tabId);
  const proof={id:task.id,task,lease:'fixture-lease-'+index};
  assert.equal((await background.message({type:'saveClaim',claimed:proof},source)).ok,true);
  const contents=views.find(view=>view.webContents.id===source.id).webContents;
  let receipt;
  if(sameTab){await browser.tabs.update(source.id,{url:popupURL(index)});await setImmediate();receipt=await browser.tabs.get(source.id);}
  else{
   const child=contents.open({url:popupURL(index),disposition:'foreground-tab'}).createWindow({});await setImmediate();
   receipt=await browser.tabs.get(child.id);
   assert.equal((await background.message({type:'worker'},receipt)).result.tabId,receipt.id);
  }
  assert.equal(browser.state().activeTabId,manual.id);
  if(pinSource){browser.select(source.id);browser.select(manual.id);}
  if(pinReceipt){browser.select(receipt.id);browser.select(manual.id);}
  background.terminal(status);
  assert.equal((await background.message({type:'api',path:'/api/complete',data:{id:task.id,lease:proof.lease,success:status==='sent'}},receipt)).result.executionStatus,status);
  await background.message({type:'workerDone',taskId:'other-task'},receipt);assert.equal(background.session.worker.taskId,task.id);
  await background.message({type:'workerDone',taskId:task.id},receipt);await setImmediate();
  assert.equal(background.session.worker,undefined);
  return {source,receipt};
 }
 const pinned=await greet(1,{pinSource:true,pinReceipt:true});
 const uncertain=await greet(2,{status:'uncertain'});
 const first=await greet(3,{sameTab:true});
 const next=await greet(4);
 await assert.rejects(browser.tabs.get(first.receipt.id),/已经关闭/);
 await assert.rejects(browser.tabs.get(next.source.id),/已经关闭/);
 let last=next;
 for(let index=5;index<=14;index++)last=await greet(index);
 assert.deepEqual(new Set(browser.state().tabs.map(tab=>tab.id)),new Set([chat.id,manual.id,pinned.source.id,pinned.receipt.id,uncertain.source.id,uncertain.receipt.id,last.receipt.id]));
 assert.equal(background.session.chatMonitorTabId,chat.id);
 assert.equal(browser.state().activeTabId,manual.id);
});

test('聊天职位后台读取不切走当前网页，只清理未选中且地址仍匹配的专用读取标签',async t=>{
 const {browser,views}=fixture(),background=backgroundFixture(browser);t.after(()=>browser.close());
 const chat=await browser.tabs.create({url:boss+'/web/geek/chat'});
 const manual=await browser.tabs.create({url:boss+'/job_detail/manual.html'});
 const detailURL=boss+'/job_detail/read.html';
 async function open(index){
  const read={requestId:'read-'+index,lease:'fixture',peerId:'boss:fixture',role:{url:detailURL}};
  assert.equal((await background.message({type:'chatJobOpen',read,url:detailURL},chat)).ok,true);
  await setImmediate();
  const tab=await browser.tabs.get(background.session.chatJob.tabId);
  assert.equal(browser.state().activeTabId,manual.id);
  assert.equal(tab.active,false);
  return {tab,finish:()=>background.message({type:'chatJobDone',requestId:read.requestId},tab)};
 }
 const untouched=await open(1);await untouched.finish();
 await assert.rejects(browser.tabs.get(untouched.tab.id),/已经关闭/);
 const selected=await open(2);browser.select(selected.tab.id);browser.select(manual.id);await selected.finish();
 assert.equal((await browser.tabs.get(selected.tab.id)).url,detailURL);
 const reused=await open(3);await browser.tabs.update(reused.tab.id,{url:manual.url});await setImmediate();await reused.finish();
 assert.equal((await browser.tabs.get(reused.tab.id)).url,manual.url);
 const timedOut=await open(4);background.session.chatJob.at=Date.now()-61000;
 assert.equal((await background.message({type:'chatJobWorker'},timedOut.tab)).result,null);await setImmediate();
 await assert.rejects(browser.tabs.get(timedOut.tab.id),/已经关闭/);
 assert.equal(background.session.chatJob,undefined);
 const timedOutSelected=await open(5);browser.select(timedOutSelected.tab.id);browser.select(manual.id);background.session.chatJob.at=Date.now()-61000;
 await background.message({type:'chatJobWorker'},timedOutSelected.tab);await setImmediate();
 assert.equal((await browser.tabs.get(timedOutSelected.tab.id)).url,detailURL);
 const read={requestId:'popup-read',lease:'fixture',peerId:'boss:fixture',role:{}};
 await background.message({type:'chatJobOpen',read},chat);
 const contents=views.find(view=>view.webContents.id===chat.id).webContents;
 const popup=contents.open({url:detailURL,disposition:'background-tab'}).createWindow({});await setImmediate();
 assert.equal((await background.message({type:'chatJobFind',requestId:read.requestId},chat)).result.pending,true);
 assert.equal(browser.state().activeTabId,manual.id);
 await background.message({type:'chatJobDone',requestId:read.requestId},await browser.tabs.get(popup.id));
 assert.equal((await browser.tabs.get(popup.id)).url,detailURL);
 assert.equal(browser.state().activeTabId,manual.id);
});

test('控制台缩放先换算为 DIP，BOSS 页面可独立缩放且边缘不盖住控件',async t=>{
 const {browser,views}=fixture();t.after(()=>browser.close());
 const state=browser.show({x:0,y:72.5,width:800,height:487.5},1.25);
 assert.deepEqual(views[0].bounds,{x:0,y:91,width:1000,height:609});
 assert.equal(state.zoomMode,'auto');
 assert.equal(state.zoomFactor,.91);
 assert.equal(browser.setZoom('125').zoomFactor,1.25);
 assert.equal(views[0].webContents.zoom,1.25);
 assert.throws(()=>browser.setZoom('300'),/比例无效/);
 browser.show({x:-40,y:100,width:600,height:600});
 assert.deepEqual(views[0].bounds,{x:0,y:100,width:560,height:600});
 assert.equal(browser.state().zoomFactor,1.25);
 assert.equal(browser.setZoom('auto').zoomFactor,.75);
});

test('BOSS 网页缩放按桌面配置保存，关闭后恢复，损坏文件回到自动适配',async t=>{
 const temp=await realpath(tmpdir()),directory=await realpath(await mkdtemp(join(temp,'xiaojing-zoom-fixture-')));
 assert.equal(dirname(directory),temp);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const profile=join(directory,'profile-a'),another=join(directory,'profile-b');
 const zoomFile=join(profile,'embedded-zoom'),bounds={x:0,y:100,width:700,height:600};
 const first=fixture(profile).browser;
 try{
  assert.equal(first.show(bounds).zoomMode,'auto');
  assert.equal(first.setZoom('110').zoomFactor,1.1);
  first.hide();assert.equal(first.show(bounds,1.25).zoomFactor,1.1);
  assert.throws(()=>first.setZoom('300'),/比例无效/);
  assert.equal(await readFile(zoomFile,'utf8'),'110\n');
 }finally{first.close();}

 const reopened=fixture(profile).browser,other=fixture(another).browser;
 try{
  assert.equal(reopened.show(bounds,.9).zoomFactor,1.1);
  assert.equal(other.show(bounds).zoomMode,'auto');
  assert.equal(reopened.setZoom('auto').zoomMode,'auto');
  assert.equal(await readFile(zoomFile,'utf8'),'auto\n');
 }finally{reopened.close();other.close();}

 await writeFile(zoomFile,'garbage');
 const corrupted=fixture(profile).browser;
 try{assert.equal(corrupted.show(bounds).zoomMode,'auto');}finally{corrupted.close();}
 const blocked=join(directory,'blocked');await mkdir(join(blocked,'embedded-zoom'),{recursive:true});
 const failed=fixture(blocked).browser;
 try{
  assert.throws(()=>failed.setZoom('125'),/无法保存/);
  assert.equal(failed.state().zoomMode,'auto');
 }finally{failed.close();}
});

test('页面桥仅接受登记的 BOSS 主框架，页面存储无法读取令牌',async t=>{
 const {browser,views,handlers,messages}=fixture();t.after(()=>browser.close());
 browser.navigate(boss+'/web/geek/chat');await setImmediate();
 const sender=views[0].webContents,handle=handlers.get('xiaojing:boss-content');
 const message={type:'api',path:'/api/browser-state'};
 await assert.rejects(handle({sender,senderFrame:{...sender.mainFrame,routingId:999}},{kind:'message',value:message}),/请求不可用/);
 await assert.rejects(handle({sender,senderFrame:{...sender.mainFrame,url:'https://login.zhipin.com/'}},{kind:'message',value:message}),/请求不可用/);
 const event={sender,senderFrame:sender.mainFrame};
 await assert.rejects(handle(event,{kind:'storage:get',value:'token'}),/存储键不可用/);
 const inbox={version:1,threads:Array.from({length:400},(_,index)=>[`boss:fixture-${index}`,{
  sidebar:{preview:'合'.repeat(450),time:'12:34'},handled:Array.from({length:16},(_,number)=>`simulated-message-${index}-${number}`)
 }]),events:[]};
 assert(Buffer.byteLength(JSON.stringify(inbox))>700000);
 await handle(event,{kind:'storage:set',value:{'boss-realtime-v1':inbox}});
 assert.deepEqual((await handle(event,{kind:'storage:get',value:'boss-realtime-v1'}))['boss-realtime-v1'],inbox);
 await assert.rejects(handle(event,{kind:'message',value:{...message,extra:'x'.repeat(700001)}}),/请求不可用/);
 assert.deepEqual(await handle(event,{kind:'message',value:message}),{ok:true});
 assert.equal(messages[0].sender.id,bossRuntimeId);
 assert.equal(messages[0].sender.tab.id,sender.id);
 assert.equal(messages[0].sender.url,boss+'/web/geek/chat');
});

test('预加载脚本仅在 BOSS 主文档隔离世界公开固定 IPC 方法',async()=>{
 const code=await readFile(new URL('../desktop/boss-preload.cjs',import.meta.url),'utf8');
 for(const [isMainFrame,origin,count] of [[true,boss,1],[false,boss,0],[true,'https://login.zhipin.com',0]]){
  const calls=[],ipc=[];
  runInNewContext(code,{process:{isMainFrame},location:{origin},require:()=>({
   contextBridge:{exposeInIsolatedWorld:(...args)=>calls.push(args),exposeInMainWorld:()=>assert.fail('主世界不得接触 IPC')},
   ipcRenderer:{invoke:(channel,value)=>ipc.push({channel,value})}
  })});
  assert.equal(calls.length,count);
  if(!count)continue;
  const [[world,key,bridge]]=calls;assert.equal(world,1104);assert.equal(key,'xiaojingBossTransport');
  assert.deepEqual(Object.keys(bridge),['send','get','set']);
  bridge.send({type:'chatMonitor'});
  assert.equal(ipc[0].channel,'xiaojing:boss-content');assert.equal(ipc[0].value.kind,'message');
 }
});
