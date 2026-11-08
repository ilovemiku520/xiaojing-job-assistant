import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseResumeReceipt,observeResumeUI,confirmResumeSent,resumeContext,resumeDispatchPlan} from '../server/resume-state.mjs';
import {validateDecision,defaults} from '../server/core.mjs';
import {createApplication} from '../server/app.mjs';
import {testPort} from './port.mjs';
const notice='您的附件简历 某同学_游... 已发送给Boss点击查看附件';
test('结构化站内附件卡片以同会话我方消息编号去重并保留历史状态',()=>{
 const card={source:'self_attachment_card',messageId:'sent-card',filenameLabel:'合成附件.pdf'},self={id:card.messageId,role:'self',text:'合成附件.pdf'},profile={resumeName:'合成简历.pdf',resumeAliases:['合成附件.pdf']};
 const observe=(conversation,...receipts)=>observeResumeUI(conversation,{receipts},100,profile);
 const c={peerId:'first',window:[self]};
 assert.equal(observe(c,card,card),true);assert.equal(c.resume.status,'sent');assert.equal(c.resume.receipts.length,1);
 assert.deepEqual(c.resume.receipts[0],{id:c.resume.receipts[0].id,source:'self_attachment_card',messageId:'sent-card',raw:'站内我方附件简历卡片 合成附件.pdf（消息编号 sent-card）',filenameLabel:'合成附件.pdf',filenameComplete:true,status:'sent',observedAt:100,lastSeenAt:100});
 assert.equal(observe(c,card),false);
 c.window=[];assert.equal(observe(c),false);assert.equal(c.resume.status,'sent');
 const other={peerId:'second',window:[{...self,role:'hr'}]};observe(other,card);assert.equal(other.resume.status,'unknown');
 for(const invalid of [{...card,messageId:'another-id'},{...card,messageId:'sent-card\n'},{...card,filenameLabel:'合成附…'},{...card,filenameLabel:'无关附件.pdf'}]){
  const conversation={window:[self]};observe(conversation,invalid);assert.equal(conversation.resume.status,'unknown');
 }
 const duplicate={window:[self,self]};observe(duplicate,card);assert.equal(duplicate.resume.status,'unknown');
});
test('窗口外可见附件用独立的同会话锚点确认，矛盾角色或重复编号无效',()=>{
 const card={source:'self_attachment_card',messageId:'older-card',filenameLabel:'合成简历.pdf'},anchor={id:card.messageId,role:'self',filenameLabel:card.filenameLabel};
 const history={id:card.messageId,role:'self',text:card.filenameLabel,source:'boss_dom_history'},recent={id:'recent',role:'hr',text:'您好'};
 const profile={resumeName:card.filenameLabel};
 const observe=(c,anchors)=>observeResumeUI(c,{receipts:[card],...(anchors===undefined?{}:{attachmentCardAnchors:anchors})},100,profile);
 const outside={window:[recent]};observe(outside,[anchor]);assert.equal(outside.resume.status,'sent');assert.deepEqual(outside.window,[recent]);
 const legacy={window:[recent],history:[history]};observe(legacy);assert.equal(legacy.resume.status,'sent');
 const unanchored={window:[recent]};observe(unanchored);assert.equal(unanchored.resume.status,'unknown');
 const cases=[
  [{window:[{...recent,id:card.messageId}],history:[history]},[anchor]],
  [{window:[history,history]},[anchor]],
  [{window:[recent],history:[{...history,role:'hr'}]},[anchor]],
  [{window:[recent],history:[history,history]},[anchor]],
  [{window:[recent],history:[{...history,source:'model_summary'}]},undefined],
  [{window:[recent]},[{...anchor,role:'hr'}]],
  [{window:[recent]},[{...anchor,filenameLabel:'另一个附件.pdf'}]],
  [{window:[recent]},[{...anchor,id:'unrelated'}]],
  [{window:[recent]},[anchor,anchor]],
  [{window:[recent]},Array(21).fill(anchor)]
 ];
 for(const [conversation,anchors] of cases){observe(conversation,anchors);assert.equal(conversation.resume.status,'unknown');}
});
test('聊天正文引用不生成新回执，历史已发证明继续阻止重发',()=>{
 const quote=`你这边是不是显示“${notice}”？我这里没有收到，麻烦再发一下。`;
 for(const invalid of [quote,`${notice}，这条是你那边的提示吗？`,`${notice}${' '.repeat(1500)}待核对`])assert.equal(parseResumeReceipt(invalid,'sidebar'),null);
 const c={},pending={requestPending:true,agreeEnabled:true,requestMessageId:'synthetic-request'};
 observeResumeUI(c,{...pending,receipts:[{source:'sidebar',text:quote}]},100);
 assert.equal(c.resume.status,'unknown');assert.equal(c.resume.workflow,'resume_requested');
 const options={resumeName:'合成简历.pdf',allowSiteDefaultResume:true};
 assert.equal(resumeDispatchPlan({...c.resume.capabilities,...c.resume},options).route,'accept_request');
 observeResumeUI(c,{...pending,receipts:[{source:'chat_notice',text:notice}]},200);
 observeResumeUI(c,{...pending,receipts:[]},300);
 assert.equal(c.resume.receipts.length,1);assert.equal(resumeDispatchPlan({...c.resume.capabilities,...c.resume},options).alreadySent,true);
 const legacy={resume:{status:'sent',receipts:[{id:'legacy-receipt',raw:quote,source:'sidebar',status:'sent'}]}};
 observeResumeUI(legacy,{...pending,receipts:[]},300);
 assert.equal(legacy.resume.receipts[0].id,'legacy-receipt');assert.equal(resumeDispatchPlan({...legacy.resume.capabilities,...legacy.resume},options).alreadySent,true);
});
test('附件提示独立保存，截断文件名不补全，提示离开侧栏后仍记得已发',()=>{
 const receipt=parseResumeReceipt(notice,'sidebar');assert.equal(receipt.filenameLabel,'某同学_游...');assert.equal(receipt.filenameComplete,false);assert.equal(parseResumeReceipt('我想要一份您的附件简历，您是否同意'),null);
 const c={};assert(observeResumeUI(c,{receipts:[{source:'sidebar',text:notice}],toolbarPresent:true,toolbarEnabled:false},100));assert.equal(c.resume.status,'sent');assert.equal(c.resume.workflow,'resume_sent_followup');
 assert.equal(observeResumeUI(c,{receipts:[{source:'sidebar',text:notice}],toolbarPresent:true,toolbarEnabled:false},200),false);assert.equal(c.resume.receipts.length,1);
 observeResumeUI(c,{receipts:[],toolbarPresent:true,toolbarEnabled:false},300);assert.equal(c.resume.status,'sent');assert.equal(resumeContext(c).receipts.length,1);const other={};observeResumeUI(other,{receipts:[]});assert.equal(other.resume.status,'unknown');
});
test('已发送不再发历史附件；入口未开放是等待，不能当作发送失败',()=>{
 const config=structuredClone(defaults);config.profile.resumeName='游戏策划简历.pdf';const v={action:'send_resume',text:'',reason:'HR要附件',score:90};
 assert.equal(validateDecision(v,config,{kind:'reply',memory:{resume:{status:'sent'}}}).action,'skip');
 const blocked=validateDecision(v,config,{kind:'reply',memory:{resume:{status:'unknown',capabilities:{toolbarEnabled:false,agreeEnabled:false}}}});assert.equal(blocked.action,'hold');assert.match(blocked.reason,/尚未尝试发送/);
 const consent=validateDecision(v,config,{kind:'reply',memory:{resume:{status:'unknown',capabilities:{agreeEnabled:true,defaultResumeName:'另一个附件.pdf'}}}});assert.equal(consent.action,'hold');
 assert.equal(validateDecision(v,config,{kind:'reply',memory:{resume:{status:'unknown',capabilities:{agreeEnabled:true,defaultResumeName:'游戏策划简历.pdf'}}}}).action,'send_resume');
});
test('主人确认已发使追问旧稿作废，正文与附件状态一起进入跟进模型；仅恢复未执行目标',async t=>{
 let context;const port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'resume-flow-')),port,key:'fixture',inference:async(c,k,input)=>{context=input;return {action:'send_text',text:'您好，主人已发过附件简历，想了解一下筛选进展。',reason:'跟进已发简历',score:90};}});
 await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));const base=`http://127.0.0.1:${port}`,session=await(await fetch(base+'/api/session')).json();
 const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?session.token:session.extensionToken},...(d?{body:JSON.stringify(d)}:{})});return {httpStatus:r.status,...await r.json()};};
 await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京']}});
 const target={name:'甲先生',company:'测试游戏'},messages=[{id:'request1',role:'hr',text:'我想要一份您的附件简历，您是否同意'}],{peerId}=await api('/api/chat/resolve',{...target,uniquePeer:true,header:'甲先生 测试游戏',messages},false);
 const {plan}=await api('/api/owner-chat',{kind:'followup',requestId:'resume-followup',instruction:'询问进度',targets:[target]}),selection={...target,planId:plan.id,targetId:plan.targets[0].id,uniquePeer:true,header:'甲先生 测试游戏',messages};
 const {task:old}=await api('/api/owner-chat/prepare',selection,false);assert.equal(old.status,'approved');assert.equal((await api('/api/chat/resume-confirm',{...target,peerId},false)).httpStatus,403);
 assert.equal((await api('/api/chat/resume-confirm',{...target,peerId,evidence:'主人确认已经同意发送，网页提示附件已发',filenameLabel:'某同学_游...'})).status,'resume_sent_followup');assert.equal(app.state.tasks[0].status,'stale');assert.equal(app.state.ownerChats[0].targets[0].status,'queued');
 const {task}=await api('/api/owner-chat/prepare',selection,false);assert(task);assert.equal(context.memory.resume.status,'sent');assert.equal(context.memory.resume.receipts[0].source,'owner_confirmation');assert.match(context.owner_request.instruction,/附件简历已发送/);
 await api('/api/stop',{reason:'重启测试'},false);assert.equal((await api('/api/owner-chat/resume',{planId:plan.id},false)).httpStatus,403);assert.equal((await api('/api/owner-chat/resume',{planId:plan.id})).plan.status,'queued');
});
test('多HR计划中的附件确认不串到另一位HR',async t=>{
 const contexts=[],port=await testPort(),app=createApplication({local:mkdtempSync(join(tmpdir(),'resume-scope-')),port,key:'fixture',inference:async(c,k,ctx)=>{contexts.push(ctx);return {action:'send_text',text:'您好，帮主人了解一下目前的进度。',reason:'跟进进度',score:90};}});await new Promise(r=>app.server.listen(port,'127.0.0.1',r));t.after(()=>new Promise(r=>{app.server.close(r);app.server.closeAllConnections();}));const base=`http://127.0.0.1:${port}`,{token,extensionToken}=await(await fetch(base+'/api/session')).json();
 const api=async(p,d,owner=true)=>{const r=await fetch(base+p,{method:d?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':owner?token:extensionToken},...(d?{body:JSON.stringify(d)}:{})});const v=await r.json();assert(r.ok,v.error);return v;};await api('/api/config',{mode:'auto',browserCalibrated:true,learningEnabled:false,limits:{hoursStart:0,hoursEnd:24},profile:{name:'测试主人',facts:'2027届本科生',titles:['游戏策划'],cities:['北京']}});
 const targets=[{name:'甲先生',company:'测试甲'},{name:'乙女士',company:'测试乙'}],{plan}=await api('/api/owner-chat',{kind:'followup',requestId:'scope-test',instruction:'分别询问两位HR求职进度',targets}),selection=i=>({...targets[i],planId:plan.id,targetId:plan.targets[i].id,uniquePeer:true,header:targets[i].name+' '+targets[i].company,messages:[{id:'m-'+i,role:'hr',text:'你好'}]});
 const {peerId}=await api('/api/chat/resolve',selection(0),false);await api('/api/chat/resume-confirm',{...targets[0],peerId,evidence:'主人确认甲先生已收到附件'});const {task}=await api('/api/owner-chat/prepare',selection(0),false),lease=await api('/api/claim',{id:task.id,peerId:task.peerId,fingerprint:task.fingerprint},false);await api('/api/complete',{id:task.id,lease:lease.lease,success:true,evidence:'同一会话出现新MID'},false);app.state.lastAction=0;
 await api('/api/owner-chat/prepare',selection(1),false);assert.equal(contexts[0].memory.resume.status,'sent');assert.match(contexts[0].owner_request.instruction,/已确认此HR附件简历已发送/);assert.equal(contexts[1].memory.resume.status,'unknown');assert(!contexts[1].owner_request.instruction.includes('已确认此HR附件简历已发送'));
});
