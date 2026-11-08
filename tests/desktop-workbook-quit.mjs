import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readFileSync,realpathSync,rmSync} from 'node:fs';
import {request} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {_electron as electron} from '../tools/node/node_modules/playwright-core/index.mjs';
import {testPort} from './port.mjs';

const base=realpathSync(tmpdir());
const home=realpathSync(mkdtempSync(join(base,'xiaojing-workbook-quit-')));
assert.equal(dirname(home),base);
const root=fileURLToPath(new URL('../',import.meta.url));
const packaged=process.argv[2]&&resolve(process.argv[2]);
const executablePath=packaged||join(root,'tools','cache','electron','runtime','electron.exe');
const port=await testPort(),origin='http://127.0.0.1:'+port;
const file=join(home,'profile','exports','岗位实时.xlsx');
const oldTitle='合成测试岗位甲',newTitle='合成测试岗位乙';
let app,closing,upload,download;
function within(promise,message,ms=4000){
  let timer;
  const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);});
  return Promise.race([promise,deadline]).finally(()=>clearTimeout(timer));
}
function sheet(){
  const bytes=readFileSync(file);
  for(let offset=0;bytes.readUInt32LE(offset)===0x04034b50;){
    const size=bytes.readUInt32LE(offset+18),nameSize=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28);
    const start=offset+30+nameSize+extra;
    if(bytes.toString('utf8',offset+30,offset+30+nameSize)==='xl/worksheets/sheet1.xml')return inflateRawSync(bytes.subarray(start,start+size)).toString();
    offset=start+size;
  }
  throw Error('Missing synthetic sheet');
}
async function launch(){
  app=await electron.launch({executablePath,args:packaged?[]:[resolve(root)],env:{...process.env,XIAOJING_DESKTOP_HOME:home,XIAOJING_DESKTOP_PORT:String(port)},timeout:25000});
  await app.evaluate(({session})=>{
    session.defaultSession.webRequest.onBeforeRequest({urls:['https://*/*']},(_details,done)=>done({cancel:true}));
  });
  const window=await app.firstWindow({timeout:25000});
  await window.waitForURL(origin+'/');
  const {token}=await(await fetch(origin+'/api/session')).json();
  const api=async(path,body)=>{
    const res=await fetch(origin+path,{method:body?'POST':'GET',headers:{'X-Boss-Token':token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    const data=await res.json();
    assert(res.ok,data.error);
    return data;
  };
  return {api,token};
}
const table=api=>api('/api/jobs/table?page=1');
const observation=(title,id)=>({jobs:[{title,company:'合成工作室',city:'北京',url:'https://www.zhipin.com/job_detail/'+id+'.html'}]});
async function settled(api){
  for(let i=0;i<100;i++){
    const value=await table(api);
    if(value.workbook.ready&&!value.workbook.pending)return value;
    await new Promise(done=>setTimeout(done,75));
  }
  throw Error('Synthetic workbook did not settle');
}
try{
  const {api,token}=await launch();
  await api('/api/jobs/observe',observation(oldTitle,'fixture-quit-a'));
  assert.equal((await settled(api)).total,1);
  assert.match(sheet(),new RegExp(oldTitle));
  assert.doesNotMatch(sheet(),new RegExp(newTitle));

  // Simulate a download that stalls after producing valid bytes, without a
  // huge workbook or dependence on the OS socket buffer size.
  const exportPath='/api/jobs/export?format=xlsx';
  await app.evaluate((_electron,exportPath)=>{
    const {Server}=process.getBuiltinModule('node:http');
    const emit=Server.prototype.emit;
    Server.prototype.emit=function(event,...args){
      const [req,res]=args;
      if(event==='request'&&req.url===exportPath&&req.headers['x-fixture-download']==='stall'){
        res.end=body=>{globalThis.heldJobDownload=res.statusCode===200&&body?.subarray(0,2).toString()==='PK';return res;};
      }
      return emit.call(this,event,...args);
    };
  },exportPath);
  download=request(origin+exportPath,{headers:{'X-Boss-Token':token,'X-Fixture-Download':'stall'},agent:false});
  download.on('error',()=>{});
  const downloadClosed=new Promise(done=>download.on('socket',socket=>socket.once('close',done)));
  download.end();
  let exportHeld=false;
  for(let i=0;!exportHeld&&i<60;i++){
    exportHeld=await app.evaluate(()=>globalThis.heldJobDownload===true);
    if(!exportHeld)await new Promise(done=>setTimeout(done,50));
  }
  assert.equal(exportHeld,true,'Authenticated export did not reach the held response');

  const documentName='合成未完成上传.txt';
  upload=request(origin+'/api/library/document',{method:'POST',headers:{'X-Boss-Token':token,'Content-Type':'application/json','Content-Length':4096,Expect:'100-continue'},agent:false});
  upload.on('error',()=>{});
  const accepted=once(upload,'continue');
  upload.flushHeaders();
  await within(accepted,'Synthetic upload headers were not accepted');
  await new Promise((done,reject)=>upload.write('{"name":'+JSON.stringify(documentName)+',"content":"未完成',error=>error?reject(error):done()));
  const uploadClosed=new Promise(done=>upload.socket.once('close',done));

  await api('/api/jobs/observe',observation(newTitle,'fixture-quit-b'));
  const pending=await table(api);
  assert.equal(pending.total,2);
  assert.equal(pending.workbook.pending,true);
  assert.equal(pending.workbook.ready,true);
  closing=app.close();
  await within(Promise.all([closing,uploadClosed,downloadClosed]),'Normal desktop quit hung on an unfinished upload or download');
  app=undefined;closing=undefined;
  const afterQuit=sheet();
  assert.match(afterQuit,new RegExp(oldTitle));
  assert(afterQuit.includes(newTitle),'Normal desktop quit must flush pending rows before restart');
  const restarted=await launch();
  const first=await table(restarted.api);
  assert.equal(first.total,2);
  assert(!(await restarted.api('/api/library')).documents.some(document=>document.name===documentName));
  assert.deepEqual(await restarted.api('/api/shutdown',{}),{ok:true});
  console.log('Clean desktop quit flushed both workbook rows and closed the held upload and export. No partial document was imported.');
}finally{
  upload?.destroy();download?.destroy();
  if(app)await(closing||app.close());
  rmSync(home,{recursive:true,force:true,maxRetries:3,retryDelay:150});
}
