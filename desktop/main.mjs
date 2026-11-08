import {app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, net, shell} from 'electron';
import {copyFileSync, mkdirSync, writeFileSync} from 'node:fs';
import {delimiter, dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

const desktop = dirname(fileURLToPath(import.meta.url));
const root = dirname(desktop);
const appHome = process.env.XIAOJING_DESKTOP_HOME
  ? resolve(process.env.XIAOJING_DESKTOP_HOME)
  : join(app.getPath('appData'), 'Xiaojing Desktop');
const dataDir = join(appHome, 'profile');
const configuredPort = Number(process.env.XIAOJING_DESKTOP_PORT || 17322);
const port = Number.isInteger(configuredPort) && configuredPort >= 1024 && configuredPort <= 65535 ? configuredPort : 17322;
const origin = 'http://127.0.0.1:' + port;
const desktopVersion = app.getVersion();
const launchKind = 'xiaojing-desktop-launch';
const jobExportFormats = {
  xlsx:{name:'Excel 工作簿',mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
  csv:{name:'CSV 文件',mime:'text/csv'},
  json:{name:'JSON 文件',mime:'application/json'},
};
const versionParts = value => typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){2}$/.test(value) ? value.split('.').map(Number) : null;
function launchedNewer(data) {
  if (data?.kind !== launchKind) return false;
  const running = versionParts(desktopVersion), launched = versionParts(data.version);
  if (!running || !launched) return false;
  const changed = launched.findIndex((part, index) => part !== running[index]);
  return changed !== -1 && launched[changed] > running[changed];
}
app.setName('小鲸求职助手');
mkdirSync(appHome, {recursive:true});
app.setPath('userData', appHome);
if (!app.requestSingleInstanceLock({kind:launchKind, version:desktopVersion})) {
  app.quit();
} else {
  // The portable distribution starts with a fresh profile, including a clean browser.
  process.env.BOSS_DATA_DIR = dataDir;
  process.env.BOSS_KNOWLEDGE_DIR = join(desktop, 'starter');
  process.env.BOSS_DESKTOP_EXE = process.execPath;
  process.env.BOSS_RESUME_ON_START = '0';
  process.env.PORT = String(port);

  let window, service, embedded, embeddedWorker, pendingUpgrade, consoleReady = false, quitting = false, quitReady = false;
  let savingJobExport = false;
  let externalBrowser = {revision:0,phase:'idle',activeExternal:false};
  let externalPairingTimer;
  function updateExternalBrowser(phase, pending) {
    clearTimeout(externalPairingTimer);
    externalBrowser = {revision:externalBrowser.revision+1,phase,activeExternal:service.activeBrowserBridge()==='external',...pending};
    if(phase==='pending') externalPairingTimer=setTimeout(scheduleExternalExpiry,Math.max(0,pending.expiresAt-Date.now())).unref();
    if(window&&!window.isDestroyed())window.webContents.send('desktop:external-browser-state',externalBrowser);
    return externalBrowser;
  }
  function scheduleExternalExpiry() {
    const remaining=externalBrowser.expiresAt-Date.now();
    if(remaining<=0){updateExternalBrowser('expired');return;}
    externalPairingTimer=setTimeout(scheduleExternalExpiry,remaining).unref();
  }
  function externalBrowserState() {
    if(externalBrowser.phase==='pending'&&externalBrowser.expiresAt<=Date.now())updateExternalBrowser('expired');
    return externalBrowser;
  }
  function closeEmbedded() {
    embeddedWorker?.close();
    embedded?.close();
    embeddedWorker = undefined;
    embedded = undefined;
  }
  function showUpgradeNotice() {
    if (!pendingUpgrade || !consoleReady || !window || window.isDestroyed() || quitting) return;
    window.webContents.send('desktop:version-mismatch', pendingUpgrade);
    pendingUpgrade = undefined;
  }
  app.on('second-instance', (_event, _argv, _directory, additionalData) => {
    if (launchedNewer(additionalData)) pendingUpgrade = {runningVersion:desktopVersion, launchedVersion:additionalData.version};
    if (window && !window.isDestroyed() && !quitting) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    showUpgradeNotice();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', event => {
    closeEmbedded();
    if (quitReady || (!quitting && !service?.server.listening)) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    const serverClosed = new Promise(done=>service.server.once('close',done));
    // A partial upload or an unfinished download can outlive server.close().
    const workbookClosed = Promise.resolve(service.shutdown({flushWorkbook:true}))
      .finally(()=>service.server.closeAllConnections());
    void Promise.allSettled([serverClosed,workbookClosed]).then(()=>{
      quitReady = true;
      app.quit();
    });
  });

  function requireConsole(event) {
    if (quitting) throw Error('小鲸正在关闭');
    const contents = window?.webContents;
    const frame = event.senderFrame;
    if (!contents || event.sender !== contents || !frame || frame !== contents.mainFrame) throw Error('操作仅限桌面控制台');
    const from = new URL(frame.url);
    if (from.origin !== origin || from.pathname !== '/' || from.username || from.password) throw Error('操作仅限桌面控制台');
  }

  void app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark';
    const workspace = join(dataDir, 'workspace');
    mkdirSync(join(workspace, 'work'), {recursive:true});
    mkdirSync(join(workspace, 'tools'), {recursive:true});
    copyFileSync(join(root, 'tools', 'boss-task.mjs'), join(workspace, 'tools', 'boss-task.mjs'));
    const binaries = join(dataDir, 'bin');
    mkdirSync(binaries, {recursive:true});
    writeFileSync(join(binaries, 'node.cmd'), '@setlocal\r\n@chcp 65001 >nul\r\n@set ELECTRON_RUN_AS_NODE=1\r\n@"'+process.execPath.replaceAll('%','%%')+'" %*\r\n');
    process.env.PATH = binaries + delimiter + (process.env.PATH || '');

    const {createApplication} = await import('../server/app.mjs');
    const {createBrowserSetup} = await import('./browser-setup.mjs');
    const {createEmbeddedBrowser} = await import('./embedded-browser.mjs');
    const {startEmbeddedWorker} = await import('./embedded-worker.mjs');
    service = createApplication({port, workspace, desktop:true, desktopVersion,onExternalBrowserPaired:()=>{
      closeEmbedded();
      updateExternalBrowser('paired');
    }});
    service.server.listen(port, '127.0.0.1');
    await once(service.server, 'listening');

    const browser = createBrowserSetup({
      runtimeDir:join(dataDir, 'browser'),
      extensionDir:join(root, 'extension'),
      serviceOrigin:origin,
      issuePairingCode:service.prepareExternalBrowserPairing,
      onProgress:message=>window?.webContents.send('desktop:browser-progress', message)
    }, {fetcher:(url, options)=>net.fetch(url, options)});
    window = new BrowserWindow({
      width:1260, height:860, minWidth:720, minHeight:560, show:false,
      title:'小鲸求职助手', backgroundColor:'#0D0D0D', autoHideMenuBar:true,
      icon:join(desktop, 'assets', 'xiaojing-icon.png'),
      webPreferences:{preload:join(desktop, 'preload.cjs'), contextIsolation:true, sandbox:true, nodeIntegration:false}
    });
    window.webContents.on('did-start-loading', () => {
      consoleReady = false;
      embedded?.hide();
    });
    window.webContents.on('did-finish-load', () => { consoleReady = true; showUpgradeNotice(); });
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    window.webContents.on('will-attach-webview', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(({url}) => {
      const target = new URL(url);
      const job = target.origin==='https://www.zhipin.com'&&/^\/job_detail\/[\w-]+\.html$/.test(target.pathname);
      if(job&&service.activeBrowserBridge()==='embedded')window.webContents.send('desktop:open-job',target.origin+target.pathname);
      else if (target.origin === 'https://www.zhipin.com' || target.href === 'https://github.com/ilovemiku520') {
        void shell.openExternal(target.href).catch(() => {});
      }
      return {action:'deny'};
    });
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ipcMain.handle('desktop:external-browser-state', event => {
      requireConsole(event);
      return externalBrowserState();
    });
    ipcMain.handle('desktop:browser', async (event, mode) => {
      requireConsole(event);
      if (!['managed', 'edge', 'chrome'].includes(mode)) throw Error('请选择 Chrome 或 Edge');
      const result = mode === 'managed' ? await browser.launch() : await browser.openFallback(mode);
      const snapshot=updateExternalBrowser('pending', {
        mode, expiresAt:result.pairingExpiresAt, extensionPath:mode==='managed'?'':result.extensionPath
      });
      if (mode !== 'managed') clipboard.writeText(result.extensionPath);
      return snapshot;
    });
    ipcMain.handle('desktop:embedded', async (event, action, value) => {
      requireConsole(event);
      const openingJob = action === 'open-job';
      const opening = action === 'open' || openingJob;
      const url = openingJob ? value?.url : undefined;
      if(openingJob&&(!/^https:\/\/www\.zhipin\.com\/job_detail\/[\w-]+\.html$/.test(String(url))||service.activeBrowserBridge()!=='embedded')){
        throw Error('请使用内置浏览器打开有效的 BOSS 岗位');
      }
      if(action==='open'){
        const previous=externalBrowserState();
        service.selectBrowserBridge('embedded');
        if(previous.phase==='pending')updateExternalBrowser('cancelled');
        else if(previous.activeExternal)updateExternalBrowser('idle');
      }
      if (opening && !embedded) {
        const extensionDir = join(root,'extension');
        embedded = createEmbeddedBrowser({
          window, extensionDir, local:dataDir,
          onChange:state=>window?.webContents.send('desktop:embedded-state',state),
          onMessage:(message,sender)=>embeddedWorker?.receiveMessage(message,sender),
          onSettingsShortcut:tabId=>{
            if(!consoleReady||!window?.isFocused()||service.activeBrowserBridge()!=='embedded')return false;
            window.webContents.focus();
            window.webContents.send('desktop:settings-shortcut',tabId);
            return true;
          }
        });
        try {embeddedWorker=await startEmbeddedWorker({tabs:embedded.tabs,extensionDir,local:dataDir,port,token:service.embeddedToken});}
        catch(error){closeEmbedded();throw error;}
      }
      if (action === 'focus-tab') {
        if(!window.isFocused())return false;
        const owner=window;
        if(service.activeBrowserBridge()==='embedded'){
          if(embedded?.focusTab(value))return true;
          embedded?.preserveConsoleFocus(()=>{
            if(window===owner&&consoleReady&&owner.isFocused()&&service.activeBrowserBridge()==='embedded')owner.webContents.focus();
          });
        }
        owner.webContents.focus();return false;
      }
      if (!embedded) return null;
      if (opening || action === 'bounds') {
        const rect = openingJob ? value.bounds : value;
        if (!rect || !['x','y','width','height'].every(key=>Number.isFinite(rect[key]))) throw Error('浏览器区域无效');
        if (openingJob) {
          const existing=(await embedded.tabs.query({url}))[0];
          if(existing)await embedded.select(existing.id);
          else await embedded.tabs.create({url,active:true});
        }
        embedded.show(rect,window.webContents.getZoomFactor());
      } else if (action === 'hide') embedded.hide();
      else if (action === 'zoom') embedded.setZoom(value);
      else if (action === 'navigate') {
        const pages = {chat:'https://www.zhipin.com/web/geek/chat',jobs:'https://www.zhipin.com/web/geek/job',favorites:'https://www.zhipin.com/web/geek/recommend?tab=4&sub=1&page=1&tag=4'};
        if (!Object.hasOwn(pages,value)) throw Error('未知 BOSS 页面');
        await embedded.navigate(pages[value]);
      } else if (action === 'select') await embedded.select(Number(value));
      else if (action === 'close-tab') await embedded.closeTab(Number(value));
      else if (action === 'reload') await embedded.reload();
      else if (action === 'back') await embedded.back();
      else if (action === 'forward') await embedded.forward();
      else if (action !== 'state') throw Error('浏览器操作无效');
      return embedded.state();
    });
    ipcMain.handle('desktop:mcp-config', (event, readOnly) => {
      requireConsole(event);
      const args = [join(root,'tools','boss-mcp.mjs'), ...(readOnly===false?[]:['--read-only'])];
      const env = {ELECTRON_RUN_AS_NODE:'1',BOSS_DATA_DIR:dataDir,PORT:String(port)};
      const config = {mcpServers:{xiaojing:{command:process.execPath,args,env}}};
      const text = JSON.stringify(config, null, 2);
      clipboard.writeText(text);
      return text;
    });
    ipcMain.handle('desktop:resume-folder', event => {
      requireConsole(event);
      const resume = service.library.activeResume();
      if (!resume) throw Error('请先导入 PDF 简历');
      shell.showItemInFolder(resume.path);
    });
    ipcMain.handle('desktop:data-folder', async event => {
      requireConsole(event);
      if (await shell.openPath(dataDir)) throw Error('无法打开本机资料目录');
    });
    ipcMain.handle('desktop:jobs-export', async (event, {url,format,stamp} = {}) => {
      requireConsole(event);
      const prefix = 'blob:' + origin + '/';
      if (typeof url !== 'string' || !url.startsWith(prefix) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url.slice(prefix.length)) ||
        typeof format !== 'string' || !Object.hasOwn(jobExportFormats,format) || typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(stamp)) {
        throw Error('岗位导出文件无效');
      }
      if (savingJobExport) throw Error('已有一份岗位表正在保存');
      savingJobExport = true;
      const contents = window.webContents, session = contents.session;
      const {name,mime} = jobExportFormats[format];
      try {
        return await new Promise((resolve,reject) => {
          const cleanup = () => {
            clearTimeout(startTimeout);
            session.removeListener('will-download', started);
            contents.removeListener('destroyed', closed);
          };
          const fail = message => { cleanup();reject(Error(message)); };
          const closed = () => fail('岗位导出窗口已关闭');
          function started(downloadEvent,item,source) {
            if (source !== contents || item.getURL() !== url) return;
            clearTimeout(startTimeout);
            session.removeListener('will-download', started);
            try {
              if (item.getMimeType() !== mime) throw Error('岗位导出文件格式不符');
              item.setSaveDialogOptions({defaultPath:join(app.getPath('downloads'),`小鲸岗位_${stamp}.${format}`),filters:[{name,extensions:[format]}]});
              item.once('done', (_event,state) => { cleanup();resolve(state); });
            } catch (error) {
              downloadEvent.preventDefault();
              fail(error.message);
            }
          }
          const startTimeout = setTimeout(() => fail('未能启动岗位表保存，请重试'),10000);
          session.on('will-download', started);
          contents.once('destroyed', closed);
          try { contents.downloadURL(url); }
          catch { fail('未能启动岗位表保存，请重试'); }
        });
      } finally { savingJobExport = false; }
    });
    ipcMain.handle('desktop:jobs-workbook', async (event,rebuild) => {
      requireConsole(event);
      const workbook = service.jobWorkbook;
      const status = workbook.status();
      if (rebuild===true || !status.ready) {
        if (!status.pending || ['error','locked'].includes(status.state)) workbook.refresh();
        return {ok:false,pending:true};
      }
      if (status.externallyChanged) return {ok:false,externallyChanged:true};
      const error = await shell.openPath(workbook.file);
      if (error) throw Error('无法打开 Excel 文件，请检查系统默认的表格应用');
      return {ok:true};
    });
    window.once('ready-to-show', () => window.show());
    await window.loadURL(origin + '/');
  }).catch(error => {
    if (error.code === 'EADDRINUSE') dialog.showErrorBox('小鲸无法启动', '桌面版端口 '+port+' 正在使用。请关闭占用该端口的程序，再打开小鲸。');
    else dialog.showErrorBox('小鲸无法启动', String(error.message));
    app.quit();
  });
}
