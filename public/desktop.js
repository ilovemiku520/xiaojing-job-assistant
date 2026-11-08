(() => {
  const desktop = window.xiaojingDesktop;
  const text = (id, value) => { $(id).textContent = value; };
  const personaFields = [['persona',$('desktop-persona')],['rules',$('desktop-rules')]];
  const unsavedPersona = new Set();
  const savedPersona = new Map(personaFields.map(([key,field])=>[key,field.value]));
  let libraryRead = 0, savingPersona = false;
  for (const [key,field] of personaFields) field.addEventListener('input',()=>{
    if (!savingPersona && field.value===savedPersona.get(key)) unsavedPersona.delete(key);
    else unsavedPersona.add(key);
  });
  const action = (id, fn) => {
    const button = $(id);
    button?.addEventListener('click', guard(async event => {
      button.disabled = true;
      try { await fn(event); } finally { button.disabled = false; }
    }));
  };

  function renderLibrary(data) {
    const list = $('desktop-documents');
    list.replaceChildren();
    if (!data.documents.length) list.append(el('p','muted','知识库为空。导入资料后，小鲸会在相关对话中检索。'));
    for (const doc of data.documents) {
      const row = el('div','desktop-row');
      row.append(el('span','',doc.name),el('small','muted',Math.ceil(doc.bytes/1024)+' KB'));
      const remove = el('button','','移除');
      remove.type = 'button';
      remove.onclick = guard(async () => {
        renderLibrary(await api('/api/library/document/remove',{id:doc.id}));
        notice('知识资料已移除。');
      });
      row.append(remove);
      list.append(row);
    }
    text('desktop-resume-name', data.resume?.name || '尚未导入简历');
    $('desktop-show-resume').hidden = !desktop || !data.resume;
  }

  function applyLibrary(data) {
    for (const [key,field] of personaFields) if (!unsavedPersona.has(key)) {
      if (field.value!==data[key]) field.value=data[key];
      savedPersona.set(key,field.value);
    }
    renderLibrary(data);
  }

  async function refreshLibrary() {
    const read = ++libraryRead;
    const data = await api('/api/library');
    if (read===libraryRead) applyLibrary(data);
  }

  let mcpRead=0,mcpWrites=Promise.resolve(),savingMcp=false;
  const mcpVisible=()=>desktop?window.activeDesktopSettings?.()==='mcp':!$('mcp').hidden;
  async function refreshMcp(){
    const read=++mcpRead,current=()=>read===mcpRead&&mcpVisible();
    await mcpWrites;
    if(!current())return;
    try{
      const data=await api('/api/mcp-tools');
      if(current())renderMcp(data);
    }catch(error){if(current())throw error;}
  }
  function updateMcp(change){
    mcpRead++;
    const write=mcpWrites.then(async()=>renderMcp(await api('/api/mcp-tools',change)));
    mcpWrites=write.catch(()=>{});
    return write;
  }
  function mcpAction(control,change){
    control.onclick=guard(async()=>{
      if(control.disabled||!control.isConnected||!mcpVisible())return;
      control.disabled=true;
      try{await updateMcp(change);}finally{control.disabled=false;}
    });
  }
  function renderMcp(data) {
    const list = $('desktop-tools');
    list.replaceChildren();
    $('desktop-mcp-form').hidden = !!data.configurationError;
    if (data.configurationError) {
      const actions = el('div','desktop-actions');
      if (desktop) {
        const folder = el('button','','打开资料目录');
        folder.type = 'button';
        folder.onclick = guard(async () => desktop.showDataFolder());
        actions.append(folder);
      }
      const reload = el('button','','重新读取');
      reload.type = 'button';
      reload.onclick = guard(refreshMcp);
      actions.append(reload);
      list.append(el('p','',data.configurationError),el('p','muted','修复 mcp-servers.json，或重命名该文件留作备份，然后重新读取。'),actions);
      return;
    }
    if (!data.servers.length) list.append(el('p','muted','尚未添加 MCP 工具。'));
    for (const server of data.servers) {
      const row = el('div','desktop-row');
      const details = el('div');
      let status = server.enabled?'配置已启用':'已暂停';
      if (!server.installed) status += ' · 启动程序未找到，暂未加载。请检查启动命令或使用可执行文件的绝对路径。';
      else if (server.enabled) status += server.autonomous?' · 允许自主规划使用':' · 对话可用';
      details.append(el('strong','',server.label),el('p','muted',status));
      row.append(details);
      const toggle = el('button','',server.enabled?'暂停':'启用');
      toggle.type = 'button';
      toggle.disabled = !server.installed && !server.enabled;
      mcpAction(toggle,{action:'toggle',name:server.name,enabled:!server.enabled});
      row.append(toggle);
      if (server.sourceKind === 'custom') {
        const remove = el('button','','移除');
        remove.type = 'button';
        mcpAction(remove,{action:'remove',name:server.name});
        row.append(remove);
      }
      list.append(row);
    }
  }

  if(!desktop)document.querySelectorAll('[data-panel="library"],[data-panel="mcp"]').forEach(button=>{
    button.addEventListener('click',guard(async ()=>{
      if(button.dataset.panel==='library')await refreshLibrary();
      if(button.dataset.panel==='mcp')await refreshMcp();
    }));
  });

  $('desktop-persona-form').onsubmit = guard(async event => {
    const button = event.currentTarget.querySelector('button');
    if (savingPersona) return;
    if (!unsavedPersona.size) {notice('人格与沟通规则没有修改。');return;}
    const values = Object.fromEntries(personaFields.filter(([key])=>unsavedPersona.has(key)).map(([key,field])=>[key,field.value]));
    savingPersona = button.disabled = true;
    try {
      const data = await api('/api/library/persona',values);
      libraryRead++;
      for (const [key,field] of personaFields) if (Object.hasOwn(values,key) && field.value===values[key]) unsavedPersona.delete(key);
      applyLibrary(data);
      notice(unsavedPersona.size?'已保存提交时的规则，之后的修改仍在编辑框。':'人格和沟通规则已保存。');
    } finally { savingPersona = button.disabled = false; }
  });
  async function readTextFile(file) {
    if (file.size > 256*1024) throw Error('每份文本文件最多 256 KB');
    const bytes=await file.arrayBuffer();
    try { return new TextDecoder('utf-8',{fatal:true}).decode(bytes); }
    catch { throw Error('请选择 UTF-8 编码的文本文件'); }
  }

  function bindFileImport(input,dropTarget,importFiles) {
    const importSelection=async files=>{
      if (!files.length || input.disabled) return;
      input.disabled=true;
      try { await importFiles(files); }
      catch (error) { notice(error.message||'导入失败',true); }
      finally { input.value='';input.disabled=false; }
    };
    input.addEventListener('change',()=>void importSelection([...input.files]));
    if (!desktop) return;
    dropTarget.addEventListener('dragover',event=>{
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect=input.disabled?'none':'copy';
      dropTarget.classList.toggle('desktop-file-over',!input.disabled);
    });
    dropTarget.addEventListener('dragleave',event=>{
      if (!dropTarget.contains(event.relatedTarget)) dropTarget.classList.remove('desktop-file-over');
    });
    dropTarget.addEventListener('drop',event=>{
      dropTarget.classList.remove('desktop-file-over');
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      void importSelection([...event.dataTransfer.files]);
    });
  }

  const documentInput=$('desktop-document-file');
  bindFileImport(documentInput,documentInput.closest('label'),async files=>{
    let added=0,duplicates=0;
    const issues=[];
    const progress=$('desktop-document-progress');
    progress.hidden=false;
    try {
      for (const [index,file] of files.entries()) {
        progress.textContent=`正在导入 ${index+1} / ${files.length} 份`;
        try {
          const content=await readTextFile(file);
          const result=await api('/api/library/document',{name:file.name,text:content});
          if (result.importStatus==='duplicate') duplicates++;
          else added++;
          renderLibrary(result);
        } catch (error) { issues.push(`${file.name}（${error.message||'导入未确认'}）`); }
      }
    } finally {
      progress.hidden=true;
    }
    const summary=`新增 ${added} 份，重复 ${duplicates} 份`;
    const more=issues.length>5?`，另有 ${issues.length-5} 份需处理`:'';
    notice(issues.length?`${summary}，${issues.length} 份需处理。${issues.slice(0,5).join('、')}${more}。`:`${summary}。`,issues.length>0);
  });
  const resumeInput=$('desktop-resume-file');
  bindFileImport(resumeInput,resumeInput.closest('label'),async files=>{
    if (files.length!==1 || !/\.pdf$/i.test(files[0].name)) throw Error('请选择一份 PDF 简历');
    const [file]=files;
    if (file.size > 8*1024*1024) throw Error('PDF 简历最多 8 MB');
    const encoded = await new Promise((resolve,reject)=>{
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.onerror = () => reject(Error('无法读取简历文件'));
      reader.readAsDataURL(file);
    });
    renderLibrary(await api('/api/library/resume',{name:file.name,base64:encoded}));
    notice('PDF 简历已导入。站内发送使用 BOSS 账号中的附件，请在 BOSS 上传并核对名称。');
  });
  $('desktop-mcp-form').onsubmit = guard(async event => {
    if(savingMcp)return;
    const field=$('desktop-mcp-json'),submitted=field.value,button=event.currentTarget.querySelector('button');
    let server;
    try { server = JSON.parse(submitted); } catch {throw Error('请输入有效的 MCP 工具 JSON');}
    savingMcp=button.disabled=true;
    try{
      await updateMcp({action:'add',server});
      if(field.value===submitted)field.value='';
      notice('MCP 工具配置已保存。');
    }finally{savingMcp=button.disabled=false;}
  });

  document.querySelectorAll('[data-desktop-only]').forEach(node => {node.hidden = !desktop;});
  if (!desktop) return;
  document.body.classList.add('desktop-shell');
  function addTextImport(field,label,{mcp=false}={}) {
    const controls=el('div','desktop-text-import wide');
    const picker=el('label','desktop-file-picker',mcp?'导入 JSON':'导入文本');
    const input=el('input');input.id=field.id+'-file';input.type='file';input.accept=mcp?'.json':'.txt,.md,.markdown,.json';
    input.setAttribute('aria-label',`导入${label}${mcp?' JSON':'文本'}`);
    const hint=el('span','muted',mcp?'JSON · 可拖入空白编辑框':'TXT、Markdown、JSON · 可拖入编辑框');hint.id=field.id+'-import-hint';
    const status=el('span','desktop-text-import-status');status.setAttribute('role','status');
    field.setAttribute('aria-describedby',hint.id);
    picker.append(input);controls.append(picker,hint,status);field.closest('label').after(controls);
    bindFileImport(input,field,async files=>{
      try {
        if (files.length!==1) throw Error('请一次导入一份文本文件');
        const [file]=files;
        if (mcp ? !/\.json$/i.test(file.name) : !/\.(txt|md|markdown|json)$/i.test(file.name)) {
          throw Error(mcp?'请选择 JSON 配置文件':'请选择 TXT、Markdown 或 JSON 文件');
        }
        const content=(await readTextFile(file)).replace(/\r\n?/g,'\n');
        if (!content.trim() || content.includes('\0')) throw Error('文件须包含有效文本');
        if (/\.json$/i.test(file.name)) {
          let value;
          try { value=JSON.parse(content); }
          catch { throw Error('JSON 文件格式无效'); }
          if (mcp && (!value || typeof value!=='object' || Array.isArray(value))) throw Error('MCP 配置须为一个 JSON 对象');
        }
        const current=field.value;
        if (mcp && (current.trim() || savingMcp)) throw Error('请先保存或移走当前内容，再导入 JSON');
        const separator=current && !current.endsWith('\n\n') ? (current.endsWith('\n')?'\n':'\n\n') : '';
        const value=mcp?content:current+separator+content;
        if (value.length>field.maxLength) throw Error(`导入后会超过此栏的 ${field.maxLength.toLocaleString('zh-CN')} 字限制`);
        field.value=value;
        field.dispatchEvent(new Event('input',{bubbles:true}));
        status.textContent=mcp?`已载入「${file.name}」，点击「添加 MCP 工具」保存。`:`已追加「${file.name}」，保存后生效。`;
      } catch (error) {
        status.textContent=error.message||'无法导入文本';
      }
    });
  }
  const profileFacts=$('profile-form').elements.facts;
  profileFacts.id='desktop-profile-facts';profileFacts.maxLength=16000;
  addTextImport(profileFacts,'经历与能力');
  addTextImport($('desktop-persona'),'人格设定');
  addTextImport($('desktop-rules'),'补充规则');
  addTextImport($('desktop-mcp-json'),' MCP 配置',{mcp:true});
  documentInput.closest('label').append(el('small','desktop-drop-hint','可把文件拖到这里'));
  resumeInput.closest('label').append(el('small','desktop-drop-hint','可把 PDF 拖到这里'));
  document.querySelectorAll('[data-legacy-only]').forEach(node => {node.hidden = true;});
  document.querySelector('.aside-note')?.remove();
  const nav = $('main-nav');
  const drawer = el('section','desktop-settings-drawer');
  drawer.id='desktop-settings-drawer';drawer.hidden=true;drawer.setAttribute('aria-labelledby','desktop-settings-title');
  const settingsHeader=el('div','desktop-settings-header'),settingsTitle=el('h2','','设置');settingsTitle.id='desktop-settings-title';
  const settingsNav=el('nav','desktop-settings-nav');settingsNav.id='desktop-settings-nav';settingsNav.setAttribute('aria-label','设置分类');
  const settingsContent=el('div','desktop-settings-content');
  const settingsPanes=new Map(),settingsButtons=new Map();
  function iconButton(id,label,path){
    const button=el('button','desktop-icon-button'),namespace='http://www.w3.org/2000/svg';
    const icon=document.createElementNS(namespace,'svg');
    icon.setAttribute('viewBox','0 0 24 24');icon.setAttribute('aria-hidden','true');
    icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.6');
    icon.setAttribute('stroke-linecap','round');icon.setAttribute('stroke-linejoin','round');
    const shape=document.createElementNS(namespace,'path');shape.setAttribute('d',path);icon.append(shape);
    button.id=id;button.type='button';button.title=label;button.setAttribute('aria-label',label);button.append(icon);return button;
  }
  const gearPath='M10 3h4l.5 2.2 1.4.8 2.2-.7 2 3.5-1.7 1.5v1.7l1.7 1.5-2 3.5-2.2-.7-1.4.8L14 19h-4l-.5-2.2-1.4-.8-2.2.7-2-3.5 1.7-1.5V10L3.9 8.5l2-3.5 2.2.7 1.4-.8L10 3ZM14.5 11a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z';
  const gear=iconButton('desktop-settings-toggle','设置',gearPath),browserGear=iconButton('embedded-settings-toggle','设置',gearPath);
  const closeSettings=iconButton('desktop-settings-close','收起设置栏','M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6Zm11-2v16m-6-5 3-3-3-3');
  const brand=document.querySelector('.brand'),brandRow=el('div','desktop-brand-row');brand.before(brandRow);brandRow.append(brand,gear);
  $('embedded-hide').before(browserGear);
  settingsHeader.append(settingsTitle,closeSettings);drawer.append(settingsHeader,settingsNav,settingsContent);document.body.append(drawer);
  for(const button of [gear,browserGear]){
    button.title='设置（Ctrl+,）';button.setAttribute('aria-controls',drawer.id);button.setAttribute('aria-expanded','false');
  }
  closeSettings.setAttribute('aria-controls',drawer.id);
  const browserPreferences=el('section','panel desktop-settings');browserPreferences.id='browser-settings';browserPreferences.hidden=true;
  const openFromSettings=el('button','','前往内置浏览器');openFromSettings.id='desktop-settings-open-embedded';openFromSettings.type='button';
  const builtIn=el('div','desktop-sheet desktop-section');builtIn.append(el('h3','','内置浏览器'),el('p','muted','在桌面工作区打开 BOSS，并沿用此应用的登录会话。'),openFromSettings);
  browserPreferences.append(document.querySelector('.desktop-browser-fallback'),builtIn);
  const browserCategory=el('button','nav','浏览器');browserCategory.type='button';browserCategory.dataset.panel='browser-settings';
  browserCategory.onclick=()=>panel('browser-settings');
  const connectionShortcut=$('desktop-connection-links').querySelector('[data-goto="browser-setup"]');
  connectionShortcut.dataset.goto='browser-settings';
  for(const [name,section,button] of [
    ['browser-settings',browserPreferences,browserCategory],
    ...['profile','library','providers','mcp','settings','connection'].map(name=>[name,$(name),nav.querySelector('[data-panel="'+name+'"]')])
  ]){
    settingsPanes.set(name,section);settingsButtons.set(name,button);settingsContent.append(section);settingsNav.append(button);
  }
  for (const [label, panels] of [
    ['工作区',['overview','owner','job-channel','hr-channel','browser-setup','jobs']],
    ['任务与记录',['control','memory','learning']]
  ]) {
    const group = el('div','desktop-nav-group');
    group.append(el('div','desktop-nav-title',label));
    for (const panel of panels) {
      const item = nav.querySelector('[data-panel="'+panel+'"]');
      if (item) group.append(item);
    }
    nav.append(group);
  }
  const advanced = el('details','desktop-nav-group desktop-nav-advanced');
  advanced.append(el('summary','desktop-nav-title','高级与诊断'));
  for (const panel of ['context','project-map']) {
    const item = nav.querySelector('[data-panel="'+panel+'"]');
    if (item) advanced.append(item);
  }
  nav.append(advanced);

  let embeddedOpen = false, layoutQueued = false, currentTabSignature = '', lastBounds = '';
  let externalBrowserRevision = -1, requestingBrowser = false, requestedBrowser = false;
  let settingsSelection='browser-settings',settingsOpener,settingsNativeTabId,settingsFocusRevision=0;
  const preferredGear=()=>embeddedOpen&&document.body.dataset.view==='browser-setup'?browserGear:gear;
  function presentSettings(open){
    drawer.hidden=!open;document.body.classList.toggle('desktop-settings-open',open);
    for(const button of [gear,browserGear])button.setAttribute('aria-expanded',String(open));
    layoutBrowser();
  }
  function showSettings(name,opener,refocus=false){
    const opening=drawer.hidden,changed=settingsSelection!==name;
    if(opening){settingsOpener=opener||document.activeElement;settingsFocusRevision++;}
    settingsSelection=name;
    for(const [key,section] of settingsPanes){
      const active=key===name,button=settingsButtons.get(key);
      section.hidden=!active;button.classList.toggle('active',active);
      if(active)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    }
    if(opening)presentSettings(true);
    if(opening||changed||refocus)settingsButtons.get(name).focus({preventScroll:true});
    if(opening||changed){
      settingsContent.scrollTop=0;
      renderCurrentContent();
      const read=name==='library'?refreshLibrary():name==='mcp'?refreshMcp():undefined;
      read?.catch(error=>{if(window.activeDesktopSettings()===name)notice(error.message,true);});
      document.dispatchEvent(new CustomEvent('desktop-panel',{detail:name}));
    }
  }
  function hideSettings({restoreFocus=true}={}){
    if(drawer.hidden)return;
    presentSettings(false);
    const opener=settingsOpener,nativeTabId=settingsNativeTabId,revision=++settingsFocusRevision;
    settingsOpener=settingsNativeTabId=undefined;
    if(!restoreFocus)return;
    const fallback=()=>{
      if(drawer.hidden&&settingsFocusRevision===revision)(opener?.isConnected&&opener.getClientRects().length?opener:preferredGear()).focus({preventScroll:true});
    };
    if(nativeTabId===undefined||preferredGear()!==browserGear)fallback();
    else void desktop.embedded('focus-tab',nativeTabId).then(restored=>{if(!restored)fallback();},fallback);
  }
  window.activeDesktopSettings=()=>drawer.hidden?null:settingsSelection;
  window.openDesktopSettings=name=>{
    if(!settingsPanes.has(name))return false;
    closeMainMenu();showSettings(name);return true;
  };
  desktop.onSettingsShortcut?.(tabId=>{
    if(preferredGear()!==browserGear)return;
    settingsNativeTabId=tabId;
    closeMainMenu();showSettings(settingsSelection,browserGear,true);
  });
  for(const button of [gear,browserGear])button.onclick=()=>{
    if(!drawer.hidden)hideSettings();
    else{closeMainMenu();showSettings(button===browserGear?'browser-settings':settingsSelection,button);}
  };
  closeSettings.onclick=()=>hideSettings();
  document.addEventListener('keydown',event=>{
    if(event.ctrlKey&&!event.altKey&&!event.shiftKey&&!event.metaKey&&!event.repeat&&event.key===','){
      event.preventDefault();closeMainMenu();showSettings(settingsSelection,preferredGear(),true);
    }else if(event.key==='Escape'&&!drawer.hidden&&drawer.contains(event.target)){
      event.preventDefault();hideSettings();
    }
  });
  function presentBrowser(open) {
    document.body.classList.toggle('desktop-embedded-open',open);
    $('embedded-workspace').hidden = !open;
    $('embedded-intro').hidden = open;
    lastBounds = '';
  }
  function browserBounds() {
    const rect = $('embedded-surface').getBoundingClientRect();
    return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};
  }
  function layoutBrowser() {
    if (!embeddedOpen || layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      if (!embeddedOpen) return;
      const visible = !$('browser-setup').hidden && !$('embedded-workspace').hidden;
      const bounds = visible?browserBounds():undefined;
      const signature = bounds?JSON.stringify([bounds,window.devicePixelRatio]):'hidden';
      if (signature === lastBounds) return;
      lastBounds = signature;
      desktop.embedded(visible?'bounds':'hide', bounds).catch(()=>{if (lastBounds === signature) lastBounds = '';});
    });
  }
  function renderEmbedded(browser) {
    if (!browser) return;
    const status = browser.error || (browser.loading?'正在加载 BOSS…':browser.ready?'桥接就绪':'等待 BOSS 页面和桥接…');
    text('embedded-status',status);
    $('embedded-status').title = status;
    const zoom = $('embedded-zoom');
    if (browser.zoomMode) zoom.value = browser.zoomMode;
    if (browser.zoomFactor) zoom.options[0].text = browser.zoomMode==='auto'?`自动适配 ${Math.round(browser.zoomFactor*100)}%`:'自动适配';
    $('embedded-back').disabled = !browser.canGoBack;
    $('embedded-forward').disabled = !browser.canGoForward;
    const signature = JSON.stringify(browser.tabs.map(tab=>[tab.id,tab.title,tab.active]));
    if (signature === currentTabSignature) return;
    currentTabSignature = signature;
    const strip = $('embedded-tabs');
    strip.replaceChildren();
    for (const tab of browser.tabs) {
      const group = el('div','embedded-tab'+(tab.active?' is-active':''));
      const choose = el('button','',tab.title||'BOSS 直聘');
      choose.type = 'button';
      choose.setAttribute('aria-pressed',String(tab.active));
      choose.onclick = guard(async()=>renderEmbedded(await desktop.embedded('select',tab.id)));
      group.append(choose);
      if(browser.tabs.length>1){
        const close = el('button','embedded-close','×');
        close.type = 'button';
        close.setAttribute('aria-label','关闭标签页');
        close.onclick = guard(async()=>renderEmbedded(await desktop.embedded('close-tab',tab.id)));
        group.append(close);
      }
      strip.append(group);
    }
    layoutBrowser();
  }
  desktop.onEmbeddedState(renderEmbedded);
  function renderExternalBrowser(state) {
    if (!state || state.revision<=externalBrowserRevision) return;
    externalBrowserRevision=state.revision;
    if (state.phase==='paired') {
      embeddedOpen=false;
      presentBrowser(false);
    }
    const messages={
      idle:'选择浏览器开始。',
      pending:state.mode==='managed'
        ? 'Chrome 已打开，等待扩展配对。配对完成后切换浏览器。'
        : '正在等待外部扩展配对。在扩展管理页启用开发者模式并加载下方目录，已加载时可以重新加载。',
      paired:'外部浏览器已配对。请在工作台查看 BOSS 登录、账号核对和发送校准状态。',
      cancelled:'已继续使用内置浏览器。本次外部配对已取消。',
      expired:state.activeExternal
        ? '本次外部配对已过期，原外部浏览器仍保持配对。'
        : '外部扩展配对已过期。请重新打开外部浏览器开始配对。'
    };
    text('desktop-browser-status',messages[state.phase]);
    text('desktop-browser-path',state.extensionPath||'');
  }
  desktop.onExternalBrowserState?.(renderExternalBrowser);
  void desktop.externalBrowserState?.().then(state=>{if(!requestedBrowser)renderExternalBrowser(state);}).catch(()=>{});
  desktop.onVersionMismatch?.(({runningVersion,launchedVersion}) => {
    notice(`当前运行 ${runningVersion}。关闭当前窗口后可启动新版 ${launchedVersion}。`);
  });
  async function openEmbedded(url) {
    presentBrowser(true);
    try {
      const bounds = browserBounds();
      const browser = url ? await desktop.embedded('open-job',{url,bounds}) : await desktop.embedded('open',bounds);
      renderEmbedded(browser);
      embeddedOpen = true;
      layoutBrowser();
      $('embedded-hide').focus();
    } catch(error) {
      presentBrowser(false);
      throw error;
    }
  }
  action('desktop-open-embedded', () => openEmbedded());
  action('desktop-settings-open-embedded',()=>{hideSettings({restoreFocus:false});panel('browser-setup');return openEmbedded();});
  desktop.onJobLink?.(url => {
    panel('browser-setup');
    void openEmbedded(url).catch(error=>notice(error.message||'无法打开 BOSS 岗位',true));
  });
  action('embedded-hide', async () => {
    await desktop.embedded('hide');
    embeddedOpen = false;
    presentBrowser(false);
    $('desktop-open-embedded').focus();
  });
  $('embedded-zoom').onchange = guard(async event=>renderEmbedded(await desktop.embedded('zoom',event.currentTarget.value)));
  for (const [name, id] of [['back','embedded-back'],['forward','embedded-forward'],['reload','embedded-reload']]) {
    action(id, async()=>renderEmbedded(await desktop.embedded(name)));
  }
  document.querySelectorAll('[data-embedded-page]').forEach(button=>{
    button.onclick = guard(async()=>renderEmbedded(await desktop.embedded('navigate',button.dataset.embeddedPage)));
  });
  new MutationObserver(layoutBrowser).observe($('browser-setup'),{attributes:true,attributeFilter:['hidden']});
  new ResizeObserver(layoutBrowser).observe($('embedded-surface'));
  window.addEventListener('resize',layoutBrowser);
  window.visualViewport?.addEventListener('resize',layoutBrowser);

  action('desktop-show-resume',()=>desktop.showResume());
  action('desktop-show-data',()=>desktop.showDataFolder());
  action('desktop-copy-mcp',async()=>{
    $('desktop-mcp-example').textContent = await desktop.copyMcpConfig(!$('desktop-mcp-control').checked);
    notice('MCP 客户端配置已复制。');
  });
  desktop.onBrowserProgress(message => text('desktop-browser-status',message));
  for (const [mode, id] of [['managed','desktop-open-managed'],['edge','desktop-open-edge'],['chrome','desktop-open-chrome']]) {
    action(id, async () => {
      if (requestingBrowser) return;
      requestedBrowser=true;
      requestingBrowser=true;
      const priorRevision=externalBrowserRevision;
      text('desktop-browser-status','正在准备浏览器…');
      try {
        renderExternalBrowser(await desktop.openBrowser(mode));
      } catch (error) {
        if (externalBrowserRevision===priorRevision) text('desktop-browser-status',error.message||'浏览器设置失败。');
        throw error;
      } finally { requestingBrowser=false; }
    });
  }
})();
