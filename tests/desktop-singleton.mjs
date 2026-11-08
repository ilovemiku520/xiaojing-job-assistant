import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const executablePath=join(root,'tools','cache','electron','runtime','electron.exe');
const temp=realpathSync(tmpdir());
const fixture=realpathSync(mkdtempSync(join(temp,'xiaojing-singleton-')));
assert.equal(dirname(fixture),temp);
const profile=join(fixture,'profile'),challenger=join(fixture,'candidate');
mkdirSync(challenger);
writeFileSync(join(challenger,'main.cjs'),`
const {app}=require('electron');
app.setPath('userData',process.env.XIAOJING_DESKTOP_HOME);
const info={kind:'xiaojing-desktop-launch',version:app.getVersion()};
if(app.requestSingleInstanceLock(info))app.exit(17);
else app.quit();
`);
const port=await testPort();
const env={...process.env,XIAOJING_DESKTOP_HOME:profile,XIAOJING_DESKTOP_PORT:String(port)};
let primary;
try{
  primary=await electron.launch({executablePath,args:[resolve(root)],env,timeout:25000});
  const window=await primary.firstWindow();
  await window.waitForURL('http://127.0.0.1:'+port+'/');
  await window.locator('body.desktop-shell').waitFor();
  await window.evaluate(()=>{
    globalThis.fixtureNotices=[];
    window.xiaojingDesktop.onVersionMismatch(notice=>globalThis.fixtureNotices.push(notice));
  });
  const running=await primary.evaluate(({app})=>app.getVersion());
  const primaryPid=primary.process().pid;
  const newer=running.split('.').map((value,index)=>Number(value)+(index===2?1:0)).join('.');
  await primary.evaluate(({app})=>{
    globalThis.fixtureLaunches=[];
    app.on('second-instance',(_event,_argv,_directory,data)=>globalThis.fixtureLaunches.push(data??null));
  });
  async function launch(version){
    writeFileSync(join(challenger,'package.json'),JSON.stringify({name:'xiaojing-singleton-fixture',version,main:'main.cjs'}));
    const child=spawn(executablePath,[challenger],{env,windowsHide:true,stdio:'ignore'});
    const [code]=await once(child,'exit');
    assert.equal(code,0,'第二个实例必须退出并交接给原实例');
    for(let i=0;i<60;i++){
      if(await primary.evaluate((_electron,version)=>globalThis.fixtureLaunches.some(data=>data?.version===version),version))return;
      await window.waitForTimeout(50);
    }
    throw Error('主实例未收到同资料目录的启动请求 '+JSON.stringify(await primary.evaluate(()=>globalThis.fixtureLaunches)));
  }
  await launch(running);
  assert.deepEqual(await window.evaluate(()=>globalThis.fixtureNotices),[]);
  await primary.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.emit('did-start-loading'));
  await launch(newer);
  assert.deepEqual(await window.evaluate(()=>globalThis.fixtureNotices),[]);
  await primary.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].webContents.emit('did-finish-load'));
  await window.waitForFunction(()=>globalThis.fixtureNotices.length===1);
  assert.deepEqual(await window.evaluate(()=>globalThis.fixtureNotices),[{runningVersion:running,launchedVersion:newer}]);
  assert.equal(primary.process().pid,primaryPid);
  assert.equal(await window.evaluate(()=>window.location.port),String(port));
  console.log(JSON.stringify({sameVersionQuiet:true,newerVersionBuffered:true,primaryProcessPreserved:true}));
}finally{
  if(primary)await primary.close();
  rmSync(fixture,{recursive:true,force:true});
}
