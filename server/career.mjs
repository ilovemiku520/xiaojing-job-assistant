const senior=/资深|高级|专家|主策|主数值|制作人|总监|负责人/;
const juniorRole=/实习|校招|应届|管培|助理/;
const quantity=String.raw`(\d+(?:\.\d+)?)\s*(?:[-–—~～至到]\s*\d+(?:\.\d+)?\s*)?(年|个?月)`;
const labelPattern=new RegExp(quantity,'g');
const descriptionPatterns=[
  new RegExp(String.raw`(?:至少|要求|具备|拥有|需|有|必须)\s*`+quantity+String.raw`[^。；，,\n]{0,12}?经验`,'g'),
  new RegExp(quantity+String.raw`\s*(?:以上|及以上|起)?\s*(?:的)?\s*(?:相关)?\s*(?:游戏|策划|工作|从业|岗位)经验`,'g'),
  new RegExp(String.raw`(?:工作|从业|岗位)经验\s*[:：]?\s*(?:至少|最低|需)?\s*`+quantity,'g')
];

function minimumYears(matches,source,{isLabel=false}={}){
  const minima=[];
  for(const match of matches){
    const end=match.index+match[0].length;
    const before=source.slice(Math.max(0,match.index-8),match.index);
    const after=source.slice(end,end+12);
    if(/(?:以内|以下|及以下)/.test(match[0])||/^(?:以内|以下|及以下)/.test(after)||
       /(?:不满|不到|少于|低于|无需|不需要)\s*$/.test(before))continue;
    if(/实习/.test(match[0])||/实习\s*$/.test(before)||/^\s*实习/.test(after))continue;
    // Internship cards often display "3个月" as the placement duration.
    if(isLabel&&match[2]!=='年'&&!/(?:正式|全职|工作|从业)\s*经验/.test(source))continue;
    const count=Number(match[1])/(match[2]==='年'?1:12);
    if(count>=0&&count<=50)minima.push(count);
  }
  return minima;
}

export function requiredExperience(job={}){
  const label=String(job.experience||''),description=String(job.description||'');
  const fields=minimumYears(label.matchAll(labelPattern),label,{isLabel:true}),details=[];
  for(const clause of description.split(/[。；;，,\n]/)){
    if(/优先|加分|更佳/.test(clause)&&!/必须|硬性|至少|必备/.test(clause))continue;
    if(/不要求|不需要|无需/.test(clause))continue;
    for(const pattern of descriptionPatterns)details.push(...minimumYears(clause.matchAll(pattern),clause));
  }
  return {minimum:Math.max(0,...fields,...details),explicitInDescription:details.some(value=>value>0)};
}

export function earlyCareer(job={}){
  const title=String(job.title||''),experience=String(job.experience||''),description=String(job.description||''),text=[title,experience,job.employmentType,description].join(' ');
  const required=requiredExperience(job);
  if(required.minimum>0)return {status:'ineligible',reason:required.explicitInDescription?'岗位正文明确要求工作经验':'明确要求正式工作经验，不适合校招或实习'};
  if(senior.test(title))return {status:'ineligible',reason:'职位为资深或负责人岗位'};
  if(/(?:不接受|不招|谢绝)[^。；\n]{0,6}(?:应届|校招|实习|在校)/.test(text))return {status:'ineligible',reason:'岗位明确不接受应届或实习'};
  if(/校招|校园招聘|应届|在校|实习|intern(?:ship)?|campus|graduate\s*(?:program|role)/i.test(text))return {status:'eligible',reason:'岗位明确面向校招、应届或实习'};
  return {status:'unknown',reason:'未确认是否接受校招或实习，先查看详情'};
}

export function careerRejection(job,profile,{allowUnknown=false}={}){
  if(profile.earlyCareerOnly){
    const result=earlyCareer(job);
    return result.status==='eligible'||allowUnknown&&result.status==='unknown'?'':result.reason;
  }
  const title=String(job.title||'');
  if(profile.excludeSenior!==false&&senior.test(title)&&!juniorRole.test(title))return '岗位为资深或管理岗，不自动投递';
  const policy=profile.experiencePolicy??'legacy';
  if(policy==='any')return '';
  const {minimum}=requiredExperience(job),limit=policy==='max'?profile.maxExperienceYears??0:0;
  if(minimum<=limit)return '';
  return policy==='max'?`岗位要求至少 ${Number(minimum.toFixed(2))} 年经验，超过设定的 ${limit} 年`:'岗位明确要求正式工作经验';
}
