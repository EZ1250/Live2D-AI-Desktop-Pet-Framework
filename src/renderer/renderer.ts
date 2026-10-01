/**
 * renderer.ts — Pet 桌面宠物渲染进程入口
 *
 * 职责：
 *   1. 等待 preload 注入的 window.electron 窄接口。
 *   2. loadModel() 装载默认模型：先试空名 ''（主进程侧应回退到 models.json 第一项），
 *      再按 IPC_MODEL_LIST 返回的模型名逐个回退。工程不写死用户模型名。
 *   3. 按 ModelManifest.type 渲染：
 *        moc3     → PIXI + pixi-live2d（见 live2d.ts；不可用/失败 → 预览图或占位图形）
 *        portrait → <img src=manifest.url> + CSS transform 待机动画
 *   4. 统一 requestAnimationFrame 主循环：60fps 上限节流（lastTime 累加器 1000/60），
 *      document.hidden 时暂停、visibilitychange 恢复；每帧驱动当前渲染 handle。
 *   5. 气泡：showBubble() 自带逐字打字机（20ms/字，TTL 后淡出）。
 *   6. onWindowChange 订阅 → 右下角状态小字（活动窗口 / 摸鱼提示）。
 *
 * 运行约束（安全）：
 *   - contextIsolation:true，renderer 只能调用 window.electron 暴露的窄接口。
 *   - 本文件是【普通全局脚本】：不 import / 不 export（连类型也只通过类型查询
 *     `import('../shared/contracts')` 引用，编译后被完全擦除，不产生运行时
 *     require/import/module 标记）。因此无论 tsc 直出 renderer.js 还是打包器
 *     构建，都能被 index.html <script> 直接加载。
 *
 * 主进程推送：preload 已通过 onChat/onBubble/onAction/onGlobalCursor 等窄接口转发，
 * renderer 在启动时进行能力探测并订阅，保持旧版 preload 缺失这些入口时仍可降级运行。
 */

/* ================================================================
   0. 契约类型（类型查询引用 shared/contracts —— 纯类型、运行时零开销）
   ================================================================ */
type Any = any;
type ElectronAPI = import('../shared/contracts').ElectronAPI;
type ModelManifest = import('../shared/contracts').ModelManifest;
type WindowInfo = import('../shared/contracts').WindowInfo;
type AppSettings = import('../shared/contracts').AppSettings;

/* ================================================================
   1. 内部类型与常量
   ================================================================ */

/** live2d.ts 暴露的全局渲染库（见 ./live2d.ts 底部 window.PetLive2d） */
interface RenderLib {
  isLive2DAvailable(): boolean;
  mountLive2D(input: { container: HTMLElement; url: string }): Promise<RenderHandle | null>;
  mountPortrait(input: { container: HTMLElement; url: string }): RenderHandle | null;
  mountPlaceholder(input: { container: HTMLElement; name: string; hint?: string }): RenderHandle | null;
}
interface RenderHandle {
  kind: 'moc3' | 'portrait' | 'placeholder';
  update?(nowSec: number, deltaSec: number): void;
  /** 播放动作分组（如右键菜单“Idle 待机”；可用组名取决于模型） */
  playMotion?(group: string): void;
  /** 应用/清除表情（null = 恢复默认） */
  setExpression?(name: string | null): void;
  /** 当前模型可用表情名（无表情能力 → []） */
  listExpressions?(): string[];
  /** 视线目标 nx/ny ∈[-1,1]，向右/向上为正；0 = 归位 */
  setGaze?(nx: number, ny: number): void;
  /** 滚轮缩放：dir=+1 放大 / -1 缩小（moc3/portrait 支持；placeholder 不实现） */
  zoom?(dir: number): void;
  /** 角色在窗口中的实际可见范围（相对窗口顶部 px）；主进程用它把气泡贴在头顶上方 */
  bounds?(): { top: number; height: number } | null;
  /** 刷新命中遮罩（点击穿透用）；返回是否成功 */
  refreshHitMask?(): boolean;
  /** 客户端坐标是否命中角色；ok=false 表示暂无可靠数据（调用方不应拦截鼠标） */
  hitTest?(clientX: number, clientY: number): { ok: boolean; hit: boolean };
  /** 模型内容包围盒实测（遍历绘制网格顶点） */
  contentBounds?(): Any;
  /** 命中遮罩统计（不透明像素数与归一化包围盒）：客观验证遮罩是否真有内容 */
  hitMaskStats?(): { available: boolean; opaque: number; bbox: [number, number, number, number] | null; ageMs: number | null };
  /** 全身 / 半身取景切换（只动相机：缩放 + 位移 + 视线增益，不改模型参数映射） */
  setFraming?(mode: 'full' | 'half'): void;
  /* —— 追踪参数层（骨骼追踪 / 表情追踪 / 语音口型）；底层只吃"一帧参数"，不绑具体设备 —— */
  /** 推进一帧追踪数据；缺参数自动降级，层过期后自动回到鼠标跟随 */
  applyTrackingFrame?(frame: Any): void;
  /** 语音口型（驱动嘴部参数，TTL 由调用方给） */
  applySpeech?(mouth: { openY?: number; form?: number }, ttlMs?: number): void;
  /** 情绪标签 → 模型表情（返回实际应用的表情名；没匹配到返回 null） */
  applyEmotionLabel?(label: string, expressionName?: string): string | null;
  /** 追踪层状态（调试/状态展示） */
  trackingStatus?(): { sources: string[]; lastSource: string; lastFrameAgoMs: number | null };
  /** 清空追踪/语音层，回到基座（鼠标跟随） */
  clearTrackingLayer?(): void;
  /** 换一套参数映射（pet-model.json 的 parameterMap）：逻辑名 → 模型实际参数 ID */
  setParameterMap?(map: Record<string, string> | null | undefined): Record<string, string>;
  /** 当前参数映射 + 各参数是否存在（设置页展示"这个模型缺什么参数"） */
  parameterInfo?(): { ids: Record<string, string>; present: Record<string, boolean> };
  /** 调试用：moc3 挂载内部状态（换运行库时排查"画不出来"） */
  debug?(): unknown;
  destroy(): void;
}

/** 主进程推送订阅；保留能力探测以兼容旧版 preload。 */
interface PushBridge {
  onBubble?: (cb: (payload: { text?: string; ttlMs?: number }) => void) => void;
  onChat?: (cb: (payload: { delta?: string; full?: string; message?: string }) => void) => void;
  onAction?: (cb: (payload: { type?: string; payload?: Any }) => void) => void;
}
type RendererBridge = ElectronAPI & PushBridge;

/** RAF 节流：60fps 上限 */
const FRAME_INTERVAL_MS = 1000 / 60;
/**
 * 独立聊天窗口模式：同一个渲染页被主进程以 `?panel=chat` 加载时，
 * 只渲染对话面板（不初始化 Live2D、不挂模型），对话框因此永远在模型窗口之外。
 */
const CHAT_PANEL_MODE: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).get('panel') === 'chat';
  } catch {
    return false;
  }
})();
/** 思考浮窗模式：?panel=think 时只渲染思考过程面板（独立浮窗，提问时自动开、答完自动关） */
const THINK_PANEL_MODE: boolean = (() => {
  try {
    return new URLSearchParams(window.location.search).get('panel') === 'think';
  } catch {
    return false;
  }
})();
/** 气泡逐字速度 */
const TYPE_SPEED_MS = 20;
/** 气泡默认停留时长（打完字后开始计时） */
const DEFAULT_TTL_MS = 3800;

const IDLE_PHRASES = [
  '看起来好忙呀，摸摸鱼吧～',
  '记得起来活动一下哦～',
  '要不要歇一会儿？',
];

/* ================================================================
   1. DOM 引用
   ================================================================ */
let stageEl: HTMLElement | null = null;
let bubbleEl: HTMLElement | null = null;
let bubbleTextEl: HTMLElement | null = null;
let overlayEl: HTMLElement | null = null;
let overlayTextEl: HTMLElement | null = null;

function grabElements(): boolean {
  stageEl = document.getElementById('stage');
  bubbleEl = document.getElementById('bubble');
  bubbleTextEl = document.getElementById('bubble-text');
  overlayEl = document.getElementById('overlay');
  overlayTextEl = document.getElementById('overlay-text');
  chatLogEl = document.getElementById('chat-log');
  chatHistoryEl = document.getElementById('chat-history-list');
  return Boolean(stageEl && bubbleEl && bubbleTextEl && overlayEl && overlayTextEl);
}

/* ================================================================
   2. 渲染库访问（window.PetLive2d，live2d.ts 提供）
      —— 若 live2d.js 未加载（如被误删），本层用最小 DOM 实现兜底，
         保证“模型图像能显示 + 待机浮动动画”这两条底线不依赖 PIXI。
   ================================================================ */
function getRenderLib(): RenderLib | null {
  const lib = (window as Any).PetLive2d;
  return lib && typeof lib.mountPortrait === 'function' && typeof lib.mountLive2D === 'function'
    ? (lib as RenderLib)
    : null;
}

/** 兜底 portrait：纯 DOM <img> + 简易浮动（无 live2d.ts 时仍可显示） */
function fallbackPortrait(container: HTMLElement, url: string, name: string): RenderHandle | null {
  const box = document.createElement('div');
  box.className = 'pet-media';
  const img = document.createElement('img');
  img.className = 'pet-portrait';
  img.alt = name;
  img.draggable = false;
  img.addEventListener('load', () => img.classList.add('is-visible'));
  img.addEventListener('error', () => console.warn('[renderer] 兜底 portrait 加载失败:', url));
  img.src = url;
  box.appendChild(img);
  container.appendChild(box);
  const phase = Math.random() * Math.PI * 2;
  const handle: RenderHandle = {
    kind: 'portrait',
    update(nowSec: number): void {
      const t = nowSec + phase;
      const breathe = 1 + Math.sin(t * 1.35) * 0.012 + Math.sin(t * 0.63 + 1.8) * 0.008;
      const lift = Math.sin(t * 0.86) * 2.6 + Math.sin(t * 0.41 + 2.6) * 1.4;
      img.style.transform = `translateY(${lift.toFixed(2)}px) scale(${breathe.toFixed(4)})`;
    },
    destroy(): void {
      box.remove();
    },
  };
  return handle;
}

/** 兜底 placeholder */
function fallbackPlaceholder(container: HTMLElement, name: string, hint: string): RenderHandle | null {
  const box = document.createElement('div');
  box.className = 'pet-placeholder';
  const emoji = document.createElement('div');
  emoji.className = 'ph-emoji';
  emoji.textContent = '🐾';
  const nameEl = document.createElement('div');
  nameEl.className = 'ph-name';
  nameEl.textContent = name || 'Pet';
  const hintEl = document.createElement('div');
  hintEl.className = 'ph-hint';
  hintEl.textContent = hint;
  box.append(emoji, nameEl, hintEl);
  container.appendChild(box);
  const phase = Math.random() * Math.PI * 2;
  const handle: RenderHandle = {
    kind: 'placeholder',
    update(nowSec: number): void {
      const t = nowSec + phase;
      box.style.transform =
        `translateY(${(Math.sin(t * 0.7) * 2.2).toFixed(2)}px) scale(${(1 + Math.sin(t * 1.1) * 0.01).toFixed(4)})`;
    },
    destroy(): void {
      box.remove();
    },
  };
  return handle;
}

/* ================================================================
   3. 气泡 —— 逐字打字机
   ================================================================ */
let typeTimer: number | null = 0;
let hideTimer = 0;
/** 打字机是否正在逐字输出（区别于“气泡已显示完文字”） */
let typewriterActive = false;
/** 打字机缓冲区（支持 AI 流式增量追加：streamBuffer 只增，revealPos 追赶） */
let streamBuffer = '';
let revealPos = 0;
let streamDone = false;
let streamTTL = DEFAULT_TTL_MS;
let bubbleTone: 'info' | 'error' = 'info';

function setBubbleTone(tone: 'info' | 'error'): void {
  bubbleTone = tone;
  if (bubbleEl) bubbleEl.classList.toggle('is-error', tone === 'error');
}

function clearBubbleTimers(): void {
  if (typeTimer) window.clearTimeout(typeTimer);
  if (hideTimer) window.clearTimeout(hideTimer);
  typeTimer = 0;
  hideTimer = 0;
}
function hideBubble(): void {
  clearBubbleTimers();
  stopSpeechMouth(); // 气泡收起 → 口型立刻收回（看不到"静音还在动嘴"）
  typewriterActive = false;
  if (bubbleEl) bubbleEl.classList.remove('is-visible', 'is-typing');
}

function pumpTypewriter(): void {
  if (!bubbleTextEl) return;
  const step = TYPE_SPEED_MS;
  // 每 tick 至少推进 1 字；遇到连续空白（流式切句）可适度加速
  const chunk = streamBuffer.slice(revealPos, revealPos + 1);
  const skipBlanks = /[\s\n]/.test(chunk) ? 3 : 1;
  revealPos = Math.min(streamBuffer.length, revealPos + skipBlanks);
  bubbleTextEl.textContent = streamBuffer.slice(0, revealPos);

  if (!streamDone || revealPos < streamBuffer.length) {
    typeTimer = window.setTimeout(pumpTypewriter, step);
    return;
  }
  // 打完：移除光标，TTL 后隐藏（长回复按长度多留一会儿，方便读完）
  typewriterActive = false;
  typeTimer = 0; // 关键：本轮定时器已自然结束，必须归零；否则 feedChatDelta 里 `if (!typeTimer)` 永远为假，后续流式增量再也打不出来
  window.setTimeout(stopSpeechMouth, 320); // 说完留一拍再闭嘴（与下面 TTL 淡出衔接）
  if (bubbleEl) bubbleEl.classList.remove('is-typing');
  const scaledTtl = Math.min(30_000, Math.max(streamTTL, 3000 + streamBuffer.length * 90));
  hideTimer = window.setTimeout(hideBubble, scaledTtl);
}

/**
 * 显示气泡并逐字打印。
 * @param text  完整文本（打字机 20ms/字）
 * @param opts  ttlMs 打完后的停留毫秒；tone='error' 显示为错误气泡；
 *              immediate=true 跳过打字直接整段显示
 */
function showBubble(text: string, opts?: { ttlMs?: number; tone?: 'info' | 'error'; immediate?: boolean }): void {
  if (!bubbleEl || !bubbleTextEl) return;
  markInteraction(); // 正在说话 → 属于活跃状态，不该待在空闲降帧里
  clearBubbleTimers();
  streamBuffer = text;
  revealPos = 0;
  streamDone = true;
  streamTTL = opts?.ttlMs ?? DEFAULT_TTL_MS;
  setBubbleTone(opts?.tone ?? 'info');
  bubbleEl.classList.add('is-visible');

  if (!text) {
    hideBubble();
    return;
  }
  if (opts?.immediate) {
    bubbleTextEl.textContent = text;
    typewriterActive = false;
    bubbleEl.classList.remove('is-typing');
    hideTimer = window.setTimeout(hideBubble, streamTTL);
    return;
  }
  typewriterActive = true;
  bubbleEl.classList.add('is-typing');
  revealPos = 0;
  bubbleTextEl.textContent = '';
  startSpeechMouth(); // 说话时嘴动（走底层预留的口型参数层，模型没有嘴部参数时自动无效）
  typeTimer = window.setTimeout(pumpTypewriter, TYPE_SPEED_MS);
}

/**
 * AI 流式增量接入点：把主进程推来的 delta 追加进缓冲区并继续打字。
 * 主进程推送 delta 时追加到当前气泡。
 */
function feedChatDelta(delta: string): void {
  if (!bubbleEl || !bubbleTextEl) return;
  if (!streamBuffer || streamDone) {
    // 新一段回复：清屏重开打字
    clearBubbleTimers();
    streamBuffer = '';
    revealPos = 0;
    streamDone = false;
    streamTTL = 5000;
    typewriterActive = true;
    setBubbleTone('info');
    bubbleEl.classList.add('is-visible', 'is-typing');
    markUserRowSent(); // 已经收到回复 → 该行从"发送中"转为已送达
  } else {
    streamDone = false; // 缓冲未结束，继续等更多 delta
  }
  streamBuffer += delta;
  if (!typeTimer) typeTimer = window.setTimeout(pumpTypewriter, TYPE_SPEED_MS);
  // 同步到对话记录：正在流式输出的那一行实时增长（不逐段持久化，整段结束才写）
  // 独立聊天窗口接管对话时，这一行由它维护；桌宠窗口只在气泡里打字，避免重复落盘
  if (!chatOwnedByChatWindow) {
    if (!streamRowEl) streamRowEl = appendChatLog('pet', '', { persist: false });
    const streamText = streamRowEl?.querySelector('.chat-text');
    if (streamText) streamText.textContent = streamBuffer;
  }
  setChatTyping(false);
  chatScrollToEnd();
}

/* ================================================================
   4. 状态小字（活动窗口监控）
   ================================================================ */
let lastChatterAt = 0;
let lastChatterApp = '';
let statusTimer = 0;

function setStatus(text: string): void {
  if (!overlayEl || !overlayTextEl) return;
  if (statusTimer) {
    window.clearTimeout(statusTimer);
    statusTimer = 0;
  }
  overlayTextEl.textContent = text;
  overlayEl.classList.toggle('is-visible', Boolean(text));
}

/** 短暂显示一条状态后自动清空（不遮挡后续窗口监控状态） */
function flashStatus(text: string, ms = 1800): void {
  setStatus(text);
  if (text) statusTimer = window.setTimeout(() => setStatus(''), ms);
}

function handleWindowChange(info: WindowInfo | null): void {
  if (!info) {
    setStatus('桌面');
    return;
  }
  setStatus(`${info.app}${info.isFullscreen ? ' · 全屏' : ''} — ${info.title}`);

  // 摸鱼提示：切换应用时偶尔冒一句（防打扰：≥20s 一次且当前无气泡输出/停留）
  const now = Date.now();
  const appChanged = info.app !== lastChatterApp;
  lastChatterApp = info.app;
  if (appChanged && now - lastChatterAt > 20_000 && !typewriterActive && !hideTimer) {
    lastChatterAt = now;
    const phrase = IDLE_PHRASES[Math.floor(Math.random() * IDLE_PHRASES.length)];
    showBubble(phrase, { ttlMs: 3000 });
  }
}

/* ================================================================
   5. 模型挂载
   ================================================================ */
let currentHandle: RenderHandle | null = null;
/** 挂载代数：防止慢速异步（moc3 加载）结果覆盖后发起的挂载 */
let mountGeneration = 0;
/** 当前已加载的模型名（供“重新加载模型”无需打开设置即可回退） */
let activeModelName = '';

function destroyCurrent(): void {
  try {
    currentHandle?.destroy();
  } catch (err) {
    console.warn('[renderer] 销毁旧模型失败', err);
  }
  currentHandle = null;
  if (stageEl) stageEl.replaceChildren();
}

function libMountPortrait(url: string, name: string): RenderHandle | null {
  if (!stageEl) return null;
  const lib = getRenderLib();
  if (lib) return lib.mountPortrait({ container: stageEl, url });
  return fallbackPortrait(stageEl, url, name);
}

function libMountPlaceholder(name: string, hint: string): RenderHandle | null {
  if (!stageEl) return null;
  const lib = getRenderLib();
  if (lib) return lib.mountPlaceholder({ container: stageEl, name, hint });
  return fallbackPlaceholder(stageEl, name, hint);
}

/** 契约 ModelManifest 之外的防御性“预览图”字段扫描（主进程可能附带 png 预览） */
function findPreviewUrl(manifest: ModelManifest): string | null {
  const candidateKeys = ['preview', 'previewImage', 'portrait', 'thumbnail', 'image', 'png', 'cover'];
  for (const key of candidateKeys) {
    const v = (manifest as Any)[key];
    if (typeof v === 'string' && /^(https?:|data:|file:|blob:)/i.test(v)) return v;
  }
  return null;
}

async function mountManifest(manifest: ModelManifest): Promise<void> {
  if (!stageEl) return;
  const gen = ++mountGeneration;
  destroyCurrent();
  const name = manifest.name || '模型';
  if (manifest.name) activeModelName = manifest.name;
  // 模型级预设（pet-model.json）：情绪→表情映射 / 取景建议。缺失即 null，行为与从前一致。
  activeModelPreset = manifest.preset ?? null;
  activeModelCapabilities = manifest.preset?.capabilities ?? null;
  // 体检结果（能渲染 / 有警告 / 不能渲染）：不能渲染时直接用它的文案提示，不再硬加载
  activeModelCompat = manifest.compat ?? null;
  if (manifest.compat && manifest.compat.verdict !== 'ok') {
    console.warn('[renderer] 模型体检：', manifest.compat.verdict, manifest.compat.reason ?? '', manifest.compat.issues.join('；'));
  }
  if (manifest.presetIssues && manifest.presetIssues.length) {
    console.warn('[renderer] 模型预设有问题：', manifest.presetIssues.join('；'));
    flashStatus(`模型预设有问题（${manifest.presetIssues.length} 项），已用默认行为`);
  }
  const url = manifest.url || '';
  setStatus(`加载 ${name} …`);

  if (manifest.type === 'portrait') {
    if (url) {
      currentHandle = libMountPortrait(url, name);
      showBubble(`嗨，我是 ${name}！`, { ttlMs: 3000 });
    } else {
      currentHandle = libMountPlaceholder(name, 'portrait 模型缺少图片地址');
    }
    flashStatus(`${name} 就绪`);
    return;
  }

  if (manifest.type === 'moc3') {
    // 版本/完整性预检用主进程的体检结果（modelCompat）：文案是"原因 + 怎么办"，
    // 上限 coreMax 来自随包运行库自身的枚举（换 Core 后自动变），渲染层不再写死 4。
    const compat = manifest.compat;
    if (compat && compat.verdict === 'unsupported') {
      currentHandle = libMountPlaceholder(name, `${compat.reason ?? '这个模型加载不了'}${compat.action ? `\n${compat.action}` : ''}`);
      showBubble(`${name}：${compat.reason ?? '暂时加载不了'}`, { tone: 'info', ttlMs: 5200 });
      flashStatus(`${name}（加载不了）`);
      return;
    }
    // 兜底：没拿到体检结果时，仍按 mocVersion 自己判一次（老版本主进程也能跑）
    if (typeof manifest.mocVersion === 'number' && manifest.mocVersion > (compat?.coreMax ?? 4)) {
      currentHandle = libMountPlaceholder(
        name,
        `模型为 Cubism ${manifest.mocVersion}，当前引擎仅支持到 Cubism 4.2。请用 Cubism 4.2 导出后重新导入。`,
      );
      showBubble(`${name}：Cubism ${manifest.mocVersion} 暂不支持渲染`, { tone: 'info', ttlMs: 4200 });
      flashStatus(`${name}（版本不支持）`);
      return;
    }
    const lib = getRenderLib();
    if (lib && lib.isLive2DAvailable() && url) {
      // —— 真 moc3：PIXI 路径 ——
      const handle = await lib.mountLive2D({ container: stageEl, url });
      if (gen !== mountGeneration) {
        // 挂载期间用户/主进程已切换模型：丢弃本次结果
        try { handle?.destroy(); } catch { /* ignore */ }
        return;
      }
      if (handle) {
        currentHandle = handle;
        flashStatus(`${name} 就绪`);
        showBubble(`嗨，我是 ${name}！`, { ttlMs: 3000 });
        return;
      }
      destroyCurrent(); // mountLive2D 内部失败时可能留下空 canvas
    }
    // —— 降级路径：区分“运行时缺失”与“模型加载失败”，占位提示更可读 ——
    const fallbackReason =
      lib && !lib.isLive2DAvailable()
        ? 'Live2D 运行时缺失（pixi-live2d / Cubism Core 未加载）'
        : 'moc3 模型加载失败（详见控制台 [live2d] 日志）';
    console.warn('[renderer] moc3 不可用，已降级为占位显示。原因：', fallbackReason);
    const preview = url ? findPreviewUrl(manifest) : null;
    if (preview) {
      // moc3 模型带预览图：以静态图 + 待机动画兜底，可看性更好
      currentHandle = libMountPortrait(preview, name);
      showBubble(`${name}（moc3 暂不可用，以预览图显示）`, { tone: 'info', ttlMs: 3600 });
    } else {
      currentHandle = libMountPlaceholder(name, `当前环境无法渲染 Live2D(moc3)。${fallbackReason}`);
    }
    flashStatus(`${name} 就绪`);
    return;
  }

  // 未知 type：按“能显示就行”的底线处理
  if (url && /\.(png|jpe?g|webp|gif|svg)($|\?)/i.test(url)) {
    currentHandle = libMountPortrait(url, name);
  } else {
    currentHandle = libMountPlaceholder(name, `未知模型类型：${String(manifest.type)}`);
  }
  flashStatus(`${name} 就绪`);
}

/* ================================================================
   6. loadModel：默认模型（'' → 契约默认；失败逐名回退）
   ================================================================ */
/** 启动耗时打点（PET_BOOT_TIMING=1 时打印；用于定位"exe 启动慢"到底慢在哪一段） */
const BOOT_T0 = typeof performance !== 'undefined' ? performance.now() : 0;
function bootMark(label: string): number {
  const ms = Math.round((typeof performance !== 'undefined' ? performance.now() : 0) - BOOT_T0);
  if (bootTimingOn) console.log(`[boot] ${label} +${ms}ms`);
  return ms;
}
const bootTimingOn = (() => {
  try {
    return typeof location !== 'undefined' && /[?&]bootTiming=1/.test(location.search);
  } catch {
    return false;
  }
})();
/** 渲染层打点结果（主进程可用 executeJavaScript 取走来对比） */
const bootTimeline: Array<{ label: string; ms: number }> = [];
function bootRecord(label: string): void {
  bootTimeline.push({ label, ms: bootMark(label) });
}
try {
  (window as Any).__petBoot = { timeline: bootTimeline, t0: BOOT_T0 };
} catch {
  /* ignore */
}

async function loadDefaultModel(bridge: RendererBridge): Promise<ModelManifest | null> {
  let lastErr: Any = null;
  let candidates = [''];
  try {
    const names = await bridge.modelList();
    candidates = ['', ...names.filter((name) => typeof name === 'string' && name.trim())];
  } catch {
    // 兼容没有模型列表接口的旧 preload。
  }
  for (const name of [...new Set(candidates)]) {
    try {
      setStatus(name ? `加载 ${name} …` : '加载默认模型 …');
      const manifest = await bridge.loadModel(name);
      if (manifest && manifest.url && (manifest.type === 'moc3' || manifest.type === 'portrait')) {
        console.log(`[renderer] 模型就绪: name=${manifest.name} type=${manifest.type} url=${manifest.url}`);
        return manifest;
      }
      lastErr = new Error(`loadModel(${JSON.stringify(name)}) 返回了空/非法 manifest`);
    } catch (err) {
      lastErr = err;
      console.warn(`[renderer] loadModel(${JSON.stringify(name)}) 失败`, err);
    }
  }
  console.error('[renderer] 所有候选模型均加载失败:', lastErr);
  return null;
}

/* ================================================================
   7. 主循环（RAF：60fps 上限 + 空闲降 24fps + 隐藏暂停）
   ================================================================ */
let rafId = 0;
let lastFrameMs = 0;
let accMs = 0;
let loopRunning = false;

/** 空闲降帧：连续无交互多久之后降到 IDLE_FRAME_INTERVAL_MS */
const IDLE_AFTER_MS = 3000;
/** 空闲期的帧上限（约 24fps）。待机呼吸是 1.2Hz 级的慢正弦，24fps 足够平滑，
 *  但 GPU/CPU 占用能降到满帧的约 40%——桌宠长期挂机时这是主要收益点。 */
const IDLE_FRAME_INTERVAL_MS = 1000 / 24;
/** 最后一次"用户还在互动"的时间点（鼠标/键盘/滚轮/触摸/气泡输出都会刷新） */
let lastInteractionAt = 0;
/** 标记一次交互（空闲降帧的输入） */
function markInteraction(nowMs = performance.now()): void {
  lastInteractionAt = nowMs;
}
/**
 * 当前帧间隔：空闲超过 IDLE_AFTER_MS 就放宽到 IDLE_FRAME_INTERVAL_MS。
 * 纯函数，便于单测/静态校验（不依赖任何渲染状态）。
 */
function frameIntervalFor(nowMs: number, interactionAt: number): number {
  const idle = interactionAt > 0 && nowMs - interactionAt >= IDLE_AFTER_MS;
  return idle ? IDLE_FRAME_INTERVAL_MS : FRAME_INTERVAL_MS;
}

function frameLoop(nowMs: number): void {
  rafId = requestAnimationFrame(frameLoop);
  if (document.hidden) return; // 不可见时 RAF 通常已停，这里再保险一次

  const dt = Math.min(250, nowMs - lastFrameMs); // 防切后台时间戳跳变
  lastFrameMs = nowMs;
  accMs += dt;
  if (accMs < frameIntervalFor(nowMs, lastInteractionAt)) return; // 满帧 60fps / 空闲 24fps

  const nowSec = nowMs / 1000;
  const deltaSec = Math.min(0.1, accMs / 1000);
  accMs = 0;
  try {
    driveGaze(nowMs); // 先喂视线目标，handle.update 内做平滑插值
    currentHandle?.update?.(nowSec, deltaSec);
  } catch (err) {
    console.warn('[renderer] 帧更新失败', err);
  }
}

/** 用户交互 → 退出空闲降帧（被动监听，不拦截事件） */
function installIdleHooks(): void {
  const mark = (): void => markInteraction();
  for (const evt of ['pointermove', 'pointerdown', 'pointerup', 'wheel', 'keydown', 'touchstart']) {
    window.addEventListener(evt, mark, { passive: true });
  }
  // 切换回本窗口也算恢复互动（否则刚切回来还是 24fps，看着像卡了）
  window.addEventListener('focus', mark);
  markInteraction();
}

function startLoop(): void {
  if (loopRunning) return;
  loopRunning = true;
  lastFrameMs = performance.now();
  accMs = 0;
  rafId = requestAnimationFrame(frameLoop);
}

function stopLoop(): void {
  loopRunning = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
}

function installVisibilityHooks(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLoop();
    } else {
      startLoop();
    }
  });
}

/* ================================================================
   7.5 视线跟踪（鼠标 → handle.setGaze；平滑插值在各 handle 的
       update() 内做，不动主循环节奏）
   ================================================================ */
const GAZE_IDLE_MS = 3000;
let gazeNX = 0;          // 归一化鼠标偏移 [-1,1]，向右为正
let gazeNY = 0;          // 向上为正
let lastGazeMoveAt = 0;  // 0 = 尚未移动/已离开窗口

function updateGazeFromPointer(clientX: number, clientY: number): void {
  const cx = window.innerWidth / 2 || 0.5;
  const cy = window.innerHeight / 2 || 0.5;
  gazeNX = Math.max(-1, Math.min(1, (clientX - cx) / cx));
  gazeNY = Math.max(-1, Math.min(1, (cy - clientY) / cy)); // 屏幕下方 → 负（低头）
  lastGazeMoveAt = performance.now();
}

/** 全局鼠标（主进程轮询推送，屏幕 DIP 坐标）→ 归一化视线目标。 */
function updateGazeFromGlobal(screenX: number, screenY: number): void {
  const w = window.innerWidth || 1;
  const h = window.innerHeight || 1;
  const cx = window.screenX + w / 2; // 宠物窗口中心的屏幕坐标（DIP）
  const cy = window.screenY + h / 2;
  // 分母含 220px 软区：鼠标在窗口附近时视线按比例细腻跟动，远离则平滑趋于极限
  gazeNX = Math.max(-1, Math.min(1, (screenX - cx) / (w / 2 + 220)));
  gazeNY = Math.max(-1, Math.min(1, -(screenY - cy) / (h / 2 + 220))); // 向上为正
  lastGazeMoveAt = performance.now();
}

function installGazeTracking(): void {
  window.addEventListener('pointermove', (e) => updateGazeFromPointer(e.clientX, e.clientY), { passive: true });
  // 鼠标离开窗口：视线不再更新，主循环里走“缓缓归零”分支
  window.addEventListener('mouseleave', () => { lastGazeMoveAt = 0; });
}

/** 主循环每帧调用：鼠标静止/离开超过 GAZE_IDLE_MS 则目标归零 */
function driveGaze(nowMs: number): void {
  const h = currentHandle;
  if (!h || typeof h.setGaze !== 'function') return;
  const stale = !lastGazeMoveAt || nowMs - lastGazeMoveAt > GAZE_IDLE_MS;
  h.setGaze(stale ? 0 : gazeNX, stale ? 0 : gazeNY);
}

/* ================================================================
   7.55 追踪参数中枢 window.petTracking
   —— 底层（live2d.ts）只接受"一帧参数"，**具体设备不进渲染核**：
      摄像头骨骼追踪、外部设备、云端 ASR 口型、文本情感，全都从这里 push 进来。
   —— 这一层现在就是可用闭环：语音口型（打字机说话）+ 文本情感 → 表情；
      骨骼/表情追踪属于**预留接口**：外部脚本 registerSource 后 push 即可生效，
      没数据时零副作用（层过期自动回到鼠标跟随）。
   ================================================================ */

/** 一帧追踪输入；字段全部可选，缺什么就沿用基座值 */
interface TrackingInput {
  t?: number;
  source?: string;
  /** 头部骨骼：yaw 左右转头 / pitch 抬头低头 / roll 歪头，归一化 [-1,1] */
  head?: { yaw?: number; pitch?: number; roll?: number };
  /** 眼睛：眨眼量（0 睁 1 闭）与眼球位移 [-1,1] */
  eyes?: { blinkL?: number; blinkR?: number; eyeBallX?: number; eyeBallY?: number };
  /** 嘴：张口量 [0,1] 与口型 [-1,1] */
  mouth?: { openY?: number; form?: number };
  emotion?: { label?: string; confidence?: number };
}

/** 追踪总闸：默认开启，但没有任何 source 时行为与默认完全一致（鼠标跟随） */
let trackingEnabled = true;
/** source 注册表：记录最后活跃时间与帧数，用于设置页/状态展示"谁在驱动" */
const trackingSources = new Map<string, { lastAt: number; frames: number; note: string }>();
let lastTrackingPushAt = 0;
/** 最近一次由文本情感应用的表情（调试/状态展示用） */
let lastEmotion: { label: string; expression: string; at: number } | null = null;

/** 模型级预设（pet-model.json）：情绪→表情映射优先于内置模糊匹配 */
let activeModelPreset: ModelManifest['preset'] | null = null;
/** 当前模型自动识别的能力归类（点击触发 / 服饰道具 / 情绪表情），来自模型目录里的 pet-model.json */
let activeModelCapabilities: NonNullable<NonNullable<ModelManifest['preset']>['capabilities']> | null = null;
/** 当前模型的体检结果（主进程 modelCompat.ts 产出）：能不能渲染 / 为什么 / 怎么办 */
let activeModelCompat: ModelManifest['compat'] | null = null;

/**
 * 把模型预设里的参数映射交给当前渲染 handle（命名不标准的模型靠它对齐）。
 * 没有预设 / handle 不支持 → 什么都不做（标准 Cubism 参数名本来就是默认）。
 */
function applyPresetParameterMap(): void {
  const map = activeModelPreset?.parameterMap;
  if (!map || typeof map !== 'object') return;
  const h = currentHandle;
  if (!h || typeof h.setParameterMap !== 'function') return;
  try {
    const applied = h.setParameterMap(map);
    console.log('[renderer] 已应用模型参数映射（parameterMap）：', JSON.stringify(applied));
  } catch (err) {
    console.warn('[renderer] 参数映射应用失败（继续用标准参数名）', err);
  }
}

function trackingHandle(): RenderHandle | null {
  const h = currentHandle;
  if (!h || typeof h.applyTrackingFrame !== 'function') return null;
  return h;
}

/**
 * 推入一帧追踪数据。
 * @returns 是否真的送到了渲染层（模型未就绪 / 总闸关闭 / 无有效字段时为 false，不报错）
 */
function pushTrackingFrame(sourceId: string, frame: TrackingInput): boolean {
  const id = typeof sourceId === 'string' && sourceId ? sourceId : 'external';
  if (!trackingEnabled) return false;
  const entry = trackingSources.get(id) ?? { lastAt: 0, frames: 0, note: '' };
  entry.lastAt = performance.now();
  entry.frames += 1;
  trackingSources.set(id, entry);
  lastTrackingPushAt = entry.lastAt;
  const h = trackingHandle();
  if (!h) return false;
  // 情绪字段也走这里：有 label 就顺手切表情（模型没有对应表情时保持原样）
  if (frame && frame.emotion && typeof frame.emotion.label === 'string' && frame.emotion.label) {
    const conf = typeof frame.emotion.confidence === 'number' ? frame.emotion.confidence : 1;
    if (conf >= 0.34) h.applyEmotionLabel?.(frame.emotion.label);
  }
  h.applyTrackingFrame?.({ ...frame, source: frame?.source ?? 'external' });
  return true;
}

/** 语音口型：给"说话中"的时序用（打字机/Motion/外部 TTS 都调它） */
function pushSpeechMouth(mouth: { openY?: number; form?: number }, ttlMs = 220): void {
  trackingHandle()?.applySpeech?.(mouth, ttlMs);
}

/** 文本 → 情绪 → 表情；返回实际应用的表情名（没有对应表情/未就绪 → null） */
function applyEmotionFromText(text: string): string | null {
  if (!trackingEnabled) return null;
  const emotion = (window as Any).PetEmotion as
    | { classify?: (t: unknown) => { label?: string; confidence?: number } }
    | undefined;
  if (!emotion || typeof emotion.classify !== 'function') return null;
  const h = trackingHandle();
  if (!h || typeof h.applyEmotionLabel !== 'function') return null;
  let result: { label?: string; confidence?: number } | null = null;
  try {
    result = emotion.classify(text);
  } catch {
    return null;
  }
  if (!result || !result.label || result.label === 'neutral') return null;
  if (typeof result.confidence === 'number' && result.confidence < 0.34) return null;
  // 模型自带映射优先（pet-model.json 的 emotionMap：把情绪对到该模型真实存在的表情名）
  const mapped = activeModelPreset?.emotionMap?.[result.label];
  const applied = h.applyEmotionLabel(result.label, typeof mapped === 'string' ? mapped : undefined);
  if (applied) lastEmotion = { label: result.label, expression: applied, at: Date.now() };
  return applied;
}

/* —— 语音口型循环（打字机说话时嘴动；停止后自然回到基座）—— */
const SPEECH_TICK_MS = 90;
let speechTimer: number | null = null;
let speechPhase = 0;

function stopSpeechMouth(): void {
  if (speechTimer) {
    window.clearTimeout(speechTimer);
    speechTimer = null;
  }
}

function startSpeechMouth(): void {
  if (!trackingEnabled) return;
  if (speechTimer) return; // 已在说话：复用同一循环
  const tick = (): void => {
    speechPhase += 0.55 + Math.random() * 0.35;
    const open = 0.12 + 0.6 * (0.5 + 0.5 * Math.sin(speechPhase)) * (0.75 + Math.random() * 0.25);
    pushSpeechMouth({ openY: Math.max(0, Math.min(1, open)), form: Math.sin(speechPhase * 0.7) * 0.25 }, SPEECH_TICK_MS * 2.6);
    // 还在打字就继续；typewriterActive 由打字机维护，停下来后循环自然收尾
    if (typewriterActive || (bubbleEl && bubbleEl.classList.contains('is-typing'))) {
      speechTimer = window.setTimeout(tick, SPEECH_TICK_MS);
    } else {
      speechTimer = null;
      pushSpeechMouth({ openY: 0 }, 260); // 收口
    }
  };
  speechTimer = window.setTimeout(tick, SPEECH_TICK_MS);
}

/** 暴露给页面/外部脚本（设置页"底层追踪预留"、将来接摄像头脚本的唯一入口） */
function installTrackingHub(): void {
  const api = {
    /** 声明一个数据源（例如 'webcam'、'external-os'）；仅用于状态展示 */
    registerSource(id: string, note = ''): boolean {
      if (!id) return false;
      const cur = trackingSources.get(id) ?? { lastAt: performance.now(), frames: 0, note: '' };
      cur.note = note;
      trackingSources.set(id, cur);
      return true;
    },
    unregisterSource(id: string): boolean {
      trackingSources.delete(id);
      return true;
    },
    /** 推入一帧（骨骼/眼/嘴/情绪） */
    push: pushTrackingFrame,
    /** 语音口型 */
    speech: pushSpeechMouth,
    /** 文本情感 → 表情，返回应用到的表情名 */
    emotion: applyEmotionFromText,
    /** 总闸：false = 忽略一切外部帧，回到纯鼠标跟随 */
    setEnabled(on: boolean): boolean {
      trackingEnabled = on !== false;
      if (!trackingEnabled) {
        stopSpeechMouth();
        trackingHandle()?.clearTrackingLayer?.();
      }
      return trackingEnabled;
    },
    enabled: (): boolean => trackingEnabled,
    clear(): void {
      stopSpeechMouth();
      trackingHandle()?.clearTrackingLayer?.();
    },
    /** 状态快照（设置页/控制台用）：谁在驱动、多久没来数据、最近情绪 */
    state(): {
      enabled: boolean;
      driver: string | null;
      sources: Array<{ id: string; note: string; frames: number; agoMs: number; active: boolean }>;
      handle: { sources: string[]; lastSource: string; lastFrameAgoMs: number | null } | null;
      lastEmotion: { label: string; expression: string; agoMs: number } | null;
      speaking: boolean;
    } {
      const now = performance.now();
      const sources = [...trackingSources.entries()].map(([id, v]) => ({
        id,
        note: v.note,
        frames: v.frames,
        agoMs: Math.round(now - v.lastAt),
        active: now - v.lastAt < 1200,
      }));
      const active = sources.filter((s) => s.active).sort((a, b) => a.agoMs - b.agoMs);
      return {
        enabled: trackingEnabled,
        driver: active.length ? active[0].id : null,
        sources,
        handle: trackingHandle()?.trackingStatus?.() ?? null,
        lastEmotion: lastEmotion
          ? { label: lastEmotion.label, expression: lastEmotion.expression, agoMs: Date.now() - lastEmotion.at }
          : null,
        speaking: speechTimer !== null,
      };
    },
  };
  (window as Any).petTracking = api;
  currentTrackingApi = api;
}

/** 留给 __petDebug 与测试引用（window.petTracking 可能被外部脚本覆盖） */
let currentTrackingApi: Any = null;

/* ================================================================
  7.6 拖拽移动窗口 + 滚轮缩放
   ================================================================ */
const DRAG_IGNORE_SELECTOR = '#context-menu, #todo-panel, #ask-box, #think-panel, #settings-panel, #chatbar input, .chat-input, input, button, select, textarea';

/* ================================================================
   7.7 点击特效：粉色星星小范围扩散（不挡视野、初始半透明、与主题统一）
   ================================================================ */
let lastSparkleAt = 0;
const SPARKLE_COOLDOWN_MS = 120;
const SPARKLE_GLYPHS = ['★', '✦', '✧', '✩'];

function ensureFxLayer(): HTMLElement {
  let layer = document.getElementById('fx-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'fx-layer';
    layer.className = 'fx-layer';
    layer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(layer);
  }
  return layer;
}

/** 在 (x,y) 生成一小簇粉色星星（外加一圈极淡光晕），动画结束自动清理 */
function spawnClickSparkles(x: number, y: number): void {
  const now = Date.now();
  if (now - lastSparkleAt < SPARKLE_COOLDOWN_MS) return;
  lastSparkleAt = now;
  const layer = ensureFxLayer();
  if (layer.childElementCount > 80) return; // 极端情况防堆积

  // 光晕：极淡、快速淡出，仅增加设计感
  const halo = document.createElement('div');
  halo.className = 'sparkle-halo';
  halo.style.left = `${x}px`;
  halo.style.top = `${y}px`;
  layer.appendChild(halo);
  window.setTimeout(() => halo.remove(), 360);

  const count = 8 + Math.floor(Math.random() * 7); // 8~14 颗
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = 22 + Math.random() * 42; // 22~64px（整体 ≤70px，小范围不挡视野）
    const size = 7 + Math.random() * 7; // 7~14px
    const duration = 520 + Math.random() * 320;
    const delay = Math.random() * 90;
    // 粉色为主，少量冷色星呼应主题蓝
    const palette = ['#ffd6ea', '#ff9fd0', '#ff7fc0', '#9ecbff'];
    const color = palette[Math.floor(Math.random() * palette.length)];

    const star = document.createElement('span');
    star.className = 'sparkle';
    star.textContent = SPARKLE_GLYPHS[Math.floor(Math.random() * SPARKLE_GLYPHS.length)];
    star.style.left = `${x}px`;
    star.style.top = `${y}px`;
    star.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    star.style.setProperty('--dy', `${Math.sin(angle) * distance}px`);
    star.style.setProperty('--size', `${size}px`);
    star.style.setProperty('--color', color);
    star.style.setProperty('--rot', `${(Math.random() * 50 - 25).toFixed(1)}deg`);
    star.style.setProperty('--dur', `${duration}ms`);
    star.style.setProperty('--delay', `${delay}ms`);
    layer.appendChild(star);
    star.addEventListener('animationend', () => star.remove());
    window.setTimeout(() => star.remove(), duration + delay + 60);
  }
}

/** 把角色在窗口里的实际可见范围报给主进程（气泡窗据此贴到角色头顶上方） */
function reportPetBounds(bridge: RendererBridge | null): void {
  if (!bridge || typeof bridge.reportPetBounds !== 'function' || CHAT_PANEL_MODE || THINK_PANEL_MODE) return;
  try {
    const b = currentHandle?.bounds?.();
    if (!b || !Number.isFinite(b.top)) return;
    bridge.reportPetBounds({ top: Math.round(b.top), height: Math.round(b.height) });
  } catch {
    /* 量不到就算了：主进程用默认值 */
  }
}

/**
 * 滚轮缩放时连续上报角色范围。
 * 这里**不能防抖**（防抖会让气泡在缩放过程中卡住不动 → 手感"不跟手"），
 * 改成按帧合并：同一帧里滚多少格都只上报一次，于是气泡逐帧平滑跟随。
 */
let petBoundsFrame = 0;
function reportPetBoundsSoon(bridge: RendererBridge | null): void {
  if (petBoundsFrame) return; // 本帧已排过一次
  petBoundsFrame = window.requestAnimationFrame(() => {
    petBoundsFrame = 0;
    reportPetBounds(bridge);
  });
}

function installWindowInteractions(bridge: RendererBridge): void {
  // —— 滚轮缩放：档位 ±1（1.08^n），preventDefault 防页面/隐式滚动；拖拽期间忽略 ——
  let dragging = false;
  let moved = false; // 本次按下是否已超过 3px（用于区分"点击"与"拖拽"）
  let dragFrame = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (dragging) return; // 拖拽过程中无视滚轮，避免误放大
      if ((e.target as Element)?.closest?.('#todo-panel, #ask-box, #think-panel, #settings-panel, #context-menu, #chatbar')) return; // 面板区滚动不缩放
      if (!currentHandle || typeof currentHandle.zoom !== 'function') return;
      e.preventDefault();
      currentHandle.zoom(e.deltaY < 0 ? 1 : -1);
      reportPetBoundsSoon(bridge); // 缩放后角色范围变了：防抖后让气泡窗重新贴到头顶上方
    },
    { passive: false },
  );

  // —— 左键按住拖拽：按增量移动窗口 ——
  let lastDragX = 0;
  let lastDragY = 0;
  const flushDrag = (): void => {
    dragFrame = 0;
    if (!dragging || (!pendingDx && !pendingDy)) return;
    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;
    bridge.moveWindow(dx, dy);
  };
  const endDrag = (): void => {
    if (!dragging) return;
    if (dragFrame) {
      window.cancelAnimationFrame(dragFrame);
      dragFrame = 0;
    }
    flushDrag();
    dragging = false;
    pendingDx = 0;
    pendingDy = 0;
    bridge.endWindowDrag();
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t && t.closest && t.closest(DRAG_IGNORE_SELECTOR)) return; // 输入/菜单/设置区不拖
    dragging = true;
    moved = false;
    lastDragX = e.screenX;
    lastDragY = e.screenY;
    lastGazeMoveAt = 0; // 拖拽期间暂停视线跟随
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastDragX;
    const dy = e.screenY - lastDragY;
    // 3px 阈值：微动视为点击；超过才按增量连续移动
    if (Math.abs(dx) + Math.abs(dy) >= 3) {
      moved = true;
      pendingDx += dx;
      pendingDy += dy;
      if (!dragFrame) dragFrame = window.requestAnimationFrame(flushDrag);
      lastDragX = e.screenX;
      lastDragY = e.screenY;
    }
  });
  window.addEventListener('pointerup', (e) => {
    const wasDragging = dragging;
    const hasMoved = moved;
    endDrag();
    // 单击（未拖动）且不在 UI 区域 → 触发「点一下」表情 + 粉色星星特效
    if (!wasDragging || hasMoved) return;
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t && t.closest && t.closest(DRAG_IGNORE_SELECTOR)) return;
    triggerPetTap(e.clientX, e.clientY);
  });
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);
}

/* ================================================================
   7.8 点击模型 → 播放「点一下」表情（白子专属）+ 星星特效 + 轻灵音效
   ================================================================ */
let tapExpressionResetTimer = 0;
let activeTapExpression = ''; // 当前由点击触发且在保持中的表情名
const TAP_EXPRESSION_HOLD_MS = 1600; // 表情保持时长，之后恢复默认

/** 取消「点击表情的自动恢复」：右键菜单显式选表情时调用，避免菜单效果被 1.6s 计时器重置 */
function cancelTapExpressionReset(): void {
  if (tapExpressionResetTimer) {
    window.clearTimeout(tapExpressionResetTimer);
    tapExpressionResetTimer = 0;
  }
}

// —— 点击音效：Web Audio 现场合成（不引入音频文件，离线可用）——
let sfxCtx: AudioContext | null = null;
let sfxEnabled = true;
let sfxVolumeLevel = 0.6;
let sfxLastAt = 0;
const SFX_MIN_GAP_MS = 70; // 狂点时不叠加成一串噪音

/** 应用设置里的音效开关/音量（打开设置与保存设置时调用；同时刷新滑杆与百分比显示） */
function applySfxSettings(settings: AppSettings): void {
  sfxEnabled = settings.sfxEnabled !== false; // 默认开启
  const raw = typeof settings.sfxVolume === 'number' ? settings.sfxVolume : 0.6;
  sfxVolumeLevel = Math.max(0, Math.min(1, raw));
  const slider = elementById<HTMLInputElement>('setting-sfx-volume');
  if (slider) slider.value = String(sfxVolumeLevel);
  const display = elementById<HTMLElement>('sfx-volume-display');
  if (display) display.textContent = `${Math.round(sfxVolumeLevel * 100)}%`;
}

/**
 * 一声「轻灵」的点击音：E6 + B6 两个正弦泛音，8ms 起音 + 指数衰减，第二声略微延后。
 * 音量整体压得很低（主增益 ≈ 音量 × 0.09），不刺耳、不抢注意力。
 */
function playTapChime(): void {
  if (!sfxEnabled || sfxVolumeLevel <= 0) return;
  const now = performance.now();
  if (now - sfxLastAt < SFX_MIN_GAP_MS) return;
  sfxLastAt = now;
  try {
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? ((window as Any).webkitAudioContext as typeof AudioContext | undefined);
    if (!Ctor) return; // 环境不支持 Web Audio：静默降级
    if (!sfxCtx) sfxCtx = new Ctor();
    const ctx = sfxCtx;
    if (ctx.state === 'suspended') void ctx.resume();
    const t0 = ctx.currentTime + 0.001;
    const master = ctx.createGain();
    master.gain.value = Math.max(0.02, sfxVolumeLevel) * 0.09;
    master.connect(ctx.destination);
    const partials: Array<[number, number, number]> = [
      [1318.5, 0, 0.32], // E6
      [1975.5, 0.055, 0.28], // B6，稍晚一点像两声轻响
    ];
    for (const [freq, delay, dur] of partials) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0 + delay);
      env.gain.setValueAtTime(0.0001, t0 + delay);
      env.gain.exponentialRampToValueAtTime(1, t0 + delay + 0.008);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + dur);
      osc.connect(env);
      env.connect(master);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + dur + 0.02);
      osc.onended = () => {
        try {
          env.disconnect();
          osc.disconnect();
        } catch {
          /* ignore */
        }
      };
    }
  } catch {
    /* 音效失败绝不影响点击体验 */
  }
}

/** 日常点击模型：触发「点一下」（若模型有该表情）并播放星星特效与音效 */
function triggerPetTap(x: number, y: number): void {
  playTapChime(); // 轻灵音效（可在设置里关闭/调音量）
  spawnClickSparkles(x, y); // 星星特效（所有模型都有）
  const h = currentHandle;
  if (!h || typeof h.setExpression !== 'function') return;
  let tapName = '点一下';
  if (typeof h.listExpressions === 'function') {
    const names = h.listExpressions();
    // 优先用能力归类里认定过的点击表情/动作（pet-model.json capabilities.click），
    // 其次精确名「点一下」，再其次模糊匹配（戳/poke/tap…）；都没有就不触发（不硬套表情）。
    const classified = (activeModelCapabilities?.click ?? []).find((n) => names.includes(n));
    tapName = classified ?? names.find((n) => n === '点一下') ?? names.find((n) => /点一下|戳|poke|tap/i.test(n)) ?? '';
    if (!tapName) return;
  }
  cancelTapExpressionReset();
  try {
    if (activeTapExpression === tapName) {
      // 已经是该表情：先清空再重设，保证每次点击都「重播」一次，而不是毫无变化
      h.setExpression(null);
      window.setTimeout(() => {
        try {
          currentHandle?.setExpression?.(tapName);
        } catch {
          /* ignore */
        }
      }, 60);
    } else {
      h.setExpression(tapName);
    }
    activeTapExpression = tapName;
  } catch {
    /* 表情失败不影响点击体验 */
  }
  tapExpressionResetTimer = window.setTimeout(() => {
    tapExpressionResetTimer = 0;
    activeTapExpression = '';
    try {
      currentHandle?.setExpression?.(null); // 恢复默认表情，避免永久停在该表情
    } catch {
      /* ignore */
    }
  }, TAP_EXPRESSION_HOLD_MS);
}

/* ================================================================
   8. Electron bridge 接线
   ================================================================ */
/** 聊天记录用的 bridge（在 init 里赋值；appendChatLog 需要它做持久化） */
let chatBridge: RendererBridge | null = null;
/** 对话记录容器与"正在流式的那一行"/"正在输入提示行" */
let chatLogEl: HTMLElement | null = null;
let chatHistoryEl: HTMLElement | null = null;
let streamRowEl: HTMLElement | null = null;
let typingRowEl: HTMLElement | null = null;
/** 本轮“你：”那一行，用于标记发送状态。 */
let pendingUserRow: HTMLElement | null = null;
let chatToolbarTimer = 0;
const CHAT_LOG_MAX_ROWS = 200;
/** 正在查看的历史会话 id（空=当前会话）；查看历史时禁止发送 */
let chatViewingSessionId = '';
/** 历史会话摘要（新→旧） */
let chatSessions: Array<{ id: string; startedAt: number; title: string; count: number }> = [];
/**
 * 对话是否已交给独立聊天窗口（?panel=chat 那个窗口）。
 * 两个窗口都会收到同一份 AI 推送：一旦独立窗口接管，
 * 桌宠窗口只留气泡，不再往对话记录/落盘里写，否则同一条回复会被持久化两次。
 */
let chatOwnedByChatWindow = false;

function chatScrollToEnd(): void {
  if (chatLogEl) chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

/**
 * 往对话记录里追加一行。
 * role: user=主人 / pet=桌宠 / tool=工具步骤 / error=错误。默认会持久化到主进程（tool 行不落盘）。
 */
function appendChatLog(
  role: 'user' | 'pet' | 'tool' | 'error',
  text: string,
  opts?: { persist?: boolean; at?: number },
): HTMLElement | null {
  if (!chatLogEl) return null;
  const row = document.createElement('div');
  row.className = `chat-row is-${role}`;
  const labelText = role === 'user' ? '你' : role === 'pet' ? 'Pet' : '';
  if (labelText) {
    const label = document.createElement('span');
    label.className = 'chat-label';
    label.textContent = labelText;
    row.appendChild(label);
  }
  const body = document.createElement('span');
  body.className = 'chat-text';
  body.textContent = role === 'tool' ? `🔧 ${text}` : role === 'error' ? `⚠️ ${text}` : text;
  row.appendChild(body);
  chatLogEl.appendChild(row);
  while (chatLogEl.childElementCount > CHAT_LOG_MAX_ROWS) {
    const first = chatLogEl.firstElementChild;
    if (!first) break;
    chatLogEl.removeChild(first);
  }
  chatScrollToEnd();
  if (opts?.persist !== false) {
    void chatBridge?.chatLogAppend?.({ role, text, at: opts?.at ?? Date.now() }).catch(() => undefined);
  }
  return row;
}

/** 启动时把历史记录渲染出来（不再回写，避免重复） */
async function loadChatLog(bridge: RendererBridge): Promise<void> {
  if (!chatLogEl || typeof bridge.chatLogGet !== 'function') return;
  try {
    const snap = await bridge.chatLogGet();
    const entries = Array.isArray(snap?.entries) ? snap.entries : [];
    chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : [];
    chatViewingSessionId = '';
    chatLogEl.replaceChildren();
    streamRowEl = null;
    if (entries.length === 0) {
      appendChatLog('tool', '说点什么开始对话吧（右键桌宠可以唤起我）', { persist: false });
      return;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.text !== 'string') continue;
      appendChatLog(entry.role, entry.text, { persist: false, at: entry.at });
    }
    chatScrollToEnd();
  } catch (err) {
    console.warn('[renderer] 读取聊天记录失败', err);
  }
}

/* ---- 行状态：sending / sent / failed ----
   失败的行走"点一下把原文回到输入框"，不自动重发：误发比多点一次更贵。 */
function markUserRowSending(row: HTMLElement | null): void {
  if (!row) return;
  row.classList.remove('is-failed');
  row.classList.add('is-sending');
}

function markUserRowSent(row: HTMLElement | null = pendingUserRow): void {
  if (!row) return;
  row.classList.remove('is-sending', 'is-failed');
}

function markUserRowFailed(row: HTMLElement | null, reason?: string): void {
  if (!row) return;
  row.classList.remove('is-sending');
  row.classList.add('is-failed');
  row.title = reason ? `${reason}（点这一行可重填输入框）` : '发送失败（点这一行可重填输入框）';
}

/** 点失败行 → 原文回到输入框（不自动发送） */
function installChatRowRetry(): void {
  chatLogEl?.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement | null)?.closest?.('.chat-row.is-failed') as HTMLElement | null;
    if (!row) return;
    const text = row.querySelector('.chat-text')?.textContent ?? '';
    const input = elementById<HTMLInputElement>('chat-input');
    if (!input) return;
    input.value = text.trim();
    input.classList.remove('is-prefilled');
    void input.offsetWidth; // 强制重排，让下面的动画能重复触发
    input.classList.add('is-prefilled');
    try { input.focus(); } catch { /* ignore */ }
    setChatToolbarStatus('已把这条失败消息填回输入框，确认后点「发送」');
  });
}

/** 设置工具条右侧的小状态文字（自动淡出；「返回当前」这类按钮不会被淡出清掉） */function setChatToolbarStatus(text: string, isError = false): void {
  const el = elementById<HTMLElement>('chat-toolbar-status');
  if (!el) return;
  el.classList.toggle('is-error', isError);
  // 只清掉上一次的状态文字（带 data-status-msg 标记的空格），保留按钮等固定控件
  for (const old of Array.from(el.querySelectorAll('[data-status-msg]'))) old.remove();
  if (text) {
    const span = document.createElement('span');
    span.dataset.statusMsg = '1';
    span.textContent = text;
    el.appendChild(span);
  }
  if (chatToolbarTimer) window.clearTimeout(chatToolbarTimer);
  chatToolbarTimer = 0;
  if (text) {
    chatToolbarTimer = window.setTimeout(() => {
      chatToolbarTimer = 0;
      for (const old of Array.from(el.querySelectorAll('[data-status-msg]'))) old.remove();
    }, 2600);
  }
}

/** 渲染历史会话列表（点击查看） */
function renderChatHistoryList(): void {
  if (!chatHistoryEl) return;
  chatHistoryEl.replaceChildren();
  if (chatSessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'chat-history-empty';
    empty.textContent = '还没有历史对话';
    chatHistoryEl.appendChild(empty);
  }
  for (const session of chatSessions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `chat-history-item${session.id === chatViewingSessionId ? ' is-current' : ''}`;
    const title = document.createElement('span');
    title.className = 'chat-history-title';
    title.textContent = session.title || '新对话';
    const meta = document.createElement('span');
    meta.className = 'chat-history-meta';
    const d = new Date(session.startedAt);
    const pad = (n: number): string => String(n).padStart(2, '0');
    meta.textContent = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} · ${session.count} 条`;
    btn.appendChild(title);
    btn.appendChild(meta);
    btn.addEventListener('click', () => void openChatSession(session.id, chatBridge));
    chatHistoryEl.appendChild(btn);
  }
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'chat-history-clear';
  clear.textContent = '清空全部历史';
  clear.addEventListener('click', () => {
    if (!window.confirm('确定清空全部历史对话吗？此操作不可撤销。')) return;
    void (async () => {
      try {
        await chatBridge?.chatHistoryClear?.();
        await loadChatLog(chatBridge as RendererBridge);
        renderChatHistoryList();
        setChatToolbarStatus('历史已清空');
      } catch (err) {
        setChatToolbarStatus(`清空失败：${(err as Error).message ?? String(err)}`, true);
      }
    })();
  });
  chatHistoryEl.appendChild(clear);
}

/** 查看某段历史对话（只读） */
async function openChatSession(id: string, bridge: RendererBridge | null): Promise<void> {
  if (!bridge || !chatLogEl) return;
  try {
    const snap = await bridge.chatSessionSelect?.(id);
    const entries = Array.isArray(snap?.entries) ? snap.entries : [];
    chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : chatSessions;
    chatLogEl.replaceChildren();
    streamRowEl = null;
    chatViewingSessionId = id;
    for (const entry of entries) {
      if (!entry || typeof entry.text !== 'string') continue;
      appendChatLog(entry.role, entry.text, { persist: false, at: entry.at });
    }
    if (entries.length === 0) appendChatLog('tool', '（这段对话没有内容）', { persist: false });
    chatScrollToEnd();
    renderChatHistoryList();
    if (chatHistoryEl) chatHistoryEl.hidden = true;
    // 只读提示 + 返回当前按钮
    setChatToolbarStatus('正在查看历史对话（只读）');
    const status = elementById<HTMLElement>('chat-toolbar-status');
    if (status) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'chat-tool';
      back.textContent = '返回当前';
      back.addEventListener('click', () => {
        void (async () => {
          await loadChatLog(bridge);
          setChatToolbarStatus('已回到当前对话');
        })();
      });
      status.appendChild(back);
    }
    const input = elementById<HTMLInputElement>('chat-input');
    if (input) input.disabled = true;
  } catch (err) {
    setChatToolbarStatus(`打开历史失败：${(err as Error).message ?? String(err)}`, true);
  }
}

/** 新对话：清空 AI 上下文 + 新建会话（记录里开一段新的） */
async function startNewChat(bridge: RendererBridge): Promise<void> {
  try {
    const reset = await bridge.chatContextReset?.();
    const snap = await bridge.chatSessionNew?.();
    if (chatLogEl) {
      chatLogEl.replaceChildren();
      streamRowEl = null;
      appendChatLog('tool', '新对话已开始（AI 上下文已清空），说点什么吧', { persist: false });
    }
    chatViewingSessionId = '';
    chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : chatSessions;
    renderChatHistoryList();
    if (chatHistoryEl) chatHistoryEl.hidden = true;
    const input = elementById<HTMLInputElement>('chat-input');
    if (input) {
      input.disabled = false;
      input.focus();
    }
    setChatToolbarStatus(reset?.ok === false ? '已开新对话（上下文清空失败，可继续聊）' : '已开始新对话', reset?.ok === false);
    chatScrollToEnd();
  } catch (err) {
    setChatToolbarStatus(`新对话失败：${(err as Error).message ?? String(err)}`, true);
  }
}

/** 收起 ＋ 菜单 */
function closeChatMenu(): void {
  const menu = elementById<HTMLElement>('chat-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  elementById<HTMLButtonElement>('chat-plus')?.setAttribute('aria-expanded', 'false');
}

/** 工具条接线：左侧 ＋ 菜单（新对话 / 历史 / 思考浮窗 / 收起）+ 右侧 × */
function installChatToolbar(bridge: RendererBridge): void {
  const plus = elementById<HTMLButtonElement>('chat-plus');
  const menu = elementById<HTMLElement>('chat-menu');
  plus?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    plus.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) void refreshChatSessions(bridge);
  });
  menu?.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest('button')?.getAttribute('data-chat-menu');
    if (!item) return;
    closeChatMenu();
    if (item === 'new') void startNewChat(bridge);
    else if (item === 'history') void toggleHistoryList(bridge);
    else if (item === 'think') void toggleThinkWindow(bridge);
    else if (item === 'collapse') void collapseChatSurface(bridge);
  });
  // 点菜单外面任意处：只收菜单（不改动气泡窗本身）
  document.addEventListener('click', (event) => {
    if ((event.target as HTMLElement)?.closest?.('#chat-menu, #chat-plus')) return;
    closeChatMenu();
  });
  elementById<HTMLButtonElement>('chat-close')?.addEventListener('click', () => {
    void collapseChatSurface(bridge);
  });
}

/** 拉一次会话摘要（打开 ＋ 菜单时刷新历史列表用） */
async function refreshChatSessions(bridge: RendererBridge): Promise<void> {
  try {
    const snap = await bridge.chatLogGet?.();
    chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : chatSessions;
  } catch {
    /* 用已有列表兜底 */
  }
}

/** "Pet 正在回复"提示：发送后立刻显示，收到第一个分片/结束/出错时移除 */
function setChatTyping(on: boolean): void {
  const sendBtn = elementById<HTMLButtonElement>('chat-send');
  const input = elementById<HTMLInputElement>('chat-input');
  // 按钮文字始终保持「发送」：改成「…」会让人误以为是"更多"按钮（气泡窗很小时尤其明显）。
  // 回复中只做禁用 + 变暗，状态由输入框占位文字表达。
  if (sendBtn) {
    sendBtn.disabled = on;
    sendBtn.classList.toggle('is-busy', on);
  }
  if (input) input.placeholder = on ? 'Pet 正在回复…' : '和 Pet 说点什么…';
  if (!chatLogEl) return;
  if (!on) {
    if (typingRowEl?.parentElement) typingRowEl.remove();
    return;
  }
  if (!typingRowEl) {
    typingRowEl = document.createElement('div');
    typingRowEl.className = 'chat-row is-typing';
    const body = document.createElement('span');
    body.className = 'chat-text';
    body.textContent = 'Pet 正在回复'; // 三个点由 CSS 动画补（chat-dots），不用静态省略号
    typingRowEl.appendChild(body);
  }
  chatLogEl.appendChild(typingRowEl); // 始终贴在最后一行
  chatScrollToEnd();
}

function getBridge(): RendererBridge | null {
  const api = (window as Any).electron;
  return api && typeof api.loadModel === 'function' ? (api as RendererBridge) : null;
}

async function waitForElectron(timeoutMs = 5000): Promise<RendererBridge | null> {
  const start = performance.now();
  while (performance.now() - start < timeoutMs) {
    const b = getBridge();
    if (b) return b;
    await new Promise<void>((r) => window.setTimeout(r, 60));
  }
  return null;
}

/** 连接主进程推送；缺少某个可选入口时跳过该功能。 */
function subscribeOptionalPushes(bridge: RendererBridge): void {
  if (typeof bridge.onBubble === 'function') {
    bridge.onBubble((payload) => {
      if (payload && typeof payload.text === 'string') {
        showBubble(payload.text, { ttlMs: payload.ttlMs });
      }
      return;
    });
  }
  if (typeof bridge.onChat === 'function') {
    bridge.onChat((payload) => {
      if (payload && typeof payload.delta === 'string') {
        feedChatDelta(payload.delta);
      } else if (payload && typeof payload.full === 'string') {
        showBubble(payload.full, { immediate: true });
        // 文本情感 → 表情（emotion.js 规则判定；模型没有对应表情就保持原样）
        applyEmotionFromText(payload.full);
        // 对话记录：整段结束才落盘（流式过程中那一行不逐段持久化）。
        // 独立聊天窗口接管时由它落盘，这里跳过，否则同一条回复会被写两次。
        if (!chatOwnedByChatWindow) {
          if (!streamRowEl) streamRowEl = appendChatLog('pet', '', { persist: false });
          const streamText = streamRowEl?.querySelector('.chat-text');
          if (streamText) streamText.textContent = payload.full;
          streamRowEl = null;
          void bridge.chatLogAppend?.({ role: 'pet', text: payload.full, at: Date.now() }).catch(() => undefined);
        }
        setChatTyping(false);
        chatScrollToEnd();
      } else if (payload && typeof payload.message === 'string') {
        // AI 调用错误：以错误气泡提示，不清空正在进行的流
        showBubble(`⚠️ ${payload.message}`, { tone: 'error', immediate: true });
        if (!chatOwnedByChatWindow) appendChatLog('error', payload.message);
        setChatTyping(false);
        streamDone = true;
        if (typeTimer) {
          window.clearTimeout(typeTimer);
          typeTimer = null;
        }
      }
      return;
    });
  }
  if (typeof bridge.onAction === 'function') {
    bridge.onAction((action) => {
      const type = action && action.type;
      if (type === 'speak') {
        const text = action.payload && action.payload.text;
        if (typeof text === 'string') showBubble(text);
      } else if (type === 'emotion') {
        // 主进程/外部脚本可直接推情绪标签（与文本判定共用同一条表情通道）
        const label = action.payload && typeof action.payload.label === 'string' ? action.payload.label : '';
        if (label) currentHandle?.applyEmotionLabel?.(label);
      } else if (type === 'tracking') {
        // 外部追踪一帧（骨骼/眼/嘴）：主进程转发，底层按存在的参数降级驱动
        const frame = action.payload && typeof action.payload === 'object' ? (action.payload as TrackingInput) : null;
        if (frame) pushTrackingFrame(typeof frame.source === 'string' && frame.source ? frame.source : 'external', frame);
      } else if (type === 'open-settings') {
        openSettings(bridge);
      } else if (type === 'framing') {
        // 托盘菜单改取景：主进程已写好设置，这里只负责让画面立刻生效
        const mode = action.payload && action.payload.mode === 'half' ? 'half' : 'full';
        applyFraming(mode);
      } else if (type === 'motion') {
        const group = action.payload && typeof action.payload.group === 'string' ? action.payload.group : '';
        if (group && currentHandle?.playMotion) currentHandle.playMotion(group);
      } else if (type === 'expression') {
        const name = action.payload && typeof action.payload.name === 'string' ? action.payload.name : '';
        if (currentHandle?.setExpression) currentHandle.setExpression(name || null);
      }
      return;
    });
  }
  // 全局鼠标坐标推送（主进程轮询）→ 宠物视线自动跟随（含鼠标不在宠物窗口内时）
  if (typeof bridge.onGlobalCursor === 'function') {
    bridge.onGlobalCursor((pos) => {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        updateGazeFromGlobal(pos.x, pos.y);
      }
    });
  }
  // 独立聊天窗口开/关：开着时桌宠窗口收起自己的输入条与思考浮窗（对话已在另一个窗口里进行）
  if (typeof bridge.onChatWindowState === 'function') {
    bridge.onChatWindowState((payload) => {
      chatOwnedByChatWindow = Boolean(payload && payload.open);
      if (chatOwnedByChatWindow) hideChatBar();
    });
  }
}

/* ================================================================
   9.5 拖放加入资产（把模型 / 插件文件夹拖到桌宠身上）
   ================================================================ */

/**
 * 拖放两个必须处理的前提：
 *   1. 必须全局阻止默认行为，否则拖入文件会让整个窗口导航去打开那个文件（桌宠直接白屏）；
 *   2. Electron 31+ 起渲染层拿不到 `File.path`，只能经 preload 的 `pathForFile()`
 *      （内部是 webUtils.getPathForFile）换绝对路径。
 * 主进程按目录内容自行判断是模型还是插件，所以这里不需要用户先分类。
 */
function installDropTarget(bridge: RendererBridge): void {
  // 全局拦截：任何地方都别让浏览器把文件当成导航目标
  for (const evt of ['dragover', 'drop'] as const) {
    document.addEventListener(evt, (e) => e.preventDefault());
  }
  const canImport = typeof bridge.assetImportPath === 'function' && typeof bridge.pathForFile === 'function';
  const stage = elementById<HTMLElement>('stage');
  const target: HTMLElement = stage ?? document.body;
  // 拖入时给一点视觉反馈（没有 bridge 能力时不提示，免得空欢喜）
  target.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (canImport) document.body.classList.add('is-dragover');
  });
  target.addEventListener('dragleave', (e) => {
    // 只有真正离开舞台才收起高亮（在子元素间移动也会触发 dragleave）
    if (e.target === target) document.body.classList.remove('is-dragover');
  });
  target.addEventListener('drop', (e) => {
    void (async () => {
      e.preventDefault();
      document.body.classList.remove('is-dragover');
      if (!canImport) {
        showBubble('当前版本不支持拖放加入，请用设置里的「＋ 添加模型 / 插件…」', { tone: 'error', ttlMs: 5000 });
        return;
      }
      const dt = e.dataTransfer;
      const files = dt ? Array.from(dt.files) : [];
      if (!files.length) {
        showBubble('没有识别到文件。请拖入模型或插件的**文件夹**。', { tone: 'error', ttlMs: 5000 });
        return;
      }
      flashStatus('正在加入…');
      let okCount = 0;
      const problems: string[] = [];
      for (const file of files) {
        const p = bridge.pathForFile?.(file) ?? '';
        if (!p) {
          problems.push(`${file.name}：取不到本地路径（需从资源管理器拖入，而不是浏览器内拖拽）`);
          continue;
        }
        const res = await bridge.assetImportPath?.(p, 'auto');
        if (!res) continue;
        if (res.ok) {
          okCount++;
          if (res.issues && res.issues.length) problems.push(`${res.name}：${res.issues.length} 条提示`);
        } else {
          problems.push(res.error ?? '未知原因');
        }
      }
      if (okCount) {
        const tail = problems.length ? `（${problems[0]}）` : '';
        showBubble(`已加入 ${okCount} 个资产${tail}`, { ttlMs: 4000 });
        flashStatus(`已加入 ${okCount} 个资产`);
      } else {
        showBubble(`加入失败：${problems[0] ?? '未知原因'}`, { tone: 'error', ttlMs: 6000 });
        flashStatus('加入失败');
      }
      // 面板与下拉框同步（用户多半正开着设置页）
      void refreshAssetPanel(bridge);
      void refreshModelOptions(bridge);
    })();
  });
}

/**
 * 点击穿透的命中判定（渲染层这一侧）。
 *
 * 语义（**注意方向**：这里传的是 main 侧 `setIgnoreMouseEvents` 的 ignore 标志）：
 *   reportHitResult(false) = 光标在角色身上 → **不**忽略鼠标 → 正常收点击
 *   reportHitResult(true)  = 光标不在角色身上 → 忽略鼠标 → 穿透给下面的窗口
 *
 * 这一处曾写反过两次：第一次是兜底分支报错方向，"一开启就整窗穿透、连右键和设置都点不动"；
 * 第二次是命中分支直接传 `r.hit`，变成"角色身上穿透、透明区反而不穿透"。
 * **判断口诀：报的是"要不要穿透"，不是"有没有命中"。**
 *
 * **拿不准时一律报不穿透**：宁可穿透功能不生效，也不能把桌面点击全吃掉或让窗口变成挡板。
 * 遮罩没建好、handle 缺失、判定抛错，都走这个方向。
 */
function installClickThroughBridge(bridge: RendererBridge): void {
  if (typeof bridge.onHitProbe !== 'function' || typeof bridge.reportHitResult !== 'function') return;
  let lastRefresh = 0;
  bridge.onHitProbe((pos) => {
    // 拿不准 / 无数据 / 判定失败时，一律**不穿透**（ignore=false），保住窗口可交互
    const keepInteractive = (): void => bridge.reportHitResult?.(false, hasOpenOverlay());
    try {
      // 窗口内开着覆盖层面板（设置/待办/右键菜单/思考浮窗）时**必须**保持可交互：
      // 这些面板就在本窗口内部，而 setIgnoreMouseEvents 是整窗生效的 ——
      // 一旦按"光标不在角色身上"判成穿透，面板自己也点不动了。
      if (hasOpenOverlay()) {
        bridge.reportHitResult?.(false, true);
        return;
      }
      const h = currentHandle;
      if (!h || typeof h.hitTest !== 'function') {
        keepInteractive(); // 还没有可判定的模型 → 保持可交互
        return;
      }
      // 角色一直在动（呼吸/动作），遮罩按需刷新：位移很小，500ms 足够跟上。
      // 刷新放在**判定之前**，避免"第一次探测时遮罩还没建好"这件事把状态带偏。
      const now = performance.now();
      if (now - lastRefresh > 500 && typeof h.refreshHitMask === 'function') {
        lastRefresh = now;
        h.refreshHitMask();
      }
      const r = h.hitTest(pos.x, pos.y);
      if (!r.ok) {
        keepInteractive(); // 遮罩仍不可用 → 保持可交互
        return;
      }
      // ⚠️ 这里传的是 main 侧 `setIgnoreMouseEvents` 的 ignore 语义，**不是**"是否命中"：
      //     ignore = true  → 该点穿透到下层
      //     ignore = false → 该点由本窗口收下
      //   所以命中角色（r.hit=true）必须传 **false**。传 r.hit 会让"角色身上穿透、透明区反而不穿透"。
      bridge.reportHitResult?.(!r.hit, false);
    } catch (err) {
      console.warn('[renderer] 命中判定失败', err);
      keepInteractive();
    }
  });
}

/**
 * 窗口内是否有"会挡住点击的覆盖层面板"处于打开状态。
 *
 * 这些面板与角色**同处一个窗口**，而点击穿透是整窗生效的：面板打开时若仍按角色命中判定，
 * 光标落在面板以外就会被判成可穿透，导致面板点不动（真实故障）。
 * 因此只要它们开着，就必须整体保持可交互。
 */
function hasOpenOverlay(): boolean {
  try {
    // 只看会遮挡点击的面板；气泡(#bubble)是纯展示、不吃点击，故不计入
    const ids = ['settings-panel', 'todo-panel', 'context-menu', 'think-panel'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && !el.hidden) return true;
    }
    return false;
  } catch {
    // 查询失败按"没有覆盖层"处理：不要把窗口永久钉在可交互态
    return false;
  }
}

function subscribeWindowChanges(bridge: RendererBridge): void {
  try {
    const off = bridge.onWindowChange((info) => handleWindowChange(info));
    window.addEventListener('beforeunload', () => {
      try { off(); } catch { /* ignore */ }
    });
  } catch (err) {
    console.warn('[renderer] onWindowChange 订阅失败', err);
  }
}

/* ================================================================
   9. 初始化
   ================================================================ */
function mountBootPlaceholder(message: string): void {
  if (!stageEl) return;
  currentHandle = libMountPlaceholder('Pet', message);
}


/* ================================================================
   9. 右键菜单与设置
   ================================================================ */
let settingsBridge: RendererBridge | null = null;

function elementById<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function setSettingsStatus(text: string, isError = false): void {
  const status = elementById<HTMLElement>('settings-status');
  if (status) {
    status.textContent = text;
    status.style.color = isError ? '#ffaaa8' : '';
  }
}

function readNumber(id: string, fallback: number): number {
  const input = elementById<HTMLInputElement>(id);
  const value = Number(input?.value);
  return Number.isFinite(value) ? value : fallback;
}

/** 服务端拉到的全部可用模型（设置页内嵌列表用） */
let aiModelAll: string[] = [];

/* ---------------- 转写模型：按 API 地址索引 + 体检提示 ----------------
   用户要求：转写模型/路由要能"按你给的 API 地址自动索引模型"；如果地址里没有这个模型、
   压根没有转写类模型、或者地址读不到，都要给出提示（而不是等转写时才报错）。 */

/** 最近一次索引结果里的候选（供下拉列表用） */
let voiceModelCandidates: string[] = [];
let voiceModelAll: string[] = [];

function setVoiceModelHint(text: string, level: 'ok' | 'warn' | 'error' | 'none' = 'none'): void {
  const el = elementById<HTMLElement>('setting-voice-model-hint');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('is-ok', level === 'ok');
  el.classList.toggle('is-warn', level === 'warn');
  el.classList.toggle('is-bad', level === 'error');
}

function closeVoiceModelPanel(): void {
  const panel = elementById<HTMLElement>('setting-voice-model-panel');
  if (panel) panel.hidden = true;
  elementById<HTMLButtonElement>('setting-voice-model-pick')?.setAttribute('aria-expanded', 'false');
}

/** 转写候选列表（转写类在前，后面跟上其余模型，方便手挑） */
function renderVoiceModelList(filter = ''): void {
  const list = elementById<HTMLElement>('setting-voice-model-list');
  if (!list) return;
  const q = filter.trim().toLowerCase();
  const current = elementById<HTMLInputElement>('setting-voice-model')?.value.trim() ?? '';
  const isAsr = (m: string): boolean => voiceModelCandidates.includes(m);
  // 候选在前、其余在后；每项标一下是不是"识别为转写类"
  const ordered = [...voiceModelCandidates, ...voiceModelAll.filter((m) => !isAsr(m))];
  const hits = q ? ordered.filter((m) => m.toLowerCase().includes(q)) : ordered;
  list.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = voiceModelAll.length ? '没有匹配的模型' : '（还没索引到模型，点上面的按钮按地址拉取）';
    list.appendChild(empty);
    return;
  }
  for (const id of hits.slice(0, 300)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `model-item${id === current ? ' is-current' : ''}`;
    btn.textContent = isAsr(id) ? `${id}（转写候选）` : id;
    btn.title = isAsr(id) ? '名字看起来是转写/语音类模型' : '这个名字不像转写模型，选中后请用「🎙 自检语音识别」确认';
    btn.addEventListener('click', () => {
      const input = elementById<HTMLInputElement>('setting-voice-model');
      if (input) input.value = id;
      closeVoiceModelPanel();
      setVoiceModelHint(`已选择「${id}」——记得点最下面「保存设置」，再点「🎙 自检语音识别」确认能转写。`, 'warn');
    });
    list.appendChild(btn);
  }
}

/**
 * 按当前 API 地址索引转写模型：
 *  - 模型留空 → 用服务端候选自动填一个（并说明"已自动填入"）；
 *  - 当前模型不在列表里 / 没有转写类候选 / 拉不到列表 → 在提示行里说清原因与下一步。
 */
async function refreshVoiceModelIndex(bridge: RendererBridge, opts: { autoFill?: boolean } = {}): Promise<void> {
  const input = elementById<HTMLInputElement>('setting-voice-model');
  if (!input) return;
  if (typeof bridge.voiceModels !== 'function') {
    setVoiceModelHint('当前版本不支持按地址索引转写模型，可手填模型名', 'warn');
    return;
  }
  setVoiceModelHint('正在按 API 地址索引转写模型…');
  try {
    const res = await bridge.voiceModels();
    if (!res) {
      setVoiceModelHint('索引没有返回结果', 'warn');
      return;
    }
    voiceModelCandidates = Array.isArray(res.candidates) ? res.candidates : [];
    voiceModelAll = voiceModelCandidates.slice();
    const typed = input.value.trim();
    // 1) 框里已经有值（手填的或刚自动填入的）→ 按"框里的值"给结论，
    //    否则会在下拉刷新时把刚才的自动填入提示覆盖成"留空，建议填另一个"（自相矛盾）。
    if (typed) {
      const supported = voiceModelCandidates.includes(typed);
      if (supported) {
        const routeTail = res.knownRoute
          ? `｜上次实测可用路由：${res.knownRoute === 'chat-audio' ? 'chat 接口 + 音频' : 'audio/transcriptions'}`
          : res.routeHint
            ? `｜${res.routeHint}`
            : '';
        setVoiceModelHint(`✅ 「${typed}」在这个地址的转写候选里（共 ${res.total} 个模型）${routeTail}——保存后点「🎙 自检语音识别」确认`, 'ok');
        return;
      }
      if (res.ok && res.total > 0) {
        setVoiceModelHint(
          `⚠️ 「${typed}」不在这个地址的转写候选里${voiceModelCandidates.length ? `（候选：${voiceModelCandidates.slice(0, 4).join('、')}）` : ''}——保存后点「🎙 自检语音识别」确认`,
          'warn',
        );
        return;
      }
      // 列表没拿到 → 落到下面用 res 的结论说明"地址/密钥"层面的问题
    }
    // 2) 框里空着 → 用服务端候选自动填一个（并说明是自动填的）
    if (!typed && opts.autoFill !== false && res.autoPicked) {
      input.value = res.autoPicked;
      setVoiceModelHint(`已按地址自动填入「${res.autoPicked}」（${res.reason}）——保存后点「🎙 自检语音识别」确认`, 'warn');
      return;
    }
    // 3) 其余情况：直接展示服务端体检结论（模型不存在 / 没有转写类模型 / 拉不到列表）
    const level: 'ok' | 'warn' | 'error' = res.verdict === 'ok' ? 'ok' : res.verdict === 'warn' ? 'warn' : 'error';
    const icon = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '❌';
    const tail = [res.action, res.routeHint].filter(Boolean).join('；');
    setVoiceModelHint(`${icon} ${res.reason}${tail ? `｜${tail}` : ''}`, level);
  } catch (err) {
    setVoiceModelHint(`索引失败：${(err as Error).message ?? String(err)}`, 'error');
  }
}

function setAiModelStatus(text: string, isError = false): void {
  const status = elementById<HTMLElement>('setting-ai-model-status');
  if (!status) return;
  status.textContent = text;
  status.style.color = isError ? '#ffaaa8' : '';
}

function closeAiModelPanel(): void {
  const panel = elementById<HTMLElement>('setting-ai-model-panel');
  if (panel) panel.hidden = true;
  elementById<HTMLButtonElement>('setting-ai-model-refresh')?.setAttribute('aria-expanded', 'false');
}

/** 渲染内嵌模型列表（带过滤；点一项即填入输入框并收起） */
function renderAiModelList(filter = ''): void {
  const list = elementById<HTMLElement>('setting-ai-model-list');
  if (!list) return;
  const q = filter.trim().toLowerCase();
  const current = elementById<HTMLInputElement>('setting-ai-model')?.value.trim() ?? '';
  const hits = q ? aiModelAll.filter((m) => m.toLowerCase().includes(q)) : aiModelAll;
  list.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = aiModelAll.length ? '没有匹配的模型' : '（还没拉到模型列表，点上面的按钮拉取）';
    list.appendChild(empty);
    return;
  }
  for (const id of hits.slice(0, 300)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `model-item${id === current ? ' is-current' : ''}`;
    btn.textContent = id;
    btn.addEventListener('click', () => {
      const input = elementById<HTMLInputElement>('setting-ai-model');
      if (input) input.value = id;
      closeAiModelPanel();
      setAiModelStatus(`已选择「${id}」——记得点最下面「保存设置」才会生效。`);
    });
    list.appendChild(btn);
  }
}

/**
 * 拉取服务端可用模型（GET /models）并填充内嵌列表。
 * 刻意不用 `<datalist>`：Electron/Chromium 里它的原生弹窗只显示与输入框前缀匹配的项
 * （看起来"只有一个模型"）、点外面收不回去、设置页滚动时还钉在原来位置。
 */
async function refreshAiModelOptions(bridge: RendererBridge, openPanel = false): Promise<void> {
  const panel = elementById<HTMLElement>('setting-ai-model-panel');
  const list = elementById<HTMLElement>('setting-ai-model-list');
  if (openPanel && panel) {
    panel.hidden = false;
    elementById<HTMLButtonElement>('setting-ai-model-refresh')?.setAttribute('aria-expanded', 'true');
    // 展开后把这一整块滚进可视区：521px 高的窗口里，展开的列表常常落在可视区外，
    // 用户会以为"展开了却显示不出来"（用户报过的原话）。表单是唯一的滚动容器，
    // scrollIntoView 会滚它（block:'center' 让过滤框+列表整块可见）。
    window.requestAnimationFrame(() => {
      try {
        panel.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch {
        panel.scrollIntoView(false); // 老 Chromium 不认对象参数
      }
    });
    const filter = elementById<HTMLInputElement>('setting-ai-model-filter');
    if (filter) {
      filter.value = '';
      window.setTimeout(() => {
        try {
          filter.focus();
        } catch {
          /* ignore */
        }
      }, 30);
    }
  }
  if (typeof bridge.aiModelList !== 'function') {
    setAiModelStatus('（当前版本不支持拉取模型列表）', true);
    return;
  }
  setAiModelStatus('正在拉取可用模型…');
  if (list) list.replaceChildren();
  try {
    const res = await bridge.aiModelList();
    if (!res || !res.ok) {
      setAiModelStatus(`拉取失败：${res?.error ?? '未知原因'}（也可以手动输入模型名）`, true);
      renderAiModelList();
      return;
    }
    aiModelAll = res.models;
    renderAiModelList(elementById<HTMLInputElement>('setting-ai-model-filter')?.value ?? '');
    // 顺手把"填了个不存在的模型名"当面点出来
    const current = elementById<HTMLInputElement>('setting-ai-model')?.value.trim() ?? '';
    if (current && !aiModelAll.includes(current)) {
      setAiModelStatus(`共 ${aiModelAll.length} 个可用模型；⚠️ 当前填的「${current}」不在列表里，点「▾ 选择模型」挑一个再保存。`, true);
    } else {
      setAiModelStatus(`已拉取 ${aiModelAll.length} 个可用模型（点「▾ 选择模型」展开挑选）。`);
    }
  } catch (err) {
    setAiModelStatus(`拉取失败：${(err as Error).message ?? String(err)}`, true);
  }
}

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
  const modelSelect = elementById<HTMLSelectElement>('setting-model');
  if (modelSelect) {
    modelSelect.replaceChildren();
    for (const name of models) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      modelSelect.appendChild(option);
    }
  }
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
  if (hideFsBox) hideFsBox.checked = settings.hideOnFullscreen !== false; // 默认开启
  const clickThroughBox = elementById<HTMLInputElement>('setting-click-through');
  if (clickThroughBox) clickThroughBox.checked = settings.clickThrough === true; // 默认关闭
  applySfxSettings(settings); // 音效开关/音量 + 滑杆显示
  // 打开设置就顺手拉一次可用模型列表（失败也不影响其它设置项）+ 扫描可插拔资产
  void refreshAiModelOptions(bridge);
  void refreshAssetPanel(bridge);
  void refreshVoiceStatus(bridge); // 语音识别这行的状态（是否配好、走哪条路由、发往哪个主机）
  void refreshVoiceModelIndex(bridge); // 转写模型：按地址索引候选 + 体检提示（模型留空时自动填一个）
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

function openSettings(bridge: RendererBridge): void {
  const panel = elementById<HTMLElement>('settings-panel');
  if (!panel) return;
  hideContextMenu();
  panel.hidden = false;
  // 表单是唯一滚动容器：每次打开都从顶部开始，否则会停在上次的位置，看着像"内容缺了"
  const form = elementById<HTMLElement>('settings-form');
  if (form) form.scrollTop = 0;
  closeAiModelPanel(); // 展开的模型列表收起，避免一进来就是 200+ 项的滚动区
  setSettingsStatus('读取设置…');
  void populateSettings(bridge)
    .then(() => setSettingsStatus(''))
    .catch((err: unknown) => setSettingsStatus(`读取失败：${(err as Error).message ?? String(err)}`, true));
}

function closeSettings(): void {
  const panel = elementById<HTMLElement>('settings-panel');
  if (panel) panel.hidden = true;
}

async function saveSettings(bridge: RendererBridge): Promise<void> {
  const value = (id: string): string => elementById<HTMLInputElement>(id)?.value.trim() ?? '';
  const settings: AppSettings = {
    provider: value('setting-provider'),
    aiBaseUrl: value('setting-base-url'),
    aiApiKey: value('setting-api-key'),
    aiModel: value('setting-ai-model'),
    azureApiVersion: value('setting-azure-version'),
    temperature: readNumber('setting-temperature', 0.7),
    contextRounds: readNumber('setting-rounds', 10),
    maxContextTokens: readNumber('setting-tokens', 16000),
    confirmTools: elementById<HTMLInputElement>('setting-confirm-tools')?.checked === true,
    showThinking: elementById<HTMLInputElement>('setting-show-thinking')?.checked !== false,
    sfxEnabled: elementById<HTMLInputElement>('setting-sfx')?.checked !== false,
    sfxVolume: readNumber('setting-sfx-volume', 0.6),
    devWorkspaceRoot: value('setting-dev-root'),
    allowShell: elementById<HTMLInputElement>('setting-allow-shell')?.checked !== false,
    permissionMode: (elementById<HTMLSelectElement>('setting-permission-mode')?.value as AppSettings['permissionMode']) ?? 'ask',
    displayMode: (elementById<HTMLSelectElement>('setting-display-mode')?.value as AppSettings['displayMode']) ?? 'full',
    hideOnFullscreen: elementById<HTMLInputElement>('setting-hide-fullscreen')?.checked !== false,
    clickThrough: elementById<HTMLInputElement>('setting-click-through')?.checked === true,
    // 语音识别（留空即复用 AI 配置）
    voiceModel: value('setting-voice-model'),
    voiceRoute: (elementById<HTMLSelectElement>('setting-voice-route')?.value as AppSettings['voiceRoute']) ?? 'auto',
    voiceBaseUrl: value('setting-voice-base-url'),
    voiceApiKey: value('setting-voice-api-key'),
  };
  setSettingsStatus('保存中…');
  const result = await bridge.setSettings(settings);
  if (!result.ok) {
    setSettingsStatus(result.error ?? '保存失败', true);
    return;
  }
  applySfxSettings(settings); // 音效开关/音量立刻生效（无需重启）
  applyFraming(settings.displayMode === 'half' ? 'half' : 'full'); // 取景立刻生效
  void refreshVoiceStatus(bridge); // 语音状态行跟着更新
  void refreshVoiceModelIndex(bridge, { autoFill: false }); // 转写模型体检（保存后重新校验一次）
  setSettingsStatus('已保存，下一条消息立即使用新配置。');
  showBubble('设置已生效', { ttlMs: 2200 });
}

async function switchModel(bridge: RendererBridge, modelName: string): Promise<void> {
  if (!modelName) return;
  setSettingsStatus(`正在加载 ${modelName}…`);
  try {
    const manifest = await bridge.loadModel(modelName);
    await mountManifest(manifest);
    applyPresetParameterMap(); // 新模型的 parameterMap 立刻生效
    setSettingsStatus(`${modelName} 已切换`);
  } catch (err) {
    setSettingsStatus(`模型切换失败：${(err as Error).message ?? String(err)}`, true);
  }
}

/* ================================================================
   9.5 右键菜单：动作 / 表情 / 聊天 / 设置 / 退出（DOM 事件委托 + 动态表情区）
   ================================================================ */
function hideContextMenu(): void {
  const menu = elementById<HTMLElement>('context-menu');
  if (menu) menu.hidden = true;
}

/** 打开右键菜单：按当前模型能力填表情区，在鼠标位置显示并做屏幕边界收敛 */
/** 把菜单放进窗口可见区域内（菜单自身有 max-height + 滚动，这里只负责"别顶出窗沿"） */
function placeContextMenu(menu: HTMLElement, x: number, y: number): void {
  const m = 6; // 距窗口边缘的最小边距
  const rect = menu.getBoundingClientRect();
  const maxLeft = Math.max(m, window.innerWidth - rect.width - m);
  const maxTop = Math.max(m, window.innerHeight - rect.height - m);
  menu.style.left = `${Math.min(Math.max(x, m), maxLeft)}px`;
  menu.style.top = `${Math.min(Math.max(y, m), maxTop)}px`;
}

function showContextMenu(x: number, y: number): void {
  const menu = elementById<HTMLElement>('context-menu');
  const panel = elementById<HTMLElement>('settings-panel');
  if (!menu || (panel && !panel.hidden)) return; // 设置面板打开时不叠菜单
  hideChatBar(); // 聊天条显示时打开菜单 → 先收起，避免二者叠加
  populateExpressionItems();
  populateCostumeItems(); // 服饰/道具：模型没有这一类就整组隐藏
  menu.hidden = false;
  placeContextMenu(menu, x, y);
  // 表情是"按当前模型动态生成"的，第一帧可能还没算完高度 → 下一帧再夹一次，
  // 否则菜单会按错的尺寸定位、底部被窗口裁掉（用户报过这个问题）。
  window.requestAnimationFrame(() => {
    if (!menu.hidden) placeContextMenu(menu, x, y);
  });
}

/** 表情区：默认 + 当前模型真实 Expressions；无表情能力则整组隐藏 */
function populateExpressionItems(): void {
  const wrap = elementById<HTMLElement>('cm-expressions');
  const list = elementById<HTMLElement>('cm-expression-list');
  if (!wrap || !list) return;
  list.replaceChildren();
  const names = currentHandle && typeof currentHandle.listExpressions === 'function'
    ? currentHandle.listExpressions()
    : [];
  const costumeNames = new Set((activeModelCapabilities?.costume ?? []).filter((name) => names.includes(name)));
  const uniqueNames = [...new Set(names)].filter((name) => !costumeNames.has(name));
  if (!uniqueNames.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const addItem = (label: string, value: string): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.menuExpression = value;
    b.textContent = label;
    list.appendChild(b);
  };
  addItem('默认', '');
  for (const name of uniqueNames) addItem(name, name);
}

/** 服饰/道具分组：内容来自 pet-model.json 的 capabilities.costume（自动识别，可在文件里手改）；空则隐藏 */
function populateCostumeItems(): void {
  const wrap = elementById<HTMLElement>('cm-costume');
  const list = elementById<HTMLElement>('cm-costume-list');
  if (!wrap || !list) return;
  list.replaceChildren();
  const names = currentHandle && typeof currentHandle.listExpressions === 'function'
    ? currentHandle.listExpressions()
    : [];
  const items = [...new Set(activeModelCapabilities?.costume ?? [])].filter((name) => names.includes(name));
  if (!items.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const addItem = (label: string, value: string): void => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.menuExpression = value;
    b.textContent = label;
    list.appendChild(b);
  };
  addItem('不穿 / 取下', '');
  for (const n of items) addItem(n, n);
}

/** 动作入口：仅 Idle 待机（挥手入口已从右键菜单移除；live2d 层播放能力保留供未来模型使用）。
 *  Idle 本身就是回到待机呼吸/浮动，播完无需任何自动回退计时。 */
function playIdleMotion(): void {
  hideContextMenu();
  const h = currentHandle;
  if (!h) {
    showBubble('模型尚未就绪', { ttlMs: 1600 });
    return;
  }
  if (h.kind === 'placeholder') {
    showBubble('当前为占位显示，无法播放动作', { ttlMs: 1800 });
    return;
  }
  if (typeof h.playMotion !== 'function') {
    showBubble('当前渲染方式不支持动作', { ttlMs: 1600 });
    return;
  }
  h.playMotion('Idle'); // moc3 播 Idle 组；portrait 取消手势回呼吸浮动
}

/** 表情入口：'' = 恢复默认表情。菜单是显式选择 → 取消点击触发的自动恢复，避免被重置 */
function triggerExpression(value: string): void {
  hideContextMenu();
  cancelTapExpressionReset();
  const h = currentHandle;
  if (!h || typeof h.setExpression !== 'function') {
    showBubble('当前模型不支持表情切换', { ttlMs: 1600 });
    return;
  }
  if (value === '') {
    h.setExpression(null);
    activeTapExpression = '';
    return;
  }
  if (activeTapExpression === value) {
    // 与当前生效的表情相同（例如刚点击触发过「点一下」）：清空后重设，保证菜单选择仍有可见效果
    h.setExpression(null);
    window.setTimeout(() => {
      try {
        currentHandle?.setExpression?.(value);
      } catch {
        /* ignore */
      }
    }, 60);
  } else {
    h.setExpression(value);
  }
  activeTapExpression = value;
}

/** 退出 Pet：bridge 无关闭方法，Electron 下 window.close() 关窗即退出应用 */
function quitPet(): void {
  hideContextMenu();
  try {
    if ((window as Any).electron) {
      window.close();
    } else {
      console.warn('[renderer] 非 Electron 环境：忽略“退出 Pet”');
    }
  } catch (err) {
    console.warn('[renderer] 退出失败', err);
  }
}

/* ================================================================
   9.6 AI 对话输入条（右键菜单“💬 和 Pet 聊天”打开）
      顶部窄条，不遮挡角色；Enter 发送、Esc 收起、点聊天条外收起。
      AI 回复不经此函数处理：sendMessage 已让主进程 SSE 流式推送，
      subscribeOptionalPushes 的 onChat → feedChatDelta 逐字打到气泡。
   ================================================================ */
/** 是否正在 await sendMessage（防连点重复发送） */
let chatSending = false;

/** 显示聊天条并聚焦输入框（聊天条与右键菜单互斥，避免顶部/菜单叠加）；同时打开思考浮窗 */
function showChatBar(): void {
  hideContextMenu();
  const bar = elementById<HTMLElement>('chatbar');
  if (!bar) return;
  bar.classList.add('is-open');
  bar.setAttribute('aria-hidden', 'false');
  chatScrollToEnd(); // 打开时先滚到最新一条
  openThinkWithChat(); // 浮窗伴随对话打开
  // 下一帧聚焦：等淡入开始后输入框即可获得焦点打字
  window.requestAnimationFrame(() => {
    try { elementById<HTMLInputElement>('chat-input')?.focus(); } catch { /* ignore */ }
  });
}

/**
 * 打开对话界面：默认弹**独立聊天窗口**（对话框在模型窗口外展开，不遮挡桌宠）。
 * 聊天窗口不可用（渲染入口缺失/创建失败）时，回退到窗口内的输入条，保证功能不丢。
 */
async function openChatSurface(bridge: RendererBridge): Promise<void> {
  hideContextMenu();
  if (typeof bridge.chatWindowOpen === 'function') {
    try {
      const res = await bridge.chatWindowOpen();
      if (res && res.ok) {
        // 独立窗口接管对话：桌宠窗口自己的输入条与思考浮窗一并收起，避免两处重复
        hideChatBar();
        return;
      }
      flashStatus(`独立聊天窗口不可用，改用窗口内输入条${res?.error ? `（${res.error}）` : ''}`, 3600);
      console.warn('[renderer] 独立聊天窗口打开失败：', res?.error ?? '未知原因');
    } catch (err) {
      flashStatus('独立聊天窗口打开失败，改用窗口内输入条', 3600);
      console.warn('[renderer] chatWindowOpen 调用失败', err);
    }
  }
  showChatBar();
}

/**
 * 收起聊天条（直接移除 .is-open；无淡出动画，下次打开仍淡入）。
 * keepThinkPanel=true 用于 ask_user 提问等场景：只收输入条，不关思考浮窗。
 */
function hideChatBar(keepThinkPanel = false): void {
  const bar = elementById<HTMLElement>('chatbar');
  if (bar) {
    bar.classList.remove('is-open');
    bar.setAttribute('aria-hidden', 'true');
    try { elementById<HTMLInputElement>('chat-input')?.blur(); } catch { /* ignore */ }
  }
  // 收起对话时若正在录音，立刻取消并释放麦克风（不做后台常驻录音）
  if (voiceState === 'listening' || voiceState === 'arming') finishVoiceCapture(true);
  if (!keepThinkPanel) closeThinkWithChat(); // 关闭对话 → 浮窗彻底关闭（含胶囊）
}

/* ================================================================
   9.5 语音输入（按住说话 → 云端 ASR 转写 → 填入输入框）
   —— 状态机：idle → arming(按住) → listening(录音) → transcribing → ready / error / cancelled
   —— 三条硬规则：
      1) 音频只在内存里过一手（MediaRecorder → ArrayBuffer → IPC），**不落盘**；
      2) 转写结果只填进输入框，**不自动发送**（用户确认后再发，避免误发与浪费额度）；
      3) 任何一个环节出问题都只改状态 + 给一行可读文案，绝不抛异常卡住聊天。
   —— 录音过程中用麦克风能量驱动口型（说话时嘴跟着动），拿不到音频数据就静默跳过。
   ================================================================ */
type VoiceState = 'idle' | 'arming' | 'listening' | 'transcribing' | 'ready' | 'error' | 'cancelled';

/** 按住多久才算"真的要说话"（短于此视为误触，直接取消） */
const VOICE_MIN_HOLD_MS = 300;
/** 单次录音上限（防止一直按着不放） */
const VOICE_MAX_RECORD_MS = 60_000;
/** 口型采样间隔：麦克风能量 → ParamMouthOpenY */
const VOICE_MOUTH_TICK_MS = 90;

let voiceState: VoiceState = 'idle';
let voiceRecorder: MediaRecorder | null = null;
let voiceStream: MediaStream | null = null;
let voiceChunks: Blob[] = [];
let voiceArmAt = 0;
let voiceRowEl: HTMLElement | null = null;
let voiceMaxTimer: number | null = null;
let voiceMouthTimer: number | null = null;
let voiceAudioCtx: AudioContext | null = null;
let voiceAnalyser: AnalyserNode | null = null;
let voiceMouthBuf: Uint8Array | null = null;
/** 外部可挂的唤醒词回调（当前不做常驻唤醒；留给将来接本地/系统级唤醒词） */
let wakeWordHook: ((word: string) => void) | null = null;

/* ---- 声纹（实时输入电平波形）：由 voicelab.ts 提供 ---- */
interface VoiceLabLike {
  begin(opts?: { label?: string; phase?: 'connecting' | 'recording' }): number;
  level(token: number, rms: number, peak?: number): void;
  configure(token: number, opts: { phase?: string; label?: string }): void;
  stop(token?: number): void;
  isActive(): boolean;
  state(): Any;
}

function voiceLab(): VoiceLabLike | null {
  const v = (window as Any).PetVoiceLab;
  return v && typeof v.begin === 'function' ? (v as VoiceLabLike) : null;
}

/** 声纹当前会话 token（0 = 没在显示） */
let voiceLabToken = 0;

/** 开始一段声纹会话：connecting 阶段只显示"正在连接语音"，第一帧电平到了才切成波形 */
function startVoiceWave(label = '正在连接语音'): boolean {
  const lab = voiceLab();
  if (!lab) return false;
  voiceLabToken = lab.begin({ label, phase: 'connecting' });
  return true;
}

/** 喂电平（rms/peak 都是 0~1）：越界的值由 voicelab 自己丢掉 */
function feedVoiceLevel(rms: number, peak: number): void {
  const lab = voiceLab();
  if (!lab || !lab.isActive()) return;
  lab.level(voiceLabToken, rms, peak);
}

/** 结束声纹会话（幂等） */
function stopVoiceWave(): void {
  const lab = voiceLab();
  voiceLabToken = 0;
  if (!lab) return;
  try {
    lab.stop();
  } catch (err) {
    console.warn('[renderer] 声纹收尾失败', err);
  }
}

function voiceButton(): HTMLButtonElement | null {
  return elementById<HTMLButtonElement>('chat-mic');
}

/** 读取当前状态（包一层函数：await 之后 TS 的类型收窄会失效，这里强制按最新值判断） */
function currentVoiceState(): VoiceState {
  return voiceState;
}

/** 语音专用行：不持久化（转写结果进输入框，历史上不该留"录音中…"这种瞬时状态） */
function setVoiceRow(text: string, tone: 'info' | 'error' = 'info'): void {
  if (!chatLogEl) return;
  if (!voiceRowEl) voiceRowEl = appendChatLog('tool', text, { persist: false });
  if (!voiceRowEl) return;
  voiceRowEl.classList.toggle('is-error', tone === 'error');
  voiceRowEl.classList.add('is-voice');
  const body = voiceRowEl.querySelector('.chat-text');
  if (body) body.textContent = tone === 'error' ? `⚠️ ${text}` : `🎤 ${text}`;
  chatScrollToEnd();
}

function clearVoiceRow(): void {
  if (voiceRowEl && voiceRowEl.parentElement) voiceRowEl.parentElement.removeChild(voiceRowEl);
  voiceRowEl = null;
}

/** 状态切换：按钮外观 + 状态行文案 + 收尾（停录音/停口型）都集中在这里 */
function setVoiceState(next: VoiceState, text?: string, tone: 'info' | 'error' = 'info'): void {
  voiceState = next;
  const btn = voiceButton();
  if (btn) {
    btn.classList.toggle('is-arming', next === 'arming');
    btn.classList.toggle('is-listening', next === 'listening' || next === 'transcribing');
    btn.classList.toggle('is-busy', next === 'transcribing');
    btn.disabled = next === 'transcribing';
    btn.setAttribute('aria-pressed', next === 'listening' ? 'true' : 'false');
    btn.title = next === 'idle'
      ? '按住说话（松开后转写，不会自动发送）'
      : next === 'listening' ? '正在录音…松开结束' : next === 'transcribing' ? '转写中…' : '按住说话';
  }
  if (text) setVoiceRow(text, tone);
  // 声纹只在"连接中/录音中"存在；其它状态一律收掉（转写/完成/报错由状态行表达）
  if (next !== 'listening' && next !== 'arming') stopVoiceWave();
  if (next === 'idle' || next === 'ready' || next === 'error' || next === 'cancelled') stopVoiceMouth();
}

/* —— 麦克风能量 → 口型（说话时嘴跟着动）—— */
function stopVoiceMouth(): void {
  if (voiceMouthTimer) {
    window.clearTimeout(voiceMouthTimer);
    voiceMouthTimer = null;
  }
  try { voiceAnalyser = null; } catch { /* ignore */ }
  pushSpeechMouth({ openY: 0 }, 240);
}

function startVoiceMouth(stream: MediaStream): void {
  stopVoiceMouth();
  try {
    const Ctx = (window as Any).AudioContext || (window as Any).webkitAudioContext;
    if (!Ctx) return;
    const ctx: AudioContext = new Ctx();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    src.connect(analyser);
    voiceAudioCtx = ctx;
    voiceAnalyser = analyser;
    voiceMouthBuf = new Uint8Array(analyser.fftSize);
  } catch (err) {
    console.warn('[renderer] 麦克风能量分析不可用（口型跳过）', err);
    return;
  }
  const tick = (): void => {
    if (voiceState !== 'listening' || !voiceAnalyser || !voiceMouthBuf) {
      voiceMouthTimer = null;
      return;
    }
    try {
      voiceAnalyser.getByteTimeDomainData(voiceMouthBuf as unknown as Uint8Array<ArrayBuffer>);
      let sum = 0;
      let peakOffset = 0; // 时域峰值（相对 128 的最大偏移）：给声纹用
      for (let i = 0; i < voiceMouthBuf.length; i += 1) {
        const off = Math.abs(voiceMouthBuf[i] - 128);
        sum += off;
        if (off > peakOffset) peakOffset = off;
      }
      const rms = sum / voiceMouthBuf.length / 128;              // 归一化能量
      const peak = Math.min(1, peakOffset / 128);                // 归一化峰值
      const openY = Math.max(0, Math.min(1, (rms - 0.04) * 2.2)); // 阈值过滤底噪，增益拉满
      pushSpeechMouth({ openY }, VOICE_MOUTH_TICK_MS * 2.6);
      feedVoiceLevel(rms, peak); // 同一份采样同时喂声纹（口型与声纹共用一次 getByteTimeDomainData，省一次 FFT 读取）
    } catch {
      /* 设备掉线：下一轮自然停 */
    }
    voiceMouthTimer = window.setTimeout(tick, VOICE_MOUTH_TICK_MS);
  };
  voiceMouthTimer = window.setTimeout(tick, VOICE_MOUTH_TICK_MS);
}

function releaseVoiceStream(): void {
  stopVoiceWave(); // 麦克风一释放，声纹立刻收掉（不留残波）
  try { voiceRecorder?.state !== 'inactive' && voiceRecorder?.stop(); } catch { /* ignore */ }
  voiceRecorder = null;
  try { voiceStream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  voiceStream = null;
  const ctx = voiceAudioCtx;
  voiceAudioCtx = null;
  if (ctx) { try { void ctx.close(); } catch { /* ignore */ } }
  voiceChunks = [];
}

/**
 * 松开（或取消）后的收尾。
 * @param cancel true = 放弃这一段（太短 / 用户取消），不发请求
 */
function finishVoiceCapture(cancel: boolean): void {
  if (voiceState !== 'listening' && voiceState !== 'arming') return;
  const heldMs = performance.now() - voiceArmAt;
  if (voiceMaxTimer) { window.clearTimeout(voiceMaxTimer); voiceMaxTimer = null; }
  stopVoiceMouth();
  if (cancel || heldMs < VOICE_MIN_HOLD_MS) {
    releaseVoiceStream();
    setVoiceState('cancelled', '语音未发送（按得太短或已取消）');
    window.setTimeout(() => { if (voiceState === 'cancelled') { clearVoiceRow(); setVoiceState('idle'); } }, 2000);
    return;
  }
  if (!voiceStream) {
    setVoiceState('cancelled', '语音未发送（没有拿到麦克风）');
    return;
  }
  const bridge = chatBridge ?? getBridge();
  const recorder = voiceRecorder;
  setVoiceState('transcribing', '转写中…');
  const stopAll = (): void => {
    const mime = recorder?.mimeType || 'audio/webm';
    const blob = new Blob(voiceChunks, { type: mime });
    releaseVoiceStream();
    void sendVoiceForTranscript(blob, mime, bridge);
  };
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = stopAll;
    try { recorder.stop(); } catch { stopAll(); }
  } else {
    stopAll();
  }
}

async function sendVoiceForTranscript(
  blob: Blob,
  mime: string,
  bridge: RendererBridge | null,
): Promise<void> {
  if (!bridge || typeof bridge.voiceTranscribe !== 'function') {
    setVoiceState('error', '当前版本没有接入语音转写', 'error');
    return;
  }
  if (!blob.size) {
    setVoiceState('error', '没有录到声音，请再试一次', 'error');
    return;
  }
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const res = await bridge.voiceTranscribe({ bytes, mime, language: 'zh' });
    if (res && res.ok && res.text) {
      fillVoiceTranscript(res.text);
      return;
    }
    setVoiceState('error', (res && res.error) || '转写失败，请重试', 'error');
  } catch (err) {
    setVoiceState('error', `转写失败：${(err as Error).message ?? String(err)}`, 'error');
  }
}

/** 转写成功：只填进输入框（不自动发送），并让用户能直接回车确认 */
function fillVoiceTranscript(text: string): void {
  const input = elementById<HTMLInputElement>('chat-input');
  const clean = text.trim();
  if (input) {
    input.value = input.value.trim() ? `${input.value.trim()} ${clean}` : clean;
    try { input.focus(); } catch { /* ignore */ }
  }
  setVoiceState('ready', `转写完成：${clean.slice(0, 60)}${clean.length > 60 ? '…' : ''}（确认后点发送）`);
  setChatToolbarStatus('语音已转写，确认后发送');
  window.setTimeout(() => { if (voiceState === 'ready') { clearVoiceRow(); setVoiceState('idle'); } }, 6000);
}

async function startVoiceCapture(): Promise<void> {
  if (voiceState === 'arming' || voiceState === 'listening' || voiceState === 'transcribing') return;
  const bridge = chatBridge ?? getBridge();
  if (chatViewingSessionId) {
    setChatToolbarStatus('正在查看历史对话，先点「返回当前」再发语音', true);
    return;
  }
  if (!bridge || typeof bridge.voiceTranscribe !== 'function') {
    setVoiceState('error', '当前版本没有接入语音转写', 'error');
    return;
  }
  // 先问主进程"配置好了没"：没配就不要弹麦克风权限（避免用户白授权）
  if (typeof bridge.voiceStatus === 'function') {
    try {
      const st = await bridge.voiceStatus();
      if (st && st.configured === false) {
        setVoiceState('error', st.hint || '语音输入未配置（设置 → AI 接口地址与密钥）', 'error');
        window.setTimeout(() => { if (voiceState === 'error') { clearVoiceRow(); setVoiceState('idle'); } }, 5200);
        return;
      }
    } catch (err) {
      console.warn('[renderer] voiceStatus 查询失败（继续尝试录音）', err);
    }
  }
  if (voiceState !== 'idle' && voiceState !== 'ready' && voiceState !== 'error' && voiceState !== 'cancelled') return;
  clearVoiceRow();
  voiceArmAt = performance.now();
  setVoiceState('arming');
  // 声纹条替代“语音输入 · 准备中”这类瞬时文字行（连接阶段只显示“正在连接语音”，
  // 第一帧电平到了才切成波形）；拿不到 voicelab 时退回原来的文字行，功能不变。
  if (!startVoiceWave('正在连接语音')) setVoiceRow('语音输入 · 准备中');
  let stream: MediaStream;
  try {
    const nav = navigator as Navigator & { mediaDevices?: MediaDevices };
    if (!nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') {
      setVoiceState('error', '这台机器/窗口拿不到麦克风接口', 'error');
      return;
    }
    stream = await nav.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = (err as Error)?.name ?? '';
    const why = name === 'NotAllowedError' ? '麦克风权限被拒绝（系统设置里允许本应用使用麦克风）' : `无法访问麦克风：${(err as Error).message ?? String(err)}`;
    setVoiceState('error', why, 'error');
    return;
  }
  // 松手早于权限弹窗返回：这里要能自愈（否则会出现"没在录却显示录音中"）
  if (currentVoiceState() !== 'arming') {
    try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    return;
  }
  voiceStream = stream;
  voiceChunks = [];
  try {
    const prefer = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', ''];
    const mimeType = prefer.find((m) => !m || (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m))) || '';
    voiceRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    voiceRecorder.ondataavailable = (ev: BlobEvent): void => {
      if (ev.data && ev.data.size) voiceChunks.push(ev.data);
    };
    voiceRecorder.start(250); // 每 250ms 切一片：长录音也不会一直堆在内存峰值上
  } catch (err) {
    releaseVoiceStream();
    setVoiceState('error', `录音启动失败：${(err as Error).message ?? String(err)}`, 'error');
    return;
  }
  startVoiceMouth(stream);
  // 声纹：连接阶段已开始显示"正在连接语音"，这里进入录音（第一帧电平到了自动切成波形）
  const lab = voiceLab();
  if (lab) lab.configure(voiceLabToken, { phase: 'recording', label: '录音中…' });
  setVoiceState('listening');
  voiceMaxTimer = window.setTimeout(() => {
    if (voiceState === 'listening') finishVoiceCapture(false);
  }, VOICE_MAX_RECORD_MS);
}

/** 挂按住说话事件：document 级别监听松手，避免鼠标移出按钮时"停不下来" */
function installVoiceInput(): void {
  const btn = voiceButton();
  if (!btn) return;
  const cancelByPointerAway = (event: PointerEvent): void => {
    if (voiceState !== 'listening' && voiceState !== 'arming') return;
    if (event.relatedTarget && (btn === event.relatedTarget || btn.contains(event.relatedTarget as Node))) return;
    finishVoiceCapture(true);
  };
  btn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    void startVoiceCapture();
  });
  btn.addEventListener('pointerleave', cancelByPointerAway);
  btn.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('pointerup', () => {
    if (voiceState === 'listening' || voiceState === 'arming') finishVoiceCapture(false);
  });
  document.addEventListener('pointercancel', () => {
    if (voiceState === 'listening' || voiceState === 'arming') finishVoiceCapture(true);
  });
  // Esc 取消；页面隐藏/关闭时一定释放麦克风（隐私：不做后台常驻录音）
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (voiceState === 'listening' || voiceState === 'arming')) finishVoiceCapture(true);
  });
  window.addEventListener('blur', () => {
    if (voiceState === 'listening' || voiceState === 'arming') finishVoiceCapture(true);
  });
  window.addEventListener('pagehide', () => releaseVoiceStream());
  // 预留：唤醒词（当前不做常驻唤醒；外部脚本可 setWakeWordHook 后由它触发）
  (window as Any).petVoice = {
    start: () => void startVoiceCapture(),
    stop: () => finishVoiceCapture(false),
    cancel: () => finishVoiceCapture(true),
    state: () => voiceState,
    configured: async (): Promise<boolean> => {
      const b = chatBridge ?? getBridge();
      if (!b || typeof b.voiceStatus !== 'function') return false;
      try { return (await b.voiceStatus())?.configured === true; } catch { return false; }
    },
    /** 唤醒词预留钩子：setWakeWordHook((word) => …)；返回 false 表示当前版本不常驻监听 */
    setWakeWordHook: (fn: ((word: string) => void) | null): boolean => {
      wakeWordHook = typeof fn === 'function' ? fn : null;
      return true;
    },
    fireWakeWord: (word: string): boolean => {
      if (!wakeWordHook) return false;
      try { wakeWordHook(word || 'wake'); return true; } catch { return false; }
    },
    wakeWordSupported: false,
  };
}


/** 发送一条消息：先回显“你：…”再调主进程，失败走错误气泡；成功后清空输入框 */
async function sendChat(bridge: RendererBridge): Promise<void> {
  const input = elementById<HTMLInputElement>('chat-input');
  const sendBtn = elementById<HTMLButtonElement>('chat-send');
  if (chatViewingSessionId) {    setChatToolbarStatus('正在查看历史对话，先点「返回当前」再发消息', true);
    return;
  }
  if (chatSending || !input) return;
  const text = input.value.trim();
  if (!text) return;
  chatSending = true;
  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.textContent = '…';
  }
  // 先取走文字并清空输入框：AI 回复期间用户可继续组织下一句
  input.value = '';
  input.classList.remove('is-prefilled');
  try {
    // 用户消息立即回显；AI 回复随后经 onChat → feedChatDelta 覆盖/续打同一气泡
    showBubble(`你：${text}`, { immediate: true, ttlMs: 2000 });
    pendingUserRow = appendChatLog('user', text);
    markUserRowSending(pendingUserRow);
    streamRowEl = null; // 新的一轮：流式行从头开始
    const res = await bridge.sendMessage(text);
    if (!res.ok) {
      // 契约未携带 error 字段：给出通用失败提示（空消息/主进程拒绝等）
      const why = '发送失败：消息未送达，请检查 AI 设置后重试';
      showBubble(why, { tone: 'error', immediate: true, ttlMs: 3200 });
      markUserRowFailed(pendingUserRow, '消息未送达');
      appendChatLog('error', why);
    } else {
      setChatTyping(true); // 已送达：显示"Pet 正在回复…"，收到第一个分片或结束时复位
    }
  } catch (err) {
    console.warn('[renderer] sendMessage 调用失败', err);
    markUserRowFailed(pendingUserRow, (err as Error).message ?? String(err));
    showBubble(`发送失败：${(err as Error).message ?? String(err)}`, { tone: 'error', immediate: true, ttlMs: 3200 });
  } finally {
    chatSending = false;
    if (sendBtn) sendBtn.disabled = false;
    // 文字/占位符交给 setChatTyping 统一管理（发送成功后显示"正在回复"，收到分片或结束再复位）
    if (!typingRowEl) setChatTyping(false);
    // 聊天条仍打开时把焦点还给输入框，方便连续对话
    const bar = elementById<HTMLElement>('chatbar');
    if (bar && bar.classList.contains('is-open')) {
      try { input?.focus(); } catch { /* ignore */ }
    }
  }
}

/* ================================================================
   9.7 待办笔记本面板（数据经 IPC 走主进程 ToolBox，持久化 %APPDATA%）
   ================================================================ */
type TodoDto = import('../shared/contracts').TodoDto;

function renderTodoList(bridge: RendererBridge): void {
  const listEl = elementById<HTMLElement>('todo-list');
  const emptyEl = elementById<HTMLElement>('todo-empty');
  if (!listEl || !emptyEl) return;
  bridge
    .todoList()
    .then((todos) => {
      if (!todos.length) {
        listEl.replaceChildren();
        emptyEl.hidden = false;
        return;
      }
      emptyEl.hidden = true;
      listEl.replaceChildren();
      for (const todo of todos) {
        const li = document.createElement('div');
        li.className = 'todo-item';
        li.setAttribute('data-id', String(todo.id));
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'todo-item-checkbox';
        cb.checked = todo.done;
        const text = document.createElement('span');
        text.className = `todo-item-text${todo.done ? ' done' : ''}`;
        text.textContent = todo.text;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'todo-item-delete';
        del.textContent = '×';
        del.setAttribute('aria-label', '删除待办');
        li.append(cb, text, del);
        listEl.appendChild(li);
      }
    })
    .catch((err: unknown) => console.warn('[renderer] 读取待办失败', err));
}

function openTodoPanel(bridge: RendererBridge): void {
  const panel = elementById<HTMLElement>('todo-panel');
  const chatBar = elementById<HTMLElement>('chatbar');
  hideContextMenu();
  if (chatBar) chatBar.classList.remove('is-open');
  if (!panel) return;
  panel.hidden = false;
  renderTodoList(bridge);
  try {
    elementById<HTMLInputElement>('todo-input')?.focus();
  } catch { /* ignore */ }
}

function closeTodoPanel(): void {
  const panel = elementById<HTMLElement>('todo-panel');
  if (panel) panel.hidden = true;
}

function installTodoPanel(bridge: RendererBridge): void {
  elementById<HTMLButtonElement>('todo-close')?.addEventListener('click', closeTodoPanel);
  elementById<HTMLButtonElement>('todo-close2')?.addEventListener('click', closeTodoPanel); // 页脚“关闭”按钮

  const refreshAfter = (p: Promise<unknown>): void => {
    p.then(() => renderTodoList(bridge)).catch((err: unknown) => console.warn('[renderer] 待办操作失败', err));
  };

  const addFromInput = (): void => {
    const input = elementById<HTMLInputElement>('todo-input');
    const text = input?.value.trim();
    if (!text) return;
    if (input) input.value = '';
    refreshAfter(bridge.todoAdd(text));
  };
  elementById<HTMLButtonElement>('todo-add')?.addEventListener('click', addFromInput);
  elementById<HTMLInputElement>('todo-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addFromInput();
    }
  });

  // 列表事件委托：勾选 / 删除
  elementById<HTMLElement>('todo-list')?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest?.('.todo-item') as HTMLElement | null;
    const btn = (e.target as HTMLElement).closest?.('button') as HTMLElement | null;
    if (!item) return;
    const id = Number(item.getAttribute('data-id'));
    if (!Number.isFinite(id)) return;
    if (btn) {
      refreshAfter(bridge.todoDel(id));
    } else if ((e.target as HTMLInputElement).type === 'checkbox') {
      refreshAfter(bridge.todoToggle(id));
    }
  });

  // 聊天说“打开待办/笔记本” → 主进程 push IPC_TODO_SHOW
  bridge.onTodoShow?.(() => {
    openTodoPanel(bridge);
  });
}

/* ================================================================
   9.8 AI 提问框（ask_user）：选项按钮 + 自由文本回答
   ================================================================ */
type AskQuestionPayload = { id: string; question: string; options: Array<{ label: string; description?: string }> };

function hideAskBox(): void {
  const box = elementById<HTMLElement>('ask-box');
  if (!box) return;
  box.hidden = true;
  box.setAttribute('aria-hidden', 'true');
  delete box.dataset.questionId;
  setThinkWaiting(false); // 用户已作答 → 结束"暂停"状态，思考浮窗恢复
}

function showAskBox(bridge: RendererBridge, payload: AskQuestionPayload): void {
  const box = elementById<HTMLElement>('ask-box');
  const questionEl = elementById<HTMLElement>('ask-question');
  const optionsEl = elementById<HTMLElement>('ask-options');
  const input = elementById<HTMLInputElement>('ask-input');
  if (!box || !questionEl || !optionsEl || !input) return;
  hideContextMenu();
  const chatBar = elementById<HTMLElement>('chatbar');
  if (chatBar) chatBar.classList.remove('is-open'); // 只收输入条，保留思考浮窗
  box.dataset.questionId = payload.id;
  questionEl.textContent = payload.question;
  optionsEl.replaceChildren();
  for (const opt of payload.options.slice(0, 4)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ask-option-btn';
    const label = document.createElement('span');
    label.className = 'ask-option-label';
    label.textContent = opt.label;
    btn.appendChild(label);
    if (opt.description) {
      const desc = document.createElement('span');
      desc.className = 'ask-option-desc';
      desc.textContent = opt.description;
      btn.appendChild(desc);
    }
    btn.addEventListener('click', () => {
      void bridge.askAnswer({ id: payload.id, selected: [opt.label] }).catch(() => undefined);
      hideAskBox();
    });
    optionsEl.appendChild(btn);
  }
  input.value = '';
  box.hidden = false;
  box.setAttribute('aria-hidden', 'false');
  // 弹窗即"暂停"：思考浮窗切成等待态，并在记录里留一行，避免看起来还在自顾自思考
  setThinkWaiting(true);
  pushThinkLine({ kind: 'tool', text: `⏸ 暂停，等待你确认：${String(payload.question ?? '').split('\n')[0]}` });
  window.setTimeout(() => {
    try {
      input.focus();
    } catch { /* ignore */ }
  }, 60);
}

function installAskBox(bridge: RendererBridge): void {
  bridge.onAskQuestion?.((payload) => {
    showAskBox(bridge, payload);
    return hideAskBox;
  });
  // 提问超时/失效：主进程会推 cancel，这里收起弹窗并结束等待态（否则弹窗会一直留在屏幕上）
  bridge.onAskCancel?.(() => hideAskBox());
  const input = elementById<HTMLInputElement>('ask-input');
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const box = elementById<HTMLElement>('ask-box');
      const id = box?.dataset.questionId;
      const text = input.value.trim();
      if (id && text) {
        void bridge.askAnswer({ id, text }).catch(() => undefined);
        hideAskBox();
      }
    }
  });
}

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
    const nextTop = Math.min(Math.max(4, rect.top + (e.clientY - lastY)), Math.max(4, window.innerHeight - 40));
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

function installSettingsUi(bridge: RendererBridge): void {
  settingsBridge = bridge;
  const menu = elementById<HTMLElement>('context-menu');

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

/* ================================================================
   10. 初始化
   ================================================================ */

/* ---------- 10.1 独立聊天窗口模式（?panel=chat）----------
   同一个 index.html 被主进程以 ?panel=chat 打开时，只跑对话面板：
   不初始化 Live2D / 不做视线跟随 / 不挂右键菜单，模型永远留在桌宠窗口里。
   这样"对话框"物理上就在模型窗口之外，不可能遮挡模型。 */

/** 对话面板专用的推送订阅（只接对话流；气泡/模型动作/窗口监测一概不接） */
function subscribeChatPanelPushes(bridge: RendererBridge): void {
  if (typeof bridge.onChat !== 'function') return;
  bridge.onChat((payload) => {
    if (payload && typeof payload.delta === 'string') {
      feedChatDelta(payload.delta);
      return;
    }
    if (payload && typeof payload.full === 'string') {
      // 整段结束才落盘（流式过程中那一行不逐段持久化）
      if (!streamRowEl) streamRowEl = appendChatLog('pet', '', { persist: false });
      const streamText = streamRowEl?.querySelector('.chat-text');
      if (streamText) streamText.textContent = payload.full;
      streamRowEl = null;
      streamDone = true;
      void bridge.chatLogAppend?.({ role: 'pet', text: payload.full, at: Date.now() }).catch(() => undefined);
      setChatTyping(false);
      chatScrollToEnd();
    } else if (payload && typeof payload.message === 'string') {
      appendChatLog('error', payload.message);
      setChatTyping(false);
      streamDone = true;
      if (typeTimer) {
        window.clearTimeout(typeTimer);
        typeTimer = null;
      }
    }
  });
}

/** 对话面板 UI：发送 / Enter 发送 / Esc 收起气泡窗 */
function installChatPanelUi(bridge: RendererBridge): void {
  elementById<HTMLButtonElement>('chat-send')?.addEventListener('click', () => {
    void sendChat(bridge);
  });
  elementById<HTMLInputElement>('chat-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void sendChat(bridge);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      void collapseChatSurface(bridge);
    }
  });
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (elementById<HTMLElement>('chat-menu')?.hidden === false) {
      closeChatMenu(); // 菜单开着时 Esc 只收菜单
      return;
    }
    void collapseChatSurface(bridge);
  });
}

/** 收起对话界面：气泡窗模式 → 隐藏气泡窗；桌宠窗口内的回退输入条 → 收起输入条 */
async function collapseChatSurface(bridge: RendererBridge): Promise<void> {
  closeChatMenu();
  if (CHAT_PANEL_MODE) {
    await bridge.chatWindowClose?.();
    return;
  }
  hideChatBar();
}

/** 思考浮窗当前是开是关（由主进程推送，用于 ＋ 菜单里的状态显示） */
let thinkWindowOpen = false;

/** 打开/收起思考浮窗（＋ 菜单里的「🧠 思考浮窗」） */
async function toggleThinkWindow(bridge: RendererBridge): Promise<void> {
  try {
    if (thinkWindowOpen) {
      await bridge.thinkWindowHide?.();
      thinkWindowOpen = false;
      setChatToolbarStatus('思考浮窗已收起');
    } else {
      await bridge.thinkWindowShow?.();
      thinkWindowOpen = true;
      setChatToolbarStatus('思考浮窗已打开');
    }
  } catch (err) {
    setChatToolbarStatus(`思考浮窗操作失败：${(err as Error).message ?? String(err)}`, true);
  }
}

/** 展开/收起历史对话列表（＋ 菜单里的「🕘 历史对话」） */
async function toggleHistoryList(bridge: RendererBridge): Promise<void> {
  if (!chatHistoryEl) return;
  if (chatHistoryEl.hidden) {
    try {
      const snap = await bridge.chatLogGet?.();
      chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : chatSessions;
    } catch {
      /* 拿不到最新摘要就用已有列表兜底 */
    }
    renderChatHistoryList();
  }
  chatHistoryEl.hidden = !chatHistoryEl.hidden;
}

/**
 * 面板窗口标题：跟随"当前默认模型"，工程内不写死任何模型名。
 * 用 modelList()[0] 是有依据的——主进程自己就用它当默认模型
 * （见 mainImpl 的 `resolver.modelList()[0] || 'character'`），且该 IPC 无副作用。
 * 没有模型（空框架首次运行）时保留通用标题，不会显示成 "undefined · 对话"。
 */
async function applyPanelTitle(bridge: RendererBridge, kind: string): Promise<void> {
  document.title = kind;
  try {
    const names = await bridge.modelList();
    const first = names.find((n) => typeof n === 'string' && n.trim());
    if (first) document.title = `${first} · ${kind}`;
  } catch {
    /* 拿不到模型列表就保留通用标题 */
  }
}

async function initChatPanel(): Promise<void> {
  document.body.classList.add('is-chat-window');
  // 气泡尾巴朝向由主进程按"气泡在桌宠上/下/旁边"决定（决定 CSS 画朝下还是朝上的小三角）
  const tail = new URLSearchParams(window.location.search).get('tail');
  document.body.dataset.tail = tail === 'up' || tail === 'none' ? tail : 'down';
  document.title = '对话';
  // 只取聊天相关 DOM（#stage/#bubble 仍在页面上但被 CSS 隐藏，流式打字逻辑照旧可用）
  grabElements();

  const bridge = await waitForElectron();
  if (bridge) void applyPanelTitle(bridge, '对话');
  if (!bridge) {
    console.error('[renderer] 气泡窗未检测到 window.electron —— preload 未注入');
    const log = chatLogEl;
    if (log) {
      const row = document.createElement('div');
      row.className = 'chat-row is-error';
      const body = document.createElement('span');
      body.className = 'chat-text';
      body.textContent = '渲染进程未接入 Electron（preload 未注入），对话气泡窗无法工作。';
      row.appendChild(body);
      log.appendChild(row);
    }
    return;
  }

  chatBridge = bridge;
  subscribeChatPanelPushes(bridge);
  bridge.onThinkWindowState?.((payload) => {
    thinkWindowOpen = Boolean(payload && payload.open);
  });
  installAskBox(bridge); // 提问/写操作确认：有可见气泡窗时主进程会弹到这里
  installChatToolbar(bridge); // ＋ 菜单（新对话 / 历史 / 思考浮窗 / 收起）
  installChatPanelUi(bridge);
  installVoiceInput(); // 按住说话 → 转写 → 填入输入框（不自动发送）
  installChatRowRetry(); // 失败行走"点一行重填"（不自动重发）
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    installDebugHooks(bridge);
  }
  void loadChatLog(bridge);
  showChatBar(); // 常驻展开 + 聚焦输入框
}

/* ---------- 10.2 思考浮窗模式（?panel=think）----------
   桌面上的独立浮窗：只显示思考过程与任务进度清单。
   主进程在"用户提问"时自动打开、AI 答完 2.5s 后自动收起；这里只管渲染与手动关闭。 */
async function initThinkPanelWindow(): Promise<void> {
  document.body.classList.add('is-think-window');
  document.title = '思考过程';
  grabElements();

  const bridge = await waitForElectron();
  if (bridge) void applyPanelTitle(bridge, '思考过程');
  const list = elementById<HTMLElement>('think-list');
  if (!bridge) {
    console.error('[renderer] 思考浮窗未检测到 window.electron —— preload 未注入');
    if (list) list.textContent = '渲染进程未接入 Electron（preload 未注入），思考浮窗无法工作。';
    return;
  }

  chatSessionOpen = true; // 允许 pushThinkLine 正常渲染（它默认只在对话打开时才画）
  bridge.onThink?.((evt) => {
    pushThinkLine(evt);
    return hideThinkPanel;
  });
  bridge.onPlan?.((payload) => renderPlan(payload?.items));
  elementById<HTMLButtonElement>('think-close')?.addEventListener('click', () => {
    void bridge.thinkWindowHide?.();
  });
  elementById<HTMLButtonElement>('think-capsule')?.addEventListener('click', expandThinkPanel);
  openThinkWithChat(); // 打开即展开并显示待命标题
  const panel = elementById<HTMLElement>('think-panel');
  if (panel) {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
  }
}

/**
 * 控制台调试钩子（可选，不影响主流程）。
 * 角色窗与气泡窗都会调用它——气泡窗才有对话 DOM，之前的 chatDemo/voiceLab 只在角色窗可用，
 * 导致"在气泡窗里验证气泡 UI"做不到（踩过一次，故抽成函数两处共用）。
 */
function installDebugHooks(bridge: RendererBridge): void {
  (window as Any).__petDebug = {
    showBubble,
    speak: (text: string) => showBubble(text),
    send: (text: string) => bridge.sendMessage(text).catch((e) => console.warn('[renderer] sendMessage 失败', e)),
    reload: () => window.location.reload(),
    // 取景（全身/半身）与角色可见范围：给"跟手/取景"这类几何问题做实测用
    framing: (mode: string) => applyFraming(mode === 'half' ? 'half' : 'full'),
    framingMode: () => currentFraming,
    // 模型体检结果（能渲染 / 有警告 / 不能渲染 + 原因 + 怎么办）：调试与自动化验证用
    modelCompat: () => activeModelCompat,
    // moc3 挂载内部状态（尺寸/缩放/画布像素/参数容器）：换运行库排查"画不出来"时用
    moc3Debug: () => (currentHandle && typeof currentHandle.debug === 'function' ? currentHandle.debug() : null),
    bounds: () => currentHandle?.bounds?.() ?? null,
    // 追踪参数层（骨骼/表情/语音口型）：调试与自动化验证用
    tracking: () => currentTrackingApi?.state() ?? null,
    pushTracking: (frame: TrackingInput, source = 'debug') => pushTrackingFrame(source, frame),
    emotion: (text: string) => applyEmotionFromText(text),
    speech: (openY: number, ttlMs = 400) => pushSpeechMouth({ openY }, ttlMs),
    /**
     * 点击穿透的命中判定：供 GPU 审计与自动化验证直接问"这个点算不算在角色身上"。
     * 返回 ok=false 表示遮罩还没有可靠数据（此时调用方不该拦截鼠标）。
     */
    hitTest: (clientX: number, clientY: number) =>
      currentHandle && typeof currentHandle.hitTest === 'function'
        ? currentHandle.hitTest(clientX, clientY)
        : { ok: false, hit: false },
    refreshHitMask: () => (currentHandle && typeof currentHandle.refreshHitMask === 'function' ? currentHandle.refreshHitMask() : false),
    /**
     * 命中遮罩的统计（不透明像素数与包围盒，归一化 0..1）。
     * 用来客观判断遮罩形状是否与画面一致：bbox 为空或极小 = 取样没拿到内容。
     */
    /** 模型内容包围盒（顶点实测）：判断缩放基准是否与实际内容相符 */
    contentBounds: () =>
      currentHandle && typeof currentHandle.contentBounds === 'function' ? currentHandle.contentBounds() : null,
    /** 窗口内是否有覆盖层面板打开（设置/待办/菜单/思考浮窗）：穿透判定与自动化验证用 */
    overlayOpen: () => hasOpenOverlay(),
    /** 打开设置面板（自动化验证"面板打开时应保持可交互"用） */
    openSettings: () => openSettings(bridge),
    /** 关闭设置面板 */
    closeSettings: () => closeSettings(),
    hitMaskStats: () =>
      currentHandle && typeof currentHandle.hitMaskStats === 'function' ? currentHandle.hitMaskStats() : null,
    // 语音输入：状态机自检/自动化验证用（不触发真实录音时只读状态）
    voice: () => ({
      state: voiceState,
      micApi: typeof navigator !== 'undefined' && !!navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function',
      recorder: typeof MediaRecorder !== 'undefined',
      wakeWordSupported: false,
    }),
    voiceCancel: () => finishVoiceCapture(true),
    /**
     * 只用于视觉验证：往对话里插几条"演示行"（user / pet / tool / failed 各一条）+ 驱动声纹。
     * persist:false —— **不写聊天记录**，纯 UI 展示，刷新就没了。
     */
    chatDemo: (): number => {
      if (!chatLogEl) return 0;
      const u = appendChatLog('user', '帮我把这段代码里的超时改成按工具类型区分', { persist: false });
      appendChatLog('pet', '改好了：读类工具 10s、需要确认的写操作 150s、shell 330s。', { persist: false });
      appendChatLog('tool', '已编辑 src/main/ai/chatClient.ts（+12 −4）', { persist: false });
      const failed = appendChatLog('user', '再帮我跑一遍完整测试', { persist: false });
      markUserRowFailed(failed, '消息未送达');
      markUserRowSent(u);
      const wave = (window as Any).PetVoiceLab;
      if (wave && typeof wave.begin === 'function') {
        const token = wave.begin({ label: '正在连接语音' });
        let now = performance.now();
        // 填满 40 点窗口（否则左边是空的、右边一个包，看起来像"箭头"而不是波形）
        for (let i = 0; i < 40; i += 1) {
          const rms = 0.06 + 0.4 * Math.abs(Math.sin(i * 0.45)) * (1 - i / 80);
          wave.level(token, rms, Math.min(1, rms * 1.6));
          now += 60;
          wave.__tick(now);
        }
      } else {
        setVoiceRow('语音输入 · 准备中');
      }
      chatScrollToEnd();
      return chatLogEl.querySelectorAll('.chat-row').length;
    },
    /** 声纹当前状态（自动化验证用） */
    voiceLab: () => voiceLab()?.state() ?? null,
    // 参数映射（pet-model.json 的 parameterMap）：运行时改一下，验证"命名不标准的模型"这条路
    setParamMap: (map: Record<string, string>) => currentHandle?.setParameterMap?.(map) ?? null,
    paramInfo: () => currentHandle?.parameterInfo?.() ?? null,
    // 模型预设（pet-model.json 的 emotionMap）：运行时改映射，便于验证"情绪→本模型表情"这条路
    emotionMap: (map?: Record<string, string>) => {
      if (map && typeof map === 'object') {
        activeModelPreset = { ...(activeModelPreset ?? {}), emotionMap: map };
      }
      return activeModelPreset?.emotionMap ?? null;
    },
    expressions: () => currentHandle?.listExpressions?.() ?? [],
  };
}

async function init(): Promise<void> {
  if (CHAT_PANEL_MODE) {
    await initChatPanel();
    return;
  }
  if (THINK_PANEL_MODE) {
    await initThinkPanelWindow();
    return;
  }
  if (!grabElements()) {
    return;
  }
  startLoop();
  installVisibilityHooks();
  installIdleHooks(); // 空闲降帧：无交互一段时间后把帧上限降到 24fps

  const bridge = await waitForElectron();
  if (!bridge) {
    // 非 Electron / preload 未注入：给出可见提示并显示占位，避免黑屏无反馈
    console.error('[renderer] 未检测到 window.electron —— preload 未注入或不在 Electron 中运行');
    showBubble('渲染进程未接入 Electron（preload 未注入）。请在主进程中以 loadFile 方式加载本页。', {
      tone: 'error',
      ttlMs: 6000,
    });
    mountBootPlaceholder('未检测到 Electron preload');
    setStatus('electron 未就绪');
    return;
  }

  installDebugHooks(bridge);

  subscribeWindowChanges(bridge);
  chatBridge = bridge; // 聊天记录持久化用
  installTrackingHub(); // 追踪参数中枢（语音口型 + 文本情感；骨骼/外部追踪预留入口）
  subscribeOptionalPushes(bridge);
  void loadChatLog(bridge); // 渲染历史对话（重启后还能回看）
  installGazeTracking();
  installWindowInteractions(bridge); // 拖拽移动窗口 + 滚轮缩放
  installDropTarget(bridge); // 拖放模型/插件文件夹到桌宠身上即可加入
  installClickThroughBridge(bridge); // 点击穿透的命中判定（主进程负责真正 setIgnoreMouseEvents）
  installTodoPanel(bridge); // 待办笔记本面板
  installAskBox(bridge); // AI 提问框（ask_user 工具）
  installThinkPanel(bridge); // 思考过程浮窗
  installChatToolbar(bridge); // 新对话 / 历史对话
  installVoiceInput(); // 按住说话 → 转写 → 填入输入框（不自动发送）
  installChatRowRetry(); // 失败行走"点一行重填"（不自动重发）
  installSettingsUi(bridge);

  bootRecord('bridge 就绪');
  const manifest = await loadDefaultModel(bridge);
  bootRecord('拿到模型 manifest');
  if (manifest) {
    await mountManifest(manifest);
    bootRecord('模型挂载完成');
    applyPresetParameterMap(); // pet-model.json 的 parameterMap（命名不标准的模型靠它对齐）
    // 报告角色实际可见范围：立刻一次 + live2d 二次 refit（250/900ms）之后再补两次
    reportPetBounds(bridge);
    window.setTimeout(() => reportPetBounds(bridge), 1300);
    window.setTimeout(() => reportPetBounds(bridge), 2800);
    // 启动时按设置应用「取景（全身/半身）」与音效参数——不打开设置页也要生效
    try {
      const bootSettings = await bridge.getSettings();
      // 取景优先级：用户在设置里选过 → 用它；没选过 → 用模型预设（pet-model.json）；都没有 → full
      const chosen = bootSettings.displayMode === 'half' ? 'half' : bootSettings.displayMode === 'full' ? 'full' : null;
      applyFraming(chosen ?? (activeModelPreset?.framing === 'half' ? 'half' : 'full'));
      applySfxSettings(bootSettings);
      bootRecord('设置应用完成（角色可见）');
    } catch (err) {
      console.warn('[renderer] 启动时应用设置失败（用默认值）', err);
    }
  } else {
    // 现在项目**不内置模型**：首次运行模型表本来就是空的 → 给可操作的引导，而不是报错
    const emptyHint = '还没有模型：右键桌宠 → 设置 → 📂 打开模型文件夹，把模型文件夹放进去；或点「＋ 添加模型…」选一个现成目录。';
    showBubble(emptyHint, { tone: 'info', ttlMs: 9000 });
    mountBootPlaceholder('还没有模型（模型放在本机用户数据里，不再随包内置）');
    setStatus('还没有模型');
  }
}

/* 页面脚本位于 body 末尾，但保险起见仍等 DOM ready */
function boot(): void {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { void init(); });
  } else {
    void init();
  }
}
boot();
