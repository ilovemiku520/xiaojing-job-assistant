import {readFileSync} from 'node:fs';
import {request} from 'node:http';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {extensionRoutes} from '../server/browser-routes.mjs';

export const embeddedRuntimeId='xiaojing-embedded';
// The shared Chrome worker uses this logical origin. The in-app transport
// connects to the desktop service's bound port after checking the route.
const extensionBase='http://127.0.0.1:17321';
const bossOrigin='https://www.zhipin.com';
const maxRequestBytes=750000;
const maxResponseBytes=8*1024*1024;
const unavailable=()=>({ok:false,error:'小鲸内嵌浏览器已停止'});

function chromeEvent(){
  const listeners=new Set();
  return {
    listeners,
    api:{addListener:listener=>listeners.add(listener),removeListener:listener=>listeners.delete(listener)},
    fire(...args){
      for(const listener of [...listeners]){
        try{void Promise.resolve(listener(...args)).catch(()=>{});}catch{}
      }
    },
  };
}

function storage(initial={}){
  const values=new Map(Object.entries(initial));
  return {
    async get(key){
      return values.has(key)?{[key]:structuredClone(values.get(key))}:{};
    },
    async set(items){
      for(const [key,value] of Object.entries(items))values.set(key,structuredClone(value));
    },
    async remove(key){values.delete(key);},
  };
}

function loopbackFetch(port,token,lifetime){
  return async (input,{method='GET',body,signal}={})=>{
    lifetime.throwIfAborted();
    signal?.throwIfAborted();
    const url=new URL(input);
    if(url.origin!==extensionBase||url.username||url.password||url.search||url.hash||!extensionRoutes.has(url.pathname))throw Error('本地接口不在浏览器权限范围内');
    if(!['GET','POST'].includes(method)||body!==undefined&&(method!=='POST'||typeof body!=='string'||Buffer.byteLength(body)>maxRequestBytes))throw Error('本地接口请求格式无效');
    return new Promise((done,fail)=>{
      const req=request({
        hostname:'127.0.0.1',port,path:url.pathname,method,agent:false,
        signal:signal?AbortSignal.any([lifetime,signal]):lifetime,
        headers:{Host:`127.0.0.1:${port}`,'X-Boss-Token':token,'Content-Type':'application/json',...(body===undefined?{}:{'Content-Length':Buffer.byteLength(body)})},
      },async res=>{
        try{
          const chunks=[];
          let bytes=0;
          for await(const chunk of res){
            bytes+=chunk.length;
            if(bytes>maxResponseBytes)throw Error('本地接口返回数据过大');
            chunks.push(chunk);
          }
          const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          done({ok:res.statusCode>=200&&res.statusCode<300,json:async()=>structuredClone(value)});
        }catch(error){res.destroy();fail(error);}
      });
      req.once('error',()=>fail(Error(lifetime.aborted?'小鲸内嵌浏览器已停止':'小鲸本地服务连接中断')));
      req.end(body);
    });
  };
}

export function startEmbeddedWorker({tabs,extensionDir,port,token}){
  if(typeof token!=='string'||!/^[\da-f]{64}$/i.test(token))throw Error('缺少小鲸内嵌浏览器凭据');
  if(!Number.isInteger(port)||port<1||port>65535)throw Error('小鲸内嵌浏览器端口无效');
  const manifest=JSON.parse(readFileSync(join(extensionDir,'manifest.json'),'utf8'));
  const workerSource=readFileSync(join(extensionDir,'background.js'),'utf8');
  const stopped=new AbortController();
  const messages=chromeEvent(),startup=chromeEvent(),installed=chromeEvent(),alarms=chromeEvent();
  const pending=new Set(),timeouts=new Set(),intervals=new Set(),alarmTimers=new Map(),unbind=[];

  function timeout(fn,delay){
    const handle=setTimeout(()=>{
      timeouts.delete(handle);
      if(!stopped.signal.aborted)fn();
    },delay);
    timeouts.add(handle);
    return handle;
  }
  function clearTimer(handle){clearTimeout(handle);timeouts.delete(handle);}
  function interval(fn,delay){
    const handle=setInterval(()=>{if(!stopped.signal.aborted)fn();},delay);
    intervals.add(handle);
    return handle;
  }
  function close(){
    if(stopped.signal.aborted)return;
    stopped.abort();
    for(const handle of timeouts)clearTimeout(handle);
    for(const handle of intervals)clearInterval(handle);
    timeouts.clear();
    intervals.clear();
    alarmTimers.clear();
    for(const dispose of unbind)dispose();
    for(const settle of pending)settle(unavailable());
  }

  const workerTabs={};
  for(const name of ['query','get','create','createAutomation','update','remove','removeAutomation','reload','goBack','sendMessage']){
    if(typeof tabs[name]!=='function')continue;
    workerTabs[name]=async (...args)=>{
      if(stopped.signal.aborted)throw Error('小鲸内嵌浏览器已停止');
      return structuredClone(await tabs[name](...structuredClone(args)));
    };
  }
  for(const name of ['onUpdated','onActivated','onRemoved']){
    const event=chromeEvent();
    const forward=(...args)=>{if(!stopped.signal.aborted)event.fire(...structuredClone(args));};
    tabs[name].addListener(forward);
    unbind.push(()=>tabs[name].removeListener(forward));
    workerTabs[name]=event.api;
  }

  const chrome={
    runtime:{id:embeddedRuntimeId,getManifest:()=>structuredClone(manifest),onMessage:messages.api,onStartup:startup.api,onInstalled:installed.api},
    storage:{local:storage({token}),session:storage({loadedVersion:manifest.version})},
    tabs:workerTabs,
    alarms:{
      onAlarm:alarms.api,
      create(name,{periodInMinutes}){
        const old=alarmTimers.get(name);
        if(old){clearInterval(old);intervals.delete(old);}
        if(Number.isFinite(periodInMinutes)&&periodInMinutes>=0.5){
          alarmTimers.set(name,interval(()=>alarms.fire({name,scheduledTime:Date.now(),periodInMinutes}),periodInMinutes*60000));
        }
      },
    },
  };
  try{
    // The bundled script is trusted app code. Page input enters only as cloned
    // messages and the VM is used to host the Chrome globals, not as a sandbox.
    runInNewContext(workerSource,{
      chrome,fetch:loopbackFetch(port,token,stopped.signal),URL,AbortSignal,
      setTimeout:timeout,clearTimeout:clearTimer,setInterval:interval,
    },{filename:'embedded-extension/background.js',timeout:1000});
  }catch(error){close();throw error;}
  queueMicrotask(()=>{if(!stopped.signal.aborted)startup.fire();});

  function receiveMessage(message,sender){
    if(stopped.signal.aborted)return Promise.resolve(unavailable());
    let payload,url;
    try{
      url=new URL(sender?.url);
      const serialized=JSON.stringify(message);
      if(!serialized||Buffer.byteLength(serialized)>maxRequestBytes)throw Error();
      payload=JSON.parse(serialized);
      if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.type!=='string')throw Error();
      if(sender.id!==embeddedRuntimeId||!Number.isSafeInteger(sender.tab?.id)||sender.tab.id<0||url.origin!==bossOrigin||url.username||url.password)throw Error();
    }catch{return Promise.resolve({ok:false,error:'内嵌浏览器消息来源或格式无效'});}
    if(pending.size>=64)return Promise.resolve({ok:false,error:'内嵌浏览器正在处理其他请求'});
    return new Promise(done=>{
      const finish=result=>{
        if(!pending.delete(finish))return;
        clearTimer(wait);
        done(structuredClone(result));
      };
      const wait=timeout(()=>finish({ok:false,error:'内嵌浏览器请求超时'}),140000);
      pending.add(finish);
      const ownSender={id:embeddedRuntimeId,url:url.href,tab:{id:sender.tab.id}};
      let waiting=false;
      for(const listener of messages.listeners){
        try{if(listener(payload,ownSender,finish)===true)waiting=true;}catch{}
        if(!pending.has(finish))return;
      }
      if(!waiting)finish({ok:false,error:'内嵌浏览器没有处理这条请求'});
    });
  }
  return {receiveMessage,close};
}
