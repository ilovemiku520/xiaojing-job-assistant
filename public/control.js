/* Owner-only task controls, progressive memory recall and source-derived map. */
(()=>{
 let operations,operationPage=1,operationQueryTimer,selectedOperation=null,operationSnapshot=null,operationsRequest=0,boardKey='',detailKey='',decisionsKey='';
 let contextSearchRequest=0,contextDetailRequest=0,memorySearched=false;
 let mapData=null,flowIndex=0,mapSelection='',refreshing=false;
 const status={timed_out:'本轮超时，可续聊',queued:'排队中',running:'运行中',reading:'正在读取',generating:'正在拟写',ready:'待执行',pending:'待审核',approved:'待发送',executing:'正在发送',done:'已完成',read:'已读取',sent:'已确认发送',finished_with_issues:'已结束，有需处理项',interrupted:'已中断',cancelled:'已停止',failed:'未执行',error:'执行失败',hold:'需要你处理',uncertain:'发送待核对',stale:'旧草稿失效',skip:'已跳过',rejected:'已停止',expired:'已过期'};
 const queued=new Set(['queued','pending','approved','ready','hold','uncertain']);
 const working=new Set(['running','reading','generating','executing']);
 const when=at=>at?new Date(at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'尚无记录';
 const button=(caption,action,cls='')=>{const b=el('button',cls,caption);b.onclick=guard(action);return b;};
 const board=$('operation-board'),detail=$('operation-detail'),decisionBox=el('section','card');
 const contextPanel=$('context'),contextDetail=$('context-detail'),contextQuery=$('context-query');
 decisionBox.id='operation-decisions';decisionBox.hidden=true;decisionBox.setAttribute('aria-labelledby','operation-decisions-heading');
 $('operation-summary').after(decisionBox);
 detail.tabIndex=-1;detail.setAttribute('aria-label','任务详情');
 const focused=element=>element.contains(document.activeElement);
 const setText=(node,text)=>{if(node.textContent!==text)node.textContent=text;};
 const decisionItems=()=>(state?.ownerDecisions||[]).filter(item=>item.status==='needs_owner_decision');
 const operationKey=row=>row.kind+':'+row.id;
 const currentOperation=selection=>selection===selectedOperation&&!$('control').hidden;
 const operationQuery=()=>String(new URLSearchParams({view:'board',filter:$('operation-filter').value,q:$('operation-query').value.trim(),page:operationPage}));
 function showDecisions(force=false){
   if(!force&&focused(decisionBox))return;
   const query=$('operation-query').value.trim().toLowerCase();
   const items=$('operation-filter').value==='active'?[]:decisionItems().filter(item=>`${item.header||''} ${item.summary||''}`.toLowerCase().includes(query));
   const key=JSON.stringify(items);
   if(key===decisionsKey)return;
   decisionsKey=key;decisionBox.hidden=!items.length;decisionBox.replaceChildren();
   if(!items.length)return;
   const heading=el('h3','',`待你决定 · ${items.length}`);heading.id='operation-decisions-heading';decisionBox.append(heading);
   for(const item of items.slice(0,6)){
     const row=el('div','channel-activity-row');row.append(el('strong','',item.header||'HR 会话'),el('span','muted',when(item.at)),el('p','',item.summary||''));
     const actions=el('div','task-buttons');
     actions.append(button('标为已处理',async event=>{
       const control=event.currentTarget;control.disabled=true;
       try{
         await api('/api/owner-decision',{id:item.id});
         await refresh();showDecisions(true);
         if(!control.isConnected)$('operation-filter').focus({preventScroll:true});
       }finally{control.disabled=false;}
     }));
     row.append(actions);decisionBox.append(row);
   }
   if(items.length>6)decisionBox.append(button('在会话记忆查看全部',()=>{panel('memory');window.showMemoryDecisions?.();}));
 }
 function showOperations(force=false){
   showDecisions(force);
   if(!operations)return;
   const {items:rows,total,active,matched,page,pages}=operations;
   setText($('operation-summary'),`共 ${total} 项记录 · ${active} 项进行中 · ${decisionItems().length} 项待你决定`+(matched===total?'':` · 匹配 ${matched} 项`));
   $('operation-pagination').hidden=pages<=1;
   setText($('operation-page'),`${page} / ${pages}`);
   $('operation-prev').disabled=page<=1;
   $('operation-next').disabled=page>=pages;
   if(!force&&focused(board))return;
   const signature=JSON.stringify(rows);
   if(signature===boardKey)return;
   boardKey=signature;
   const oldButton=board.contains(document.activeElement)?document.activeElement:null,oldKey=oldButton?.closest('.op-card')?.dataset.operationKey;
   const buckets=[['排队与待处理',r=>queued.has(r.status)],['正在进行',r=>working.has(r.status)],['已结束',r=>!queued.has(r.status)&&!working.has(r.status)]];
   const columns=buckets.map(([title,predicate])=>[title,rows.filter(predicate)]);
   const filled=columns.filter(([,items])=>items.length).length,fragment=document.createDocumentFragment();
   let replacement;
   board.dataset.columns=filled||3;
   for(const [title,items] of columns){
     const column=el('section','op-column');column.hidden=filled>0&&!items.length;column.append(el('h3','',`${title} · ${items.length}`));
     for(const r of items){
       const card=el('article','op-card');card.dataset.operationKey=operationKey(r);
       card.append(el('span','badge',r.kind==='owner'&&r.status==='done'?'已返回结果':status[r.status]||r.status),el('h3','',r.title),el('p','muted',`${r.done}/${r.total} ${r.kind==='greeting'?'位HR已确认发送':'项处理结束'} · ${when(r.updatedAt)}`));
       if(r.reason)card.append(el('p','',r.reason));
       const actions=el('div','task-buttons');
       const inspect=button('查看详情',async()=>{
         selectedOperation={id:r.id,kind:r.kind};operationSnapshot=null;detailKey='';
         detail.hidden=true;detail.replaceChildren();
         await operationDetail(true);
       });
       actions.append(inspect);
       if(card.dataset.operationKey===oldKey)replacement=inspect;
       if(r.canCancel)actions.append(button('停止此任务',async event=>{
         const control=event.currentTarget;control.disabled=true;
         try{await api('/api/operations/cancel',{kind:r.kind,id:r.id});notice('已提交停止请求，其他独立任务继续保持原状态。');await loadOperations(true);}
         finally{control.disabled=false;}
       },'danger'));
       card.append(actions);column.append(card);
     }
     if(!items.length)column.append(el('p','muted','暂无对应记录'));
     fragment.append(column);
   }
   board.replaceChildren(fragment);
   if(oldKey)(replacement||$('operation-filter')).focus({preventScroll:true});
 }
 function renderOperationDetail(reveal=false){
   if(!operationSnapshot||!reveal&&focused(detail))return;
   const data=operationSnapshot,box=detail,selection=selectedOperation;
   const signature=JSON.stringify(data);
   if(signature===detailKey&&!reveal)return;
   detailKey=signature;box.replaceChildren();box.hidden=false;box.append(el('h3','',data.operation.title),el('p','',data.operation.kind==='owner'&&data.operation.status==='done'?'小鲸已返回报告，发送结果另见实际回执':data.replyRecovery?.closedAt?'已结束本次待核对':status[data.operation.status]||data.operation.status));
   if(data.operation.kind==='message'&&['pending','hold','approved'].includes(data.operation.status))box.append(button('到工作台审核',()=>{panel('overview');$('filter').value='todo';renderTasks();$('filter').focus();}));
   if(data.replyRecovery?.closedAt)box.append(el('p','muted','原发送结果仍未核实。'));
   else if(data.replyRecovery?.eligible){
     box.append(el('p','muted','结束这条回复后，小鲸只处理之后确认的新来信。原发送结果仍保留待核对。'));
     const actions=el('div','task-buttons');
     actions.append(button('结束本次待核对',async event=>{
       const control=event.currentTarget;
       if(!currentOperation(selection)||box.hidden||!box.contains(control))return;
       control.disabled=true;
       try{
         await api('/api/replies/close-uncertain',{taskId:data.operation.id});
         if(!currentOperation(selection))return;
         notice('已结束本次待核对。新来信将按当前通道设置处理。');
         await operationDetail(true);
         if(currentOperation(selection))await loadOperations(true);
       }catch(error){if(currentOperation(selection))throw error;}
       finally{control.disabled=false;}
     }));
     box.append(actions);
   }else if(data.replyRecovery?.reason)box.append(el('p','muted',data.replyRecovery.reason));
   for(const t of data.operation.targets||[])box.append(el('p','',`${t.company} · ${t.name}：${status[t.status]||t.status}${t.reason?' · '+t.reason:''}`));
   if(data.result)box.append(el('pre','',data.result));
   box.append(el('h3','','状态变化'));for(const e of data.events)box.append(el('p','muted',`${when(e.at)} · ${status[e.previousStatus]||e.previousStatus||'首次记录'} → ${status[e.status]||e.status}${e.reason?' · '+e.reason:''}`));
   if(reveal){box.focus({preventScroll:true});box.scrollIntoView({block:'nearest'});}
 }
 async function operationDetail(reveal=false){
   const selected=selectedOperation;if(!selected)return;
   try{
     const data=await api('/api/operations/detail',selected);
     if(!currentOperation(selected))return;
     operationSnapshot=data;renderOperationDetail(reveal);
   }catch(error){if(currentOperation(selected))throw error;}
 }
 async function loadOperations(force=false){
   const query=operationQuery(),request=++operationsRequest;
   const result=await api('/api/operations'+'?'+query);
   if(request!==operationsRequest||$('control').hidden||query!==operationQuery())return;
   operations=result;operationPage=result.page;
   showOperations(force);await operationDetail();
 }
 function loadOperationPage(page=1){
   clearTimeout(operationQueryTimer);operationPage=page;
   void loadOperations(true).catch(error=>notice(error.message,true));
 }
 function renderCheckpoint(data){
   const c=data.checkpoint,box=$('project-checkpoint');box.replaceChildren();if(!c){box.append(el('p','','尚未生成项目检查点'));return;}
   box.append(el('h3','','新会话可以接着做'),el('p','',`${c.counts.conversations} 个HR会话 · ${c.counts.verifiedSends} 次已确认发送 · ${c.counts.unconfirmedSends} 次待核对`),el('p','muted',`检查点保存于 ${when(c.savedAt)}；历史报告仅供参考，发送情况以站内回显证据为准。`));
   for(const p of c.activePlans)box.append(el('p','',`未结束的${p.kind==='read'?'读取':'跟进'}任务：${p.targets.map(t=>t.company+' '+t.name+'（'+(status[t.status]||t.status)+'）').join('、')}`));
   for(const p of c.greetingPlans||[])box.append(el('p','',`招呼任务：${p.sent}/${p.requested} 位已确认发送 · ${p.waitingReason||''}`));
   for(const t of c.recentOwnerTasks.slice(0,3)){const d=el('details');d.append(el('summary','',`${status[t.status]||t.status} · ${t.prompt}`),el('p','',t.resultPreview||'任务尚未返回结果'));box.append(d);}
 }
 function renderCatalog(data){
   const box=$('context-results');box.replaceChildren();$('context-summary').textContent=`匹配 ${data.total} 条记忆；先看索引，点开后再读取详情与原文依据。`;
   for(const n of data.items){const card=el('article','op-card');card.append(button(n.title,()=>noteDetail(n.id)),el('p','muted',`${n.trust==='owner_direct'?'手动补充':'来源观察'} · ${n.source.title||n.source.kind} · 约 ${n.estimatedTokens} tokens · ${when(n.updatedAt)}`));box.append(card);}if(!data.items.length)box.append(el('p','empty','没有匹配的记忆，可先在“学习记录”补充记忆。'));
 }
 function clearContextDetail(){
   contextDetail.hidden=true;contextDetail.replaceChildren();
   return ++contextDetailRequest;
 }
 async function noteDetail(id){
   const request=clearContextDetail();
   const current=()=>request===contextDetailRequest&&!contextPanel.hidden;
   try{
     const {note:n}=await api('/api/context/note',{id});
     if(!current())return;
     contextDetail.append(el('h3','','记忆详情'),el('p','',n.text),el('p','muted',n.scope.peerId?'仅此HR会话的观察':n.trust==='owner_direct'?'手动补充的记忆':'此岗位或来源中的观察'),el('h3','','原文依据'),el('pre','',n.evidence));
     if(n.scope.peerId){
       const timeline=el('section');
       contextDetail.append(button('读取对应原始对话',async event=>{
         const control=event.currentTarget;control.disabled=true;
         try{
           const d=await api('/api/context/timeline',{peerId:n.scope.peerId,limit:30});
           if(!current())return;
           timeline.replaceChildren(el('h3','','最近实际观察的原始消息'));
           for(const m of d.messages)timeline.append(el('p','',`${m.role==='hr'?'HR':'站内我方'}：${m.text}`));
           timeline.append(el('p','muted',d.coverage.complete?'已确认网页历史起点':'未证明网站全部历史已加载'));
           if(!timeline.isConnected)contextDetail.append(timeline);
         }catch(error){if(current())throw error;}
         finally{control.disabled=false;}
       }));
     }
     contextDetail.hidden=false;
   }catch(error){if(current())throw error;}
 }
 function renderMap(){
   if(!mapData)return;const m=mapData,query=$('map-query').value.toLowerCase();$('map-summary').textContent=`${m.files.length} 个源码文件 · ${m.edges.length} 条导入关系 · ${m.endpoints.length} 个服务接口。结构指纹 ${m.fingerprint}。`;
   const tours=$('map-flows');tours.replaceChildren();m.flows.forEach((f,i)=>tours.append(button(f.title,()=>{flowIndex=i;renderMap();},i===flowIndex?'primary':'')));
   const rail=$('map-flow');rail.replaceChildren();for(const id of m.flows[flowIndex].steps){const file=m.files.find(f=>f.id===id);if(file){if(rail.childElementCount)rail.append(el('span','map-arrow','→'));rail.append(button(file.label,()=>{mapSelection=id;renderMap();},'map-step'));}}
   const groups=$('map-groups');groups.replaceChildren();for(const name of [...new Set(m.files.map(f=>f.group))]){const card=el('section','op-column');card.append(el('h3','',name));for(const f of m.files.filter(f=>f.group===name&&(!query||(f.path+' '+f.label+' '+f.purpose).toLowerCase().includes(query))))card.append(button(f.label,()=>{mapSelection=f.id;renderMap();},mapSelection===f.id?'primary':''));groups.append(card);}
   const detail=$('map-detail');detail.replaceChildren();const f=m.files.find(f=>f.id===mapSelection);if(!f){detail.append(el('p','muted','点击模块查看用途、依赖、影响范围和接口。'));return;}
   detail.append(el('h3','',f.label),el('p','',f.purpose),el('p','muted',`${f.path} · ${f.lines} 行`));
   const links=(label,ids)=>{detail.append(el('h3','',label));if(!ids.length)detail.append(el('p','muted','未扫描到直接导入关系'));for(const id of ids){const item=m.files.find(x=>x.id===id);detail.append(button(item?.label||id,()=>{mapSelection=id;renderMap();}));}};
   links('它直接使用',m.edges.filter(e=>e.from===f.id).map(e=>e.to));links('改动会直接影响',m.edges.filter(e=>e.to===f.id).map(e=>e.from));
   detail.append(el('h3','','相关接口'));for(const e of m.endpoints.filter(e=>e.file===f.id||e.callers.includes(f.id)))detail.append(el('p','muted',`${e.path} · ${e.access} · ${e.file}:${e.line}`));
 }
 window.refreshControl=async()=>{
   if(refreshing)return;refreshing=true;try{
     if(!$('control').hidden)await loadOperations();
     else if(!contextPanel.hidden){
       const data=await api('/api/context');
       if(!contextPanel.hidden){renderCheckpoint(data);if(!memorySearched)renderCatalog(data.catalog);}
     }
     else if(!$('project-map').hidden){mapData=await api('/api/project-map');renderMap();}
   }finally{refreshing=false;}
 };
 for(const [region,apply] of [[board,showOperations],[decisionBox,showDecisions],[detail,renderOperationDetail]]){
   region.addEventListener('focusout',event=>{
     if(!region.contains(event.relatedTarget))queueMicrotask(()=>{if(!$('control').hidden)apply();});
   });
 }
 $('operation-filter').onchange=()=>{showDecisions(true);loadOperationPage();};
 $('operation-query').oninput=()=>{
   showDecisions(true);clearTimeout(operationQueryTimer);operationPage=1;
   operationQueryTimer=setTimeout(()=>{if(!$('control').hidden)loadOperationPage();},150);
 };
 $('operation-prev').onclick=()=>loadOperationPage(Math.max(1,(operations?.page||1)-1));
 $('operation-next').onclick=()=>loadOperationPage((operations?.page||1)+1);
 $('context-search-form').onsubmit=guard(async()=>{
   const request=++contextSearchRequest,query=contextQuery.value;
   const current=()=>request===contextSearchRequest&&!contextPanel.hidden&&contextQuery.value===query;
   memorySearched=true;clearContextDetail();
   try{
     const data=await api('/api/context/search',{query});
     if(current()){clearContextDetail();renderCatalog(data);}
   }catch(error){if(current())throw error;}
 });
 $('map-query').oninput=renderMap;
})();
