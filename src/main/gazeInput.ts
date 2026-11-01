/**
 * gazeInput —— 主进程「视线输入」：全局光标轮询
 *
 * 本文件的逻辑从 mainImpl.js 的 startCursorTracking() 原样迁出（行为不变）：
 *   1) 窗口外也轮询全局光标 → sendCursor() → IPC_GLOBAL_CURSOR（渲染层据此换算视线目标）；
 *      光标移动时实时推，鼠标静止时按 CURSOR_HEARTBEAT_MS 心跳补推
 *      （渲染层的视线目标 3s 没更新就回正，只在"移动"时推的话，鼠标停在窗口外不动就
 *      会看一会儿不看了 —— 用户报的"窗口外不追踪"）。
 *   2) 自适应降频：光标距窗口边界 CURSOR_NEAR_DISTANCE（DIP）内走 CURSOR_POLL_MS，
 *      远离窗口时退到 CURSOR_FAR_POLL_MS（DIP 距离，与主进程其它几何口径一致）。
 *   3) 鼠标行为事件：由静止恢复 → onMouseMoved；静止超时 → onMouseIdle（场景文案在调用方）。
 *   4) 点击穿透探测：光标移动时把全局坐标交给调用方换算"相对客户区"坐标。
 *   5) 手机触摸（notifyPhoneTouch）：1500ms 内**只**暂停光标推送，
 *      穿透探测与鼠标状态维护照旧执行。
 *
 * 窗口、IPC 推送、场景触发、穿透判定都属主进程其余部分，全部经 GazeInputOptions 注入，
 * 本文件不 require mainImpl.js（避免循环依赖）。
 */
import { screen } from 'electron';
import type { BrowserWindow } from 'electron';

/** 全局光标轮询周期（窗口附近；视线自动跟随的平滑度） */
const CURSOR_POLL_MS = 80;
/** 鼠标远离窗口时的低频轮询（约 6.7fps；太低会一卡一卡） */
const CURSOR_FAR_POLL_MS = 150;
/** 距窗口边界多少 DIP 内算"靠近" */
const CURSOR_NEAR_DISTANCE = 260;
/** 鼠标静止时的光标心跳间隔：保证窗口外也一直望着鼠标（渲染层 3s 没更新会回正） */
const CURSOR_HEARTBEAT_MS = 400;
/** 静止 90s 视为"鼠标静止"事件 */
const MOUSE_IDLE_MS = 90000;
/** 鼠标类场景 5min 冷却（"鼠标活跃"的冷却判定在调用方，复用同一个值避免两处漂移） */
export const MOUSE_SCENE_GAP_MS = 300000;

/** 光标屏幕坐标（DIP）；与 Electron 的 Point 结构兼容 */
export interface CursorPoint {
  x: number;
  y: number;
}

export interface GazeInputOptions {
  /** 取桌宠主窗口；窗口还没建好或已销毁时返回 null */
  getWindow: () => BrowserWindow | null;
  /** 推送全局光标（主进程实现：IPC_GLOBAL_CURSOR） */
  sendCursor: (x: number, y: number) => void;
  /** 鼠标从静止恢复活跃（主进程实现："鼠标活跃"场景，含自己的场景冷却） */
  onMouseMoved: (now: number) => void;
  /** 光标静止超时（主进程实现："鼠标静止"场景） */
  onMouseIdle: (now: number) => void;
  /** 点击穿透判定（主进程实现：相对客户区换算 + IPC_HIT_PROBE + resetHitIgnore） */
  onClickThroughProbe: (p: CursorPoint, now: number) => void;
}

// ------------------------------------------------------------------ 模块级状态
let cursorTimer: ReturnType<typeof setInterval> | null = null;
let lastCursorSent: CursorPoint | null = null;
let lastCursorPushAt = 0; // 上次推送 IPC_GLOBAL_CURSOR 的时刻（心跳用）
let lastMouseMovedAt = Date.now();
let lastMouseIdleSceneAt = 0;
let mouseIdleFired = false;
let cursorFast = true;
let phoneTouchUntil = 0;

/**
 * 启动全局光标轮询（重复调用无副作用）。
 * 窗口未就绪/已销毁的那一轮直接跳过；screen 暂不可用等异常静默，下轮重试。
 */
export function startGazeInput(opts: GazeInputOptions): void {
  if (cursorTimer !== null) return;
  cursorFast = true;
  const poll = (): void => {
    const win = opts.getWindow();
    if (!win || win.isDestroyed()) return;
    const now = Date.now();
    const phoneTouchBypass = now < phoneTouchUntil; // 手机触摸期间：只暂停光标推送，不跳过穿透/鼠标状态维护
    const p = screen.getCursorScreenPoint();
    try {
      let near = true;
      try {
        const boundsForPoll = win.getBounds();
        const dx = Math.max(boundsForPoll.x - p.x, 0, p.x - (boundsForPoll.x + boundsForPoll.width));
        const dy = Math.max(boundsForPoll.y - p.y, 0, p.y - (boundsForPoll.y + boundsForPoll.height));
        near = Math.hypot(dx, dy) <= CURSOR_NEAR_DISTANCE;
      } catch {
        near = true;
      }
      if (near !== cursorFast) {
        cursorFast = near;
        if (cursorTimer !== null) clearInterval(cursorTimer);
        cursorTimer = setInterval(poll, near ? CURSOR_POLL_MS : CURSOR_FAR_POLL_MS);
      }
      const moved = !lastCursorSent || lastCursorSent.x !== p.x || lastCursorSent.y !== p.y;
      if (moved) {
        lastCursorSent = { x: p.x, y: p.y };
        lastMouseMovedAt = now;
        // 从"静止事件"恢复为活跃 → 触发一次"鼠标活跃"（场景冷却由调用方判定）
        if (mouseIdleFired) {
          mouseIdleFired = false;
          opts.onMouseMoved(now);
        }
      }
      // 光标推送：移动时实时推；鼠标静止时每 CURSOR_HEARTBEAT_MS 也补一次。
      if (!phoneTouchBypass && (moved || now - lastCursorPushAt >= CURSOR_HEARTBEAT_MS)) {
        lastCursorPushAt = now;
        opts.sendCursor(p.x, p.y);
      }
      // 点击穿透：只在光标移动时探测（判定与重置都在调用方）。
      if (moved) {
        opts.onClickThroughProbe(p, now);
      }
      if (!moved && !mouseIdleFired && now - lastMouseMovedAt >= MOUSE_IDLE_MS && now - lastMouseIdleSceneAt >= MOUSE_SCENE_GAP_MS) {
        // 静止超过 90s → "鼠标静止"事件
        mouseIdleFired = true;
        lastMouseIdleSceneAt = now;
        opts.onMouseIdle(now);
      }
    } catch {
      /* screen 暂不可用等场景静默，下轮重试 */
    }
  };
  poll();
  cursorTimer = setInterval(poll, CURSOR_POLL_MS);
}

/** 停止轮询并清掉"已推送光标"记忆（下次启动第一轮必按移动处理） */
export function stopGazeInput(): void {
  if (cursorTimer !== null) {
    clearInterval(cursorTimer);
    cursorTimer = null;
  }
  lastCursorSent = null;
}

/**
 * 手机触摸：1500ms 内暂停光标推送（穿透探测 / 鼠标状态维护照旧）。
 * 传入落点的屏幕坐标时，同时把它记为"已推送过的光标位置" ——
 * 调用方随后会自己推一帧该坐标，这样下一轮轮询不会把这次人工推送当成真实鼠标移动。
 */
export function notifyPhoneTouch(x?: number, y?: number): void {
  phoneTouchUntil = Date.now() + 1500;
  if (typeof x === 'number' && typeof y === 'number') lastCursorSent = { x, y };
}

/** 只读：当前是否处于"手机触摸暂停光标推送"窗口内 */
export function isPhoneTouchSuppressed(): boolean {
  return Date.now() < phoneTouchUntil;
}

/** 只读：鼠标是否已进入"静止"状态（长时间活跃计时等逻辑用它清零） */
export function isMouseIdle(): boolean {
  return mouseIdleFired;
}
