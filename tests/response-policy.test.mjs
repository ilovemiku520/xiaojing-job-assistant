import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDecision,defaults} from '../server/core.mjs';
import {conversationStopped,mayProactivelyResume,ownerDecisionFor} from '../server/response-policy.mjs';
const config={...structuredClone(defaults),mode:'auto'};
const answer={action:'send_text',text:'主人每周可实习4—5天，可以持续3个月以上。',reason:'已核实资料',score:90};
test('已核实实习信息和普通薪资提及可自动沟通；未确认安排只自动确认转交',()=>{
 const normal=validateDecision(answer,config,{kind:'reply',messages:[{role:'hr',text:'每周可以实习几天，能实习多久？'}]});assert.equal(normal.text,answer.text);assert(!normal.ownerDecision);
 const proposal=validateDecision({...answer,text:'可以，明天下午三点我主人到公司。'},config,{kind:'reply',messages:[{role:'hr',text:'明天下午来面试可以吗？'}]});assert.equal(proposal.action,'send_text');assert.equal(proposal.ownerDecision.kind,'schedule');assert(!proposal.text.includes('三点'));assert(proposal.text.includes('确认'));
 const salary=validateDecision({...answer,text:'主人接受500元每月。'},config,{kind:'reply',messages:[{role:'hr',text:'期望薪资多少？'}]});assert.equal(salary.ownerDecision.kind,'salary');assert(!salary.text.includes('500'));
});
test('称呼礼貌但实际拒绝的HR不触发主动附件；欢迎沟通可以',()=>{
 for(const text of ['你好，我们觉得不太合适','您好，您的经历与岗位不匹配','你好，实习生不需要了','您好，游戏策划岗位已经招满了']){assert(conversationStopped({history:[{role:'hr',text}]}));assert(!mayProactivelyResume(text));}
 assert(conversationStopped({history:[{role:'self',text:'不去'}]}));
 assert(!mayProactivelyResume('请把简历发到邮箱'));assert(!mayProactivelyResume('简历收到，感谢介绍'));
 assert(mayProactivelyResume('你好，想了解一下主人的游戏策划项目'));
});
test('同一会话旧履历中提过面试，不干扰本次普通项目问答',()=>{
 const result=validateDecision(answer,config,{kind:'reply',messages:[{role:'hr',text:'明天能面试吗'},{role:'self',text:'安排需要本人确认'},{role:'hr',text:'可以，先介绍下项目吧'}]});assert.equal(result.action,'send_text');assert(!result.ownerDecision);
});

test('简历筛选和后续面试流程说明不冒充需要主人确认的具体安排',()=>{
 for(const text of [
  '我先把您简历给负责人看下，通过后会邀请来公司面试',
  '简历已经提交给负责人，筛选通过后会邀请参加面试。',
  '后续面试流程是先做题，再沟通。',
  '我会联系用人部门，有结果再通知您。',
  '面试结果出来后会通知你。',
  '你的简历还在看，下周给您反馈面试结果。'
 ]){
  assert.equal(ownerDecisionFor(text),null,text);
  const result=validateDecision({...answer,text:'好的，谢谢，期待筛选结果。'},config,{kind:'reply',messages:[{role:'hr',text}]});
  assert.equal(result.text,'好的，谢谢，期待筛选结果。');assert(!result.ownerDecision);
 }
});

test('实际面试邀请、确认问题与到岗时间仍需主人决定，混合流程说明不会掩盖真实邀请',()=>{
 for(const text of ['明天下午来面试可以吗？','邀请您来公司面试。','想约你面试。','这边安排一次面试。','面试定在周五下午两点，请确认一下。','简历通过后会邀请面试。周三方便来参加面试吗？','什么时候方便到岗？','方便线上笔试吗？']){
  assert.equal(ownerDecisionFor(text)?.kind,'schedule',text);
  const result=validateDecision({...answer,text:'主人同意参加面试。'},config,{kind:'reply',messages:[{role:'hr',text}]});
  assert.equal(result.action,'send_text');assert.equal(result.ownerDecision.kind,'schedule');assert(result.text.includes('确认'));assert(!result.text.includes('同意参加'));
 }
});

test('主人委托的进度追问不被历史面试、联系方式或报价改写成重复确认',()=>{
 const followup={...answer,text:'你好，想帮主人跟进一下，简历提交给负责人后，目前筛选有进展了吗？还需要补充什么材料吗？',reason:'主人要求询问进度'};
 for(const text of ['我先把您简历给负责人看下，通过后会邀请来公司面试','明天下午来面试可以吗？','可以留一下手机号吗？','期望薪资多少？']){
  const result=validateDecision(followup,config,{kind:'followup',owner_request:{instruction:'帮我询问过往求职进度'},messages:[{role:'hr',text},{role:'self',text:'收到，我会把具体安排转给主人确认，确认后再回复你。'}]});
  assert.equal(result.action,'send_text');assert.equal(result.text,followup.text);assert.equal(result.reason,followup.reason);
 }
});

test('保留追问目的不放行擅自承诺或泄露联系方式',()=>{
 for(const text of ['主人同意明天下午参加面试。','主人的邮箱是 person@example.com。','主人接受500元每月。']){
  const result=validateDecision({...answer,text},config,{kind:'followup',messages:[{role:'hr',text:'明天下午来面试可以吗？'}]});
  assert.equal(result.action,'hold',text);assert.match(result.reason,/未授权/);
 }
});
