// This is a narrow goal check for an authenticated owner's progress enquiry.
// It neither authorizes a send nor changes hold/skip decisions. The resulting
// text must still pass the normal decision, recipient and receipt checks.
const compact=value=>String(value||'').replace(/\s+/g,'');

function asksForProgress(instruction){
 const text=compact(instruction);
 // The legacy owner-chat route also carries first greetings. An explicit
 // request to make an opening must not acquire invented application history.
 const openingText=text.replace(/(?:不要|不能|别|并非|不是).{0,8}(?:首次|初次|第一次)?(?:开场|打招呼)/g,'');
 if(/(?:首次|初次|第一次).{0,6}(?:开场|招呼|沟通)|当作.{0,6}(?:开场|招呼)/.test(openingText))return false;
 if(/(?:不要|不用|不必|无需|别)(?:再)?(?:询问|问|追问|跟进).{0,6}(?:进度|进展|结果)/.test(text))return false;
 return /进度|进展|筛选(?:结果|情况)|(?:负责人|简历).{0,16}(?:看得怎么样|看过没有|看得如何|审核结果|有没有反馈)|(?:应聘|投递|面试|筛选).{0,8}(?:到哪一步|有(?:没有|无)结果|有消息了吗)/.test(text);
}

function isProgressEnquiry(value){
 const text=compact(value);
 const topic=/进度|进展|结果|反馈|筛选|审核|负责人|简历.{0,8}(?:看|审)|到哪一步|下一步|后续安排/.test(text);
 if(!topic)return false;
 const directQuestion=/请问|想问|询问|是否|有没有|怎么样|如何|什么时候|哪一步|有.{0,5}消息|能否|方便.{0,12}(?:告知|说|问)|可以.{0,12}(?:告知|告诉|了解|问)|[?？]/.test(text);
 if(directQuestion)return true;
 // A polite declarative enquiry is fine; promising to ask somebody later is
 // not the same as asking this HR now.
 if(/(?:我会|稍后|之后|会去|再去).{0,12}(?:询问|跟进|问|了解)/.test(text))return false;
 return /(?:想|希望).{0,8}(?:了解|跟进)|(?:帮|替)主人.{0,8}跟进|跟进一下|烦请.{0,8}(?:告知|反馈)/.test(text);
}

function correctionRequested(instruction){
 const text=compact(instruction);
 return /解释|说明|道歉|致歉|抱歉/.test(text)&&/重复|刚才.{0,8}回复|(?:回复|消息).{0,8}(?:出错|偏差)/.test(text);
}

function authorshipCorrectionRequested(instruction){
 return /消息来源|消息作者|作者|归属|(?:主人|小鲸).{0,6}(?:发的|发出)/.test(compact(instruction));
}

export function enforceFollowupGoal(value,context={},_target={}){
 if(context.kind!=='followup'||value?.action!=='send_text'||typeof value.text!=='string')return value;
 const instruction=context.owner_request?.instruction||'';
 if(!asksForProgress(instruction))return value;
 if(isProgressEnquiry(value.text))return {...value,followupGoal:{kind:'progress',repaired:false}};
 const incoming=compact(context.messages?.filter(m=>m.role==='hr').at(-1)?.text);
 const reviewPending=/(?:简历.{0,12}(?:负责人|领导)|(?:负责人|领导).{0,12}简历)/.test(incoming)&&/看|审|筛选|反馈/.test(incoming);
 const enquiry=reviewPending?'想帮主人跟进一下，负责人那边简历看得怎么样了？目前有筛选结果了吗？':'想帮主人跟进一下，之前沟通的岗位目前进展怎么样了？还需要补充什么材料吗？';
 const explanation=correctionRequested(instruction)?'刚才的回复重复了，是我这边处理出了点偏差'+(authorshipCorrectionRequested(instruction)?'，也没有区分好主人和我各自发出的消息':'')+'，抱歉。':'';
 return {...value,text:explanation+enquiry,reason:'落实主人要求，询问实际筛选进度',followupGoal:{kind:'progress',repaired:true}};
}
