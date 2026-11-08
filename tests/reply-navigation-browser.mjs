// Exercise the real content adapter against a local synthetic chat page and API.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {chromium} from '../tools/node/node_modules/playwright-core/index.mjs';

const source=['realtime.js','resume-ui.js','content.js'].map(name=>readFileSync(new URL('../extension/'+name,import.meta.url),'utf8')).join('\n');
const peers={a:{name:'甲女士',company:'模拟甲'},b:{name:'乙女士',company:'模拟乙'},c:{name:'丙女士',company:'模拟丙'},d:{name:'丁女士',company:'模拟丁'}};
const browser=await chromium.launch({headless:true,channel:'msedge'});
const pageHTML=(peers,ids)=>`<!doctype html><meta charset="utf-8"><div class="friend-list" data-id="shared-container">${Object.entries(peers).map(([id,label],index)=>`<div id="${id}" ${ids[id]?`data-id="${ids[id]}"`:''} class="friend-content ${index===0?'selected':''}"><div class="title-box"><span class="name-text">${label.name}</span><span>${label.company}</span></div><span class="last-msg-text">旧消息 ${id}</span><span class="time">10月01日</span></div>`).join('')}</div><main class="chat-conversation"><div class="top-info-content"></div><div class="chat-record"></div><div class="chat-editor"><textarea class="chat-input"></textarea><button class="btn-send disabled">发送</button></div></main><script>
 const peers=${JSON.stringify(peers)},byPeer=Object.fromEntries(Object.keys(peers).map(id=>[id,[{id:'old-'+id,role:'hr',text:'旧消息 '+id}]]));
 const editor=document.querySelector('textarea'),send=document.querySelector('.btn-send');window.sent=[];window.clicks=[];
 const selected=()=>document.querySelector('.friend-content.selected');
 function render(){const peer=selected(),id=peer.id;document.querySelector('.top-info-content').textContent=peers[id].name+' '+peers[id].company;const record=document.querySelector('.chat-record');record.replaceChildren();for(const message of byPeer[id]){const item=document.createElement('div');item.className='message-item '+(message.role==='hr'?'item-friend':'item-myself');item.dataset.mid=message.id;const text=document.createElement('span');text.className='text';text.textContent=message.text;item.append(text);record.append(item);}}
 for(const peer of document.querySelectorAll('.friend-content'))peer.onclick=()=>{window.clicks.push(peer.id);selected().classList.remove('selected');peer.classList.add('selected');peer.querySelector('.notice-badge')?.remove();if(window.delayPeer===peer.id)setTimeout(render,180);else render();};
 editor.oninput=()=>send.classList.toggle('disabled',!editor.value);
 send.onclick=()=>{const id=selected().id;window.sent.push({id,text:editor.value});byPeer[id].push({id:'sent-'+id,role:'self',text:editor.value});editor.value='';send.classList.add('disabled');render();};
 window.inject=(id,message)=>{const peer=document.getElementById(id),text=message||'新的模拟来信 '+id;byPeer[id].push({id:'new-'+id,role:'hr',text});peer.querySelector('.last-msg-text').textContent=text;peer.querySelector('.time').textContent='12:34';const badge=document.createElement('span');badge.className='notice-badge';badge.textContent='1';peer.append(badge);if(selected()===peer)render();};
 render();</script>`;

async function fixture({mode='auto',legacy=false,authBlocked=false,chatInput=true,browserCalibrated=true,autoBrowse=true,sameLabels=false,idCollision='',delayed=false}={}){
  const page=await browser.newPage(),calls=[],rows=[],tasks=[],errors=[];
  let beforeBacklog;
  const labels=sameLabels?{...peers,d:peers.c}:peers;
  const ids={a:'fixture-a',b:'fixture-b',c:idCollision==='missing'?'':idCollision==='duplicate'?'fixture-duplicate':'fixture-c',d:idCollision==='missing'?'':idCollision==='duplicate'?'fixture-duplicate':'fixture-d'};
  const config={running:true,hrInboxRunning:true,readingEnabled:true,mode,autoBrowse,chatRead:true,chatInput,browserCalibrated,newMessagesOnly:true,historySweepEnabled:false,watchEpoch:1,selectors:{}};
  for(const id of ['a','b']){
    rows.push({id:`row-${id}`,peerId:`boss:fixture-${id}`,...peers[id],status:'ready',taskId:`task-${id}`,...(!legacy?{sendEligible:false}:{})});
    tasks.push({id:`task-${id}`,peerId:`boss:fixture-${id}`,status:mode==='review'?'pending':'approved',fingerprint:`fingerprint-${id}`,action:'send_text',text:'过往的模拟草稿'});
  }
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('https://www.zhipin.com/**',route=>route.fulfill({contentType:'text/html',body:pageHTML(labels,ids)}));
  await page.exposeFunction('replyNavigationFixture',async message=>{
    if(message.type==='chatMonitor')return {ok:true,result:{monitor:true}};
    if(message.type!=='api')return {ok:true,result:null};
    const {path,data}=message;calls.push({path,data});let result={};
    if(path==='/api/heartbeat')result={config};
    if(path==='/api/replies/state')result={items:rows};
    if(path==='/api/tasks'){
      if(beforeBacklog)await beforeBacklog(data);
      result={tasks:tasks.filter(task=>task.peerId===data.peerId&&['pending','approved'].includes(task.status))};
    }
    if(path==='/api/replies/enqueue'){
      const mid=data.messages.at(-1).id,id=mid.at(-1);
      assert.equal(mid,`new-${id}`);assert.equal(data.peerId,`boss:fixture-${id}`);
      let row=rows.find(item=>item.id===`row-${id}`);
      if(!row){
        const hasDraft=!legacy&&!authBlocked;
        row={id:`row-${id}`,peerId:data.peerId,...data.label,status:authBlocked?'auth_blocked':hasDraft?'ready':'generating',...(hasDraft?{taskId:`task-${id}`,sendEligible:false}:{})};rows.push(row);
        if(hasDraft)tasks.push({id:row.taskId,peerId:data.peerId,status:'pending',fingerprint:`fingerprint-${id}`,action:'send_text',text:'仅测试发送这一条。'});
      }
      result={reply:row};
    }
    if(path==='/api/claim'){
      const task=tasks.find(item=>item.id===data.id),row=rows.find(item=>item.taskId===data.id);
      if(row?.sendEligible!==true)result={blocked:'模拟的全局发送限制'};
      else{
        assert.equal(task.peerId,data.peerId);assert.equal(task.fingerprint,data.fingerprint);
        const selected=await page.locator('.friend-content.selected').getAttribute('data-id');assert.equal(data.peerId,`boss:${selected}`);
        task.status='executing';result={task,lease:'fixture-lease'};
      }
    }
    if(path==='/api/check')result={allowed:true};
    if(path==='/api/complete'){
      assert.equal(data.success,true);assert.match(data.evidence,new RegExp('sent-'+data.id.at(-1)));
      tasks.find(task=>task.id===data.id).status='sent';rows.find(row=>row.taskId===data.id).status='done';
    }
    return {ok:true,result};
  });
  await page.addInitScript(()=>{
    const now=Date.now;window.offset=0;Date.now=()=>now()+window.offset;
    const values={};window.chrome={storage:{local:{get:async key=>({[key]:values[key]}),set:async patch=>Object.assign(values,patch)}},runtime:{id:'reply-navigation-fixture',onMessage:{addListener:fn=>window.wake=fn},sendMessage:message=>window.replyNavigationFixture(message)}};
    const interval=setInterval;window.setInterval=(fn,ms,...args)=>[1000,1500,6000].includes(ms)?0:interval(fn,ms,...args);
  });
  await page.goto('https://www.zhipin.com/web/geek/chat');await page.addScriptTag({content:source});
  if(delayed)await page.evaluate(()=>{window.delayPeer='c';});
  async function tick(){await page.evaluate(()=>{window.offset+=2500;return new Promise(resolve=>window.wake({type:'assistant-read',command:'tick'},{id:'reply-navigation-fixture'},resolve));});}
  async function until(check,label){for(let i=0;i<60;i++){if(await check())return;await tick();await page.waitForTimeout(30);}assert(await check(),label);}
  await until(()=>calls.some(call=>call.path==='/api/tasks'),'fixture should begin reading current chat');
  return {page,calls,rows,tasks,config,tick,until,errors,onBacklog(fn){beforeBacklog=fn;}};
}

try{
  for(const options of [{},{chatInput:false},{browserCalibrated:false},{mode:'review',autoBrowse:false},{legacy:true}]){
    const f=await fixture(options);
    if(options.legacy)await f.tick();
    await f.page.evaluate(()=>inject('c'));
    if(options.autoBrowse===false){
      await f.tick();assert(!f.rows.some(row=>row.id==='row-c'),'关闭自动浏览时保留未读');
      f.config.autoBrowse=true;
    }
    await f.until(()=>f.rows.some(row=>row.id==='row-c'),'fresh unread should queue while older drafts are blocked');
    const selections=await f.page.evaluate(()=>clicks.slice());
    if(!options.legacy){
      assert.deepEqual(selections,['c'],'known blocked drafts must never take sidebar focus');
      assert(!f.calls.some(call=>call.path==='/api/claim'),'known blocked drafts must not repeatedly claim');
    }else assert(selections.includes('c'),'old server fallback still reads fresh unread');

    if(options.mode==='review'){
      await f.page.evaluate(()=>inject('d'));
      await f.until(()=>f.rows.some(row=>row.id==='row-d'),'another unread is read while C is awaiting approval');
      for(let i=0;i<4;i++)await f.tick();
      assert.deepEqual(await f.page.evaluate(()=>clicks),['c','d'],'an unchanged submitted event is not new unread');
      f.tasks.find(task=>task.id==='task-c').status='approved';
      f.rows.find(row=>row.id==='row-c').sendEligible=true;
      await f.until(()=>f.calls.some(call=>call.path==='/api/complete'),'approved review draft should execute on its correct peer');
      assert.deepEqual(await f.page.evaluate(()=>sent),[{id:'c',text:'仅测试发送这一条。'}]);
      assert.deepEqual(f.calls.filter(call=>call.path==='/api/claim').map(call=>call.data.id),['task-c']);
    }else assert.deepEqual(await f.page.evaluate(()=>sent),[]);
    assert.deepEqual(f.errors,[]);await f.page.close();
  }
  const auth=await fixture({authBlocked:true});
  for(const id of ['c','d']){
    await auth.page.evaluate(id=>inject(id),id);
    await auth.until(()=>auth.rows.some(row=>row.id===`row-${id}`&&row.status==='auth_blocked'),'new unread is still preserved during model authentication failure');
  }
  for(let i=0;i<6;i++)await auth.tick();
  assert.deepEqual(await auth.page.evaluate(()=>clicks),['c','d'],'an authentication-blocked conversation is not reopened as an unprocessed event');
  assert.deepEqual(auth.calls.filter(call=>call.path==='/api/replies/enqueue').map(call=>call.data.peerId),['boss:fixture-c','boss:fixture-d']);
  assert(!auth.calls.some(call=>call.path==='/api/claim'));
  const recovered=auth.rows.find(row=>row.id==='row-c');
  Object.assign(recovered,{status:'ready',taskId:'task-c',sendEligible:true});
  auth.tasks.push({id:recovered.taskId,peerId:recovered.peerId,status:'approved',fingerprint:'fingerprint-c',action:'send_text',text:'模拟模型修复后的回复。'});
  await auth.until(()=>auth.calls.some(call=>call.path==='/api/complete'),'a recovered draft returns to the normal browser send flow');
  assert.deepEqual(await auth.page.evaluate(()=>sent),[{id:'c',text:'模拟模型修复后的回复。'}]);
  assert.deepEqual(auth.errors,[]);await auth.page.close();
  const duplicate=await fixture({mode:'review',sameLabels:true,delayed:true});
  for(let i=0;i<6;i++)await duplicate.tick();
  assert.deepEqual(await duplicate.page.evaluate(()=>clicks),[],'同名会话不同的旧侧栏预览不能反复触发');
  assert.equal(duplicate.calls.filter(call=>call.path==='/api/replies/enqueue').length,0);
  await duplicate.page.evaluate(()=>inject('d'));
  await duplicate.until(()=>duplicate.rows.some(row=>row.id==='row-d'),'D unread must queue independently');
  await duplicate.page.evaluate(()=>inject('c'));
  await duplicate.until(()=>duplicate.rows.some(row=>row.id==='row-c'),'C unread must queue after its own body replaces D');
  assert.deepEqual(duplicate.calls.filter(call=>call.path==='/api/replies/enqueue').map(call=>[call.data.peerId,call.data.messages.at(-1).id]),[['boss:fixture-d','new-d'],['boss:fixture-c','new-c']]);
  assert(!duplicate.calls.some(call=>call.path==='/api/observe'&&call.data.peerId==='boss:fixture-c'&&call.data.messages.some(message=>message.id.endsWith('-d'))));
  duplicate.tasks.find(task=>task.id==='task-d').status='approved';
  duplicate.rows.find(row=>row.taskId==='task-d').sendEligible=true;
  await duplicate.until(()=>duplicate.calls.some(call=>call.path==='/api/complete'),'approved D must be selected by stable row ID');
  assert.deepEqual(await duplicate.page.evaluate(()=>sent),[{id:'d',text:'仅测试发送这一条。'}]);
  let recycled=false;
  duplicate.onBacklog(async data=>{
    if(recycled||data.peerId!=='boss:fixture-c')return;
    recycled=true;await duplicate.page.locator('#c').evaluate(peer=>{peer.dataset.id='fixture-recycled';});
  });
  duplicate.tasks.find(task=>task.id==='task-c').status='approved';
  duplicate.rows.find(row=>row.taskId==='task-c').sendEligible=true;
  await duplicate.until(()=>recycled,'fixture must reuse the selected row during the task lookup');
  await duplicate.tick();
  assert.deepEqual(duplicate.calls.filter(call=>call.path==='/api/claim').map(call=>call.data.id),['task-d'],'旧快照不能领取已经换成其他会话编号的行');
  assert.deepEqual(await duplicate.page.evaluate(()=>sent),[{id:'d',text:'仅测试发送这一条。'}]);
  assert.deepEqual(duplicate.errors,[]);await duplicate.page.close();
  for(const idCollision of ['missing','duplicate']){
    const f=await fixture({sameLabels:true,idCollision});
    await f.page.evaluate(()=>inject('d'));for(let i=0;i<8;i++)await f.tick();
    assert.deepEqual(await f.page.evaluate(()=>clicks),[],'编号缺失或重复的同名会话不可自动猜测');
    assert.equal(f.calls.filter(call=>call.path==='/api/replies/enqueue').length,0);
    assert.deepEqual(f.errors,[]);await f.page.close();
  }
  const restriction=await fixture({mode:'review'});
  await restriction.page.evaluate(()=>inject('c','请问你说的“操作过于频繁”是在哪个步骤出现的？'));
  await restriction.until(()=>restriction.rows.some(row=>row.id==='row-c'),'an HR quotation should remain ordinary content');
  assert.equal(restriction.calls.filter(call=>call.path==='/api/stop').length,0);
  await restriction.page.evaluate(()=>{
    const warning=document.createElement('div');
    for(const text of ['操作过于','频繁，请稍后再试']){const part=document.createElement('span');part.textContent=text;warning.append(part);}
    document.body.append(warning);
  });
  await restriction.until(()=>restriction.calls.some(call=>call.path==='/api/stop'),'a visible site restriction outside the conversation still pauses');
  assert.deepEqual(restriction.errors,[]);await restriction.page.close();
  console.log(JSON.stringify({knownBlockedDraftsDoNotNavigate:true,authBlockedNotReopened:true,authRecoveredDraftSends:true,readOnlyDraftGeneration:true,reviewUnread:true,reviewRequiresApproval:true,alreadySubmittedNotNewUnread:true,oldServerFallback:true,duplicateLabelsIsolated:true,matchingStableRowSelected:true,oldBodyRejected:true,recycledRowBlockedBeforeClaim:true,ambiguousIDsNotGuessed:true,hrQuoteIsNotSiteRestriction:true,siteRestrictionPauses:true,realHRsContacted:0}));
}finally{await browser.close();}
