/**
 * ttsMouth.ts —— TTS 播放期间的「本地桌宠口型」驱动（全局脚本，暴露 window.PetTtsMouth）
 *
 * 为什么单独一个文件：本工程没有打包器，渲染层不能 import 模块；而"按音频播放时长
 * 打拍子驱动嘴部、停止时归零"这段逻辑必须能用**桩 handle + 假定时器**单测。
 * 于是和 gazeController.ts 一样做成全局脚本（index.html 在 renderer.js 之前加载），
 * renderer.ts 只在 playTtsAudio 的播放链路里 start()/stop()。
 *
 * 与 VTS 的关系：
 *   - 这里只写**本地** Live2D handle（applySpeech / 追踪层 MouthOpen）；
 *   - 主进程那条「说话时给 VTS 注入 MouthOpen」（ipc.ts 的 onVtsMouth）保持不变、互不干扰；
 *   - 本模块不发任何 IPC，所以绝不会回环到 VTS。
 *
 * 驱动优先级（不重复造接口）：
 *   1) handle.applySpeech({ openY }, ttlMs)  —— live2d.ts 的语音口型层（moc3 有嘴部参数时才生效）；
 *   2) handle.applyTrackingFrame({ mouth: { openY } }) —— 立绘/占位等没有语音层的 handle；
 *   3) 两者都没有 → 什么都不做（模型本来就没有嘴）。
 */
(() => {
  'use strict';

  /** 驱动口型只依赖 handle 的这两项能力（结构类型，等价于 renderer.ts 的 RenderHandle 子集） */
  interface MouthHandle {
    applySpeech?(mouth: { openY?: number; form?: number }, ttlMs?: number): void;
    applyTrackingFrame?(frame: { source?: string; mouth?: { openY?: number; form?: number } }): void;
  }

  interface TtsMouthDriverOptions {
    /** 当前渲染 handle（换模型无需重新创建 driver） */
    getHandle: () => MouthHandle | null;
    /** 注入随机源（测试用）；默认 Math.random */
    random?: () => number;
    /** 注入定时器（测试用假时钟）；默认 window.setTimeout */
    setTimer?: (fn: () => void, ms: number) => number;
    /** 注入清定时器；默认 window.clearTimeout */
    clearTimer?: (id: number) => void;
  }

  interface TtsMouthState {
    active: boolean;
    /** 已发的口型拍数（自查：TTS 在播却没涨 = 没驱动到） */
    ticks: number;
    /** 最近一拍的 openY（0..1） */
    lastOpenY: number;
    timerRunning: boolean;
  }

  interface TtsMouthDriver {
    start(): void;
    /** @returns 之前是否在播（false = 本来就没动，调用方不用重复归零） */
    stop(): boolean;
    state(): TtsMouthState;
  }

  /** 节拍间隔：90~120ms 轻微随机，避免听起来像机械打点 */
  const TICK_MIN_MS = 90;
  const TICK_MAX_MS = 120;
  /** 每拍 TTL 约 150ms：比间隔稍长，嘴部参数不会在两拍之间掉回 0（看着不抽） */
  const TTL_MS = 150;
  /** 张口量范围（不张满也不几乎不动） */
  const OPEN_MIN = 0.15;
  const OPEN_MAX = 0.75;

  function clamp01(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
  }

  /**
   * 把一帧张口量写到当前 handle。
   * @returns 是否真的驱动到了（没有 handle / 没有嘴部能力 → false）
   */
  function driveMouth(handle: MouthHandle | null, openY: number, ttlMs = TTL_MS): boolean {
    if (!handle) return false;
    const value = clamp01(openY);
    if (typeof handle.applySpeech === 'function') {
      handle.applySpeech({ openY: value }, ttlMs);
      return true;
    }
    if (typeof handle.applyTrackingFrame === 'function') {
      // 没有语音层的 handle（立绘/占位）：退回追踪层的嘴部参数
      handle.applyTrackingFrame({ source: 'external', mouth: { openY: value } });
      return true;
    }
    return false;
  }

  function createTtsMouthDriver(options: TtsMouthDriverOptions): TtsMouthDriver {
    if (!options || typeof options.getHandle !== 'function') {
      throw new TypeError('createTtsMouthDriver 需要 getHandle 函数');
    }
    const getHandle = options.getHandle;
    const random = typeof options.random === 'function' ? options.random : Math.random;
    const setTimer = typeof options.setTimer === 'function'
      ? options.setTimer
      : (fn: () => void, ms: number): number => window.setTimeout(fn, ms) as unknown as number;
    const clearTimer = typeof options.clearTimer === 'function'
      ? options.clearTimer
      : (id: number): void => window.clearTimeout(id);

    let active = false;
    let timer: number | null = null;
    let ticks = 0;
    let lastOpenY = 0;

    function nextDelay(): number {
      const span = TICK_MAX_MS - TICK_MIN_MS;
      return TICK_MIN_MS + Math.round(Math.max(0, Math.min(1, random())) * span);
    }

    function tick(): void {
      timer = null;
      if (!active) return;
      // 每拍一个轻微随机的张口量（0.15~0.75），TTL 约 150ms
      lastOpenY = OPEN_MIN + Math.max(0, Math.min(1, random())) * (OPEN_MAX - OPEN_MIN);
      driveMouth(getHandle(), lastOpenY, TTL_MS);
      ticks += 1;
      timer = setTimer(tick, nextDelay());
    }

    /** 开始（重复调用幂等：已经在跑就复用同一循环，不叠加定时器） */
    function start(): void {
      if (active) return;
      active = true;
      ticks = 0;
      tick(); // 先动一拍，避免第一拍要等 90ms 才张嘴
    }

    /** 停止并归零（嘴闭上）；本来就没在播时不做任何写入，避免覆盖别的口型来源 */
    function stop(): boolean {
      const wasActive = active;
      active = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (wasActive) {
        lastOpenY = 0;
        driveMouth(getHandle(), 0, TTL_MS);
      }
      return wasActive;
    }

    function state(): TtsMouthState {
      return { active, ticks, lastOpenY: Math.round(lastOpenY * 1000) / 1000, timerRunning: timer !== null };
    }

    return { start, stop, state };
  }

  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  w.PetTtsMouth = {
    createDriver: createTtsMouthDriver,
    driveMouth,
    TICK_MIN_MS,
    TICK_MAX_MS,
    TTL_MS,
    OPEN_MIN,
    OPEN_MAX,
  };
})();
