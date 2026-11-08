import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {testPort} from './port.mjs';
import {createServer} from 'node:http';
import {once} from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = realpathSync(tmpdir());
const profile = realpathSync(mkdtempSync(join(temporary,'xiaojing-desktop-ui-')));
assert.equal(dirname(profile),temporary);
const packagedExe = process.argv[2];
const executablePath = packagedExe || join(root,'tools','cache','electron','runtime','electron.exe');
const launchArgs = packagedExe ? [] : [resolve(root)];
const packagePath = packagedExe ? join(dirname(executablePath),'resources','app','package.json') : join(root,'package.json');
const expectedVersion = JSON.parse(readFileSync(packagePath,'utf8')).version;
const defaultPortTest = process.env.XIAOJING_TEST_DEFAULT_PORT === '1';
const port = defaultPortTest ? 17322 : await testPort();
const env = {...process.env,XIAOJING_DESKTOP_HOME:profile};
if (defaultPortTest) delete env.XIAOJING_DESKTOP_PORT;
else env.XIAOJING_DESKTOP_PORT=String(port);
let app, legacy;
try {
  if(defaultPortTest){
    legacy=createServer((_request,response)=>response.end('legacy port fixture'));
    legacy.listen(17321,'127.0.0.1');
    try {await once(legacy,'listening');}
    catch(error){if(error.code!=='EADDRINUSE')throw error;legacy=undefined;}
  }
  app = await electron.launch({
    executablePath, args:launchArgs, env,
    timeout:25000
  });
  const win = await app.firstWindow({timeout:25000});
  await win.waitForURL('http://127.0.0.1:'+port+'/');
  assert.equal(new URL(win.url()).port,String(port));
  await win.locator('body.desktop-shell').waitFor();
  assert.equal(await win.locator('aside .aside-note').count(),0);
  await win.locator('#main-nav').getByRole('button',{name:'内置浏览器',exact:true}).waitFor();
  await win.locator('#main-nav').getByRole('button',{name:'对话',exact:true}).waitFor();
  await win.getByText('0/4 已准备',{exact:true}).waitFor();
  await win.keyboard.press('Tab');
  await win.waitForFunction(()=>document.activeElement.id==='workspace-skip');
  assert.equal(await win.locator('#workspace-skip').evaluate(node=>getComputedStyle(node).clipPath),'none');
  await win.keyboard.press('Enter');
  assert.equal(await win.evaluate(()=>document.activeElement.id),'heading');
  assert.equal(new URL(win.url()).hash,'');
  const initialWindow=await app.evaluate(({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0];
    const initial={size:window.getSize(),zoom:window.webContents.getZoomFactor()};
    window.setSize(790,750);window.webContents.setZoomFactor(1.25);
    return initial;
  });
  const menu=win.locator('#nav-toggle'),jobsNav=win.locator('#main-nav [data-panel="jobs"]');
  await menu.waitFor({state:'visible'});
  await menu.focus();await win.keyboard.press('Enter');
  await jobsNav.focus();await win.keyboard.press('Escape');
  assert.equal(await win.evaluate(()=>document.activeElement.id),'nav-toggle');
  assert.equal(await menu.getAttribute('aria-expanded'),'false');
  await win.keyboard.press('Enter');await jobsNav.focus();await win.keyboard.press('Enter');
  await win.locator('body[data-view="jobs"]').waitFor();
  assert.equal(await win.evaluate(()=>document.activeElement.id),'heading');
  assert.equal(await jobsNav.getAttribute('aria-current'),'page');
  assert.equal(await win.locator('#main-nav [aria-current="page"]').count(),1);
  await app.evaluate(({BrowserWindow},{size,zoom})=>{
    const window=BrowserWindow.getAllWindows()[0];window.setSize(...size);window.webContents.setZoomFactor(zoom);
  },initialWindow);
  await win.locator('#main-nav [data-panel="overview"]').click();
  await win.evaluate(async()=>{await api('/api/heartbeat',{page:'https://www.zhipin.com/web/user'});await refresh();});
  assert.equal(await win.locator('#m-browser').textContent(),'待登录');
  assert.match(await win.locator('#setup-browser').textContent(),/完成登录/);
  await win.waitForFunction(version=>document.querySelector('#app-version').textContent==='桌面版 '+version,expectedVersion);
  assert.equal(await win.getByRole('link',{name:'作者 ilovemiku520 的 GitHub'}).getAttribute('href'),'https://github.com/ilovemiku520');
  const theme = await win.evaluate(()=>{
    const styles = selector => getComputedStyle(document.querySelector(selector));
    const card = styles('.channel-summary');
    return {body:styles('body').backgroundColor,aside:styles('aside').backgroundColor,primary:styles('#run').backgroundColor,card:card.backgroundColor,border:card.borderTopColor,radius:card.borderRadius,shadow:card.boxShadow,transition:styles('#stop').transitionDuration};
  });
  assert.deepEqual(theme,{body:'rgb(13, 13, 13)',aside:'rgb(23, 23, 23)',primary:'rgb(0, 255, 136)',card:'rgb(23, 23, 23)',border:'rgb(42, 42, 42)',radius:'2px',shadow:'none',transition:'0.2s'});
  const placeholders=await win.evaluate(()=>['#jobs-query','#memory-search'].map(selector=>getComputedStyle(document.querySelector(selector),'::placeholder').color));
  assert.deepEqual(placeholders,['rgb(85, 85, 85)','rgb(85, 85, 85)']);
  await win.locator('#tasks .empty strong').waitFor();
  const accentless=await win.evaluate(()=>['#tasks .empty strong','.autonomy-card summary'].map(selector=>getComputedStyle(document.querySelector(selector)).color));
  assert.deepEqual(accentless,['rgb(237, 237, 237)','rgb(237, 237, 237)']);
  const settingsGear=win.getByRole('button',{name:'设置',exact:true});
  const settingsDrawer=win.locator('#desktop-settings-drawer');
  const settingsNav=settingsDrawer.locator('#desktop-settings-nav');
  const settingsCategory=name=>settingsNav.locator(`[data-panel="${name}"]`);
  async function openSetting(name){
    if(!(await settingsDrawer.isVisible()))await settingsGear.click();
    await settingsCategory(name).click();
  }
  async function closeSettings(){
    await settingsDrawer.getByRole('button',{name:'收起设置栏',exact:true}).click();
    await settingsDrawer.waitFor({state:'hidden'});
  }
  async function dropFiles(target,files){
    const url=win.url();
    const result=await target.evaluate((node,items)=>{
      const dataTransfer=new DataTransfer();
      for(const [name,content,type] of items)dataTransfer.items.add(new File([content],name,{type}));
      const send=type=>node.dispatchEvent(new DragEvent(type,{dataTransfer,bubbles:true,cancelable:true}));
      const highlighted=()=>!!node.closest('.desktop-file-over');
      const dragPrevented=!send('dragover'),marked=highlighted(),dropPrevented=!send('drop');
      return {dragPrevented,marked,dropPrevented,cleared:!highlighted()};
    },files);
    assert.deepEqual(result,{dragPrevented:true,marked:true,dropPrevented:true,cleared:true});
    assert.equal(win.url(),url);
  }
  assert.equal(await settingsGear.getAttribute('id'),'desktop-settings-toggle');
  assert.equal(await settingsGear.getAttribute('aria-controls'),'desktop-settings-drawer');
  assert.equal(await settingsGear.getAttribute('aria-expanded'),'false');
  assert.equal(await settingsDrawer.isVisible(),false);
  await win.keyboard.press('Control+,');
  await settingsDrawer.waitFor({state:'visible'});
  assert.equal(await settingsGear.getAttribute('aria-expanded'),'true');
  await settingsCategory('library').focus();
  await win.keyboard.press('Escape');
  await settingsDrawer.waitFor({state:'hidden'});
  assert.equal(await win.evaluate(()=>document.activeElement.id),'desktop-settings-toggle');
  assert.equal(await settingsGear.getAttribute('aria-expanded'),'false');

  // The compact drawer occupies the top of the window. Keyboard focus in the
  // underlying workspace must scroll into the uncovered area.
  await app.evaluate(({BrowserWindow})=>{
    const window=BrowserWindow.getAllWindows()[0];window.setContentSize(720,650);
  });
  await win.waitForFunction(()=>innerWidth===720&&innerHeight===650);
  await win.locator('#main-nav [data-panel="owner"]').click();
  await openSetting('profile');
  const ownerTaskPicker=win.locator('#owner-thread-select');
  await win.evaluate(()=>scrollTo(0,0));
  await win.locator('#owner-new').focus();
  const scrollAmount=await ownerTaskPicker.evaluate(node=>Math.ceil(node.getBoundingClientRect().top-175));
  assert(scrollAmount>0);
  await win.mouse.move(360,570);
  await win.mouse.wheel(0,scrollAmount);
  await win.waitForFunction(()=>{
    const task=document.querySelector('#owner-thread-select').getBoundingClientRect();
    const drawer=document.querySelector('#desktop-settings-drawer').getBoundingClientRect();
    return scrollY>0&&task.top>=drawer.top&&task.bottom<drawer.bottom;
  });
  await win.keyboard.press('Tab');
  await win.waitForFunction(()=>document.activeElement.id==='owner-thread-select');
  const compactFocus=await ownerTaskPicker.evaluate(node=>{
    const task=node.getBoundingClientRect(),drawer=document.querySelector('#desktop-settings-drawer');
    const hit=document.elementFromPoint((task.left+task.right)/2,(task.top+task.bottom)/2);
    const drawerContent=drawer.querySelector('.desktop-settings-content'),root=document.documentElement;
    return {drawerOpen:!drawer.hidden,visible:task.top>=drawer.getBoundingClientRect().bottom&&task.bottom<=innerHeight,
      hit:hit===node||node.contains(hit),overflow:root.scrollWidth-root.clientWidth,drawerOverflow:drawerContent.scrollWidth-drawerContent.clientWidth};
  });
  assert.deepEqual(compactFocus,{drawerOpen:true,visible:true,hit:true,overflow:0,drawerOverflow:0});
  await closeSettings();
  await app.evaluate(({BrowserWindow},{size,zoom})=>{
    const window=BrowserWindow.getAllWindows()[0];window.setSize(...size);window.webContents.setZoomFactor(zoom);
  },initialWindow);
  await win.locator('#main-nav [data-panel="overview"]').click();

  await openSetting('library');
  assert.equal(await win.locator('body').getAttribute('data-view'),'overview');
  assert.equal(await win.locator('#overview').isVisible(),true);
  assert.equal(await settingsNav.locator('[aria-current="page"]').count(),1);
  await win.getByText('知识库为空。',{exact:false}).waitFor();
  await win.locator('#desktop-persona').fill('测试助手口吻简洁');
  await win.locator('#desktop-rules').fill('问清岗位职责');
  await win.locator('#desktop-persona-file').setInputFiles({name:'人格.md',mimeType:'text/markdown',buffer:Buffer.from('解释要具体')});
  await win.getByText('已追加「人格.md」，保存后生效。',{exact:true}).waitFor();
  const rulesImport='{"focus":"核对岗位事实"}';
  await dropFiles(win.locator('#desktop-rules'),[['规则.json',rulesImport,'application/json']]);
  await win.getByText('已追加「规则.json」，保存后生效。',{exact:true}).waitFor();
  const {persona:storedPersona,rules:storedRules}=await win.evaluate(()=>api('/api/library'));
  assert.equal(storedPersona,'');
  assert.equal(storedRules,'');
  const priorLibrary=await win.locator('#desktop-documents > p').elementHandle();
  await openSetting('profile');
  await openSetting('library');
  await win.waitForFunction(node=>!node.isConnected,priorLibrary);
  assert.equal(await win.locator('#desktop-persona').inputValue(),'测试助手口吻简洁\n\n解释要具体');
  assert.equal(await win.locator('#desktop-rules').inputValue(),'问清岗位职责\n\n'+rulesImport);
  await win.getByRole('button',{name:'保存人格与规则'}).click();
  await win.getByText('人格和沟通规则已保存。').waitFor();
  const knowledge=Buffer.from('# 样例\n说明文档内容');
  await win.locator('#desktop-document-file').setInputFiles([
    {name:'样例知识.md',mimeType:'text/markdown',buffer:knowledge},
    {name:'无效知识.json',mimeType:'application/json',buffer:Buffer.from('{broken')},
    {name:'第二份资料.txt',mimeType:'text/plain',buffer:Buffer.from('这是合成的第二份资料。')},
    {name:'重复知识.md',mimeType:'text/markdown',buffer:knowledge}
  ]);
  await win.getByText('样例知识.md',{exact:true}).waitFor();
  await win.getByText('第二份资料.txt',{exact:true}).waitFor();
  await win.getByText(/新增 2 份，重复 1 份，1 份需处理.*无效知识\.json/).waitFor();
  assert.equal(await win.locator('#desktop-document-file').inputValue(),'');
  await dropFiles(win.locator('#desktop-document-file'),[
    ['拖放知识.md','# 新知识\n通过拖放补充。','text/markdown'],
    ['拖放重复.md',knowledge.toString(),'text/markdown'],
  ]);
  await win.getByText('拖放知识.md',{exact:true}).waitFor();
  await win.getByText('新增 1 份，重复 1 份。',{exact:true}).waitFor();
  assert.equal(await app.evaluate(({shell})=>{
    const original=shell.openPath;
    globalThis.folderFixture={original,requested:null};
    shell.openPath=async path=>{globalThis.folderFixture.requested=path;return '';};
    return shell.openPath!==original;
  }),true);
  await win.getByRole('button',{name:'打开本机资料目录',exact:true}).click();
  await win.waitForFunction(()=>!document.querySelector('#desktop-show-data').disabled);
  const folder=await app.evaluate(({shell})=>{
    shell.openPath=globalThis.folderFixture.original;
    return globalThis.folderFixture.requested;
  });
  assert.equal(folder,join(profile,'profile'));
  await win.locator('#desktop-resume-file').setInputFiles({name:'样例简历.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\n%%EOF')});
  await win.getByText('样例简历.pdf',{exact:true}).waitFor();
  await dropFiles(win.locator('#desktop-resume-file'),[['拖放简历.pdf','%PDF-1.7\n%fixture drop\n%%EOF','application/pdf']]);
  await win.getByText('拖放简历.pdf',{exact:true}).waitFor();
  await openSetting('mcp');
  const mcpField=win.locator('#desktop-mcp-json');
  const importedMcp='{"name":"fixture_import_only","command":"fixture-do-not-launch"}';
  await mcpField.fill('手工草稿');
  await dropFiles(mcpField,[['MCP.json',importedMcp,'application/json']]);
  await win.getByText('请先保存或移走当前内容，再导入 JSON',{exact:true}).waitFor();
  assert.equal(await mcpField.inputValue(),'手工草稿');
  await mcpField.fill('');
  await dropFiles(mcpField,[['损坏的 MCP.json','{broken','application/json']]);
  await win.getByText('JSON 文件格式无效',{exact:true}).waitFor();
  assert.equal(await mcpField.inputValue(),'');
  await win.locator('#desktop-mcp-json-file').setInputFiles({name:'MCP.json',mimeType:'application/json',buffer:Buffer.from(importedMcp)});
  await win.getByText('已载入「MCP.json」，点击「添加 MCP 工具」保存。',{exact:true}).waitFor();
  assert.equal(await mcpField.inputValue(),importedMcp);
  const {servers}=await win.evaluate(()=>api('/api/mcp-tools'));
  assert(!servers.some(server=>server.name==='fixture_import_only'));
  await win.evaluate(()=>history.replaceState(null,'','/?conversation=fixture-owner-task#owner'));
  await win.getByRole('button',{name:'复制客户端配置'}).click();
  await win.getByText('MCP 客户端配置已复制。').waitFor();
  const mcpConfig = JSON.parse(await win.locator('#desktop-mcp-example').textContent()).mcpServers.xiaojing;
  assert(mcpConfig.args.includes('--read-only'));
  await closeSettings();
  await win.locator('#main-nav [data-panel="browser-setup"]').click();
  await win.getByRole('button',{name:'打开内置浏览器'}).waitFor();
  await openSetting('connection');
  assert.equal(await win.locator('body').getAttribute('data-view'),'browser-setup');
  await win.locator('#browser-state').waitFor();
  assert.equal(await win.locator('#key-form').isVisible(),false);
  assert.equal(await win.locator('#pair-token').isVisible(),false);
  await win.getByRole('button',{name:'设置任务模型',exact:true}).click();
  await win.locator('#providers-content').getByText('DeepSeek',{exact:false}).first().waitFor();
  const state = await win.evaluate(async()=>{
    const auth = await(await fetch('/api/session')).json();
    return await(await fetch('/api/state',{headers:{'X-Boss-Token':auth.token}})).json();
  });
  assert.equal(state.config.profile.name,'');
  assert.equal(state.config.running,false);
  assert.equal(Object.keys(state.memories).length,0);
  assert(state.tools.some(tool=>tool.name==='web'&&!tool.enabled));
  await closeSettings();
  await win.locator('#main-nav [data-panel="control"]').click();
  await win.waitForFunction(()=>document.querySelector('#operation-summary').textContent.includes('共 0 项记录'));
  assert.equal(await win.locator('#operation-pagination').isVisible(),false);
  await openSetting('profile');
  for(const [name,value] of [['name','测试求职者'],['titles','软件测试'],['cities','上海，测试城市'],['facts','测试资料']]){
    await win.locator('#profile-form [name="'+name+'"]').fill(value);
  }
  await dropFiles(win.locator('#desktop-profile-facts'),[['经历.txt','通过拖放补充项目经历。','text/plain']]);
  await win.getByText('已追加「经历.txt」，保存后生效。',{exact:true}).waitFor();
  assert.equal(await win.locator('#desktop-profile-facts').inputValue(),'测试资料\n\n通过拖放补充项目经历。');
  await win.locator('[name="experiencePolicy"]').selectOption('max');
  await win.locator('[name="maxExperienceYears"]').fill('2');
  await win.locator('[name="excludeSenior"]').uncheck();
  await win.getByRole('button',{name:'保存资料',exact:true}).click();
  await win.getByText('求职资料和筛选标准已保存，旧草稿已失效。').waitFor();
  await win.waitForFunction(()=>document.querySelector('#profile-search-coverage').textContent.includes('自动搜索支持 上海'));
  assert.match(await win.locator('#profile-search-coverage').textContent(),/测试城市可用于筛选/);
  const screening = await win.evaluate(async()=>{
    const auth = await(await fetch('/api/session')).json();
    const {config} = await(await fetch('/api/state',{headers:{'X-Boss-Token':auth.token}})).json();
    return config.profile;
  });
  assert.equal(screening.experiencePolicy,'max');
  assert.equal(screening.facts,'测试资料\n\n通过拖放补充项目经历。');
  assert.equal(screening.maxExperienceYears,2);
  assert.equal(screening.excludeSenior,false);
  await closeSettings();
  await win.locator('#main-nav [data-panel="overview"]').click();
  await win.getByText('1/4 已准备',{exact:true}).waitFor();
  assert.equal(await win.locator('#summary').isVisible(),false);
  assert.equal(await win.locator('#summary').textContent(),'');
  const mcp = spawn(mcpConfig.command,mcpConfig.args,{env:{...env,...mcpConfig.env},windowsHide:true,stdio:['pipe','pipe','pipe']});
  const mcpResult = await new Promise((resolve,reject)=>{
    let stdout = '', tools, table, operations;
    const timeout = setTimeout(()=>{mcp.kill();reject(Error('Electron MCP did not respond'));},12000);
    mcp.stdout.setEncoding('utf8').on('data',chunk=>{
      stdout += chunk;
      const complete = stdout.split(/\r?\n/);
      stdout = complete.pop();
      for(const line of complete){
        try {
          const row=JSON.parse(line);
          if(row.id===2)tools=row.result?.tools;
          if(row.id===3)table=row.result;
          if(row.id===4)operations=row.result;
          if(tools&&table&&operations){clearTimeout(timeout);mcp.stdin.end();resolve({tools,table,operations});return;}
        } catch {}
      }
    });
    mcp.on('error',error=>{clearTimeout(timeout);reject(error);});
    mcp.on('exit',()=>{clearTimeout(timeout);reject(Error('Electron MCP closed before listing tools'));});
    const packet = (method,id,params)=>JSON.stringify({jsonrpc:'2.0',method,...(id?{id}:{}),...(params?{params}:{})})+'\n';
    mcp.stdin.write(packet('initialize',1,{protocolVersion:'2025-11-25',clientInfo:{name:'desktop-test',version:'1.0.0'},capabilities:{}}));
    mcp.stdin.write(packet('notifications/initialized'));
    mcp.stdin.write(packet('tools/list',2));
    mcp.stdin.write(packet('tools/call',3,{name:'boss_jobs_table',arguments:{page:1}}));
    mcp.stdin.write(packet('tools/call',4,{name:'boss_operations',arguments:{kind:'owner',limit:5}}));
  });
  assert(mcpResult.tools.some(tool=>tool.name==='boss_status'));
  assert(mcpResult.tools.every(tool=>tool.annotations.readOnlyHint));
  assert.equal(mcpResult.table.structuredContent.total,0);
  assert.equal(mcpResult.operations.structuredContent.total,0);
  async function waitForWorkbook(){
    const deadline=Date.now()+10000;
    do{
      const ready=await win.evaluate(async()=>{
        const {workbook}=await api('/api/jobs/table?page=1');
        return workbook.ready&&!workbook.pending;
      });
      if(ready)return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }while(Date.now()<deadline);
    throw Error('Isolated live workbook did not become ready');
  }
  await waitForWorkbook();
  unlinkSync(join(profile,'profile','exports','岗位实时.xlsx'));
  const recreated=await win.evaluate(()=>window.xiaojingDesktop.openJobsWorkbook());
  assert.deepEqual(recreated,{ok:false,pending:true});
  await waitForWorkbook();
  if(legacy)assert.equal(await(await fetch('http://127.0.0.1:17321/')).text(),'legacy port fixture');
  const screenshots = join(root,'work','desktop-qa');
  mkdirSync(screenshots,{recursive:true});
  await win.screenshot({path:join(screenshots,'setup.png')});
  await openSetting('providers');
  await win.screenshot({path:join(screenshots,'models.png')});
  await openSetting('library');
  await win.screenshot({path:join(screenshots,'library.png')});
  console.log('Electron UI verified with a clean profile and synthetic imports.');
} finally {
  if(app)await app.close();
  if(legacy)await new Promise(resolve=>legacy.close(resolve));
  rmSync(profile,{recursive:true,force:true});
}
