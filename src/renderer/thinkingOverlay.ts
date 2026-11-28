/**
 * thinkingOverlay.ts —— 思考过程浮窗（推理内容 + 工具步骤展示）
 *
 * 从 renderer.ts 拆出的独立全局脚本（无 import/export，由 index.html 在 renderer.js 之前加载）。
 * 拆分原因：renderer.ts 曾达 6,125 行，资产面板/语音输入/思考浮窗是三块边界清晰的声明区，
 * 单独成文件便于定位与 review；它们与 renderer.ts 共享同一个全局作用域（函数声明在脚本加载时
 * 即已可用），所以调用方代码不需要任何改动。
 *
 * 注意：本文件顶层只有声明，没有可执行语句——顺序上只要求先于 renderer.js 加载（见 index.html）。
 */

/* ================================================================
   9.9 思考过程浮窗（贴在模型旁边）：推理内容 + 工具步骤实时显示
   ================================================================ */
type ThinkEvent = { kind: 'start' | 'reasoning' | 'tool' | 'result' | 'done' | 'error'; text: string };
let thinkHideTimer = 0;
let thinkCollapsed = false;
let thinkUserClosed = false; // 本轮被用户 × 关闭：不再自动弹出，直到下一轮 start
let chatSessionOpen = false; // 对话窗是否打开（浮窗仅在对话打开时显示）
let thinkRoundActive = false; // 是否有一轮思考正在进行（决定"等待确认"结束后标题回到什么）
let thinkWaiting = false; // 正在等用户确认（弹窗期间"暂停"）

/** 弹确认框期间把浮窗切成"暂停等待"态；用户作答后恢复 */
function setThinkWaiting(on: boolean): void {
  thinkWaiting = on;
  const panel = elementById<HTMLElement>('think-panel');
  const title = elementById<HTMLElement>('think-title');
  panel?.classList.toggle('is-waiting', on);
  if (!title) return;
  if (on) {
    title.textContent = '⏸ 等你确认…';
    return;
  }
  if (thinkRoundActive) title.textContent = '思考中…';
}

/** 打开对话时同步打开浮窗（空内容时显示待命标题） */
function openThinkWithChat(): void {
  chatSessionOpen = true;
  thinkUserClosed = false;
  const panel = elementById<HTMLElement>('think-panel');
  const capsule = elementById<HTMLButtonElement>('think-capsule');
  const list = elementById<HTMLElement>('think-list');
  const title = elementById<HTMLElement>('think-title');
  if (thinkHideTimer) {
    window.clearTimeout(thinkHideTimer);
    thinkHideTimer = 0;
  }
  if (capsule) capsule.hidden = true;
  if (panel) {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
  }
  if (list && title) {
    // 保留历史：有上次记录则提示“思考记录（上次）”，否则待命
    title.textContent = list.childElementCount > 0 ? '思考记录（上次）' : '等待你的消息…';
  }
  thinkCollapsed = false;
}

/** 关闭对话时彻底关闭浮窗：面板与胶囊都收起；**保留历史内容**，下次打开对话仍可见 */
function closeThinkWithChat(): void {
  chatSessionOpen = false;
  thinkUserClosed = false;
  if (thinkHideTimer) {
    window.clearTimeout(thinkHideTimer);
    thinkHideTimer = 0;
  }
  const panel = elementById<HTMLElement>('think-panel');
  const capsule = elementById<HTMLButtonElement>('think-capsule');
  if (panel) {
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  if (capsule) capsule.hidden = true;
  thinkCollapsed = false;
}

function hideThinkPanel(): void {
  const panel = elementById<HTMLElement>('think-panel');
  const capsule = elementById<HTMLButtonElement>('think-capsule');
  if (thinkHideTimer) {
    window.clearTimeout(thinkHideTimer);
    thinkHideTimer = 0;
  }
  if (panel) {
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  if (capsule) capsule.hidden = true; // 彻底关闭：胶囊也收起，直到下一轮
  thinkUserClosed = true;
  thinkCollapsed = false;
}

/** 折叠成右下角「🧠 详情」胶囊（保留内容，可再展开） */
function collapseThinkPanel(): void {
  const panel = elementById<HTMLElement>('think-panel');
  const capsule = elementById<HTMLButtonElement>('think-capsule');
  if (panel) {
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
  }
  if (capsule) capsule.hidden = false;
  thinkCollapsed = true;
}

/**
 * 「答完过一会儿自动折叠成胶囊」的定时器。
 * 思考浮窗模式（?panel=think）里不做这个折叠：整个窗口就是面板，主进程会在答完 2.5s 后直接收起窗口。
 */
function scheduleThinkCollapse(ms: number): void {
  if (THINK_PANEL_MODE) return;
  thinkHideTimer = window.setTimeout(collapseThinkPanel, ms);
}

function expandThinkPanel(): void {
  const panel = elementById<HTMLElement>('think-panel');
  const capsule = elementById<HTMLButtonElement>('think-capsule');
  if (panel) {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    const plan = elementById<HTMLElement>('think-plan');
    if (plan && plan.childElementCount > 0) plan.hidden = false; // 展开时把进度清单一并显示
  }
  if (capsule) capsule.hidden = true;
  thinkCollapsed = false;
}

/** 渲染 AI 的任务进度清单（plan_update）：done=✓、doing=▸、pending=· */
function renderPlan(items: unknown): void {
  const planEl = elementById<HTMLElement>('think-plan');
  if (!planEl) return;
  if (!Array.isArray(items) || items.length === 0) {
    clearPlan();
    return;
  }
  const prefix: Record<string, string> = { done: '✓ ', doing: '▸ ', pending: '· ' };
  const frag = document.createDocumentFragment();
  for (const raw of items.slice(0, 20)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as { text?: unknown; status?: unknown };
    const text = typeof row.text === 'string' ? row.text : '';
    if (!text) continue;
    const status = row.status === 'done' || row.status === 'doing' || row.status === 'pending' ? row.status : 'pending';
    const line = document.createElement('div');
    line.className = `think-plan-item is-${status}`;
    line.textContent = `${prefix[status]}${text}`;
    line.title = text;
    frag.appendChild(line);
  }
  planEl.replaceChildren(frag);
  const hasRows = planEl.childElementCount > 0;
  const panel = elementById<HTMLElement>('think-panel');
  // 对话没打开时不弹浮窗（独立聊天窗口接管对话时，桌宠窗口不该再冒进度面板出来）
  planEl.hidden = !hasRows || !panel || panel.hidden || !chatSessionOpen;
  if (hasRows && panel && chatSessionOpen) {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
  }
}

/** 清空进度清单（新一轮开始时调用；'done'/'error' 时保留，便于回看） */
function clearPlan(): void {
  const planEl = elementById<HTMLElement>('think-plan');
  if (!planEl) return;
  planEl.replaceChildren();
  planEl.hidden = true;
}

function pushThinkLine(evt: ThinkEvent): void {
  // 对话窗已关闭 / 本轮被 × 关闭 → 不弹浮窗（其他功能不受影响）
  if (!chatSessionOpen) return;
  if (thinkUserClosed && evt.kind !== 'start') return;
  const panel = elementById<HTMLElement>('think-panel');
  const list = elementById<HTMLElement>('think-list');
  const title = elementById<HTMLElement>('think-title');
  if (!panel || !list) return;
  if (thinkHideTimer) {
    window.clearTimeout(thinkHideTimer);
    thinkHideTimer = 0;
  }
  if (evt.kind === 'start') {
    list.replaceChildren(); // 新一轮：清空旧内容并自动展开
    clearPlan(); // 新一轮的任务清单也清空（AI 会重新 plan_update）
    thinkRoundActive = true;
    thinkWaiting = false;
    panel.classList.remove('is-waiting');
    if (title) title.textContent = '思考中…';
    thinkUserClosed = false;
    expandThinkPanel();
  }
  const line = document.createElement('div');
  line.className = `think-line is-${evt.kind}`;
  // 单条过长（思考链/工具结果可能是整段文件）只显示前 600 字，完整内容挂在 title 上，避免浮窗被撑爆
  const raw = evt.text ?? '';
  if (raw.length > 600) {
    line.textContent = `${raw.slice(0, 600)}…（共 ${raw.length} 字）`;
    line.title = raw;
  } else {
    line.textContent = raw;
  }
  list.appendChild(line);
  while (list.childElementCount > 30) list.removeChild(list.firstElementChild as Element);
  list.scrollTop = list.scrollHeight;
  if (!thinkCollapsed) {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    const plan = elementById<HTMLElement>('think-plan');
    if (plan && plan.childElementCount > 0) plan.hidden = false;
  }
  if (evt.kind === 'done') {
    thinkRoundActive = false;
    if (title && !thinkWaiting) title.textContent = '思考完成';
    scheduleThinkCollapse(8000); // 8s 后收起为胶囊（可再展开）
  } else if (evt.kind === 'error') {
    thinkRoundActive = false;
    if (title && !thinkWaiting) title.textContent = '出错了';
    scheduleThinkCollapse(6000);
  } else if (evt.kind === 'tool' && title && !thinkWaiting) {
    title.textContent = '执行中…';
  } else if (evt.kind === 'result' && title && !thinkWaiting) {
    title.textContent = '继续思考…';
  }
}

/** 拖动浮窗（header 按住拖）；位置限制在窗口内，拖过只记 left/top */
function installThinkDrag(): void {
  const panel = elementById<HTMLElement>('think-panel');
  const header = panel?.querySelector('.think-header') as HTMLElement | null;
  if (!panel || !header) return;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  header.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
    try {
      header.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
  });
  header.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = panel.getBoundingClientRect();
    const nextLeft = Math.min(Math.max(4, rect.left + (e.clientX - lastX)), Math.max(4, window.innerWidth - rect.width - 4));
    const nextTop = Math.min(Math.max(4, rect.top + (e.clientY - lastY)), Math.max(4, window.innerHeight - rect.height - 4));
    lastX = e.clientX;
    lastY = e.clientY;
    panel.style.right = 'auto';
    panel.style.left = `${Math.round(nextLeft)}px`;
    panel.style.top = `${Math.round(nextTop)}px`;
  });
  const endDrag = (): void => {
    dragging = false;
  };
  header.addEventListener('pointerup', endDrag);
  header.addEventListener('pointercancel', endDrag);
}

function installThinkPanel(bridge: RendererBridge): void {
  bridge.onThink?.((evt) => {
    pushThinkLine(evt);
    // 工具步骤同时记进对话记录（不落盘），让"它在干什么"在对话里也看得见
    if (evt && evt.kind === 'tool' && typeof evt.text === 'string') {
      appendChatLog('tool', evt.text, { persist: false });
    }
    return hideThinkPanel;
  });
  // AI 的任务进度清单（plan_update 推送）：渲染在浮窗顶部，让用户随时看到做到哪一步了
  bridge.onPlan?.((payload) => renderPlan(payload?.items));
  elementById<HTMLButtonElement>('think-close')?.addEventListener('click', hideThinkPanel);
  elementById<HTMLButtonElement>('think-capsule')?.addEventListener('click', expandThinkPanel);
  installThinkDrag();
}

/** 滚动容器支持"按住空白处拖动滚动"（滚动条较细时，直接拖内容更符合直觉） */
function installDragScroll(el: HTMLElement | null): void {
  if (!el) return;
  let active = false;
  let startY = 0;
  let startTop = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t && t.closest && t.closest('input, select, textarea, button, a')) return; // 控件上不拖
    active = true;
    startY = e.clientY;
    startTop = el.scrollTop;
  });
  el.addEventListener('pointermove', (e) => {
    if (!active) return;
    el.scrollTop = startTop - (e.clientY - startY);
  });
  const stop = (): void => { active = false; };
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  window.addEventListener('blur', stop);
}

function installSettingsUi(bridge: RendererBridge): void {
  settingsBridge = bridge;
  const menu = elementById<HTMLElement>('context-menu');

  // 设置页「更新」区：立即检查（会联网；忽略"启动时自动检查"开关）。
  // 更新状态文字/当前版本/前往下载按钮由 renderer.ts 的 renderUpdateStatus 统一渲染。
  elementById<HTMLButtonElement>('btn-check-update')?.addEventListener('click', () => {
    const statusEl = elementById<HTMLElement>('update-status-text');
    const maybe = bridge as RendererBridge & { checkForUpdates?: () => Promise<import('../shared/contracts').UpdateSnapshot> };
    if (typeof maybe.checkForUpdates !== 'function') {
      if (statusEl) statusEl.textContent = '当前版本不支持检查更新';
      return;
    }
    if (statusEl) statusEl.textContent = '正在检查 GitHub 更新…';
    void maybe
      .checkForUpdates()
      .then((snapshot) => renderUpdateStatus(snapshot))
      .catch((err: unknown) => {
        if (statusEl) statusEl.textContent = `检查失败：${(err as Error).message ?? String(err)}`;
      });
  });

  // 设置页顶部的项目链接（Star / Issue / 下载）：交给主进程用系统浏览器打开，
  // 因为主窗口拦截了所有外部导航与新窗口。
  for (const link of Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-external-link'))) {
    link.addEventListener('click', () => {
      const url = link.dataset.url || '';
      if (!url) return;
      if (typeof bridge.openExternal !== 'function') {
        setSettingsStatus('当前版本不支持打开外部链接', true);
        return;
      }
      void bridge
        .openExternal(url)
        .then((err) => {
          if (err) setSettingsStatus(`打开链接失败：${err}`, true);
        })
        .catch((err: unknown) => setSettingsStatus(`打开链接失败：${(err as Error).message ?? String(err)}`, true));
    });
  }

  // —— 右键菜单：主进程推送坐标（params.x/y 为 DIP client 坐标）→ 定位显示 ——
  bridge.onContextMenu?.((position) => {
    showContextMenu(position.x, position.y);
  });

  // —— 统一菜单项点击（data-menu-action / data-menu-expression）——
  menu?.addEventListener('click', (event) => {
    const btn = (event.target as HTMLElement).closest('button');
    if (!btn || !menu) return;
    const action = btn.getAttribute('data-menu-action');
    if (action) {
      switch (action) {
        case 'idle':
          playIdleMotion();
          break;
        case 'chat':
          void openChatSurface(bridge); // 优先弹独立聊天窗口；失败回退窗口内输入条
          break;
        case 'framing':
          void toggleFraming(bridge); // 全身 / 半身
          break;
        case 'settings':
          openSettings(bridge); // 内部会 hideContextMenu()
          break;
        case 'reload':
          hideContextMenu();
          void switchModel(
            bridge,
            elementById<HTMLSelectElement>('setting-model')?.value || activeModelName || '',
          );
          break;
        case 'quit':
          quitPet(); // 内部先隐藏再关窗
          break;
        default:
          hideContextMenu();
          break;
      }
      return;
    }
    const expr = btn.getAttribute('data-menu-expression');
    if (expr !== null) triggerExpression(expr);
  });

  // —— 点菜单外、ESC、窗口失焦 → 隐藏 ——
  // 注意：左键点模型**不再**收起聊天条（用户点宠物只是想互动，不该把输入框弄没）；
  // 收起聊天条改为右键（右键经主进程推 IPC_CONTEXT_MENU → showContextMenu() 内部 hideChatBar()）或 ESC。
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    if (menu && target.closest('#context-menu')) return;
    hideContextMenu();
    if (target.closest('#chatbar')) return; // 聊天条内部点击：既不关菜单也不关聊天条
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideContextMenu();
      hideChatBar();
      closeTodoPanel(); // ESC 也关闭待办面板
    }
  });
  window.addEventListener('blur', hideContextMenu);

  // —— AI 对话输入条：Enter 发送 / Esc 收起 / 按钮发送 ——
  elementById<HTMLButtonElement>('chat-send')?.addEventListener('click', () => {
    void sendChat(bridge);
  });
  elementById<HTMLInputElement>('chat-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendChat(bridge);
    } else if (event.key === 'Escape') {
      hideChatBar(); // 输入框内 Esc：只收聊天条（全局 Esc 逻辑同效，双重无害）
    }
  });

  // —— 设置面板 ——
  elementById<HTMLButtonElement>('settings-close')?.addEventListener('click', closeSettings);
  elementById<HTMLInputElement>('setting-sfx-volume')?.addEventListener('input', (event) => {
    // 拖动时实时显示百分比（是否生效仍以“保存设置”为准）
    const val = Number((event.target as HTMLInputElement).value);
    const display = elementById<HTMLElement>('sfx-volume-display');
    if (display) display.textContent = `${Number.isFinite(val) ? Math.round(val * 100) : 60}%`;
  });
  elementById<HTMLButtonElement>('settings-save')?.addEventListener('click', (event) => {
    event.preventDefault();
    void saveSettings(bridge).catch((err: unknown) => setSettingsStatus(`保存失败：${(err as Error).message ?? String(err)}`, true));
  });
  // AI 接入方式（二选一）：切单选时展开对应配置区、收起另一边；DSH 按钮刷新状态/重置会话
  elementById<HTMLInputElement>('setting-ai-mode-api')?.addEventListener('change', syncAiModeDetails);
  elementById<HTMLInputElement>('setting-ai-mode-dsh')?.addEventListener('change', syncAiModeDetails);
  elementById<HTMLButtonElement>('dsh-refresh-status')?.addEventListener('click', () => {
    void refreshDshStatus(bridge);
  });
  elementById<HTMLButtonElement>('dsh-reset-session')?.addEventListener('click', () => {
    void resetDshSessionFromUi(bridge);
  });
  // —— VTube Studio（可选后端）：连接 / 授权 / 断开 / 刷新 / 触发热键 / 试听语音 ——
  elementById<HTMLButtonElement>('setting-vts-connect')?.addEventListener('click', () => {
    void runVtsActionFromUi(bridge, 'connect');
  });
  elementById<HTMLButtonElement>('setting-vts-authorize')?.addEventListener('click', () => {
    void runVtsActionFromUi(bridge, 'authorize');
  });
  elementById<HTMLButtonElement>('setting-vts-disconnect')?.addEventListener('click', () => {
    void runVtsActionFromUi(bridge, 'disconnect');
  });
  elementById<HTMLButtonElement>('setting-vts-refresh')?.addEventListener('click', () => {
    void runVtsActionFromUi(bridge, 'refresh');
  });
  elementById<HTMLButtonElement>('setting-vts-hotkey-run')?.addEventListener('click', () => {
    void runVtsActionFromUi(bridge, 'trigger-hotkey');
  });
  // 「测试注入」：绕过渲染层的视线链路，直接验证"主进程 → VTS"（排障用，无副作用）
  elementById<HTMLButtonElement>('setting-vts-test-inject')?.addEventListener('click', () => {
    void runVtsTestInjectFromUi(bridge);
  });
  elementById<HTMLButtonElement>('setting-tts-speak')?.addEventListener('click', () => {
    void speakSampleFromUi(bridge);
  });
  elementById<HTMLButtonElement>('setting-tts-voices-refresh')?.addEventListener('click', () => {
    void refreshTtsVoiceOptions(bridge);
  });
  // 「启用 VTS」勾上/取消：立刻决定要不要发视线（保存后配置才落盘，这里只控制发送开关）
  elementById<HTMLInputElement>('setting-vts-enabled')?.addEventListener('change', (event) => {
    setVtsTrackingEnabled((event.target as HTMLInputElement).checked === true);
  });
  elementById<HTMLFormElement>('settings-form')?.addEventListener('submit', (event) => event.preventDefault());
  // 开发工作区：选择文件夹 / 打开
  elementById<HTMLButtonElement>('setting-dev-root-pick')?.addEventListener('click', () => {
    void (async () => {
      try {
        const picked = await bridge.pickFolder?.();
        if (!picked) return; // 用户取消
        const input = elementById<HTMLInputElement>('setting-dev-root');
        if (input) input.value = picked;
        setSettingsStatus('已选择工作区，点「保存设置」后生效。');
      } catch (err) {
        setSettingsStatus(`选择文件夹失败：${(err as Error).message ?? String(err)}`, true);
      }
    })();
  });
  elementById<HTMLButtonElement>('setting-dev-root-open')?.addEventListener('click', () => {
    void (async () => {
      const folder = elementById<HTMLInputElement>('setting-dev-root')?.value.trim() ?? '';
      if (!folder) {
        setSettingsStatus('还没有选择开发工作区。', true);
        return;
      }
      try {
        const error = await bridge.openPath?.(folder);
        if (error) setSettingsStatus(`打开失败：${error}`, true);
        else setSettingsStatus('已在资源管理器中打开工作区。');
      } catch (err) {
        setSettingsStatus(`打开失败：${(err as Error).message ?? String(err)}`, true);
      }
    })();
  });
  elementById<HTMLSelectElement>('setting-model')?.addEventListener('change', (event) => {
    const name = (event.target as HTMLSelectElement).value;
    void refreshPresetInfo(bridge); // 换模型 → 预设摘要跟着换
    void switchModel(bridge, name);
  });
  // 模型预设（pet-model.json）：为当前模型生成/打开模板
  elementById<HTMLButtonElement>('asset-preset-edit')?.addEventListener('click', () => {
    void openModelPreset(bridge);
  });
  // 能力归类：重新识别（幂等，只填空缺；改动立即通过 refreshPresetInfo 反映出来）
  elementById<HTMLButtonElement>('asset-detect')?.addEventListener('click', () => {
    void (async () => {
      const name = settingsTargetModel();
      if (!name) { setSettingsStatus('先选一个模型', true); return; }
      if (typeof bridge.assetPreset !== 'function') { setSettingsStatus('当前版本不支持能力识别', true); return; }
      setSettingsStatus('正在识别模型能力…');
      const r = await bridge.assetPreset('detect', name);
      if (!r || !r.ok) { setSettingsStatus(`识别失败：${r?.error ?? '未知原因'}`, true); return; }
      const c = r.capabilities ?? {};
      const parts: string[] = [];
      if (c.click?.length) parts.push(`点击触发：${c.click.join('、')}`);
      if (c.costume?.length) parts.push(`服饰/道具：${c.costume.join('、')}`);
      if (c.emotion) parts.push(`情绪表情：${Object.entries(c.emotion).map(([k, v]) => `${k}→${v}`).join('、')}`);
      if (c.motions?.length) parts.push(`其它动作：${c.motions.join('、')}`);
      const issues = r.capabilityIssues?.length ? `（${r.capabilityIssues.join('；')}）` : '';
      setSettingsStatus(`识别完成：${parts.length ? parts.join('｜') : '没有可归类的能力'}${issues}`);
      await refreshAssetPanel(bridge);
    })();
  });

  // 语音识别：自检按钮（用内置合成音频打两条路由，不需要麦克风）
  elementById<HTMLButtonElement>('setting-voice-check')?.addEventListener('click', () => {
    void runVoiceCheck(bridge);
  });
  // MCP / 自主任务面板
  elementById<HTMLButtonElement>('setting-mcp-refresh')?.addEventListener('click', () => {
    void refreshMcpPanel(bridge);
  });
  elementById<HTMLButtonElement>('setting-mcp-reload')?.addEventListener('click', () => {
    void reloadMcpFromUi(bridge);
  });
  elementById<HTMLButtonElement>('setting-autotask-run')?.addEventListener('click', () => {
    void runAutoTaskNowFromUi(bridge);
  });
  // 可插拔资产：打开文件夹 / 添加 / 重新扫描
  elementById<HTMLButtonElement>('asset-model-open')?.addEventListener('click', () => {
    void (async () => {
      const err = await bridge.assetOpenDir?.('model');
      if (err) setSettingsStatus(`打开模型文件夹失败：${err}`, true);
    })();
  });
  elementById<HTMLButtonElement>('asset-plugin-open')?.addEventListener('click', () => {
    void (async () => {
      const err = await bridge.assetOpenDir?.('plugin');
      if (err) setSettingsStatus(`打开插件文件夹失败：${err}`, true);
    })();
  });
  const importAsset = (kind: 'model' | 'plugin'): void => {
    void (async () => {
      setSettingsStatus(kind === 'model' ? '正在加入模型…' : '正在加入插件…');
      const r = await bridge.assetImport?.(kind);
      if (!r) return;
      if (!r.ok) {
        setSettingsStatus(`加入失败：${r.error ?? '未知原因'}`, true);
      } else if (r.issues && r.issues.length) {
        setSettingsStatus(`已加入「${r.name}」，但有 ${r.issues.length} 条提示（见列表）`, true);
      } else {
        setSettingsStatus(`已加入「${r.name}」，可以直接用了`);
      }
      await refreshAssetPanel(bridge);
      // 模型列表变了 → 刷新模型下拉框
      if (kind === 'model') await refreshModelOptions(bridge);
    })();
  };
  elementById<HTMLButtonElement>('asset-model-add')?.addEventListener('click', () => importAsset('model'));
  elementById<HTMLButtonElement>('asset-plugin-add')?.addEventListener('click', () => importAsset('plugin'));
  elementById<HTMLButtonElement>('asset-refresh')?.addEventListener('click', () => {
    void (async () => {
      await refreshAssetPanel(bridge);
      setSettingsStatus('已重新扫描模型 / 插件目录');
    })();
  });
  elementById<HTMLButtonElement>('setting-ai-model-refresh')?.addEventListener('click', () => {
    const panel = elementById<HTMLElement>('setting-ai-model-panel');
    if (panel && !panel.hidden) {
      closeAiModelPanel();
      return;
    }
    void refreshAiModelOptions(bridge, true);
  });
  elementById<HTMLInputElement>('setting-ai-model-filter')?.addEventListener('input', (event) => {
    renderAiModelList((event.target as HTMLInputElement).value);
  });
  elementById<HTMLInputElement>('setting-ai-model-filter')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAiModelPanel();
    }
  });

  // 视觉模型：从视觉专用端点（留空则聊天端点）索引候选，和 AI 模型选择一致
  elementById<HTMLButtonElement>('setting-vision-model-pick')?.addEventListener('click', () => {
    const panel = elementById<HTMLElement>('setting-vision-model-panel');
    if (panel && !panel.hidden) {
      closeVisionModelPanel();
      return;
    }
    closeAiModelPanel();
    closeVoiceModelPanel();
    void refreshVisionModelOptions(bridge, true);
  });
  elementById<HTMLInputElement>('setting-vision-model-filter')?.addEventListener('input', (event) => {
    renderVisionModelList((event.target as HTMLInputElement).value);
  });
  elementById<HTMLInputElement>('setting-vision-model-filter')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeVisionModelPanel();
    }
  });

  // 转写模型：按 API 地址索引（GET /models），从候选里挑一个填进输入框
  elementById<HTMLButtonElement>('setting-voice-model-pick')?.addEventListener('click', () => {
    const panel = elementById<HTMLElement>('setting-voice-model-panel');
    if (panel && !panel.hidden) {
      closeVoiceModelPanel();
      return;
    }
    closeAiModelPanel(); // 两个内嵌列表不同时展开
    elementById<HTMLButtonElement>('setting-voice-model-pick')?.setAttribute('aria-expanded', 'true');
    void (async () => {
      await refreshVoiceModelIndex(bridge, { autoFill: false });
      if (panel) panel.hidden = false;
      const filter = elementById<HTMLInputElement>('setting-voice-model-filter');
      if (filter) filter.value = '';
      renderVoiceModelList('');
      window.requestAnimationFrame(() => {
        try {
          panel?.scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch {
          panel?.scrollIntoView(false);
        }
      });
    })();
  });
  elementById<HTMLInputElement>('setting-voice-model-filter')?.addEventListener('input', (event) => {
    renderVoiceModelList((event.target as HTMLInputElement).value);
  });
  elementById<HTMLInputElement>('setting-voice-model-filter')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeVoiceModelPanel();
    }
  });
  // 手改了转写模型名 → 本地先给个粗判断（是否在刚索引到的候选里），不额外打网络
  elementById<HTMLInputElement>('setting-voice-model')?.addEventListener('change', () => {
    const v = elementById<HTMLInputElement>('setting-voice-model')?.value.trim() ?? '';
    if (!v) {
      setVoiceModelHint('留空=按地址自动识别；点「▾ 按地址索引」可查看候选', 'warn');
      return;
    }
    if (voiceModelCandidates.length && !voiceModelCandidates.includes(v)) {
      setVoiceModelHint(`⚠️ 「${v}」不在这个地址的转写候选里（候选：${voiceModelCandidates.slice(0, 4).join('、')}）——保存后点「🎙 自检语音识别」确认`, 'warn');
      return;
    }
    void refreshVoiceModelIndex(bridge, { autoFill: false });
  });
}
