/** 后台自主任务的规则校验和提示词组装。 */
export type AutoTaskMode = 'mcp_check' | 'scene_brief' | 'custom';
export type AutoTaskTrigger = 'schedule' | 'manual' | 'event';

export interface AutoTaskSettings {
  enabled: boolean;
  mode: AutoTaskMode;
  prompt: string;
  intervalMin: number;
  dailyLimit: number;
  /** 事件触发开关与匹配条件。 */
  eventEnabled: boolean;
  eventMatch: string;
  eventCooldownMin: number;
}

export interface AutoTaskState {
  dayKey: string;
  countToday: number;
  lastRunAt: number;
  /** 上次事件触发时间。 */
  lastEventAt: number;
}

export interface AutoTaskGate {
  busy: boolean;
  pendingAsk: boolean;
  running: boolean;
  /** 触发来源。 */
  trigger?: AutoTaskTrigger;
  manual?: boolean;
  /** 调用方已确认事件命中。 */
  eventMatched?: boolean;
}

export const AUTO_TASK_MIN_INTERVAL_MIN = 5;
export const AUTO_TASK_MAX_INTERVAL_MIN = 240;
export const AUTO_TASK_DEFAULT_INTERVAL_MIN = 30;
export const AUTO_TASK_DEFAULT_DAILY_LIMIT = 20;
export const AUTO_TASK_DEFAULT_EVENT_COOLDOWN_MIN = 15;
export const AUTO_TASK_MIN_EVENT_COOLDOWN_MIN = 5;
export const AUTO_TASK_MAX_EVENT_COOLDOWN_MIN = 120;

export function dayKeyOf(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function clampInt(value: number, min: number, max: number, dflt: number): number {
  if (!Number.isFinite(value)) return dflt;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeAutoTaskSettings(raw: {
  enabled?: unknown;
  mode?: unknown;
  prompt?: unknown;
  intervalMin?: unknown;
  dailyLimit?: unknown;
  eventEnabled?: unknown;
  eventMatch?: unknown;
  eventCooldownMin?: unknown;
}): AutoTaskSettings {
  const mode: AutoTaskMode = raw.mode === 'scene_brief' || raw.mode === 'custom' ? raw.mode : 'mcp_check';
  return {
    enabled: raw.enabled === true,
    mode,
    prompt: typeof raw.prompt === 'string' ? raw.prompt.trim().slice(0, 200) : '',
    intervalMin: clampInt(
      typeof raw.intervalMin === 'number' ? raw.intervalMin : NaN,
      AUTO_TASK_MIN_INTERVAL_MIN,
      AUTO_TASK_MAX_INTERVAL_MIN,
      AUTO_TASK_DEFAULT_INTERVAL_MIN,
    ),
    dailyLimit: clampInt(
      typeof raw.dailyLimit === 'number' ? raw.dailyLimit : NaN,
      1,
      200,
      AUTO_TASK_DEFAULT_DAILY_LIMIT,
    ),
    eventEnabled: raw.eventEnabled === true,
    eventMatch: typeof raw.eventMatch === 'string' ? raw.eventMatch.trim().slice(0, 80) : '',
    eventCooldownMin: clampInt(
      typeof raw.eventCooldownMin === 'number' ? raw.eventCooldownMin : NaN,
      AUTO_TASK_MIN_EVENT_COOLDOWN_MIN,
      AUTO_TASK_MAX_EVENT_COOLDOWN_MIN,
      AUTO_TASK_DEFAULT_EVENT_COOLDOWN_MIN,
    ),
  };
}

/** 跨天清零并返回新状态。 */
export function normalizeAutoTaskState(now: number, state: AutoTaskState | null): AutoTaskState {
  const dayKey = dayKeyOf(now);
  if (!state || state.dayKey !== dayKey)
    return { dayKey, countToday: 0, lastRunAt: state?.lastRunAt ?? 0, lastEventAt: state?.lastEventAt ?? 0 };
  return state;
}

/** 检查活动窗口是否命中事件匹配串。 */
export function matchesAutoTaskEvent(settings: AutoTaskSettings, app: string, title: string): boolean {
  const needle = settings.eventMatch.trim().toLowerCase();
  if (!needle) return false;
  return `${app} ${title}`.toLowerCase().includes(needle);
}

/** 判断任务是否可以运行，并返回原因。 */
export function shouldRunAutoTask(
  now: number,
  settings: AutoTaskSettings,
  state: AutoTaskState,
  gate: AutoTaskGate,
): { run: boolean; reason: string; state: AutoTaskState } {
  const next = normalizeAutoTaskState(now, state);
  const trigger = gate.trigger ?? (gate.manual ? 'manual' : 'schedule');
  const manual = trigger === 'manual';
  if (gate.running) return { run: false, reason: '上一次还没跑完', state: next };
  if (gate.busy) return { run: false, reason: 'AI 正在回复', state: next };
  if (gate.pendingAsk) return { run: false, reason: '有等待回答的确认框', state: next };
  if (trigger === 'event') {
    if (!settings.enabled) return { run: false, reason: '自主任务未开启', state: next };
    if (!settings.eventEnabled) return { run: false, reason: '事件触发未开启', state: next };
    if (!gate.eventMatched && !settings.eventMatch) return { run: false, reason: '事件匹配串为空', state: next };
    if (next.countToday >= settings.dailyLimit) return { run: false, reason: `已达每日上限 ${settings.dailyLimit} 次`, state: next };
    if (next.lastEventAt > 0 && now - next.lastEventAt < settings.eventCooldownMin * 60_000) {
      return { run: false, reason: `事件冷却中（${settings.eventCooldownMin} 分钟）`, state: next };
    }
    return { run: true, reason: 'ok', state: next };
  }
  if (!settings.enabled && !manual) return { run: false, reason: '自主任务未开启', state: next };
  if (!manual) {
    if (next.countToday >= settings.dailyLimit) return { run: false, reason: `已达每日上限 ${settings.dailyLimit} 次`, state: next };
    if (next.lastRunAt > 0 && now - next.lastRunAt < settings.intervalMin * 60_000) {
      return { run: false, reason: `距上次不足 ${settings.intervalMin} 分钟`, state: next };
    }
  }
  if (settings.mode === 'custom' && !settings.prompt) return { run: false, reason: '自定义模式还没写提示词', state: next };
  return { run: true, reason: 'ok', state: next };
}

/** 汇总本地 MCP 状态。 */
export function buildMcpCheckSummary(clientText: string, serverText: string): { ok: boolean; text: string } {
  const clientIssues = /连接失败|错误：|超时|spawn 失败|子进程退出/.test(clientText);
  const serverIssues = /监听失败|端口都被占用/.test(serverText);
  const ok = !clientIssues && !serverIssues;
  const lines: string[] = [];
  const firstLine = clientText.split('\n').filter(Boolean)[0];
  if (firstLine) lines.push(firstLine);
  const serverLine = serverText.split('\n').filter(Boolean)[0];
  if (serverLine) lines.push(serverLine);
  return { ok, text: lines.join('\n') || 'MCP 未配置' };
}
