(() => {
  'use strict';
  const panel = $('jobs');
  if (!panel) return;

  const sourceButtons = [...panel.querySelectorAll('[data-jobs-source]')];
  const columnLabels = [
    ['', '#'], ['title', '职位'], ['company', '公司'], ['city', '城市'], ['', '薪资'],
    ['', '经验'], ['', '来源'], ['status', '采集状态'], ['fit', '岗位匹配'], ['stage', '跟进状态'], ['lastSeenAt', '最近发现'],
  ];
  const statuses = {listed:'等待读取',reading:'正在读取',ready:'已读详情',needs_adaptation:'待校准'};
  const fits = {matched:'符合筛选',unmatched:'不符合筛选',unverified:'待核对'};
  const stages = {unobserved:'暂无跟进记录',contacted:'有历史沟通',message_sent:'消息已确认发送',resume_sent:'简历已确认发送',pending:'待处理',sending:'发送中',receipt_uncertain:'发送结果待核对'};
  const missing = '—';
  const numbers = new Intl.NumberFormat('zh-CN');
  const localDate = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const localTime = new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  const fileDate = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'});
  const table = $('jobs-table-body'), head = $('jobs-table-head'), dialog = $('jobs-detail');
  const filters = {source:'all',sort:'lastSeenAt',direction:'desc',page:1};
  const preferenceKey = 'xiaojing-jobs-view-v1';
  const preferenceFields = ['jobs-status','jobs-fit','jobs-stage','jobs-page-size','jobs-format'];
  const sortButtons = new Map();
  let snapshot, signature, etag, loadedQuery, fetching, filterTimer, detailRequest=0, detailJobId;
  let exporting = false, openingWorkbook = false, workbook;

  function textAt(id,text) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }
  function dataSources(row) {
    return Array.isArray(row.sources) && row.sources.length ? row.sources : [row.source];
  }
  function queryValue() {
    return $('jobs-query').value.trim();
  }
  function queryOptions() {
    return {q:queryValue(),source:filters.source,status:$('jobs-status').value,fit:$('jobs-fit').value,stage:$('jobs-stage').value,sort:filters.sort,direction:filters.direction};
  }
  function tableQuery() {
    return String(new URLSearchParams({...queryOptions(),page:filters.page,pageSize:$('jobs-page-size').value}));
  }
  function currentTable() {
    return !!snapshot && loadedQuery === tableQuery();
  }
  function dateLabel(value,formatter = localDate) {
    return Number.isFinite(value) && value > 0 ? formatter.format(value) : missing;
  }
  function currentSource(row) {
    const sources = dataSources(row);
    if (sources.includes('favorite')) return sources.includes('search') ? '收藏 · 搜索' : '收藏';
    return sources.includes('search') ? '搜索' : missing;
  }
  function syncStatus(text,kind,tableChanged = false) {
    const status = $('jobs-sync-status');
    const previous = status.dataset.kind;
    if (previous !== kind) status.dataset.kind = kind;
    textAt('jobs-sync-status',text);
    if (kind === 'error') textAt('jobs-sync-announcement',text);
    else if (kind === 'live' && previous === 'error') textAt('jobs-sync-announcement','岗位表已恢复更新。');
    else if (kind === 'live' && tableChanged) textAt('jobs-sync-announcement',`岗位表已更新。${$('jobs-page-summary').textContent}`);
  }
  function safeURL(value) {
    return typeof value === 'string' && /^https:\/\/www\.zhipin\.com\/job_detail\/[\w-]+\.html$/.test(value) ? value : '';
  }
  function renderWorkbook() {
    const status = $('jobs-workbook-status'), button = $('jobs-live-workbook');
    button.hidden = typeof window.xiaojingDesktop?.openJobsWorkbook !== 'function';
    const retry = workbook && ['locked','error'].includes(workbook.state);
    const changed = workbook?.externallyChanged === true;
    const waiting = workbook && (changed || !workbook.ready) && workbook.pending && !retry;
    button.disabled = openingWorkbook || !workbook || waiting;
    let action = '打开实时工作簿 ↗';
    if (waiting) action = '正在生成工作簿…';
    else if (changed) action = '重新生成实时工作簿';
    else if (workbook && !workbook.ready) action = retry ? '重试生成工作簿' : '生成实时工作簿';
    textAt('jobs-live-workbook',action);
    status.hidden = !workbook || button.hidden;
    if (status.hidden) return;
    const name = workbook.fileName || '岗位资料库.xlsx';
    let message = workbook.ready ? `${name} · 上次写入 ${dateLabel(workbook.updatedAt)}` : '实时工作簿尚未生成';
    if (changed) message = `${name} · 文件已被外部更改，重新生成会用当前岗位替换此文件`;
    if (workbook.pending || workbook.state === 'writing') message = workbook.ready && !changed ? `${name} · 有待写入的岗位变动` : '正在生成实时工作簿…';
    if (workbook.state === 'locked') message = `${name} · 正被占用，关闭 Excel 后小鲸会补写更新`;
    if (workbook.state === 'error') message = `${name} · 实时工作簿更新失败，可以导出岗位快照`;
    textAt('jobs-workbook-status',message);
  }

  async function openDetail(id) {
    if (!currentTable() || dialog.open) return;
    detailJobId=undefined;
    const request = ++detailRequest;
    const stillSelected = () => !panel.hidden && request === detailRequest && currentTable() && !dialog.open;
    const row = await api('/api/jobs/detail?'+new URLSearchParams({id})).catch(error=>{
      if (stillSelected()) throw error;
    });
    if (!row || !stillSelected()) return;
    textAt('jobs-detail-company',[row.company,row.city].filter(Boolean).join(' · ') || '公司或城市待识别');
    textAt('jobs-detail-title',row.title || '职位名称待识别');
    const metadata = el('dl','jobs-detail-fields');
    const progress = row.progress || {};
    const fields = [['薪资',row.salary],['经验',row.experience],['来源',currentSource(row)],['采集状态',statuses[row.status]],['岗位匹配',fits[row.fit]],['最近发现',dateLabel(row.lastSeenAt)],['跟进状态',stages[progress.status]],['进展记录',dateLabel(progress.at)],['简历发送',progress.resume==='confirmed'?'已确认':'暂无确认']];
    for (const [label,value] of fields) {
      const field = el('div','');
      field.append(el('dt','',label),el('dd','',value || missing));
      metadata.append(field);
    }
    const body = $('jobs-detail-body');
    body.replaceChildren(metadata);
    if (row.matchReason) body.append(el('p','jobs-match-reason',row.matchReason));
    if (window.xiaojingDesktop && row.relatedConversations?.length) {
      const related = el('section','jobs-related');
      related.append(el('h4','','相关会话'));
      for (const conversation of row.relatedConversations) {
        const open = el('button','',`打开 ${conversation.label} 的会话`);
        open.type='button';
        open.onclick=()=>{dialog.close();window.showMemoryConversation?.(conversation.peerId);};
        related.append(open);
      }
      body.append(related);
    }
    body.append(el('h4','','岗位说明'),el('div','jobs-description',row.description || '小鲸还没有读取到这份岗位的正文。'));
    const link = $('jobs-original'), url = safeURL(row.url);
    link.hidden = !url;
    if (url) link.href = url;
    else link.removeAttribute('href');
    detailJobId=id;
    dialog.showModal();
  }

  function jobFocusVisible(button) {
    const viewport=$('jobs-table-scroll'), clip=viewport.getBoundingClientRect(), box=button.getBoundingClientRect();
    const left=clip.left+viewport.clientLeft, top=clip.top+viewport.clientTop;
    const headerBottom=head.querySelector('th')?.getBoundingClientRect().bottom ?? top;
    return box.right>Math.max(0,left) && box.left<Math.min(innerWidth,left+viewport.clientWidth) &&
      box.bottom>Math.max(0,top,headerBottom) && box.top<Math.min(innerHeight,top+viewport.clientHeight);
  }

  function renderRows() {
    const previousFocus = document.activeElement;
    const activeId = !panel.hidden && table.contains(previousFocus) ? previousFocus.dataset.jobId : undefined;
    const activeIndex = activeId ? previousFocus.closest('tr').sectionRowIndex : -1;
    const wasVisible = activeIndex >= 0 && jobFocusVisible(previousFocus);
    const {rows:pageRows=[],offset=0}=snapshot||{};
    const fragment = document.createDocumentFragment();
    if (!pageRows.length) {
      const row = el('tr','jobs-empty-row'), cell = el('td','');
      cell.colSpan = columnLabels.length;
      cell.append(el('strong','','正在读取岗位'),el('span','','正在连接本地资料库。'));
      row.append(cell);fragment.append(row);
    }
    let focused;
    for (const [index,row] of pageRows.entries()) {
      const line = el('tr','');
      const number = el('td','jobs-row-number',numbers.format(offset+index+1));
      const titleCell = el('td','jobs-row-title');
      const job = el('button','jobs-detail-trigger',row.title || '职位名称待识别');
      job.type = 'button';job.title = job.textContent;job.dataset.jobId = row.id;
      job.onclick = guard(()=>openDetail(row.id));
      titleCell.append(job);
      line.append(number,titleCell);
      if (row.id === activeId) focused = job;
      for (const [value,css] of [[row.company,''],[row.city,''],[row.salary,'jobs-numeric'],[row.experience,''],[currentSource(row),'jobs-row-source'],[statuses[row.status],'jobs-row-status'],[fits[row.fit],'jobs-row-fit'],[stages[row.progress?.status],'jobs-row-stage'],[dateLabel(row.lastSeenAt),'jobs-numeric jobs-row-date']]) {
        const cell = el('td',css,value || missing);
        if (value && value !== missing) cell.title = value;
        else cell.classList.add('jobs-missing');
        line.append(cell);
      }
      line.querySelector('.jobs-row-fit').dataset.fit = row.fit;
      line.querySelector('.jobs-row-stage').dataset.stage = row.progress?.status || 'unobserved';
      fragment.append(line);
    }
    table.replaceChildren(fragment);
    const active = document.activeElement;
    const focusLost = active === document.body || active === document.documentElement;
    if (activeIndex >= 0 && !panel.hidden && focusLost && !document.querySelector('dialog[open]')) {
      if (focused && !focused.disabled) {
        const reveal = wasVisible && !jobFocusVisible(focused);
        focused.focus({preventScroll:!reveal});
      }
      else {
        let nearest, distance = Infinity;
        for (const button of table.querySelectorAll('.jobs-detail-trigger:enabled')) {
          const gap = Math.abs(button.closest('tr').sectionRowIndex - activeIndex);
          if (gap < distance) { nearest=button;distance=gap; }
        }
        (nearest || $('jobs-query')).focus();
      }
    }
    for (const [field,{header,marker}] of sortButtons) {
      if (field === filters.sort) {
        header.setAttribute('aria-sort',filters.direction === 'asc' ? 'ascending' : 'descending');
        marker.textContent = filters.direction === 'asc' ? '↑' : '↓';
      } else {
        header.removeAttribute('aria-sort');
        marker.textContent = '↕';
      }
    }
  }

  function renderCounts(counts) {
    for (const button of sourceButtons) button.querySelector('span').textContent = numbers.format(counts[button.dataset.jobsSource]);
  }

  function updateTableControls() {
    const current = currentTable();
    const {page=1,pages=1,total=0,offset=0,rows=[]}=snapshot||{};
    const summary = total ? `第 ${numbers.format(offset+1)}–${numbers.format(offset+rows.length)} 条 · 共 ${numbers.format(total)} 条` : '共 0 条岗位';
    textAt('jobs-page-summary',snapshot && !current ? `上次结果 · ${summary}` : summary);
    textAt('jobs-page-label',`${page} / ${pages}`);
    $('jobs-prev').disabled = !current || page <= 1;
    $('jobs-next').disabled = !current || page >= pages;
    $('jobs-export').disabled = !current || exporting || !total;
    $('jobs-clear').hidden = !queryValue() && ['jobs-status','jobs-fit','jobs-stage'].every(id=>$(id).value==='all') && filters.source === 'all';
    for (const job of table.querySelectorAll('.jobs-detail-trigger')) job.disabled = !current;
    const empty = table.querySelector('.jobs-empty-row td');
    if (snapshot && empty) {
      const hasJobs = snapshot.counts.all > 0;
      empty.querySelector('strong').textContent = !current ? '上次结果为空' : hasJobs ? '没有符合当前筛选的岗位' : '还没有保存的岗位';
      empty.querySelector('span').textContent = !current ? '当前筛选结果尚未更新。' : hasJobs ? '试试其他关键词，或清除当前筛选。' : '小鲸读取收藏或搜索结果后，岗位会自动出现在这里。';
    }
  }

  function markTableChange() {
    if (!currentTable()) {
      detailRequest++;
      syncStatus(snapshot ? '正在更新岗位表 · 暂显示上次结果' : '正在加载岗位…','pending');
    }
    updateTableControls();
  }

  function savePreferences() {
    const {source,sort,direction}=filters;
    const selections=Object.fromEntries(preferenceFields.map(id=>[id,$(id).value]));
    try { localStorage.setItem(preferenceKey,JSON.stringify({source,sort,direction,selections})); } catch {}
  }

  function restorePreferences() {
    let saved;
    try { saved=JSON.parse(localStorage.getItem(preferenceKey)); } catch { return; }
    if (!saved) return;
    if (sourceButtons.some(button=>button.dataset.jobsSource===saved.source)) {
      filters.source=saved.source;
      for (const button of sourceButtons) button.setAttribute('aria-pressed',String(saved.source===button.dataset.jobsSource));
    }
    if (sortButtons.has(saved.sort) && ['asc','desc'].includes(saved.direction)) {
      filters.sort=saved.sort;filters.direction=saved.direction;
    }
    for (const id of preferenceFields) {
      const field=$(id), value=saved.selections?.[id];
      if ([...field.options].some(option=>option.value===value)) field.value=value;
    }
  }

  async function load() {
    if (panel.hidden) return;
    const query = tableQuery();
    if (fetching?.query === query && !fetching.controller.signal.aborted) return;
    fetching?.controller.abort();
    const controller = new AbortController();
    fetching = {query,controller};
    const refresh = $('jobs-refresh');
    refresh.disabled = true;
    try {
      const headers = {'X-Boss-Token':token};
      if (etag && loadedQuery === query) headers['If-None-Match'] = etag;
      const response = await fetch('/api/jobs/table?'+query,{headers,cache:'no-store',signal:controller.signal});
      if (controller.signal.aborted || query !== tableQuery()) return;
      if (response.status === 304) {
        syncStatus(`实时更新 · ${dateLabel(Date.now(),localTime)}`,'live');
        return;
      }
      if (!response.ok) throw Error('未能读取本地岗位表');
      const value = await response.json();
      if (!Array.isArray(value.rows)) throw Error('本地岗位表返回格式有误');
      if (controller.signal.aborted || query !== tableQuery()) return;
      filters.page = value.page;
      loadedQuery = tableQuery();
      etag = query === loadedQuery ? response.headers.get('ETag') : undefined;
      workbook = value.workbook;
      const {workbook:ignored,updatedAt,...tableState}=value;
      const next = JSON.stringify([loadedQuery,tableState]);
      const tableChanged = next !== signature;
      if (tableChanged) {
        snapshot = tableState;signature = next;
        renderCounts(value.counts);renderRows();
      }
      updateTableControls();
      renderWorkbook();
      syncStatus(`实时更新 · ${dateLabel(Date.now(),localTime)}`,'live',tableChanged);
    } catch {
      if (controller.signal.aborted || query !== tableQuery()) return;
      syncStatus(snapshot && !currentTable() ? '暂时无法更新岗位表 · 暂显示上次结果' : '暂时无法更新岗位表','error');
      if (signature === undefined) {
        const empty = table.querySelector('.jobs-empty-row td');
        empty?.replaceChildren(el('strong','','未能读取岗位'),el('span','','请点击刷新按钮重试。'));
      }
    } finally {
      if (fetching?.controller === controller) {
        fetching = undefined;
        refresh.disabled = false;
      }
    }
  }

  async function exportRows() {
    if (exporting || !snapshot?.total || !currentTable()) return;
    const button = $('jobs-export'), format = $('jobs-format').value;
    const query = new URLSearchParams({...queryOptions(),format});
    exporting = true;button.disabled = true;button.setAttribute('aria-busy','true');
    try {
      const response = await fetch(`/api/jobs/export?${query}`,{headers:{'X-Boss-Token':token}});
      if (!response.ok) throw Error('未能导出当前筛选结果');
      const stamp = /xiaojing-jobs-(\d{4}-\d{2}-\d{2})\./.exec(response.headers.get('Content-Disposition')||'')?.[1] || fileDate.format(Date.now());
      const objectURL = URL.createObjectURL(await response.blob());
      if (typeof window.xiaojingDesktop?.saveJobsExport === 'function') {
        try {
          notice('请选择岗位表的保存位置。');
          const result = await window.xiaojingDesktop.saveJobsExport({url:objectURL,format,stamp});
          if (result === 'cancelled') notice('已取消保存岗位表。');
          else if (result === 'completed') notice('岗位表已保存。');
          else throw Error('岗位表保存中断，请重试');
        } finally { URL.revokeObjectURL(objectURL); }
        return;
      }
      const link = el('a','');
      link.href = objectURL;
      link.download = `小鲸岗位_${stamp}.${format}`;
      document.body.append(link);link.click();link.remove();
      setTimeout(() => URL.revokeObjectURL(objectURL),1000);
      notice('已发起岗位表下载。');
    } catch (error) { notice(error.message,true); }
    finally {
      exporting = false;updateTableControls();button.removeAttribute('aria-busy');
    }
  }

  const headerRow = el('tr','');
  for (const [index,[field,label]] of columnLabels.entries()) {
    const header = el('th',index === 0 ? 'jobs-row-number' : index === 1 ? 'jobs-row-title' : '');
    header.scope = 'col';
    if (!field) header.textContent = label;
    else {
      const control = el('button','jobs-sort',label), marker = el('span','jobs-sort-marker','↕');
      control.type = 'button';marker.setAttribute('aria-hidden','true');control.append(marker);
      control.onclick = () => {
        filters.direction = filters.sort === field && filters.direction === 'asc' ? 'desc' : 'asc';
        filters.sort = field;
        changeFilters();
      };
      sortButtons.set(field,{header,marker});header.append(control);
    }
    headerRow.append(header);
  }
  head.append(headerRow);
  function changeFilters() {
    clearTimeout(filterTimer);
    filters.page = 1;$('jobs-table-scroll').scrollTop = 0;
    savePreferences();
    markTableChange();void load();
  }
  function setSource(value) {
    filters.source = value;
    for (const button of sourceButtons) button.setAttribute('aria-pressed',String(value === button.dataset.jobsSource));
    changeFilters();
  }
  for (const button of sourceButtons) button.onclick = () => setSource(button.dataset.jobsSource);
  $('jobs-query').oninput = () => {
    filters.page = 1;markTableChange();clearTimeout(filterTimer);filterTimer = setTimeout(changeFilters,120);
  };
  for (const [value,label] of Object.entries(stages)) {
    const option = el('option','',label);option.value = value;$('jobs-stage').append(option);
  }
  restorePreferences();
  for (const id of ['jobs-status','jobs-fit','jobs-stage','jobs-page-size']) $(id).onchange = changeFilters;
  $('jobs-format').onchange = savePreferences;
  $('jobs-clear').onclick = () => {
    $('jobs-query').value = '';
    for (const id of ['jobs-status','jobs-fit','jobs-stage']) $(id).value = 'all';
    setSource('all');
  };
  function selectPage(step) {
    if (!currentTable()) return;
    const page = snapshot.page+step;
    if (page < 1 || page > snapshot.pages) return;
    filters.page = page;$('jobs-table-scroll').scrollTop = 0;
    markTableChange();void load();
  }
  $('jobs-prev').onclick = () => selectPage(-1);
  $('jobs-next').onclick = () => selectPage(1);
  $('jobs-refresh').onclick = load;
  $('jobs-export').onclick = exportRows;
  $('jobs-detail-close').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    const id=detailJobId, active=document.activeElement;
    detailJobId=undefined;
    // Native dialog focus restoration already handles a surviving invoker.
    const focusLost=active===document.body||active===document.documentElement||dialog.contains(active);
    if (!id || panel.hidden || !focusLost || document.querySelector('dialog[open]')) return;
    const replacement=[...table.querySelectorAll('.jobs-detail-trigger:enabled')].find(row=>row.dataset.jobId===id);
    (replacement || $('jobs-query')).focus();
  });
  $('jobs-live-workbook').onclick = async () => {
    if (openingWorkbook) return;
    openingWorkbook = true;renderWorkbook();
    try {
      const result = await window.xiaojingDesktop.openJobsWorkbook(workbook?.externallyChanged===true);
      if (result?.pending) { notice('已安排生成实时工作簿。');return; }
      if (result?.externallyChanged) { notice('实时工作簿已被外部更改，可选择重新生成。');return; }
      if (result?.ok === false) throw Error(result.error || '无法打开实时工作簿');
      notice('已打开实时工作簿。');
    } catch (error) { notice(error.message,true); }
    finally { openingWorkbook = false;renderWorkbook();void load(); }
  };
  new MutationObserver(() => {
    if (panel.hidden) {
      detailRequest++;
      fetching?.controller.abort();
      if (dialog.open) dialog.close();
    }
    else void load();
  }).observe(panel,{attributes:true,attributeFilter:['hidden']});
  window.renderJobsTable = load;
  renderRows();updateTableControls();
})();
