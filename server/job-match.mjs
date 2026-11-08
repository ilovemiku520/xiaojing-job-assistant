import {careerRejection} from './career.mjs';

export function jobURL(value){
  const url=new URL(String(value));
  if(url.origin!=='https://www.zhipin.com'||!/^\/job_detail\/[\w-]+\.html$/.test(url.pathname))throw Error('岗位链接无效');
  return url.origin+url.pathname;
}

export function favoriteSourceURL(value){
  try{
    const url=new URL(value);
    if(url.origin!=='https://www.zhipin.com'||url.username||url.password||!/^\/web\/geek\/recommend\/?$/.test(url.pathname))return '';
    const route=new URLSearchParams();
    for(const key of ['tab','sub','page','tag']){
      const values=url.searchParams.getAll(key);
      if(!values.length)continue;
      if(values.length!==1||!/^(?:0|[1-9]\d{0,5})$/.test(values[0])||key==='page'&&values[0]==='0')return '';
      route.set(key,values[0]);
    }
    return route.get('tab')==='4'?url.origin+url.pathname+'?'+route:'';
  }catch{return '';}
}

const locationPrefix=/^(?:工作(?:城市|地点|地址)|城市|地点|地址)\s*:\s*/u;
const citySeparator=/[·•・∙|\/,、;(>\r\n\t]|(?<=\p{Script=Han})\s*[-–—]\s*(?=\p{Script=Han})|\s+[-–—]\s+/u;
const cityLabel=value=>String(value??'').normalize('NFKC').trim();
const cityKey=label=>label.trim().replace(/市$/u,'').replace(/\s+/g,' ').toLowerCase();

export function matchesJobCity(value,cities,{allowMissing=false}={}){
  const label=cityLabel(value);
  if(!label)return allowMissing;
  // The leading city is authoritative. Later segments may describe streets or qualifications.
  const city=cityKey(label.replace(locationPrefix,'').split(citySeparator,1)[0]);
  return !!city&&cities?.some(name=>cityKey(cityLabel(name))===city)===true;
}

const monthlyThousands=/^(\d+(?:\.\d+)?)\s*(?:k?\s*[-~至]\s*(\d+(?:\.\d+)?)\s*)?k(?:\s*\/\s*月)?(?:\s*[·×x*]\s*\d{1,2}\s*薪)?$/i;
const yuanAmount=String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const monthlyYuan=new RegExp(String.raw`^(${yuanAmount})\s*(?:元?\s*[-~至]\s*(${yuanAmount})\s*)?元\s*\/\s*月$`);

function monthlySalaryRange(value){
  const label=String(value||'').normalize('NFKC').trim().replace(/[‐‑‒–—−]/g,'-');
  const thousands=label.match(monthlyThousands),amounts=thousands||label.match(monthlyYuan);
  if(!amounts)return null;
  const scale=thousands?1:1000;
  const min=Number(amounts[1].replaceAll(',',''))/scale;
  const max=Number((amounts[2]||amounts[1]).replaceAll(',',''))/scale;
  return min>0&&max>=min&&Number.isFinite(max)?{min,max}:null;
}

export function matchJob(job,p) {
  const title=String(job.title||'').toLowerCase();
  if(!title||!job.company) return '岗位或公司未识别';
  if(!p.titles.some(x=>title.includes(x.toLowerCase()))) return '岗位不匹配';
  if(!matchesJobCity(job.city,p.cities)) return '城市不匹配或缺失';
  if(p.exclusions.length){
    const text=JSON.stringify(job).toLowerCase();
    if(p.exclusions.some(x=>text.includes(x.toLowerCase()))) return '命中排除词';
  }
  const careerReason=careerRejection(job,p);if(careerReason)return careerReason;
  if(p.salaryMin||p.salaryMax){
    const salary=monthlySalaryRange(job.salary);
    if(!salary) return '月薪不明确，需要人工查看';
    if(p.salaryMin&&salary.max<p.salaryMin) return '低于最低薪资';
    if(p.salaryMax&&salary.min>p.salaryMax) return '高于目标薪资范围';
  }
  return '';
}
