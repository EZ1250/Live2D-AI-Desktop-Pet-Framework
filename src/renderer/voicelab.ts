/**
 * voicelab.ts —— 声纹（实时输入电平波形）显示
 *
 * 仅负责绘制输入电平波形，不处理录音或网络请求：
 *   - 波形是**镜像对称带**：上半 `12 - v`、下半 `12 + v`，下半逆序后闭合（viewBox 0 0 160 24）；
 *   - 40 点历史，每帧最多 50ms 更新一次（`dirty` + `lastFrame`）；
 *   - 平滑 `smoothed = smoothed*0.3 + rms*0.7`（静音直接归零）；
 *   - 显示值 `pow(smoothed, 0.25) * 10`：**四次方根映射**把小音量提起来，不设 0 底噪也不削顶；
 *   - PCM 没来之前只显示"正在连接语音"文字、波形隐藏；
 *   - token 代际校验：旧会话的帧/电平不会污染新会话。
 *
 * 显示位置：**对话气泡正上方的状态条**（`#pet-voice-lab`，index.html 里已画好，这里只接管）。
 * 为什么不在输入行里插一行：那条状态条一出现就会把输入行（连同按住的麦克风按钮）顶走，
 * 指针随即"离开"按钮 → 录音被误判成用户走开而取消（实测的"按住说话起不来"）。
 * 现在它由 CSS 绝对定位（气泡窗模式下主进程会把窗口向上长高一条、底边钉住），
 * 因此**任何布局都不会动**。这个模块只写自己的文案与波形，不管状态条本身的显隐
 * （显隐由 renderer.ts 的状态机决定：`showVoiceStrip` / `hideVoiceStrip`）。
 *
 * 另外两条：
 *   1) **可在无 DOM 环境跑**：没有 document 时只算数据（history / path / smoothed），
 *      这样 Node 测试能直接加载本文件跑行为断言（见 tests/voicelab.test.js）。
 *   2) **无障碍**：文案是 `role="status"`（只在状态变化时更新），波形是 `role="img"` +
 *      `aria-label`，电平按"小声/正常/大声"三档粗粒度更新 `aria-valuetext`
 *      （50ms 一次的数值会吵到读屏软件，所以按档位更新）。
 *
 * 全局脚本（无 import/export、无 CommonJS 垫片），对外挂 `window.PetVoiceLab`。
 */
(() => {
  'use strict';

  /** 波形几何参数 */
  const VIEW_W = 160;
  const VIEW_H = 24;
  const MID_Y = 12;
  /** 历史点数 */
  const SAMPLES = 40;
  /** 波形的**最短**刷新间隔：比这更快的 level() 只记 latest，不重绘 */
  const MIN_FRAME_MS = 50;
  /** 平滑系数 + 显示映射（四次方根） */
  const SMOOTH_KEEP = 0.3;
  const DISPLAY_GAIN = 10;
  const IDLE_PATH = `M0 ${MID_Y} H${VIEW_W}`;

  interface VoiceLabState {
    token: number;
    active: boolean;
    phase: string;
    hasPcm: boolean;
    samples: number;
    latest: number;
    smoothed: number;
    peak: number;
    updates: number;
  }

  interface VoiceLabApi {
    begin(opts?: { label?: string; phase?: 'connecting' | 'recording' }): number;
    level(token: number, rms: number, peak?: number): void;
    configure(token: number, opts: { phase?: string; label?: string }): void;
    stop(token?: number): void;
    isActive(): boolean;
    state(): VoiceLabState;
    /** 测试/调试：按给定时间戳跑一帧（生产里由 requestAnimationFrame 驱动） */
    __tick(nowMs: number): boolean;
    /** 测试/调试：当前 SVG path 的 d 属性 */
    __path(): string;
    /** 测试/调试：DOM 是否存在 */
    __mounted(): boolean;
  }

  function hasDom(): boolean {
    return typeof document !== 'undefined' && !!document && typeof document.createElement === 'function';
  }

  function createVoiceLab(): VoiceLabApi {
    let generation = 0;
    let token = 0;
    let active = false;
    let phase = 'idle';
    let hasPcm = false;
    let dirty = false;
    let latest = 0;
    let smoothed = 0;
    let peak = 0;
    let updates = 0;
    let lastFrame = -Infinity;
    let history: number[] = [];
    let path = '';
    let rafId = 0;
    let el: HTMLElement | null = null;
    let statusEl: HTMLElement | null = null;
    let waveEl: HTMLElement | null = null;
    let pathEl: SVGPathElement | null = null;
    let ariaBucket = '';

    /** 音量档位（只用于无障碍文案，避免每 50ms 更新一次读屏内容） */
    function bucketOf(value: number): string {
      if (value <= 0.003) return '静音';
      if (value < 0.02) return '小声';
      if (value < 0.08) return '正常';
      return '大声';
    }

    /**
     * 接管页面里已经画好的状态条（`#pet-voice-lab` / `#pet-voice-status` / `#pet-voice-wave`）。
     * 页面里没有（老页面 / 测试页面）时才自己建一套并挂到 `#chatbar` 上——绝不插进输入行的文档流。
     */
    function mount(): void {
      if (!hasDom() || el) return;
      let box = document.getElementById('pet-voice-lab') as HTMLElement | null;
      if (!box) {
        const host = document.getElementById('chatbar') ?? document.body;
        if (!host) return;
        box = document.createElement('div');
        box.id = 'pet-voice-lab';
        box.className = 'pet-voice-lab';
        box.hidden = true;
        host.appendChild(box);
      }
      box.dataset.phase = box.dataset.phase || 'idle';

      let label = document.getElementById('pet-voice-status') as HTMLElement | null;
      if (!label) {
        label = document.createElement('span');
        label.id = 'pet-voice-status';
        label.className = 'pet-voice-status';
        label.setAttribute('role', 'status');
        box.appendChild(label);
      }
      if (!label.textContent) label.textContent = '正在连接语音';

      let wave = document.getElementById('pet-voice-wave') as HTMLElement | null;
      if (!wave) {
        wave = document.createElement('span');
        wave.id = 'pet-voice-wave';
        wave.className = 'pet-voice-wave';
        wave.setAttribute('role', 'img');
        wave.setAttribute('aria-label', '实时输入音量');
        wave.hidden = true;
        box.appendChild(wave);
      }
      if (!wave.querySelector('svg')) {
        // 用 createElementNS 建 SVG：innerHTML 注入 svg 在部分严格模式下命名空间会丢
        const NS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('preserveAspectRatio', 'none');
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('id', 'pet-voice-wave-path');
        p.setAttribute('d', IDLE_PATH);
        svg.appendChild(p);
        wave.appendChild(svg);
        pathEl = p;
      } else {
        pathEl = wave.querySelector('#pet-voice-wave-path') as SVGPathElement | null;
      }

      el = box;
      statusEl = label;
      waveEl = wave;
    }

    function applyPath(next: string): void {
      path = next;
      if (pathEl) pathEl.setAttribute('d', next);
    }

    function setPhase(next: string): void {
      phase = next;
      if (el) el.dataset.phase = next;
    }

    /** 按时间戳跑一帧：到点且有待处理数据才重绘（返回本帧是否重绘） */
    function tick(nowMs: number): boolean {
      if (!active) return false;
      if (!dirty || nowMs - lastFrame < MIN_FRAME_MS) return false;
      lastFrame = nowMs;
      dirty = false;
      smoothed = latest === 0 ? 0 : smoothed * SMOOTH_KEEP + latest * (1 - SMOOTH_KEEP);
      history.shift();
      history.push(Math.pow(smoothed, 0.25) * DISPLAY_GAIN);
      const step = VIEW_W / (SAMPLES - 1);
      const upper: string[] = [];
      const lower: string[] = [];
      for (let i = 0; i < history.length; i += 1) {
        const x = (i * step).toFixed(1);
        upper.push(`${x} ${(MID_Y - history[i]).toFixed(2)}`);
        lower.push(`${x} ${(MID_Y + history[i]).toFixed(2)}`);
      }
      lower.reverse();
      applyPath(`M${upper.join(' L')} L${lower.join(' L')} Z`);
      updates += 1;
      setPhase('recording');
      if (statusEl) statusEl.hidden = true;
      if (waveEl) waveEl.hidden = false;
      const bucket = bucketOf(smoothed);
      if (waveEl && bucket !== ariaBucket) {
        // 档位写在波形这张 "img" 上（role=img + aria-valuetext）：50ms 一次的数值会吵到读屏，
        // 所以只有跨档（静音/小声/正常/大声）才更新一次
        ariaBucket = bucket;
        waveEl.setAttribute('aria-valuetext', bucket);
      }
      return true;
    }

    function loop(): void {
      if (!active) {
        rafId = 0;
        return;
      }
      const now = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
      tick(now);
      rafId = window.requestAnimationFrame(loop);
    }

    return {
      begin(opts): number {
        mount();
        this.stop();
        generation += 1;
        token = generation;
        active = true;
        hasPcm = false;
        dirty = false;
        latest = 0;
        smoothed = 0;
        peak = 0;
        updates = 0;
        lastFrame = -Infinity;
        history = new Array(SAMPLES).fill(0);
        ariaBucket = '';
        applyPath(IDLE_PATH);
        setPhase(opts?.phase ?? 'connecting');
        if (el) el.hidden = false;
        if (statusEl) {
          statusEl.textContent = opts?.label ?? '正在连接语音';
          statusEl.hidden = false;
        }
        if (waveEl) waveEl.hidden = true;
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function' && !rafId) {
          rafId = window.requestAnimationFrame(loop);
        }
        return token;
      },

      level(tok, rms, peakIn): void {
        if (!active || tok !== token) return; // 旧会话的帧一律丢弃
        if (!Number.isFinite(rms) || rms < 0 || rms > 1) return;
        hasPcm = true;
        latest = rms;
        dirty = true;
        if (Number.isFinite(peakIn) && (peakIn as number) >= 0 && (peakIn as number) <= 1) {
          peak = Math.max(peak * 0.95, peakIn as number); // 滑动峰值，每帧衰减 5%
        }
      },

      configure(tok, opts): void {
        if (!active || tok !== token) return;
        if (opts?.phase) setPhase(opts.phase);
        if (opts?.label && statusEl) statusEl.textContent = opts.label;
      },

      stop(tok?): void {
        if (tok !== undefined && tok !== token) return;
        active = false;
        generation += 1;
        hasPcm = false;
        dirty = false;
        latest = 0;
        smoothed = 0;
        history = [];
        lastFrame = -Infinity;
        if (rafId && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
          window.cancelAnimationFrame(rafId);
        }
        rafId = 0;
        setPhase('idle');
        // 注意：**不在这里隐藏状态条本体**。状态条的显隐由 renderer 的状态机决定
        // （stop() 之后紧接着要显示"转写中… / 转写失败…"这类文案，这里一隐藏就把它吞了）。
        if (statusEl) statusEl.hidden = false;
        if (waveEl) waveEl.hidden = true;
        applyPath('');
      },

      isActive(): boolean {
        return active;
      },

      state(): VoiceLabState {
        return { token, active, phase, hasPcm, samples: history.length, latest, smoothed, peak, updates };
      },

      __tick(nowMs: number): boolean {
        return tick(Number.isFinite(nowMs) ? nowMs : 0);
      },

      __path(): string {
        return path;
      },

      __mounted(): boolean {
        return !!el;
      },
    };
  }

  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  w.PetVoiceLab = createVoiceLab();
})();
