const $=id=>document.getElementById(id);
$('version').textContent='BOSS 扩展：'+chrome.runtime.getManifest().version+'\n控制台：正在读取…';
function showVersion(result,error){
  $('version').textContent='BOSS 扩展：'+chrome.runtime.getManifest().version+'\n控制台：'+(result?.controlVersion|| (error?'未连接':'版本暂不可读'));
  if(result?.config)$('status').textContent=channelStatus(result.config);
}
function channelStatus(config){const job=typeof config.jobSearchRunning==='boolean'?config.jobSearchRunning:!!config.running,hr=typeof config.hrInboxRunning==='boolean'?config.hrInboxRunning:!!config.running;return `自主求职：${job?'运行中':'已关闭'}\nHR 新消息回复：${hr?'运行中':'已关闭'}`;}
async function refreshVersion(){
  try{const r=await chrome.runtime.sendMessage({type:'api',path:'/api/browser-state'});showVersion(r?.ok?r.result:null,!r?.ok);}
  catch{showVersion(null,true);}
}
$('reload').onclick=()=>chrome.runtime.reload();
chrome.storage.local.get('token').then(x=>$('token').value=x.token||'');
$('pair').onclick=async()=>{
  await chrome.storage.local.set({token:$('token').value.trim()});
  const r=await chrome.runtime.sendMessage({type:'api',path:'/api/browser-state'});
  showVersion(r.ok?r.result:null,!r.ok);
  $('status').textContent=r.ok?`已连接\n${channelStatus(r.result.config)}\n返回 BOSS 页面刷新一次。`:r.error;
};
$('console').onclick=()=>chrome.tabs.create({url:'http://127.0.0.1:17321/'});
$('boss').onclick=()=>chrome.tabs.create({url:'https://www.zhipin.com/web/geek/job'});
$('chat').onclick=()=>chrome.tabs.create({url:'https://www.zhipin.com/web/geek/chat'});
$('stop').onclick=async()=>{const r=await chrome.runtime.sendMessage({type:'api',path:'/api/stop',data:{reason:'用户在扩展中暂停'}});$('status').textContent=r.ok?'已暂停':r.error;};
void refreshVersion();
