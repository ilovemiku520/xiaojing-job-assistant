import {readdirSync,readFileSync,statSync,existsSync} from 'node:fs';
import {join,posix} from 'node:path';
import {createHash} from 'node:crypto';

const descriptions={
 'public/app.js':['求职工作台','展示状态、提交对话任务、审核消息和管理记忆'],
 'public/control.js':['任务与上下文界面','查看任务进度、停止指定任务、检索跨会话记忆及浏览代码地图'],
 'public/index.html':['工作台入口','各功能页面与表单'],
 'public/style.css':['界面样式','工作台布局和适配'],
 'server/app.mjs':['业务服务与授权','校验用户和扩展身份，组织任务、模型和发送结果'],
 'server/control.mjs':['任务管家','统一投影真实任务状态，追加状态变化记录，停止指定委托'],
 'server/greetings.mjs':['定量招呼队列','持久化指定人数的初次招呼，逐个核验候选、排除重复HR并按回显计数'],
 'server/continuity.mjs':['跨会话检查点','从实际状态生成可追溯摘要，供后续对话任务接续'],
 'server/project-map.mjs':['工程地图生成器','读取源码导入和接口声明，生成当前代码结构图'],
 'public/owner-dialog.js':['任务对话界面','切换独立任务，在同一任务内补充、续聊并查看实时进度'],
 'server/owner-conversations.mjs':['多轮任务上下文','保存任务对话与顺序轮次，关联原生Harness会话并保留历史'],
 'server/harness-events.mjs':['模型运行进度','仅提取阶段和最终答案，不保留思考或工具参数'],
 'server/harness.mjs':['DeepSeek执行器','启动本机Harness，隔离对话、HR和学习频道'],
 'server/browser-redaction.mjs':['浏览器日志过滤','过滤浏览器工具日志中的连接凭据'],
 'server/browser-secret.mjs':['浏览器凭据保管','加密保存自动连接浏览器所需的凭据'],
 'server/career.mjs':['校招与实习匹配','识别在校、应届和工作经验要求'],
 'server/knowledge.mjs':['人格与求职资料','读取当前启用的人格、事实、偏好和项目资料'],
 'server/main.mjs':['服务启动入口','在本机启动工作台服务'],
 'server/tooling.mjs':['本地工具接入','定义对话可用工具和求职操作指南'],
 'server/core.mjs':['求职与发送规则','匹配岗位、校验模型输出、核对发送时段和限额'],
 'server/memory.mjs':['HR原始会话记忆','按会话保存实际消息、职位、版本和发送证据'],
 'server/memory-files.mjs':['会话落盘','保存每个HR的独立文件与索引'],
 'server/learning.mjs':['长期记忆与检索','带来源整理笔记，检索索引和按需返回详情'],
 'server/owner-chat.mjs':['定向委托','管理多HR读取或追问的独立进度'],
 'server/jobs.mjs':['岗位资料库','按对应职位链接管理采集状态'],
 'server/chat-job.mjs':['聊天对应职位','将实际JD绑定到当前HR和职位'],
 'server/resume-state.mjs':['附件发送状态','识别附件发送提示，区分已发与待发送'],
 'server/dom-chat.mjs':['会话身份匹配','按真实消息锚点确认HR身份，导入历史'],
 'server/secret.mjs':['密钥保管','使用本机账户加密存储API凭据'],
 'extension/background.js':['浏览器后台','连接本机服务、调度只读页和发送执行页'],
 'extension/content.js':['BOSS页面执行器','读取可见页面、确认会话、填写消息并核对回显'],
 'extension/position-link.js':['职位入口适配','取得查看职位按钮生成的本站职位链接'],
 'extension/popup.html':['扩展配对弹窗','展示扩展连接和配对操作'],
 'extension/popup.js':['扩展连接设置','保存配对设置、查看连接并载入扩展更新'],
 'extension/popup.css':['扩展弹窗样式','设置浏览器扩展弹窗的布局'],
};
function group(path){return path.startsWith('public/')?'界面':path.startsWith('extension/')?'浏览器':/memory|learning|continuity|resume-state|chat-job/.test(path)?'记忆与资料':/control|owner-chat/.test(path)?'任务管理':'模型与业务';}
export function buildProjectMap(root){
 const files=[];
 for(const dir of ['server','public','extension'])if(existsSync(join(root,dir)))for(const entry of readdirSync(join(root,dir),{withFileTypes:true})){
   if(!entry.isFile()||entry.isSymbolicLink()||! /\.(?:mjs|js|html|css)$/.test(entry.name))continue;
   const path=dir+'/'+entry.name;if(statSync(join(root,path)).size>300000)continue;
   const content=readFileSync(join(root,path),'utf8');files.push({path,content});
 }
 const known=new Set(files.map(f=>f.path)),edges=[],endpoints=[];
 const app=files.find(f=>f.path==='server/app.mjs')?.content||'',allow=app.match(/const extensionRoutes=new Set\(\[([\s\S]*?)\]\)/)?.[1]||'';
 const browserRoutes=new Set([...allow.matchAll(/['"](\/api\/[^'"]+)['"]/g)].map(m=>m[1]));
 for(const file of files){
   for(const m of file.content.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)){const target=posix.normalize(posix.join(posix.dirname(file.path),m[1]));if(known.has(target))edges.push({from:file.path,to:target,type:'import'});}
   for(const m of file.content.matchAll(/path\s*===\s*['"](\/api\/[^'"]+)['"]/g)){
     const path=m[1];if(endpoints.some(e=>e.path===path))continue;
     endpoints.push({path,file:file.path,line:file.content.slice(0,m.index).split('\n').length,access:browserRoutes.has(path)?'用户或配对扩展':path==='/api/session'?'本机控制台':'仅本机用户',callers:files.filter(f=>f.path!==file.path&&f.content.includes("'"+path+"'")).map(f=>f.path)});
   }
 }
 const fingerprint=createHash('sha256').update(files.map(f=>f.path+f.content).join('\n')).digest('hex').slice(0,20);
 return {version:1,fingerprint,generatedAt:Date.now(),note:'文件和导入、接口来自当前源码静态扫描；中文用途与业务流程为人工整理。动态调用不保证全部覆盖。仅扫描server、public、extension，排除密钥、聊天、简历和依赖目录。',files:files.map(f=>({id:f.path,path:f.path,label:descriptions[f.path]?.[0]||f.path,purpose:descriptions[f.path]?.[1]||'工程支持文件',group:group(f.path),lines:f.content.split('\n').length})),edges,endpoints,flows:[
   {title:'提交对话任务',steps:['public/app.js','server/app.mjs','server/continuity.mjs','server/learning.mjs','server/harness.mjs','server/control.mjs']},
   {title:'读取HR岗位与历史',steps:['extension/background.js','extension/content.js','server/app.mjs','server/dom-chat.mjs','server/chat-job.mjs','server/memory.mjs','server/memory-files.mjs']},
   {title:'拟写、发送并核对',steps:['server/memory.mjs','server/core.mjs','server/harness.mjs','server/app.mjs','extension/content.js','server/resume-state.mjs']},
 ]};
}
