/**
 * settingsPanel.ts —— 渲染层设置面板（可插拔资产导入/取景/行为触发/VTS/TTS 试听 + VTS 反向同步）
 *
 * 从 renderer.ts 拆出的独立全局脚本（无 import/export，由 index.html 在 renderer.js 之前加载）。
 * 拆分原因：renderer.ts 曾达 6,125 行，资产面板/语音输入/思考浮窗是三块边界清晰的声明区，
 * 单独成文件便于定位与 review；它们与 renderer.ts 共享同一个全局作用域（函数声明在脚本加载时
 * 即已可用），所以调用方代码不需要任何改动。
 *
 * 注意：本文件顶层只有声明，没有可执行语句——顺序上只要求先于 renderer.js 加载（见 index.html）。
 */

/* ================================================================
   可插拔资产（Live2D 模型 / 插件）：文件夹式导入 + 逐项校验报告
   - 加入方式统一为「打开文件夹 / 选一个文件夹」，不再手填路径；
   - 每个资产都显示状态徽标与具体问题（缺文件 / 版本不支持 / 语法错误…）；
   - 模型走 /user-models/ 挂载点，插件用清单里的 entry，两者都不会进打包产物。
   ================================================================ */

function assetIssueLevel(issues: string[]): 'ok' | 'warn' | 'bad' {
  if (issues.some((t) => !t.startsWith('提示：'))) return 'bad';
  return issues.length ? 'warn' : 'ok';
}

/** 当前设置页选中的模型（没有就退回已加载的模型名） */
function settingsTargetModel(): string {
  const select = elementById<HTMLSelectElement>('setting-model');
  const value = select?.value?.trim();
  return value || activeModelName || '';
}

/**
 * 刷新「当前模型预设」这一行：有没有预设、里面有什么、文件在哪、哪儿写坏了。
 * 预设读的是 userData/live2d-presets/<模型>.json（用户级）优先，其次模型目录里的 pet-model.json。
 */
async function refreshPresetInfo(bridge: RendererBridge): Promise<void> {
  const info = elementById<HTMLElement>('asset-preset-info');
  const hint = elementById<HTMLElement>('asset-preset-hint');
  const editBtn = elementById<HTMLButtonElement>('asset-preset-edit');
  if (!info) return;
  const setHint = (text: string, bad = false): void => {
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = !text;
    hint.classList.toggle('is-bad', bad);
  };
  /** 没有预设时"不表达"：只留一个按钮，不占地方也不反复提示（用户要求） */
  const quiet = (buttonLabel: string, buttonTitle: string): void => {
    info.hidden = true;
    info.textContent = '';
    if (editBtn) {
      editBtn.textContent = buttonLabel;
      editBtn.title = buttonTitle;
    }
  };
  const show = (): void => {
    info.hidden = false;
    if (editBtn) {
      editBtn.textContent = '📝 打开预设…';
      editBtn.title = '打开 / 编辑这个模型的 pet-model.json';
    }
  };
  const name = settingsTargetModel();
  if (!name) {
    quiet('📝 预设…', '先在上面选一个模型');
    setHint('');
    return;
  }
  if (typeof bridge.assetPreset !== 'function') {
    quiet('📝 预设…', '当前版本不支持模型预设');
    setHint('');
    return;
  }
  try {
    const res = await bridge.assetPreset('get', name);
    if (!res || !res.ok) {
      info.hidden = false;
      info.textContent = `预设：读取失败（${res?.error ?? '未知原因'}）`;
      info.classList.add('is-bad');
      setHint('');
      return;
    }
    const hasIssues = Boolean(res.issues?.length);
    info.classList.toggle('is-bad', hasIssues);
    if (!res.exists) {
      quiet('📝 写预设…', `给「${name}」写一份 pet-model.json：取景 / 情绪→表情 / 参数映射（存在 %APPDATA%，不进包）`);
      setHint('');
      return;
    }
    const parts: string[] = [];
    if (res.preset?.framing) parts.push(res.preset.framing === 'half' ? '半身' : '全身');
    const emo = res.preset?.emotionMap ? Object.keys(res.preset.emotionMap).length : 0;
    const par = res.preset?.parameterMap ? Object.keys(res.preset.parameterMap).length : 0;
    if (emo) parts.push(`表情 ${emo}`);
    if (par) parts.push(`参数 ${par}`);
    const where = res.fromUserData ? '用户预设' : '模型目录';
    show();
    info.textContent = `预设「${name}」：${parts.length ? parts.join(' · ') : '空'}（${where}）`;
    info.title = res.path ?? '';
    const exprText = res.expressions?.length ? `可用表情 ${res.expressions.length} 个：${res.expressions.slice(0, 6).join('、')}${res.expressions.length > 6 ? '…' : ''}` : '该模型没有表情（emotionMap 写了也不会生效）';
    setHint(`${exprText}${hasIssues ? `；⚠ ${res.issues!.join('；')}` : ''}`, hasIssues);
  } catch (err) {
    info.hidden = false;
    info.textContent = `预设：读取异常（${(err as Error).message ?? String(err)}）`;
    info.classList.add('is-bad');
    setHint('');
  }
}

/** 生成/打开当前模型的预设模板（存在就直接打开，不覆盖用户已写的内容） */
async function openModelPreset(bridge: RendererBridge, modelName?: string): Promise<void> {
  const name = (modelName ?? settingsTargetModel()).trim();
  if (!name) {
    setSettingsStatus('先选一个模型', true);
    return;
  }
  if (typeof bridge.assetPreset !== 'function') {
    setSettingsStatus('当前版本不支持模型预设', true);
    return;
  }
  const res = await bridge.assetPreset('open', name);
  if (!res || !res.ok) {
    setSettingsStatus(`预设打不开：${res?.error ?? '未知原因'}`, true);
    return;
  }
  setSettingsStatus(
    `${res.created ? '已生成预设模板并打开' : '已打开已有预设'}：${res.path ?? ''}（改完切一次模型或重启即生效）`
  );
  await refreshPresetInfo(bridge);
}

function renderAssetRow(
  host: HTMLElement,
  name: string,
  issues: string[],
  badges: string[],
  actions: Array<{ label: string; title: string; onClick: () => void }>
): void {
  const level = assetIssueLevel(issues);
  const row = document.createElement('div');
  row.className = `asset-item${level === 'bad' ? ' is-bad' : ''}`;
  const nameEl = document.createElement('span');
  nameEl.className = 'asset-name';
  nameEl.textContent = name;
  nameEl.title = name;
  row.appendChild(nameEl);
  for (const text of badges) {
    const b = document.createElement('span');
    b.className = `asset-badge is-${level}`;
    b.textContent = text;
    row.appendChild(b);
  }
  for (const act of actions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = act.label;
    btn.title = act.title;
    btn.addEventListener('click', act.onClick);
    row.appendChild(btn);
  }
  host.appendChild(row);
  if (issues.length) {
    const box = document.createElement('div');
    box.className = 'asset-issues';
    box.textContent = issues.map((t) => `· ${t}`).join('\n');
    host.appendChild(box);
  }
}

/** 重新填充设置页的"模型"下拉框（加入/移除模型后调用，保留当前选择） */
async function refreshModelOptions(bridge: RendererBridge): Promise<void> {
  try {
    const models = await bridge.modelList();
    const select = elementById<HTMLSelectElement>('setting-model');
    if (!select) return;
    const current = select.value;
    select.replaceChildren();
    for (const name of models) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    if (models.includes(current)) select.value = current;
  } catch (err) {
    console.warn('[renderer] 刷新模型列表失败', err);
  }
}

/** 扫描并渲染"模型 / 插件"两块资产面板 */
async function refreshAssetPanel(bridge: RendererBridge): Promise<void> {
  const modelHost = elementById<HTMLElement>('asset-model-list');
  const pluginHost = elementById<HTMLElement>('asset-plugin-list');
  if (!modelHost || !pluginHost) return;
  if (typeof bridge.assetScan !== 'function') {
    modelHost.textContent = '（当前版本不支持资产面板）';
    return;
  }
  void refreshPresetInfo(bridge); // 当前模型的预设摘要（含"内置模型也能写预设"这条路）
  modelHost.replaceChildren();
  pluginHost.replaceChildren();
  let res: import('../shared/contracts').AssetScanResult | null = null;
  try {
    res = await bridge.assetScan();
  } catch (err) {
    modelHost.textContent = `扫描失败：${(err as Error).message ?? String(err)}`;
    return;
  }
  if (!res) return;
  const setPath = (id: string, text: string): void => {
    const el = elementById<HTMLElement>(id);
    if (el) el.textContent = `目录：${text}`;
  };
  setPath('asset-model-dir', res.dirs.model);
  setPath('asset-plugin-dir', res.dirs.plugin);

  for (const name of res.builtinModels) {
    // 内置模型也能有预设：预设文件写在 userData（不进包），所以只读的随包目录也能被适配
    renderAssetRow(modelHost, name, [], ['内置'], [
      {
        label: '预设',
        title: '为内置模型生成/打开 pet-model.json（写在 %APPDATA%，不改动随包文件）',
        onClick: () => {
          void openModelPreset(bridge, name);
        },
      },
    ]);
  }
  for (const m of res.models) {
    const badges = [
      m.kind === 'moc3' ? `Live2D${m.mocVersion ? ` v${m.mocVersion}` : ''}` : m.kind === 'portrait' ? '立绘' : '未知',
    ];
    if (m.sizeMb) badges.push(`${m.sizeMb}MB`);
    if (m.preset) {
      const bits: string[] = [];
      if (m.preset.framing) bits.push(m.preset.framing === 'half' ? '半身' : '全身');
      if (m.preset.parameterCount) bits.push(`参数 ${m.preset.parameterCount}`);
      const cap = m.preset.capabilities;
      if (cap) {
        // 能力归类（导入时自动识别）：让人一眼看到"这个模型能被怎么用"
        if (cap.click) bits.push(`点击 ${cap.click}`);
        if (cap.costume) bits.push(`服饰 ${cap.costume}`);
        if (cap.emotion) bits.push(`情绪 ${cap.emotion}`);
        if (cap.motions) bits.push(`动作 ${cap.motions}`);
        if (!cap.click && !cap.costume && !cap.emotion && !cap.motions) bits.push('无特殊能力');
      }
      badges.push(`预设${m.preset.fromUserData ? '(用户)' : ''}: ${bits.join('/') || '空'}`);
    }
    const rowIssues = m.presetIssues && m.presetIssues.length
      ? [...m.issues, ...m.presetIssues.map((t) => `预设问题：${t}`)]
      : m.issues;
    renderAssetRow(modelHost, m.name, rowIssues, badges, [
      {
        label: '预设',
        title: '生成/打开这个模型的 pet-model.json（取景 / 情绪→表情 / 参数映射）',
        onClick: () => {
          void openModelPreset(bridge, m.name);
        },
      },
      {
        label: '用这个',
        title: '立刻切换到这个模型',
        onClick: () => {
          const select = elementById<HTMLSelectElement>('setting-model');
          if (select) select.value = m.name;
          void switchModel(bridge, m.name);
        },
      },
      {
        label: '移除',
        title: m.external ? '只从列表移除（外部目录的文件不动）' : '从用户模型目录删除',
        onClick: () => {
          void (async () => {
            const ok = window.confirm(
              m.external ? `从列表移除「${m.name}」？（外部目录里的文件不会删）` : `删除用户模型「${m.name}」？`
            );
            if (!ok) return;
            const r = await bridge.assetRemove?.('model', m.name);
            if (r && !r.ok) setSettingsStatus(`移除失败：${r.error ?? '未知原因'}`, true);
            else {
              setSettingsStatus('已移除，列表已刷新');
              await refreshAssetPanel(bridge);
            }
          })();
        },
      },
    ]);
  }
  if (!res.models.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-issues';
    empty.style.color = 'rgba(255,255,255,.55)';
    empty.textContent = '还没有用户模型。点「📂 打开模型文件夹」把模型文件夹放进去，或点「＋ 添加模型…」选一个现成目录。';
    modelHost.appendChild(empty);
  }

  for (const p of res.plugins) {
    const badges = [p.version ? `v${p.version}` : '无版本'];
    renderAssetRow(pluginHost, p.name, p.issues, badges, [
      {
        label: '启用',
        title: '加载并运行这个插件',
        onClick: () => {
          void (async () => {
            const entry = p.entry ? `${p.dir}\\${p.entry.replace(/\//g, '\\')}` : '';
            const r = await bridge.pluginRegister({ name: p.name, version: p.version || '1.0.0', entry });
            setSettingsStatus(r.ok ? `插件「${p.name}」已加载并运行` : `加载失败：${r.error ?? '未知原因'}`, !r.ok);
          })();
        },
      },
      {
        label: '移除',
        title: p.external ? '只从列表移除（外部目录的文件不动）' : '删除用户插件目录里的这个插件',
        onClick: () => {
          void (async () => {
            const ok = window.confirm(
              p.external ? `从列表移除插件「${p.name}」？（外部目录里的文件不会删）` : `删除插件「${p.name}」？`
            );
            if (!ok) return;
            const r = await bridge.assetRemove?.('plugin', p.name);
            if (r && !r.ok) setSettingsStatus(`移除失败：${r.error ?? '未知原因'}`, true);
            else {
              setSettingsStatus('已移除，列表已刷新');
              await refreshAssetPanel(bridge);
            }
          })();
        },
      },
    ]);
  }
  if (!res.plugins.length) {
    const empty = document.createElement('div');
    empty.className = 'asset-issues';
    empty.style.color = 'rgba(255,255,255,.55)';
    empty.textContent = '还没有插件。点「📂 打开插件文件夹」把插件文件夹（需带 pet-plugin.json）放进去。';
    pluginHost.appendChild(empty);
  }
}

/** 当前取景（全身 / 半身） */
let currentFraming: 'full' | 'half' = 'full';

/** 应用取景到当前渲染句柄（活体切换，不用重载模型） */
function applyFraming(mode: 'full' | 'half'): void {
  currentFraming = mode === 'half' ? 'half' : 'full';
  // 半身时模型被放大到窗口之外（左右与底部是硬裁切线）→ 给 body 打标记，
  // 由 CSS 用两层 mask 让窗口边缘逐渐透明，角色像是"溶"进桌面（全身时不动）。
  try {
    document.body.classList.toggle('framing-half', currentFraming === 'half');
  } catch {
    /* ignore */
  }
  try {
    currentHandle?.setFraming?.(currentFraming);
  } catch (err) {
    console.warn('[renderer] 应用取景失败', err);
  }
  reportPetBoundsSoon(chatBridge); // 取景变了，角色可见范围也变了 → 气泡重新贴位
}

/** 右键菜单：一键切换全身 / 半身，并写回设置（下次启动保持） */
async function toggleFraming(bridge: RendererBridge): Promise<void> {
  hideContextMenu();
  const next: 'full' | 'half' = currentFraming === 'half' ? 'full' : 'half';
  applyFraming(next);
  flashStatus(next === 'half' ? '已切到半身取景' : '已切到全身取景', 1600);
  try {
    const settings = await bridge.getSettings();
    await bridge.setSettings({ ...settings, displayMode: next });
    const select = elementById<HTMLSelectElement>('setting-display-mode');
    if (select) select.value = next;
  } catch (err) {
    console.warn('[renderer] 保存取景设置失败', err);
  }
}

async function populateSettings(bridge: RendererBridge): Promise<void> {
  const [settings, models] = await Promise.all([bridge.getSettings(), bridge.modelList()]);
  applyBehaviorTriggersFromSettings(settings); // 取"当前模型"那一份绑定并刷新下拉
  renderMotionTriggerRows();
  refreshMotionTriggerOptions();
  populateMotionTriggerSelects();
  const textureSelect = elementById<HTMLSelectElement>('setting-texture-max');
  if (textureSelect) {
    const v = typeof settings.textureMaxSize === 'number' ? settings.textureMaxSize : 4096;
    textureSelect.value = String(v);
  }
  const modelSelect = elementById<HTMLSelectElement>('setting-model');
  if (modelSelect) {
    modelSelect.replaceChildren();
    for (const name of models) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      modelSelect.appendChild(option);
    }
    // ★ 必须把下拉选中值设成"当前真正在用的模型"：
    //   不设的话它停在列表第一个（例如「模型 A」），而实际可能在用模型 B ——
    //   用户打开设置就会以为"模型选择没被保存"，这是最容易被当成"设置不持久"的地方。
    const currentModel = settings.modelName || activeModelName || '';
    if (currentModel) {
      if (!Array.from(modelSelect.options).some((o) => o.value === currentModel)) {
        const option = document.createElement('option');
        option.value = currentModel;
        option.textContent = `${currentModel}（当前，不在列表里）`;
        modelSelect.appendChild(option);
      }
      modelSelect.value = currentModel;
    }
  }
  applyPetName(settings.petName);
  const petNameInput = elementById<HTMLInputElement>('setting-pet-name');
  if (petNameInput) petNameInput.value = settings.petName ?? '';
  // MCP / 自主任务
  const setChecked = (id: string, checked: boolean): void => {
    const el = elementById<HTMLInputElement>(id);
    if (el) el.checked = checked;
  };
  const setInputValue = (id: string, value: string): void => {
    const el = elementById<HTMLInputElement>(id);
    if (el) el.value = value;
  };
  ttsEnabled = settings.ttsEnabled === true;
  ttsVoice = settings.ttsVoice || TTS_DEFAULT_VOICE;
  setChecked('setting-tts-enabled', ttsEnabled);
  const ttsVoiceSelect = elementById<HTMLSelectElement>('setting-tts-voice');
  // 音色可能是联网拉取后选的（不在内置候选里）：补一个选项并选中，避免"重开设置显示空白、一保存就丢"
  if (ttsVoiceSelect) ensureSelectValue(ttsVoiceSelect, ttsVoice, `${ttsVoice}（当前音色）`);
  setChecked('setting-mcp-server-enabled', settings.mcpServerEnabled === true);
  setChecked('setting-mcp-server-lan', settings.mcpServerLanEnabled === true);
  setInputValue('setting-mcp-server-port', String(settings.mcpServerPort ?? 37653));
  setInputValue('setting-mcp-server-token', settings.mcpServerToken ?? '');
  setChecked('setting-autotask-enabled', settings.autoTaskEnabled === true);
  const autoTaskModeSelect = elementById<HTMLSelectElement>('setting-autotask-mode');
  if (autoTaskModeSelect) autoTaskModeSelect.value = settings.autoTaskMode ?? 'mcp_check';
  setInputValue('setting-autotask-prompt', settings.autoTaskPrompt ?? '');
  setInputValue('setting-autotask-interval', String(settings.autoTaskIntervalMin ?? 30));
  setInputValue('setting-autotask-limit', String(settings.autoTaskDailyLimit ?? 20));
  setChecked('setting-autotask-event-enabled', settings.autoTaskEventEnabled === true);
  setInputValue('setting-autotask-event-match', settings.autoTaskEventMatch ?? '');
  setInputValue('setting-autotask-event-cooldown', String(settings.autoTaskEventCooldownMin ?? 15));
  setChecked('setting-autotask-allow-mcp', settings.autoTaskAllowMcp === true);
  // VTube Studio（可选后端）：开关 + 端口；状态行单独异步刷
  setChecked('setting-vts-enabled', settings.vtsEnabled === true);
  setInputValue('setting-vts-port', String(settings.vtsPort ?? 8001));
  setVtsTrackingEnabled(settings.vtsEnabled === true);
  void refreshVtsStatus(bridge);
  void refreshMcpPanel(bridge);
  const values: Array<[string, string | number | undefined]> = [
    ['setting-provider', settings.provider],
    ['setting-base-url', settings.aiBaseUrl],
    ['setting-api-key', settings.aiApiKey],
    ['setting-ai-model', settings.aiModel],
    ['setting-azure-version', settings.azureApiVersion],
    ['setting-temperature', settings.temperature ?? 0.7],
    ['setting-rounds', settings.contextRounds ?? 10],
    ['setting-tokens', settings.maxContextTokens ?? 16000],
    // 语音识别（留空=复用上面的 AI 地址/密钥）
    ['setting-voice-model', settings.voiceModel],
    ['setting-voice-base-url', settings.voiceBaseUrl],
    ['setting-voice-api-key', settings.voiceApiKey],
  ];
  for (const [id, value] of values) {
    const input = elementById<HTMLInputElement>(id);
    if (input && value !== undefined) input.value = String(value);
  }
  const voiceRoute = elementById<HTMLSelectElement>('setting-voice-route');
  if (voiceRoute) voiceRoute.value = settings.voiceRoute ?? 'auto';
  const confirmBox = elementById<HTMLInputElement>('setting-confirm-tools');
  if (confirmBox) confirmBox.checked = settings.confirmTools === true;
  const thinkBox = elementById<HTMLInputElement>('setting-show-thinking');
  if (thinkBox) thinkBox.checked = settings.showThinking !== false; // 默认开启
  const devRootInput = elementById<HTMLInputElement>('setting-dev-root');
  if (devRootInput) devRootInput.value = settings.devWorkspaceRoot ?? '';
  const allowShellBox = elementById<HTMLInputElement>('setting-allow-shell');
  if (allowShellBox) allowShellBox.checked = settings.allowShell !== false; // 默认允许
  const permSelect = elementById<HTMLSelectElement>('setting-permission-mode');
  if (permSelect) permSelect.value = settings.permissionMode ?? 'ask'; // 默认每次询问
  // 取景：下拉框回填 + 立刻应用到当前角色
  const framingSelect = elementById<HTMLSelectElement>('setting-display-mode');
  const framing = settings.displayMode === 'half' ? 'half' : 'full';
  if (framingSelect) framingSelect.value = framing;
  applyFraming(framing);
  const hideFsBox = elementById<HTMLInputElement>('setting-hide-fullscreen');
  if (hideFsBox) hideFsBox.checked = settings.fullscreenAutoHide === true; // 默认关闭 = 全屏置顶显示
  const clickThroughBox = elementById<HTMLInputElement>('setting-click-through');
  if (clickThroughBox) clickThroughBox.checked = settings.clickThrough === true; // 默认关闭
  // 更新检测：开关默认开启；状态/当前版本由 renderer 的 renderUpdateStatus 刷新
  const updateCheckBox = elementById<HTMLInputElement>('setting-check-for-updates');
  if (updateCheckBox) updateCheckBox.checked = settings.checkForUpdates !== false;
  {
    const maybe = bridge as typeof bridge & { getUpdateStatus?: () => Promise<import('../shared/contracts').UpdateSnapshot> };
    if (typeof maybe.getUpdateStatus === 'function') {
      void maybe.getUpdateStatus().then(renderUpdateStatus).catch(() => undefined);
    }
  }
  const visionModelInput = elementById<HTMLInputElement>('setting-vision-model');
  if (visionModelInput) visionModelInput.value = settings.visionModel ?? '';
  const visionRouteSelect = elementById<HTMLSelectElement>('setting-vision-route');
  if (visionRouteSelect) visionRouteSelect.value = settings.visionRoute === 'chat' || settings.visionRoute === 'custom' ? settings.visionRoute : 'auto';
  const visionBaseInput = elementById<HTMLInputElement>('setting-vision-base-url');
  if (visionBaseInput) visionBaseInput.value = settings.visionBaseUrl ?? '';
  const visionKeyInput = elementById<HTMLInputElement>('setting-vision-api-key');
  if (visionKeyInput) visionKeyInput.value = settings.visionApiKey ?? '';
  // AI 接入方式二选一：单选回填 + 对应配置区展开/收起 + DSH 状态刷新
  const apiModeRadio = elementById<HTMLInputElement>('setting-ai-mode-api');
  const dshModeRadio = elementById<HTMLInputElement>('setting-ai-mode-dsh');
  const aiMode = settings.aiMode === 'dsh' ? 'dsh' : 'api';
  if (apiModeRadio) apiModeRadio.checked = aiMode === 'api';
  if (dshModeRadio) dshModeRadio.checked = aiMode === 'dsh';
  syncAiModeDetails();
  if (aiMode === 'dsh') void refreshDshStatus(bridge);
  applySfxSettings(settings); // 音效开关/音量 + 滑杆显示  // 打开设置就顺手拉一次可用模型列表（失败也不影响其它设置项）+ 扫描可插拔资产
  void refreshAiModelOptions(bridge);
  void refreshAssetPanel(bridge);
  void refreshVoiceStatus(bridge); // 语音识别这行的状态（是否配好、走哪条路由、发往哪个主机）
  void refreshVoiceModelIndex(bridge); // 转写模型：按地址索引候选 + 体检提示（模型留空时自动填一个）
}

/* ---------- 设置页：行为触发（行为 → 动作组 / 表情）---------- */
/** 建出每个行为一行（只建一次）：触发目标（动作组/表情）+ 可选的"同时表情" */
/** 附加目标的播放方式按钮：同时 / 衔接，点一下切换 */
function setPairModeButton(btn: HTMLButtonElement, mode: string): void {
  const chain = mode === 'chain';
  btn.dataset.mode = chain ? 'chain' : 'simultaneous';
  btn.textContent = chain ? '衔接表情' : '同时表情';
  btn.title = chain
    ? '衔接：主目标播完后再播放附加目标（点击切换为"同时"）'
    : '同时：与主目标一起播放（点击切换为"衔接"）';
}

function renderMotionTriggerRows(): void {
  const body = elementById<HTMLElement>('motion-trigger-body');
  if (!body || body.childElementCount > 0) return;
  for (const key of BEHAVIOR_KEYS) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const title = document.createElement('span');
    title.textContent = BEHAVIOR_LABELS[key];
    const select = document.createElement('select');
    select.id = `setting-motion-${key}`;
    select.title = '触发时播放的动作组或表情';
    const modeBtn = document.createElement('button');
    modeBtn.type = 'button';
    modeBtn.id = `setting-motion-mode-${key}`;
    modeBtn.className = 'trigger-pair-mode';
    setPairModeButton(modeBtn, 'simultaneous');
    modeBtn.addEventListener('click', () => {
      setPairModeButton(modeBtn, modeBtn.dataset.mode === 'chain' ? 'simultaneous' : 'chain');
    });
    const exprSelect = document.createElement('select');
    exprSelect.id = `setting-motion-expr-${key}`;
    exprSelect.title = '附加目标（可选）：动作组或表情；配合左侧按钮决定"同时"还是"衔接"播放';
    row.append(title, select, modeBtn, exprSelect);
    body.appendChild(row);
  }
}

/** 旧配置里的附加目标可能只存了表情名（无前缀）：补齐为 expr:/motion: 编码，避免被判成"当前模型没有" */
function normalizePairTarget(value: string, motions: string[], expressions: string[]): string {
  if (!value) return '';
  if (value.startsWith('motion:') || value.startsWith('expr:')) return value;
  if (expressions.includes(value)) return `expr:${value}`;
  if (motions.includes(value)) return `motion:${value}`;
  return value;
}

/** 保证下拉里有这个取值；当前模型没有它时也补一个选项留住（换模型不该悄悄丢掉绑定） */
function ensureTriggerOption(select: HTMLSelectElement, value: string): void {
  if (Array.from(select.options).some((o) => o.value === value)) return;
  const option = document.createElement('option');
  option.value = value;
  option.textContent = value ? `${value}（当前模型没有）` : '不触发';
  select.appendChild(option);
}

/** 用当前模型的动作组/表情刷新每个下拉的选项 */
function refreshMotionTriggerOptions(): void {
  const motions = listCurrentMotions();
  const expressions = listCurrentExpressions();
  for (const key of BEHAVIOR_KEYS) {
    const select = elementById<HTMLSelectElement>(`setting-motion-${key}`);
    if (!select) continue;
    const previous = select.options.length ? select.value : 'auto';
    select.replaceChildren();
    const add = (value: string, label: string): void => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    };
    add('auto', '自动（按行为猜一个）');
    add('', '不触发');
    if (motions.length) {
      const group = document.createElement('optgroup');
      group.label = '动作组';
      for (const name of motions) {
        const option = document.createElement('option');
        option.value = `motion:${name}`;
        option.textContent = name;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    if (expressions.length) {
      const group = document.createElement('optgroup');
      group.label = '表情';
      for (const name of expressions) {
        const option = document.createElement('option');
        option.value = `expr:${name}`;
        option.textContent = name;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    // 旧值在当前模型上不存在时也补一个选项留住（换模型不该悄悄丢掉绑定）
    ensureTriggerOption(select, previous);
    select.value = previous;

    // 附加目标（可选）：动作组和表情都能选（不限制种类）
    const exprSelect = elementById<HTMLSelectElement>(`setting-motion-expr-${key}`);
    if (!exprSelect) continue;
    const exprPrevious = normalizePairTarget(
      exprSelect.options.length ? exprSelect.value : '',
      motions,
      expressions,
    );
    exprSelect.replaceChildren();
    const addPair = (value: string, label: string): void => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      exprSelect.appendChild(option);
    };
    addPair('', '不附加');
    if (motions.length) {
      const group = document.createElement('optgroup');
      group.label = '动作组';
      for (const name of motions) {
        const option = document.createElement('option');
        option.value = `motion:${name}`;
        option.textContent = name;
        group.appendChild(option);
      }
      exprSelect.appendChild(group);
    }
    if (expressions.length) {
      const group = document.createElement('optgroup');
      group.label = '表情';
      for (const name of expressions) {
        const option = document.createElement('option');
        option.value = `expr:${name}`;
        option.textContent = name;
        group.appendChild(option);
      }
      exprSelect.appendChild(group);
    }
    ensureTriggerOption(exprSelect, exprPrevious);
    exprSelect.value = exprPrevious;
  }
}

/** 回填已保存的行为触发映射（含附加目标与播放方式） */
function populateMotionTriggerSelects(): void {
  const motions = listCurrentMotions();
  const expressions = listCurrentExpressions();
  for (const key of BEHAVIOR_KEYS) {
    const select = elementById<HTMLSelectElement>(`setting-motion-${key}`);
    if (!select) continue;
    const saved = typeof motionTriggers[key] === 'string' ? motionTriggers[key] : 'auto';
    ensureTriggerOption(select, saved);
    select.value = saved;
    const exprSelect = elementById<HTMLSelectElement>(`setting-motion-expr-${key}`);
    if (exprSelect) {
      const savedExpr = normalizePairTarget(
        typeof motionTriggerExpressions[key] === 'string' ? motionTriggerExpressions[key] : '',
        motions,
        expressions,
      );
      ensureTriggerOption(exprSelect, savedExpr);
      exprSelect.value = savedExpr;
    }
    const modeBtn = elementById<HTMLButtonElement>(`setting-motion-mode-${key}`);
    if (modeBtn) setPairModeButton(modeBtn, typeof motionTriggerPairModes[key] === 'string' ? motionTriggerPairModes[key] : 'simultaneous');
  }
}

/** 收集行为触发映射（'auto' 不落盘，缺省即 auto） */
function collectMotionTriggers(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of BEHAVIOR_KEYS) {
    const value = elementById<HTMLSelectElement>(`setting-motion-${key}`)?.value ?? 'auto';
    if (value && value !== 'auto') map[key] = value;
  }
  return map;
}

/** 收集附加目标（空 = 不附加） */
function collectMotionTriggerExpressions(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of BEHAVIOR_KEYS) {
    const value = elementById<HTMLSelectElement>(`setting-motion-expr-${key}`)?.value ?? '';
    if (value) map[key] = value;
  }
  return map;
}

/** 收集附加目标的播放方式（缺省 simultaneous，不落盘） */
function collectMotionTriggerPairModes(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of BEHAVIOR_KEYS) {
    const mode = elementById<HTMLButtonElement>(`setting-motion-mode-${key}`)?.dataset.mode;
    if (mode === 'chain') map[key] = 'chain';
  }
  return map;
}

/** 语音识别状态行：是否可用 + 实际路由 + 目标主机（不显示密钥） */
async function refreshVoiceStatus(bridge: RendererBridge): Promise<void> {
  const el = elementById<HTMLElement>('setting-voice-status');
  if (!el) return;
  if (typeof bridge.voiceStatus !== 'function') {
    el.textContent = '当前版本不支持语音识别状态查询';
    return;
  }
  try {
    const st = await bridge.voiceStatus();
    if (!st) {
      el.textContent = '';
      return;
    }
    if (!st.configured) {
      el.textContent = st.hint ?? '未配置（需要地址 + 密钥）';
      return;
    }
    const routeText = st.route === 'chat-audio' ? 'chat+音频' : st.route === 'transcriptions' ? 'audio/transcriptions' : '自动';
    el.textContent = `${st.model || 'qwen3-asr-flash'} · ${routeText} · ${st.reuseAiConfig === false ? '单独配置' : '复用 AI 配置'} · ${st.endpoint}`;
  } catch (err) {
    el.textContent = `查询失败：${(err as Error).message ?? String(err)}`;
  }
}

/** 语音自检：用内置合成音频打两条路由，把逐条结果摊开给用户看 */
async function runVoiceCheck(bridge: RendererBridge): Promise<void> {
  const el = elementById<HTMLElement>('setting-voice-status');
  const btn = elementById<HTMLButtonElement>('setting-voice-check');
  if (btn) btn.disabled = true;
  if (el) el.textContent = '自检中…（各打一次，最多 40 秒）';
  try {
    const res = await bridge.voiceCheck?.();
    if (!res) {
      if (el) el.textContent = '当前版本不支持语音自检';
      return;
    }
    if (!res.reports.length) {
      if (el) el.textContent = res.hint ?? '自检没有结果';
      return;
    }
    const parts = res.reports.map((r) => `${r.route === 'chat-audio' ? 'chat+音频' : 'audio/transcriptions'}：${r.ok ? '可用' : r.status}（${r.ms}ms）`);
    if (el) {
      el.textContent = res.ok
        ? `✅ 可用：${res.route === 'chat-audio' ? 'chat+音频' : 'audio/transcriptions'}｜${parts.join('；')}`
        : `❌ 都不通｜${parts.join('；')}${res.hint ? `｜${res.hint}` : ''}`;
    }
    console.log('[renderer] 语音自检结果：', JSON.stringify(res));
    // 注意：自检报告要留在状态行里给用户看，所以这里**不**再调用 refreshVoiceStatus 覆盖它
    // （状态行会在打开设置/保存设置时刷新）。
  } catch (err) {
    if (el) el.textContent = `自检失败：${(err as Error).message ?? String(err)}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 设置页 MCP / 自主任务状态：主进程组装文本，这里只展示 */
async function refreshMcpPanel(bridge: RendererBridge): Promise<void> {
  const statusEl = elementById<HTMLElement>('setting-mcp-status');
  const hintEl = elementById<HTMLElement>('setting-mcp-server-hint');
  const autoEl = elementById<HTMLElement>('setting-autotask-status');
  try {
    const st = await bridge.getMcpStatus?.();
    if (!st) {
      if (statusEl) statusEl.textContent = '当前版本不支持 MCP 状态查询';
      return;
    }
    if (statusEl) statusEl.textContent = [st.clientText, st.serverText].filter(Boolean).join('\n');
    if (hintEl) {
      if (!st.serverEnabled) hintEl.textContent = '未开启反向接入。';
      else if (st.serverUrl) hintEl.textContent = `服务端地址：${st.serverUrl}（请求头 Authorization: Bearer <上面的 token>）`;
      else hintEl.textContent = '已开启，保存设置后启动。';
    }
    if (autoEl) {
      const a = st.autoTask;
      const last = a.lastRunAt ? new Date(a.lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '从未';
      const state = a.running ? '运行中…' : a.enabled ? '已开启' : '未开启';
      const lastResult = a.lastResult ? `｜${a.lastResult.slice(0, 60)}` : '';
      autoEl.textContent = `${state}｜今日 ${a.countToday}/${a.dailyLimit} 次｜上次：${last}${lastResult}`;
    }
  } catch (err) {
    if (statusEl) statusEl.textContent = `读取失败：${(err as Error).message ?? String(err)}`;
  }
}

async function reloadMcpFromUi(bridge: RendererBridge): Promise<void> {
  const btn = elementById<HTMLButtonElement>('setting-mcp-reload');
  if (btn) btn.disabled = true;
  try {
    await bridge.mcpAction?.('reload');
    await refreshMcpPanel(bridge);
    setSettingsStatus('MCP 已重载。');
  } catch (err) {
    setSettingsStatus(`MCP 重载失败：${(err as Error).message ?? String(err)}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runAutoTaskNowFromUi(bridge: RendererBridge): Promise<void> {
  const btn = elementById<HTMLButtonElement>('setting-autotask-run');
  if (btn) btn.disabled = true;
  try {
    const result = await bridge.runAutoTaskNow?.();
    await refreshMcpPanel(bridge);
    setSettingsStatus(`自主任务：${(result ?? '').slice(0, 120)}`);
  } catch (err) {
    setSettingsStatus(`自主任务失败：${(err as Error).message ?? String(err)}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- 设置页：VTube Studio（可选后端）+ Edge TTS 试听 ---------- */

/**
 * VTS 状态行文本：连接/授权/模型/注入统计/错误。
 *
 * 注入统计是排障关键：`injectedCount` 一直不涨 = 渲染层根本没在发（或主进程全丢了）；
 * 涨了但 VTS 里模型不动 = 主进程→VTS 这一段的问题（用「测试注入」再区分一次）。
 * droppedCount 是"主进程收到但没连上/没授权，被丢弃"的帧数。
 */
function describeVtsStatus(st: VtsStatusDto | null): string {
  if (!st) return '当前版本不支持 VTS（主进程未接 VTS 服务）';
  const link = st.connected ? (st.authenticated ? '已连接 · 已授权' : '已连接 · 未授权') : st.enabled ? '未连接' : '未启用';
  const model = st.modelName ? ` · 模型：${st.modelName}` : st.modelLoaded ? '' : ' · 未加载模型';
  let injected = '';
  if (typeof st.injectedCount === 'number') {
    const at = st.lastInjectedAt ? ` · 最近 ${formatClock(st.lastInjectedAt)}` : '';
    injected = ` · 已注入 ${st.injectedCount} 帧${at}`;
    if (typeof st.droppedCount === 'number' && st.droppedCount > 0) injected += ` · 丢弃 ${st.droppedCount}`;
  }
  const err = st.lastError ? `｜${st.lastError}` : '';
  return `${link}${model}${injected}${err}`;
}

/** ISO 时间 → 本地 HH:MM:SS（状态行只给"最近一次注入"用，不显示日期） */
function formatClock(iso: string): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  return t.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 渲染一行 VTS 状态 */
function renderVtsStatus(st: VtsStatusDto | null): void {
  const el = elementById<HTMLElement>('setting-vts-status');
  if (el) el.textContent = describeVtsStatus(st);
}

/** 拉一次 VTS 状态（设置页打开/操作后调用） */
async function refreshVtsStatus(bridge: RendererBridge): Promise<void> {
  const el = elementById<HTMLElement>('setting-vts-status');
  if (typeof bridge.vtsStatus !== 'function') {
    if (el) el.textContent = '当前版本不支持 VTS（preload 未暴露 vtsStatus）';
    return;
  }
  try {
    renderVtsStatus(await bridge.vtsStatus());
  } catch (err) {
    if (el) el.textContent = `读取 VTS 状态失败：${(err as Error).message ?? String(err)}`;
  }
}

/* ---------------------------------------------------------------- VTS → 桌宠反向同步 */

/** 最近一次 VTS 事件（自查用；与 status 推送分开，事件可能很频繁） */
let vtsEventCount = 0;
let lastVtsEvent: VtsEventDto | null = null;
/** 最近一条事件在本地做了什么：expression:<名字> / motion:<名字> / ignored:<原因> / modelLoaded */
let lastVtsEventAction = '';

/** 在当前模型的名字表里找匹配项：先精确、再忽略大小写（VTS 热键名大小写不敏感） */
function matchLocalName(names: string[], wanted: string): string | null {
  if (!wanted) return null;
  if (names.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  return names.find((name) => name.toLowerCase() === lower) ?? null;
}

/**
 * VTS 事件 → 桌宠本地同步（**单向**：VTS → 本地，绝不回写 VTS）。
 *
 * 热键名先当表情（setExpression）、再当动作组（playMotion）；本地模型都没有就忽略并记一条 info。
 * 注意：**不要**在这里调用 VTS 操作或触发热键，否则 VTS 的热键事件会回环触发自己。
 * 我们自己按钮触发的热键也会经 VTS 事件回到这里 —— 这是有意的：两边看到同一件事。
 */
function applyVtsEvent(event: VtsEventDto | null): void {
  if (!event || typeof event !== 'object') return;
  vtsEventCount += 1;
  lastVtsEvent = event;
  if (event.kind !== 'hotkeyTriggered') {
    lastVtsEventAction = event.kind;
    return;
  }
  const wanted = typeof event.hotkeyName === 'string' ? event.hotkeyName.trim() : '';
  const h = currentHandle;
  const expression = wanted ? matchLocalName(listCurrentExpressions(), wanted) : null;
  if (h && expression && typeof h.setExpression === 'function') {
    try {
      h.setExpression(expression);
      lastVtsEventAction = `expression:${expression}`;
      return;
    } catch {
      /* 表情失败：继续试同名动作组 */
    }
  }
  const motion = wanted ? matchLocalName(listCurrentMotions(), wanted) : null;
  if (h && motion && typeof h.playMotion === 'function') {
    try {
      h.playMotion(motion);
      lastVtsEventAction = `motion:${motion}`;
      return;
    } catch {
      /* 动作失败：按忽略处理 */
    }
  }
  lastVtsEventAction = `ignored:${wanted || '(空)'}`;
  console.info(`[renderer] VTS 热键「${wanted || '(空)'}」在本地模型上没有同名表情/动作组，已忽略`);
}

/** 点「连接 / 授权 / 断开 / 刷新 / 触发热键」 */
async function runVtsActionFromUi(bridge: RendererBridge, action: 'connect' | 'authorize' | 'disconnect' | 'refresh' | 'trigger-hotkey'): Promise<void> {
  if (typeof bridge.vtsAction !== 'function') {
    setSettingsStatus('当前版本不支持 VTS 操作（preload 未暴露 vtsAction）', true);
    return;
  }
  const hotkeyInput = elementById<HTMLInputElement>('setting-vts-hotkey');
  // connect 时把端口一起带过去（用户可能刚改了端口还没点保存）；其余操作用不到 arg
  const arg = action === 'trigger-hotkey'
    ? (hotkeyInput?.value.trim() ?? '')
    : action === 'connect'
      ? (elementById<HTMLInputElement>('setting-vts-port')?.value.trim() ?? '')
      : '';
  if (action === 'trigger-hotkey' && !arg) {
    setSettingsStatus('先填一个 VTS 里的热键名再点「触发热键」', true);
    return;
  }
  if (action === 'authorize') setSettingsStatus('等待 VTS 弹窗（去 VTS 里点「允许」）…');
  else if (action === 'connect') setSettingsStatus('正在连接 VTS…');
  try {
    const result = await bridge.vtsAction(action, arg || undefined);
    renderVtsStatus(result.status ?? null);
    if (!result.ok) {
      setSettingsStatus(result.error ?? describeVtsStatus(result.status ?? null), true);
      return;
    }
    setSettingsStatus(result.message ?? '完成');
    // 连接/授权成功后顺便勾上「启用」并开始发视线：用户点了连接显然是想用 VTS
    if (action === 'connect' || action === 'authorize') {
      const box = elementById<HTMLInputElement>('setting-vts-enabled');
      if (box) box.checked = true;
      setVtsTrackingEnabled(true);
    }
  } catch (err) {
    setSettingsStatus(`VTS 操作失败：${(err as Error).message ?? String(err)}`, true);
  }
}

/**
 * 设置页「测试注入」：让**主进程**直接注入一帧固定追踪值（faceAngleX=15 / eyeLeftX=0.6 /
 * mouthOpen=0.7），1 秒后归零。
 *
 * 它完全绕过渲染层的视线链路，所以能把问题切成两半：
 *   - 点它 VTS 里模型动了 → 主进程→VTS 通；那"动鼠标没反应"就出在渲染层（看 __petDebug.vts()）
 *   - 点它也不动 → 是 VTS 侧的授权/模型/参数映射问题，与渲染层无关
 * 注意：ok=true 只代表 VTS 接受了请求；真实生效用 scripts/check-vts.js 读回 VTS **输入参数**
 * 判断（MouthOpen 最可靠：VTS 自己的摄像头追踪不会写它；而 FaceAngleX/EyeLeftX 每帧会被追踪写回去）。
 */
async function runVtsTestInjectFromUi(bridge: RendererBridge): Promise<void> {
  const btn = elementById<HTMLButtonElement>('setting-vts-test-inject');
  if (typeof bridge.vtsAction !== 'function') {
    setSettingsStatus('当前版本不支持 VTS 操作（preload 未暴露 vtsAction）', true);
    return;
  }
  if (btn) btn.disabled = true;
  setSettingsStatus('测试注入：主进程直接发 faceAngleX=15 / eyeLeftX=0.6 / mouthOpen=0.7（1 秒后归零）…');
  try {
    const result = await bridge.vtsAction('test-inject');
    renderVtsStatus(result.status ?? null);
    if (!result.ok) {
      setSettingsStatus(result.error ?? '测试注入失败（先点「连接」和「授权」）', true);
      return;
    }
    setSettingsStatus(result.message ?? '测试注入已发送');
  } catch (err) {
    setSettingsStatus(`测试注入失败：${(err as Error).message ?? String(err)}`, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- AI 接入方式（API / 桥接 DSH）---------- */
/** 二选一：选中哪边就展开哪边配置区，另一边收起（details 折叠）。 */
function syncAiModeDetails(): void {
  const dshSelected = elementById<HTMLInputElement>('setting-ai-mode-dsh')?.checked === true;
  const apiDetails = elementById<HTMLDetailsElement>('ai-api-details');
  const dshDetails = elementById<HTMLDetailsElement>('ai-dsh-details');
  if (apiDetails) apiDetails.open = !dshSelected;
  if (dshDetails) dshDetails.open = dshSelected;
}

/** 读取 DSH 桥接状态并显示在设置页（只探测 dsh 命令/版本，不发起对话）。 */
async function refreshDshStatus(bridge: RendererBridge): Promise<void> {
  const el = elementById<HTMLElement>('dsh-status-text');
  if (!el) return;
  const maybe = bridge as RendererBridge & { getDshStatus?: () => Promise<import('../shared/contracts').DshStatus> };
  if (typeof maybe.getDshStatus !== 'function') {
    el.textContent = '当前版本不支持 DSH 状态查询';
    return;
  }
  el.textContent = '检测 DSH…';
  el.className = 'settings-status';
  try {
    const s = await maybe.getDshStatus();
    el.textContent = s.available
      ? `DSH 可用：${s.version ?? '版本未知'}（${s.commandPath}）`
      : `DSH 不可用：${s.lastError ?? '未检测到 dsh 命令'}`;
    el.className = s.available ? 'settings-status' : 'settings-status is-error';
  } catch (err) {
    el.textContent = `DSH 状态检测失败：${(err as Error).message ?? String(err)}`;
    el.className = 'settings-status is-error';
  }
}

/** 重置 DSH 会话（设置页按钮；下一条消息新开会话）。 */
async function resetDshSessionFromUi(bridge: RendererBridge): Promise<void> {
  const el = elementById<HTMLElement>('dsh-status-text');
  const maybe = bridge as RendererBridge & { resetDshSession?: () => Promise<void> };
  if (typeof maybe.resetDshSession !== 'function') {
    if (el) el.textContent = '当前版本不支持重置 DSH 会话';
    return;
  }
  try {
    await maybe.resetDshSession();
    if (el) {
      el.textContent = 'DSH 会话已重置（下一条消息新开会话）';
      el.className = 'settings-status';
    }
  } catch (err) {
    if (el) {
      el.textContent = `重置失败：${(err as Error).message ?? String(err)}`;
      el.className = 'settings-status is-error';
    }
  }
}
