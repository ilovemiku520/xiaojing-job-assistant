import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyJobProgress,projectJobProgress} from '../server/job-progress.mjs';
import {parseSelfAttachmentReceipt} from '../server/resume-state.mjs';

const boss='https://www.zhipin.com';
const url=id=>boss+'/job_detail/'+id+'.html';
const jobs=(...ids)=>Object.fromEntries(ids.map(id=>[id,{id,url:url(id),title:'游戏策划实习',company:'同名公司'}]));
const message=(id,observedAt=50,role='self')=>({id,observedAt,role,source:'boss_dom',text:'我们沟通过这个岗位'});
const send=(id,jobId,status,extra={})=>({id,kind:'greeting',action:'send_text',status,updatedAt:100,job:{url:url(jobId)},text:'您好，想了解实习岗位。',...extra});
const textProof='同一会话出现新消息编号 fixture-mid 及本次完整正文（忽略时间与送达标签）';
const resumeProof='同一HR会话出现新的附件发送结果：您的附件简历 测试... 已发送给Boss；已核对指定站内附件名称';

test('结构化站内附件卡片确认已发而不计为小鲸新发，也不串到其他岗位',()=>{
  const receipt=parseSelfAttachmentReceipt({source:'self_attachment_card',messageId:'manual-attachment-1',filenameLabel:'合成简历.pdf'});
  const state={jobs:jobs('original','other','forged'),memories:{
    peer:{job:{url:url('original')},resume:{receipts:[{...receipt,observedAt:82}]}},
    forged:{job:{url:url('forged')},resume:{receipts:[{...receipt,id:'other',observedAt:90}]}}
  }};
  assert.deepEqual(projectJobProgress(state),{original:{status:'resume_sent',at:82,contact:'history',resume:'confirmed',pending:null,uncertain:false}});
  state.memories.peer.jobHistory=[{job:{url:url('original')},archivedAt:100}];state.memories.peer.job={url:url('other')};
  assert.deepEqual(projectJobProgress(state),{});
});

test('岗位进度只关联规范岗位链接或精确任务岗位 ID，不按公司、职位、联系人猜测',()=>{
  const state={jobs:jobs('alpha','beta','gamma','delta','epsilon'),tasks:[
    send('valid','alpha','sent',{job:{url:url('alpha')+'?tracking=temporary'},evidence:textProof}),
    send('missing-link','beta','sent',{job:{title:'游戏策划实习',company:'同名公司'},evidence:textProof}),
    send('mismatched-id','gamma','sent',{job:{id:'delta',url:url('gamma')},evidence:textProof}),
    send('fake-host','epsilon','sent',{job:{url:'https://www.zhipin.com.example.test/job_detail/epsilon.html'},evidence:textProof}),
    send('credentials','epsilon','sent',{job:{url:'https://private@www.zhipin.com/job_detail/epsilon.html'},evidence:textProof}),
    send('id-only','delta','approved',{job:{id:'delta'}})
  ],memories:{sameLabel:{job:{title:'游戏策划实习',company:'同名公司'},history:[message('known')]}}};
  assert.deepEqual(projectJobProgress(state),{
    alpha:{status:'message_sent',at:100,contact:'verified_send',resume:'unknown',pending:null,uncertain:false},
    delta:{status:'pending',at:100,contact:'unknown',resume:'unknown',pending:'pending',uncertain:false}
  });
  assert.equal(emptyJobProgress.status,'unobserved');
});

test('历史我方或 HR 消息只证明站内往来，历史重复招呼、缺失和错误回执不计新发送',()=>{
  const state={jobs:jobs('history','incoming','existing','missing','wrong','structured','platform','legacy'),tasks:[
    send('old-existing','existing','sent',{evidence:'聊天记录已存在完全相同的招呼语，未重复发送'}),
    send('unproven','missing','sent',{evidence:'发送成功'}),
    send('wrong-message','wrong','sent',{receipt:{messageId:'stable',observedText:'其他正文'},evidence:textProof}),
    send('structured','structured','sent',{receipt:{messageId:'new',observedText:'20:12 已读 您好，想了解实习岗位。',observedAt:95}})
  ],memories:{
    history:{job:{url:url('history')},history:[message('old-self'),{...message(''),observedAt:500}, {...message('other-source'),source:'model_summary',observedAt:600}]},
    hr:{job:{url:url('incoming')+'?foo=bar'},history:[message('old-hr',51,'hr')]},
    platform:{job:{url:url('platform')},history:[{...message('system-like'),text:'快来与这位HR打个招呼'},{...message(''),text:'这是无编号的内容'}]},
    legacy:{job:{url:url('legacy')},history:[message('old-confirmed')],sends:[{status:'sent',action:'send_text',messageId:'old-confirmed',text:'我们沟通过这个岗位',at:88}]}
  }};
  const result=projectJobProgress(state);
  assert.deepEqual(Object.keys(result),['history','incoming','existing','structured','legacy']);
  assert.equal(result.history.status,'contacted');
  assert.equal(result.history.contact,'history');
  assert.equal(result.history.at,50);
  assert.equal(result.incoming.contact,'history');
  assert.equal(result.existing.contact,'history');
  assert.equal(result.structured.status,'message_sent');
  assert.equal(result.structured.at,95);
  assert.equal(result.legacy.status,'message_sent');
  assert.equal(result.legacy.at,88);
});

test('结果待核对优先，保留已核实发送、简历与正在执行信息，并区分被动候选与实际排队',()=>{
  const state={jobs:jobs('alpha','candidate','queued-work','resume','fake-resume'),tasks:[
    send('sent','alpha','sent',{evidence:textProof}),
    send('uncertain','alpha','uncertain',{kind:'followup',updatedAt:120}),
    send('sending','alpha','executing',{kind:'reply',updatedAt:110}),
    send('resume','resume','sent',{kind:'reply',action:'send_resume',evidence:resumeProof,updatedAt:85}),
    send('held','fake-resume','hold',{kind:'reply',action:'send_resume',evidence:resumeProof}),
    send('fake','fake-resume','sent',{kind:'reply',action:'send_resume',evidence:'同一HR会话出现新的附件发送结果：这是一条回复草稿'})
  ],greetingPlans:[{id:'plan',status:'queued',createdAt:55,targets:[
    {jobId:'candidate',status:'queued'},{jobId:'queued-work',status:'generating',updatedAt:65}
  ]}],memories:{
    alpha:{job:{url:url('alpha')},resume:{status:'sent',receipts:[{id:'sidebar',status:'sent',source:'sidebar',raw:'您的附件简历 测试... 已发送给Boss',observedAt:70,lastSeenAt:400}]}},
    fake:{job:{url:url('fake-resume')},resume:{status:'sent',receipts:[{id:'fake',status:'sent',source:'chat_notice',raw:'请发一份附件简历',observedAt:60}]}}
  }};
  const result=projectJobProgress(state);
  assert.deepEqual(result.alpha,{status:'receipt_uncertain',at:120,contact:'verified_send',resume:'confirmed',pending:'sending',uncertain:true});
  assert.deepEqual(result.resume,{status:'resume_sent',at:85,contact:'verified_send',resume:'confirmed',pending:null,uncertain:false});
  assert.deepEqual(result['queued-work'],{status:'pending',at:65,contact:'unknown',resume:'unknown',pending:'pending',uncertain:false});
  assert.equal(result.candidate,undefined);
  assert.equal(result['fake-resume'],undefined);
  state.memories.alpha.resume.receipts[0].lastSeenAt=999;
  state.memories.alpha.lastSeenAt=999;
  state.jobs.alpha.lastSeenAt=999;
  assert.deepEqual(projectJobProgress(state),result);
});

test('会话换岗位后，旧会话级消息与简历不转移到新岗位，独立已核对操作保持在原链接',()=>{
  const state={jobs:jobs('original','new','unlisted-old','archive-no-link','current'),tasks:[
    send('old','original','sent',{peerId:'changed',kind:'followup',evidence:textProof}),
    send('old-unlisted','outside-job-table','sent',{peerId:'other',kind:'followup',evidence:textProof})
  ],memories:{
    changed:{peerId:'changed',job:{url:url('new')},jobHistory:[{job:{url:url('original')},archivedAt:75}],history:[message('previous-contact',90)],resume:{receipts:[{id:'prior-owner',source:'owner_confirmation',status:'sent',raw:'主人确认之前已发',observedAt:70}]}},
    other:{peerId:'other',job:{url:url('unlisted-old')},history:[message('prior-outside')]},
    archived:{peerId:'archive',job:{url:url('archive-no-link')},jobHistory:[{job:{title:'旧职位'},archivedAt:75}],history:[message('unattributed')]},
    current:{peerId:'current',job:{url:url('current')},jobHistory:[{job:{url:url('current')+'?older=1'},archivedAt:75}],resume:{receipts:[{id:'current-owner',source:'owner_confirmation',status:'sent',raw:'主人确认该岗位简历已发',observedAt:71,lastSeenAt:400}]}}
  }};
  assert.deepEqual(projectJobProgress(state),{
    original:{status:'message_sent',at:100,contact:'verified_send',resume:'unknown',pending:null,uncertain:false},
    current:{status:'resume_sent',at:71,contact:'history',resume:'confirmed',pending:null,uncertain:false}
  });
});

test('准确委托绑定提供岗位 ID；任务最新回执覆盖会话中的旧副本',()=>{
  const task=send('greeting','wrong','approved',{job:{title:'精确委托'},greetingPlanId:'plan',greetingTargetId:'target'});
  const state={jobs:jobs('target','reply'),greetingPlans:[{id:'plan',status:'queued',targets:[{id:'target',jobId:'target',taskId:task.id,status:'ready'}]}],tasks:[
    task,send('followup','reply','sent',{kind:'followup',peerId:'peer',evidence:textProof})
  ],memories:{reply:{peerId:'peer',job:{url:url('reply')},sends:[{taskId:'followup',action:'send_text',status:'uncertain',at:90}]}}};
  const result=projectJobProgress(state);
  assert.equal(result.target.status,'pending');
  assert.equal(result.reply.status,'message_sent');
  assert.equal(result.reply.uncertain,false);
  task.greetingTargetId='mismatch';
  assert.equal(projectJobProgress(state).target,undefined);
});
