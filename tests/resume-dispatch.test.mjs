import test from 'node:test';
import assert from 'node:assert/strict';
import {resumeNameMatches,resumeDispatchPlan,observeResumeUI} from '../server/resume-state.mjs';
test('附件名称仅接受完整名称或主人显式别名，显示省略pdf后缀可匹配',()=>{
 assert(resumeNameMatches('游戏策划简历','游戏策划简历.pdf'));
 assert(resumeNameMatches('旧显示名称.pdf','游戏策划简历.pdf',['旧显示名称.pdf']));
 assert(!resumeNameMatches('测试求职者_游...','游戏策划简历.pdf'));
 assert(!resumeNameMatches('游戏策划简历.docx','游戏策划简历.pdf'));
});
test('未知默认名称需要显式持续授权；有授权只表示站内默认，不冒充文件名核验',()=>{
 const ui={agreeEnabled:true,requestPending:true,requestMessageId:'request-1',defaultResumeName:''};
 assert.equal(resumeDispatchPlan(ui,{resumeName:'游戏策划简历.pdf'}).allowed,false);
 const plan=resumeDispatchPlan(ui,{resumeName:'游戏策划简历.pdf',allowSiteDefaultResume:true});assert.equal(plan.allowed,true);assert.equal(plan.route,'accept_request');assert.equal(plan.attachmentSource,'site_default_owner_authorized');assert.equal(plan.visibleFilename,'');
 assert.equal(resumeDispatchPlan({...ui,receipts:[{text:'已发送'}]},{resumeName:'游戏策划简历.pdf',allowSiteDefaultResume:true}).alreadySent,true);
});
test('请求卡片无附件名时，可使用已识别选择器；已处理请求不再标待同意',()=>{
 const ui={agreeEnabled:true,toolbarEnabled:true,chooserSupported:true};assert.equal(resumeDispatchPlan(ui,{resumeName:'游戏策划简历.pdf'}).route,'choose_attachment');
 const c={};observeResumeUI(c,{requestPending:true,requestHandled:true,agreeEnabled:false,attachmentNames:['游戏策划简历'],defaultResumeEvidence:'visible_default_row'});assert.equal(c.resume.capabilities.requestPending,false);assert.equal(c.resume.capabilities.defaultResumeEvidence,'visible_default_row');assert.deepEqual(c.resume.capabilities.attachmentNames,['游戏策划简历']);
});
