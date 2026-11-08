import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';
import {createApplication} from '../server/app.mjs';
import {createMcpTools} from '../server/tooling.mjs';
import {publicWebScopeEnv} from '../tools/boss-web-mcp.mjs';
import {testPort} from './port.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'boss-mcp-tools-'));
const command=process.execPath;
const privateValue='example-mcp-private-credential';
const privateArg='example-arg-never-in-api';
const tool={name:'custom_tool',label:'测试本地工具',command,args:['script.mjs',privateArg],env:{TEST_TOOL_TOKEN:privateValue}};
const asText=value=>JSON.stringify(value);
const names=entries=>entries.map(e=>e.config.serverName);

test('自定义工具持久保存并隔离自主回合，预设可以停用和恢复',()=>{
 const local=temp(),presets=join(local,'presets.json');
 writeFileSync(presets,asText({servers:[{name:'example',label:'测试预设',command,args:[]}]}));
 const tools=createMcpTools(local,{presets});
 assert.deepEqual(names(tools.entries('owner')),['example']);
 assert.deepEqual(names(tools.entries('autonomy')),['example']);
 const added=tools.update({action:'add',server:tool});
 assert.equal(added.servers.at(-1).installed,true);
 assert.equal(added.servers.at(-1).autonomous,false);
 assert.deepEqual(added.servers.at(-1).envNames,['TEST_TOOL_TOKEN']);
 assert(!asText(added).includes(privateValue));
 assert(!asText(added).includes(privateArg));
 tools.update({action:'add',server:{name:'autonomous',command,args:[],autonomous:true}});
 assert.throws(()=>tools.update({action:'add',server:{...tool,name:'CUSTOM_TOOL'}}),/同名/);
 assert.throws(()=>tools.update({action:'add',server:{...tool,name:'wrong',url:'https://example.test/mcp'}}),/stdio/);
 assert.throws(()=>tools.update({action:'remove',name:'example'}),/预设/);
 tools.update({action:'toggle',name:'example',enabled:false});
 assert.deepEqual(names(tools.entries('owner')),['custom_tool','autonomous']);
 assert.deepEqual(names(tools.entries('autonomy')),['autonomous']);
 assert.deepEqual(tools.entries('hr'),[]);
 assert.deepEqual(tools.entries('learning'),[]);

 const file=join(local,'mcp-servers.json'),restored=createMcpTools(local,{presets});
 assert.equal(restored.entries('owner')[0].config.env.TEST_TOOL_TOKEN,privateValue);
 assert.equal(JSON.parse(readFileSync(file,'utf8')).version,1);
 if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);
 restored.update({action:'install',templateId:'example'});
 restored.update({action:'remove',name:'custom_tool'});
 assert.deepEqual(names(restored.entries('owner')),['example','autonomous']);
});

test('桌面版只显示可选内置网页工具，不载入旧 Windows 配置',t=>{
 const previous=process.env.BOSS_DESKTOP_EXE;
 t.after(()=>{
  if(previous===undefined)delete process.env.BOSS_DESKTOP_EXE;else process.env.BOSS_DESKTOP_EXE=previous;
 });
 process.env.BOSS_DESKTOP_EXE=command;
 const local=temp(),cwd=join(local,'workspace'),tools=createMcpTools(local,{cwd});
 assert.deepEqual(tools.list().servers.map(s=>s.name),['web']);
 assert.equal(tools.list().servers[0].enabled,false);
 assert.deepEqual(tools.entries('owner'),[]);
 tools.update({action:'install',templateId:'web'});
 const privateValue='sk-fixture-protected-key';
 const webPrompt='https://EXAMPLE.org/docs#read https://example.org/?q=%73'+privateValue.slice(1);
 assert.deepEqual(tools.entries('owner'),[]);
 assert.deepEqual(tools.entries('owner',{webPrompt:'https://example.org/?q='+privateValue,privateValues:[privateValue]}),[]);
 const [entry]=tools.entries('owner',{webPrompt,privateValues:[privateValue]});
 assert.equal(entry.config.command,command);
 assert.deepEqual(entry.config.args,[fileURLToPath(new URL('../tools/boss-web-mcp.mjs',import.meta.url)),'--owner-scoped']);
 assert.equal(entry.config.env.ELECTRON_RUN_AS_NODE,'1');
 assert.deepEqual(JSON.parse(entry.config.env[publicWebScopeEnv]),['https://example.org/docs']);
 assert.equal(entry.config.cwd,cwd);
 assert.deepEqual(tools.entries('autonomy',{webPrompt}),[]);
});

test('工具可用性和实际启动命令使用同一个 PATH，并支持绝对路径',t=>{
 const local=temp(),cwd=join(local,'workspace'),parentBin=join(local,'parent-bin'),toolBin=join(cwd,'fixture-bin');
 const oldPath=process.env.PATH;
 t.after(()=>{if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;});
 process.env.PATH=parentBin;
 const windows=process.platform==='win32';
 const fake=(directory,name)=>{
  mkdirSync(directory,{recursive:true});
  const path=join(directory,name+(windows?'.exe':''));
  writeFileSync(path,'synthetic executable; never launched',{mode:0o700});
  return path;
 };
 const parent=fake(parentBin,'fixture-parent'),child=fake(toolBin,'fixture-child');
 const tools=createMcpTools(local,{presets:join(local,'no-presets.json'),cwd});
 for(const server of [
  {name:'parent',command:'fixture-parent'},
  {name:'child',command:'fixture-child',env:{[windows?'pAtH':'PATH']:'fixture-bin'}},
  {name:'disabled_path',command:'fixture-parent',env:{PATH:''}},
  {name:'absolute',command:child,env:{PATH:''}},
 ])tools.update({action:'add',server:{...server,args:[]}});
 assert.deepEqual(tools.list().servers.map(({name,installed})=>[name,installed]),[
  ['parent',true],['child',true],['disabled_path',false],['absolute',true],
 ]);
 assert.deepEqual(tools.entries('owner').map(({config})=>[config.serverName,config.command,config.env.PATH]),[
  ['parent',parent,undefined],['child',child,'fixture-bin'],['absolute',child,''],
 ]);
});

const packagedMcpRuntime=process.env.XIAOJING_TEST_MCP_RUNTIME;
const developmentMcpRuntime=fileURLToPath(new URL('../tools/cache/electron/runtime/electron.exe',import.meta.url));
test('桌面内置 Node 运行没有独立 Node 的 stdio 工具，并遵守显式路径',{
 skip:process.platform!=='win32'||!packagedMcpRuntime&&!existsSync(developmentMcpRuntime)
},t=>{
 const local=realpathSync(temp()),tempRoot=realpathSync(tmpdir());
 t.after(()=>{assert.equal(dirname(local),tempRoot);rmSync(local,{recursive:true,force:true});});
 const exe=resolve(packagedMcpRuntime||developmentMcpRuntime);
 const runtimeRoot=packagedMcpRuntime?join(dirname(exe),'resources','app'):fileURLToPath(new URL('../',import.meta.url));
 const shimBin=join(local,'bin'),explicitBin=join(local,'explicit-bin');
 mkdirSync(shimBin);mkdirSync(explicitBin);
 writeFileSync(join(shimBin,'node.cmd'),'@set ELECTRON_RUN_AS_NODE=1\r\n@"'+exe+'" %*\r\n');
 const physicalNode=join(explicitBin,'node.exe');
 writeFileSync(physicalNode,'fixture executable; never launched');
 const fixture=String.raw`
 import assert from 'node:assert/strict';
 import {spawnSync} from 'node:child_process';
 const {createMcpTools}=await import(process.env.XIAOJING_FIXTURE_TOOLING);
 const local=process.env.BOSS_DATA_DIR;
 const tools=createMcpTools(local,{cwd:local});
 const args=[process.env.XIAOJING_FIXTURE_MCP,'--read-only'];
 const add=(name,command,env={})=>tools.update({action:'add',server:{name,command,args,env}});
 add('desktop_node','node');
 add('empty_path','node',{Path:''});
 assert.throws(()=>add('unsafe_wrapper','node.cmd'),/可执行程序/);
 const find=(name)=>tools.list().servers.find(row=>row.name===name);
 const entry=()=>tools.entries('owner').find(item=>item.config.serverName==='desktop_node')?.config;
 assert.equal(find('desktop_node').installed,true);
 assert.equal(find('empty_path').installed,false);
 const fallback=entry();
 assert.equal(fallback.command,process.execPath);
 assert.equal(fallback.env.ELECTRON_RUN_AS_NODE,'1');
 const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',clientInfo:{name:'fixture',version:'1'},capabilities:{}}};
 const input=[initialize,{jsonrpc:'2.0',method:'notifications/initialized'},{jsonrpc:'2.0',id:2,method:'tools/list'}].map(value=>JSON.stringify(value)+'\n').join('');
 const stdio=spawnSync(fallback.command,fallback.args,{env:{...process.env,...fallback.env},cwd:fallback.cwd,input,encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(stdio.status,0,stdio.stderr);
 const responses=stdio.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line));
 assert.equal(responses[0].result.serverInfo.name,'xiaojing-boss');
 assert(responses[1].result.tools.some(tool=>tool.name==='boss_status'));
 assert(responses[1].result.tools.every(tool=>tool.annotations.readOnlyHint));
 process.env.BOSS_DESKTOP_EXE=process.env.XIAOJING_FIXTURE_FOREIGN_EXE;
 assert.equal(find('desktop_node').installed,false);
 assert.equal(entry(),undefined);
 process.env.BOSS_DESKTOP_EXE=process.execPath;
 process.env.PATH=process.env.XIAOJING_FIXTURE_DIRECT_PATH;
 assert.equal(entry().command,process.env.XIAOJING_FIXTURE_FOREIGN_EXE);
 assert.equal(entry().env.ELECTRON_RUN_AS_NODE,undefined);
 console.log('fixture MCP handshake succeeded');
 `;
 const result=spawnSync(exe,['--input-type=module','-e',fixture],{
  env:{...process.env,PATH:shimBin,BOSS_DATA_DIR:local,BOSS_DESKTOP_EXE:exe,ELECTRON_RUN_AS_NODE:'1',
   XIAOJING_FIXTURE_TOOLING:pathToFileURL(join(runtimeRoot,'server','tooling.mjs')).href,
   XIAOJING_FIXTURE_MCP:join(runtimeRoot,'tools','boss-mcp.mjs'),
   XIAOJING_FIXTURE_FOREIGN_EXE:physicalNode,XIAOJING_FIXTURE_DIRECT_PATH:explicitBin},
  encoding:'utf8',windowsHide:true,timeout:15000,
 });
 assert.equal(result.status,0,result.error?.message||result.stderr);
 assert.equal(result.stdout.trim(),'fixture MCP handshake succeeded');
});

test('桌面状态兼容 UTF-8 BOM，损坏的可选 MCP 文件不会中断服务或被覆盖',async t=>{
 const local=temp(),port=await testPort(),path=join(local,'mcp-servers.json');
 const valid='\uFEFF'+asText({version:1,enabled:{},servers:[tool]});
 writeFileSync(path,valid);
 const app=createApplication({local,port,key:'fixture-key',desktop:true});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 async function api(route,data){
  const response=await fetch(base+route,{method:data?'POST':'GET',headers:{'X-Boss-Token':session.token,'Content-Type':'application/json'},...(data?{body:asText(data)}:{})});
  return {status:response.status,value:await response.json()};
 }
 const dashboard='/api/state?view=desktop&panel=overview',settings='/api/mcp-tools';
 const before=await api(dashboard);
 assert.equal(before.status,200);assert(before.value.tools.some(row=>row.name===tool.name));
 assert.equal(readFileSync(path,'utf8'),valid);
 const malformed='{ "note": "fixture-private-malformed-config"';
 writeFileSync(path,malformed);
 const state=await api(dashboard),tools=await api(settings);
 assert.equal(state.status,200);assert.deepEqual(state.value.tools,[]);
 assert.deepEqual(tools,{status:200,value:{servers:[],templates:[],configurationError:state.value.toolsConfigurationError}});
 assert.match(tools.value.configurationError,/原文件已保留/);
 assert(!asText([state,tools]).includes('fixture-private-malformed-config'));
 assert.deepEqual(createMcpTools(local).entries('owner'),[]);
 assert.equal((await api(settings,{action:'remove',name:tool.name})).status,400);
 assert.equal((await api(settings,{action:'add',server:tool})).status,400);
 assert.equal(readFileSync(path,'utf8'),malformed);
 const backup=path+'.backup';renameSync(path,backup);
 assert.equal((await api(settings,{action:'add',server:tool})).status,200);
 assert.equal(readFileSync(backup,'utf8'),malformed);
 assert.equal((await api(dashboard)).value.toolsConfigurationError,undefined);
});

test('只有主人能管理 MCP，工具清单和主状态都不回传参数或环境变量值',async t=>{
 const local=temp(),port=await testPort(),key='sk-example-protected-boss-key';
 const app=createApplication({local,port,key,inference:async()=>({action:'skip',text:'',reason:'测试',score:0})});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{app.server.once('close',r);app.shutdown();}));
 const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 async function api(path,data,token=session.token,extra={}){
  const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'X-Boss-Token':token,'Content-Type':'application/json',...extra},...(data?{body:asText(data)}:{})});
  return {status:response.status,value:await response.json()};
 }
 const path='/api/mcp-tools',add={action:'add',server:tool};
 assert.equal((await api(path,undefined,'')).status,401);
 assert.equal((await api(path,undefined,session.extensionToken)).status,403);
 assert.equal((await api(path,add,session.extensionToken)).status,403);
 assert.equal((await api(path,add,session.token,{Origin:'chrome-extension://'+'a'.repeat(32)})).status,401);
 for(const value of [key,session.token,session.extensionToken]){
  const denied=await api(path,{action:'add',server:{...tool,env:{TEST_TOOL_TOKEN:value}}});
  assert.equal(denied.status,400);assert(!asText(denied.value).includes(value));
 }
 const created=await api(path,add);
 assert.equal(created.status,200,created.value.error);
 assert(created.value.servers.some(s=>s.name===tool.name));
 for(const result of [created,await api(path),await api('/api/state')]){
  assert.equal(result.status,200);
  assert(!asText(result.value).includes(privateValue));
  assert(!asText(result.value).includes(privateArg));
 }
 assert.equal((await api(path,{action:'toggle',name:tool.name,enabled:false})).status,200);
 assert.equal(createMcpTools(local).list().servers.find(s=>s.name===tool.name).enabled,false);
 assert.equal((await api(path,{action:'remove',name:tool.name})).status,200);
 assert(!createMcpTools(local).list().servers.some(s=>s.name===tool.name));
});
