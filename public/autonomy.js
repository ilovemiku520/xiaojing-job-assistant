(()=>{
 let dirty=false;
 const goal=$('autonomy-goal'),form=$('autonomy-form'),save=form.querySelector('button');
 goal.addEventListener('input',()=>dirty=true);
 window.renderAutonomy=s=>{
  const a=s.autonomy||{};
  if(!dirty&&document.activeElement!==goal)goal.value=a.goal||'';
  const running=s.config.channels?.jobSearch??s.config.running;$('autonomy-state').textContent=!running?'自主求职已关闭':a.status==='working'?'小鲸正在自主推进':'自主求职已开启';
  $('autonomy-reason').textContent=a.reason||'给小鲸一个持续目标，她会自行安排后续操作，并在这里留下进展。';
  $('autonomy-toggle').textContent=running?'关闭自主求职':'开启自主求职';$('autonomy-toggle').setAttribute('aria-pressed',String(running));
  $('autonomy-open').hidden=!a.conversationId;$('autonomy-open').onclick=()=>{$('channel-log-jobSearch')?.scrollIntoView({block:'nearest'});$('channel-prompt-jobSearch')?.focus();};
  const list=$('autonomy-next');list.replaceChildren();
  for(const step of (a.nextSteps||[]).filter(s=>s.status==='planned').slice(0,5)){const row=el('li','',step.description);if(step.dueAt)row.append(el('small','',new Date(step.dueAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})));else row.append(el('small','','等待相关新情况'));list.append(row);}
 };
 form.onsubmit=guard(async()=>{
  if(save.disabled)return;
  const submitted=goal.value;
  save.disabled=true;
  try{
   await api('/api/autonomy',{goal:submitted});
   dirty=goal.value!==submitted;
   await refresh();
   notice(dirty?'已保存提交时的目标，之后的编辑仍保留。':'长期目标已保存。');
  }finally{save.disabled=false;}
 });
 $('autonomy-toggle').onclick=guard(async()=>{await window.setChannelRunning?.('jobSearch');});
})();
