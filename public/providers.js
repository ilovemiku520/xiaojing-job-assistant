(() => {
  const names = {
    owner: '对话',
    autonomy: '自主规划',
    greeting: '岗位分析与招呼',
    reply: 'HR 回复',
    followup: '主动跟进',
    learning: '学习整理'
  };
  let settings, view, pendingLoad, routeSave, credentialSave;
  let settingsReads = 0, appliedSettingsRead = 0;
  const root = () => $('providers-content') || $('providers');
  const option = (value, label) => Object.assign(el('option', '', label), {value});
  const button = (label, type = 'button') => Object.assign(el('button', '', label), {type});
  const effortSupported = provider => provider === 'harness' || provider === 'deepseek';
  const credentialProvider = provider => provider === 'harness' ? 'deepseek' : provider;

  function labeled(label, control) {
    const field = el('label', 'provider-field', label);
    control.setAttribute('aria-label', label);
    field.append(control);
    return field;
  }

  function routeField(label, control) {
    const field = el('label', 'provider-route-field');
    field.append(el('span', '', label), control);
    return field;
  }

  function message(node, text, error = false) {
    node.textContent = text;
    node.classList.toggle('provider-error', error);
  }

  function section(title, description) {
    const outer = el('div', 'provider-section');
    const intro = el('div', 'provider-section-intro');
    intro.append(el('h2', '', title), el('p', 'provider-note', description));
    outer.append(intro);
    return {outer, intro};
  }

  function createRouteRow(stage, providers) {
    const name = names[stage] || stage;
    const row = el('div', 'provider-route-row');
    row.dataset.modelStage = stage;
    const title = el('div', 'provider-route-title');
    const current = el('span', 'provider-route-current');
    current.setAttribute('aria-live', 'polite');
    title.append(el('h3', '', name), current);

    const select = el('select');
    select.setAttribute('aria-label', name + '提供商');
    select.append(option('', '跟随默认'));
    for (const provider of providers) select.append(option(provider.id, provider.label));

    const model = Object.assign(el('input'), {type:'text', maxLength:160, spellcheck:false, autocomplete:'off'});
    model.setAttribute('aria-label', name + '模型 ID');
    const effort = el('select');
    effort.setAttribute('aria-label', name + '推理强度');
    effort.append(option('', '默认强度'), option('high', 'High'), option('max', 'Max'));

    const test = button('测试');
    test.setAttribute('aria-label', '测试' + name);
    const testResult = el('p', 'provider-inline-feedback');
    testResult.setAttribute('role', 'status');
    row.append(title, routeField('提供商',select), routeField('模型 ID',model), routeField('推理强度',effort), test, testResult);
    const record = {stage, row, current, select, model, effort, test, testResult};

    select.addEventListener('change', () => {
      const saved = settings.routes[stage];
      const override = settings.modelRoutes[stage];
      model.value = select.value === saved.provider ? saved.model : '';
      effort.value = select.value === override?.provider ? override.reasoningEffort || '' : '';
      updateRouteRow(record);
    });
    for (const input of [model, effort]) input.addEventListener('input', () => updateRouteRow(record));
    test.onclick = () => testRoute(record);
    return record;
  }

  function clearRouteTest(record) {
    record.testAttempt = undefined;
    message(record.testResult, '');
  }

  async function testRoute(record) {
    if (record.test.disabled) return;
    const {stage,testResult}=record, testRevision=settings.routes[stage].testRevision;
    const attempt=Symbol('model connection test');
    const current=()=>record.testAttempt===attempt;
    record.testAttempt=attempt;
    updateRouteRow(record);
    message(testResult, '正在测试已保存的模型…');
    let result, failure;
    try { result=await api('/api/test',{stage,testRevision}); }
    catch (error) { failure=error; }
    if (!current()) return;
    try {
      await loadSettings();
      if (!current()) return;
      if (failure) message(testResult, failure.message, true);
      else if (result.testRevision===testRevision) message(testResult, result.model + ' 连接成功');
      else clearRouteTest(record);
    } catch {
      if (current()) message(testResult, '暂时无法核对模型设置，请重试。', true);
    } finally {
      if (current()) record.testAttempt=undefined;
      updateRouteRow(record);
    }
  }

  function routeValue(record) {
    if (!record.select.value) return null;
    const effort = effortSupported(record.select.value) ? record.effort.value : '';
    return {provider:record.select.value, model:record.model.value.trim(), ...(effort ? {reasoningEffort:effort} : {})};
  }

  function sameRoute(a, b) {
    if (!a || !b) return a === b;
    return a.provider === b.provider && a.model === b.model &&
      (!effortSupported(a.provider) || (a.reasoningEffort || '') === (b.reasoningEffort || ''));
  }
  const isEdited = record => !sameRoute(routeValue(record), settings.modelRoutes[record.stage] || null);

  function updateRouteRow(record) {
    const saved = settings.routes[record.stage];
    const configured = settings.providers.find(item => item.id === saved.provider);
    const edited = isEdited(record);
    const inherited = !record.select.value;
    const saving = (routeSave && Object.hasOwn(routeSave, record.stage)) || credentialSave===credentialProvider(saved.provider);
    if (edited || record.savedTestRevision!==saved.testRevision) clearRouteTest(record);
    record.savedTestRevision=saved.testRevision;
    record.model.disabled = inherited;
    record.model.required = !inherited;
    record.model.placeholder = inherited ? saved.model : '填写模型 ID';
    record.effort.disabled = inherited || !effortSupported(record.select.value);
    record.test.disabled = !!record.testAttempt || edited || saving;
    record.test.title = edited ? '保存模型设置后再测试' : '使用示例请求测试当前模型';
    record.test.textContent = record.testAttempt ? '测试中' : '测试';
    record.row.classList.toggle('provider-edited', edited);
    record.current.textContent = edited
      ? '更改待保存'
      : (settings.modelRoutes[record.stage] ? '已指定' : '跟随默认') + ' · ' + configured.label + (configured.configured ? '' : ' · 待填密钥');
  }

  function populateRoutes(preserved) {
    for (const record of view.rows) {
      if (!preserved?.has(record.stage)) {
        const override = settings.modelRoutes[record.stage];
        for (const [field, value] of [[record.select, override?.provider], [record.model, override?.model], [record.effort, override?.reasoningEffort]]) {
          if (field.value !== (value || '')) field.value = value || '';
        }
      }
      updateRouteRow(record);
    }
    view.routeCount.textContent = Object.keys(settings.modelRoutes).length + ' 项已单独设置';
  }

  function makeRoutes() {
    const block = section('任务模型', '为每类任务指定模型。跟随默认时沿用运行设置，对话和自主规划默认使用 Harness。');
    block.intro.append(el('p', 'provider-note', '岗位先按城市、方向与经验规则筛选，再由模型分析和拟写招呼。'));
    block.intro.append(el('p', 'provider-note', '对话和自主规划使用 Harness 时可调用已授权的本机工具。对话选 API 时，可用已启用的网页工具读取本轮给出的公开链接。'));
    const routeCount = el('p', 'provider-route-count');
    block.intro.append(routeCount);
    const form = el('form', 'provider-sheet');
    const rows = settings.stages.map(stage => createRouteRow(stage, settings.providers));
    const captions = el('div', 'provider-route-captions');
    captions.setAttribute('aria-hidden', 'true');
    for (const label of ['任务','提供商','模型 ID','推理强度','连接']) captions.append(el('span','',label));
    const save = button('保存模型设置', 'submit');
    save.className = 'provider-primary';
    const result = el('p', 'provider-inline-feedback');
    result.setAttribute('role', 'status');
    const actions = el('div', 'provider-actions');
    actions.append(save, result);
    form.append(captions, ...rows.map(record => record.row), actions);
    form.onsubmit = async event => {
      event.preventDefault();
      if (routeSave) return;
      const changed = rows.filter(isEdited);
      if (!changed.length) {message(result, '模型设置没有修改');return;}
      const modelRoutes = Object.fromEntries(changed.map(record => [record.stage, routeValue(record)]));
      routeSave = modelRoutes;
      for (const record of changed) updateRouteRow(record);
      save.disabled = true;
      message(result, '正在保存…');
      let committed = false;
      try {
        await api('/api/config', {modelRoutes});
        committed = true;
        await loadSettings(modelRoutes);
        message(result, rows.some(isEdited) ? '本次提交已保存，之后的修改仍待保存' : '模型设置已保存');
      } catch (error) {
        message(result, committed ? '本次提交已保存，暂时无法重新读取模型设置。' : error.message, true);
      } finally {
        routeSave = undefined;
        for (const record of changed) updateRouteRow(record);
        save.disabled = false;
      }
    };
    block.outer.append(form);
    return {node:block.outer, rows, routeCount};
  }

  function updateCredentialStatus() {
    for (const provider of settings.providers) {
      const status = view.statuses.get(provider.id);
      if (!status) continue;
      status.textContent = provider.id === 'harness'
        ? [provider.available ? '已安装' : '待安装', provider.configured ? '已配置' : '待填密钥'].join(' · ')
        : provider.configured ? '已配置' : '待配置';
      status.classList.toggle('provider-ready', !!provider.configured && provider.available !== false);
    }
  }

  function makeCredentials() {
    const block = section('API 密钥', '每家提供商使用自己的密钥。Harness 与 DeepSeek API 共用 DeepSeek 密钥。');
    const list = el('dl', 'provider-credential-status');
    const statuses = new Map();
    for (const provider of settings.providers) {
      const status = el('dd');
      list.append(el('dt','',provider.label), status);
      statuses.set(provider.id, status);
    }
    block.intro.append(list);

    const form = el('form', 'provider-sheet provider-credential-form');
    const select = el('select');
    for (const provider of settings.providers.filter(item => item.id !== 'harness')) select.append(option(provider.id, provider.label));
    const address = Object.assign(el('input'), {
      type:'url', maxLength:512, autocomplete:'off', spellcheck:false, placeholder:'https://服务商域名/v1'
    });
    const addressField = labeled('兼容 API 基础地址', address);
    const secret = Object.assign(el('input'), {
      type:'password', required:true, minLength:12, maxLength:512, autocomplete:'new-password', spellcheck:false
    });
    const save = button('保存密钥', 'submit');
    const result = el('p', 'provider-inline-feedback');
    result.setAttribute('role', 'status');
    const actions = el('div', 'provider-actions');
    actions.append(save, result);
    form.append(labeled('提供商', select), addressField, labeled('API 密钥', secret), actions);
    let providerSelection = 0;
    function selectProvider() {
      providerSelection++;
      const custom = select.value === 'compatible';
      addressField.hidden = !custom;
      address.disabled = !custom;
      address.required = custom;
      if (custom) address.value = settings.compatibleBaseURL || '';
      secret.value = '';
      message(result, '');
    }
    select.addEventListener('change', selectProvider);
    selectProvider();
    form.onsubmit = async event => {
      event.preventDefault();
      if (save.disabled) return;
      const provider = select.value;
      const selection = providerSelection, keyInput = secret.value, addressInput = address.value;
      const sameSelection = () => providerSelection === selection;
      credentialSave=provider;
      for (const record of view.rows) {
        if (credentialProvider(settings.routes[record.stage].provider)===provider) clearRouteTest(record);
        updateRouteRow(record);
      }
      save.disabled = true;
      message(result, '正在保存…');
      try {
        await api('/api/provider-key', {provider,key:keyInput.trim(),...(provider === 'compatible' ? {baseURL:addressInput.trim()} : {})});
        if (sameSelection() && secret.value === keyInput) secret.value = '';
        await loadSettings();
        if (sameSelection()) {
          if (provider === 'compatible' && address.value === addressInput) address.value = settings.compatibleBaseURL;
          message(result, '密钥已保存');
        }
      } catch (error) {
        if (sameSelection()) message(result, error.message, true);
      } finally {
        credentialSave=undefined;
        for (const record of view.rows) updateRouteRow(record);
        save.disabled = false;
      }
    };
    block.outer.append(form);
    return {node:block.outer, statuses};
  }

  function render() {
    const routes = makeRoutes();
    const credentials = makeCredentials();
    root().replaceChildren(routes.node, credentials.node);
    view = {rows:routes.rows, routeCount:routes.routeCount, statuses:credentials.statuses};
    populateRoutes();
    updateCredentialStatus();
  }

  async function loadSettings(submitted) {
    const read = ++settingsReads;
    const next = await api('/api/providers');
    if (read < appliedSettingsRead) return;
    appliedSettingsRead = read;
    if (!view) {settings = next;render();return;}
    const preserved = new Set(view.rows.filter(record => {
      const {stage} = record;
      if (submitted && Object.hasOwn(submitted, stage)) return !sameRoute(routeValue(record), submitted[stage]);
      return (routeSave && Object.hasOwn(routeSave, stage)) || isEdited(record);
    }).map(record => record.stage));
    settings = next;
    populateRoutes(preserved);
    updateCredentialStatus();
  }

  async function refreshProviders() {
    const content = root();
    if (!content || pendingLoad) return pendingLoad;
    if (!view) content.replaceChildren(el('p', 'provider-note', '正在读取模型设置…'));
    pendingLoad = loadSettings().catch(error => {
      if (view) {
        notice(error.message, true);
        return;
      }
      const retry = button('重新读取');
      retry.onclick = refreshProviders;
      content.replaceChildren(el('p', 'provider-error', error.message), retry);
    }).finally(() => { pendingLoad = undefined; });
    return pendingLoad;
  }

  window.refreshProviders = refreshProviders;
  document.addEventListener('desktop-panel', event => {
    if (event.detail === 'providers' || event.detail?.name === 'providers') refreshProviders();
  });
  document.addEventListener('click', event => {
    if (event.target.closest('[data-panel="providers"],[data-goto="providers"]')) refreshProviders();
  });
})();
