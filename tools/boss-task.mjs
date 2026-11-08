// Owner-channel helper. Credentials stay local and are never printed.
import {readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const local=resolve(process.env.BOSS_DATA_DIR||join(root,'.local'));
const port=Number(process.env.PORT??17321);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('控制台端口无效');
const base=`http://127.0.0.1:${port}`;
const token=readFileSync(join(local,'pairing-token'),'utf8').trim();
async function api(path,data){const r=await fetch(base+path,{method:data?'POST':'GET',headers:{'Content-Type':'application/json','X-Boss-Token':token},...(data?{body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error);return v;}
function contacts(){
 const inspection=JSON.parse(readFileSync(join(local,'chat-inspection.json'),'utf8')),nodes=inspection.nodes||[],peers=[];
 for(let i=0;i<nodes.length;i++){
  if(!/(?:^|\s)friend-content(?:\s|$)/.test(nodes[i].attrs?.class||''))continue;
  const parts=[];for(let j=i+1;j<nodes.length&&!/(?:^|\s)friend-content(?:\s|$)|chat-conversation/.test(nodes[j].attrs?.class||'');j++)parts.push(nodes[j]);
  const pos=parts.findIndex(n=>/(?:^|\s)name-text(?:\s|$)/.test(n.attrs?.class||''));if(pos<0)continue;
  const company=parts.slice(pos+1).find(n=>n.text&&!n.attrs?.class)?.text;if(company)peers.push({name:parts[pos].text,company,preview:parts.find(n=>n.attrs?.class==='last-msg-text')?.text,time:parts.find(n=>n.attrs?.class==='time')?.text});
 }return {observedAt:inspection.at,ageSeconds:Math.round((Date.now()-inspection.at)/1000),source:'仅聊天侧栏，不能据此声称已读正文或确认过往约定',peers};
}
try{
 const [command,arg]=process.argv.slice(2);let result;
 if(command==='autonomy')result=await api('/api/autonomy');
 else if(command==='channels')result=await api('/api/channels',arg?JSON.parse(readFileSync(arg,'utf8')):undefined);
 else if(command==='favorites')result=await api('/api/favorites/state');
 else if(command==='discovery')result=await api('/api/discovery');
 else if(command==='replies')result=await api('/api/replies/state');
 else if(command==='search'){if(!arg)throw Error('需要搜索请求JSON');result=await api('/api/search',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='greet'){if(!arg)throw Error('需要招呼委托JSON路径');result=await api('/api/greetings',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='greetings'){result=await api('/api/greetings');if(arg)result.plans=result.plans.filter(p=>p.id===arg);}
 else if(command==='jobs')result=await api('/api/greetings/candidates');
 else if(command==='contacts')result=contacts();
 else if(command==='context-search'){if(!arg)throw Error('需要检索请求JSON路径');result=await api('/api/context/search',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='context-note'){if(!arg)throw Error('需要记忆ID');result=await api('/api/context/note',{id:arg});}
 else if(command==='context')result=await api('/api/context');
 else if(command==='operations')result=await api('/api/operations');
 else if(command==='operation-detail'){if(!arg)throw Error('需要任务查询JSON路径');result=await api('/api/operations/detail',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='project-map')result=await api('/api/project-map');
 else if(command==='submit'){if(!arg)throw Error('需要请求JSON文件路径');result=await api('/api/owner-chat',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='limits'){if(!arg)throw Error('需要发送设置JSON路径');result=await api('/api/limits',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='resolve'){if(!arg)throw Error('需要待核对的任务ID');result=await api('/api/owner-chat/resolve',{taskId:arg});}
 else if(command==='resume'){if(!arg)throw Error('需要未执行的计划ID');result=await api('/api/owner-chat/resume',{planId:arg});}
 else if(command==='confirm-resume'){if(!arg)throw Error('需要主人确认JSON路径');result=await api('/api/chat/resume-confirm',JSON.parse(readFileSync(arg,'utf8')));}
 else if(command==='status'){const s=await api('/api/state');const plans=s.ownerChats.filter(p=>!arg||p.id===arg||p.requestId===arg);result={currentTime:new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}),running:s.config.running,primaryWork:s.autonomy?.primaryWork,favorites:s.favorites,jobDiscovery:s.jobDiscovery,historySweepEnabled:s.config.historySweepEnabled,ownerBusy:s.ownerBusy,limits:s.config.limits,extensionVersion:s.heartbeat.diagnostics?.extensionVersion,plans:plans.map(p=>({...p,targets:p.targets.map(t=>{const task=s.tasks.find(x=>x.id===t.taskId);const safe=task?Object.fromEntries(Object.entries(task).filter(([k])=>k!=='lease')):undefined;return {...t,task:safe};})}))};}
 else if(command==='memory'){const s=await api('/api/state');if(!arg||!Object.hasOwn(s.memories,arg))throw Error('需要已读取的peerId');result=s.memories[arg];}
 else throw Error('用法：node tools/boss-task.mjs contacts | submit 请求.json | status [计划ID] | memory peerId');
 console.log(JSON.stringify(result,null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
