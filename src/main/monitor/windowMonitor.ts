/**
 * windowMonitor —— 活动窗口轮询 + 主动互动触发器
 *
 * - 依赖 active-win（npm，v8+；Electron 主进程内调用 activeWin()）。
 *   active-win v8 起以 ESM 为主，本文件为兼容 CJS 编译统一走 `await import('active-win')`
 *   （动态 import，Node/Electron 均支持），并在 async 上下文里取 default 导出。
 *   加载失败 / 平台不支持 / 返回 null（无活动窗口）一律容忍，不抛到主流程；
 *   实现可换 —— 需要换 Electron 内置 screen 或平台原生 API 时只需替换 loadActiveWin()/pollOnce()。
 * - 轮询间隔 >= 2000ms（构造参数会被钳制到 2000 下限）。
 * - 每轮结果经 cbs.onInfo(info) 回调 → main.ts 桥接 IPC_ON_WINDOW_CHANGE 推送到 renderer。
 * - 主动互动触发器：每轮对 WindowInfo 判断，命中则 cbs.onAction(action) → main.ts 桥接 IPC_ACTION。
 *   * app 含 chrome/msedge 且 title 含 B站/bilibili/YouTube → {type:'motion', payload:'slacking'}（摸鱼警告）
 *   * app 含 Code/idea64（VS Code / JetBrains IDEA）→ {type:'motion', payload:'coding'}
 *   * isFullscreen（窗口 bounds 覆盖所在屏幕整分辨率）→ {type:'speak', payload:'health'}
 *   动作按"状态切换 + 15s 冷却"去抖，避免每 2s 向 renderer 轰炸同一动作。
 */
import { screen } from 'electron';
import type { WindowInfo } from '../../shared/contracts';

export interface PetAction {
  type: 'speak' | 'motion' | 'expression' | 'scene';
  payload?: unknown;
}

export interface WindowMonitorCallbacks {
  /** 活动窗口快照（null = 无活动窗口 / 获取失败），用于 IPC_ON_WINDOW_CHANGE */
  onInfo?: (info: WindowInfo | null) => void;
  /** 主动互动动作，用于 IPC_ACTION */
  onAction?: (action: PetAction) => void;
}

/** active-win 返回窗口的最小形态（字段按需容错，缺失即视为"无法判定"） */
interface ActiveWindowLike {
  title?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
  owner?: { name?: string; processId?: number } | null;
}

type ActiveWinFn = () => Promise<ActiveWindowLike | null> | ActiveWindowLike | null;

const ACTION_COOLDOWN_MS = 8_000; // 动作去抖冷却（原 15s → 8s，提升互动频率）
const FULLSCREEN_TOLERANCE = 2; // px

export class WindowMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private activeWinFn: ActiveWinFn | null = null;
  private lastActionKey = '';
  private lastActionAt = 0;
  private currentInfo: WindowInfo | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly cbs: WindowMonitorCallbacks,
    opts?: { intervalMs?: number }
  ) {
    // 轮询间隔下限 2000ms（契约要求）
    this.intervalMs = Math.max(opts?.intervalMs ?? 2000, 2000);
  }

  async start(): Promise<void> {
    await this.loadActiveWin(); // 失败不阻塞：monitor 降级为"无活动窗口数据"
    await this.pollOnce();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getCurrentInfo(): WindowInfo | null {
    return this.currentInfo;
  }

  // ------------------------------------------------------------------ private

  /** 动态加载 active-win（ESM-only 兼容 CJS 编译的关键），失败记录并置空 */
  private async loadActiveWin(): Promise<void> {
    try {
      const mod = (await import('active-win')) as {
        default?: ActiveWinFn;
        activeWin?: ActiveWinFn;
      };
      this.activeWinFn = mod.default ?? mod.activeWin ?? null;
      if (!this.activeWinFn) {
        console.warn('[windowMonitor] active-win 未导出可用函数，轮询降级');
      }
    } catch (err) {
      console.warn('[windowMonitor] active-win 加载失败（npm 未安装或平台不支持），轮询降级：', (err as Error).message);
      this.activeWinFn = null;
    }
  }

  /** 单轮轮询：整段 try/catch 容忍 active-win 异常 */
  private async pollOnce(): Promise<void> {
    try {
      const aw = this.activeWinFn ? await this.activeWinFn() : null;
      const info = this.toWindowInfo(aw);
      this.currentInfo = info;
      this.cbs.onInfo?.(info);
      if (info) this.evaluateTriggers(info);
    } catch (err) {
      console.warn('[windowMonitor] 轮询异常（容忍）：', (err as Error).message);
      this.currentInfo = null;
      this.cbs.onInfo?.(null);
    }
  }

  /** 组装 WindowInfo；bounds 缺失或全 0 时视为无效，返回 null */
  private toWindowInfo(aw: ActiveWindowLike | null): WindowInfo | null {
    const b = aw?.bounds;
    if (!aw || !b || !b.width || !b.height) return null;
    const bounds = { x: b.x ?? 0, y: b.y ?? 0, width: b.width, height: b.height };
    return {
      app: aw.owner?.name ?? '',
      title: aw.title ?? '',
      bounds,
      isFullscreen: WindowMonitor.coversFullDisplay(bounds),
    };
  }

  /** isFullscreen：bounds 是否覆盖其所在屏幕（displayMatching 中心点）的整分辨率 */
  private static coversFullDisplay(bounds: { x: number; y: number; width: number; height: number }): boolean {
    try {
      const display = screen.getDisplayMatching(bounds);
      const db = display.bounds;
      const near = (a: number, b2: number): boolean => Math.abs(a - b2) <= FULLSCREEN_TOLERANCE;
      return (
        near(db.x, bounds.x) &&
        near(db.y, bounds.y) &&
        near(db.width, bounds.width) &&
        near(db.height, bounds.height)
      );
    } catch {
      return false; // screen 未就绪等
    }
  }

  /**
   * 场景分类（事件驱动语料触发）：按优先级（会议>视频>网页>代码>文档>游戏全屏）
   * 判定当前窗口属于哪个语料分组；只在“场景切换”时发一次（配合组级冷却），避免反复轰炸。
   */
  private evaluateTriggers(info: WindowInfo): void {
    const appName = info.app.toLowerCase();
    const title = info.title.toLowerCase();
    const has = (...kws: string[]): boolean =>
      kws.some((k) => appName.includes(k) || title.includes(k));

    let group = '';
    // 优先级：会议 > 音乐陪伴(先于社交，避免QQ音乐被当QQ) > 社交聊天 > 视频媒体 > 设计创作 > 终端命令 > 邮件处理 > 网页浏览 > 代码陪伴 > 文档写作 > 游戏全屏
    if (has('zoom', 'teams', '腾讯会议', '飞书', 'classin', 'meeting', '钉钉')) {
      group = '会议场景';
    } else if (has('spotify', '网易云', 'qq音乐', 'qq 音乐', '酷狗', 'foobar', '音乐')) {
      group = '音乐陪伴';
    } else if (has('wechat', 'weixin', '微信', 'qq', 'telegram', 'discord', 'slack')) {
      group = '社交聊天';
    } else if (has('vlc', 'potplayer', '爱奇艺', '腾讯视频', '优酷', '芒果', '哔哩', 'bilibili', 'youtube', '直播', 'obs', 'media player', '视频')) {
      group = '视频媒体';
    } else if (has('figma', 'photoshop', 'illustrator', 'csp', 'clip studio', 'krita', '画世界', '剪映', 'vegas', 'premiere', 'after effects', '达芬奇', 'paint')) {
      group = '设计创作';
    } else if (has('terminal', 'powershell', 'wsl', 'cmd', '命令提示符', 'bash', 'shell')) {
      group = '终端命令';
    } else if (has('outlook', 'thunderbird', '邮件', 'mail')) {
      group = '邮件处理';
    } else if (has('chrome', 'msedge', 'edge', 'firefox', '浏览器')) {
      group = '网页浏览';
    } else if (has('code', 'idea64', 'pycharm', 'webstorm', 'visual studio', 'cursor', 'vscode', 'xcode')) {
      group = '代码陪伴';
    } else if (
      has('word', 'wps', 'obsidian', 'notion', 'typora', 'notepad', '记事本', 'office', '.pdf') ||
      /\.(md|docx?|xlsx?|pptx?|txt|pdf)$/.test(title)
    ) {
      group = '文档写作';
    } else if (info.isFullscreen) {
      group = '游戏全屏';
    }
    if (!group) {
      // 离开已识别场景后清空去重状态；再次回到同一场景时应重新触发。
      this.lastActionKey = '';
      return;
    }

    const key = JSON.stringify({ type: 'scene', payload: group });
    const now = Date.now();
    // 只在场景切换（key 变化）且距上次触发超过冷却时发出
    if (key === this.lastActionKey) return;
    if (now - this.lastActionAt < ACTION_COOLDOWN_MS) return;
    this.lastActionKey = key;
    this.lastActionAt = now;
    this.cbs.onAction?.({ type: 'scene', payload: group });
  }
}
