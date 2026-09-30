/**
 * src/shared/contracts.ts
 *
 * 全工程跨模块契约的唯一实现方（Single Source of Truth）。
 * Sole implementor of the cross-module contract defined in CONTRACT.md.
 * 其他模块（main / preload / plugin-system / renderer）只可 import 本文件，
 * 不得各自重复定义这些类型与 IPC 通道名。严禁循环依赖：本文件不 import 任何模块。
 *
 * 安全约定：preload 只通过 contextBridge 暴露 window.electron（ElectronAPI），
 * 绝不暴露 ipcRenderer / node 原对象。
 */

// ---------------------------------------------------------------------------
// IPC 通道常量（IPC channel names）——renderer ⇄ main 之间的唯一通道名。
// 名称与 CONTRACT.md 完全一致，改动前必须同步主进程 ipc.ts。
// ---------------------------------------------------------------------------

/** invoke renderer→main：按名字加载模型（返回 ModelManifest）。 */
export const IPC_LOAD_MODEL = 'model:load';
/** invoke renderer→main：发送一条用户消息，触发 AI 对话（返回 {ok}）。 */
export const IPC_SEND_MESSAGE = 'chat:send';
/** invoke renderer→main：注册插件清单（PluginManifest），返回 {ok, error?}。 */
export const IPC_PLUGIN_REGISTER = 'plugin:register';
/** 主进程 push→renderer：活动窗口变化（webContents.send / ipcRenderer.on）。 */
export const IPC_ON_WINDOW_CHANGE = 'monitor:windowChange';
/** 主进程 push→renderer：AI 回复的逐字增量分片 {delta}。 */
export const IPC_AI_CHUNK = 'chat:chunk';
/** 主进程 push→renderer：AI 回复完成 {full, usage?}。 */
export const IPC_AI_DONE = 'chat:done';
/** 主进程 push→renderer：AI 出错 {message}。 */
export const IPC_AI_ERROR = 'chat:error';
/** renderer→main 或主进程内部：宠物动作 {type:'speak'|'motion'|'expression', payload}。 */
export const IPC_ACTION = 'pet:action';
/** 主进程 push→renderer：要求渲染气泡 {text, ttlMs}。 */
export const IPC_UI_BUBBLE = 'ui:bubble';
/** invoke renderer→main：返回可用模型名数组 string[]。 */
export const IPC_MODEL_LIST = 'model:list';
/** invoke renderer→main：读取持久化应用设置。 */
export const IPC_SETTINGS_GET = 'settings:get';
/** invoke renderer→main：保存并立即应用应用设置。 */
export const IPC_SETTINGS_SET = 'settings:set';
/** 主进程捕获透明拖拽窗口右键后推送菜单坐标。 */
export const IPC_CONTEXT_MENU = 'ui:contextMenu';
/** 主进程 push→renderer：全局鼠标屏幕坐标（DIP，轮询），用于宠物视线自动跟随。 */
export const IPC_GLOBAL_CURSOR = 'cursor:global';
/** renderer→main（send，高频）：左键拖拽窗口的增量位移 {dx, dy}（DIP）。 */
export const IPC_WINDOW_DRAG = 'win:drag';
/** renderer→main（send）：拖拽结束通知。 */
export const IPC_WINDOW_DRAG_END = 'win:drag-end';
/** invoke renderer→main：读取待办列表（TodoDto[]）。 */
export const IPC_TODO_GET = 'todo:get';
/** invoke renderer→main：新增待办，返回最新列表。 */
export const IPC_TODO_ADD = 'todo:add';
/** invoke renderer→main：勾选/取消某待办，返回最新列表。 */
export const IPC_TODO_TOGGLE = 'todo:toggle';
/** invoke renderer→main：删除某待办，返回最新列表。 */
export const IPC_TODO_DEL = 'todo:del';
/** 主进程 push→renderer：要求显示“待办笔记本”面板。 */
export const IPC_TODO_SHOW = 'todo:show';
/** 主进程 push→renderer：AI 向用户提问 {id, question, options:[{label,description}]}。 */
export const IPC_ASK_QUESTION = 'ask:question';
/** invoke renderer→main：提交用户回答 {id, selected?:string[], text?:string}。 */
export const IPC_ASK_ANSWER = 'ask:answer';
/** 主进程 push→renderer：提问已失效（超时/退出）→ 渲染层收起提问框并结束等待态。 */
export const IPC_ASK_CANCEL = 'ask:cancel';
/** 主进程 push→renderer：AI 思考过程事件 {kind, text}（推理内容 / 工具步骤 / 完成）。 */
export const IPC_THINK_PUSH = 'ai:think';
/** 主进程 push→renderer：AI 的任务进度清单 { items: Array<{ text, status }> }。 */
export const IPC_PLAN_PUSH = 'ai:plan';
/** invoke renderer→main：读取当前会话记录 + 历史会话摘要（返回 ChatLogSnapshot）。 */
export const IPC_CHAT_LOG_GET = 'chat:logGet';
/** invoke renderer→main：追加一条聊天记录（写入当前会话）。 */
export const IPC_CHAT_LOG_APPEND = 'chat:logAppend';
/** invoke renderer→main：新建会话（返回新的快照）。 */
export const IPC_CHAT_SESSION_NEW = 'chat:sessionNew';
/** invoke renderer→main：切换到某个历史会话查看（返回该会话记录的快照）。 */
export const IPC_CHAT_SESSION_SELECT = 'chat:sessionSelect';
/** invoke renderer→main：清空全部历史会话（并新建一个空会话）。 */
export const IPC_CHAT_HISTORY_CLEAR = 'chat:historyClear';
/** invoke renderer→main：清空 AI 的对话上下文（不影响聊天记录）。 */
export const IPC_CHAT_CONTEXT_RESET = 'chat:contextReset';
/** invoke renderer→main：打开（不存在则创建）独立聊天窗口——对话框在模型窗口外展开，不遮挡桌宠。 */
export const IPC_CHAT_WINDOW_OPEN = 'chat:windowOpen';
/** invoke renderer→main：关闭独立聊天窗口。 */
export const IPC_CHAT_WINDOW_CLOSE = 'chat:windowClose';
/** 主进程 push→renderer：独立聊天窗口开/关状态 {open}（桌宠窗口据此收起自己的浮窗与输入条）。 */
export const IPC_CHAT_WINDOW_STATE = 'chat:windowState';
/** invoke renderer→main：显示（不存在则创建）思考浮窗——提问时自动打开，也可从 ＋ 菜单手动开。 */
export const IPC_THINK_WINDOW_SHOW = 'think:windowShow';
/** invoke renderer→main：收起思考浮窗。 */
export const IPC_THINK_WINDOW_HIDE = 'think:windowHide';
/** renderer→main（send）：报告角色在窗口里的实际可见范围 {top,height}（DIP），供气泡窗贴到头顶上方。 */
export const IPC_PET_BOUNDS = 'pet:bounds';
/**
 * 主进程 push→renderer：全局光标相对桌宠窗口客户区的坐标 {x,y}（DIP）。
 * 点击穿透用：主进程已知窗口位置与全局光标，换算后交给渲染层做命中判定。
 */
export const IPC_HIT_PROBE = 'pet:hitProbe';
/**
 * renderer→main（send）：命中判定的结果 {ignore, overlay}。
 * ignore  = true → 该点不在角色身上 → 主进程执行 setIgnoreMouseEvents(true, {forward:true}) 让点击穿到底下。
 * overlay = true → 窗口内正开着覆盖层面板（设置/待办/右键菜单/思考浮窗）。
 *
 * 为什么需要 overlay：这些面板就在**同一个窗口内部**，而 setIgnoreMouseEvents 是**整窗**生效的。
 * 只看"光标是否在角色身上"的话，面板一打开、光标落在面板外缘的透明处就会被判成可穿透，
 * 于是面板自己也点不动了。有这个标志，主进程就能在面板打开期间强制保持可交互。
 */
export const IPC_HIT_RESULT = 'pet:hitResult';
/** 主进程 push→renderer：思考浮窗开/关状态 {open}（气泡窗里据此显示「思考浮窗」是开还是关）。 */
export const IPC_THINK_WINDOW_STATE = 'think:windowState';

/** 打开聊天窗口的结果。 */
export interface ChatWindowResult {
  ok: boolean;
  /** ok=false 时的原因（渲染入口缺失 / 窗口创建失败等）。 */
  error?: string;
}

/** 一条聊天记录（user=主人 / pet=桌宠回复 / tool=工具步骤 / error=错误提示）。 */
export interface ChatLogEntry {
  role: 'user' | 'pet' | 'tool' | 'error';
  text: string;
  at: number;
}

/** 历史会话摘要（会话列表用）。 */
export interface ChatSessionSummary {
  id: string;
  startedAt: number;
  title: string;
  count: number;
}

/** 聊天记录快照：当前会话的记录 + 历史会话摘要（新→旧）。 */
export interface ChatLogSnapshot {
  currentId: string;
  entries: ChatLogEntry[];
  sessions: ChatSessionSummary[];
}
/** invoke renderer→main：弹出系统文件夹选择器，返回绝对路径（取消返回空字符串）。 */
export const IPC_PICK_FOLDER = 'app:pickFolder';
/** invoke renderer→main：用系统方式打开一个目录/文件（返回空字符串=成功，否则为错误信息）。 */
export const IPC_OPEN_PATH = 'app:openPath';
/**
 * invoke renderer→main：从当前 API 地址拉取服务端**可用模型列表**（GET /models）。
 * 设置页用它把"AI 模型"变成可选列表，避免手打一个不存在的模型名（服务端只会回 "Model not exist."）。
 */
export const IPC_AI_MODEL_LIST = 'ai:modelList';

/** AI 模型列表拉取结果。 */
export interface AiModelListResult {
  ok: boolean;
  /** 可用模型 ID（已排序、去重）；ok=false 时为空数组。 */
  models: string[];
  /** ok=false 时的原因（网络/鉴权/地址不对等）。 */
  error?: string;
}

// ---------------------------------------------------------------------------
// 可插拔资产（Live2D 模型 / 插件）：扫描、校验、导入、移除
// 设计：模型与插件都是"可加可移除的外部资产"，一律通过"打开文件夹 / 选文件夹"加入，
//       每个资产都带回**问题清单**，用户能看到到底缺什么、哪里不兼容。
// ---------------------------------------------------------------------------

/** invoke renderer→main：扫描用户资产（模型 + 插件）并返回带问题清单的结果。 */
export const IPC_ASSET_SCAN = 'assets:scan';
/** invoke renderer→main：打开对应资产文件夹（模型 / 插件），没有就创建。 */
export const IPC_ASSET_OPEN_DIR = 'assets:openDir';
/** invoke renderer→main：打开系统文件夹选择器并把选中的目录加入（校验不过会返回可读原因）。 */
export const IPC_ASSET_IMPORT = 'assets:import';
/**
 * invoke renderer→main：按**绝对路径**直接加入资产（拖放文件/文件夹到桌宠身上时用）。
 * 与 IPC_ASSET_IMPORT 的区别只是不经系统选择器——路径由渲染层经 `webUtils.getPathForFile` 取到。
 * 主进程会自己判断是模型还是插件（看目录里的描述文件），所以渲染层不需要预先分类。
 */
export const IPC_ASSET_IMPORT_PATH = 'assets:importPath';
/** invoke renderer→main：移除一个用户资产（外部目录只注销、不删用户文件）。 */
export const IPC_ASSET_REMOVE = 'assets:remove';
/**
 * invoke renderer→main：模型的 `pet-model.json` 预设（取景 / 情绪→表情 / 参数映射）。
 * action: 'get' 读；'template' 在 userData 里生成模板（已存在则不覆盖）；'open' 用系统默认程序打开。
 */
export const IPC_ASSET_PRESET = 'assets:preset';

/** 预设操作返回（get/template/open 共用）。 */
export interface AssetPresetResult {
  ok: boolean;
  /** 预设在磁盘上的位置（get/template 有；未生成时为空） */
  path?: string;
  /** 是否已存在（false = 还没写过预设） */
  exists?: boolean;
  /** 是否来自 userData（true）还是模型目录里的 pet-model.json（false） */
  fromUserData?: boolean;
  /** 本次是否新写了模板 */
  created?: boolean;
  /** 重新识别能力(action=detect)时：内容是否真的有变化 */
  changed?: boolean;
  /** 解析后的预设（get） */
  preset?: { framing?: 'full' | 'half'; emotionMap?: Record<string, string>; parameterMap?: Record<string, string> };
  /** 预设文件的问题清单（坏 JSON / 字段类型不对等） */
  issues?: string[];
  /** 该模型可用的表情名（写模板时列出来，省得用户去翻 model3.json） */
  expressions?: string[];
  /** 自动识别出的能力归类（action='detect' 或 'get' 时返回） */
  capabilities?: {
    click?: string[];
    costume?: string[];
    emotion?: Record<string, string>;
    idle?: string[];
    motions?: string[];
  };
  /** 识别过程要提醒用户的事（例如有情绪参数但没有情绪表情） */
  capabilityIssues?: string[];
  error?: string;
}

/** 资产种类。 */
export type AssetKind = 'model' | 'plugin';

/** 用户模型（扫描结果）。 */
export interface UserModelInfo {
  name: string;
  dir: string;
  kind: 'moc3' | 'portrait' | 'unknown';
  issues: string[];
  mocVersion: number | null;
  external: boolean;
  sizeMb: number;
  /** 这个模型当前的预设摘要（取景 / 映射条数）；没有预设时为 undefined */
  preset?: {
    framing?: 'full' | 'half';
    emotionCount: number;
    parameterCount: number;
    fromUserData: boolean;
    /** 自动识别出的能力条数（点击触发/服饰道具/情绪映射/其它动作组） */
    capabilities?: { click: number; costume: number; emotion: number; motions: number };
  };
  /** 预设文件的问题（坏 JSON / 字段类型不对）；没有问题时 undefined */
  presetIssues?: string[];
  /** 模型体检结果（能不能渲染 / 为什么 / 怎么办） */
  compat?: ModelCompatInfo;
}

/** 用户插件（扫描结果）。 */
export interface UserPluginInfo {
  name: string;
  dir: string;
  entry: string;
  version: string;
  description: string;
  issues: string[];
  external: boolean;
}

/** 资产扫描结果。 */
export interface AssetScanResult {
  models: UserModelInfo[];
  plugins: UserPluginInfo[];
  /** 两个目录的绝对路径（设置页展示 + 打开） */
  dirs: { model: string; plugin: string };
  /** 随包模型名（用于区分"内置"与"用户添加"） */
  builtinModels: string[];
}

/** 加入资产的返回。 */
export interface AssetImportResult {
  ok: boolean;
  kind: AssetKind;
  name?: string;
  issues?: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// 语音输入（按住说话 → 云端 ASR 转写）
// 设计：录音由渲染层（MediaRecorder）完成，**音频只经 IPC 传给主进程直接转发**，
//       不落盘、不缓存；转写文本回到渲染层填入输入框，由用户确认后发送（不自动发送）。
// ---------------------------------------------------------------------------

/** invoke renderer→main：把一段录音送去转写。 */
export const IPC_VOICE_TRANSCRIBE = 'voice:transcribe';
/** invoke renderer→main：查询语音输入是否可用（地址+密钥是否就绪），不返回密钥本身。 */
export const IPC_VOICE_STATUS = 'voice:status';
/** invoke renderer→main：语音自检（用内置合成音频分别打两条路由，返回逐条报告）。 */
export const IPC_VOICE_CHECK = 'voice:check';
/** invoke renderer→main：按 API 地址索引转写模型（GET /models）并体检当前转写模型/路由。 */
export const IPC_VOICE_MODELS = 'voice:models';

/** 语音转写请求。 */
export interface VoiceTranscribeRequest {
  /** 音频二进制（渲染层传 ArrayBuffer 或 Uint8Array）。 */
  bytes: Uint8Array | ArrayBuffer;
  /** 例：audio/webm;codecs=opus */
  mime?: string;
  /** 例：zh */
  language?: string;
}

/** 语音转写结果（ok=false 时 error 可直接展示）。 */
export interface VoiceTranscribeResult {
  ok: boolean;
  text: string;
  ms: number;
  error?: string;
}

/** 语音输入可用性（绝不包含密钥）。 */
export interface VoiceStatusResult {
  configured: boolean;
  model: string;
  /** 实际生效的路由（auto 时为上次成功过的路由，没有则为空） */
  route?: string;
  /** 仅主机名 + 路径，用于设置页显示"发往哪里"；已剔除协议与查询串。 */
  endpoint: string;
  /** 是否复用了聊天用的地址/密钥（false = 语音单独配置了） */
  reuseAiConfig?: boolean;
  /** 配置缺失时的提示文案。 */
  hint?: string;
}

/** 语音自检的单条路由报告。 */
/** 按 API 地址索引到的转写模型体检结果。 */
export interface VoiceModelIndexResult {
  /** 是否成功拿到模型列表 */
  ok: boolean;
  /** 只留主机+路径，不含密钥 */
  endpoint: string;
  /** 列表里的模型总数 */
  total: number;
  /** 转写类候选（强特征在前） */
  candidates: string[];
  /** 当前配置的转写模型（空=没填） */
  current: string;
  /** 当前模型是否出现在服务端列表里 */
  currentSupported: boolean;
  /** 当前模型为空时建议自动填入的候选 */
  autoPicked?: string;
  /** ok=当前模型可用；warn=需人确认；error=拉不到列表或模型不存在 */
  verdict: 'ok' | 'warn' | 'error';
  /** 一句话原因 */
  reason: string;
  /** 一句话怎么办 */
  action?: string;
  /** 上次实测可用的路由 */
  knownRoute?: 'transcriptions' | 'chat-audio';
  /** 路由层面的提醒 */
  routeHint?: string;
}

export interface VoiceCheckRouteReport {
  route: 'transcriptions' | 'chat-audio';
  ok: boolean;
  /** 成功=「200 OK」；失败=可读原因（含 HTTP 状态码） */
  status: string;
  ms: number;
  /** 成功时：识别出的文本（自检音频是合成音，可能为空/很短） */
  text?: string;
  error?: string;
}

/** 语音自检结果。 */
export interface VoiceCheckResult {
  ok: boolean;
  /** 建议使用的路由（两条都失败时为空） */
  route?: 'transcriptions' | 'chat-audio';
  model: string;
  endpoint: string;
  reports: VoiceCheckRouteReport[];
  hint?: string;
}

/** 待办条目（渲染层可见形态） */
export interface TodoDto {
  id: number;
  text: string;
  done: boolean;
}

// ---------------------------------------------------------------------------
// 窗口与模型（window / model）
// ---------------------------------------------------------------------------

/**
 * 活动窗口信息。由主进程 windowMonitor 采集并 push 给渲染进程与插件。
 * Active-window snapshot; null = 当前无活动窗口。
 */
export interface WindowInfo {
  /** 窗口所属应用名，如 "Code"、"chrome"。 */
  app: string;
  /** 窗口标题。 */
  title: string;
  /** 窗口在屏幕坐标中的边界（物理像素）。 */
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  /** 是否全屏。 */
  isFullscreen: boolean;
}

/**
 * 模型清单。loadModel 返回其 url 指向主进程内启动的本地静态 HTTP 服务
 * （http://127.0.0.1:<port>/assets/...）；渲染进程一律不直接读文件系统。
 * Resolved model descriptor returned by the main process.
 */
export interface ModelManifest {
  /** 模型名（目录名，须与 IPC_MODEL_LIST 返回的名字一致）。 */
  name: string;
  /** 模型静态资源 base URL（主进程本地 HTTP 服务）。 */
  url: string;
  /** 'moc3' = Live2D 模型；'portrait' = 静态立绘。 */
  type: 'moc3' | 'portrait';
  /** 相对资源根的 model3.json 路径（如 'x.model3.json'）。 */
  model3Path: string;
  /** 模型 moc3 的 Cubism 版本（头第 5 字节，如 3/4/5；portrait/未知时为 undefined）。 */
  mocVersion?: number;
  /**
   * 模型自带预设（模型目录里的可选 `pet-model.json`）：
   * 取景建议 / 情绪→表情映射 / 参数映射。缺失时 undefined，行为与从前一致。
   */
  preset?: {
    framing?: 'full' | 'half';
    emotionMap?: Record<string, string>;
    parameterMap?: Record<string, string>;
    /** 自动识别出的能力归类（点击触发/服饰道具/情绪表情/动作组） */
    capabilities?: {
      click?: string[];
      costume?: string[];
      emotion?: Record<string, string>;
      idle?: string[];
      motions?: string[];
    };
  };
  /** 预设文件的兼容性问题（示例：framing 值非法、emotionMap 不是对象）；空/缺省 = 没问题。 */
  presetIssues?: string[];
  /**
   * 模型体检结果（外部模型普适适配层，见 main/assets/modelCompat.ts）：
   * 任何来源的模型都能给出「能不能渲染 / 为什么 / 怎么办」，渲染层据此决定直接提示而不是硬加载。
   */
  compat?: ModelCompatInfo;
}

/** 模型体检结果（主进程 modelCompat.ts 产出） */
export interface ModelCompatInfo {
  /** moc3=Live2D 骨骼；portrait=静态立绘；cubism2/unknown=挂不了 */
  type: 'moc3' | 'portrait' | 'cubism2' | 'unknown';
  /** moc3 头部版本（3=4.0 / 4=4.2 / 5=Cubism 5）；非 moc3 为 null */
  mocVersion: number | null;
  /** 随包运行库最高能读的 moc3 版本（解析 lib 里的 MocVersion_* 得到） */
  coreMax: number;
  verdict: 'ok' | 'warn' | 'unsupported';
  /** 一句话原因（中文，给用户看） */
  reason?: string;
  /** 一句话怎么办（中文，给用户看） */
  action?: string;
  /** 细节：缺哪些文件、有几个候选、命中哪个描述文件…… */
  issues: string[];
  /** 命中的描述文件（相对模型目录） */
  model3?: string;
}

// ---------------------------------------------------------------------------
// 渲染进程桥接 API（由 preload 实现）
// ---------------------------------------------------------------------------

/**
 * 暴露到 window.electron 的渲染进程 API 契约（严格签名，见 CONTRACT.md）。
 * Bridge surface exposed by preload via contextBridge.exposeInMainWorld('electron', ...).
 */
export interface ElectronAPI {
  /** 加载指定模型，resolve 为 ModelManifest（url 指向主进程静态服务）。 */
  loadModel(modelName: string): Promise<ModelManifest>;
  /** 发送消息触发 AI 对话；流式结果经 onChat 订阅推送。 */
  sendMessage(text: string): Promise<{ ok: boolean }>;
  /** 订阅活动窗口变化；返回取消订阅函数。 */
  onWindowChange(cb: (info: WindowInfo | null) => void): () => void;
  /** 注册插件清单，供主进程加载进 plugin registry；失败时 error 携带原因。 */
  pluginRegister(plugin: PluginManifest): Promise<{ ok: boolean; error?: string }>;
  /** 返回资源目录中的可用模型名。 */
  modelList(): Promise<string[]>;
  /** 读取当前持久化设置。 */
  getSettings(): Promise<AppSettings>;
  /** 持久化并立即应用设置。 */
  setSettings(settings: AppSettings): Promise<{ ok: boolean; error?: string }>;
  /** 订阅透明拖拽窗口的右键菜单坐标。 */
  onContextMenu?(cb: (position: { x: number; y: number }) => void): () => void;
  /**
   * 订阅主进程推送（可选，特性探测）：
   * - AI 流式分片/完成/错误（IPC_AI_CHUNK/DONE/ERROR）
   * - 气泡指令（IPC_UI_BUBBLE）
   * - 宠物动作（IPC_ACTION，如 windowMonitor 触发的摸鱼/敲码/健康提醒）
   * 各订阅返回取消函数。preload 若未实现这些方法则 renderer 自动降级
   * （仅能发消息、收不到推送）——见 renderer.subscribeOptionalPushes。
   */
  onChat?(cb: (payload: { delta?: string; full?: string; message?: string }) => void): () => void;
  onBubble?(cb: (payload: { text?: string; ttlMs?: number }) => void): () => void;
  onAction?(cb: (payload: { type?: string; payload?: any }) => void): () => void;
  /**
   * 订阅主进程轮询推送的全局鼠标屏幕坐标 {x, y}（DIP；鼠标移动才推送），
   * renderer 用它换算视线目标实现"宠物自动望向鼠标"。
   */
  onGlobalCursor?(cb: (pos: { x: number; y: number } | null) => void): () => void;
  /** 左键拖拽移动窗口：增量 DIP 坐标（fire-and-forget，拖拽高频用 ipcRenderer.send）。 */
  moveWindow(dx: number, dy: number): void;
  /** 拖拽结束通知（主进程预留收尾）。 */
  endWindowDrag(): void;
  /** 弹出系统文件夹选择器；取消/失败返回空字符串。 */
  pickFolder?(): Promise<string>;
  /** 用系统默认方式打开目录或文件；成功返回空字符串，失败返回错误信息。 */
  openPath?(target: string): Promise<string>;
  /** 拉取服务端可用 AI 模型列表（设置页的模型选择用）。 */
  aiModelList?(): Promise<AiModelListResult>;
  /** 扫描用户资产（模型 + 插件），带问题清单。 */
  assetScan?(): Promise<AssetScanResult>;
  /** 打开资产文件夹（模型 / 插件）；返回空字符串=成功。 */
  assetOpenDir?(kind: AssetKind): Promise<string>;
  /** 选一个文件夹并加入（模型或插件）。 */
  assetImport?(kind: AssetKind): Promise<AssetImportResult>;
  /**
   * 按绝对路径加入资产（拖放用）。kind='auto' 时由主进程按目录内容判断模型还是插件。
   * 路径来自 preload 的 `pathForFile()`（Electron 31+ 起渲染层拿不到 File.path）。
   */
  assetImportPath?(path: string, kind?: AssetKind | 'auto'): Promise<AssetImportResult>;
  /**
   * 把拖放的 File 转成绝对路径（preload 里调 `webUtils.getPathForFile`）。
   * Electron 31+ 移除了 `File.path`，渲染层只能经这个桥取路径；取不到时返回空字符串。
   */
  pathForFile?(file: File): string;
  /** 移除一个用户资产。 */
  assetRemove?(kind: AssetKind, name: string): Promise<{ ok: boolean; error?: string; removedFiles?: boolean }>;
  /** 模型预设（pet-model.json）：读 / 生成模板 / 用系统程序打开。 */
  assetPreset?(action: 'get' | 'template' | 'open' | 'detect', name: string): Promise<AssetPresetResult>;
  /** 语音输入：把一段录音送去转写（音频不落盘，仅内存转发）。 */
  voiceTranscribe?(payload: VoiceTranscribeRequest): Promise<VoiceTranscribeResult>;
  /** 语音输入：查询是否可用（地址 + 密钥），返回内容不含密钥。 */
  voiceStatus?(): Promise<VoiceStatusResult>;
  /** 语音输入：按 API 地址索引转写模型并体检（只读 /models，不做转写；返回内容不含密钥）。 */
  voiceModels?(): Promise<VoiceModelIndexResult>;
  /** 语音输入：自检（用内置合成音频分别打两条转写路由），设置页「自检」按钮用。 */
  voiceCheck?(): Promise<VoiceCheckResult>;
  /** 待办笔记本：读取列表（TodoDto[]）。 */
  todoList(): Promise<TodoDto[]>;
  /** 待办笔记本：新增一条，返回最新列表。 */
  todoAdd(text: string): Promise<TodoDto[]>;
  /** 待办笔记本：勾选/取消，返回最新列表。 */
  todoToggle(id: number): Promise<TodoDto[]>;
  /** 待办笔记本：删除一条，返回最新列表。 */
  todoDel(id: number): Promise<TodoDto[]>;
  /** 订阅“显示待办笔记本”指令（聊天路由触发）。 */
  onTodoShow?(cb: () => void): () => void;
  /** 读取历史聊天记录快照（当前会话记录 + 会话摘要）。 */
  chatLogGet?(): Promise<ChatLogSnapshot>;
  /** 追加一条聊天记录（写入当前会话，失败静默）。 */
  chatLogAppend?(entry: ChatLogEntry): Promise<{ ok: boolean }>;
  /** 新建一段对话（返回新快照）。 */
  chatSessionNew?(): Promise<ChatLogSnapshot>;
  /** 查看某个历史对话（返回该会话的快照）。 */
  chatSessionSelect?(id: string): Promise<ChatLogSnapshot>;
  /** 清空全部历史对话（并新建空会话）。 */
  chatHistoryClear?(): Promise<ChatLogSnapshot>;
  /** 清空 AI 的对话上下文（聊天记录保留）。 */
  chatContextReset?(): Promise<{ ok: boolean }>;
  /** 打开独立聊天窗口（对话框在模型窗口外展开）；失败时渲染层回退到窗口内输入条。 */
  chatWindowOpen?(): Promise<ChatWindowResult>;
  /** 关闭独立聊天窗口。 */
  chatWindowClose?(): Promise<{ ok: boolean }>;
  /** 订阅独立聊天窗口开/关状态。 */
  onChatWindowState?(cb: (payload: { open: boolean }) => void): () => void;
  /** 显示思考浮窗（提问时主进程会自动打开，这里供 ＋ 菜单手动开）。 */
  thinkWindowShow?(): Promise<{ ok: boolean }>;
  /** 收起思考浮窗。 */
  thinkWindowHide?(): Promise<{ ok: boolean }>;
  /** 订阅思考浮窗开/关状态。 */
  onThinkWindowState?(cb: (payload: { open: boolean }) => void): () => void;
  /** 报告角色在窗口里的实际可见范围（相对窗口顶部 px），主进程据此摆放对话气泡。 */
  reportPetBounds?(bounds: { top: number; height: number }): void;
  /** 订阅"光标探测"坐标（相对桌宠客户区，DIP）；点击穿透的命中判定用。 */
  onHitProbe?(cb: (pos: { x: number; y: number }) => void): () => void;
  /**
   * 上报命中判定结果。
   * @param ignore  true = 该点可穿透到下层窗口
   * @param overlay true = 窗口内正开着覆盖层面板（设置/待办/右键菜单/思考浮窗），
   *                此时主进程会**强制保持可交互**，否则面板自己也点不动
   */
  reportHitResult?(ignore: boolean, overlay?: boolean): void;
  /** 订阅主进程提问（AI ask_user 工具）。 */
  onAskQuestion?(cb: (payload: { id: string; question: string; options: Array<{ label: string; description?: string }> }) => void): () => void;
  /** 提交对提问的回答（选项或自由文本）。 */
  askAnswer(payload: { id: string; selected?: string[]; text?: string }): Promise<{ ok: boolean; error?: string }>;
  /** 订阅"提问已失效"（超时/退出）：渲染层应收起提问框、结束等待态。 */
  onAskCancel?(cb: () => void): () => void;
  /** 订阅 AI 思考过程事件（推理内容 + 工具调用步骤），用于“思考浮窗”。 */
  onThink?(cb: (evt: { kind: 'start' | 'reasoning' | 'tool' | 'result' | 'done' | 'error'; text: string }) => void): () => void;
  /** 订阅 AI 的任务进度清单（plan_update 工具推送），用于在浮窗里显示进度。 */
  onPlan?(cb: (payload: { items: Array<{ text: string; status: 'pending' | 'doing' | 'done' }> }) => void): () => void;
}

/** 可由设置页编辑的应用配置；API key 仅在本地 userData/settings.json 保存。 */
export interface AppSettings {
  aiBaseUrl?: string;
  aiApiKey?: string;
  aiModel?: string;
  provider?: string;
  azureApiVersion?: string;
  temperature?: number;
  contextRounds?: number;
  maxContextTokens?: number;
  /** 工具调用需确认：开启后写类工具执行前先询问用户（默认关闭）。 */
  confirmTools?: boolean;
  /** 显示思考过程：请求模型返回推理内容（enable_thinking，Qwen3 系支持；默认开启）。 */
  showThinking?: boolean;
  /** 点击桌宠时的轻灵音效开关（默认开启）。 */
  sfxEnabled?: boolean;
  /** 音效音量 0~1（默认 0.6）。 */
  sfxVolume?: number;
  /** 开发工作区根目录（绝对路径；空=未配置，此时建目录/写文件/执行命令类工具全部禁用）。 */
  devWorkspaceRoot?: string;
  /** 是否允许 AI 执行 PowerShell 命令（默认 true；危险命令始终会被拦截）。 */
  allowShell?: boolean;
  /** 权限模式：ask=每次询问（默认）；auto-edit=写类操作自动放行（命令仍问）；plan-only=只读/计划（拒绝任何写与命令）。 */
  permissionMode?: 'ask' | 'auto-edit' | 'plan-only';
  /** 角色取景：full=全身（默认，缩放到窗口里）；half=半身（放大取头与上半身，脚裁掉）。 */
  displayMode?: 'full' | 'half';
  /**
   * 前台是全屏应用（游戏/视频/全屏文档）时自动收起桌宠，退出全屏后自动回来。
   * 默认开启：桌宠是 alwaysOnTop，全屏时压在别人画面会很碍事。经托盘手动隐藏过则不再自动弹出。
   */
  hideOnFullscreen?: boolean;
  /**
   * 点击穿透：透明区域不拦截鼠标（点击落到下面的窗口/桌面），只有角色身体范围可交互。
   * 默认关闭——它靠渲染层按像素命中判定，属于"没实机验证过就不该默认打开"的交互变更。
   */
  clickThrough?: boolean;
  /**
   * 桌宠窗口位置与尺寸：主进程在移动/缩放后写入，下次启动读回。
   * 只在窗口仍落在某个显示器工作区内时才沿用，换屏/拔屏后不会跑到看不见的地方。
   */
  petX?: number;
  petY?: number;
  petW?: number;
  petH?: number;
  /**
   * 语音识别模型（默认 qwen3-asr-flash）。
   * 注意：ASR 模型与聊天模型通常不是同一个，所以单独一项；留空=用默认。
   */
  voiceModel?: string;
  /**
   * 语音转写路由：
   *  - auto（默认）：先试上次成功的路由，其次 chat-audio，最后 transcriptions
   *  - chat-audio：走 /chat/completions + input_audio（阿里云百炼工作区域名只支持这条）
   *  - transcriptions：走 /audio/transcriptions（OpenAI 经典 multipart）
   */
  voiceRoute?: 'auto' | 'chat-audio' | 'transcriptions';
  /** 语音单独使用的网关地址（留空=复用 aiBaseUrl）；当聊天网关不支持语音时填这里。 */
  voiceBaseUrl?: string;
  /** 语音单独使用的密钥（留空=复用 aiApiKey）。 */
  voiceApiKey?: string;
  /**
   * 邮箱 IMAP（给 mail_check 用；留空则"看邮件"不可用，但"写邮件"始终可用）。
   * 只存在**本机** settings.json，不随包、不上传。多数邮箱要用网页端生成的**授权码**，不是登录密码。
   */
  mailImapHost?: string;
  /** IMAP 端口：993（SSL，默认）/ 143（非 SSL，secure 置 false）。 */
  mailImapPort?: number;
  mailImapUser?: string;
  /** 授权码/密码。绝不写进日志，也不回显给模型。 */
  mailImapPass?: string;
}

/** 渲染进程类型增强：window.electron 在全局可用。 */
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}

// ---------------------------------------------------------------------------
// 插件（plugin）
// ---------------------------------------------------------------------------

/**
 * 插件注册清单。name 全局唯一；entry 是插件入口资源，由主进程加载（registry 持
 * factory 载入，entry 留给主进程做动态 import 定位）。
 * Manifest used to register a plugin with the main process.
 */
export interface PluginManifest {
  /** 插件唯一名（注册时校验不重复）。 */
  name: string;
  /** 插件版本号（semver 风格字符串）。 */
  version: string;
  /** 插件入口文件路径/URL，供主进程定位并加载。 */
  entry: string;
}
