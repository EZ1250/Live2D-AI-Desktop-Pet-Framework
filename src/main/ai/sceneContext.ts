/**
 * sceneContext.ts —— 自主任务的「情景提示词」组装。
 *
 * 目标：后台任务不再只拿一行窗口标题问 AI，而是：
 *   1. 按桌面场景（会议/创作/聊天/学习/浏览/娱乐/事务/空闲）选提示词；
 *   2. 带上当前屏幕内容（应用、窗口标题、全屏、空闲时长）；
 *   3. 把近期情景记录和本地 MCP 状态一起写进情景提示词。
 *
 * 场景与提示词参考用户提供的 desktop_pet_scenes.yaml，做了收敛：
 * 只保留可稳定从活动窗口 + 系统空闲时间判断的分类；CPU/未响应/锁屏等
 * 需要平台级探针的分类先不启用，避免误报。
 */
import { sanitizeScenarioText } from './scenario';

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
  /** 会议锁：命中即不发言 */
  lock?: boolean;
  /** 当前窗口命中规则 */
  match: (app: string, title: string) => boolean;
  /** 命中后是否禁止主动发言 */
  silent?: boolean;
  /** 全屏时忽略提示（YAML 的 fullscreen: ignore_prompt） */
  fullscreenIgnore?: boolean;
  /** 场景提示词（{var} 会被替换） */
  prompt: string;
}

const PROCESS = (...names: string[]) => (app: string): boolean =>
  names.some((n) => app.includes(n));

const TITLE = (...keywords: string[]) => (_app: string, title: string): boolean =>
  keywords.some((k) => title.includes(k));

const ANY = (...rules: Array<(app: string, title: string) => boolean>) =>
  (app: string, title: string): boolean => rules.some((r) => r(app, title));

const CATEGORIES: SceneCategory[] = [
  {
    id: 'meeting',
    name: '会议沟通',
    lock: true,
    silent: true,
    match: ANY(
      PROCESS('zoom', 'teams', 'tencent meeting', 'tencentmeeting', 'feishu', 'lark'),
      TITLE('通话中', '会议中', '共享中', '屏幕共享', '直播中'),
    ),
    prompt: '用户正在会议中，不要主动发言。',
  },
  {
    id: 'production',
    name: '生产创作',
    match: ANY(
      PROCESS('code', 'idea64', 'idea', 'cursor', 'vscode', 'winword', 'excel', 'powerpnt', 'photoshop', 'premiere', 'figma', 'blender'),
      TITLE('.docx', '.xlsx', '.pptx', '.psd', '.prproj', '.md'),
    ),
    prompt:
      '用户正在专注「{detected_app}」（窗口标题：{window_title}）。默认安静陪伴，不要为了刷存在感打断；只有发现明确异常、报错或长时间卡住时，才用一句很短的话提醒。',
  },
  {
    id: 'im_chat',
    name: '即时通讯',
    match: ANY(PROCESS('wechat', 'weixin', 'qq', 'slack', 'telegram', 'discord')),
    prompt:
      '用户停留在聊天窗口（{window_title}）。除非确实有值得接的话，否则不要主动插话；若开口，只轻量接一句，不追问。',
  },
  {
    id: 'learning',
    name: '学习阅读',
    match: ANY(
      TITLE('课程', '教程', 'lecture', 'tutorial', '.pdf', '论文', '网课'),
      PROCESS('acrobat', 'foxit', 'sumatrapdf'),
    ),
    prompt:
      '用户正在学习/阅读（{window_title}）。不要打断；只有连续专注较久、确实需要休息时，才温和提醒一次。',
  },
  {
    id: 'browsing',
    name: '信息浏览',
    match: ANY(
      PROCESS('chrome', 'firefox', 'msedge', 'edge', 'safari'),
      TITLE('google.com/search', 'bing.com/search', 'zhihu.com/question', '新闻'),
    ),
    prompt:
      '用户正在浏览网页（{window_title}）。默认不打扰；若已连续浏览较久，可提醒一次起身活动，深夜则只做简短关怀。',
  },
  {
    id: 'entertainment',
    name: '娱乐消遣',
    fullscreenIgnore: true,
    match: ANY(
      PROCESS('potplayer', 'vlc', 'spotify', 'netease', 'cloudmusic', 'steam', 'league of legends', 'bilibili'),
      TITLE('youtube.com', 'bilibili.com', 'douyin.com', 'weibo.com', 'reddit.com'),
    ),
    prompt:
      '用户正在娱乐（{window_title}）。可以顺势轻松接一句，但不要打扰沉浸；没有合适的话就保持安静。',
  },
  {
    id: 'daily_chores',
    name: '日常事务',
    match: ANY(TITLE('taobao', 'jd.com', 'bank', 'gov.cn', '12306', 'booking', '银行', '购物')),
    prompt:
      '用户正在处理日常事务（{window_title}）。轻声提醒即可，一句即止；不要催促或反复询问。',
  },
  {
    id: 'file_organizing',
    name: '系统杂务',
    silent: true,
    match: ANY(PROCESS('explorer', 'download')),
    prompt: '',
  },
];

const IDLE_CATEGORY: SceneCategory = {
  id: 'idle',
  name: '空闲离开',
  match: () => false,
  prompt:
    '用户已离开约 {idle_duration} 分钟，或长时间没有键鼠输入。可以主动问候一句，或提议休息/整理桌面；不要连续催促。',
};

/** 小写、去掉 .exe，避免 Chrome.exe / chrome 这种差异 */
export function normalizeApp(app: string): string {
  return (app || '').toLowerCase().replace(/\.exe$/i, '').trim();
}

function normalizeTitle(title: string): string {
  return (title || '').toLowerCase().trim();
}

function idleSecondsOf(screen: SceneScreen | null | undefined): number {
  const value = Number(screen?.idleSeconds);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 当前屏幕 → 场景；按配置顺序取第一个命中，会议优先。 */
export function classifyScene(screen: SceneScreen): SceneCategory | null {
  const app = normalizeApp(screen?.app || '');
  const title = normalizeTitle(screen?.title || '');
  for (const cat of CATEGORIES) {
    if (cat.match(app, title)) return cat;
  }
  // 空闲放在所有前台场景之后：正在专注时仍以当前应用为准。
  if (idleSecondsOf(screen) >= 300) return IDLE_CATEGORY;
  return null;
}

/** 当前是否深夜收敛时段（23:00–07:00） */
export function isQuietHours(now: number): boolean {
  const hour = new Date(now).getHours();
  return hour >= 23 || hour < 7;
}

function safeText(text: string, maxLen: number): string {
  // 复用情景记录模块的清洗（控制字符/密钥/邮箱/本地路径），避免再造一套。
  return sanitizeScenarioText(text, maxLen);
}

/** 填模板变量；未知变量替换成可读的兜底词，避免把 {xxx} 原样喂给模型。 */
function renderPrompt(template: string, screen: SceneScreen, sceneName: string): string {
  const idleMin = Math.floor(idleSecondsOf(screen) / 60);
  const vars: Record<string, string> = {
    detected_app: safeText(screen.app || '当前应用', 40) || '当前应用',
    detected_activity: sceneName,
    window_title: safeText(screen.title || '无标题', 80) || '无标题',
    active_duration: idleMin > 0 ? String(idleMin) : '一段',
    idle_duration: idleMin > 0 ? String(idleMin) : '几',
    page_type: sceneName,
    issue_detail: '需要留意的异常',
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

/** 情景记录保持逐行结构（sanitize 单条会折叠换行，不能把整段压成一行）。 */
function scenarioSummary(text: string): string {
  return (text || '')
    .split(/\r?\n/)
    .map((line) => safeText(line, 140))
    .filter(Boolean)
    .slice(0, 20)
    .join('\n')
    .slice(0, 900);
}

/**
 * 组装一次自主任务的提示词。
 *
 * MCP 状态不是单独一条“外设信息”，而是写进情景提示词本身：
 * 模型能同时看到「当前屏幕 + 场景提示 + 近期记录 + MCP 状态」。
 */
export function buildSceneAutoTaskPrompt(input: ScenePromptInput): ScenePromptResult {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const screen: SceneScreen = input.screen ?? { app: '', title: '', isFullscreen: false, idleSeconds: 0 };
  const idleSeconds = idleSecondsOf(screen);
  const scene = classifyScene(screen);
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
  if (input.mode === 'scene_brief' && scene?.fullscreenIgnore && screen.isFullscreen) {
    return { skip: true, reason: '全屏娱乐中，不弹提示', sceneId, sceneName, prompt: '' };
  }

  const timeText = new Date(now).toLocaleString('zh-CN', { hour12: false });
  const screenText =
    `应用：${safeText(screen.app || '未知', 60) || '未知'}；` +
    `窗口标题：${safeText(screen.title || '无标题', 140) || '无标题'}；` +
    `全屏：${screen.isFullscreen ? '是' : '否'}；` +
    `空闲：${Math.floor(idleSeconds / 60)} 分钟`;

  const sceneTask = custom
    ? custom
    : scene && scene.prompt
      ? renderPrompt(scene.prompt, screen, sceneName)
      : '根据当前屏幕和近期情景，判断是否有值得主动说的一句话；没有就输出“无需提醒”。不要为了刷存在感提醒喝水/休息。';

  const mcpText = safeText(input.mcpText || '未配置', 240) || '未配置';
  const scenarioText = scenarioSummary(input.scenarioText || '');
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
