(() => {
  'use strict';
  const root = $('memory-workspace'), panel = $('memory');
  if (!root || !panel) return;
  root.dataset.ui = '';
  root.innerHTML = `
    <details class="memory-pending" id="memory-pending" hidden><summary id="memory-pending-label">待你决定</summary><div id="memory-pending-items"></div></details>
    <div class="memory-layout">
      <section class="memory-rail" aria-labelledby="memory-rail-heading">
        <div class="memory-rail-head"><h2 id="memory-rail-heading">HR 会话</h2><p id="memory-count-desktop"></p></div>
        <label class="memory-search"><span>查找会话</span><input id="memory-search" type="search" placeholder="姓名、公司或职位" maxlength="150" autocomplete="off"></label>
        <div id="memory-thread-list" class="memory-thread-list" aria-label="会话列表"></div>
        <div class="memory-page"><button id="memory-page-prev" type="button" aria-label="上一页">‹</button><span id="memory-page-label" role="status">1 / 1</span><button id="memory-page-next" type="button" aria-label="下一页">›</button></div>
      </section>
      <section class="memory-reader" aria-label="选中的 HR 会话">
        <div id="memory-reader-empty" class="memory-reader-empty"><h2 id="memory-selected-name">会话记忆</h2><p id="memory-empty-note">正在读取已保存的会话。</p></div>
        <div id="memory-thread" hidden>
          <div class="memory-thread-head"><button class="memory-back" id="memory-back" type="button">‹ 返回会话列表</button><h2 id="memory-thread-title" tabindex="-1"></h2><p id="memory-thread-role"></p><p id="memory-thread-coverage"></p></div>
          <div class="memory-tabs" role="group" aria-label="会话资料"><button type="button" data-memory-tab="timeline" aria-pressed="true">对话</button><button type="button" data-memory-tab="job" aria-pressed="false">岗位与简历</button><button type="button" data-memory-tab="receipts" aria-pressed="false">发送回执</button></div>
          <div class="memory-error" id="memory-error" role="status" hidden><span id="memory-error-text"></span><button id="memory-retry" type="button">重试</button></div>
          <div class="memory-older" id="memory-older-bar" hidden><span id="memory-visible-count"></span><button id="memory-older" type="button">加载更早消息</button></div>
          <div class="memory-timeline" id="memory-timeline" tabindex="0" aria-label="历史消息，可滚动"><p id="memory-message-empty" class="memory-muted"></p><ol id="memory-messages"></ol></div>
          <div class="memory-information" id="memory-job" hidden></div><div class="memory-information" id="memory-receipts" hidden></div>
        </div>
      </section>
    </div>`;

  const pageSize = 10, narrow = matchMedia('(max-width:760px)');
  const list = $('memory-thread-list'), messages = $('memory-messages'), timeline = $('memory-timeline');
  const decisions = $('memory-pending-items'), tabs = [...root.querySelectorAll('[data-memory-tab]')];
  const timestamp = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const authorTypes = {
    hr:['HR','招聘方'],owner_confirmed:['本人','本人确认'],bot_verified:['小鲸','已核对发送回执'],account_self_unknown:['站内我方','作者未确认'],
  };
  const proofTypes = {authenticated_owner_confirmation:'本人确认',verified_send_receipt:'同一会话发送回执',verified_send_message_id:'已核对站内消息编号',legacy_send_receipt:'旧版发送回执'};
  let stateSnapshot, selected = '', page = 1, mode = 'timeline', thread, history = [], offset = 0, request = 0, pendingLatest, pendingOlder;
  let listKey = '', messageKey = '', infoKey = '', decisionKey = '', error = '', deferredEnd = false;

  const setText = (id,value) => { const node = $(id);if (node.textContent !== value) node.textContent = value; };
  const formatTime = value => Number.isFinite(value) && value > 0 ? timestamp.format(value) : '';
  const within = node => node.contains(document.activeElement);
  const contactName = item => item?.domIdentity?.name || item?.header || '未命名会话';
  const summaries = () => Object.values(stateSnapshot?.memories || {});
  const byRecency = (a,b) => (b.updatedAt || b.lastSeenAt || 0) - (a.updatedAt || a.lastSeenAt || 0);
  const selectedSummary = () => stateSnapshot?.memories?.[selected];
  const summaryVersion = item => item?.version ?? `${item?.updatedAt || 0}:${item?.historyCount || 0}`;
  const messageAnchor = entry => entry?.eventId || entry?.id || '';
  const rangeAnchor = entry => entry?.eventId ? `event:${entry.eventId}` : entry?.id ? `message:${entry.id}` : '';
  const safeJob = value => typeof value === 'string' && /^https:\/\/www\.zhipin\.com\/job_detail\/[\w-]+\.html$/.test(value) ? value : '';

  function button(label, action, className = '') {
    const node = el('button',className,label);node.type = 'button';node.onclick = guard(action);return node;
  }
  function setError(text) {
    error = text;
    $('memory-error').hidden = !text;
    setText('memory-error-text',text);
  }
  function renderDecisions(force = false) {
    const items = (stateSnapshot?.ownerDecisions || []).filter(item => item.status === 'needs_owner_decision');
    const signature = JSON.stringify(items);
    if (signature === decisionKey || (!force && within(decisions))) return;
    decisionKey = signature;
    $('memory-pending').hidden = !items.length;
    setText('memory-pending-label',`待你决定 · ${items.length}`);
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      const row = el('div','memory-decision');
      row.append(el('strong','',item.header || 'HR 会话'),el('p','',item.summary || ''));
      row.append(button('标为已处理',async event => {
        const control = event.currentTarget;control.disabled = true;
        try {
          await api('/api/owner-decision',{id:item.id});
          await refresh();renderDecisions(true);
          if (!control.isConnected) ($('memory-pending').hidden ? $('memory-search') : $('memory-pending-label')).focus();
        } finally { control.disabled = false; }
      }));
      fragment.append(row);
    }
    decisions.replaceChildren(fragment);
  }

  function renderList(force = false) {
    const words = $('memory-search').value.trim().toLocaleLowerCase('zh-CN').split(/\s+/).filter(Boolean);
    const all = summaries();
    const filtered = all.filter(item => {
      if (!words.length) return true;
      const search = [item.header,item.domIdentity?.name,item.job?.title,item.job?.company,item.job?.city].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
      return words.every(word => search.includes(word));
    }).sort(byRecency);
    const pages = Math.max(1,Math.ceil(filtered.length/pageSize));
    page = Math.min(page,pages);
    if (!selected && filtered.length) selected = filtered[0].peerId;
    const rows = filtered.slice((page-1)*pageSize,page*pageSize);
    const signature = JSON.stringify([selected,page,pages,all.length,filtered.length,rows.map(item => [item.peerId,contactName(item),item.job,item.historyCount,item.updatedAt || item.lastSeenAt])]);
    if (signature === listKey || (!force && within(list))) return;
    listKey = signature;
    const focusedPeer = within(list) ? document.activeElement.dataset.memoryPeer : '';
    let restored;
    setText('memory-count-desktop',words.length ? `找到 ${filtered.length} 个 · 共 ${all.length} 个` : `本机已保存 ${all.length} 个`);
    setText('memory-page-label',`${page} / ${pages}`);
    $('memory-page-prev').disabled = page <= 1;
    $('memory-page-next').disabled = page >= pages;
    const fragment = document.createDocumentFragment();
    if (!rows.length) fragment.append(el('p','memory-list-empty',words.length ? '没有符合搜索条件的会话。' : '还没有保存的 HR 会话。'));
    for (const item of rows) {
      const row = button('',() => selectThread(item.peerId),'memory-contact');
      row.dataset.memoryPeer = item.peerId;
      row.setAttribute('aria-pressed',String(selected===item.peerId));
      row.append(el('strong','',contactName(item)),el('time','',formatTime(item.updatedAt || item.lastSeenAt)));
      const label = [item.job?.company,item.job?.title].filter(Boolean).join(' · ');
      row.append(el('span','memory-contact-job',label || `${item.historyCount || 0} 条已存消息`));
      if (item.peerId === focusedPeer) restored = row;
      fragment.append(row);
    }
    list.replaceChildren(fragment);
    restored?.focus({preventScroll:true});
  }

  function setTab(value) {
    mode = value;
    for (const control of tabs) control.setAttribute('aria-pressed',String(control.dataset.memoryTab === mode));
    for (const [tab,id] of [['timeline','memory-timeline'],['job','memory-job'],['receipts','memory-receipts']]) $(id).hidden = mode !== tab;
    updateOlder();scrollDeferred();
  }

  function updateOlder() {
    $('memory-older-bar').hidden = mode !== 'timeline' || !thread || offset <= 0;
    $('memory-older').disabled = Boolean(pendingOlder);
    setText('memory-visible-count',`已显示最近 ${history.length} 条`);
  }
  function scrollDeferred() {
    if (deferredEnd && timeline.clientHeight) { timeline.scrollTop = timeline.scrollHeight;deferredEnd = false; }
  }

  function renderHeader() {
    const summary = selectedSummary(), visible = !!summary;
    $('memory-thread').hidden = !visible;
    $('memory-reader-empty').hidden = visible;
    setText('memory-empty-note',stateSnapshot ? '小鲸读取 BOSS 会话后，已保存的对话会出现在这里。' : '正在读取已保存的会话。');
    if (!visible) return;
    setText('memory-thread-title',contactName(summary));
    setText('memory-thread-role',[thread?.job?.company || summary.job?.company,thread?.job?.title || summary.job?.title].filter(Boolean).join(' · '));
    setText('memory-thread-coverage',thread ? `${thread.total ?? history.length} 条已保存 · ${thread.historyCoverage?.complete ? '已确认网页历史起点' : '覆盖已加载的历史'}` : '正在读取这位 HR 的已存历史…');
  }

  function renderMessage(entry) {
    const known = entry.author?.kind;
    const kind = entry.role === 'hr' ? 'hr' : known === 'owner_confirmed' || known === 'bot_verified' ? known : 'account_self_unknown';
    const [speaker,source] = authorTypes[kind];
    const row = el('li','memory-message');row.dataset.author = kind;
    row.dataset.messageAnchor = messageAnchor(entry);
    const top = el('div','memory-message-head');
    top.append(el('strong','',speaker),el('span','memory-author-source',source));
    const seenAt = entry.time || formatTime(entry.observedAt);
    if (seenAt) top.append(el('time','',seenAt));
    row.append(top,el('p','memory-message-text',entry.text || ''));
    const evidence = kind === 'owner_confirmed' || kind === 'bot_verified' ? entry.author?.evidence : null;
    if (evidence?.messageId) {
      const proof = el('div','memory-proof');
      proof.append(el('span','',proofTypes[evidence.source] || source),el('code','',`消息编号 ${evidence.messageId}`));
      const confirmed = formatTime(evidence.confirmedAt);
      if (confirmed) proof.append(el('time','',confirmed));
      row.append(proof);
    }
    if (kind === 'account_self_unknown' && entry.id) row.append(button('标为本人发送',async event => {
      const action = event.currentTarget, peerId = selected;action.disabled = true;
      try {
        const result = await api('/api/chat/author-confirm',{peerId,messageId:entry.id,kind:'owner_confirmed'});
        if (selected !== peerId) return;
        if (result.message) history = history.map(message => message.id === entry.id ? result.message : message);
        renderMessages(true);
        const replacement = [...messages.children].find(node=>node.dataset.messageAnchor===messageAnchor(entry));
        if (replacement) { replacement.tabIndex = -1;replacement.focus({preventScroll:true}); }
        await refresh();
      } finally { action.disabled = false; }
    },'memory-confirm'));
    return row;
  }

  function renderMessages(force = false, scroll = 'keep') {
    const signature = JSON.stringify([selected,Boolean(thread),offset,error,history]);
    if (signature === messageKey || (!force && within(messages))) return;
    messageKey = signature;
    const oldTop = timeline.scrollTop, oldHeight = timeline.scrollHeight;
    const nearEnd = oldHeight-oldTop-timeline.clientHeight < 70;
    const top = scroll==='anchor'&&!nearEnd&&timeline.clientHeight ? timeline.getBoundingClientRect().top : null;
    const anchor = top===null ? null : [...messages.children].find(row=>row.dataset.messageAnchor&&row.getBoundingClientRect().bottom>top);
    const relativeTop = anchor?.getBoundingClientRect().top;
    messages.replaceChildren(...history.map(renderMessage));
    setText('memory-message-empty',history.length ? '' : thread ? '这个会话还没有已保存的消息。' : error ? '' : '正在读取历史消息…');
    updateOlder();
    if (scroll === 'prepend') timeline.scrollTop = oldTop + timeline.scrollHeight-oldHeight;
    else if (scroll === 'end' || nearEnd) { deferredEnd = true;scrollDeferred(); }
    else {
      const replacement = anchor && [...messages.children].find(row=>row.dataset.messageAnchor===anchor.dataset.messageAnchor);
      if (replacement) timeline.scrollTop += replacement.getBoundingClientRect().top-relativeTop;
      else timeline.scrollTop = oldTop;
    }
  }

  function renderInformation() {
    const signature = JSON.stringify([selected,thread?.job,thread?.jobDetail,thread?.resume,thread?.sends]);
    if (signature === infoKey || within($('memory-job')) || within($('memory-receipts'))) return;
    infoKey = signature;
    const job = $('memory-job'), receipts = $('memory-receipts');
    job.replaceChildren();receipts.replaceChildren();
    if (!thread) return;
    job.append(el('h3','','岗位资料'),el('p','',[thread.job?.title,thread.job?.company,thread.job?.city,thread.job?.salary].filter(Boolean).join(' · ') || '尚未观察到该会话的岗位信息。'));
    const url = safeJob(thread.job?.url);
    if (url) { const link = el('a','memory-job-link','在 BOSS 查看原岗位 ↗');link.href=url;link.target='_blank';link.rel='noopener noreferrer';job.append(link); }
    if (thread.jobDetail?.status === 'read' && thread.job?.description) job.append(el('p','memory-long-text',thread.job.description));
    else if (thread.jobDetail?.reason) job.append(el('p','memory-muted',thread.jobDetail.reason));
    job.append(el('h3','','简历附件'));
    job.append(el('p','',thread.resume?.status === 'sent' ? '已记录附件发送' : '尚无已确认的附件发送记录'));
    for (const receipt of (thread.resume?.receipts || []).slice(-4)) job.append(el('p','memory-muted',receipt.raw || ''));
    receipts.append(el('h3','','小鲸发送回执'));
    if (!thread.sends?.length) receipts.append(el('p','memory-muted','这个会话还没有小鲸的发送回执。'));
    for (const send of [...(thread.sends || [])].reverse()) {
      const row = el('div','memory-receipt');
      const label = send.status === 'sent' ? '已确认发送' : send.status === 'uncertain' ? '发送待核对' : '发送记录';
      row.append(el('strong','',label),el('time','',formatTime(send.at)),el('p','memory-long-text',send.text || (send.action === 'send_resume' ? '附件简历' : '')));
      if (send.evidence) row.append(el('p','memory-muted',send.evidence));
      receipts.append(row);
    }
  }

  function loadedRange() {
    if (!thread || !history.length || offset>0&&offset>=thread.latestOffset) return null;
    const from = offset===0?'~all':rangeAnchor(history[0]);
    return from?{from,through:rangeAnchor(history.at(-1)),rangeRevision:thread.rangeRevision}:null;
  }

  async function loadLatest(force = false) {
    const summary = selectedSummary();
    if (!summary || panel.hidden) return;
    const peerId = selected, version = summaryVersion(summary);
    if ((!force && thread?.version === version) || (pendingLatest?.peerId === peerId && pendingLatest.version === version)) return;
    const id = ++request;
    pendingLatest = {peerId,version};
    const range = loadedRange();
    try {
      const data = await api(`/api/memory/conversation?${new URLSearchParams({peerId,...range})}`);
      if (id !== request || selected !== peerId) return;
      if (data.peerId !== peerId || !Array.isArray(data.history)) throw Error('会话资料与所选联系人不一致');
      const oldThread = thread, currentRange = loadedRange();
      const replaceRange = data.rangeReplaced || oldThread&&data.rangeRevision!==oldThread.rangeRevision;
      if (currentRange?.from!==range?.from) {
        pendingLatest = null;
        return loadLatest(true);
      }
      if (oldThread&&oldThread.version!==data.version) pendingOlder = null;
      const anchor = rangeAnchor(data.history[0]);
      const anchorIndex = !replaceRange&&oldThread&&offset<oldThread.latestOffset&&anchor ? history.findIndex(item=>rangeAnchor(item)===anchor) : -1;
      const prefix = anchorIndex > 0 ? history.slice(Math.max(0,anchorIndex-data.offset),anchorIndex) : [];
      history = [...prefix,...data.history];offset = Math.max(0,data.offset-prefix.length);thread = data;
      setError('');renderHeader();renderInformation();renderMessages(false,replaceRange?'anchor':oldThread?'keep':'end');updateOlder();
    } catch (problem) {
      if (id === request) { setError(problem.message || '暂时无法读取已存会话');renderMessages(); }
    } finally { if (id === request) pendingLatest = null; }
  }

  async function loadOlder() {
    if (!thread || offset <= 0 || pendingOlder) return;
    const peerId = selected, before = offset, version = thread.version;
    const load = Symbol('older history request');
    pendingOlder = load;updateOlder();
    try {
      const data = await api(`/api/memory/conversation?${new URLSearchParams({peerId,before})}`);
      if (pendingOlder !== load) return;
      if (data.peerId !== peerId || data.version !== version || thread.version !== version || offset !== before) {
        setError('会话刚有更新，正在刷新历史。');void loadLatest(true);return;
      }
      history = [...data.history,...history];offset = data.offset;
      setError('');renderMessages(true,'prepend');
    } catch (problem) { if (pendingOlder === load) setError(problem.message || '暂时无法加载更早消息'); }
    finally { if (pendingOlder === load) { pendingOlder = null;updateOlder(); } }
  }

  function selectThread(peerId) {
    if (selected !== peerId) {
      selected = peerId;thread = null;history = [];offset = 0;request++;pendingLatest = pendingOlder = null;
      setError('');setTab('timeline');renderHeader();renderInformation();renderMessages(true);
    }
    root.dataset.mobileOpen = 'true';renderList(true);
    if (narrow.matches) $('memory-thread-title').focus({preventScroll:true});
    scrollDeferred();
    void loadLatest();
  }
  function render() {
    if (panel.hidden) return;
    if (selected && !selectedSummary()) { selected='';thread=null;history=[];offset=0;request++;pendingLatest=pendingOlder=null;root.dataset.mobileOpen='false'; }
    renderDecisions();renderList();renderHeader();renderInformation();renderMessages();void loadLatest();
  }
  $('memory-search').oninput = () => { page=1;renderList(true); };
  $('memory-page-prev').onclick = () => { page--;renderList(true);list.scrollTop=0; };
  $('memory-page-next').onclick = () => { page++;renderList(true);list.scrollTop=0; };
  $('memory-back').onclick = () => {
    root.dataset.mobileOpen = 'false';
    ([...list.children].find(item=>item.dataset.memoryPeer===selected) || $('memory-search')).focus();
  };
  $('memory-retry').onclick = () => void loadLatest(true);
  $('memory-older').onclick = loadOlder;
  for (const control of tabs) control.onclick = () => setTab(control.dataset.memoryTab);
  for (const [node,update] of [[list,renderList],[messages,renderMessages],[decisions,renderDecisions],[$('memory-job'),renderInformation],[$('memory-receipts'),renderInformation]]) {
    node.addEventListener('focusout',event => { if (!node.contains(event.relatedTarget)) queueMicrotask(() => { if (!panel.hidden) update(); }); });
  }
  new MutationObserver(render).observe(panel,{attributes:true,attributeFilter:['hidden']});
  window.renderMemoryWorkspace = value => { stateSnapshot = value;render(); };
  window.showMemoryDecisions = () => { $('memory-pending').open = true;$('memory-pending-label').focus(); };
  window.showMemoryConversation = peerId => {
    stateSnapshot = state;
    const index = summaries().sort(byRecency).findIndex(item=>item.peerId===peerId);
    if(index<0)return;
    $('memory-search').value = '';
    page = Math.floor(index/pageSize)+1;
    selectThread(peerId);
    window.panel('memory');
    $('memory-thread-title').focus({preventScroll:true});
  };
})();
