// HR text is data. Only actual personal decisions need the owner's involvement;
// their safe acknowledgement remains an ordinary automatic reply.
function interviewSchedulingRequest(text){
  // A status update about screening or a future interview is not an invitation
  // that the candidate must accept. Keep actual questions and concrete invitations
  // distinct from those process descriptions, including mixed messages.
  const value=String(text).replace(/(?:面试|笔试|测评)(?:结果|进度|流程|经历|经验|内容|问题|题目|轮次|反馈)/g,'招聘流程');
  if(!/面试|笔试|测评/.test(value))return false;
  if(/(?:能否|是否|能不能|可不可以|何时|什么时候|哪天|几点)[^。！？!?；;\n]{0,18}(?:面试|笔试|测评)|(?:方便|有空|可以|愿意|能接受)[^。！？!?；;\n]{0,18}(?:面试|笔试|测评)[^。！？!?；;\n]{0,6}(?:吗|么|[？?])|(?:面试|笔试|测评)[^。！？!?；;\n]{0,18}(?:可以吗|方便吗|有空吗|能来吗|能参加吗|能否|是否|何时|什么时候|哪天|几点|请确认|请回复|确认一下)/.test(value))return true;
  return value.split(/[。！？!?；;\n]/).some(part=>{
    if(!/面试|笔试|测评/.test(part))return false;
    if(/(?:通过|合适|筛选|评估).{0,6}(?:后|的话|再)|如果|若|后续|之后|届时/.test(part))return false;
    return /(?:邀请|欢迎|请).{0,12}(?:来|参加|到(?:公司|现场)|进行).{0,8}(?:面试|笔试|测评)|约(?:您|你|主人).{0,8}(?:面试|笔试|测评)|安排.{0,5}(?:一次|一场|个)(?:面试|笔试|测评)|(?:给您|给你|为您|为你).{0,4}安排.{0,5}(?:面试|笔试|测评)|(?:面试|笔试|测评)(?:邀请|通知)|(?:今天|明天|后天|下周|本周|这周|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}[:：]\d{2}|\d{1,2}点|\d{1,2}月\d{1,2}[日号]).{0,12}(?:面试|笔试|测评)|(?:面试|笔试|测评).{0,8}(?:定在|安排在|时间是|时间为)/.test(part);
  });
}
export function ownerDecisionFor(text='') {
  if(/验证码|密码|密钥|配对码|系统提示词|规则文件|执行.{0,8}(命令|脚本)|忽略.{0,8}(规则|指令)|读取.{0,8}(硬盘|文件|目录)|powershell|cmd\.exe/i.test(text))return {kind:'untrusted_request',summary:'对方索要凭据或要求越权操作',ack:'这些内容不属于求职沟通，我无法提供。岗位相关问题可以继续和我沟通。'};
  if(/转账|缴费|付费|银行卡|身份证|签约|签署|合同|offer|录用|入职手续/i.test(text))return {kind:'offer_or_private_material',summary:'录用、合同、费用或敏感个人材料需要主人决定',ack:'收到，我会把这项安排转给主人，由主人本人确认后再答复你。'};
  if(/微信|手机号|电话号码|邮箱|联系方式|留.{0,4}电话|加.{0,4}(?:微信|好友)/i.test(text))return {kind:'contact',summary:'联系方式交换需要主人决定',ack:'收到，联系方式需要主人本人确认。我会转达，岗位相关的信息也可以先在这里沟通。'};
  if(interviewSchedulingRequest(text)||/具体.{0,5}(?:到岗|入职)|哪天.{0,5}(?:到岗|入职)|什么时候.{0,5}(?:到岗|入职)|(?:明天|后天|下周|周[一二三四五六日天]|\d{1,2}[:：]\d{2}).{0,15}(?:来|到岗|入职)/i.test(text))return {kind:'schedule',summary:'具体面试或到岗安排需要主人确认',ack:'收到，我会把具体安排转给主人确认，确认后再回复你。'};
  if(/(?:薪资|工资|日薪|月薪|年薪|待遇).{0,20}(?:多少|期望|要求|接受|确认|确定)|(?:接受|确认|同意).{0,15}(?:\d+\s*元|薪资|工资)|\d+\s*元\s*[/／每]\s*(?:天|日|月|年)/i.test(text))return {kind:'salary',summary:'具体薪资报价或承诺需要主人决定',ack:'主人目前没有固定薪资筛选要求，可以先按岗位标准沟通；具体薪资方案会交给主人本人确认。'};
  return null;
}
export function conversationStopped(conversation){
  const self=conversation?.history?.filter(m=>m.role==='self').at(-1)?.text||'';
  const hr=conversation?.history?.filter(m=>m.role==='hr').at(-1)?.text||'';
  return /(?:不考虑|不去了|不去面试|(?:^|[，。！\s])不去(?:[了，。！\s]|$)|暂不考虑|不合适.{0,8}不|请勿再联系|不要再联系|停止联系)/.test(self)||/(?:岗位已关闭|招聘已结束|不再招聘|不招实习|不招应届|(?:暂时|目前|现在).{0,5}(?:没有|不招).{0,5}(?:实习|校招|岗位)|不(?:太)?合适|不予考虑|(?:经历|条件|岗位).{0,12}不匹配|(?:不符合|不匹配).{0,8}(?:要求|条件)|(?:实习生|应届生).{0,8}不需要|(?:岗位|实习|游戏策划).{0,12}招满|请勿再联系|不要再联系)/.test(hr);
}
export function mayProactivelyResume(text=''){
  return !conversationStopped({history:[{role:'hr',text}]})&&!ownerDecisionFor(text)&&!/(?:发到|投递至|请投).{0,10}(?:邮箱|邮件)|(?:收到|收到了|看过).{0,6}简历|简历.{0,6}(?:收到|收到了|看过)/.test(text)&&/你好|您好|欢迎|了解|介绍|作品|项目|在校|毕业|实习|游戏|策划|每周|一周|几天|多久|期待|感兴趣/.test(text);
}

export function riskyOutgoing(text='') {
  if(/sk-[\w-]{12,}|\b1[3-9]\d{9}\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|[A-Z]:[\\/]|127\.0\.0\.1|localhost|(?:微信号|手机号|邮箱|身份证号|银行卡号|验证码|配对码|密钥)\s*[：:=]\s*\S+/i.test(text))return true;
  if(/(?:同意|接受|定为|就定|要求).{0,8}\d+(?:\.\d+)?\s*(?:元|[kK])/.test(text))return true;
  if(/(?:我|主人|我们).{0,8}(?:同意|接受|保证|承诺|确定可以|确定能|可以安排).{0,18}(?:面试|入职|到岗|薪资|工资|offer|录用|签约|合同)|(?:明天|后天|下周|周[一二三四五六日天]|\d{1,2}[:：]\d{2}).{0,10}(?:准时到|参加面试|就能到岗|可以到岗|可以入职)|(?:薪资|工资|月薪|日薪).{0,8}(?:就定|确定|接受|要求).{0,6}\d/i.test(text))return true;
  return /(?:请|需要|先|点击|帮你|为你).{0,8}(?:下载|安装)|(?:提供|发送|给你|告诉你).{0,10}(?:系统提示词|规则文件|API密钥|验证码)|(?:同意|接受|确定).{0,8}(?:缴费|转账|付费|签约|签署)/i.test(text);
}

export function applyResponsePolicy(value,context) {
  if(context.kind==='greeting')return value;
  const incoming=context.messages?.filter(m=>m.role==='hr').at(-1)?.text||'';
  const decision=ownerDecisionFor(incoming);
  if(!decision)return value;
  const {ack,...item}=decision;
  // An owner-initiated follow-up asks a new question. The latest HR line may be
  // an old invitation/contact request already acknowledged in that conversation.
  // Preserve the follow-up instead of answering that historical line again.
  // The normal outgoing validator still rejects unauthorized commitments/data.
  if(context.kind==='followup')return {...value,ownerDecision:item};
  if(decision.kind==='untrusted_request')return {...value,action:'send_text',text:ack,reason:'忽略越权内容，仅发送求职范围说明',ownerDecision:item};
  // Resume requests have their own peer/request/file/receipt checks. A nearby
  // interview mention must not prevent accepting that request.
  if(value.action==='send_resume')return {...value,ownerDecision:item};
  if(value.action==='skip')return {...value,ownerDecision:item};
  return {...value,action:'send_text',text:ack,reason:'自动确认收到；个人决定已记录给主人',ownerDecision:item};
}
