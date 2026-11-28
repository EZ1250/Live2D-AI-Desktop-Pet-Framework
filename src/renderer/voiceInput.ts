/**
 * voiceInput.ts —— 语音输入状态机（按住说话 → ASR → 填入输入框）
 *
 * 从 renderer.ts 拆出的独立全局脚本（无 import/export，由 index.html 在 renderer.js 之前加载）。
 * 拆分原因：renderer.ts 曾达 6,125 行，资产面板/语音输入/思考浮窗是三块边界清晰的声明区，
 * 单独成文件便于定位与 review；它们与 renderer.ts 共享同一个全局作用域（函数声明在脚本加载时
 * 即已可用），所以调用方代码不需要任何改动。
 *
 * 注意：本文件顶层只有声明，没有可执行语句——顺序上只要求先于 renderer.js 加载（见 index.html）。
 */

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
let voiceMaxTimer: number | null = null;
let voiceMouthTimer: number | null = null;
let voiceAudioCtx: AudioContext | null = null;
let voiceAnalyser: AnalyserNode | null = null;
let voiceMouthBuf: Uint8Array | null = null;
/** 语音状态文案的自动收起定时器（见 setVoiceState） */
let voiceRowTimer: number | null = null;
/**
 * "按下说话"的代际号。
 *
 * 一次按下会走两条 await（查配置 → 开麦克风）。如果用户按一下、松开、马上再按一下，
 * 两次 await 会交叠：前一条链路醒来时状态已经是新一轮的 arming，只看状态判断会被它
 * 蒙混过关，于是把**上一次**的麦克风接回来（第二路 getUserMedia 也会覆盖 voiceStream，
 * 旧流泄漏、录音器被建两遍）。所以每条链路认领一个代际号，醒来先对号。
 */
let voicePressSeq = 0;
/** "按住说话"的指针容差（px）：指针在这个范围内一律不算"移开按钮"，见 cancelByPointerAway */
const VOICE_LEAVE_PAD_PX = 16;
/** 外部可挂的唤醒词回调（当前不做常驻唤醒；留给将来接本地/系统级唤醒词） */
let wakeWordHook: ((word: string) => void) | null = null;

/* ---- 语音状态条（声纹 + 转写报错）：贴在对话气泡正上方 ————
   为什么单独做一条：以前声纹条插在输入行前面的文档流里，一显示就把输入行（连同按住的
   麦克风按钮）顶走 —— 指针随即"离开"按钮，pointerleave 直接把录音取消掉，看起来就是
   "语音输入起不来"；报错则写进消息区，而消息区在折叠态是整片隐藏的 → 报错也看不见。
   现在：绝对定位的状态条 + 气泡窗模式下由主进程把窗口向上长高一条（底边钉住），
   气泡本体在屏幕上原地不动，输入行绝不移位。 */
let voiceStripShown = false;

function voiceStripEl(): HTMLElement | null {
  return document.getElementById('pet-voice-lab');
}

function voiceStripTextEl(): HTMLElement | null {
  return document.getElementById('pet-voice-status');
}

/**
 * 显示状态条。气泡窗模式下**先让窗口向上长高一条再加 class**：这样气泡在屏幕上一步都不动
 * （窗口变高时输入行本来就贴着底边，加 class 后气泡缩回原高、底边仍在原处）。
 */
function showVoiceStrip(): void {
  const el = voiceStripEl();
  if (el) el.hidden = false;
  if (voiceStripShown) return;
  voiceStripShown = true;
  // 按**当前**意愿落 class：IPC 是异步的，快速"显示→收起"时后到的回调不能把状态带回去
  const apply = (): void => { document.body.classList.toggle('is-voice-strip', voiceStripShown); };
  const bridge = CHAT_PANEL_MODE ? chatBridge ?? getBridge() : null;
  const pending = bridge?.chatWindowVoiceStrip?.(true);
  if (pending && typeof pending.then === 'function') {
    void pending.then(apply).catch(apply);
    return;
  }
  apply();
}

/** 收起状态条（幂等）。窗口先缩回原高、再摘 class，避免气泡在屏幕上跳一下。 */
function hideVoiceStrip(): void {
  const el = voiceStripEl();
  if (el) el.hidden = true;
  if (!voiceStripShown) return;
  voiceStripShown = false;
  const apply = (): void => { document.body.classList.toggle('is-voice-strip', voiceStripShown); };
  const bridge = CHAT_PANEL_MODE ? chatBridge ?? getBridge() : null;
  const pending = bridge?.chatWindowVoiceStrip?.(false);
  if (pending && typeof pending.then === 'function') {
    void pending.then(apply).catch(apply);
    return;
  }
  apply();
}

/**
 * 状态条 / 输入行 / 麦克风按钮的几何快照（调试与自动化验证用）。
 * 关键断言就一条：**状态条显隐前后 `mic` 的坐标不许变**（变了就说明又挤动布局了，
 * 那正是"按住说话起不来"的老病根）。
 */
function voiceStripDebug(): Any {
  const rect = (el: Element | null): Any => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    shown: voiceStripShown,
    mode: CHAT_PANEL_MODE ? 'chat-window' : 'in-window',
    win: { w: window.innerWidth, h: window.innerHeight },
    strip: rect(voiceStripEl()),
    text: voiceStripTextEl()?.textContent ?? null,
    bar: rect(document.getElementById('chatbar')),
    inputRow: rect(document.querySelector('.chat-input-row')),
    mic: rect(document.getElementById('chat-mic')),
    lab: voiceLab()?.state() ?? null,
  };
}

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

/**
 * 语音状态文案：写到**气泡上方的状态条**里（不再往聊天记录插行）。
 *
 * 两条硬理由：
 *   1) 聊天记录（#chat-log）在气泡窗的折叠态是 `display:none`，而折叠态正是气泡窗打开时的
 *      默认形态 —— 写进去的报错用户根本看不见（"按住说话没反应"最容易被忽视的原因）；
 *   2) 状态条是绝对定位的，写文案不会挤动输入行，麦克风按钮原地不动。
 * 文案不持久化：转写结果进输入框，历史上不该留"录音中…"这种瞬时状态。
 */
function setVoiceRow(text: string, tone: 'info' | 'error' = 'info'): void {
  const el = voiceStripTextEl();
  if (!el) return;
  showVoiceStrip();
  el.textContent = tone === 'error' ? `⚠️ ${text}` : `🎤 ${text}`;
  el.classList.toggle('is-error', tone === 'error');
  el.hidden = false;
}

/** 清掉状态文案并收起状态条（幂等） */
function clearVoiceRow(): void {
  const el = voiceStripTextEl();
  if (el) {
    el.textContent = '';
    el.classList.remove('is-error');
  }
  hideVoiceStrip();
}

/** 各状态的文案停留时长（0/未列出 = 一直留到状态自己变） */
const VOICE_ROW_HIDE_MS: Partial<Record<VoiceState, number>> = {
  error: 6000,
  ready: 6500,
  cancelled: 2400,
};

/**
 * 状态切换：按钮外观 + 状态条文案 + 收尾（停录音/停口型）都集中在这里。
 *
 * 顺序很重要：**先收声纹（stopVoiceWave），再写文案**。反过来的话，收声纹那一步会把
 * 状态条吞掉，"转写中… / 转写失败…"这些字就永远看不见（这是修复前报错消失的原因之一）。
 */
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
  // 声纹只在"连接中/录音中"存在；其它状态一律收掉（转写/完成/报错由状态条文案表达）
  if (next !== 'listening' && next !== 'arming') stopVoiceWave();
  if (next === 'idle' || next === 'ready' || next === 'error' || next === 'cancelled') stopVoiceMouth();
  if (text) setVoiceRow(text, tone);
  // idle 一定伴随状态条收起：不带文案的 idle 也要把旧文案清掉，否则它会一直挂在气泡上方
  else if (next === 'idle') clearVoiceRow();
  scheduleVoiceRowHide(next);
}

/**
 * 状态文案的自动收起：集中在这里，避免每个分支各写一个 setTimeout ——
 * 漏写的那条分支（例如"当前版本没有接入语音转写"）会让状态条永远留在气泡上方。
 */
function scheduleVoiceRowHide(next: VoiceState): void {
  if (voiceRowTimer) {
    window.clearTimeout(voiceRowTimer);
    voiceRowTimer = null;
  }
  const ms = VOICE_ROW_HIDE_MS[next];
  if (!ms) return;
  voiceRowTimer = window.setTimeout(() => {
    voiceRowTimer = null;
    if (voiceState !== next) return; // 期间又变了 → 交给新的状态处理
    clearVoiceRow();
    setVoiceState('idle');
  }, ms);
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
  voicePressSeq += 1; // 让还在 await 里的那条链路作废（否则它会把刚放掉的麦克风又接回来）
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
    return;
  }
  if (!voiceStream) {
    // 按住够久但麦克风还没就绪（授权/设备慢）就松手了：这段没录到，说清楚原因
    setVoiceState('cancelled', '语音未发送（麦克风还没就绪就松手了）');
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
}

/**
 * 按下麦克风（**同步**进入 arming）。
 *
 * 为什么必须同步：以前这里是 `await bridge.voiceStatus()` 之后才 setVoiceState('arming')，
 * 于是"按下后马上松手"（或松手正好落在 IPC 往返期间）时状态还是 idle，document 上的 pointerup
 * 什么都不做，随后录音启动 → 状态卡在 listening 直到 60s 上限（表现为"麦克风自己开着"）。
 * 现在按键当场记时间、当场进 arming，松手一定能被 finishVoiceCapture 接住。
 */
function beginVoicePress(): void {
  if (voiceState === 'arming' || voiceState === 'listening' || voiceState === 'transcribing') return;
  if (chatViewingSessionId) {
    // 走状态条而不是工具条状态：气泡窗折叠态下工具条状态是隐藏的，写进去等于没说
    setChatToolbarStatus('正在查看历史对话，先点「返回当前」再发语音', true);
    setVoiceState('error', '正在查看历史对话，先点「返回当前」再发语音', 'error');
    return;
  }
  const bridge = chatBridge ?? getBridge();
  if (!bridge || typeof bridge.voiceTranscribe !== 'function') {
    setVoiceState('error', '当前版本没有接入语音转写', 'error');
    return;
  }
  voiceArmAt = performance.now();
  voicePressSeq += 1;
  const seq = voicePressSeq;
  setVoiceState('arming');
  // 状态条 + 声纹：先亮起来再连接麦克风，用户按下立刻有反馈
  showVoiceStrip();
  if (!startVoiceWave('正在连接语音')) setVoiceRow('语音输入 · 准备中');
  void startVoiceCapture(bridge, seq);
}

/** 连接麦克风并开始录音（异步部分；失败一律转成一条可读文案，不抛异常） */
async function startVoiceCapture(bridge: RendererBridge, seq: number): Promise<void> {
  /** 这一次按下还算数吗？（期间松手/取消/又按了新的 → 老链路必须自己作废） */
  const pressAlive = (): boolean => seq === voicePressSeq && currentVoiceState() === 'arming';
  // 先问主进程"配置好了没"：没配就不要弹麦克风权限（避免用户白授权）
  if (typeof bridge.voiceStatus === 'function') {
    try {
      const st = await bridge.voiceStatus();
      if (!pressAlive()) return; // 期间已经松手/取消/又按了一下 → 不要再开麦克风
      if (st && st.configured === false) {
        setVoiceState('error', st.hint || '语音输入未配置（设置 → AI 接口地址与密钥）', 'error');
        return;
      }
    } catch (err) {
      console.warn('[renderer] voiceStatus 查询失败（继续尝试录音）', err);
    }
  }
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
  if (!pressAlive()) {
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
/**
 * 指针是否仍在按钮附近（含容差）。
 *
 * 为什么需要：按钮的位置会随布局变化（窗口改高、消息区滚动、状态条显隐、贴到屏幕边缘被
 * 夹回来…）。布局一变，浏览器在下一次鼠标移动时就会补发 pointerleave —— 指针其实一步没动，
 * 却被当成"用户走开了"，录音当场被取消（这正是"按住说话起不来"的病根）。
 *
 * 所以判据是"指针相对**按钮**在哪"，而不是"按钮现在在哪"：
 *   ① 指针落在按钮**当前**矩形内（±容差）；或
 *   ② 指针落在**按下当时**的按钮矩形内（±容差）。
 * 两条都不成立，才算用户真的把指针拖走了（此时才取消）。
 * 因为按下点必然落在按下当时的矩形里，所以"按钮自己挪走、指针没动"这条路径一定走 ② 而不取消。
 */
function installVoiceInput(): void {
  const btn = voiceButton();
  if (!btn) return;
  /** 按下时的按钮矩形（判断"到底是谁动了"的基准） */
  let pressRect: { left: number; top: number; right: number; bottom: number } | null = null;
  const insideRect = (
    r: { left: number; top: number; right: number; bottom: number } | null,
    x: number,
    y: number,
    pad: number
  ): boolean => !!r && x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad;
  const stillNearButton = (event: PointerEvent): boolean => {
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    // 拿不到坐标（合成事件/异常）→ 宁可不取消，也不能把录音误杀
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return true;
    const r = btn.getBoundingClientRect();
    if (!r.width && !r.height) return true; // 按钮被藏起来时也不在这里判取消
    return insideRect(r, x, y, VOICE_LEAVE_PAD_PX) || insideRect(pressRect, x, y, VOICE_LEAVE_PAD_PX);
  };
  const cancelByPointerAway = (event: PointerEvent): void => {
    if (voiceState !== 'listening' && voiceState !== 'arming') return;
    if (event.relatedTarget && (btn === event.relatedTarget || btn.contains(event.relatedTarget as Node))) return;
    if (stillNearButton(event)) return; // 布局位移造成的假"离开" → 不取消
    finishVoiceCapture(true);
  };
  btn.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const r = btn.getBoundingClientRect();
    pressRect = { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    // 同步进入 arming：松手事件一定接得住（见 beginVoicePress 的注释）
    beginVoicePress();
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
    start: () => beginVoicePress(),
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
  // 附件（图片/音频/文件）：即使没打字也可以只发附件；发送前已做过兼容性检查
  const attachments = typeof getPendingAttachments === 'function' ? getPendingAttachments() : [];
  if (!text && attachments.length === 0) return;
  chatSending = true;
  if (sendBtn) {
    sendBtn.disabled = true;
  }
  // 先取走文字并清空输入框：AI 回复期间用户可继续组织下一句
  input.value = '';
  input.classList.remove('is-prefilled');
  try {
    // 用户消息立即回显；AI 回复随后经 onChat → feedChatDelta 覆盖/续打同一气泡
    const shownText = text || (attachments.length ? '📎 已发送附件' : '');
    showBubble(`你：${text || '📎 附件'}`, { immediate: true, ttlMs: 2000 });
    pendingUserRow = appendChatLog(
      'user',
      shownText,
      attachments.length ? { media: attachments.map((att) => (typeof attachmentMeta === 'function' ? attachmentMeta(att) : undefined)).filter(Boolean) as import('../shared/contracts').ChatMediaMeta[] } : undefined,
    );
    markUserRowSending(pendingUserRow);
    streamRowEl = null; // 新的一轮：流式行从头开始
    aiStartEmitted = false;
    emitBehavior('user_message'); // 桌宠窗口内发消息：本地触发（气泡窗发的那条由主进程转发）
    const res = await bridge.sendMessage(text, attachments);
    if (!res.ok) {
      // 契约未携带 error 字段：给出通用失败提示（空消息/主进程拒绝等）
      const why = '发送失败：消息未送达，请检查 AI 设置后重试';
      showBubble(why, { tone: 'error', immediate: true, ttlMs: 3200 });
      markUserRowFailed(pendingUserRow, '消息未送达');
      appendChatLog('error', why);
    } else {
      if (attachments.length && typeof clearPendingAttachments === 'function') clearPendingAttachments();
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
