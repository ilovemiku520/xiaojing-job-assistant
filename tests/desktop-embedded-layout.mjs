import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import {testPort} from './port.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const output=resolve(process.argv[3]||join(root,'work','embedded-viewport'));
const exe=process.argv[2]||join(root,'tools','cache','electron','runtime','electron.exe');
const temp=realpathSync(tmpdir());
const profile=realpathSync(mkdtempSync(join(temp,'xiaojing-viewport-')));
assert.equal(dirname(profile),temp);
const port=await testPort(),chat='https://www.zhipin.com/web/geek/chat';
const otherJob='https://www.zhipin.com/job_detail/settings-focus-fixture.html';
const html=readFileSync(new URL('./fixtures/desktop-embedded-chat.html',import.meta.url),'utf8').replace('</style>',`
  body{height:calc(100vh - 36px);overflow:hidden}
  main{height:100%;grid-template-columns:minmax(125px,24%) minmax(0,1fr)}
  .chat-conversation{display:flex;flex-direction:column;min-height:0}
  .chat-record{flex:1;min-height:0;overflow:auto}
  .chat-record::after{content:"";display:block;height:100vh}
</style>`);
const screenshots=[];
let app;

async function eventually(check,label){
 for(let attempt=0;attempt<100;attempt++){
  const value=await check();if(value)return value;
  await setTimeout(80);
 }
 throw Error(label);
}

async function launch(){
 app=await electron.launch({executablePath:exe,args:process.argv[2]?[]:[resolve(root)],env:{...process.env,XIAOJING_DESKTOP_HOME:profile,XIAOJING_DESKTOP_PORT:String(port)}});
 const window=await app.firstWindow();
 const browserMenu=window.locator('#main-nav [data-panel="browser-setup"]');
 await browserMenu.waitFor();
 await app.evaluate(({session,BrowserWindow},{chat,otherJob,html})=>{
  const boss=session.fromPartition('persist:xiaojing-boss');
  boss.protocol.handle('https',request=>{
   const allowed=request.url===chat||request.url===otherJob;
   return new Response(allowed?html:'',{status:allowed?200:403,headers:{'Content-Type':'text/html; charset=utf-8'}});
  });
  boss.protocol.handle('http',()=>new Response('',{status:403}));
  BrowserWindow.getAllWindows()[0].setMinimumSize(390,450);
 },{chat,otherJob,html});
 return {window,browserMenu};
}

async function openBrowser(window,browserMenu){
 if(browserMenu)await browserMenu.click();
 await window.getByRole('button',{name:'打开内置浏览器',exact:true}).click();
 await eventually(async()=> (await window.evaluate(()=>window.xiaojingDesktop.embedded('state')))?.ready,'Synthetic BOSS view never connected');
}

try{
 mkdirSync(output,{recursive:true});
 let {window,browserMenu}=await launch();
 const drawer=()=>window.locator('#desktop-settings-drawer');
 const globalSettings=()=>window.locator('#desktop-settings-toggle');
 const browserSettings=()=>window.locator('#embedded-settings-toggle');
 const settingsClose=()=>window.locator('#desktop-settings-close');
 const category=()=>window.locator('#desktop-settings-nav [data-panel="browser-settings"]');
 const drawerHasFocus=()=>drawer().evaluate(node=>node.contains(document.activeElement));
 async function settingsExpanded(toggle,expanded){
  await drawer().waitFor({state:expanded?'visible':'hidden'});
  assert.equal(await toggle.getAttribute('aria-expanded'),String(expanded));
  if(expanded)await eventually(drawerHasFocus,'Opening settings did not focus its controls');
 }
 async function focused(locator){
  await eventually(()=>locator.evaluate(node=>node===document.activeElement),'Settings focus was not restored');
 }
 await globalSettings().focus();
 await window.keyboard.press('Control+,');
 await settingsExpanded(globalSettings(),true);
 await category().waitFor();
 await window.locator('#heading').focus();
 assert.equal(await drawerHasFocus(),false);
 await window.keyboard.press('Control+,');
 await eventually(drawerHasFocus,'Ctrl+, did not return focus to already-open settings');
 await window.keyboard.press('Escape');
 await settingsExpanded(globalSettings(),false);
 await focused(globalSettings());
 await openBrowser(window,browserMenu);

 async function verify(label,drawerDock){
  const match=await eventually(async()=>{
   const shell=await window.evaluate(()=>{
    const rect=id=>{const {x,y,width,height,bottom}=document.getElementById(id).getBoundingClientRect();return {x,y,width,height,bottom};};
    window.scrollTo(0,500);
    const controlsBottom=Math.max(...[...document.querySelectorAll('.embedded-toolbar,.embedded-tabbar')].map(node=>node.getBoundingClientRect().bottom));
    return {view:rect('embedded-surface'),drawer:rect('desktop-settings-drawer'),controlsBottom,viewport:{width:innerWidth,height:innerHeight},scrollY,scrollHeight:document.documentElement.scrollHeight,scrollWidth:document.documentElement.scrollWidth};
   });
   const native=await app.evaluate(async({BrowserWindow},chat)=>{
    const window=BrowserWindow.getAllWindows()[0],view=window.contentView.children.find(child=>child.webContents?.getURL()===chat);
    if(!view)return null;
    return {id:view.webContents.id,visible:view.getVisible(),bounds:view.getBounds(),size:window.getContentSize(),consoleZoom:window.webContents.getZoomFactor(),pageZoom:view.webContents.getZoomFactor(),page:await view.webContents.executeJavaScript(`(()=>{
      const scroller=document.querySelector('.chat-record');scroller.scrollTop=100;
      const insideScroll=scroller.scrollTop;scroller.scrollTop=0;
      return {width:innerWidth,height:innerHeight,insideScroll};
    })()`) };
   },chat);
   if(!native?.visible)return null;
   const {view,controlsBottom,viewport}=shell,{bounds,size,consoleZoom,pageZoom,page}=native;
   if(Math.abs(bounds.x-view.x*consoleZoom)>1||Math.abs(bounds.y-view.y*consoleZoom)>1||Math.abs(bounds.width-view.width*consoleZoom)>2||Math.abs(bounds.height-view.height*consoleZoom)>2)return null;
   if(Math.abs(page.width*pageZoom-bounds.width)>3||Math.abs(page.height*pageZoom-bounds.height)>3)return null;
   assert.equal(shell.scrollY,0);
   assert(shell.scrollHeight<=viewport.height+1);
   assert(shell.scrollWidth<=viewport.width+1);
   assert(bounds.y+1>=controlsBottom*consoleZoom,'Native view must not overlap toolbar or tabs');
   if(drawerDock){
    assert(shell.drawer.width>0&&shell.drawer.height>0,'Settings drawer must have its own layout space');
    if(drawerDock==='right'){
     assert(bounds.x+bounds.width<=shell.drawer.x*consoleZoom+1,'Native BOSS must stay to the left of the settings drawer');
     assert(bounds.width>=size[0]*.55,'Desktop drawer leaves the majority of the window for BOSS');
    }else{
     assert(shell.drawer.bottom*consoleZoom<=bounds.y+1,'Native BOSS must stay below the settings drawer');
     assert(bounds.width>=size[0]-2,'Narrow drawer keeps the full BOSS width');
    }
   }else{
    assert(bounds.width>=size[0]-2,'Native view should fill the full available window width');
    assert(bounds.height>=size[1]*.68,'Toolbar should not consume the majority of the height');
   }
   assert(bounds.y+bounds.height>=size[1]-2,'Native view should reach window bottom');
   assert(bounds.height>=size[1]*.25,'Settings must leave a usable visible BOSS viewport');
   assert(page.insideScroll>0,'Site keeps its own scroll container');
   return {label,...native};
  },'Native browser bounds did not match the viewport '+label);
  const images=await app.evaluate(async({BrowserWindow},chat)=>{
   const owner=BrowserWindow.getAllWindows()[0];
   const view=owner.contentView.children.find(child=>child.webContents?.getURL()===chat);
   const [chrome,boss]=await Promise.all([owner.webContents.capturePage(),view.webContents.capturePage()]);
   return {chrome:chrome.toPNG().toString('base64'),boss:boss.toPNG().toString('base64')};
  },chat);
  const ownerPath=join(output,label+'-chrome.png'),bossPath=join(output,label+'-boss.png');
  writeFileSync(ownerPath,Buffer.from(images.chrome,'base64'));writeFileSync(bossPath,Buffer.from(images.boss,'base64'));
  screenshots.push({...match,ownerPath,bossPath});
  return match;
 }

 for(const [width,height] of [[1440,900],[768,610],[390,620]]){
  await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),[width,height]);
  const view=await verify(`${width}x${height}`);
  assert.equal(view.pageZoom,width>=1100?1:.75);
 }
 const activeBrowser=()=>window.evaluate(async()=>{
  const {activeTabId,url,visible}=await window.xiaojingDesktop.embedded('state');
  return {activeTabId,url,visible};
 });
 const original=await activeBrowser();
 assert.equal(original.url,chat);assert.equal(original.visible,true);
 const actualFocus=()=>app.evaluate(({webContents})=>webContents.getFocusedWebContents()?.id);
 const nativeKeys=()=>app.evaluate(async({webContents},id)=>webContents.fromId(id).executeJavaScript('window.settingsFixtureKeys'),original.activeTabId);
 const sendKey=(id,key,modifiers=[])=>app.evaluate(({webContents},{id,key,modifiers})=>{
  const contents=webContents.fromId(id);
  contents.sendInputEvent({type:'keyDown',keyCode:key,modifiers});
  contents.sendInputEvent({type:'keyUp',keyCode:key,modifiers});
 },{id,key,modifiers});
 const ownerId=await app.evaluate(async({BrowserWindow,webContents},id)=>{
  const owner=BrowserWindow.getAllWindows()[0],contents=webContents.fromId(id);
  owner.focus();contents.focus();
  await contents.executeJavaScript(`(()=>{
   const editor=document.querySelector('[contenteditable="true"]');editor.focus();
   editor.textContent='synthetic text';getSelection().setBaseAndExtent(editor.firstChild,1,editor.firstChild,4);
   window.settingsFixtureKeys=[];document.addEventListener('keydown',event=>{if(event.isTrusted)settingsFixtureKeys.push(event.key);});
  })()`);
  return owner.webContents.id;
 },original.activeTabId);
 await eventually(async()=>await actualFocus()===original.activeTabId,'Synthetic BOSS renderer did not gain actual keyboard focus');
 await sendKey(original.activeTabId,',',['control']);
 await settingsExpanded(browserSettings(),true);
 await eventually(async()=>await actualFocus()===ownerId,'Native shortcut did not transfer actual keyboard focus to the console');
 assert.deepEqual(await activeBrowser(),original);
 await app.evaluate(({webContents},id)=>webContents.fromId(id).focus(),original.activeTabId);
 await sendKey(original.activeTabId,'Escape');
 await eventually(async()=>(await nativeKeys()).includes('Escape'),'Native Escape did not reach the BOSS editor');
 assert.equal(await drawer().isVisible(),true,'BOSS Escape must leave shell settings open');
 await sendKey(original.activeTabId,',',['control']);
 await eventually(async()=>await actualFocus()===ownerId&&await drawerHasFocus(),'Shortcut did not refocus settings while already open');
 await sendKey(ownerId,'Escape');
 await settingsExpanded(browserSettings(),false);
 await eventually(async()=>await actualFocus()===original.activeTabId,'Closing settings did not restore the BOSS renderer focus');
 const editor=await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript(`(()=>{
  const selection=getSelection();return {text:document.activeElement.textContent,start:selection.anchorOffset,end:selection.focusOffset};
 })()`),original.activeTabId);
 assert.deepEqual(editor,{text:'synthetic text',start:1,end:4});
 assert.equal((await nativeKeys()).includes(','),false,'BOSS must not also receive the handled shortcut');
 await sendKey(original.activeTabId,',',['control']);
 await settingsExpanded(browserSettings(),true);
 const alternate=await window.evaluate(url=>{
  const {x,y,width,height}=document.querySelector('#embedded-surface').getBoundingClientRect();
  return window.xiaojingDesktop.embedded('open-job',{url,bounds:{x,y,width,height}});
 },otherJob);
 assert.notEqual(alternate.activeTabId,original.activeTabId);
 await sendKey(ownerId,'Escape');
 await settingsExpanded(browserSettings(),false);
 await focused(browserSettings());
 assert.equal((await activeBrowser()).activeTabId,alternate.activeTabId,'Focus restoration must not reselect an old tab');
 assert.equal(await actualFocus(),ownerId,'Unavailable native opener should leave focus in the console');
 await window.evaluate(id=>window.xiaojingDesktop.embedded('close-tab',id),alternate.activeTabId);
 assert.deepEqual(await activeBrowser(),original);
 await app.evaluate(({webContents},id)=>webContents.fromId(id).executeJavaScript('document.querySelector(\'[contenteditable="true"]\').textContent=""'),original.activeTabId);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 const beforeSettings=await verify('1440x900-settings-closed');
 await browserSettings().click();
 await settingsExpanded(browserSettings(),true);
 assert.equal((await verify('1440x900-settings-right','right')).id,beforeSettings.id);
 await drawer().locator('#desktop-settings-nav [data-panel="settings"]').click();
 await drawer().locator('#settings-form').waitFor();
 assert.equal(await window.locator('body').getAttribute('data-view'),'browser-setup');
 assert.deepEqual(await activeBrowser(),original);
 await category().click();
 await window.keyboard.press('Escape');
 await settingsExpanded(browserSettings(),false);
 await focused(browserSettings());
 assert.equal((await verify('1440x900-settings-restored')).id,beforeSettings.id);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(390,620));
 await browserSettings().press('Enter');
 await settingsExpanded(browserSettings(),true);
 assert.equal((await verify('390x620-settings-top','top')).id,beforeSettings.id);
 assert.deepEqual(await activeBrowser(),original);
 await settingsClose().click();
 await settingsExpanded(browserSettings(),false);
 await focused(browserSettings());
 assert.equal((await verify('390x620-settings-restored')).id,beforeSettings.id);
 const workspace=await window.locator('#embedded-workspace').evaluate(node=>node.outerHTML);
 const css=['style.css','desktop.css'].map(file=>readFileSync(join(root,'public',file),'utf8')).join('\n');
 const escaped=html.replaceAll('&','&amp;').replaceAll('"','&quot;');
 const snapshot=workspace.replace(/<div id="embedded-surface"[^>]*>/,surface=>`${surface}<iframe title="模拟 BOSS 聊天" srcdoc="${escaped}"></iframe>`);
 writeFileSync(join(output,'fixture.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>小鲸 · BOSS</title><style>${css}\n.embedded-surface iframe{display:block;width:100%;height:100%;border:0}</style><body class="desktop-shell desktop-embedded-open" data-view="browser-setup"><main><section id="browser-setup">${snapshot}</section></main></body></html>`);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].maximize());
 await eventually(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isMaximized()),'Fixture window did not maximize');
 await verify('maximized');
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].unmaximize());
 await eventually(()=>app.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isMaximized()),'Fixture window did not restore');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(990,680);w.webContents.setZoomFactor(1.25);});
 await window.getByRole('combobox',{name:'BOSS 网页缩放'}).selectOption('110');
 const zoomed=await verify('990x680-console125-page110');
 assert.equal(zoomed.consoleZoom,1.25);assert(Math.abs(zoomed.pageZoom-1.1)<.001);
 await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(1440,900));
 await browserSettings().focus();
 await window.keyboard.press('Control+,');
 await settingsExpanded(browserSettings(),true);
 const zoomedDrawer=await verify('1440x900-console125-settings-right','right');
 assert.equal(zoomedDrawer.id,beforeSettings.id);
 assert.equal(zoomedDrawer.consoleZoom,1.25);assert(Math.abs(zoomedDrawer.pageZoom-1.1)<.001);
 await window.keyboard.press('Escape');
 await settingsExpanded(browserSettings(),false);
 await window.getByRole('button',{name:'收起浏览器',exact:true}).click();
 assert.equal((await window.evaluate(()=>window.xiaojingDesktop.embedded('state'))).visible,false);
 await browserMenu.waitFor();
 await openBrowser(window);
 assert.equal(await window.getByRole('combobox',{name:'BOSS 网页缩放'}).inputValue(),'110');
 assert(Math.abs((await window.evaluate(()=>window.xiaojingDesktop.embedded('state'))).zoomFactor-1.1)<.001);

 await app.close();app=null;
 ({window,browserMenu}=await launch());
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(990,680);w.webContents.setZoomFactor(.9);});
 await openBrowser(window,browserMenu);
 assert.equal(await window.getByRole('combobox',{name:'BOSS 网页缩放'}).inputValue(),'110');
 const restored=await verify('restart-console90-page110');
 assert(Math.abs(restored.consoleZoom-.9)<.001);assert(Math.abs(restored.pageZoom-1.1)<.001);
 writeFileSync(join(output,'results.json'),JSON.stringify(screenshots,null,2));
 console.log(JSON.stringify(screenshots.map(({label,bounds,size,consoleZoom,pageZoom})=>({label,bounds,size,consoleZoom,pageZoom}))));
}finally{
 if(app)await app.close();
 rmSync(profile,{recursive:true,force:true});
}
