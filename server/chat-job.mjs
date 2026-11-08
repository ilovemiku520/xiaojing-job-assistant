import {randomBytes} from 'node:crypto';
import {jobURL} from './jobs.mjs';

const norm=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
const fields=['title','company','city','salary','experience','description','url'];
function roleURL(value){try{return jobURL(value);}catch{return value;}}
export function cleanChatJob(input={}){
  const job={};for(const k of fields){const value=String(input[k]||'').trim().slice(0,k==='description'?12000:1000);if(value)job[k]=value;}
  if(job.url)job.url=jobURL(job.url);return job;
}
export function sameChatRole(a={},b={}){
  return !(a.url&&b.url&&roleURL(a.url)!==roleURL(b.url))&&
    !['title','company','city'].some(k=>a[k]&&b[k]&&norm(a[k])!==norm(b[k]));
}
export function archiveChatJob(c){
  c.jobHistory=[...(c.jobHistory||[]),{job:{...c.job},detail:c.jobDetail,archivedAt:Date.now()}].slice(-10);
}
// Empty observations must not erase a JD; a different role must not inherit it.
export function mergeChatJob(c,input={}){
  const next=cleanChatJob(input),before=JSON.stringify(c.job||{});
  if(!sameChatRole(c.job,next)){
    if(c.job?.title||c.job?.url)archiveChatJob(c);
    c.job={};delete c.jobDetail;
  }
  c.job={...c.job,...next};return before!==JSON.stringify(c.job);
}
export function createChatJobReader(){
  const reads=new Map();
  return {
    clear(){reads.clear();},
    start(c,job,now=Date.now()){
      if(!job.title)throw Error('聊天顶部尚未识别岗位名称');
      if(!sameChatRole(c.job,job))throw Error('聊天岗位已变化');
      const old=c.jobDetail;
      if(old&&sameChatRole(c.job,old.role)&&now-old.observedAt<(old.status==='read'?12*3600000:15*60000))return {cached:true,status:old.status,job:c.job};
      for(const [id,r] of reads)if(now-r.at>90000)reads.delete(id);
      const pending=[...reads.values()].find(r=>r.peerId===c.peerId&&sameChatRole(r.role,c.job));
      if(pending)return {busy:true};
      const requestId=randomBytes(16).toString('hex'),lease=randomBytes(24).toString('hex');
      const r={requestId,lease,peerId:c.peerId,role:{...c.job},at:now};delete r.role.description;reads.set(requestId,r);
      return {requestId,lease,peerId:c.peerId,role:r.role};
    },
    complete(memories,input,now=Date.now()){
      const r=reads.get(String(input.requestId));
      if(!r||input.lease!==r.lease||r.peerId!==input.peerId||now-r.at>90000)throw Error('岗位读取凭据失效');
      const c=memories[r.peerId];if(!c||!sameChatRole(c.job,r.role))throw Error('会话岗位已变化，未关联旧详情');
      const job=cleanChatJob(input.job);
      let reason=String(input.reason||'未能读取完整职位说明').slice(0,400),success=input.success===true;
      if(success){
        if(!job.title||norm(job.title)!==norm(r.role.title))throw Error('职位详情标题与聊天顶部不一致');
        if(job.company&&r.role.company&&!norm(job.company).includes(norm(r.role.company))&&!norm(r.role.company).includes(norm(job.company))&&!(r.role.url&&job.url===r.role.url))throw Error('职位详情公司与当前HR不一致');
        if(r.role.url&&job.url&&roleURL(r.role.url)!==job.url)throw Error('职位链接与当前会话不一致');
        if((job.description||'').length<40){success=false;reason='职位说明过短或岗位已下线，保留顶部信息';}
      }
      const previous=JSON.stringify([c.job,c.jobDetail]);
      if(success){c.job={...c.job,...job};for(const k of ['title','company','city','salary'])if(r.role[k])c.job[k]=r.role[k];}
      c.jobDetail={status:success?'read':'unavailable',role:r.role,observedAt:now,source:'boss_chat_view_job',entry:'聊天顶部查看职位',...(success?{url:job.url||'',observed_fields:job,evidence:'从当前HR的查看职位入口读取可见职位正文'}:{reason})};
      reads.delete(r.requestId);
      return {conversation:c,changed:previous!==JSON.stringify([c.job,c.jobDetail]),success};
    }
  };
}
