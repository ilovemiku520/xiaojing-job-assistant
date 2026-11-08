import {createHash} from 'node:crypto';
import {parentPort} from 'node:worker_threads';
import {exportJobRows,filterJobRows,projectJobRows} from './job-exports.mjs';

const isRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const formats=new Set(['xlsx','csv','json']);

function project({jobs,profile,progress}){
  if(!isRecord(jobs)||!isRecord(profile)||!isRecord(progress))throw Error('岗位资料格式无效');
  const rows=projectJobRows({jobs,config:{profile}},undefined,progress);
  const hash=createHash('sha256');
  hash.update('job-rows-v1\n');
  for(const row of rows)hash.update(JSON.stringify(row)+'\n');
  return {rows,signature:hash.digest('hex')};
}

function exportRows({rows,format,filters,generatedAt}){
  if(!Array.isArray(rows)||!formats.has(format)||filters!==undefined&&!isRecord(filters))throw Error('岗位导出参数无效');
  if(generatedAt!==undefined&&(!Number.isFinite(generatedAt)||Math.abs(generatedAt)>8640000000000000))throw Error('岗位导出时间无效');
  return exportJobRows(filters?filterJobRows(rows,filters):rows,format,{generatedAt});
}

parentPort.on('message',message=>{
  if(!Number.isSafeInteger(message?.id))return;
  const {id,command}=message;
  try{
    if(command==='project'){
      parentPort.postMessage({id,ok:true,result:project(message)});
    }else if(command==='export'){
      const {body,contentType,extension}=exportRows(message);
      // Small Buffers may share Node's slab. Transfer only owned bytes.
      const bytes=body.byteOffset===0&&body.byteLength===body.buffer.byteLength?body:Uint8Array.from(body);
      parentPort.postMessage({id,ok:true,result:{body:bytes,contentType,extension}},[bytes.buffer]);
    }else throw Error('不支持的岗位后台操作');
  }catch(error){
    parentPort.postMessage({id,ok:false,error:String(error?.message||'岗位后台处理失败').slice(0,250)});
  }
});
