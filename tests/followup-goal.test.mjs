import test from 'node:test';
import assert from 'node:assert/strict';
import {enforceFollowupGoal} from '../server/followup-goal.mjs';
import {riskyOutgoing} from '../server/response-policy.mjs';

const ack={action:'send_text',text:'收到，我会把具体安排转给主人确认，确认后再回复你。',reason:'自动确认',score:90};
const context=instruction=>({kind:'followup',owner_request:{instruction},messages:[{role:'hr',text:'我先把您简历给负责人看下 通过后会邀请来公司面试'}]});

test('明确进度委托中的泛化确认改为实际追问，不声称已安排面试或重复个人信息',()=>{
 const result=enforceFollowupGoal(ack,context('帮主人了解游艺春秋这边的应聘进度，顺着负责人看简历的节点问。'));
 assert.equal(result.action,'send_text');assert.deepEqual(result.followupGoal,{kind:'progress',repaired:true});
 assert.match(result.text,/负责人.*简历.*怎么样/);assert.match(result.text,/筛选结果/);assert(!/转给主人确认|确认后再回复|已发送|已投递|到岗|薪资/.test(result.text));assert(!riskyOutgoing(result.text));
});

test('语义近似的结果询问指令同样生效，礼貌的实际进度询问保持原文',()=>{
 for(const instruction of ['问问负责人那边简历看得怎么样了','替主人打听筛选结果','帮我问下应聘到哪一步了']){
  assert.equal(enforceFollowupGoal(ack,context(instruction)).followupGoal.repaired,true);
 }
 for(const text of ['陈女士您好，负责人那边简历看得怎么样了？','想帮主人跟进一下筛选进度，方便时告知目前的进展，谢谢。','请问已经有反馈了吗？']){
  const result=enforceFollowupGoal({...ack,text},context('询问一下当前进度'));
  assert.equal(result.text,text);assert.equal(result.followupGoal.repaired,false);
 }
 const promised=enforceFollowupGoal({...ack,text:'收到，我会跟进一下筛选进度，再转给主人。'},context('主人希望现在问进度'));
 assert.equal(promised.followupGoal.repaired,true);
});

test('legacy首次开场和否定追问不变；非followup及hold/skip不被放行',()=>{
 for(const instruction of ['不问进度，首次开场','这条是空会话，请当作首次开场，不要写成跟进或追问进度','第一次打招呼，想了解实习招聘情况']){
  assert.equal(enforceFollowupGoal(ack,context(instruction)),ack);
 }
 for(const kind of ['reply','greeting','read'])assert.equal(enforceFollowupGoal(ack,{...context('询问进度'),kind}),ack);
 for(const action of ['skip','hold','send_resume']){const value={...ack,action};assert.equal(enforceFollowupGoal(value,context('询问进度')),value);}
 assert.equal(enforceFollowupGoal(ack,context('不要把询问进度改成首次开场')).followupGoal.repaired,true);
});

test('主人要求解释重复回复时只附一段说明再追问，已有道歉与进度问题保持不变',()=>{
 const instruction='给HR解释刚才重复回复的情况并致歉，接着询问负责人筛选进度，一条消息完成。';
 const result=enforceFollowupGoal(ack,context(instruction));
 assert.match(result.text,/刚才的回复重复了/);assert.match(result.text,/我这边处理出了点偏差/);assert.match(result.text,/负责人.*怎么样/);assert(!/网站|系统故障|HR.*错误/.test(result.text));assert.equal((result.text.match(/抱歉/g)||[]).length,1);
 const text='刚才连续回复了相同的话，抱歉。想帮主人问下，目前筛选到哪一步了？';
 assert.equal(enforceFollowupGoal({...ack,text},context(instruction)).text,text);
 const normal=enforceFollowupGoal(ack,context('帮主人询问目前筛选进度'));
 assert(!/抱歉|重复/.test(normal.text));
});

test('缺少负责人审阅证据时只问岗位进展；输出仍交由原安全检查判断',()=>{
 const result=enforceFollowupGoal(ack,{...context('询问求职进展'),messages:[{role:'hr',text:'你好，欢迎了解我们的岗位。'}]});
 assert.match(result.text,/岗位目前进展怎么样/);assert(!/负责人|已发简历|已提交|面试安排/.test(result.text));assert(!riskyOutgoing(result.text));
 const unsafe={...ack,text:'主人保证明天参加面试，请问目前筛选进度如何？'};
 assert.equal(enforceFollowupGoal(unsafe,context('询问进度')).text,unsafe.text);assert(riskyOutgoing(unsafe.text));
});

test('主人要求解释消息归属时说明区分失误，不声称所有历史作者已确认',()=>{
 const instruction='向HR解释刚才重复回复的情况，也说明消息归属没有分清，主人发的和小鲸发的消息需要区分，再问目前筛选进度。';
 const result=enforceFollowupGoal(ack,context(instruction));
 assert.match(result.text,/也没有区分好主人和我各自发出的消息/);assert.match(result.text,/负责人.*简历.*怎么样/);assert(!/已经完全|所有历史|已经能识别|全部确认/.test(result.text));assert(!riskyOutgoing(result.text));
 const text='刚才没有分清主人和我各自发的消息，还重复回复了，抱歉。想帮主人问下，目前筛选进度怎么样了？';
 assert.equal(enforceFollowupGoal({...ack,text},context(instruction)).text,text);
 const withoutAuthorship=enforceFollowupGoal(ack,context('请解释刚才重复回复并问进度'));
 assert(!/各自发出/.test(withoutAuthorship.text));
});
