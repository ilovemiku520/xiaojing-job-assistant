import {Worker} from 'node:worker_threads';

const workerFile=new URL('./job-export-worker.mjs',import.meta.url);
const profileKeys=['titles','cities','exclusions','salaryMin','salaryMax','earlyCareerOnly','experiencePolicy','maxExperienceYears','excludeSenior'];
const filterKeys=['q','query','source','status','fit','stage','sort','direction'];
const formats=new Set(['xlsx','csv','json']);
const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);

function selectFields(value,keys){
  return Object.fromEntries(keys.filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]]));
}

function createWorker(){
  // This worker only transforms data. It has no need for provider keys,
  // knowledge paths, or the host process's command-line flags.
  return new Worker(workerFile,{name:'xiaojing-job-export',env:{},execArgv:[]});
}

export function createJobExportEngine({workerFactory=createWorker,maxPending=4,timeoutMs=120000}={}){
  let worker,closed=false,sequence=0;
  const pending=new Map();
  const terminating=new Set();

  function terminate(target){
    const stopped=Promise.resolve().then(()=>target.terminate()).catch(()=>{});
    terminating.add(stopped);
    void stopped.then(()=>terminating.delete(stopped));
  }

  function failWorker(target,error,stop=true){
    if(worker!==target)return;
    worker=undefined;
    for(const request of pending.values()){
      clearTimeout(request.timeout);
      request.reject(error);
    }
    pending.clear();
    if(stop)terminate(target);
  }

  function settle(target,message){
    if(worker!==target)return;
    const entry=pending.get(message?.id);
    if(!entry)return;
    if(message.ok===true){
      const value=message.result;
      const valid=entry.command==='project'
        ?Array.isArray(value?.rows)&&typeof value.signature==='string'&&/^[0-9a-f]{64}$/.test(value.signature)
        :value?.body instanceof Uint8Array&&typeof value.contentType==='string'&&value.extension===entry.format;
      if(!valid){failWorker(target,Error('岗位导出后台返回无效结果，请重试'));return;}
      if(entry.command==='export')value.body=Buffer.from(value.body.buffer,value.body.byteOffset,value.body.byteLength);
      entry.resolve(value);
    }else if(message.ok===false&&typeof message.error==='string'){
      entry.reject(Error(message.error));
    }else{failWorker(target,Error('岗位导出后台返回无效结果，请重试'));return;}
    clearTimeout(entry.timeout);
    pending.delete(message.id);
    if(!pending.size)target.unref();
  }

  function getWorker(){
    if(worker)return worker;
    const target=workerFactory();
    worker=target;
    target.on('message',message=>settle(target,message));
    target.on('messageerror',()=>failWorker(target,Error('岗位导出后台返回数据失败，请重试')));
    target.on('error',()=>failWorker(target,Error('岗位导出后台异常退出，请重试')));
    target.on('exit',()=>failWorker(target,Error('岗位导出后台已退出，请重试'),false));
    return target;
  }

  function submit(command,data){
    if(closed)return Promise.reject(Error('岗位导出服务已关闭'));
    if(pending.size>=maxPending)return Promise.reject(Error('正在处理其他岗位导出，请稍后重试'));
    return new Promise((resolve,reject)=>{
      const target=getWorker(),id=++sequence;
      const timeout=setTimeout(()=>failWorker(target,Error('岗位导出超时，请缩小筛选范围后重试')),timeoutMs);
      pending.set(id,{resolve,reject,command,format:data.format,timeout});
      target.ref();
      try{target.postMessage({id,command,...data});}
      catch{
        clearTimeout(timeout);
        pending.delete(id);
        if(!pending.size)target.unref();
        reject(Error('无法向后台传递岗位资料'));
      }
    });
  }

  return {
    async project({jobs,profile,progress={}}={}){
      if(!isRecord(jobs)||profile!==undefined&&!isRecord(profile)||!isRecord(progress))throw Error('岗位资料格式无效');
      return submit('project',{jobs,profile:selectFields(profile||{},profileKeys),progress});
    },
    async export(rows,format,{filters,generatedAt}={}){
      if(!Array.isArray(rows)||!formats.has(format)||filters!==undefined&&!isRecord(filters))throw Error('岗位导出参数无效');
      return submit('export',{rows,format,filters:filters&&selectFields(filters,filterKeys),generatedAt});
    },
    async close(){
      closed=true;
      if(worker)failWorker(worker,Error('岗位导出服务已关闭'));
      await Promise.all(terminating);
    },
  };
}
