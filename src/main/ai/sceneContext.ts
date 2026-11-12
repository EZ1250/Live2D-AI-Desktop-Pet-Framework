/**
 * sceneContext.ts —— 自主任务的「情景提示词」组装。
 *
 * 数据源：用户维护的 desktop_pet_scenes.yaml（sceneCategories）。
 * 本模块只负责：
 *   1. 解析 YAML 里的 categories/global；
 *   2. 用活动窗口 + 空闲时长匹配场景；
 *   3. 把「当前屏幕 + 场景提示词 + 近期情景记录 + MCP 状态」拼成后台任务提示词。
 *
 * 不在这里再手写一份场景表——没有加载到 YAML 时只使用通用兜底提示词，
 * 避免代码里的提示词和用户 YAML 各维护一份、越走越偏。
 */

export interface SceneScreen {
  /** 活动窗口进程名，例如 Code.exe / chrome.exe */
  app: string;
  /** 活动窗口标题 */
  title: string;
  /** 窗口是否全屏 */
  isFullscreen: boolean;
  /** 无键鼠输入秒数（Electron powerMonitor.getSystemIdleTime） */
  idleSeconds: number;
}

export interface ScenePromptInput {
  mode: 'scene_brief' | 'custom';
  customPrompt: string;
  petName: string;
  screen: SceneScreen;
  todoText: string;
  mcpText: string;
  /** 近期「屏幕/行动/事件」情景记录（scenario.injectText） */
  scenarioText: string;
  now?: number;
}

export interface ScenePromptResult {
  skip: boolean;
  reason: string;
  /** 命中的场景 id / 名称 */
  sceneId: string;
  sceneName: string;
  prompt: string;
}

interface SceneCategory {
  id: string;
  name: string;
  lock: boolean;
  silent: boolean;
  fullscreenIgnore: boolean;
  processes: string[];
  titleKeywords: string[];
  idleThreshold: number | null;
  prompt: string;
}

interface RawSceneSignals {
  processes?: unknown;
  processes_any?: unknown;
  title_keywords_any?: unknown;
  url_patterns_any?: unknown;
  fullscreen?: unknown;
  no_input_seconds?: unknown;
}

interface RawSceneRules {
  speak?: unknown;
}

interface RawSceneCategory {
  id?: unknown;
  name?: unknown;
  lock?: unknown;
  signals?: RawSceneSignals;
  rules?: RawSceneRules;
  prompt?: unknown;
}

interface RawSceneConfig {
  global?: { idle_threshold_default?: unknown; max_prompt_length?: unknown };
  categories?: RawSceneCategory[];
}

/** 已加载的 YAML 场景；为空表示还没加载/加载失败。 */
let sceneCategories: SceneCategory[] = [];
let loadedFileName = '';

function strList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((v) => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
    .filter(Boolean);
}

function numberOrNull(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function toCategory(raw: RawSceneCategory, globalIdle: number | null): SceneCategory | null {
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) return null;
  const signals = raw.signals ?? {};
  const rules = raw.rules ?? {};
  const processes = [...strList(signals.processes), ...strList(signals.processes_any)];
  const titleKeywords = [...strList(signals.title_keywords_any), ...strList(signals.url_patterns_any)];
  const idleThreshold =
    numberOrNull(signals.no_input_seconds) ?? (id === 'idle' ? globalIdle : null);
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    lock: raw.lock === true,
    silent: raw.lock === true || rules.speak === 'never',
    fullscreenIgnore: signals.fullscreen === 'ignore_prompt',
    processes,
    titleKeywords,
    idleThreshold,
    prompt: typeof raw.prompt === 'string' ? raw.prompt.trim() : '',
  };
}

/**
 * 载入一份 desktop_pet_scenes.yaml。
 * 返回加载的类别数量；空/格式不对时保留上一次配置不变。
 */
export function loadSceneConfig(text: string, fileName = 'desktop_pet_scenes.yaml'): { ok: boolean; count: number; error?: string } {
  try {
    // js-yaml 是运行时依赖（package.json dependencies），打包后会带进 asar
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const yaml = require('js-yaml') as { load: (s: string) => unknown };
    const raw = yaml.load(text) as RawSceneConfig | null;
    const list = Array.isArray(raw?.categories) ? raw.categories : [];
    const globalIdle = numberOrNull(raw?.global?.idle_threshold_default);
    const parsed = list.map((c) => toCategory(c, globalIdle)).filter((c): c is SceneCategory => c !== null);
    if (!parsed.length) return { ok: false, count: 0, error: 'YAML 里没有可用的 categories' };
    sceneCategories = parsed;
    loadedFileName = fileName;
    return { ok: true, count: parsed.length };
  } catch (err) {
    return { ok: false, count: 0, error: (err as Error).message };
  }
}

export function sceneConfigStatus(): { loaded: boolean; count: number; file: string } {
  return { loaded: sceneCategories.length > 0, count: sceneCategories.length, file: loadedFileName };
}

/** 小写、去掉 .exe，避免 Chrome.exe / chrome 这种差异 */
export function normalizeApp(app: string): string {
  return (app || '').toLowerCase().replace(/\.exe$/i, '').trim();
}

function normalizeTitle(title: string): string {
  return (title || '').toLowerCase().trim();
}

/** 标题关键字支持 YAML 里少量通配符（如 "*.* - " / "BV.*"），普通字符串按包含匹配。 */
function titleMatches(keyword: string, title: string): boolean {
  const key = keyword.trim().toLowerCase();
  if (!key) return false;
  if (!key.includes('*')) return title.includes(key);
  const escaped = key.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  try {
    return new RegExp(escaped).test(title);
  } catch {
    return title.includes(key.replace(/\*/g, ''));
  }
}

function matchesCategory(cat: SceneCategory, app: string, title: string): boolean {
  if (cat.id === 'idle') return false;
  const processHit = cat.processes.some((p) => app.includes(p));
  const textHit = cat.titleKeywords.some((k) => titleMatches(k, title));
  if (cat.id === 'meeting') {
    // 微信/QQ 只有标题出现“通话中/会议中”等才算会议；避免把普通聊天当会议锁住。
    const chatLike = /wechat|weixin|qq|telegram|slack|discord/.test(app);
    return textHit || (processHit && !chatLike);
  }
  return processHit || textHit;
}

/** 当前屏幕 → 场景；按 YAML categories 顺序取第一个命中。 */
export function classifyScene(screen: SceneScreen): SceneCategory | null {
  const app = normalizeApp(screen.app);
  const title = normalizeTitle(screen.title);
  for (const cat of sceneCategories) {
    if (cat.id !== 'idle' && matchesCategory(cat, app, title)) return cat;
  }
  const idle = sceneCategories.find((c) => c.id === 'idle');
  if (idle && idle.idleThreshold != null && screen.idleSeconds >= idle.idleThreshold) return idle;
  return null;
}

/** 当前是否深夜收敛时段（23:00–07:00） */
export function isQuietHours(now: number): boolean {
  const hour = new Date(now).getHours();
  return hour >= 23 || hour < 7;
}

function safeText(text: string, maxLen: number): string {
  const clean = (text || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > maxLen ? `${clean.slice(0, maxLen)}…` : clean;
}

/** 填模板变量；未知变量替换成可读的兜底词，避免把 {xxx} 原样喂给模型。 */
function renderPrompt(template: string, screen: SceneScreen, sceneName: string): string {
  const idleMin = Math.max(0, Math.floor((screen.idleSeconds || 0) / 60));
  const vars: Record<string, string> = {
    detected_app: safeText(screen.app || '当前应用', 40) || '当前应用',
    detected_activity: sceneName,
    window_title: safeText(screen.title || '无标题', 80) || '无标题',
    active_duration: idleMin > 0 ? String(idleMin) : '一段',
    idle_duration: idleMin > 0 ? String(idleMin) : '几',
    page_type: sceneName,
    long_session: '50',
    long_browse: '45',
    long_play: '60',
    dwell_seconds: '180',
    away_seconds: '300',
    hang_seconds: '30',
    meeting_duration: '一段',
  };
  return template.replace(/\{([a-z_]+)\}/gi, (_m, key: string) => vars[key.toLowerCase()] ?? '相关');
}

function quietTone(now: number): string {
  return isQuietHours(now)
    ? '现在是深夜，语气克制、简短，不要主动开启新话题。'
    : '语气自然，像桌面伙伴，不说教。';
}

/**
 * 组装一次自主任务的提示词。
 *
 * MCP 状态不是单独一条“外设信息”，而是写进情景提示词本身：
 * 模型能同时看到「当前屏幕 + 场景提示 + 近期记录 + MCP 状态」。
 */
export function buildSceneAutoTaskPrompt(input: ScenePromptInput): ScenePromptResult {
  const now = input.now ?? Date.now();
  const scene = classifyScene(input.screen);
  const sceneId = scene?.id ?? 'general';
  const sceneName = scene?.name ?? '通用桌面';
  const custom = input.mode === 'custom' ? safeText(input.customPrompt || '', 200) : '';

  if (input.mode === 'scene_brief' && scene?.silent) {
    return {
      skip: true,
      reason: scene.id === 'meeting' ? '当前在会议中，不主动发言' : '当前场景不适合主动发言',
      sceneId,
      sceneName,
      prompt: '',
    };
  }
  if (input.mode === 'scene_brief' && scene?.fullscreenIgnore && input.screen.isFullscreen) {
    return { skip: true, reason: '全屏场景中，不弹提示', sceneId, sceneName, prompt: '' };
  }

  const timeText = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const screenText =
    `应用：${safeText(input.screen.app || '未知', 60) || '未知'}；` +
    `窗口标题：${safeText(input.screen.title || '无标题', 140) || '无标题'}；` +
    `全屏：${input.screen.isFullscreen ? '是' : '否'}；` +
    `空闲：${Math.max(0, Math.floor((input.screen.idleSeconds || 0) / 60))} 分钟`;

  const sceneTask = custom
    ? custom
    : scene && scene.prompt
      ? renderPrompt(scene.prompt, input.screen, sceneName)
      : '根据当前屏幕和近期情景，判断是否有值得主动说的一句话；没有就输出“无需提醒”。不要为了刷存在感提醒喝水/休息。';

  const mcpText = safeText(input.mcpText || '未配置', 240) || '未配置';
  const scenarioText = safeText(input.scenarioText || '', 900);
  const todoText = safeText(input.todoText || '无', 200) || '无';

  const lines = [
    `现在是 ${timeText}。这是一次后台自主任务，不是在回复用户；不要提问、不要寒暄。`,
    `【当前屏幕】${screenText}`,
    `【情景提示词】${sceneName}${custom ? '（自定义任务）' : ''}`,
    sceneTask,
    `【本地 MCP】${mcpText}`,
    `【待办】${todoText}`,
  ];
  if (scenarioText) lines.push(`【近期情景记录】${scenarioText}`);
  lines.push(
    `要求：只输出一句中文（不超过 60 字），不要解释、不要加引号；${input.petName || '桌宠'}会直接把它当气泡说给用户听。`,
    quietTone(now),
  );

  return {
    skip: false,
    reason: 'ok',
    sceneId,
    sceneName,
    prompt: lines.join('\n'),
  };
}
