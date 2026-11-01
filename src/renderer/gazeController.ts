/**
 * gazeController.ts —— 渲染层视线控制器（全局脚本，暴露 window.PetGaze）
 *
 * 为什么放渲染层全局脚本：本工程没有打包器，渲染层不能 import 模块；
 * index.html 在 renderer.js 之前用 <script> 加载本文件，renderer 通过 window.PetGaze 调用。
 *
 * 定位：原 renderer.ts「7.5 视线跟踪」一节的状态与换算逻辑整体搬到这里（逐行原样，语义不变），
 * renderer 只保留事件接线（pointermove / mouseleave / 全局光标推送 / 主循环 tick）。
 * 对当前渲染 handle 与取景（全身/半身）的依赖通过 renderer 初始化时注入的 getter 读取——
 * 本文件不直接碰 renderer.ts 的局部变量。
 *
 * 平滑插值仍在各 handle 的 update() 内做，这里不改主循环节奏。
 *
 * 调试：window.__petDebug.gazeMode() / gaze() 的渲染层数值即来自这里的 debug() / state()。
 */
(() => {
  'use strict';

  type Any = any;

  /** 视线只依赖 handle 的这几项能力（结构类型，等价于 renderer.ts 的 RenderHandle 子集） */
  interface GazeHandle {
    /** 视线目标 nx/ny ∈[-1,1]，向右/向上为正；0 = 归位 */
    setGaze(nx: number, ny: number): void;
    /** SDK 内置 FocusController 指针喂入（画布局部坐标，可窗口外） */
    focusAt?(clientX: number, clientY: number): boolean;
    /** SDK 视线回正 */
    resetFocus?(): boolean;
    gazeOriginRatio?(): number | null;
  }

  /** 渲染层视线换算快照（__petDebug.gaze() 的 renderer 段，字段与拆分前完全一致） */
  interface GazeState {
    nx: number;
    ny: number;
    stale: boolean;
    sinceMoveMs: number | null;
    globalCursorPushes: number;
    sinceGlobalMs: number | null;
  }

  /* ---------------- 状态（原 renderer.ts 7.5 节，逐行迁移） ---------------- */
  const GAZE_IDLE_MS = 3000;
  let gazeNX = 0;          // 归一化鼠标偏移 [-1,1]，向右为正
  let gazeNY = 0;          // 向上为正
  let lastGazeMoveAt = 0;  // 0 = 尚未移动/已离开窗口
  let globalCursorPushes = 0; // 主进程推来的全局光标更新次数（自查"窗口外是否还在跟"用）
  let sdkFocusActive = false; // 当前是否由 Live2D/Pixi SDK 内置 FocusController 驱动视线（默认主路径）
  let sdkTargetX = 0;   // 最近一次输入换算出的画布目标点
  let sdkTargetY = 0;
  let sdkFeedX = NaN;   // 逐帧插值后喂给 SDK 的实际坐标（消除低频输入的一卡一卡）
  let sdkFeedY = NaN;
  let sdkIdleReset = false; // 静止 3s 后只回正一次，避免反复覆盖 SDK 中性位
  let lastDriveAt = 0;
  /** 迟滞：连续成功/失败达阈值才切换驱动模式，避免 SDK 与项目管线逐帧交替写参数 */
  let sdkOkStreak = 0;
  let sdkFailStreak = 0;
  let lastGazeHandle: GazeHandle | null = null;
  /** SDK focus 调用失败次数（静默兜底时至少可自查，不刷 console） */
  let sdkFocusFailures = 0;
  let lastGlobalCursorAt = 0; // 最近一次全局光标推送时刻（performance.now 基准）

  /* ---------------- 外部依赖（由 renderer 初始化时注入） ---------------- */
  /** 当前取景：全身 / 半身（注入前按全身处理，与 renderer 的初始值一致） */
  let getFraming: () => 'full' | 'half' = () => 'full';
  /** 当前渲染 handle（未挂载/未注入时为 null） */
  let getHandle: () => GazeHandle | null = () => null;

  /**
   * 优先喂给 SDK 内置 FocusController（默认主路径）。
   * 成功返回 true；SDK 不可用/抛错时返回 false，调用方回退到项目自建 setGaze 管线。
   */
  function trySdkFocus(clientX: number, clientY: number): boolean {
    const h = getHandle();
    if (!h || typeof h.focusAt !== 'function') {
      sdkFocusFailures += 1;
      sdkFailStreak += 1;
      if (sdkFailStreak >= 3) sdkFocusActive = false;
      return false;
    }
    try {
      const ok = h.focusAt(clientX, clientY);
      if (ok) {
        sdkOkStreak += 1;
        sdkFailStreak = 0;
        if (sdkOkStreak >= 3) sdkFocusActive = true;
        return true;
      }
    } catch {
      /* 按失败计，走迟滞 */
    }
    sdkOkStreak = 0;
    sdkFailStreak += 1;
    sdkFocusFailures += 1;
    if (sdkFailStreak >= 3) sdkFocusActive = false;
    return false;
  }

  /** 半身视线原点：优先用模型预设的 gazeOriginRatio，缺省脖颈 38%；全身=窗口中心 */
  function gazeOriginY(vh: number): number {
    if (getFraming() !== 'half') return vh / 2;
    const h = getHandle();
    const r = h && typeof h.gazeOriginRatio === 'function' ? h.gazeOriginRatio() : null;
    return vh * (Number.isFinite(Number(r)) && Number(r) > 0 && Number(r) < 1 ? Number(r) : 0.38);
  }

  /** 窗口内指针（pointermove）→ 归一化视线目标，并直接喂给 SDK focus */
  function setPointer(clientX: number, clientY: number): void {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    // Half framing: gaze origin at the neck (head lives in the upper part of the window).
    const cx = vw / 2;
    const cy = gazeOriginY(vh);
    gazeNX = Math.max(-1, Math.min(1, (clientX - cx) / (vw / 2)));
    gazeNY = Math.max(-1, Math.min(1, (cy - clientY) / (vh / 2))); // screen down -> negative (look down)
    lastGazeMoveAt = performance.now();
    sdkTargetX = clientX;
    sdkTargetY = clientY;
    sdkIdleReset = false;
    trySdkFocus(clientX, clientY); // SDK 主路径（窗口内跟手，SDK 自己的 autoInteract 也在跑）
  }

  /** 全局鼠标（主进程轮询推送，屏幕 DIP 坐标）→ 归一化视线目标。 */
  function setGlobal(screenX: number, screenY: number): void {
    globalCursorPushes += 1; // 主进程推来的全局光标更新次数（自查用，只有本入口会推）
    lastGlobalCursorAt = performance.now();
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const oy = gazeOriginY(h); // neck origin in half framing (per-model configurable)
    const cx = window.screenX + w / 2;
    const cy = window.screenY + oy;
    // 分母含 220px 软区：鼠标在窗口附近时视线按比例细腻跟动，远离则平滑趋于极限
    // 窗口外光标相对坐标可能到 -2/3，不能 clamp 到 [-1,1]（否则视线卡在边缘）；tanh 平滑饱和
    const scaleX = w / 2 + 220;
    const scaleY = h / 2 + 220;
    gazeNX = Math.tanh((screenX - cx) / scaleX);
    gazeNY = Math.tanh(-(screenY - cy) / scaleY); // 向上为正
    lastGazeMoveAt = performance.now();
    // 喂给 SDK：画布局部坐标（可超出画布），方向交给 SDK 内部换算 → 窗口外也能生效
    sdkTargetX = w / 2 + gazeNX * (w / 2);
    sdkTargetY = gazeOriginY(h) - gazeNY * (h / 2);
    sdkIdleReset = false;
    // 不在这里直接 focus：交给 tick 每帧插值，避免低频输入一卡一卡
    if (!sdkFocusActive) trySdkFocus(sdkTargetX, sdkTargetY);
  }

  /** 暂停跟随：鼠标离开窗口 / 拖拽窗口期间（主循环下一帧起走"缓缓归零"分支） */
  function pause(): void {
    lastGazeMoveAt = 0;
  }

  /** 主循环每帧调用：鼠标静止/离开超过 GAZE_IDLE_MS 则目标归零 */
  function tick(nowMs: number): void {
    const h = getHandle();
    if (!h || typeof h.setGaze !== 'function') return;
    if (h !== lastGazeHandle) {
      // 换模型：清掉旧模型的 SDK 插值状态，避免第一帧跳变
      lastGazeHandle = h;
      sdkFeedX = NaN;
      sdkIdleReset = false;
      sdkOkStreak = 0;
      sdkFailStreak = 0;
    }
    const stale = !lastGazeMoveAt || nowMs - lastGazeMoveAt > GAZE_IDLE_MS;
    if (sdkFocusActive) {
      if (stale) {
        if (!sdkIdleReset) {
          sdkIdleReset = true;
          sdkFeedX = NaN; // 下次移动重新起步
          if (typeof h.resetFocus === 'function') h.resetFocus();
          h.setGaze(0, 0); // 静止回正也要走项目管线，避免 SDK 头部参数被 Idle 卡住
        }
        return;
      }
      // 逐帧插值：即使输入只有 6.7fps，喂给 SDK 的坐标也是连续的（不卡顿）
      if (!Number.isFinite(sdkFeedX)) { sdkFeedX = sdkTargetX; sdkFeedY = sdkTargetY; }
      const dtMs = lastDriveAt ? Math.min(120, Math.max(1, nowMs - lastDriveAt)) : 16;
      lastDriveAt = nowMs;
      const ease = 1 - Math.exp(-(dtMs / 1000) * 20);
      sdkFeedX += (sdkTargetX - sdkFeedX) * ease;
      sdkFeedY += (sdkTargetY - sdkFeedY) * ease;
      const ok = trySdkFocus(sdkFeedX, sdkFeedY);
      if (ok) {
        // SDK 的 FocusController 在 model.update 内部写参数，但模型 Idle 动作会在其后覆盖
        // AngleX/Y（眼球参数不被 Idle 覆盖）→ 表现为"只有眼睛动、头不动"。
        // 这里在 update 之后再补写一次（头部+眼球），让头和眼睛一起跟。
        h.setGaze(gazeNX, gazeNY);
        return;
      }
      if (sdkFocusActive) return; // 未达失败阈值：继续等 SDK，避免双写者逐帧抖动
      // 达到阈值 → 掉到下面的代码管线兜底
    }
    h.setGaze(stale ? 0 : gazeNX, stale ? 0 : gazeNY);
  }

  /** 渲染层换算结果快照（__petDebug.gaze() 的 renderer 段；窗口几何由 renderer 自己补） */
  function state(): GazeState {
    return {
      nx: Math.round(gazeNX * 1000) / 1000,
      ny: Math.round(gazeNY * 1000) / 1000,
      stale: !lastGazeMoveAt || performance.now() - lastGazeMoveAt > GAZE_IDLE_MS,
      sinceMoveMs: lastGazeMoveAt ? Math.round(performance.now() - lastGazeMoveAt) : null,
      globalCursorPushes,
      sinceGlobalMs: lastGlobalCursorAt ? Math.round(performance.now() - lastGlobalCursorAt) : null,
    };
  }

  /** 视线驱动模式自查：sdkFocusActive=true 表示当前由 SDK focus 驱动，false=项目代码管线兜底 */
  function debug(): { sdkFocusActive: boolean; globalCursorPushes: number; sdkFocusFailures: number } {
    return { sdkFocusActive, globalCursorPushes, sdkFocusFailures };
  }

  function createGazeController(): Any {
    return {
      setPointer,
      setGlobal,
      tick,
      pause,
      state,
      debug,
      /** renderer 初始化时注入：当前取景（全身/半身）的 getter */
      setFramingGetter(fn: () => 'full' | 'half'): void {
        if (typeof fn === 'function') getFraming = fn;
      },
      /** renderer 初始化时注入：当前渲染 handle 的 getter（换模型无需重新注入） */
      setHandleGetter(fn: () => GazeHandle | null): void {
        if (typeof fn === 'function') getHandle = fn;
      },
    };
  }

  const w = (typeof window !== 'undefined' ? window : globalThis) as unknown as Record<string, unknown>;
  w.PetGaze = createGazeController();
})();
