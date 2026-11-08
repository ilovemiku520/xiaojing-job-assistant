import {mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
export const bossPartition='persist:xiaojing-boss';
export const bossRuntimeId='xiaojing-embedded';
const world=1104,ipc='xiaojing:boss-content',origin='https://www.zhipin.com',defaultURL=origin+'/web/geek/chat';
const preload=fileURLToPath(new URL('./boss-preload.cjs',import.meta.url));
const storageKey='boss-realtime-v1',maxTabs=20,maxPayload=700000;
const maxInboxStorageBytes=2000000;
const viewDefault={x:0,y:0,width:1100,height:720};
const pageZooms=new Set(['auto','75','90','100','110','125']);
const contentFiles=['realtime.js','resume-ui.js','favorites.js','content.js'];
const allowedRead=new Set(['tick','favorites-scan','scan-jobs','inspect','monitor-destination']);

export function bossNavigation(value){
  try{
    if(typeof value!=='string'||value.length>4096)return '';
    const u=new URL(value);
    return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&(u.hostname==='zhipin.com'||u.hostname.endsWith('.zhipin.com'))?u.href:'';
  }catch{return '';}
}

const isBridgePage=url=>bossNavigation(url)&&new URL(url).origin===origin;
function eventSource(){
  const listeners=new Set();
  return {addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener),emit:(...args)=>{
    for(const listener of listeners)Promise.resolve().then(()=>listener(...args)).catch(()=>{});
  },clear:()=>listeners.clear()};
}

function contentStore(local){
  const file=local&&join(local,'embedded-realtime.json');
  let value;
  if(file)try{value=JSON.parse(readFileSync(file,'utf8'));}catch{}
  return {
    get(key){if(key!==storageKey)throw Error('页面存储键不可用');return value?{[storageKey]:value}:{};},
    set(input){
      if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,storageKey))throw Error('页面存储键不可用');
      const next=input[storageKey],serialized=JSON.stringify(next);
      if(next?.version!==1||!serialized||Buffer.byteLength(serialized)>maxInboxStorageBytes)throw Error('页面存储内容无效');
      if(file){mkdirSync(local,{recursive:true,mode:0o700});writeFileSync(file+'.tmp',serialized,{mode:0o600});renameSync(file+'.tmp',file);}
      value=next;
    }
  };
}

function storedZoom(file){
  if(file)try{
    const value=readFileSync(file,'utf8').trim();
    if(pageZooms.has(value))return value;
  }catch{}
  return 'auto';
}

function clampBounds(bounds,size,scale){
  if(!bounds||!['x','y','width','height'].every(key=>Number.isFinite(bounds[key]))||!Number.isFinite(scale)||scale<=0)return null;
  // Console CSS pixels are smaller/larger than Electron DIPs at non-100% zoom.
  // Round inward so a one-pixel edge cannot cover the controls above the view.
  const [w,h]=size,x=Math.max(0,Math.ceil(bounds.x*scale)),y=Math.max(0,Math.ceil(bounds.y*scale));
  const width=Math.min(w,Math.floor((bounds.x+bounds.width)*scale))-x;
  const height=Math.min(h,Math.floor((bounds.y+bounds.height)*scale))-y;
  return width>=1&&height>=1?{x,y,width,height}:null;
}

export function createEmbeddedBrowser({window,extensionDir,local,onChange=()=>{},onMessage,onSettingsShortcut=()=>false},electron=require('electron')){
  const {WebContentsView,session,ipcMain}=electron;
  const ses=session.fromPartition(bossPartition);
  const options={session:ses,preload,contextIsolation:true,sandbox:true,nodeIntegration:false,nodeIntegrationInSubFrames:false,webSecurity:true,backgroundThrottling:false,webviewTag:false,devTools:false};
  const storage=contentStore(local),records=new Map(),activated=eventSource(),updated=eventSource(),removed=eventSource();
  const shim=readFileSync(new URL('./boss-content-shim.js',import.meta.url),'utf8').trim();
  const content=contentFiles.map(name=>readFileSync(join(extensionDir,name),'utf8')).join('\n;\n');
  const isolated=`(()=>{if(location.origin!==${JSON.stringify(origin)}||!globalThis.xiaojingBossTransport)return false;\nif(globalThis.xiaojingBossDeliver)return true;\nconst chrome=${shim}(globalThis.xiaojingBossTransport);\n${content}\nreturn true;})()`;
  const mainWorld=`(()=>{if(location.origin!==${JSON.stringify(origin)}||globalThis.__xiaojingPositionLink)return;globalThis.__xiaojingPositionLink=true;\n${readFileSync(join(extensionDir,'position-link.js'),'utf8')}\n})()`;
  const zoomFile=local&&join(local,'embedded-zoom');
  let activeId=null,visible=false,requestedBounds,consoleZoom=1,zoomMode=storedZoom(zoomFile),closed=false,pendingConsoleFocus;

  const descriptor=tab=>({id:tab.id,url:tab.url,title:tab.title,status:tab.status,active:tab.id===activeId,ready:tab.ready,...(tab.openerTabId?{openerTabId:tab.openerTabId}:{}),...(tab.automation?{automation:tab.automation}:{}),...(tab.unavailable?{unavailable:true}:{})});
  function state(){
    const current=records.get(activeId),history=current?.contents.navigationHistory;
    return {visible,activeTabId:activeId,url:current?.url||'',title:current?.title||'',loading:current?.status==='loading',ready:current?.ready===true,error:current?.error||'',zoomMode,zoomFactor:current?.zoomFactor??1,
      canGoBack:history?.canGoBack()===true,canGoForward:history?.canGoForward()===true,tabs:[...records.values()].map(descriptor)};
  }
  function changed(){if(!closed)onChange(state());}
  function visibleTab(tab){
    return visible&&tab?.id===activeId&&!tab.unavailable&&!tab.contents.isDestroyed()&&tab.view.getVisible();
  }
  function activeVisibleTab(tab){
    return visibleTab(tab)&&!!bossNavigation(tab.contents.getURL());
  }
  function attachedBossTab(tab){
    if(!visibleTab(tab))return false;
    const url=tab.contents.getURL();
    return !!bossNavigation(url)||((url===''||url==='about:blank')&&!!bossNavigation(tab.url));
  }
  function cancelConsoleFocus(tab){
    if(pendingConsoleFocus?.tab===tab)pendingConsoleFocus=undefined;
  }
  function layout(){
    const bounds=visible?clampBounds(requestedBounds,window.getContentSize(),consoleZoom):null;
    for(const tab of records.values()){
      const show=visible&&tab.id===activeId&&bounds;
      if(show){
        tab.view.setBounds(bounds);
        const factor=zoomMode==='auto'?Math.max(.75,Math.min(1,Math.round(bounds.width/viewDefault.width*100)/100)):Number(zoomMode)/100;
        if(Math.abs(tab.contents.getZoomFactor()-factor)>.001)tab.contents.setZoomFactor(factor);
        tab.zoomFactor=factor;
      }
      tab.view.setVisible(!!show);
    }
  }
  function activate(tab,{focus=false,keep=false}={}){
    if(keep)tab.automation=null;
    if(activeId!==tab.id||focus)pendingConsoleFocus=undefined;
    if(focus)tab.initialFocusPending=false;
    const was=activeId;activeId=tab.id;layout();
    if(focus&&visible)tab.contents.focus();
    if(was!==tab.id)activated.emit({tabId:tab.id,windowId:window.id});
    changed();return descriptor(tab);
  }
  function get(id){
    const tab=records.get(id);
    if(!tab||tab.contents.isDestroyed())throw Error('BOSS 标签页已经关闭');
    return tab;
  }
  function requireURL(url){const target=bossNavigation(url);if(!target)throw Error('内置浏览器仅支持 BOSS 直聘页面');return target;}

  function forget(tab,closeContents){
    if(!records.delete(tab.id))return;
    cancelConsoleFocus(tab);
    if(!window.isDestroyed())window.contentView.removeChildView(tab.view);
    if(closeContents&&!tab.contents.isDestroyed())tab.contents.close({waitForBeforeUnload:false});
    if(activeId===tab.id){
      const replacement=records.get(tab.openerTabId)||[...records.values()].at(-1);
      activeId=null;if(replacement)activate(replacement,{keep:true});
    }
    if(!closed)removed.emit(tab.id,{windowId:window.id,isWindowClosing:false});
    changed();
  }

  async function installContent(tab){
    const navigation=tab.navigation;
    if(tab.unavailable||tab.installation===navigation)return;
    tab.installation=navigation;
    const url=tab.contents.getURL();
    if(!bossNavigation(url)&&url!=='about:blank')return;
    tab.url=url;
    try{
      if(isBridgePage(url)){
        await tab.contents.executeJavaScript(mainWorld);
        if(!records.has(tab.id)||tab.navigation!==navigation)return;
        const ready=await tab.contents.executeJavaScriptInIsolatedWorld(world,[{code:isolated,url:'xiaojing-boss-adapter.js'}]);
        if(!records.has(tab.id)||tab.navigation!==navigation)return;
        if(ready!==true)throw Error('页面组件不可用');
        tab.ready=true;
      }
      if(!records.has(tab.id)||tab.navigation!==navigation)return;
      tab.status='complete';tab.error='';
      if(tab.id===activeId)layout();
      updated.emit(tab.id,{status:'complete'},descriptor(tab));
    }catch{
      if(!records.has(tab.id)||tab.navigation!==navigation)return;
      tab.status='complete';tab.error='BOSS 页面连接组件未加载，可手动刷新';
    }
    changed();
  }

  function load(tab,url){
    tab.url=requireURL(url);tab.status='loading';tab.ready=false;tab.unavailable=false;tab.error='';
    changed();
    // Chrome's tabs.create/update resolve while the page is loading; worker
    // leases must be saved before the content script starts processing it.
    void tab.contents.loadURL(tab.url).catch(error=>{
      if(!records.has(tab.id)||tab.unavailable||error.code==='ERR_ABORTED')return;
      tab.status='complete';tab.error='暂时无法打开 BOSS 页面';changed();
    });
  }

  function create({url,active=true,openerTabId,adopt,automation=null}={}){
    if(closed||records.size>=maxTabs)throw Error('内置 BOSS 标签页数量已达上限');
    if(!adopt&&url!==undefined)requireURL(url);
    const view=new WebContentsView(adopt?{webContents:adopt}:{webPreferences:options});
    const contents=view.webContents,id=contents.id;
    const tab={id,view,contents,openerTabId,automation:!active&&activeId?automation:null,url:url||'about:blank',title:'',status:'loading',ready:false,error:'',navigation:0,zoomFactor:1,initialFocusPending:true};
    contents.setZoomMode('isolated');
    contents.once('focus',()=>{
      tab.initialFocusPending=false;
      const request=pendingConsoleFocus;
      if(request?.tab!==tab)return;
      // Windows can focus a newly attached view after the console has already
      // requested focus. Yield once so real site input can cancel that request.
      setImmediate(()=>{
        if(pendingConsoleFocus!==request)return;
        cancelConsoleFocus(tab);
        if(attachedBossTab(tab)&&contents.isFocused())request.restore();
      });
    });
    contents.on('before-mouse-event',(_event,input)=>{
      if(input.type==='mouseDown'||input.type==='mouseWheel')cancelConsoleFocus(tab);
    });
    contents.on('before-input-event',(event,input)=>{
      if(input.type==='keyDown')cancelConsoleFocus(tab);
      if(input.type!=='keyDown'||input.key!==','||!input.control||input.alt||input.shift||input.meta||input.isAutoRepeat||
          !activeVisibleTab(tab)||!contents.isFocused())return;
      if(onSettingsShortcut(tab.id))event.preventDefault();
    });
    records.set(id,tab);view.setVisible(false);view.setBounds(viewDefault);window.contentView.addChildView(view);
    contents.setWindowOpenHandler(details=>{
      const target=bossNavigation(details.url);
      if((!target&&details.url!=='about:blank')||records.size>=maxTabs||closed)return {action:'deny'};
      const greetingPopup=tab.automation==='greeting'&&activeId!==id&&!tab.openerTabId&&(details.url==='about:blank'||target&&new URL(target).pathname==='/web/geek/chat');
      return {action:'allow',outlivesOpener:true,overrideBrowserWindowOptions:{webPreferences:options},createWindow:childOptions=>{
        const child=create({active:!greetingPopup&&details.disposition!=='background-tab',openerTabId:id,adopt:childOptions.webContents,automation:greetingPopup?'greeting':null});
        if(!childOptions.webContents&&target)load(child,target);
        return child.contents;
      }};
    });
    contents.on('will-attach-webview',event=>event.preventDefault());
    function blockNavigation(details){
      details.preventDefault();
      tab.status='complete';tab.error='内置浏览器已阻止离开 BOSS 直聘';
      changed();
    }
    contents.on('will-navigate',(details,legacyUrl)=>{if(!bossNavigation(details.url??legacyUrl))blockNavigation(details);});
    contents.on('will-redirect',(details,legacyUrl,_sameDocument,legacyMainFrame)=>{if((details.isMainFrame??legacyMainFrame)&&!bossNavigation(details.url??legacyUrl))blockNavigation(details);});
    contents.on('did-start-navigation',details=>{
      if(!details.isMainFrame||details.isSameDocument)return;
      if(tab.navigation){tab.initialFocusPending=false;cancelConsoleFocus(tab);}
      tab.navigation++;tab.ready=false;tab.unavailable=false;tab.status='loading';tab.error='';
      if(bossNavigation(details.url)||details.url==='about:blank')tab.url=details.url;
      changed();
    });
    contents.on('dom-ready',()=>{void installContent(tab);});
    contents.on('did-stop-loading',()=>{
      if(tab.initialFocusPending){tab.initialFocusPending=false;cancelConsoleFocus(tab);}
      void installContent(tab);
    });
    contents.on('did-navigate-in-page',(_event,next,isMainFrame)=>{
      if(!isMainFrame||!bossNavigation(next))return;
      tab.url=next;
      if(tab.ready)updated.emit(id,{status:'complete'},descriptor(tab));
      changed();
    });
    contents.on('page-title-updated',(_event,title)=>{tab.title=String(title).slice(0,180);changed();});
    contents.on('render-process-gone',()=>{
      if(!records.has(id)||tab.unavailable)return;
      tab.initialFocusPending=false;cancelConsoleFocus(tab);
      tab.navigation++;tab.ready=false;tab.unavailable=true;tab.status='complete';tab.error='BOSS 页面已退出，请刷新';
      updated.emit(id,{unavailable:true},descriptor(tab));changed();
    });
    contents.once('destroyed',()=>forget(tab,false));
    if(active||!activeId)activate(tab);else changed();
    if(url&&!adopt)load(tab,url);
    return tab;
  }

  const tabs={
    onActivated:activated,onUpdated:updated,onRemoved:removed,
    async query(query={}){
      return [...records.values()].filter(tab=>{
        if(query.active!==undefined&&query.active!==(tab.id===activeId))return false;
        if(query.url==='https://www.zhipin.com/*')return isBridgePage(tab.url);
        return !query.url||query.url===tab.url;
      }).map(descriptor);
    },
    async create({url,active}={}){return descriptor(create({url,active}));},
    async createAutomation({url,kind}){
      if(!['greeting','chat-job'].includes(kind))throw Error('后台标签任务类型无效');
      return descriptor(create({url,active:false,automation:kind}));
    },
    async removeAutomation(id,{kind,url,openerTabId}={}){
      const tab=records.get(id);
      if(!tab||!tab.automation||tab.automation!==kind||tab.id===activeId||tab.openerTabId!==openerTabId||tab.unavailable||tab.status!=='complete'||tab.url!==url||tab.contents.getURL()!==url)return false;
      forget(tab,true);return true;
    },
    async get(id){return descriptor(get(id));},
    async update(id,input){
      const tab=get(id);
      if(input.url!==undefined)load(tab,input.url);
      if(input.active===true)activate(tab,{keep:true});
      return descriptor(tab);
    },
    async reload(id){get(id).contents.reload();},
    async goBack(id){const history=get(id).contents.navigationHistory;if(history.canGoBack())history.goBack();},
    async remove(id){forget(get(id),true);},
    async sendMessage(id,message){
      const tab=get(id);
      if(!tab.ready||!isBridgePage(tab.contents.getURL()))throw Error('BOSS 页面组件尚未连接');
      if(message?.type!=='assistant-read'||!allowedRead.has(message.command))throw Error('浏览器页面请求不可用');
      const input={type:'assistant-read',command:message.command,allowNavigate:message.allowNavigate===true};
      return tab.contents.executeJavaScriptInIsolatedWorld(world,[{code:`globalThis.xiaojingBossDeliver(${JSON.stringify(input)})`}]);
    }
  };

  ses.setPermissionCheckHandler(()=>false);
  ses.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
  const blockDownload=event=>event.preventDefault();
  ses.on('will-download',blockDownload);
  ipcMain.handle(ipc,async(event,request)=>{
    const tab=records.get(event.sender.id),frame=event.senderFrame,main=tab?.contents.mainFrame;
    if(closed||!tab||event.sender!==tab.contents||!frame||!main||frame.processId!==main.processId||frame.routingId!==main.routingId||!isBridgePage(frame.url))throw Error('页面连接请求不可用');
    if(request?.kind==='storage:get')return storage.get(request.value);
    if(request?.kind==='storage:set')return storage.set(request.value);
    const message=request?.value;
    if(request?.kind!=='message'||!message||typeof message!=='object'||Array.isArray(message)||Buffer.byteLength(JSON.stringify(message))>maxPayload)throw Error('页面连接请求不可用');
    return onMessage?.(message,{id:bossRuntimeId,url:frame.url,tab:descriptor(tab)});
  });

  function close(){
    if(closed)return;
    closed=true;visible=false;
    ipcMain.removeHandler(ipc);ses.removeListener('will-download',blockDownload);window.removeListener('resize',resize);
    activated.clear();updated.clear();removed.clear();
    for(const tab of [...records.values()])forget(tab,true);
  }
  function resize(){if(visible){layout();changed();}}
  window.on('resize',resize);
  window.once('closed',close);

  return {
    tabs,state,close,
    show(rect,scale=1){
      requestedBounds=rect;consoleZoom=scale;visible=!!clampBounds(rect,window.getContentSize(),consoleZoom);
      if(visible&&!activeId)create({url:defaultURL});
      layout();changed();return state();
    },
    hide(){pendingConsoleFocus=undefined;visible=false;layout();changed();return state();},
    setZoom(value){
      if(!pageZooms.has(value))throw Error('网页缩放比例无效');
      if(value===zoomMode)return state();
      if(zoomFile){
        const temporary=zoomFile+'.tmp';
        try{
          mkdirSync(local,{recursive:true,mode:0o700});
          writeFileSync(temporary,value+'\n',{mode:0o600});
          renameSync(temporary,zoomFile);
        }catch{
          try{unlinkSync(temporary);}catch{}
          throw Error('无法保存内置浏览器缩放设置');
        }
      }
      zoomMode=value;layout();changed();return state();
    },
    navigate(url){const tab=records.get(activeId);if(tab)load(tab,url);else create({url});return state();},
    reload(){if(activeId)get(activeId).contents.reload();return state();},
    back(){const h=records.get(activeId)?.contents.navigationHistory;if(h?.canGoBack())h.goBack();return state();},
    forward(){const h=records.get(activeId)?.contents.navigationHistory;if(h?.canGoForward())h.goForward();return state();},
    select(id){activate(get(id),{focus:true,keep:true});return state();},
    focusTab(id){
      const tab=records.get(id);
      if(!activeVisibleTab(tab))return false;
      cancelConsoleFocus(tab);tab.initialFocusPending=false;
      tab.contents.focus();return tab.contents.isFocused();
    },
    preserveConsoleFocus(restore){
      const tab=records.get(activeId);
      if(attachedBossTab(tab)&&tab.initialFocusPending&&!tab.contents.isFocused())pendingConsoleFocus={tab,restore};
    },
    closeTab(id){forget(get(id),true);return state();}
  };
}
