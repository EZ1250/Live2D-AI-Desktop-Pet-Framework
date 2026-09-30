/**
 * src/preload/preload.ts
 *
 * preload runs with contextIsolation.
 *
 * 本文件运行于 preload 隔离上下文（BrowserWindow webPreferences 中
 * contextIsolation:true、nodeIntegration:false）。只通过 contextBridge 暴露
 * CONTRACT.md 定义的 window.electron（ElectronAPI）窄接口：
 *  - 绝不暴露 ipcRenderer 或任何 node 原对象；
 *  - 通道名与类型全部 import 自 ../shared/contracts，杜绝字符串漂移。
 * Runs inside the isolated preload world; exposes only window.electron.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC_ACTION,
  IPC_AI_CHUNK,
  IPC_AI_DONE,
  IPC_AI_ERROR,
  IPC_AI_MODEL_LIST,
  IPC_ASK_ANSWER,
  IPC_ASK_CANCEL,
  IPC_ASK_QUESTION,
  IPC_ASSET_IMPORT,
  IPC_ASSET_IMPORT_PATH,
  IPC_ASSET_OPEN_DIR,
  IPC_ASSET_PRESET,
  IPC_ASSET_REMOVE,
  IPC_ASSET_SCAN,
  IPC_CHAT_CONTEXT_RESET,
  IPC_CHAT_HISTORY_CLEAR,
  IPC_CHAT_LOG_APPEND,
  IPC_CHAT_LOG_GET,
  IPC_CHAT_SESSION_NEW,
  IPC_CHAT_SESSION_SELECT,
  IPC_CHAT_WINDOW_CLOSE,
  IPC_CHAT_WINDOW_OPEN,
  IPC_CHAT_WINDOW_STATE,
  IPC_CONTEXT_MENU,
  IPC_GLOBAL_CURSOR,
  IPC_HIT_PROBE,
  IPC_HIT_RESULT,
  IPC_LOAD_MODEL,
  IPC_MODEL_LIST,
  IPC_ON_WINDOW_CHANGE,
  IPC_OPEN_PATH,
  IPC_PET_BOUNDS,
  IPC_PICK_FOLDER,
  IPC_PLAN_PUSH,
  IPC_PLUGIN_REGISTER,
  IPC_SEND_MESSAGE,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_SET,
  IPC_THINK_PUSH,
  IPC_THINK_WINDOW_HIDE,
  IPC_THINK_WINDOW_SHOW,
  IPC_THINK_WINDOW_STATE,
  IPC_TODO_ADD,
  IPC_TODO_DEL,
  IPC_TODO_GET,
  IPC_TODO_SHOW,
  IPC_TODO_TOGGLE,
  IPC_UI_BUBBLE,
  IPC_VOICE_CHECK,
  IPC_VOICE_MODELS,
  IPC_VOICE_STATUS,
  IPC_VOICE_TRANSCRIBE,
  IPC_WINDOW_DRAG,
  IPC_WINDOW_DRAG_END,
} from '../shared/contracts';
import type {
  ElectronAPI,
  ModelManifest,
  PluginManifest,
  AppSettings,
  ChatLogEntry,
  ChatLogSnapshot,
  ChatWindowResult,
  TodoDto,
  AssetPresetResult,
  VoiceCheckResult,
  VoiceModelIndexResult,
  VoiceStatusResult,
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
  WindowInfo,
} from '../shared/contracts';

/** 订阅单个主进程推送通道；返回取消订阅函数（用具名 handler，安全移除单个监听）。 */
function subscribeChannel<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => {
    cb(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

/**
 * ElectronAPI 的 preload 实现。
 * invoke 通道为 renderer→main 单向请求/响应；on* 系列为主进程→renderer 推送订阅。
 */
const api: ElectronAPI = {
  loadModel(modelName: string): Promise<ModelManifest> {
    return ipcRenderer.invoke(IPC_LOAD_MODEL, modelName);
  },

  sendMessage(text: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC_SEND_MESSAGE, text);
  },

  onWindowChange(cb: (info: WindowInfo | null) => void): () => void {
    return subscribeChannel<WindowInfo | null>(IPC_ON_WINDOW_CHANGE, cb);
  },

  pluginRegister(plugin: PluginManifest): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC_PLUGIN_REGISTER, plugin);
  },

  modelList(): Promise<string[]> {
    return ipcRenderer.invoke(IPC_MODEL_LIST);
  },

  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(IPC_SETTINGS_GET);
  },

  setSettings(settings: AppSettings): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IPC_SETTINGS_SET, settings);
  },

  /** 开发辅助：弹出系统文件夹选择器（取消返回空字符串）。 */
  pickFolder(): Promise<string> {
    return ipcRenderer.invoke(IPC_PICK_FOLDER);
  },

  /** 开发辅助：用系统默认方式打开目录/文件（成功返回空字符串）。 */
  openPath(target: string): Promise<string> {
    return ipcRenderer.invoke(IPC_OPEN_PATH, target);
  },

  /** 拉取服务端可用 AI 模型列表（设置页的模型选择用）。 */
  aiModelList() {
    return ipcRenderer.invoke(IPC_AI_MODEL_LIST);
  },

  /** 可插拔资产（模型 / 插件）：扫描 / 打开文件夹 / 加入 / 移除。 */
  assetScan() {
    return ipcRenderer.invoke(IPC_ASSET_SCAN);
  },
  assetOpenDir(kind) {
    return ipcRenderer.invoke(IPC_ASSET_OPEN_DIR, kind);
  },
  assetImport(kind) {
    return ipcRenderer.invoke(IPC_ASSET_IMPORT, kind);
  },
  /** 拖放加入：路径来自 webUtils（Electron 31+ 渲染层已拿不到 File.path）。 */
  assetImportPath(path, kind) {
    return ipcRenderer.invoke(IPC_ASSET_IMPORT_PATH, path, kind ?? 'auto');
  },
  /**
   * 把拖放进来的 File 换成绝对路径。
   * Electron 32 起 `File.path` 被移除，唯一受支持的方式就是 webUtils.getPathForFile()，
   * 而且它只能在 preload（有 Electron 上下文）里调用——所以必须经这一层转出去。
   */
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  assetRemove(kind, name) {
    return ipcRenderer.invoke(IPC_ASSET_REMOVE, kind, name);
  },
  /** 模型预设（pet-model.json）：读 / 生成模板 / 用系统程序打开。 */
  assetPreset(action, name) {
    return ipcRenderer.invoke(IPC_ASSET_PRESET, action, name);
  },

  onContextMenu(cb: (position: { x: number; y: number }) => void): () => void {
    return subscribeChannel<{ x: number; y: number }>(IPC_CONTEXT_MENU, cb);
  },

  // ---- 可选推送订阅（renderer 特性探测；renderer.subscribeOptionalPushes 自动接线）----

  /** AI 流式对话：合并 CHUNK(delta)/DONE(full)/ERROR(message) 到单一回调。 */
  onChat(cb) {
    const offs = [
      subscribeChannel<{ delta: string }>(IPC_AI_CHUNK, (p) => cb({ delta: p.delta })),
      subscribeChannel<{ full: string; usage?: unknown }>(IPC_AI_DONE, (p) => cb({ full: p.full })),
      subscribeChannel<{ message: string }>(IPC_AI_ERROR, (p) => cb({ message: p.message })),
    ];
    return () => offs.forEach((off) => off());
  },

  /** 主进程气泡指令（如 windowMonitor 的 speak:health）。 */
  onBubble(cb) {
    return subscribeChannel<{ text?: string; ttlMs?: number }>(IPC_UI_BUBBLE, cb);
  },

  /** 宠物动作（windowMonitor 触发的 slacking/coding/health 等）。 */
  onAction(cb) {
    return subscribeChannel<{ type?: string; payload?: unknown }>(IPC_ACTION, cb);
  },

  /** 全局鼠标屏幕坐标推送（视线自动跟随）。 */
  onGlobalCursor(cb) {
    return subscribeChannel<{ x: number; y: number } | null>(IPC_GLOBAL_CURSOR, cb);
  },

  /** 左键拖拽：增量移动窗口（高频 send，无回执）。 */
  moveWindow(dx: number, dy: number) {
    ipcRenderer.send(IPC_WINDOW_DRAG, { dx, dy });
  },

  /** 拖拽结束（预留）。 */
  endWindowDrag() {
    ipcRenderer.send(IPC_WINDOW_DRAG_END);
  },

  /** 待办笔记本：读取列表。 */
  todoList(): Promise<TodoDto[]> {
    return ipcRenderer.invoke(IPC_TODO_GET);
  },

  /** 待办笔记本：新增一条。 */
  todoAdd(text: string): Promise<TodoDto[]> {
    return ipcRenderer.invoke(IPC_TODO_ADD, text);
  },

  /** 待办笔记本：勾选/取消。 */
  todoToggle(id: number): Promise<TodoDto[]> {
    return ipcRenderer.invoke(IPC_TODO_TOGGLE, id);
  },

  /** 待办笔记本：删除一条。 */
  todoDel(id: number): Promise<TodoDto[]> {
    return ipcRenderer.invoke(IPC_TODO_DEL, id);
  },

  /** 订阅“显示待办笔记本”。 */
  onTodoShow(cb) {
    return subscribeChannel<unknown>(IPC_TODO_SHOW, cb);
  },

  /** 订阅主进程提问（AI ask_user）。 */
  onAskQuestion(cb) {
    return subscribeChannel<{ id: string; question: string; options: Array<{ label: string; description?: string }> }>(
      IPC_ASK_QUESTION,
      cb,
    );
  },

  /** 提交对提问的回答。 */
  askAnswer(payload) {
    return ipcRenderer.invoke(IPC_ASK_ANSWER, payload);
  },

  /** 订阅"提问已失效"（超时/退出）：渲染层收起提问框。 */
  onAskCancel(cb) {
    return subscribeChannel<unknown>(IPC_ASK_CANCEL, () => cb());
  },

  /**
   * 语音输入：把一段录音送去转写（音频经 IPC 直接转发，不落盘）。
   * 传 ArrayBuffer/Uint8Array 均可；返回 { ok, text, ms, error? }，永不抛异常。
   */
  voiceTranscribe(payload: VoiceTranscribeRequest): Promise<VoiceTranscribeResult> {
    return ipcRenderer.invoke(IPC_VOICE_TRANSCRIBE, payload);
  },

  /** 语音输入是否可用（是否配好接口地址与密钥；不返回密钥）。 */
  voiceStatus(): Promise<VoiceStatusResult> {
    return ipcRenderer.invoke(IPC_VOICE_STATUS);
  },

  /** 按 API 地址索引转写模型并体检（设置页用；不会返回密钥）。 */
  voiceModels(): Promise<VoiceModelIndexResult> {
    return ipcRenderer.invoke(IPC_VOICE_MODELS);
  },

  /** 语音自检：用内置合成音频分别打两条转写路由，返回逐条报告（设置页「自检」按钮用）。 */
  voiceCheck(): Promise<VoiceCheckResult> {
    return ipcRenderer.invoke(IPC_VOICE_CHECK);
  },

  /** 聊天记录：读取快照（当前会话记录 + 会话摘要）。 */
  chatLogGet(): Promise<ChatLogSnapshot> {
    return ipcRenderer.invoke(IPC_CHAT_LOG_GET);
  },
  /** 聊天记录：追加一条到当前会话（失败静默）。 */
  chatLogAppend(entry: ChatLogEntry): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC_CHAT_LOG_APPEND, entry);
  },
  /** 新对话：新建会话并返回新快照。 */
  chatSessionNew(): Promise<ChatLogSnapshot> {
    return ipcRenderer.invoke(IPC_CHAT_SESSION_NEW);
  },
  /** 历史对话：切到某个会话查看。 */
  chatSessionSelect(id: string): Promise<ChatLogSnapshot> {
    return ipcRenderer.invoke(IPC_CHAT_SESSION_SELECT, id);
  },
  /** 清空全部历史对话。 */
  chatHistoryClear(): Promise<ChatLogSnapshot> {
    return ipcRenderer.invoke(IPC_CHAT_HISTORY_CLEAR);
  },
  /** 清空 AI 上下文（聊天记录保留）。 */
  chatContextReset(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC_CHAT_CONTEXT_RESET);
  },
  /** 打开独立聊天窗口（对话框在模型窗口外展开，不遮挡桌宠）。 */
  chatWindowOpen(): Promise<ChatWindowResult> {
    return ipcRenderer.invoke(IPC_CHAT_WINDOW_OPEN);
  },
  /** 关闭独立聊天窗口。 */
  chatWindowClose(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC_CHAT_WINDOW_CLOSE);
  },
  /** 订阅独立聊天窗口开/关状态（桌宠窗口据此决定是否收起自己的对话浮窗）。 */
  onChatWindowState(cb) {
    return subscribeChannel<{ open: boolean }>(IPC_CHAT_WINDOW_STATE, cb);
  },
  /** 显示思考浮窗。 */
  thinkWindowShow(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC_THINK_WINDOW_SHOW);
  },
  /** 收起思考浮窗。 */
  thinkWindowHide(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IPC_THINK_WINDOW_HIDE);
  },
  /** 订阅思考浮窗开/关状态。 */
  onThinkWindowState(cb) {
    return subscribeChannel<{ open: boolean }>(IPC_THINK_WINDOW_STATE, cb);
  },
  /** 报告角色在窗口里的实际可见范围（气泡窗据此贴在头顶上方）。 */
  reportPetBounds(bounds: { top: number; height: number }): void {
    ipcRenderer.send(IPC_PET_BOUNDS, bounds);
  },

  /** 订阅"光标探测"坐标（相对客户区）；点击穿透的命中判定用。 */
  onHitProbe(cb) {
    return subscribeChannel<{ x: number; y: number }>(IPC_HIT_PROBE, cb);
  },

  /**
   * 上报命中结果。
   * @param ignore  true = 该点穿透到下层窗口
   * @param overlay true = 窗口内开着覆盖层面板（设置/待办/菜单/思考浮窗）→ 主进程强制保持可交互
   */
  reportHitResult(ignore: boolean, overlay = false): void {
    ipcRenderer.send(IPC_HIT_RESULT, { ignore: Boolean(ignore), overlay: Boolean(overlay) });
  },

  /** 订阅 AI 的任务进度清单（plan_update）。 */
  onPlan(cb) {
    return subscribeChannel<{ items: Array<{ text: string; status: 'pending' | 'doing' | 'done' }> }>(IPC_PLAN_PUSH, cb);
  },

  /** 订阅 AI 思考过程（推理内容 + 工具步骤）。 */
  onThink(cb) {
    return subscribeChannel<{ kind: 'start' | 'reasoning' | 'tool' | 'result' | 'done' | 'error'; text: string }>(
      IPC_THINK_PUSH,
      cb,
    );
  },
};

// 暴露到渲染进程 window.electron（类型声明见 ../shared/contracts 的
// declare global { interface Window { electron: ElectronAPI } }）。
contextBridge.exposeInMainWorld('electron', api);
