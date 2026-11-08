import test from 'node:test';
import assert from 'node:assert/strict';
import {createChatJobReader,mergeChatJob} from '../server/chat-job.mjs';
import {observeConversation,memoryContext} from '../server/memory.mjs';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const role={title:'游戏关卡策划实习生',company:'测试游戏公司',city:'杭州',salary:'200-250元/天'};
const description='岗位职责：负责关卡内容、战斗节奏和玩法原型，整理策划文档并协作验证。任职要求：2027届本科在校生，熟悉关卡编辑及游戏分析。';
const memory=()=>({peerId:'boss:test',job:{...role},history:[],window:[],sends:[],decisions:[],revision:0});
test('聊天职位正文按读取凭据关联，缓存读取不发送招呼',()=>{
 const c=memory(),reader=createChatJobReader(),read=reader.start(c,role,1000);
 assert.equal(reader.start(c,role,1001).busy,true);
 const done=reader.complete({[c.peerId]:c},{...read,success:true,job:{...role,description}},2000);
 assert.equal(done.success,true);assert.equal(c.job.description,description);assert.equal(c.jobDetail.source,'boss_chat_view_job');assert.equal(reader.start(c,role,3000).cached,true);assert.equal(memoryContext(c).job_detail.status,'read');
 assert.throws(()=>reader.complete({[c.peerId]:c},{...read,success:true,job:{...role,description}},3000));
});
test('空字段不擦除正文，换岗位时归档旧详情并使旧草稿失效',()=>{
 const memories={},input={peerId:'boss:test',job:role,messages:[{id:'m1',role:'hr',text:'您好'}]};const c=observeConversation(memories,input).conversation;
 const reader=createChatJobReader(),read=reader.start(c,role);reader.complete(memories,{...read,success:true,job:{...role,description}});
 const revision=c.revision;assert.equal(observeConversation(memories,{...input,job:{title:role.title,description:'',city:''}}).changed,false);assert.equal(c.job.description,description);
 assert.equal(observeConversation(memories,{...input,job:{...role,title:'游戏数值策划实习生'}}).changed,true);assert.equal(c.revision,revision+1);assert.equal(c.job.description,undefined);assert.equal(c.jobDetail,undefined);assert.equal(c.jobHistory[0].job.description,description);
});
test('岗位链接的查询参数可以变化，不同路径大小写仍是不同的职位',()=>{
 const original='https://www.zhipin.com/job_detail/CaseToken.html',other='https://www.zhipin.com/job_detail/casetoken.html';
 const c={job:{url:original}};
 assert.equal(mergeChatJob(c,{url:original+'?from=chat'}),false);
 assert.equal(c.jobHistory,undefined);
 assert.equal(mergeChatJob(c,{url:other}),true);
 assert.equal(c.job.url,other);assert.equal(c.jobHistory[0].job.url,original);
});
test('另一HR、另一岗位、公司不符以及过期结果均不得串入记忆',()=>{
 const c=memory(),reader=createChatJobReader(),read=reader.start(c,role,1000),memories={[c.peerId]:c};
 assert.throws(()=>reader.complete(memories,{...read,peerId:'boss:other',success:true,job:{...role,description}},1100));
 assert.throws(()=>reader.complete(memories,{...read,success:true,job:{...role,title:'另一岗位',description}},1100));
 assert.throws(()=>reader.complete(memories,{...read,success:true,job:{...role,company:'另一公司',description}},1100));
 mergeChatJob(c,{...role,title:'游戏系统策划校招'});assert.throws(()=>reader.complete(memories,{...read,success:true,job:{...role,description}},1100));
 assert.equal(c.job.description,undefined);
 const expired=reader.start(c,c.job,2000);assert.throws(()=>reader.complete(memories,{...expired,success:true,job:{...c.job,description}},100000));
});
test('岗位失效和正文不足只记录读取状态，保持已观察字段',()=>{
 const c=memory(),reader=createChatJobReader(),read=reader.start(c,role,1000);
 const result=reader.complete({[c.peerId]:c},{...read,success:true,job:{title:role.title,description:'职位已下线'}},2000);
 assert.equal(result.success,false);assert.equal(c.jobDetail.status,'unavailable');assert.equal(c.job.description,undefined);assert.equal(c.job.salary,role.salary);assert.equal(reader.start(c,role,3000).cached,true);
});
test('详情位置混有学历经验时不覆盖聊天城市，原始详情字段另存，避免每次观察都重复读取',()=>{
 const c=memory(),reader=createChatJobReader(),read=reader.start(c,role);
 reader.complete({[c.peerId]:c},{...read,success:true,job:{...role,city:'杭州 · 在校/应届 · 本科',salary:'网页特殊字体',description}});
 assert.equal(c.job.city,'杭州');assert.equal(c.job.salary,role.salary);assert.equal(c.jobDetail.observed_fields.city,'杭州 · 在校/应届 · 本科');assert.equal(mergeChatJob(c,role),false);assert.equal(reader.start(c,role).cached,true);
});
test('扩展可在只读主人任务中关联JD并持久化，但不能伪造另一会话或触发新招呼',async t=>{
 let calls=0;const local=mkdtempSync(join(tmpdir(),'chat-job-api-')),port=await testPort(),app=createApplication({port,local,key:'fixture',inference:async()=>{calls++;throw Error('只读功能不应调用回复模型');}});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));
 const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 const api=async(path,data,token=session.extensionToken)=>{const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','X-Boss-Token':token},body:JSON.stringify(data)});return {status:r.status,...await r.json()};};
 const selected={uniquePeer:true,name:'刘女士',company:role.company,header:'刘女士 '+role.company,job:role,messages:[{id:'m1',role:'self',text:'你好，想了解实习岗位。'}]};
 const {peerId}=await api('/api/chat/resolve',selected);
 assert.equal((await api('/api/chat/job/start',{...selected,peerId:'boss:other'})).status,400);
 const read=await api('/api/chat/job/start',{...selected,peerId});assert(read.lease);
 const result=await api('/api/chat/job/complete',{...read,success:true,job:{...role,description}});assert.equal(result.success,true);assert.equal(app.state.config.running,false);assert.equal(app.state.tasks.length,0);assert.equal(calls,0);
 const stored=readdirSync(join(local,'memory/boss')).filter(f=>f.endsWith('.json')&&f!=='index.json').map(f=>JSON.parse(readFileSync(join(local,'memory/boss',f))));assert(stored.some(c=>c.job.description===description&&c.jobDetail.status==='read'));
 await api('/api/observe',{...selected,peerId,job:{title:role.title,city:''}});assert.equal(app.state.memories[peerId].job.description,description);
 const link={peerId,name:selected.name,company:selected.company,url:'https://www.zhipin.com/job_detail/verified-entry.html',evidence:'主人从此HR的查看职位手动打开后核对了链接'};
 assert.equal((await api('/api/chat/job/link',link)).status,403);assert.equal((await api('/api/chat/job/link',{...link,company:'另一公司'},session.token)).status,400);
 assert.equal((await api('/api/chat/job/link',link,session.token)).status,200);assert.equal(app.state.memories[peerId].job.description,undefined);assert.equal(app.state.memories[peerId].jobHistory.at(-1).job.description,description);assert.equal(app.state.memories[peerId].job.url,link.url);
 await api('/api/config',{chatRead:false},session.token);assert.equal((await api('/api/chat/job/start',{...selected,peerId})).status,400);
});
test('缺少旧标题或正文时也归档已知的不同链接，原会话回执不会串进新岗位和导出',async t=>{
 const local=mkdtempSync(join(tmpdir(),'chat-job-receipt-link-')),port=await testPort(),app=createApplication({port,local,key:'',desktop:true});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>app.shutdown());
 const base=`http://127.0.0.1:${port}`,{token}=await(await fetch(base+'/api/session')).json();
 const api=async(path,data,worker=false)=>{
  const response=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':worker?app.embeddedToken:token},...(data?{body:JSON.stringify(data)}:{})});
  const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;
 };
 const url=id=>'https://www.zhipin.com/job_detail/'+id+'.html';
 const job=id=>({...role,url:url(id)});
 const original='manual-original',replacement='manual-replacement',partial='browser-original',changed='browser-replacement';
 const rows=async(path='/api/jobs/table?page=1')=>{
  const result=await api(path);return Object.fromEntries((result.rows||result.jobs).map(row=>[row.url,row.progress]));
 };
 const receipt='您的附件简历 合成... 已发送给Boss';
 const thread=name=>({uniquePeer:true,name,company:role.company,header:name+' '+role.company,messages:[{id:'fixture-'+name,role:'self',text:'已按要求提供附件'}],resumeUI:{receipts:[{source:'chat_notice',text:receipt}]}});
 const manual=thread('测试甲'),browser=thread('测试乙');
 await api('/api/jobs/observe',{jobs:[original,replacement,partial,changed].map(job)},true);
 const {peerId:manualPeer}=await api('/api/chat/resolve',{...manual,job:job(original)},true);
 const {peerId:browserPeer}=await api('/api/chat/resolve',{...browser,job:{url:url(partial)}},true);
 const before=await rows();
 assert.equal(before[url(original)].status,'resume_sent');assert.equal(before[url(partial)].status,'resume_sent');
 const setOwnerLink=(id,query='')=>api('/api/chat/job/link',{peerId:manualPeer,name:manual.name,company:manual.company,url:url(id)+query,evidence:'合成测试的实际职位入口'});
 await setOwnerLink(original,'?from=owner');
 await api('/api/chat/resolve',{...browser,job:{url:url(partial)+'?from=chat'}},true);
 await api('/api/jobs/observe',{jobs:[{...job(original),url:url(original)+'?from=search'}]},true);
 assert.deepEqual(await rows(),before);
 await setOwnerLink(replacement);
 assert.equal((await api('/api/chat/resolve',{...browser,job:job(changed)},true)).peerId,browserPeer);
 const after=await rows();
 for(const [peerId,oldId,newId] of [[manualPeer,original,replacement],[browserPeer,partial,changed]]){
  const conversation=app.state.memories[peerId];
  assert.equal(conversation.job.url,url(newId));assert.equal(conversation.jobHistory.at(-1).job.url,url(oldId));
  assert.equal(conversation.resume.receipts[0].raw,receipt);
  assert.equal(after[url(newId)].status,'unobserved');assert.equal(after[url(newId)].resume,'unknown');
 }
 assert.deepEqual(await rows('/api/jobs/export?format=json'),after);
 const observedAt=Date.now()-1000,text='原岗位的可核对消息';
 app.state.tasks.push({id:'fixture-verified',kind:'reply',action:'send_text',status:'sent',peerId:manualPeer,job:job(original),text,receipt:{messageId:'verified-id',observedText:text,observedAt}});
 await api('/api/jobs/observe',{jobs:[job(original)]},true);
 const verified=await rows();
 assert.equal(verified[url(original)].status,'message_sent');assert.equal(verified[url(original)].at,observedAt);
 assert.equal(verified[url(replacement)].status,'unobserved');assert.deepEqual(await rows('/api/jobs/export?format=json'),verified);
});
