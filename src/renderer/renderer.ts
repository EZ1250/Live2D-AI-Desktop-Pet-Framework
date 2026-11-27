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
type VtsStatusDto = import('../shared/contracts').VtsStatusDto;
type VtsTrackingValues = import('../shared/contracts').VtsTrackingValues;
type VtsEventDto = import('../shared/contracts').VtsEventDto;
type TtsAudioPayload = import('../shared/contracts').TtsAudioPayload;
type UpdateSnapshot = import('../shared/contracts').UpdateSnapshot;

/** 渲染层微内核（kernel.js 暴露；缺失时返回 null，调用方自行降级） */
interface RendererKernelHandle {
  provide(name: string, impl: unknown): void;
  setActionBridge(bridge: (action: string, payload: Any) => void): void;
  emit(event: string, payload: Any): void;
  call<T = unknown>(name: string, ...args: Any[]): T | null;
  start(): Promise<void>;
}
function rendererKernel(): RendererKernelHandle | null {
  return ((window as Any).PetKernel as RendererKernelHandle | undefined) ?? null;
}

/* ================================================================
   1. 内部类型与常量
   ================================================================ */

/** live2d.ts 暴露的全局渲染库（见 ./live2d.ts 底部 window.PetLive2d） */
interface RenderLib {
  isLive2DAvailable(): boolean;
  mountLive2D(input: { container: HTMLElement; url: string }): Promise<RenderHandle | null>;
  mountPortrait(input: { container: HTMLElement; url: string; fit?: 'contain' | 'framing' }): RenderHandle | null;
  mountPlaceholder(input: { container: HTMLElement; name: string; hint?: string }): RenderHandle | null;
}

/** 对话/气泡出现时按设置自动朗读；每次生成新的 requestId，旧音频由 playTtsAudio 丢弃 */
function speakConversation(bridge: RendererBridge, text: string): void {
  const clean = text.trim();
  if (!ttsEnabled || !clean || typeof bridge.ttsSpeak !== 'function') return;
  // 与主进程 edgeTts.MAX_TEXT_CHARS 对齐：超长整段合成会直接失败，这里先截断并留一条日志
  const speakable = clean.length > TTS_MAX_CHARS ? clean.slice(0, TTS_MAX_CHARS) : clean;
  if (speakable.length < clean.length) {
    console.warn(`[renderer] 回复过长（${clean.length} 字），自动朗读只读前 ${TTS_MAX_CHARS} 字`);
  }
  const requestId = beginTtsRequest();
  void bridge.ttsSpeak(speakable, ttsVoice, requestId).catch((err: unknown) => {
    console.warn('[renderer] 自动朗读失败', err);
  });
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
  /** 当前模型可用动作组名（无动作 → []） */
  listMotions?(): string[];
  /** 调试：.vtube.json 参数映射/待机组是否加载 */
  vtsDebug?(): Any;
  /** 视线目标 nx/ny ∈[-1,1]，向右/向上为正；0 = 归位 */
  setGaze?(nx: number, ny: number): void;
  gazeOriginRatio?(): number | null;
  debugSetParam?(id: string, value: number): number | null;
  /** SDK 内置 FocusController 指针喂入（画布局部坐标，可窗口外） */
  focusAt?(clientX: number, clientY: number): boolean;
  /** SDK 视线回正 */
  resetFocus?(): boolean;
  /** 视线跟踪自查（目标值 / 平滑值 / 实际写进模型的参数）：排查"不跟鼠标"用 */
  gaze?(): Any;
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
/** 气泡停留时长下限 */
const MIN_BUBBLE_TTL_MS = 3000;
/** 气泡停留时长上限（用户要求区间 3–300s） */
const MAX_BUBBLE_TTL_MS = 300_000;
/** 阅读速度折算：每字多留 ms（约 6.7 字/秒） */
const BUBBLE_TTL_PER_CHAR_MS = 150;

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
/** 本轮气泡的 ttlMs 是否由调用方显式指定（显式值原样夹取，否则按内容长度自适应） */
let ttlExplicit = false;
let bubbleTone: 'info' | 'error' = 'info';
/** 用户正在看/操作气泡（悬停、点击、滚动）→ 暂停 TTL 自动隐藏 */
let bubbleHeld = false;
/** 是否正在拖动桌宠（点击穿透判定要避让：拖拽期间整窗保持可交互） */
let petDragging = false;

/** 气泡停留时长：显式值夹取到 [3s,300s]；未指定则按内容长度自适应 */
function computeBubbleTtl(text: string, explicitMs?: number): number {
  const raw = explicitMs ?? MIN_BUBBLE_TTL_MS + text.length * BUBBLE_TTL_PER_CHAR_MS;
  return Math.min(MAX_BUBBLE_TTL_MS, Math.max(MIN_BUBBLE_TTL_MS, raw));
}

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
  bubbleHeld = false;
  clearBubbleTimers();
  stopSpeechMouth(); // 气泡收起 → 口型立刻收回（看不到"静音还在动嘴"）
  typewriterActive = false;
  if (bubbleEl) bubbleEl.classList.remove('is-visible', 'is-typing');
}

/** 气泡被悬停/点击/滚动：暂停自动隐藏，让用户能读完/滚动长回复 */
function holdBubble(): void {
  if (!bubbleEl || !bubbleEl.classList.contains('is-visible')) return;
  bubbleHeld = true;
  if (hideTimer) {
    window.clearTimeout(hideTimer);
    hideTimer = 0;
  }
}

/** 移开气泡：没在打字就按内容长度重新开始倒计时 */
function releaseBubbleHold(): void {
  if (!bubbleHeld) return;
  bubbleHeld = false;
  if (!bubbleEl || !bubbleEl.classList.contains('is-visible')) return;
  if (typeTimer || !streamBuffer) return;
  hideTimer = window.setTimeout(hideBubble, computeBubbleTtl(streamBuffer, ttlExplicit ? streamTTL : undefined));
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
  // 打完：移除光标，TTL 后隐藏（时长按内容长度自适应，钳在 3–300s）
  typewriterActive = false;
  typeTimer = 0; // 关键：本轮定时器已自然结束，必须归零；否则 feedChatDelta 里 `if (!typeTimer)` 永远为假，后续流式增量再也打不出来
  window.setTimeout(stopSpeechMouth, 320); // 说完留一拍再闭嘴（与下面 TTL 淡出衔接）
  if (bubbleEl) bubbleEl.classList.remove('is-typing');
  if (!bubbleHeld)
    hideTimer = window.setTimeout(hideBubble, computeBubbleTtl(streamBuffer, ttlExplicit ? streamTTL : undefined));
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
  ttlExplicit = opts?.ttlMs !== undefined;
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
    if (!bubbleHeld)
      hideTimer = window.setTimeout(hideBubble, computeBubbleTtl(text, ttlExplicit ? streamTTL : undefined));
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
    streamTTL = DEFAULT_TTL_MS;
    ttlExplicit = false;
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

function libMountPortrait(url: string, name: string, fit?: 'contain' | 'framing'): RenderHandle | null {
  if (!stageEl) return null;
  const lib = getRenderLib();
  if (lib) return lib.mountPortrait({ container: stageEl, url, fit });
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
  // ⚠️ 这里**不要**刷新"行为触发"下拉：此时 currentHandle 还是 null（模型正在挂载），
  // listMotions/listExpressions 只能拿到空清单 → 已保存的绑定会被全部标成
  // 「（当前模型没有）」，而挂载完成后又没人再刷新，用户会以为"换模型绑定丢了/设置没记住"。
  // 正确的刷新点在挂载完成之后：调用方 `switchModel` / init 的启动设置块
  // 都会调 `loadBehaviorTriggers`（内部会 refreshMotionTriggerOptions + populateMotionTriggerSelects）。
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
      currentHandle = libMountPortrait(url, name, activeModelPreset?.portraitFit);
      showBubble(`嗨，我是 ${petName || name}！`, { ttlMs: 3000 });
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
    if (typeof manifest.mocVersion === 'number' && manifest.mocVersion > (compat?.coreMax ?? 5)) {
      currentHandle = libMountPlaceholder(
        name,
        `模型为 moc3 v${manifest.mocVersion}，当前运行库最高支持 moc3 v${compat?.coreMax ?? 5}。请用更低版本导出后重新导入。`,
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
        showBubble(`嗨，我是 ${petName || name}！`, { ttlMs: 3000 });
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
      currentHandle = libMountPortrait(preview, name, activeModelPreset?.portraitFit);
      showBubble(`${name}（moc3 暂不可用，以预览图显示）`, { tone: 'info', ttlMs: 3600 });
    } else {
      currentHandle = libMountPlaceholder(name, `当前环境无法渲染 Live2D(moc3)。${fallbackReason}`);
    }
    flashStatus(`${name} 就绪`);
    return;
  }

  // 未知 type：按“能显示就行”的底线处理
  if (url && /\.(png|jpe?g|webp|gif|svg)($|\?)/i.test(url)) {
    currentHandle = libMountPortrait(url, name, activeModelPreset?.portraitFit);
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
    gazeApi()?.tick(nowMs); // 先喂视线目标，handle.update 内做平滑插值
    // VTS 追踪推送不在这里：它由独立的 33ms 定时器驱动（不受本循环的空闲降帧影响，
    // 见 setVtsTrackingEnabled / startVtsPushTimer）
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
   —— 状态与换算逻辑已抽到 gazeController.ts（全局脚本 window.PetGaze）；
      这里只保留事件接线与"当前取景 / 当前 handle"的注入，行为不变。
   ================================================================ */

/** gazeController.ts 暴露的全局视线模块（见 ./gazeController.ts 底部 window.PetGaze） */
interface GazeApi {
  /** 窗口内指针（pointermove）→ 归一化视线目标 */
  setPointer(clientX: number, clientY: number): void;
  /** 主进程推来的全局光标（屏幕 DIP 坐标）→ 归一化视线目标 */
  setGlobal(screenX: number, screenY: number): void;
  /** 主循环每帧调用：喂视线目标 / 静止归零 */
  tick(nowMs: number): void;
  /** 暂停跟随（鼠标离开窗口 / 拖拽窗口期间）；force=true 时忽略全局光标保护 */
  pause(force?: boolean): void;
  /** 渲染层换算结果快照（__petDebug.gaze() 的 renderer 段） */
  state(): { nx: number; ny: number; stale: boolean; sinceMoveMs: number | null; globalCursorPushes: number; sinceGlobalMs: number | null };
  /** 视线驱动模式自查（__petDebug.gazeMode() 委托它） */
  debug(): { sdkFocusActive: boolean; globalCursorPushes: number; sdkFocusFailures: number };
  /** 注入当前取景（全身/半身）的 getter */
  setFramingGetter(fn: () => 'full' | 'half'): void;
  /** 注入当前渲染 handle 的 getter（换模型无需重新注入） */
  setHandleGetter(fn: () => RenderHandle | null): void;
}

function gazeApi(): GazeApi | null {
  const g = (window as Any).PetGaze;
  return g && typeof g.setPointer === 'function' ? (g as GazeApi) : null;
}

/** 初始化视线模块：注入取景/handle getter（必须先于主循环与事件接线） */
function installGazeController(): void {
  const g = gazeApi();
  if (!g) return;
  g.setFramingGetter(() => currentFraming);
  g.setHandleGetter(() => currentHandle);
}

function installGazeTracking(): void {
  window.addEventListener('pointermove', (e) => gazeApi()?.setPointer(e.clientX, e.clientY), { passive: true });
  // 鼠标离开窗口：视线不再更新，主循环里走“缓缓归零”分支
  window.addEventListener('mouseleave', () => { gazeApi()?.pause(); });
}

/* ================================================================
   7.52 VTube Studio 可选后端：视线 → 追踪参数（~30fps 发给主进程）
   —— 只发**追踪参数**（FaceAngleX/EyeLeftX...），由 VTS 自己映射到模型参数；
      直接注入 ParamAngleX 这类模型参数会被 VTS 以 #453 拒绝。
   —— 只在设置里启用 VTS 时才发；主进程那边未连接/未授权会静默丢弃。
   ================================================================ */

/** 注入节流：33ms ≈ 30fps（VTS 侧也只认"最新一帧"，再快没有意义） */
const VTS_PUSH_INTERVAL_MS = 33;
/** 视线 → 头部转角的增益（VTS 的 FaceAngleX/Y 范围是 -30..30 度） */
const VTS_FACE_ANGLE_GAIN = 30;
/** 视线 → 眼球位移的增益（EyeLeftX/Y 范围 -1..1；0.6 保留一点余量，别让眼球顶死） */
const VTS_EYE_GAIN = 0.6;

let vtsTrackingEnabled = false;
let vtsTrackingBridge: RendererBridge | null = null;
/**
 * VTS 推送定时器（33ms）。
 *
 * **不能挂在主循环里**：主循环空闲时会降到 24fps（41.7ms/帧），VTS 虽然还能收到，
 * 但"设置页里说 30fps、实际是 24fps"会给排障添乱；而且文档隐藏时 RAF 会停。
 * 这里用独立 setInterval：启用 VTS 就固定 33ms 发一帧（值可以是全 0，静止时也发）。
 */
let vtsPushTimer: number | null = null;
/** VTS 是否真的连着（未连接时不发追踪帧，省 CPU/IPC） */
let vtsConnected = false;
let vtsProbeTimer: number | null = null;
/** 自查计数：已发出的帧数 / 最后一帧 / 最后发送时刻 / 发送异常（__petDebug.vts() 用） */
let vtsSentCount = 0;
let vtsLastSent: VtsTrackingValues | null = null;
let vtsLastSentAt = 0;
let vtsLastSendError = '';

/** 打开/关闭 VTS 追踪推送（设置里勾「启用 VTS」并保存后生效；启动时按设置应用一次） */
function setVtsTrackingEnabled(on: boolean): void {
  vtsTrackingEnabled = on === true;
  if (vtsTrackingEnabled) {
    refreshVtsConnection();
    if (vtsProbeTimer === null) {
      vtsProbeTimer = window.setInterval(refreshVtsConnection, 5000) as unknown as number;
    }
    startVtsPushTimer();
  } else {
    stopVtsPushTimer();
    if (vtsProbeTimer !== null) {
      window.clearInterval(vtsProbeTimer);
      vtsProbeTimer = null;
    }
    vtsConnected = false;
  }
}

/**
 * VTS 连接状态探测：**没连接/没授权就不发 30fps 追踪帧**（之前即使 VTS 没开也在发 IPC，
 * 主进程只会丢弃；省掉 30 次/秒的序列化与进程间通信）。连接后 5s 内自动恢复推送。
 */
function refreshVtsConnection(): void {
  const bridge = vtsTrackingBridge;
  if (!bridge || typeof bridge.vtsStatus !== 'function') return;
  void bridge
    .vtsStatus()
    .then((status) => {
      vtsConnected = !!status && status.connected === true && status.authenticated === true;
    })
    .catch(() => {
      vtsConnected = false;
    });
}

function startVtsPushTimer(): void {
  if (vtsPushTimer !== null) return;
  vtsPushTimer = window.setInterval(pushVtsTracking, VTS_PUSH_INTERVAL_MS) as unknown as number;
}

function stopVtsPushTimer(): void {
  if (vtsPushTimer === null) return;
  window.clearInterval(vtsPushTimer);
  vtsPushTimer = null;
}

/** 归一化视线 [-1,1] → 一帧 VTS 追踪值（只含可算的字段） */
function gazeToVtsTracking(nx: number, ny: number): VtsTrackingValues {
  const x = Math.max(-1, Math.min(1, Number.isFinite(nx) ? nx : 0));
  const y = Math.max(-1, Math.min(1, Number.isFinite(ny) ? ny : 0));
  return {
    faceAngleX: x * VTS_FACE_ANGLE_GAIN,
    faceAngleY: y * VTS_FACE_ANGLE_GAIN,
    eyeLeftX: x * VTS_EYE_GAIN,
    eyeLeftY: y * VTS_EYE_GAIN,
    eyeRightX: x * VTS_EYE_GAIN,
    eyeRightY: y * VTS_EYE_GAIN,
  };
}

/**
 * 定时器每 33ms 调一次：启用且 bridge 可用就把当前视线换算成追踪参数发出去（fire-and-forget）。
 * 视线"静止过期"时发全 0 —— 与桌宠自己回正一致，也保证 VTS 侧不会一直歪着头。
 */
function pushVtsTracking(): void {
  if (!vtsTrackingEnabled || !vtsConnected) return; // 未连接：不发（5s 探测一次，连上自动恢复）
  const bridge = vtsTrackingBridge;
  if (!bridge || typeof bridge.sendVtsTracking !== 'function') return;
  const gaze = gazeApi()?.state();
  const values = gaze ? gazeToVtsTracking(gaze.stale ? 0 : gaze.nx, gaze.stale ? 0 : gaze.ny) : gazeToVtsTracking(0, 0);
  try {
    bridge.sendVtsTracking(values);
    vtsSentCount += 1;
    vtsLastSent = values;
    vtsLastSentAt = Date.now();
    vtsLastSendError = '';
  } catch (err) {
    /* 高频通道：发失败不能影响主循环，但要留痕给 __petDebug.vts() 自查 */
    vtsLastSendError = (err as Error)?.message ?? String(err);
  }
}

/** __petDebug.vts() 的快照：判断"渲染层到底有没有在发" */
function vtsDebugState(): Any {
  return {
    enabled: vtsTrackingEnabled,
    connected: vtsConnected,
    sentCount: vtsSentCount,
    lastSent: vtsLastSent,
    lastSentAt: vtsLastSentAt ? new Date(vtsLastSentAt).toISOString() : '',
    sinceLastMs: vtsLastSentAt ? Date.now() - vtsLastSentAt : null,
    lastError: vtsLastSendError,
    bridgeOk: !!vtsTrackingBridge && typeof vtsTrackingBridge.sendVtsTracking === 'function',
    timerRunning: vtsPushTimer !== null,
    intervalMs: VTS_PUSH_INTERVAL_MS,
    gaze: gazeApi()?.state() ?? null,
  };
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
  // 情绪字段也走这里：有 label 就交给 emotion 插件（阈值判断在插件里，表情应用走动作桥）
  if (frame && frame.emotion && typeof frame.emotion.label === 'string' && frame.emotion.label) {
    const conf = typeof frame.emotion.confidence === 'number' ? frame.emotion.confidence : 1;
    if (conf >= 0.34) {
      rendererKernel()?.emit('tracking:emotion', { label: frame.emotion.label, confidence: conf });
    }
  }
  h.applyTrackingFrame?.({ ...frame, source: frame?.source ?? 'external' });
  return true;
}

/** 语音口型：给"说话中"的时序用（打字机/Motion/外部 TTS 都调它） */
function pushSpeechMouth(mouth: { openY?: number; form?: number }, ttlMs = 220): void {
  // TTS 音频播放期间由 ttsMouth.ts 独占口型层：否则打字机每 90ms 的写入会和音频节拍互相覆盖。
  if (ttsMouthActive()) return;
  trackingHandle()?.applySpeech?.(mouth, ttlMs);
}

/** TTS 本地口型是否正在播（ttsMouth.ts 不存在时恒为 false） */
function ttsMouthActive(): boolean {
  const driver = ttsMouthDriver;
  if (!driver) return false;
  try {
    return driver.state().active;
  } catch {
    return false;
  }
}

/** 情绪标签 → 模型表情（pet-model.json 的 emotionMap 优先）；返回实际应用的表情名 */
function applyEmotionLabel(label: string): string | null {
  if (!trackingEnabled) return null;
  const h = trackingHandle();
  if (!h || typeof h.applyEmotionLabel !== 'function') return null;
  const mapped = activeModelPreset?.emotionMap?.[label];
  const applied = h.applyEmotionLabel(label, typeof mapped === 'string' ? mapped : undefined);
  if (applied) lastEmotion = { label, expression: applied, at: Date.now() };
  return applied;
}

/** 文本 → 情绪 → 表情：判定在 emotion 插件里，这里只转调（保住同步返回值给 petTracking/__petDebug） */
function applyEmotionFromText(text: string): string | null {
  return rendererKernel()?.call<string | null>('emotion.applyText', text) ?? null;
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

/**
 * 渲染层微内核接线：注册 render 服务与动作桥，再启动内置策略插件。
 * 必须在订阅推送之前完成，否则第一句对话的情绪事件会丢。
 */
async function installRendererKernel(): Promise<void> {
  const kernel = rendererKernel();
  if (!kernel) {
    console.warn('[renderer] 未加载 kernel.js：策略插件不可用，其余功能照常');
    return;
  }
  kernel.provide('render', {
    applyEmotion: applyEmotionLabel,
    ready: () => Boolean(currentHandle),
    playMotion: (name: string) => currentHandle?.playMotion?.(name),
    holdExpression: (name: string) => playBehaviorExpression(name),
  });
  // 模型能力只读服务：插件据此判断"目标在当前模型上存不存在"
  kernel.provide('model', {
    motions: listCurrentMotions,
    expressions: listCurrentExpressions,
    capabilities: () => activeModelCapabilities,
    emotionMap: () => activeModelPreset?.emotionMap ?? {},
  });
  kernel.setActionBridge((action, payload) => {
    if (action === 'expression') {
      const label = payload && typeof payload.label === 'string' ? payload.label : '';
      if (label && trackingEnabled) trackingHandle()?.applyEmotionLabel?.(label);
    } else if (action === 'motion') {
      const group = payload && typeof payload.group === 'string' ? payload.group : '';
      if (group) currentHandle?.playMotion?.(group);
    } else if (action === 'speak') {
      const text = payload && typeof payload.text === 'string' ? payload.text : '';
      if (text) showBubble(text);
    }
  });
  await kernel.start();
}

/* ================================================================
  7.6 拖拽移动窗口 + 滚轮缩放
   ================================================================ */
const DRAG_IGNORE_SELECTOR = '#bubble, #context-menu, #todo-panel, #ask-box, #think-panel, #settings-panel, #chatbar input, .chat-input, input, button, select, textarea';

/* ================================================================
   7.7 点击特效（实现在 fx.ts，挂 window.PetFx）
   ================================================================ */

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

/** 当前设置里的桌宠名字（空 = 用模型名）：问候语 / 输入框提示 / 控制台都用它 */
let petName = '';
/** 把桌宠名字应用到可见交互上（设置保存后立即生效） */
function applyPetName(next: string | undefined): void {
  petName = String(next ?? '').trim().slice(0, 24);
  const input = elementById<HTMLInputElement>('chat-input');
  if (input) input.placeholder = petName ? `和${petName}说点什么…` : '输入消息';
}

function installWindowInteractions(bridge: RendererBridge): void {
  // 气泡在模型之上：点它/划过它走气泡自己的逻辑（保持显示、滚动长文），不触发桌宠点击/拖拽/缩放
  if (bubbleEl) {
    bubbleEl.addEventListener('pointerenter', () => holdBubble());
    bubbleEl.addEventListener('pointerleave', () => releaseBubbleHold());
    bubbleEl.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      holdBubble();
    });
    bubbleEl.addEventListener('click', (e) => {
      e.stopPropagation();
      holdBubble();
    });
    bubbleEl.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }
  // —— 交互语料事件：单击 / 连点（>5 次）/ 长拖（>5s）→ 主进程按分组冷却出气泡 ——
  const CLICK_WINDOW_MS = 2500; // 连点统计窗口（超出就算新的一轮）
  const MULTI_CLICK_COUNT = 6; // "点击超过 5 次" = 第 6 次触发
  const LONG_DRAG_MS = 5000; // "拖动超过 5 秒"
  let clickTimes: number[] = [];
  let dragStartedAt = 0;
  let dragLongReported = false;
  /** 上报一次交互事件（主进程决定是否真的有语料/是否过了冷却） */
  const reportPetEvent = (type: 'click' | 'multiClick' | 'dragLong'): void => {
    try {
      bridge.petEvent?.(type);
    } catch (err) {
      console.warn('[renderer] 交互事件上报失败', type, err);
    }
  };
  // —— 滚轮缩放：档位 ±1（1.08^n），preventDefault 防页面/隐式滚动；拖拽期间忽略 ——
  let dragging = false;
  let moved = false; // 本次按下是否已超过 3px（用于区分"点击"与"拖拽"）
/** 「拖动」行为是否已在本次拖动中触发过（检测到拖动的瞬间就触发，不等松手） */
let dragBehaviorEmitted = false;
  let dragFrame = 0;
  let pendingDx = 0;
  let pendingDy = 0;
  window.addEventListener(
    'wheel',
    (e) => {
      if (dragging) return; // 拖拽过程中无视滚轮，避免误放大
      if ((e.target as Element)?.closest?.('#bubble, #todo-panel, #ask-box, #think-panel, #settings-panel, #context-menu, #chatbar')) return; // 气泡/面板区滚动不缩放
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
    petDragging = false;
    pendingDx = 0;
    pendingDy = 0;
    bridge.endWindowDrag();
  };
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t && t.closest && t.closest(DRAG_IGNORE_SELECTOR)) return; // 输入/菜单/设置区不拖
    dragging = true;
    petDragging = true;
    moved = false;
    dragBehaviorEmitted = false;
    dragStartedAt = performance.now();
    dragLongReported = false;
    lastDragX = e.screenX;
    lastDragY = e.screenY;
    gazeApi()?.pause(true); // 拖拽期间暂停视线跟随（不能被全局光标的边缘保护忽略）
  });
  document.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.screenX - lastDragX;
    const dy = e.screenY - lastDragY;
    // 3px 阈值：微动视为点击；超过才按增量连续移动
    if (Math.abs(dx) + Math.abs(dy) >= 3) {
      moved = true;
      // 「拖动」行为：检测到拖动的**瞬间**就触发（不等松手），一次拖动只触发一次
      if (!dragBehaviorEmitted) {
        dragBehaviorEmitted = true;
        emitBehavior('drag');
      }
      pendingDx += dx;
      pendingDy += dy;
      if (!dragFrame) dragFrame = window.requestAnimationFrame(flushDrag);
      lastDragX = e.screenX;
      lastDragY = e.screenY;
      // 拖动持续超过 5s → 报一次「拖动宠物」（同一次拖动只报一次，主进程还有 20s 冷却）
      if (!dragLongReported && performance.now() - dragStartedAt >= LONG_DRAG_MS) {
        dragLongReported = true;
        reportPetEvent('dragLong');
      }
    }
  });
  window.addEventListener('pointerup', (e) => {
    const wasDragging = dragging;
    const hasMoved = moved;
    endDrag();
    // 「拖动」行为已经在 pointermove 首次越过阈值时触发过；这里只负责区分"拖动"与"单击"
    if (!wasDragging || hasMoved) return;
    if (e.button !== 0) return;
    const t = e.target as Element | null;
    if (t && t.closest && t.closest(DRAG_IGNORE_SELECTOR)) return;
    // 交互语料：单击一次 + 连点计数（>5 次报到「连续点击」）
    const nowMs = performance.now();
    clickTimes = clickTimes.filter((at) => nowMs - at <= CLICK_WINDOW_MS);
    clickTimes.push(nowMs);
    reportPetEvent('click');
    emitBehavior('click');
    if (clickTimes.length >= MULTI_CLICK_COUNT) {
      clickTimes = []; // 报完重置，避免持续点数无限刷
      reportPetEvent('multiClick');
      emitBehavior('multiClick');
    }
    triggerPetTap(e.clientX, e.clientY);
  });
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', endDrag);
}

/* ================================================================
   7.8 点击模型 → 播放「点一下」表情（模型自带优先）+ 星星特效 + 轻灵音效
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

/** 刷新设置页的音效开关、音量和百分比。 */
function applySfxSettings(settings: AppSettings): void {
  sfxEnabled = settings.sfxEnabled !== false; // 默认开启
  const raw = typeof settings.sfxVolume === 'number' ? settings.sfxVolume : 0.6;
  sfxVolumeLevel = Math.max(0, Math.min(1, raw));
  const toggle = elementById<HTMLInputElement>('setting-sfx');
  if (toggle) toggle.checked = sfxEnabled; // 回显开关（漏了这行会导致重开设置时开关显示和实际值不一致）
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
  (window as Any).PetFx?.spawnSparkles?.(x, y); // 星星特效（所有模型都有；实现在 fx.ts）
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
   7.6 行为触发：行为 → 动作组 / 表情
   ================================================================ */
/** 行为键（与 contracts.ts 的 BEHAVIOR_KEYS 同步） */
type BehaviorKey =
  | 'startup'
  | 'user_message'
  | 'tool_call'
  | 'command_exec'
  | 'ai_start'
  | 'model_idle'
  | 'error'
  | 'click'
  | 'multiClick'
  | 'drag'
  | 'mcp';
const BEHAVIOR_KEYS: BehaviorKey[] = [
  'startup',
  'user_message',
  'tool_call',
  'command_exec',
  'ai_start',
  'model_idle',
  'error',
  'click',
  'multiClick',
  'drag',
  'mcp',
];
/** 行为中文名 */
const BEHAVIOR_LABELS: Record<BehaviorKey, string> = {
  startup: '启动',
  user_message: '用户发送消息',
  tool_call: '调用工具',
  command_exec: '执行命令',
  ai_start: '开始回答',
  model_idle: '待机搭话',
  error: '出错',
  click: '点击一次',
  multiClick: '连续点击',
  drag: '拖动',
  mcp: 'MCP 调用',
};
/** 行为触发表情后恢复默认的时长 */
const BEHAVIOR_EXPRESSION_HOLD_MS = 2600;
/** 命令类工具 */
const COMMAND_TOOLS = new Set(['shell_run', 'shell_bg', 'shell_output', 'shell_kill']);

/** 设置里的行为触发映射（当前模型生效的那一份，供设置页回显） */
let motionTriggers: Record<string, string> = {};
/** 行为触发映射（按模型分桶，保存时合并回去；见 AppSettings.motionTriggersByModel） */
let motionTriggersByModel: Record<string, Record<string, string>> = {};
/** 行为触发时附加播放的目标（可动作可表情；当前模型生效的那一份） */
let motionTriggerExpressions: Record<string, string> = {};
/** 附加目标（按模型分桶；见 AppSettings.motionTriggerExpressionsByModel） */
let motionTriggerExpressionsByModel: Record<string, Record<string, string>> = {};
/** 附加目标的播放方式（'simultaneous' 同时 / 'chain' 衔接；当前模型） */
let motionTriggerPairModes: Record<string, string> = {};
/** 附加目标播放方式（按模型分桶） */
let motionTriggerPairModesByModel: Record<string, Record<string, string>> = {};
/** 本轮回复是否已触发过「开始回答」 */
let aiStartEmitted = false;

/**
 * 把触发配置交给 behavior 插件（候选解析/去抖/失效告警都在插件里），再把生效映射取回来给设置页。
 * 按模型分桶的取用规则、旧版全局映射的可用性判断都留在插件里，渲染层只负责设置状态与 UI 回显。
 */
function applyBehaviorTriggersFromSettings(settings: AppSettings): void {
  motionTriggersByModel = (settings.motionTriggersByModel as Record<string, Record<string, string>> | undefined) ?? {};
  motionTriggerExpressionsByModel =
    (settings.motionTriggerExpressionsByModel as Record<string, Record<string, string>> | undefined) ?? {};
  motionTriggerPairModesByModel =
    (settings.motionTriggerPairModesByModel as Record<string, Record<string, string>> | undefined) ?? {};
  const legacy = (settings.motionTriggers as Record<string, string> | undefined) ?? {};
  const legacyExpressions = (settings.motionTriggerExpressions as Record<string, string> | undefined) ?? {};
  // 当前模型生效的"附加目标 / 播放方式"：优先按模型分桶，没有就退回旧版全局
  motionTriggerExpressions = activeModelName
    ? motionTriggerExpressionsByModel[activeModelName] ?? legacyExpressions
    : legacyExpressions;
  motionTriggerPairModes = activeModelName ? motionTriggerPairModesByModel[activeModelName] ?? {} : {};
  const kernel = rendererKernel();
  kernel?.emit('behavior:config', {
    byModel: motionTriggersByModel,
    legacy,
    expressions: motionTriggerExpressions,
    legacyExpressions,
    pairModes: motionTriggerPairModes,
    modelName: activeModelName,
    labels: BEHAVIOR_LABELS,
    keys: BEHAVIOR_KEYS,
  });
  // 内核缺失时退回旧版全局映射（正常装配下不会走到）
  motionTriggers = kernel?.call<Record<string, string>>('behavior.triggers') ?? legacy;
  // 设置面板若已经渲染过，下拉的候选与选中值也跟着刷新（没渲染时是空操作）
  refreshMotionTriggerOptions();
  populateMotionTriggerSelects();
}

/**
 * 载入「行为触发」映射（设置 → 行为触发）。
 *
 * ⚠️ 必须**随应用启动就载入**。以前这份映射只在打开设置面板时（populateSettings）才赋值，
 * 于是"配好之后不打开设置/重启应用"时 `motionTriggers` 一直是空对象 → 每个行为都退回
 * 'auto' 猜一个目标（多数是 `motion:Idle`，几乎看不出变化），用户配的表情/动作永远不播
 * —— 表现就是"设置里配了，但实际不触发"。保存设置时也会立刻刷新（见 saveSettings）。
 */
async function loadBehaviorTriggers(bridge: RendererBridge | null): Promise<void> {
  if (!bridge || typeof bridge.getSettings !== 'function') return;
  try {
    applyBehaviorTriggersFromSettings(await bridge.getSettings());
  } catch (err) {
    console.warn('[renderer] 行为触发映射载入失败（先用自动模式）', err);
  }
}

function listCurrentMotions(): string[] {
  return currentHandle && typeof currentHandle.listMotions === 'function' ? currentHandle.listMotions() : [];
}
function listCurrentExpressions(): string[] {
  return currentHandle && typeof currentHandle.listExpressions === 'function' ? currentHandle.listExpressions() : [];
}

/** 播放行为目标的表情，并到点恢复默认 */
function playBehaviorExpression(name: string): void {
  if (!currentHandle || typeof currentHandle.setExpression !== 'function') return;
  cancelTapExpressionReset();
  activeTapExpression = name;
  try {
    currentHandle.setExpression(name);
  } catch {
    /* 表情失败不影响行为 */
  }
  tapExpressionResetTimer = window.setTimeout(() => {
    tapExpressionResetTimer = 0;
    activeTapExpression = '';
    try {
      currentHandle?.setExpression?.(null);
    } catch {
      /* ignore */
    }
  }, BEHAVIOR_EXPRESSION_HOLD_MS);
}

/** 触发一次行为：策略在 behavior 插件里，这里只走内核事件（事件缺失时自然不触发） */
function emitBehavior(behavior: BehaviorKey): void {
  rendererKernel()?.emit('behavior', behavior);
}

/** 启动行为只在应用启动时触发一次；延后到模型/插件就绪后再播 */
let startupBehaviorFired = false;
function fireStartupBehavior(): void {
  if (startupBehaviorFired) return;
  startupBehaviorFired = true;
  window.setTimeout(() => emitBehavior('startup'), 800);
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
  opts?: {
    persist?: boolean;
    at?: number;
    /** 历史记录里的媒体元数据（渲染成文件卡片） */
    media?: Array<import('../shared/contracts').ChatMediaMeta>;
    /** 实时媒体（图片/音频带 dataUrl，可直接显示/播放） */
    live?: Array<import('../shared/contracts').ChatMediaPayload>;
  },
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
  const cards = opts?.live?.length ? buildMediaCards(opts.live) : opts?.media?.length ? buildMediaCards(opts.media) : null;
  if (cards) row.appendChild(cards);
  chatLogEl.appendChild(row);
  while (chatLogEl.childElementCount > CHAT_LOG_MAX_ROWS) {
    const first = chatLogEl.firstElementChild;
    if (!first) break;
    chatLogEl.removeChild(first);
  }
  chatScrollToEnd();
  if (opts?.persist !== false) {
    const entry: import('../shared/contracts').ChatLogEntry = { role, text, at: opts?.at ?? Date.now() };
    if (opts?.media?.length) entry.media = opts.media;
    void chatBridge?.chatLogAppend?.(entry).catch(() => undefined);
  }
  return row;
}

const AUTO_TASK_MODE_LABEL: Record<string, string> = {
  mcp_check: 'MCP 检查',
  scene_brief: '看一眼桌面',
  custom: '自定义提示词',
};
let autoTaskRoundRow: HTMLElement | null = null;
let autoTaskRoundAt = 0;

/** 自主任务运行卡片：运行中实时出现，完成后原地更新（不写 chat-log，避免污染历史） */
function renderAutoTaskRound(round: {
  at: number;
  trigger: string;
  mode: string;
  prompt: string;
  thinking: string;
  reply: string;
  running?: boolean;
  durationMs?: number;
} | null | undefined): void {
  if (!round || !chatLogEl || !round.at) return;
  const same = autoTaskRoundRow !== null && autoTaskRoundRow.isConnected && round.at === autoTaskRoundAt;
  const row = same && autoTaskRoundRow ? autoTaskRoundRow : document.createElement('div');
  if (!same) {
    row.className = 'chat-row is-tool';
    row.dataset.autotaskAt = String(round.at);
  }
  row.replaceChildren();
  const box = document.createElement('div');
  box.style.whiteSpace = 'pre-wrap';
  box.style.fontSize = '12px';
  const time = new Date(round.at).toLocaleString('zh-CN', { hour12: false });
  const triggerLabel = round.trigger === 'manual' ? '手动' : round.trigger === 'event' ? '事件' : '定时';
  const status = round.running ? '运行中…' : '已完成';
  const duration = round.durationMs !== undefined ? ` · 用时 ${(round.durationMs / 1000).toFixed(1)}s` : '';
  const title = document.createElement('div');
  title.textContent = `🧠 自主任务（${AUTO_TASK_MODE_LABEL[round.mode] ?? round.mode} · ${triggerLabel}）· ${status}${duration} · ${time}`;
  title.style.fontWeight = '600';
  box.appendChild(title);
  if (round.reply) {
    const reply = document.createElement('div');
    reply.textContent = `回复：${round.reply.slice(0, 2000)}`;
    box.appendChild(reply);
  }
  const thinking = document.createElement('div');
  if (round.thinking) {
    thinking.textContent = `思考：${round.thinking.slice(0, 4000)}`;
    thinking.style.maxHeight = '168px';
    thinking.style.overflowY = 'auto';
  } else {
    thinking.textContent = round.running ? '思考中…' : '思考：（本次模型没有返回思考内容）';
  }
  box.appendChild(thinking);
  if (round.prompt) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = '提示词（点击展开）';
    summary.style.cursor = 'pointer';
    const pre = document.createElement('div');
    pre.textContent = round.prompt.slice(0, 4000);
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.maxHeight = '200px';
    pre.style.overflowY = 'auto';
    details.appendChild(summary);
    details.appendChild(pre);
    box.appendChild(details);
  }
  row.appendChild(box);
  if (!same) chatLogEl.appendChild(row);
  while (chatLogEl.childElementCount > CHAT_LOG_MAX_ROWS) {
    const first = chatLogEl.firstElementChild;
    if (!first) break;
    chatLogEl.removeChild(first);
  }
  autoTaskRoundRow = row;
  autoTaskRoundAt = round.at;
  chatScrollToEnd();
}

async function loadAutoTaskRound(bridge: RendererBridge): Promise<void> {
  try {
    const round = await bridge.getAutoTaskLastRound?.();
    renderAutoTaskRound(round ?? null);
  } catch {
    /* 读取失败不影响聊天 */
  }
}

/** 启动时把历史记录渲染出来（不再回写，避免重复） */
async function loadChatLog(bridge: RendererBridge): Promise<void> {
  if (!chatLogEl || typeof bridge.chatLogGet !== 'function') return;
  // 回到当前对话/清空历史：恢复输入态，并清掉查看历史时挂的「返回当前」按钮
  const chatInput = elementById<HTMLInputElement>('chat-input');
  if (chatInput) chatInput.disabled = false;
  const statusBar = elementById<HTMLElement>('chat-toolbar-status');
  if (statusBar) {
    for (const old of Array.from(statusBar.querySelectorAll('[data-history-back]'))) old.remove();
  }
  try {
    const snap = await bridge.chatLogGet();
    const entries = Array.isArray(snap?.entries) ? snap.entries : [];
    chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : [];
    chatViewingSessionId = '';
    chatLogEl.replaceChildren();
    streamRowEl = null;
    if (entries.length === 0) {
      appendChatLog('tool', '说点什么开始对话吧（右键桌宠可以唤起我）', { persist: false });
      void loadAutoTaskRound(bridge);
      return;
    }
    for (const entry of entries) {
      if (!entry || typeof entry.text !== 'string') continue;
      appendChatLog(entry.role, entry.text, { persist: false, at: entry.at, media: entry.media });
    }
    chatScrollToEnd();
    void loadAutoTaskRound(bridge);
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
      // 重复打开历史时先清旧的，避免按钮叠加
      for (const old of Array.from(status.querySelectorAll('[data-history-back]'))) old.remove();
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'chat-tool';
      back.dataset.historyBack = '1';
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
    // 折叠态看不到消息区、连状态提示也藏着 → 先展开，否则点了等于没反应
    if (chatCollapsed) setChatCollapsed(bridge, false);
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
  // 菜单收起来 → 折叠态不再需要额外高度
  if (chatMenuRoom) {
    chatMenuRoom = false;
    syncChatWindowHeight(chatBridge);
  }
}

/** 气泡窗是否折叠 */
let chatCollapsed = true;
/** 折叠态是否正开着 ＋ 菜单（开菜单要把窗口撑高，菜单才弹得下） */
let chatMenuRoom = false;

/** 把「折叠 / 开菜单」两个高度状态同步给主进程 */
function syncChatWindowHeight(bridge: RendererBridge | null): void {
  try {
    void bridge?.chatWindowSetCollapsed?.(chatCollapsed, chatMenuRoom)?.catch(() => undefined);
  } catch {
    /* 旧版 preload 没有这个方法：UI 仍能用，只是窗口高度不变 */
  }
}

/** 切换折叠/展开：改窗口高度（走主进程）并同步 DOM */
function setChatCollapsed(bridge: RendererBridge, collapsed: boolean): void {
  chatCollapsed = collapsed;
  if (!collapsed) chatMenuRoom = false; // 展开态本来就够高
  document.body.classList.toggle('is-chat-collapsed', collapsed);
  closeChatMenu();
  const expandItem = document.querySelector<HTMLElement>('[data-chat-menu="expand"]');
  if (expandItem) expandItem.hidden = !collapsed; // 已展开时「对话信息」没有意义
  const collapseBtn = elementById<HTMLElement>('chat-collapse');
  if (collapseBtn) collapseBtn.hidden = collapsed;
  if (!collapsed) chatScrollToEnd();
  // closeChatMenu 可能已经同步过一次；这里再同步一次保证折叠态与高度一致
  syncChatWindowHeight(bridge);
}

/** 工具条接线：＋ 菜单（新对话 / 历史 / 思考浮窗 / 对话信息 / 收起）+ 折叠 + 关闭 */
function installChatToolbar(bridge: RendererBridge): void {
  const plus = elementById<HTMLButtonElement>('chat-plus');
  const menu = elementById<HTMLElement>('chat-menu');
  plus?.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!menu) return;
    const willOpen = menu.hidden;
    menu.hidden = !willOpen;
    plus.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    // 折叠态窗口只有 72px，菜单往上弹会超出窗口被裁掉 → 先撑高
    chatMenuRoom = willOpen && chatCollapsed;
    syncChatWindowHeight(bridge);
    if (willOpen) void refreshChatSessions(bridge);
  });
  menu?.addEventListener('click', (event) => {
    const item = (event.target as HTMLElement).closest('button')?.getAttribute('data-chat-menu');
    if (!item) return;
    // 先执行动作再收菜单：动作可能要改折叠态（顺带改窗口高度），
    // 反过来的话高度会被"收菜单缩回 72"再"展开到 270"来回设两遍，看着像闪一下。
    if (item === 'new') void startNewChat(bridge);
    else if (item === 'history') void toggleHistoryList(bridge);
    else if (item === 'think') void toggleThinkWindow(bridge);
    else if (item === 'expand') setChatCollapsed(bridge, false);
    else if (item === 'collapse') void collapseChatSurface(bridge);
    closeChatMenu();
  });
  // 点菜单外面任意处：只收菜单（不改动气泡窗本身）
  document.addEventListener('click', (event) => {
    if ((event.target as HTMLElement)?.closest?.('#chat-menu, #chat-plus')) return;
    closeChatMenu();
  });
  elementById<HTMLButtonElement>('chat-collapse')?.addEventListener('click', () => {
    setChatCollapsed(bridge, true);
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
        speakConversation(bridge, payload.text);
        emitBehavior('model_idle'); // 主进程主动搭话 = 待机行为
      }
      return;
    });
  }
  if (typeof bridge.onChat === 'function') {
    bridge.onChat((payload) => {
      if (payload && typeof payload.delta === 'string') {
        feedChatDelta(payload.delta);
        if (!aiStartEmitted) {
          aiStartEmitted = true;
          emitBehavior('ai_start');
        }
      } else if (payload && typeof payload.full === 'string') {
        if (!aiStartEmitted) emitBehavior('ai_start'); // 非流式回复：补一次
        aiStartEmitted = false;
        showBubble(payload.full, { immediate: true });
        speakConversation(bridge, payload.full);
        // 文本情感 → 表情：交给 emotion 插件（事件总线），渲染层不再自己判定
        rendererKernel()?.emit('chat:reply', payload.full);
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
        aiStartEmitted = false;
        showBubble(`⚠️ ${payload.message}`, { tone: 'error', immediate: true });
        emitBehavior('error');
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
  if (typeof bridge.onChatMedia === 'function') {
    bridge.onChatMedia((payload) => {
      if (!payload) return;
      if (!chatOwnedByChatWindow) appendIncomingMedia(bridge, payload);
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
      } else if (type === 'behavior') {
        // 主进程转发来的行为事件
        const name = action.payload && typeof action.payload.name === 'string' ? action.payload.name : '';
        if ((BEHAVIOR_KEYS as string[]).includes(name)) emitBehavior(name as BehaviorKey);
      }
      return;
    });
  }
  if (typeof bridge.onAutoTaskRound === 'function') {
    bridge.onAutoTaskRound((round) => {
      renderAutoTaskRound(round);
    });
  }
  if (typeof bridge.onThink === 'function') {
    bridge.onThink((evt) => {
      if (!evt) return;
      // 先调工具再出文本时不会走 delta 分支，故这里补触发「开始回答」
      if (evt.kind === 'start' && !aiStartEmitted) {
        aiStartEmitted = true;
        emitBehavior('ai_start');
      }
      if (evt.kind !== 'tool' || typeof evt.tool !== 'string' || !evt.tool) return;
      emitBehavior(COMMAND_TOOLS.has(evt.tool) ? 'command_exec' : 'tool_call');
      return;
    });
  }
  // 全局鼠标坐标推送（主进程轮询）→ 宠物视线自动跟随（含鼠标不在宠物窗口内时）
  if (typeof bridge.onGlobalCursor === 'function') {
    bridge.onGlobalCursor((pos) => {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        gazeApi()?.setGlobal(pos.x, pos.y);
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
  // VTS 状态推送（连接/授权/错误/模型变化）：设置页打开时同步刷新那一行
  if (typeof bridge.onVtsStatus === 'function') {
    bridge.onVtsStatus((status) => {
      const panel = elementById<HTMLElement>('settings-panel');
      if (panel && !panel.hidden) renderVtsStatus(status);
    });
  }
  // VTS 事件推送（热键触发 / 模型加载）：反向同步到本地模型（只在本地应用，不回写 VTS）
  if (typeof bridge.onVtsEvent === 'function') {
    bridge.onVtsEvent(applyVtsEvent);
  }
  // TTS 音频：主进程合成好就推过来，这里直接播（autoplay 策略已在主进程放宽）
  if (typeof bridge.onTtsAudio === 'function') {
    bridge.onTtsAudio(playTtsAudio);
  }
}

/* ================================================================
   9.5 拖放加入资产（把模型 / 插件文件夹拖到桌宠身上）
   ================================================================ */

/**
 * 拖放两个必须处理的前提：
 *   1. 必须全局阻止默认行为，否则拖入文件会让整个窗口导航去打开那个文件（桌宠直接白屏）；
 *   2. Electron 31+ 起渲染层拿不到 `File.path`（当前 45 同样），只能经 preload 的 `pathForFile()`
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
  /** 拖放高亮兜底清除：拖到窗口外松手/按 Esc/窗口失焦时收不到 target 的 dragleave */
  const clearDragHighlight = (): void => document.body.classList.remove('is-dragover');
  // 拖入时给一点视觉反馈（没有 bridge 能力时不提示，免得空欢喜）
  target.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (canImport) document.body.classList.add('is-dragover');
  });
  target.addEventListener('dragleave', (e) => {
    // 只有真正离开舞台才收起高亮（在子元素间移动也会触发 dragleave）
    if (e.target === target) clearDragHighlight();
  });
  window.addEventListener('dragend', clearDragHighlight);
  window.addEventListener('blur', clearDragHighlight);
  document.addEventListener('dragleave', (e) => {
    if (!(e as DragEvent).relatedTarget) clearDragHighlight();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearDragHighlight();
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
      if (petDragging) {
        bridge.reportHitResult?.(false, false); // 拖拽中：整窗收事件，避免光标滑出模型后窗口变穿透
        return;
      }
      if (hasOpenOverlay()) {
        bridge.reportHitResult?.(false, true);
        return;
      }
      // 气泡是模型之上的可交互浮层：光标在气泡内不能判成穿透
      if (bubbleEl && bubbleEl.classList.contains('is-visible')) {
        const r = bubbleEl.getBoundingClientRect();
        if (pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom) {
          bridge.reportHitResult?.(false, false);
          return;
        }
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

/**
 * 让下拉里一定有这个值并选中它。
 * 用途：设置的音色可能是「联网拉取」后选的，重启后下拉只剩内置候选；
 * 直接 `select.value = value` 会变成空串，用户再点保存就把音色覆盖回默认了。
 */
function ensureSelectValue(select: HTMLSelectElement, value: string, label?: string): void {
  if (!value) return;
  if (!Array.from(select.options).some((option) => option.value === value)) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label ?? value;
    select.appendChild(option);
  }
  select.value = value;
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

/** 整数夹取：空/非法/越界一律回退默认值（避免用户清空数字框后整次保存失败） */
function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** 服务端拉到的全部可用模型（设置页内嵌列表用） */
let aiModelAll: string[] = [];
/** 视觉端点拉到的模型列表（视觉专用地址优先，留空复用聊天端点） */
let visionModelAll: string[] = [];

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

function setVisionModelStatus(text: string, isError = false): void {
  const status = elementById<HTMLElement>('setting-vision-model-status');
  if (!status) return;
  status.textContent = text;
  status.style.color = isError ? '#ffaaa8' : '';
}

function closeVisionModelPanel(): void {
  const panel = elementById<HTMLElement>('setting-vision-model-panel');
  if (panel) panel.hidden = true;
  elementById<HTMLButtonElement>('setting-vision-model-pick')?.setAttribute('aria-expanded', 'false');
}

/** 渲染视觉模型候选（点击填入输入框；只填不保存，仍需点保存设置）。 */
function renderVisionModelList(filter = ''): void {
  const list = elementById<HTMLElement>('setting-vision-model-list');
  if (!list) return;
  const q = filter.trim().toLowerCase();
  const current = elementById<HTMLInputElement>('setting-vision-model')?.value.trim() ?? '';
  const hits = q ? visionModelAll.filter((m) => m.toLowerCase().includes(q)) : visionModelAll;
  list.replaceChildren();
  if (!hits.length) {
    const empty = document.createElement('div');
    empty.className = 'model-empty';
    empty.textContent = visionModelAll.length ? '没有匹配的模型' : '（还没拉到模型列表，点上面的按钮拉取）';
    list.appendChild(empty);
    return;
  }
  for (const id of hits.slice(0, 300)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `model-item${id === current ? ' is-current' : ''}`;
    btn.textContent = id;
    btn.addEventListener('click', () => {
      const input = elementById<HTMLInputElement>('setting-vision-model');
      if (input) input.value = id;
      closeVisionModelPanel();
      setVisionModelStatus(`已选择「${id}」——记得点最下面「保存设置」才会生效。`);
    });
    list.appendChild(btn);
  }
}

/** 拉取视觉端点模型列表：视觉专用地址有值就查它，否则回退聊天端点。 */
async function refreshVisionModelOptions(bridge: RendererBridge, openPanel = false): Promise<void> {
  const panel = elementById<HTMLElement>('setting-vision-model-panel');
  const list = elementById<HTMLElement>('setting-vision-model-list');
  if (openPanel && panel) {
    panel.hidden = false;
    elementById<HTMLButtonElement>('setting-vision-model-pick')?.setAttribute('aria-expanded', 'true');
    window.requestAnimationFrame(() => {
      try {
        panel.scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch {
        panel.scrollIntoView(false);
      }
    });
    const filter = elementById<HTMLInputElement>('setting-vision-model-filter');
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
    setVisionModelStatus('（当前版本不支持拉取模型列表）', true);
    return;
  }
  setVisionModelStatus('正在拉取视觉端点模型…');
  if (list) list.replaceChildren();
  try {
    const res = await bridge.aiModelList('vision');
    if (!res || !res.ok) {
      setVisionModelStatus(`拉取失败：${res?.error ?? '未知原因'}（也可以手动输入模型名）`, true);
      renderVisionModelList();
      return;
    }
    visionModelAll = res.models;
    renderVisionModelList(elementById<HTMLInputElement>('setting-vision-model-filter')?.value ?? '');
    const current = elementById<HTMLInputElement>('setting-vision-model')?.value.trim() ?? '';
    if (current && !visionModelAll.includes(current)) {
      setVisionModelStatus(`共 ${visionModelAll.length} 个模型；⚠️ 当前填的「${current}」不在视觉端点列表里，可点「▾ 选择模型」挑一个。`, true);
    } else {
      setVisionModelStatus(`已从视觉端点拉取 ${visionModelAll.length} 个模型（点「▾ 选择模型」展开挑选）。`);
    }
  } catch (err) {
    setVisionModelStatus(`拉取失败：${(err as Error).message ?? String(err)}`, true);
  }
}


/* ---------------------------------------------------------------- TTS 播放 */

/** 一段 50ms 的静音 wav（8kHz/8bit 单声道）：只为在用户手势里"预热"音频通道，没有声音 */
const SILENT_WAV_DATA_URL =
  'data:audio/wav;base64,UklGRrQBAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YZABAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA';

let ttsAudioEl: HTMLAudioElement | null = null;
/** 与主进程 edgeTts.DEFAULT_VOICE 同一默认值（渲染层拿不到主进程模块，只能各留一份） */
const TTS_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
/** 与主进程 edgeTts.MAX_TEXT_CHARS 对齐：超过这个长度的合成请求一定会失败 */
const TTS_MAX_CHARS = 2000;
let ttsEnabled = false;
let ttsVoice = TTS_DEFAULT_VOICE;
let ttsRequestSeq = 0;
let latestTtsRequestId = '';
/** 音频通道是否已经在用户手势里解锁过 */
let ttsUnlocked = false;
let ttsAudioContext: AudioContext | null = null;
/** 最近一次 TTS 播放失败（原始 name/message，诊断与设置页提示都用它） */
let ttsLastError = '';

/**
 * 本地口型驱动（ttsMouth.ts 的 window.PetTtsMouth；缺这个脚本时安静降级为"只出声不动嘴"）。
 * 播放期间按 90~120ms 随机节拍写 openY 0.15~0.75（TTL 150ms），ended/error/pause 时 stop() 归零。
 */
interface TtsMouthDriverLike {
  start(): void;
  stop(): boolean;
  state(): { active: boolean; ticks: number; lastOpenY: number; timerRunning: boolean };
}
let ttsMouthDriver: TtsMouthDriverLike | null = null;

/** 懒创建（模型 handle 可能还没挂载；driver 内部每次取当前 handle） */
function ttsMouth(): TtsMouthDriverLike | null {
  if (ttsMouthDriver) return ttsMouthDriver;
  const factory = (window as Any).PetTtsMouth as
    | { createDriver?: (options: { getHandle: () => RenderHandle | null }) => TtsMouthDriverLike }
    | undefined;
  if (!factory || typeof factory.createDriver !== 'function') return null;
  try {
    ttsMouthDriver = factory.createDriver({ getHandle: () => currentHandle });
  } catch (err) {
    console.warn('[renderer] TTS 本地口型驱动创建失败（只出声，不动嘴）', err);
    ttsMouthDriver = null;
  }
  return ttsMouthDriver;
}

/** 停止 TTS 本地口型并归零（音频结束/出错/暂停、开始播下一段时调用） */
function stopTtsMouth(): void {
  ttsMouth()?.stop();
}

/** 朗读开关/音色立刻生效（无需重启）；关闭时停掉正在播的那一段，并让在途请求作废 */
function applyTtsSettings(settings: AppSettings): void {
  ttsEnabled = settings.ttsEnabled === true;
  ttsVoice = settings.ttsVoice || TTS_DEFAULT_VOICE;
  if (!ttsEnabled) {
    // 合成可能要几秒：关闭后旧请求晚到的音频不能再播（playTtsAudio 只认最新 requestId）
    latestTtsRequestId = '';
    ttsAudioEl?.pause();
    stopTtsMouth();
  }
}

/** 登记最新一次朗读请求：返回 requestId，并先停掉上一段（旧结果晚到时按 id 丢弃） */
function beginTtsRequest(): string {
  ttsRequestSeq += 1;
  const requestId = `renderer-${Date.now().toString(36)}-${ttsRequestSeq}`;
  latestTtsRequestId = requestId;
  stopTtsMouth();
  try {
    ttsAudioEl?.pause();
  } catch (err) {
    console.warn('[renderer] 停止上一段 TTS 失败', err);
  }
  return requestId;
}

/**
 * 音频解锁：必须在**用户手势的同一个调用栈里**跑。
 *
 * 为什么要它：主进程合成 TTS 是异步的（IPC 回来时手势早已失效），如果运行环境的
 * autoplay 策略是 user-gesture-required 系，play() 会直接 NotAllowedError。
 * 这里在首次点击/按键时先 resume 一个 AudioContext + 静音播一个空音频，
 * 之后（同一文档内）再播就一路畅通。命令行的 autoplay-policy 开关仍在（earlySwitches），
 * 这层是"策略被收紧也还能出声"的兜底。
 */
function unlockTtsAudio(): void {
  if (ttsUnlocked) return;
  ttsUnlocked = true;
  try {
    const Ctor = (window as Any).AudioContext ?? (window as Any).webkitAudioContext;
    if (typeof Ctor === 'function') {
      ttsAudioContext = new Ctor() as AudioContext;
      void ttsAudioContext.resume().catch(() => {});
    }
  } catch (err) {
    console.warn('[renderer] AudioContext 解锁失败（继续尝试直接播放）', err);
  }
  try {
    const silent = new Audio(SILENT_WAV_DATA_URL);
    silent.volume = 0;
    const played = silent.play();
    if (played && typeof played.catch === 'function') void played.catch(() => {});
    window.setTimeout(() => {
      try {
        silent.pause();
      } catch {
        /* 已销毁 */
      }
    }, 600);
  } catch (err) {
    console.warn('[renderer] 静音解锁播放失败（继续尝试直接播放）', err);
  }
}

/** 首次用户手势（点击/按键/触摸）就解锁音频通道 */
function installTtsAudioUnlock(): void {
  for (const evt of ['pointerdown', 'keydown', 'touchstart', 'click'] as const) {
    window.addEventListener(evt, unlockTtsAudio, { capture: true, passive: true });
  }
}

/** __petDebug.tts()：判断"到底有没有出声/被谁拦了" */
function ttsDebugState(): Any {
  return {
    unlocked: ttsUnlocked,
    audioContext: ttsAudioContext ? ttsAudioContext.state : 'none',
    lastError: ttsLastError,
    playing: !!ttsAudioEl && !ttsAudioEl.paused,
    currentTime: ttsAudioEl ? Math.round(ttsAudioEl.currentTime * 1000) / 1000 : 0,
    duration: ttsAudioEl && Number.isFinite(ttsAudioEl.duration) ? ttsAudioEl.duration : null,
    volume: ttsAudioEl ? ttsAudioEl.volume : null,
    muted: ttsAudioEl ? ttsAudioEl.muted : null,
    /** 本地桌宠口型驱动：active=true 表示正在按音频时长打拍子（ticks 应持续增长） */
    mouth: ttsMouthDriver ? ttsMouthDriver.state() : null,
  };
}

/**
 * 播放一段主进程合成的语音。
 *
 * 已知坑（2026-11 实测）：
 *   1) **CSP**：TTS 音频是 `data:audio/mpeg;base64,...`，页面 CSP 的 media-src 少了 `data:`
 *      就会被拦成 "Media load rejected by URL safety check"，play() 抛 NotSupportedError
 *      —— 表现为"点试听没声音"。现在 staticServer.HTML_CSP 与 index.html 的 meta 都放行 data:。
 *   2) **autoplay**：Electron 默认策略本就免手势；但策略一旦收紧，没有手势就是 NotAllowedError。
 *      首次点击会走 unlockTtsAudio()，失败时这里给可操作提示并保留原始错误（__petDebug.tts()）。
 */
function playTtsAudio(payload: TtsAudioPayload): void {
  // 只播最新一次请求的结果：上一句的音频可能晚到（合成耗时不固定），不能打断当前这句
  if (!payload || !payload.requestId || payload.requestId !== latestTtsRequestId) return;
  if (!payload || payload.ok !== true || typeof payload.dataUrl !== 'string' || !payload.dataUrl) {
    if (payload && payload.error) setSettingsStatus(`语音合成失败：${payload.error}`, true);
    return;
  }
  try {
    // 换下一段语音：先把上一段的本地口型停下并归零（旧音频的 pause 事件也可能触发，stop 幂等）
    stopTtsMouth();
    ttsAudioEl?.pause();
  } catch {
    /* 旧元素已销毁 */
  }
  try {
    const audio = new Audio(payload.dataUrl);
    ttsAudioEl = audio;
    ttsLastError = '';
    audio.addEventListener('error', () => {
      const code = audio.error ? audio.error.code : '?';
      const message = audio.error ? audio.error.message : '';
      ttsLastError = `媒体加载失败（code=${code}${message ? `，${message}` : ''}）`;
      if (ttsAudioEl === audio) stopTtsMouth(); // 播不出来就别让嘴一直动
    });
    // 本地口型跟音频生命周期走：结束/出错/暂停都要停并归零（音频时长就是节拍的上限）
    audio.addEventListener('ended', () => {
      if (ttsAudioEl === audio) stopTtsMouth();
    });
    audio.addEventListener('pause', () => {
      // ended 也会触发 pause；stop 幂等，这里统一收口
      if (ttsAudioEl === audio) stopTtsMouth();
    });
    const played = audio.play();
    // 开始按音频时长驱动本地桌宠嘴部（VTS 那条 MouthOpen 注入仍在主进程，互不干扰）
    ttsMouth()?.start();
    if (played && typeof played.catch === 'function') {
      void played.catch((err: unknown) => {
        stopTtsMouth(); // 自动播放被拦/解码失败：立刻闭嘴
        const name = (err as Error)?.name ?? 'Error';
        const message = (err as Error)?.message ?? String(err);
        ttsLastError = `${name}: ${message}`;
        console.warn('[renderer] TTS 播放失败', err);
        if (name === 'NotAllowedError') {
          // 自动播放拦截：只有用户手势能解；试听按钮本身就是手势
          setSettingsStatus('浏览器拦截了自动播放：点一次「🔊 试听语音」（按钮本身是手势）再试一次', true);
          showBubble('语音被浏览器拦截：点一下桌宠再说话', { tone: 'error', ttlMs: 4000 });
        } else {
          // NotSupportedError / AbortError 等：多半是资源被安全策略拦了或数据不完整
          setSettingsStatus(`语音播放失败（${name}）：${message || '音频数据无法解码'}`, true);
          showBubble(`语音播放失败：${name}`, { tone: 'error', ttlMs: 4000 });
        }
      });
    }
  } catch (err) {
    stopTtsMouth();
    ttsLastError = (err as Error)?.message ?? String(err);
    setSettingsStatus(`播放失败：${ttsLastError}`, true);
  }
}

/** 设置页「试听语音」：让主进程合成一句（启用 VTS 时同时驱动 MouthOpen） */
/** 试听文本按音色语言选择：英文音色读中文会得到 0 字节，不能拿中文句子试英文音色 */
function ttsSampleForVoice(voice: string): string {
  const lang = (voice || '').toLowerCase().split('-')[0];
  if (lang === 'zh') return '你好，我是你的桌面宠物，语音已经接好了。';
  if (lang === 'ja') return 'こんにちは、あなたのデスクトップペットです。';
  if (lang === 'ko') return '안녕하세요, 데스크톱 펫입니다.';
  // 英语及其他拉丁语系音色统一用英文试听句；中文音色不能拿来读英文。
  return 'Hello, this is your desktop pet. The voice is ready.';
}

async function speakSampleFromUi(bridge: RendererBridge): Promise<void> {
  const btn = elementById<HTMLButtonElement>('setting-tts-speak');
  const el = elementById<HTMLElement>('setting-tts-status');
  if (typeof bridge.ttsSpeak !== 'function') {
    if (el) el.textContent = '当前版本不支持语音合成';
    return;
  }
  // 关键：**先解锁再合成**。合成要走网络（几百 ms~几秒），回来时这次点击的手势早就失效了；
  // 在同一个手势里先把音频通道打开，之后异步回来的 play() 才不会被策略拦。
  unlockTtsAudio();
  if (btn) btn.disabled = true;
  if (el) el.textContent = '合成中…';
  try {
    // 试听用设置页当前选中的音色（未点保存也要即时生效）
    const voice = elementById<HTMLSelectElement>('setting-tts-voice')?.value || ttsVoice;
    const requestId = beginTtsRequest();
    const result = await bridge.ttsSpeak(ttsSampleForVoice(voice), voice, requestId);
    if (el) {
      el.textContent = result.ok
        ? result.fallbackFrom
          ? `该音色不支持当前文本语言，已自动改用默认音色并合成 ${result.bytes ?? 0} 字节`
          : `已合成 ${result.bytes ?? 0} 字节，开始播放`
        : `失败：${result.error ?? '未知原因'}`;
    }
    if (!result.ok) setSettingsStatus(`语音合成失败：${result.error ?? '未知原因'}`, true);
  } catch (err) {
    if (el) el.textContent = `失败：${(err as Error).message ?? String(err)}`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * 拉取 Edge TTS 全部音色并填充设置页下拉（需联网）。
 * 失败时保留 index.html 里的内置候选，不影响原有功能。
 */
async function refreshTtsVoiceOptions(bridge: RendererBridge): Promise<void> {
  const select = elementById<HTMLSelectElement>('setting-tts-voice');
  const btn = elementById<HTMLButtonElement>('setting-tts-voices-refresh');
  const el = elementById<HTMLElement>('setting-tts-status');
  if (!select) return;
  if (typeof bridge.ttsVoices !== 'function') {
    if (el) el.textContent = '当前版本不支持拉取音色列表';
    return;
  }
  const current = select.value || ttsVoice;
  if (btn) btn.disabled = true;
  if (el) el.textContent = '拉取音色列表中…（需要联网）';
  try {
    const result = await bridge.ttsVoices();
    if (!result.ok || !Array.isArray(result.voices) || !result.voices.length) {
      if (el) el.textContent = `拉取失败：${result.error ?? '没有可用音色'}（保留内置候选）`;
      return;
    }
    const byLocale = new Map<string, typeof result.voices>();
    for (const voice of result.voices) {
      const list = byLocale.get(voice.locale) ?? [];
      list.push(voice);
      byLocale.set(voice.locale, list);
    }
    select.replaceChildren();
    for (const [locale, voices] of [...byLocale.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const group = document.createElement('optgroup');
      group.label = locale;
      for (const voice of voices) {
        const option = document.createElement('option');
        option.value = voice.shortName;
        // friendlyName 形如「Microsoft 晓晓 Online (Natural) - Chinese (Mainland)」，去掉前缀更清爽
        const name = (voice.friendlyName ?? voice.shortName).replace(/^Microsoft\s+/, '');
        option.textContent = `${name}${voice.gender ? `（${voice.gender}）` : ''}`;
        group.appendChild(option);
      }
      select.appendChild(group);
    }
    // 当前选中的音色可能不在返回列表里（自定义/已下线）：补一个选项留住
    if (!Array.from(select.options).some((o) => o.value === current)) {
      const option = document.createElement('option');
      option.value = current;
      option.textContent = `${current}（当前）`;
      select.appendChild(option);
    }
    select.value = current;
    if (el) el.textContent = `已拉取 ${result.voices.length} 个音色，可下拉选择后点「试听语音」`;
  } catch (err) {
    if (el) el.textContent = `拉取失败：${(err as Error).message ?? String(err)}（保留内置候选）`;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openSettings(bridge: RendererBridge): void {
  const panel = elementById<HTMLElement>('settings-panel');
  if (!panel) return;
  try { bridge.setSettingsPanelOpen?.(true); } catch { /* 旧版 preload 无此方法 */ }
  hideContextMenu();
  panel.hidden = false;
  // 表单是唯一滚动容器：每次打开都从顶部开始，否则会停在上次的位置，看着像"内容缺了"
  const form = elementById<HTMLElement>('settings-form');
  if (form) form.scrollTop = 0;
  closeAiModelPanel(); // 展开的模型列表收起，避免一进来就是 200+ 项的滚动区
  closeVisionModelPanel();
  setSettingsStatus('读取设置…');
  void populateSettings(bridge)
    .then(() => setSettingsStatus(''))
    .catch((err: unknown) => setSettingsStatus(`读取失败：${(err as Error).message ?? String(err)}`, true));
}

function closeSettings(): void {
  const panel = elementById<HTMLElement>('settings-panel');
  if (panel) panel.hidden = true;
  try { (window as Any).electron?.setSettingsPanelOpen?.(false); } catch { /* ignore */ }
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
    ttsEnabled: elementById<HTMLInputElement>('setting-tts-enabled')?.checked === true,
    ttsVoice: elementById<HTMLSelectElement>('setting-tts-voice')?.value || TTS_DEFAULT_VOICE,
    devWorkspaceRoot: value('setting-dev-root'),
    allowShell: elementById<HTMLInputElement>('setting-allow-shell')?.checked !== false,
    permissionMode: (elementById<HTMLSelectElement>('setting-permission-mode')?.value as AppSettings['permissionMode']) ?? 'ask',
    displayMode: (elementById<HTMLSelectElement>('setting-display-mode')?.value as AppSettings['displayMode']) ?? 'full',
    fullscreenAutoHide: elementById<HTMLInputElement>('setting-hide-fullscreen')?.checked === true,
    clickThrough: elementById<HTMLInputElement>('setting-click-through')?.checked === true,
    // AI 接入方式二选一：api=直连 API；dsh=桥接本机 DSH（只转对话）
    aiMode: elementById<HTMLInputElement>('setting-ai-mode-dsh')?.checked === true ? 'dsh' : 'api',
    visionModel: value('setting-vision-model'),
    visionRoute: (elementById<HTMLSelectElement>('setting-vision-route')?.value as AppSettings['visionRoute']) ?? 'auto',
    visionBaseUrl: value('setting-vision-base-url'),
    visionApiKey: value('setting-vision-api-key'),
    textureMaxSize: (() => {
      const n = Number(elementById<HTMLSelectElement>('setting-texture-max')?.value ?? '4096');
      return Number.isFinite(n) ? n : 4096;
    })(),
    checkForUpdates: elementById<HTMLInputElement>('setting-check-for-updates')?.checked !== false,
    // 语音识别（留空即复用 AI 配置）
    voiceModel: value('setting-voice-model'),
    voiceRoute: (elementById<HTMLSelectElement>('setting-voice-route')?.value as AppSettings['voiceRoute']) ?? 'auto',
    voiceBaseUrl: value('setting-voice-base-url'),
    voiceApiKey: value('setting-voice-api-key'),
    motionTriggers: collectMotionTriggers(),
    motionTriggerExpressions: collectMotionTriggerExpressions(),
    motionTriggerPairModes: collectMotionTriggerPairModes(),
    // 行为触发按模型分桶：只更新"当前模型"这一桶，其它模型的绑定原样保留
    petName: value('setting-pet-name').slice(0, 24),
    mcpServerEnabled: elementById<HTMLInputElement>('setting-mcp-server-enabled')?.checked === true,
    mcpServerLanEnabled: elementById<HTMLInputElement>('setting-mcp-server-lan')?.checked === true,
    mcpServerPort: clampInt(readNumber('setting-mcp-server-port', 37653), 1024, 65535, 37653),
    mcpServerToken: value('setting-mcp-server-token').slice(0, 128),
    autoTaskEnabled: elementById<HTMLInputElement>('setting-autotask-enabled')?.checked === true,
    autoTaskMode: (elementById<HTMLSelectElement>('setting-autotask-mode')?.value as AppSettings['autoTaskMode']) ?? 'mcp_check',
    autoTaskPrompt: value('setting-autotask-prompt').slice(0, 200),
    autoTaskIntervalMin: clampInt(readNumber('setting-autotask-interval', 30), 5, 240, 30),
    autoTaskDailyLimit: clampInt(readNumber('setting-autotask-limit', 20), 1, 200, 20),
    autoTaskEventEnabled: elementById<HTMLInputElement>('setting-autotask-event-enabled')?.checked === true,
    autoTaskEventMatch: value('setting-autotask-event-match').slice(0, 80),
    autoTaskEventCooldownMin: clampInt(readNumber('setting-autotask-event-cooldown', 15), 5, 120, 15),
    autoTaskAllowMcp: elementById<HTMLInputElement>('setting-autotask-allow-mcp')?.checked === true,
    // VTube Studio 可选后端（默认关闭；端口 1..65535，脏值按 8001）
    vtsEnabled: elementById<HTMLInputElement>('setting-vts-enabled')?.checked === true,
    vtsPort: clampInt(readNumber('setting-vts-port', 8001), 1, 65535, 8001),
    motionTriggersByModel: (() => {
      const next = { ...motionTriggersByModel };
      const name = activeModelName || '';
      if (name) next[name] = collectMotionTriggers();
      return next;
    })(),
    motionTriggerExpressionsByModel: (() => {
      const next = { ...motionTriggerExpressionsByModel };
      const name = activeModelName || '';
      if (name) {
        const expressions = collectMotionTriggerExpressions();
        if (Object.keys(expressions).length) next[name] = expressions;
        else delete next[name];
      }
      return next;
    })(),
    motionTriggerPairModesByModel: (() => {
      const next = { ...motionTriggerPairModesByModel };
      const name = activeModelName || '';
      if (name) {
        const modes = collectMotionTriggerPairModes();
        if (Object.keys(modes).length) next[name] = modes;
        else delete next[name];
      }
      return next;
    })(),
  };
  let previousTextureMaxSize: number | undefined;
  try {
    previousTextureMaxSize = (await bridge.getSettings()).textureMaxSize;
  } catch {
    // 读不到旧值就按默认精度处理；保存本身不受影响
  }
  setSettingsStatus('保存中…');
  const result = await bridge.setSettings(settings);
  if (!result.ok) {
    setSettingsStatus(result.error ?? '保存失败', true);
    return;
  }
  motionTriggersByModel = (settings.motionTriggersByModel as Record<string, Record<string, string>> | undefined) ?? motionTriggersByModel;
  motionTriggerExpressionsByModel =
    (settings.motionTriggerExpressionsByModel as Record<string, Record<string, string>> | undefined) ??
    motionTriggerExpressionsByModel;
  motionTriggerPairModesByModel =
    (settings.motionTriggerPairModesByModel as Record<string, Record<string, string>> | undefined) ??
    motionTriggerPairModesByModel;
  // 触发配置变更后让插件重算，并把生效映射取回来给设置页
  applyBehaviorTriggersFromSettings(settings);
  applyPetName(settings.petName); // 名字立刻生效（输入框提示/问候语）
  applySfxSettings(settings); // 音效开关/音量立刻生效（无需重启）
  applyTtsSettings(settings); // 朗读开关/音色立刻生效（无需重启）
  applyFraming(settings.displayMode === 'half' ? 'half' : 'full'); // 取景立刻生效
  setVtsTrackingEnabled(settings.vtsEnabled === true); // VTS 视线同步随开关立刻生效
  void refreshVtsStatus(bridge); // VTS 状态行跟着更新（主进程可能刚重连）
  void refreshVoiceStatus(bridge); // 语音状态行跟着更新
  void refreshMcpPanel(bridge); // MCP / 自主任务状态行跟着更新
  void refreshVoiceModelIndex(bridge, { autoFill: false }); // 转写模型体检（保存后重新校验一次）
  // 反向接入首次开启时服务端会自动生成 token：回填到输入框，用户才能复制给手机/外部客户端
  if (!value('setting-mcp-server-token')) {
    try {
      const fresh = await bridge.getSettings();
      const tokenInput = elementById<HTMLInputElement>('setting-mcp-server-token');
      if (tokenInput && fresh.mcpServerToken) tokenInput.value = fresh.mcpServerToken;
    } catch {
      /* 读取失败时保持在输入框，下次打开设置会重新 populate */
    }
  }
  const prevTextureMax = typeof previousTextureMaxSize === 'number' ? previousTextureMaxSize : 4096;
  if (settings.textureMaxSize !== prevTextureMax && activeModelName) {
    // 纹理精度是主进程静态服务/缓存目录级设置：保存后必须重新挂载当前模型，
    // 否则页面仍用旧精度的纹理，表现为“调了没反应”。
    setSettingsStatus('纹理精度已变更，正在重新加载模型…');
    await switchModel(bridge, activeModelName);
    return;
  }
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
    // 挂载完成后再刷新行为触发：换成新模型自己的绑定 + 新模型的动作组/表情候选
    // （早于挂载会被标成"当前模型没有"，见 mountManifest 里的注释）
    await loadBehaviorTriggers(bridge);
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
  // 状态条是贴着这个输入条的浮层：输入条收了就不该留在窗口里
  clearVoiceRow();
  if (!keepThinkPanel) closeThinkWithChat(); // 关闭对话 → 浮窗彻底关闭（含胶囊）
}


/* ================================================================
   9.7 待办笔记本面板（实现见 panels/todo.ts；数据仍经 IPC 走主进程 ToolBox）
   ================================================================ */
function closeTodoPanel(): void {
  (window as Any).PetTodoPanel?.close();
}

function installTodoPanel(bridge: RendererBridge): void {
  (window as Any).PetTodoPanel?.install({ byId: elementById, bridge, hideContextMenu });
}

/* ================================================================
   9.8 AI 提问框（实现见 panels/askBox.ts；思考浮窗状态经注入回调联动）
   ================================================================ */
function installAskBox(bridge: RendererBridge): void {
  (window as Any).PetAskBox?.install({
    byId: elementById,
    bridge,
    hideContextMenu,
    installDragScroll,
    setThinkWaiting,
    pushThinkLine,
    expandThinkPanel,
    isChatPanel: CHAT_PANEL_MODE,
    isThinkPanel: THINK_PANEL_MODE,
    setChatCollapsed: (collapsed: boolean) => setChatCollapsed(bridge, collapsed),
    isChatCollapsed: () => chatCollapsed,
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
  if (typeof bridge.onChatMedia === 'function') {
    bridge.onChatMedia((payload) => {
      if (!payload) return;
      appendIncomingMedia(bridge, payload);
      setChatTyping(false);
      chatScrollToEnd();
    });
  }
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
    hideVoiceStrip(); // 收起对话别把状态条留在窗口里（否则窗口会一直高一条、下次打开也带着）
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
    // 折叠态没有消息区：列表本身没地方显示，选中会话后也看不到内容 → 先展开
    if (chatCollapsed) setChatCollapsed(bridge, false);
    try {
      const snap = await bridge.chatLogGet?.();
      chatSessions = Array.isArray(snap?.sessions) ? snap.sessions : chatSessions;
    } catch {
      /* 拿不到最新摘要就用已有列表兜底 */
    }
    renderChatHistoryList();
    chatScrollToEnd();
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

  installDragScroll(chatLogEl); // 气泡窗：按住对话区拖动可滚动
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
  installChatAttachmentUi(bridge); // 聊天附件：图片/音频/文件（发送前做兼容性检查）
  installVoiceInput(); // 按住说话 → 转写 → 填入输入框（不自动发送）
  installChatRowRetry(); // 失败行走"点一行重填"（不自动重发）
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    installDebugHooks(bridge);
  }
  void loadChatLog(bridge);
  showChatBar(); // 常驻展开 + 聚焦输入框
  setChatCollapsed(bridge, true); // 打开时默认折叠：只显示输入条
}

/* ---------- 10.2 思考浮窗模式（?panel=think）----------
   桌面上的独立浮窗：只显示思考过程与任务进度清单。
   主进程在"用户提问"时自动打开、AI 答完 2.5s 后自动收起；这里只管渲染与手动关闭。 */
async function initThinkPanelWindow(): Promise<void> {
  document.body.classList.add('is-think-window');
  document.title = '思考过程';
  grabElements();

  installDragScroll(elementById<HTMLElement>('think-list')); // 思考浮窗：按住内容拖动可滚动
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
  installAskBox(bridge); // AI 的提问/确认框就弹在这个页面里（"思考到一半停下来问你"）
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
    /**
     * VTS 追踪推送自查（Console 里 `__petDebug.vts()`）：
     * enabled=有没有在发；sentCount 每次调用都应增长；lastSent 是最近一帧；
     * 若 enabled=true 但 sentCount 不涨 → bridge 没接上（bridgeOk/timerRunning 里能看出来）。
     */
    vts: () => vtsDebugState(),
    /** 当前 Live2D 模型的 .vtube 映射/待机动作加载情况（换模型后排查映射问题） */
    vtsModel: () => currentHandle?.vtsDebug?.() ?? null,
    /**
     * VTS 事件反向同步自查（Console 里 `__petDebug.vtsEvents()`）：
     * count 每次 VTS 热键/换模型都应增长；action 说明最近一条事件在本地做了什么
     * （expression:名字 / motion:名字 / ignored:名字 / modelLoaded）。
     */
    vtsEvents: () => ({ count: vtsEventCount, action: lastVtsEventAction, last: lastVtsEvent }),
    /** TTS 自查：有没有解锁音频通道、最近一次播放失败的原始错误、当前音频进度 */
    tts: () => ttsDebugState(),
    /** 视线驱动模式自查：sdkFocusActive=true 表示当前由 SDK focus 驱动，false=项目代码管线兜底 */
    gazeMode: () => gazeApi()?.debug() ?? null,
    /** 调试：直接写模型参数，验证该参数是否真的驱动网格 */
    setParam: (id: string, value: number) =>
      currentHandle && typeof currentHandle.debugSetParam === 'function' ? currentHandle.debugSetParam(id, value) : null,
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
      stripShown: voiceStripShown,
    }),
    /**
     * 语音状态条（声纹 / 转写报错）显隐 + 几何快照。
     * 自动化验证"状态条显隐时麦克风按钮坐标不变"（= 不再挤动布局）用。
     */
    voiceStrip: (on: boolean): Any => {
      if (on) showVoiceStrip();
      else hideVoiceStrip();
      return voiceStripDebug();
    },
    /** 对话消息区展开/收起（自动化验证状态条几何与窗口高度用） */
    expandChat: (): Any => { setChatCollapsed(bridge, false); return voiceStripDebug(); },
    collapseChat: (): Any => { setChatCollapsed(bridge, true); return voiceStripDebug(); },
    /**
     * 行为触发自查（排查"设置里配了但不触发"用）：
     * 当前映射、模型可用的动作组/表情、每个行为**实际解析出**的目标。
     * 解析结果是 null 就说明这个绑定在当前模型上没有对应目标。
     */
    behaviors: (): Any =>
      rendererKernel()?.call('behavior.state') ?? {
        triggers: { ...motionTriggers },
        motions: listCurrentMotions(),
        expressions: listCurrentExpressions(),
        debounceMs: {},
        resolved: {},
      },
    /** 立刻触发一次行为（跳过去抖），用于验证绑定是否生效 */
    fireBehavior: (name: string): Any => {
      if (!(BEHAVIOR_KEYS as string[]).includes(name)) return { ok: false, error: `未知行为：${name}` };
      return rendererKernel()?.call('behavior.fire', name) ?? { ok: false, error: '内核未加载' };
    },
    /**
     * 把一个触发值解析成实际目标（排查"这个值在当前模型上到底指什么"用）。
     * 支持 'motion:<动作组>' / 'expr:<表情>' / 'emotion:<标签>' / 'click' / 'costume'。
     */
    resolveTrigger: (candidate: string): Any =>
      rendererKernel()?.call('behavior.resolve', String(candidate ?? '')) ?? null,
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
        showVoiceStrip(); // 状态条本身由 renderer 控制显隐（窗口会长高一条）
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
    /**
     * 视线跟踪自查：鼠标在窗口内用指针事件、窗口外用主进程推的全局光标。
     * 这里同时给出"渲染层换算结果"和"模型实际参数"，排查"鼠标在窗口外宠物不跟"时直接看这两组值。
     */
    gaze: () => ({
      renderer: {
        ...(gazeApi()?.state() ?? {}),
        window: { screenX: window.screenX, screenY: window.screenY, w: window.innerWidth, h: window.innerHeight },
      },
      handle: currentHandle?.gaze?.() ?? null,
    }),
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

/* ================================================================
   更新检测 UI（启动检查结果 → 右键菜单项 / 设置页状态 / 前往下载）
   ================================================================ */

/** 只信任本仓库的 release 页面（与主进程 isTrustedReleaseUrl 同一规则：URL 解析 + 严格域名）。 */
function isTrustedGithubReleaseUrl(url: string): boolean {
  if (typeof url !== 'string' || !url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') return false;
    return parsed.pathname.indexOf('/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/') === 0;
  } catch {
    return false;
  }
}

const UPDATE_REASON_TEXT: Record<string, string> = {
  offline: '网络离线或 DNS 失败',
  timeout: '请求超时',
  'rate-limited': 'GitHub 限流（稍后再试）',
  'http-error': '服务器返回错误',
  'parse-error': '返回内容无法解析',
  unknown: '未知错误',
};

function formatUpdateTime(at: number | undefined): string {
  if (!at) return '';
  try {
    return new Date(at).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

/** 把一次更新检测快照渲染到设置页（更新提示的唯一入口）。 */
function renderUpdateStatus(snapshot: UpdateSnapshot): void {
  const versionEl = elementById<HTMLElement>('settings-current-version');
  if (versionEl) versionEl.textContent = snapshot.currentVersion ? `v${snapshot.currentVersion}` : '—';
  const statusEl = elementById<HTMLElement>('update-status-text');
  const state = snapshot.state;
  let text = '尚未检查';
  let isError = false;
  switch (state.kind) {
    case 'idle':
      text = '尚未检查（启动检查未开始或已跳过）';
      break;
    case 'checking':
      text = '正在检查 GitHub 更新…';
      break;
    case 'no-update':
      text = `已是最新版本${formatUpdateTime(state.checkedAt) ? `（${formatUpdateTime(state.checkedAt)} 检查）` : ''}`;
      break;
    case 'update-available':
      text = `发现新版本 v${state.release.version}${formatUpdateTime(state.checkedAt) ? `（${formatUpdateTime(state.checkedAt)} 检查）` : ''}`;
      break;
    case 'disabled':
      text = '启动时自动检查已关闭（仍可手动检查）';
      break;
    case 'error':
      text = `检查失败：${UPDATE_REASON_TEXT[state.reason] ?? UPDATE_REASON_TEXT.unknown}`;
      isError = true;
      break;
  }
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'settings-status is-error' : 'settings-status';
  }
  const openBtn = elementById<HTMLButtonElement>('btn-open-release');
  const available = state.kind === 'update-available' ? state.release : null;
  if (openBtn) {
    if (available && isTrustedGithubReleaseUrl(available.htmlUrl)) {
      openBtn.hidden = false;
      openBtn.dataset.url = available.htmlUrl;
      openBtn.textContent = `前往下载 v${available.version}`;
    } else {
      openBtn.hidden = true;
      delete openBtn.dataset.url;
    }
  }
}

/** 安装更新相关 UI：拉一次当前快照 + 订阅主进程推送 + 绑定"前往下载"按钮。 */
function installUpdateUi(bridge: RendererBridge): void {
  const openRelease = (url: string): void => {
    if (!isTrustedGithubReleaseUrl(url)) return;
    void bridge.openExternal?.(url).catch((err: unknown) => {
      console.warn('[renderer] 打开更新页面失败', err);
    });
  };
  elementById<HTMLButtonElement>('btn-open-release')?.addEventListener('click', () => {
    const url = elementById<HTMLButtonElement>('btn-open-release')?.dataset.url || '';
    if (url) openRelease(url);
  });
  // 启动时主动拉一次快照：启动检查可能在我们订阅之前就跑完（推送会丢）
  try {
    const maybe = bridge as RendererBridge & { getUpdateStatus?: () => Promise<UpdateSnapshot> };
    if (typeof maybe.getUpdateStatus === 'function') {
      void maybe.getUpdateStatus().then(renderUpdateStatus).catch(() => undefined);
    }
  } catch {
    /* 旧 preload 没有该方法：设置页保持"尚未检查" */
  }
  try {
    bridge.onUpdateStatus?.((snapshot) => renderUpdateStatus(snapshot));
  } catch {
    /* 旧 preload 没有推送：靠设置页打开时拉取 */
  }
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
  installGazeController(); // 视线模块：注入取景/handle getter（先于主循环与事件接线）
  startLoop();
  installVisibilityHooks();
  installIdleHooks(); // 空闲降帧：无交互一段时间后把帧上限降到 24fps
  installTtsAudioUnlock(); // 首次点击/按键就把音频通道解锁（TTS 是异步回来的，手势早失效了）

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
  vtsTrackingBridge = bridge; // VTS 追踪推送目标（主循环里用；未启用时不会被调用）
  await installRendererKernel(); // 策略插件先就位（行为配置/对话事件都要在触发前有订阅者）
  // 行为触发映射：**必须在这里载入**（不能只在打开设置面板时）——否则不打开设置/重启后，
  // 设置里配好的"动作或表情"永远不会播（退回 'auto' 时多数是看不出变化的 Idle）。
  await loadBehaviorTriggers(bridge);
  installTrackingHub(); // 追踪参数中枢（语音口型 + 文本情感；骨骼/外部追踪预留入口）
  subscribeOptionalPushes(bridge);
  installChatAttachmentUi(bridge); // 聊天附件：图片/音频/文件（发送前做兼容性检查）
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
  installUpdateUi(bridge); // 更新检测：拉快照 + 订阅推送 + "前往下载"按钮
  installDragScroll(elementById<HTMLElement>('settings-form'));

  bootRecord('bridge 就绪');
  const manifest = await loadDefaultModel(bridge);
  bootRecord('拿到模型 manifest');
  if (manifest) {
    await mountManifest(manifest);
    bootRecord('模型挂载完成');
    applyPresetParameterMap(); // pet-model.json 的 parameterMap（命名不标准的模型靠它对齐）
    fireStartupBehavior(); // 启动行为：模型就绪后触发一次（设置里的「启动」绑定）
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
      applyPetName(bootSettings.petName); // 设置里的桌宠名字：问候语/输入框提示立刻用上
      applySfxSettings(bootSettings);
      applyTtsSettings(bootSettings); // 不打开设置页也要按设置自动朗读
      setVtsTrackingEnabled(bootSettings.vtsEnabled === true); // 不打开设置页也要按设置同步 VTS
      // 模型已挂载完成 → 现在才知道它有哪些动作组/表情：把该模型自己的行为触发绑定套上
      applyBehaviorTriggersFromSettings(bootSettings);
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


/* ================================================================
   聊天附件（用户→AI 的图片/音频/文件）与 AI 回发媒体卡片
   ================================================================ */

type ChatAttachmentRef = import('../shared/contracts').AttachmentRef;
type ChatMediaLive = import('../shared/contracts').ChatMediaPayload;
type ChatMediaPinned = import('../shared/contracts').ChatMediaMeta;

const CHAT_MAX_ATTACHMENTS = 6;

/** 当前待发送附件（点发送后清空；失败保留） */
let pendingAttachments: ChatAttachmentRef[] = [];
let attachmentCheckSeq = 0;

/** 附件类型判定（与主进程同一套扩展名白名单；渲染层只用于暂存/展示） */
function attachmentKindOf(name: string, mime: string): ChatAttachmentRef['kind'] {
  const ext = (name.split('.').pop() || '').toLowerCase();
  const m = (mime || '').toLowerCase();
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic'].includes(ext)) return 'image';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'weba', 'webm'].includes(ext)) return 'audio';
  if (
    m.startsWith('text/') ||
    m === 'application/json' ||
    ['txt', 'md', 'json', 'csv', 'log', 'yml', 'yaml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'h', 'go', 'rs', 'sh', 'ps1', 'bat', 'cmd', 'ini', 'toml', 'sql'].includes(ext)
  ) {
    return 'text';
  }
  return 'file';
}

function attachmentMeta(att: ChatAttachmentRef): ChatMediaPinned {
  return { kind: att.kind === 'image' ? 'image' : att.kind === 'audio' ? 'audio' : 'file', name: att.name, mime: att.mime, size: att.size, path: att.path };
}

/** 实时 payload → 可持久化元数据（不存 base64） */
function mediaPayloadToMeta(payload: ChatMediaLive): ChatMediaPinned {
  return { kind: payload.kind, name: payload.name, mime: payload.mime, size: payload.size, path: payload.path, caption: payload.caption };
}

function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 组装媒体卡片：实时 payload 优先（图片/音频带 dataUrl 可直接显示/播放），历史只有路径时显示文件卡 */
function buildMediaCards(items: Array<ChatMediaLive | ChatMediaPinned>): HTMLElement | null {
  if (!items.length) return null;
  const wrap = document.createElement('div');
  wrap.className = 'chat-media-list';
  for (const item of items) {
    const live = item as ChatMediaLive;
    const card = document.createElement('div');
    card.className = `chat-media-card is-${item.kind}`;
    if (item.kind === 'image' && live.dataUrl) {
      const img = document.createElement('img');
      img.className = 'chat-media-image';
      img.src = live.dataUrl;
      img.alt = item.name;
      card.appendChild(img);
    } else if (item.kind === 'audio' && live.dataUrl) {
      const audio = document.createElement('audio');
      audio.className = 'chat-media-audio';
      audio.controls = true;
      audio.src = live.dataUrl;
      card.appendChild(audio);
    } else {
      const icon = document.createElement('span');
      icon.className = 'chat-media-icon';
      icon.textContent = item.kind === 'image' ? '🖼️' : item.kind === 'audio' ? '🎵' : '📄';
      card.appendChild(icon);
    }
    const meta = document.createElement('div');
    meta.className = 'chat-media-meta';
    const name = document.createElement('span');
    name.className = 'chat-media-name';
    name.textContent = item.name;
    const size = document.createElement('span');
    size.className = 'chat-media-size';
    size.textContent = humanSize(item.size);
    meta.append(name, size);
    if (item.caption) {
      const cap = document.createElement('span');
      cap.className = 'chat-media-caption';
      cap.textContent = item.caption;
      meta.appendChild(cap);
    }
    card.appendChild(meta);
    if (item.path) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'chat-media-open';
      open.textContent = '打开';
      open.title = '用系统程序打开（历史文件若已被清理会打不开）';
      open.addEventListener('click', () => {
        void chatBridge?.openPath?.(item.path as string).catch(() => undefined);
      });
      card.appendChild(open);
    }
    wrap.appendChild(card);
  }
  return wrap;
}

/** AI 回发媒体：聊天里显示卡片 + 落盘记录（历史里保留媒体元数据） */
function appendIncomingMedia(bridge: RendererBridge, payload: ChatMediaLive): void {
  const meta = mediaPayloadToMeta(payload);
  appendChatLog('pet', payload.caption ?? '', { persist: false, live: [payload] });
  void bridge.chatLogAppend?.({ role: 'pet', text: payload.caption ?? '', at: Date.now(), media: [meta] }).catch(() => undefined);
  if (!payload.caption) {
    const label = payload.kind === 'image' ? '图片' : payload.kind === 'audio' ? '音频' : '文件';
    showBubble(`📎 发来一个${label}：${payload.name}`, { ttlMs: 3600 });
  }
  chatScrollToEnd();
}

function setAttachmentHint(text: string, isError: boolean): void {
  const el = elementById<HTMLElement>('chat-attachments-hint');
  if (!el) return;
  el.textContent = text;
  el.hidden = !text;
  el.className = isError ? 'chat-attachments-hint is-error' : 'chat-attachments-hint';
}

/** 渲染待发送附件 chips（带移除按钮） */
function renderPendingAttachments(): void {
  const box = elementById<HTMLElement>('chat-attachments');
  if (!box) return;
  box.replaceChildren();
  box.hidden = pendingAttachments.length === 0;
  pendingAttachments.forEach((att, index) => {
    const chip = document.createElement('div');
    chip.className = `chat-attachment-chip is-${att.kind}`;
    const icon = document.createElement('span');
    icon.className = 'chat-attachment-icon';
    icon.textContent = att.kind === 'image' ? '🖼️' : att.kind === 'audio' ? '🎵' : att.kind === 'text' ? '📝' : '📄';
    const name = document.createElement('span');
    name.className = 'chat-attachment-name';
    name.textContent = att.name;
    name.title = att.path;
    const size = document.createElement('span');
    size.className = 'chat-attachment-size';
    size.textContent = humanSize(att.size);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'chat-attachment-remove';
    rm.textContent = '×';
    rm.title = '移除这个附件';
    rm.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      pendingAttachments.splice(index, 1);
      renderPendingAttachments();
      void refreshAttachmentCompatibility(getBridgeForChat() ?? undefined);
    });
    chip.append(icon, name, size, rm);
    box.appendChild(chip);
  });
}

/** 发送前兼容性检查（IPC_MEDIA_CHECK）：ok/converted/unsupported → 提示行 + chip 状态 */
async function refreshAttachmentCompatibility(bridge?: RendererBridge): Promise<void> {
  const b = bridge ?? chatBridge;
  if (!b || !pendingAttachments.length) {
    setAttachmentHint('', false);
    return;
  }
  const seq = ++attachmentCheckSeq;
  if (typeof b.checkMedia !== 'function') return;
  try {
    const result = await b.checkMedia(pendingAttachments);
    if (seq !== attachmentCheckSeq) return;
    const box = elementById<HTMLElement>('chat-attachments');
    const unsupported = new Set(result.items.filter((i) => i.status === 'unsupported').map((i) => i.attachment.path));
    box?.querySelectorAll<HTMLElement>('.chat-attachment-chip').forEach((chip, i) => {
      const att = pendingAttachments[i];
      if (!att) return;
      chip.classList.toggle('is-unsupported', unsupported.has(att.path));
      const item = result.items.find((it) => it.attachment.path === att.path);
      if (item?.hint) chip.title = item.hint;
    });
    if (!result.ok) setAttachmentHint(result.summary || '当前 AI 不支持这些附件', true);
    else if (result.summary) setAttachmentHint(result.summary, false);
    else setAttachmentHint('', false);
  } catch (err) {
    setAttachmentHint(`附件检查失败：${(err as Error).message ?? String(err)}`, true);
  }
}

/** 追加文件（选择/拖拽/粘贴共用）：拿路径 → 没路径就暂存字节 */
async function addFilesToChat(bridge: RendererBridge, files: File[]): Promise<void> {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;
  for (const file of list) {
    if (pendingAttachments.length >= CHAT_MAX_ATTACHMENTS) {
      setAttachmentHint(`一条消息最多 ${CHAT_MAX_ATTACHMENTS} 个附件`, true);
      break;
    }
    const kind = attachmentKindOf(file.name || 'file', file.type || '');
    let localPath = '';
    try {
      const maybe = bridge as RendererBridge & { pathForFile?: (f: File) => string };
      if (typeof maybe.pathForFile === 'function') localPath = maybe.pathForFile(file) || '';
    } catch {
      localPath = '';
    }
    if (!localPath) {
      try {
        const buf = await file.arrayBuffer();
        const staged = await bridge.stageAttachment?.(buf, file.name || `attachment-${Date.now()}`, file.type || '');
        if (staged && staged.ok && staged.path) localPath = staged.path;
        else {
          setAttachmentHint(staged?.error ? `附件暂存失败：${staged.error}` : '附件暂存失败', true);
          continue;
        }
      } catch (err) {
        setAttachmentHint(`附件读取失败：${(err as Error).message ?? String(err)}`, true);
        continue;
      }
    }
    pendingAttachments.push({ path: localPath, name: file.name || localPath.split(/[\\/]/).pop() || 'file', mime: file.type || '', size: file.size || 0, kind });
  }
  renderPendingAttachments();
  await refreshAttachmentCompatibility(bridge);
}

function clearPendingAttachments(): void {
  pendingAttachments = [];
  attachmentCheckSeq++;
  renderPendingAttachments();
  setAttachmentHint('', false);
}

function getPendingAttachments(): ChatAttachmentRef[] {
  return pendingAttachments.slice();
}

function getBridgeForChat(): RendererBridge | null {
  return chatBridge;
}

/** 附件 UI 绑定：📎 按钮、文件选择、拖拽、粘贴、移除 */
function installChatAttachmentUi(bridge: RendererBridge): void {
  const attachBtn = elementById<HTMLButtonElement>('chat-attach');
  const fileInput = elementById<HTMLInputElement>('chat-file-input');
  attachBtn?.addEventListener('click', () => {
    try {
      fileInput?.click();
    } catch {
      /* ignore */
    }
  });
  fileInput?.addEventListener('change', () => {
    const files = Array.from(fileInput.files ?? []);
    fileInput.value = '';
    void addFilesToChat(bridge, files);
  });
  const bar = elementById<HTMLElement>('chatbar');
  if (bar) {
    bar.addEventListener('dragover', (event) => {
      if (!(event as DragEvent).dataTransfer) return;
      event.preventDefault();
      bar.classList.add('is-dragover');
    });
    bar.addEventListener('dragleave', () => bar.classList.remove('is-dragover'));
    bar.addEventListener('drop', (event) => {
      const dt = (event as DragEvent).dataTransfer;
      if (!dt || !dt.files || !dt.files.length) return;
      event.preventDefault();
      bar.classList.remove('is-dragover');
      void addFilesToChat(bridge, Array.from(dt.files));
    });
    bar.addEventListener('paste', (event) => {
      const files = Array.from((event as ClipboardEvent).clipboardData?.files ?? []);
      if (!files.length) return;
      event.preventDefault();
      void addFilesToChat(bridge, files);
    });
  }
}



/* ================================================================
   投屏抓屏（手机端「电脑投屏」需要 ≥24fps）：
   desktopCapturer.getSources 单次约 300ms，无法做 24fps；
   这里用 getDisplayMedia 拿持续 MediaStream，按目标帧率 draw 到隐藏 canvas，
   编码 JPEG 后经 IPC 交给主进程广播（不落盘、不阻塞 UI）。
   ================================================================ */
let castCaptureStream: MediaStream | null = null;
let castCaptureTimer: number | null = null;
let castCaptureVideo: HTMLVideoElement | null = null;
let castCaptureCanvas: HTMLCanvasElement | null = null;
let castCaptureWorkers: Worker[] | null = null;
let castCaptureWorkerUrl: string | null = null;

function stopCastCapture(): void {
  if (castCaptureTimer !== null) {
    window.clearInterval(castCaptureTimer);
    castCaptureTimer = null;
  }
  if (castCaptureStream) {
    for (const track of castCaptureStream.getTracks()) {
      try { track.stop(); } catch { /* ignore */ }
    }
    castCaptureStream = null;
  }
  if (castCaptureVideo) {
    try { castCaptureVideo.pause(); } catch { /* ignore */ }
    castCaptureVideo.srcObject = null;
    castCaptureVideo.remove();
    castCaptureVideo = null;
  }
  castCaptureCanvas = null;
  if (castCaptureWorkers) {
    for (const w of castCaptureWorkers) {
      try { w.terminate(); } catch { /* ignore */ }
    }
    castCaptureWorkers = null;
  }
  if (castCaptureWorkerUrl) {
    try { URL.revokeObjectURL(castCaptureWorkerUrl); } catch { /* ignore */ }
    castCaptureWorkerUrl = null;
  }
}

async function startCastCapture(payload: { maxWidth?: number; fps?: number; quality?: number; sourceId?: string }): Promise<void> {
  stopCastCapture();
  const fps = Math.max(1, Math.min(30, Math.round(payload.fps ?? 24)));
  const maxWidth = Math.max(320, Math.min(1920, Math.round(payload.maxWidth ?? 1280)));
  const quality = Math.max(0.35, Math.min(0.95, Number(payload.quality ?? 70) / 100));
  try {
    // 优先 legacy desktop getUserMedia（部分 Windows/Electron 环境比 getDisplayMedia 帧率高）；
    // 失败则退回 getDisplayMedia（由主进程 setDisplayMediaRequestHandler 选屏）。
    let stream: MediaStream | null = null;
    if (payload.sourceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: payload.sourceId,
              maxWidth,
              maxHeight: 1200,
              maxFrameRate: 30,
            },
          },
        } as unknown as MediaStreamConstraints);
      } catch (err) {
        console.warn('[renderer] legacy getUserMedia 抓屏失败，回退 getDisplayMedia：', err);
        stream = null;
      }
    }
    if (!stream) {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: Math.max(fps, 30), max: 30 } },
        audio: false,
      } as MediaStreamConstraints);
    }
    castCaptureStream = stream;
    try {
      await stream.getVideoTracks()[0]?.applyConstraints({ frameRate: { ideal: 30, max: 30 } } as MediaTrackConstraints);
    } catch { /* 部分平台不支持在 track 上改帧率 */ }
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;';
    video.srcObject = stream;
    document.body.appendChild(video);
    castCaptureVideo = video;
    const castStats: any = {
      videoFrames: 0, sourceFps: 0, tickCount: 0, tickFps: 0,
      workerDone: 0, workerFps: 0, encodeMsTotal: 0, encodeMsAvg: 0,
      startedAt: Date.now(), settings: null,
    };
    (window as any).__petCastStats = castStats;
    const countVideoFrame = (): void => {
      castStats.videoFrames += 1;
      const elapsed = (Date.now() - castStats.startedAt) / 1000;
      if (elapsed > 0) castStats.sourceFps = Math.round((castStats.videoFrames / elapsed) * 10) / 10;
      if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(countVideoFrame);
    };
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(countVideoFrame);
    await video.play().catch(() => { /* Electron 自动播放策略通常允许 */ });
    castStats.settings = JSON.stringify(stream.getVideoTracks()[0]?.getSettings() ?? {});
    // 等首帧尺寸就绪（部分机器 videoWidth 在 play 后下一拍才更新）
    for (let i = 0; i < 30 && (!video.videoWidth || !video.videoHeight); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const vw = video.videoWidth || 1280;
    const vh = video.videoHeight || 720;
    const scale = Math.min(1, maxWidth / vw);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(2, Math.round(vw * scale));
    canvas.height = Math.max(2, Math.round(vh * scale));
    castCaptureCanvas = canvas;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('canvas 2d 不可用');
    const intervalMs = Math.max(16, Math.round(1000 / fps));
    // JPEG 编码放 Worker 池（2 路并行）：浏览器主线程编码 ~20fps，达不到 24fps
    const workerCode = `
      // 关键：canvas/context 必须复用。每帧 new OffscreenCanvas 在本机实测多出 ~60ms。
      let sharedCanvas = null;
      let sharedCtx = null;
      let sharedW = 0;
      let sharedH = 0;
      self.onmessage = async (e) => {
        const { frame, bitmap, width, height, quality, id } = e.data;
        try {
          if (!sharedCanvas || sharedW !== width || sharedH !== height) {
            sharedCanvas = new OffscreenCanvas(width, height);
            sharedCtx = sharedCanvas.getContext('2d', { alpha: false });
            sharedW = width;
            sharedH = height;
          }
          const src = frame || bitmap;
          sharedCtx.drawImage(src, 0, 0, width, height);
          if (src && src.close) src.close();
          const encodeStart = performance.now();
          const blob = await sharedCanvas.convertToBlob({ type: 'image/webp', quality });
          const encodeMs = performance.now() - encodeStart;
          const buf = await blob.arrayBuffer();
          self.postMessage({ id, buf, encodeMs }, [buf]);
        } catch (err) {
          self.postMessage({ id, error: String(err) });
        }
      };
    `;
    const workerUrl = URL.createObjectURL(new Blob([workerCode], { type: 'text/javascript' }));
    const castWorkers = [new Worker(workerUrl), new Worker(workerUrl)];
    castCaptureWorkers = castWorkers;
    castCaptureWorkerUrl = workerUrl;
    const castInFlight = [0, 0];
    let castWorkerIndex = 0;
    let castFrameId = 0;
    for (let wi = 0; wi < castWorkers.length; wi += 1) {
      castWorkers[wi].onmessage = (event: MessageEvent) => {
        castInFlight[wi] = Math.max(0, castInFlight[wi] - 1);
        const data = event.data as { buf?: ArrayBuffer; error?: string; id?: number; encodeMs?: number };
        castStats.workerDone += 1;
        const workerElapsed = (Date.now() - castStats.startedAt) / 1000;
        if (workerElapsed > 0) castStats.workerFps = Math.round((castStats.workerDone / workerElapsed) * 10) / 10;
        if (typeof data.encodeMs === 'number') {
          castStats.encodeMsTotal += data.encodeMs;
          castStats.encodeMsAvg = Math.round((castStats.encodeMsTotal / castStats.workerDone) * 10) / 10;
        }
        if (data.buf && castCaptureStream) {
          try { window.electron.sendCastFrame(data.buf); } catch (err) { console.warn('[renderer] 投屏帧发送失败：', err); }
        }
      };
    }
    const imageCapture = (() => {
      try {
        const track = stream.getVideoTracks()[0];
        return track && typeof ImageCapture !== 'undefined' ? (new ImageCapture(track) as any) : null;
      }
      catch { return null; }
    })();
    let castRawInFlight = false;
    const tick = (): void => {
      if (!castCaptureStream || !castCaptureVideo || castRawInFlight) return;
      castStats.tickCount += 1;
      const tickElapsed = (Date.now() - castStats.startedAt) / 1000;
      if (tickElapsed > 0) castStats.tickFps = Math.round((castStats.tickCount / tickElapsed) * 10) / 10;
      castRawInFlight = true;
      const grab: Promise<ImageBitmap> = imageCapture
        ? (imageCapture as any).grabFrame()
        : createImageBitmap(castCaptureVideo);
      grab.then((bitmap: ImageBitmap) => {
        if (!castCaptureStream) { bitmap.close(); castRawInFlight = false; return; }
        try {
          // 原始像素交 main：nativeImage.toJPEG 原生编码，远快于 Canvas/Worker 的 JS 编码
          ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          bitmap.close();
          const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
          window.electron.sendCastRawFrame(pixels.data.buffer, canvas.width, canvas.height, Math.round(quality * 100));
          castStats.workerDone += 1;
          const workerElapsed = (Date.now() - castStats.startedAt) / 1000;
          if (workerElapsed > 0) castStats.workerFps = Math.round((castStats.workerDone / workerElapsed) * 10) / 10;
        }
        catch (err) {
          console.warn('[renderer] 投屏原始帧发送失败：', err);
        }
        finally {
          castRawInFlight = false;
        }
      }).catch(() => { castRawInFlight = false; });
    };
    castCaptureTimer = window.setInterval(tick, intervalMs);
    tick();
    const track = stream.getVideoTracks()[0];
    track?.addEventListener('ended', () => {
      console.warn('[renderer] 投屏共享被系统结束');
      stopCastCapture();
    });
  } catch (err) {
    console.warn('[renderer] 投屏抓屏启动失败（getDisplayMedia）：', err);
    stopCastCapture();
  }
}

function installCastCapture(): void {
  const bridge = window.electron;
  if (!bridge?.onCastCapture) return;
  bridge.onCastCapture((payload) => {
    if (payload.action === 'start') {
      void startCastCapture(payload);
    } else {
      stopCastCapture();
    }
  });
}

installCastCapture();
