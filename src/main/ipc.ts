/**
 * ipc.ts —— 主进程 IPC 处理器注册 + 主窗口推送工具
 *
 * 通道常量全部来自 ../shared/contracts，本文件不重复定义。
 *  - IPC_LOAD_MODEL    invoke → ModelManifest {name, url, type}（url 指向本地静态服务）
 *  - IPC_MODEL_LIST    invoke → string[]（模型名列表）
 *  - IPC_SEND_MESSAGE  invoke → {ok}；校验长度 > 0；文本走 chat.startChat 异步流式，
 *                      流式结果由 main.ts 经 pushToRenderer 推 IPC_AI_CHUNK/DONE/ERROR
 *  - IPC_PLUGIN_REGISTER invoke → registry.register(manifest) 归一化为 {ok, error?}
 *
 * registry 使用结构接口，main.ts 负责适配具体实现。
 */
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
  IPC_AI_DONE,
  IPC_AI_MODEL_LIST,
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
  IPC_LOAD_MODEL,
  IPC_MODEL_LIST,
  IPC_OPEN_PATH,
  IPC_PICK_FOLDER,
  IPC_PLUGIN_REGISTER,
  IPC_SEND_MESSAGE,
  IPC_SETTINGS_GET,
  IPC_SETTINGS_SET,
  IPC_THINK_WINDOW_HIDE,
  IPC_THINK_WINDOW_SHOW,
  IPC_TODO_ADD,
  IPC_TODO_DEL,
  IPC_TODO_GET,
  IPC_TODO_SHOW,
  IPC_TODO_TOGGLE,
  IPC_VOICE_CHECK,
  IPC_VOICE_MODELS,
  IPC_VOICE_STATUS,
  IPC_VOICE_TRANSCRIBE,
} from '../shared/contracts';
import type { AiModelListResult, AppSettings, AssetImportResult, AssetKind, AssetPresetResult, AssetScanResult, ChatLogEntry, ChatLogSnapshot, ChatWindowResult, ModelManifest, PluginManifest, VoiceCheckResult, VoiceModelIndexResult, VoiceStatusResult, VoiceTranscribeRequest, VoiceTranscribeResult } from '../shared/contracts';
import type { PathResolver } from './PathResolver';
import { fetchAvailableModels, loadAppSettings, saveAppSettings, TOOL_DEFS } from './ai/chatClient';
import { checkVoiceRoutes, indexVoiceModels, knownRoute, normalizeVoiceConfig, toBytes, transcribeAudio } from './ai/voice';
import type { VoiceRoute } from './ai/voice';
import {
  listUserModels,
  listUserPlugins,
  openAssetDir,
  applyDetectedCapabilities,
  PLUGIN_MANIFEST,
  readModelExpressionNames,
  readModelPresetFile,
  registerModelDir,
  registerPluginDir,
  unregisterModel,
  unregisterPlugin,
  userModelsDir,
  userPluginsDir,
  writeModelPresetTemplate,
} from './assets/userAssets';
import { inspectModelDir, describeCompat } from './assets/modelCompat';
import type { ChatClient } from './ai/chatClient';
import type { ToolBox } from './tools';

/** registry 最小结构接口（register 返回可同步可异步） */
export interface PluginRegistryLike {
  register(manifest: PluginManifest): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  tick(dtSeconds: number): void;
  /** 启动所有已注册插件（应用就绪后由 main 调用一次） */
  start?(): Promise<void>;
  /** 窗口切换事件转发给插件 */
  emitWindowChange?(info: unknown): void;
  emitUserInput?(text: string): void;
}

export interface IpcDeps {
  /** 当前主窗口提供者（activate 可能重建窗口，故每次现取） */
  getWindow: () => BrowserWindow | null;
  pathResolver: PathResolver;
  chat: ChatClient;
  registry: PluginRegistryLike;
  /** 本地静态服务 baseUrl 提供者（loadModel 拼模型 URL 用） */
  staticBaseUrl: () => string;
  /** 模型切换成功后的通知（main 侧据此重载离线台词池） */
  onModelChanged?: (modelName: string) => void;
  /** 聊天→本地工具（待办/提醒闹钟）；route 命中即回执、不调 AI */
  toolbox: ToolBox;
  /**
   * 打开/关闭独立聊天窗口（对话框在模型窗口外展开，不遮挡桌宠）。
   * 窗口归 main.ts 管理，这里只经依赖注入调用，避免 ipc.ts 反向依赖 main.ts。
   */
  openChatWindow?: () => Promise<ChatWindowResult>;
  closeChatWindow?: () => void;
  /** 显示/收起思考浮窗（提问时自动开、答完自动关，也供 ＋ 菜单手动调用） */
  showThinkWindow?: () => void;
  hideThinkWindow?: () => void;
  /** 真正要调用 AI 之前触发一次：主进程据此自动打开思考浮窗 */
  onChatStarted?: () => void;
}

export interface IpcBridge {
  /** 向主窗口 webContents 推送事件（频道与负载由调用方按契约给定） */
  pushToRenderer: (channel: string, payload: unknown) => void;
}

export function registerIpc(deps: IpcDeps): IpcBridge {
  const pushToRenderer = (channel: string, payload: unknown): void => {
    const win = deps.getWindow();
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  };

  // ---- IPC_LOAD_MODEL / IPC_MODEL_LIST -------------------------------------
  ipcMain.handle(IPC_LOAD_MODEL, (_event, name?: unknown): ModelManifest => {
    const manifest = buildModelManifest(deps, typeof name === 'string' ? name : undefined);
    // 同步当前宠物到 chat：切换模型 → 注入对应人设语料（knowledge/<模型名>.md）并清空旧上下文
    deps.chat.setActiveModel(manifest.name || null);
    deps.onModelChanged?.(manifest.name || 'character');
    return manifest;
  });

  ipcMain.handle(IPC_MODEL_LIST, (): string[] => deps.pathResolver.modelList());

  // ---- 聊天记录：会话模型（新对话 / 历史查看 / 清空）----
  interface ChatSession {
    id: string;
    startedAt: number;
    title: string;
    entries: ChatLogEntry[];
  }
  interface ChatLogFile {
    currentId: string;
    sessions: ChatSession[];
  }
  const MAX_SESSIONS = 20;
  const MAX_ENTRIES_PER_SESSION = 200;

  const chatLogPath = (): string => path.join(app.getPath('userData'), 'chat-log.json');
  const isChatEntry = (e: unknown): e is ChatLogEntry => {
    if (!e || typeof e !== 'object') return false;
    const row = e as { role?: unknown; text?: unknown; at?: unknown };
    return (
      (row.role === 'user' || row.role === 'pet' || row.role === 'tool' || row.role === 'error') &&
      typeof row.text === 'string' &&
      typeof row.at === 'number'
    );
  };
  const newSession = (): ChatSession => ({
    id: `s-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    startedAt: Date.now(),
    title: '新对话',
    entries: [],
  });
  const sanitizeEntries = (list: unknown): ChatLogEntry[] =>
    Array.isArray(list) ? list.filter(isChatEntry).map((e) => ({ ...e, text: e.text.slice(0, 4000) })).slice(-MAX_ENTRIES_PER_SESSION) : [];

  /** 读会话文件；旧格式（顶层数组）自动迁移成一个会话 */
  const readChatLogFile = (): ChatLogFile => {
    try {
      const file = chatLogPath();
      if (!fs.existsSync(file)) {
        const fresh: ChatLogFile = { currentId: '', sessions: [] };
        const first = newSession();
        fresh.currentId = first.id;
        fresh.sessions = [first];
        return fresh;
      }
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as unknown;
      // 旧格式：ChatLogEntry[]
      if (Array.isArray(parsed)) {
        const entries = sanitizeEntries(parsed);
        const migrated = newSession();
        migrated.entries = entries;
        const firstUser = entries.find((e) => e.role === 'user');
        if (firstUser) migrated.title = firstUser.text.slice(0, 24);
        const next: ChatLogFile = { currentId: migrated.id, sessions: [migrated] };
        writeChatLogFile(next);
        return next;
      }
      if (parsed && typeof parsed === 'object') {
        const file2 = parsed as { currentId?: unknown; sessions?: unknown };
        if (Array.isArray(file2.sessions)) {
          const sessions: ChatSession[] = file2.sessions
            .filter((s): s is ChatSession => !!s && typeof s === 'object' && typeof (s as ChatSession).id === 'string')
            .map((s) => ({
              id: s.id,
              startedAt: typeof s.startedAt === 'number' ? s.startedAt : Date.now(),
              title: typeof s.title === 'string' && s.title ? s.title : '新对话',
              entries: sanitizeEntries((s as ChatSession).entries),
            }))
            .slice(0, MAX_SESSIONS);
          const currentId = typeof file2.currentId === 'string' && sessions.some((s) => s.id === file2.currentId)
            ? file2.currentId
            : (sessions[0]?.id ?? '');
          if (sessions.length === 0) {
            const first = newSession();
            return { currentId: first.id, sessions: [first] };
          }
          return { currentId, sessions };
        }
      }
    } catch (err) {
      console.warn('[ipc] 读取聊天记录失败（当作空历史）：', (err as Error).message);
    }
    const fresh = newSession();
    return { currentId: fresh.id, sessions: [fresh] };
  };

  const writeChatLogFile = (data: ChatLogFile): void => {
    const file = chatLogPath();
    const tmp = `${file}.tmp`;
    const json = JSON.stringify(data, null, 2);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[ipc] 聊天记录原子写失败，回退直接写：', (err as Error).message);
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(file, json, 'utf8');
    }
  };

  const chatSnapshot = (data: ChatLogFile): ChatLogSnapshot => {
    const current = data.sessions.find((s) => s.id === data.currentId) ?? data.sessions[0];
    return {
      currentId: current?.id ?? '',
      entries: current?.entries ?? [],
      sessions: [...data.sessions]
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((s) => ({ id: s.id, startedAt: s.startedAt, title: s.title, count: s.entries.length })),
    };
  };

  ipcMain.handle(IPC_CHAT_LOG_GET, (): ChatLogSnapshot => chatSnapshot(readChatLogFile()));
  ipcMain.handle(IPC_CHAT_LOG_APPEND, (_event, raw: unknown): { ok: boolean } => {
    try {
      const row = (raw ?? {}) as { role?: unknown; text?: unknown; at?: unknown };
      if (!isChatEntry({ ...row, at: typeof row.at === 'number' ? row.at : Date.now() })) return { ok: false };
      const text = (row.text as string).slice(0, 4000);
      const entry: ChatLogEntry = {
        role: row.role as ChatLogEntry['role'],
        text,
        at: typeof row.at === 'number' && Number.isFinite(row.at) ? row.at : Date.now(),
      };
      const data = readChatLogFile();
      let current = data.sessions.find((s) => s.id === data.currentId);
      if (!current) {
        current = newSession();
        data.sessions.unshift(current);
        data.currentId = current.id;
      }
      current.entries = [...current.entries, entry].slice(-MAX_ENTRIES_PER_SESSION);
      if (current.title === '新对话' && entry.role === 'user') current.title = text.slice(0, 24) || '新对话';
      data.sessions = data.sessions.slice(0, MAX_SESSIONS);
      writeChatLogFile(data);
      return { ok: true };
    } catch (err) {
      console.warn('[ipc] 追加聊天记录失败：', (err as Error).message);
      return { ok: false };
    }
  });
  ipcMain.handle(IPC_CHAT_SESSION_NEW, (): ChatLogSnapshot => {
    const data = readChatLogFile();
    const created = newSession();
    data.sessions = [created, ...data.sessions].slice(0, MAX_SESSIONS);
    data.currentId = created.id;
    writeChatLogFile(data);
    return chatSnapshot(data);
  });
  ipcMain.handle(IPC_CHAT_SESSION_SELECT, (_event, raw: unknown): ChatLogSnapshot => {
    const data = readChatLogFile();
    const id = typeof raw === 'string' ? raw : '';
    if (id && data.sessions.some((s) => s.id === id)) {
      data.currentId = id;
      writeChatLogFile(data);
    }
    return chatSnapshot(data);
  });
  ipcMain.handle(IPC_CHAT_HISTORY_CLEAR, (): ChatLogSnapshot => {
    const created = newSession();
    const data: ChatLogFile = { currentId: created.id, sessions: [created] };
    writeChatLogFile(data);
    return chatSnapshot(data);
  });
  ipcMain.handle(IPC_CHAT_CONTEXT_RESET, (): { ok: boolean } => {
    try {
      deps.chat.resetContext();
      return { ok: true };
    } catch (err) {
      console.warn('[ipc] 清空上下文失败：', (err as Error).message);
      return { ok: false };
    }
  });

  // ---- 开发辅助：选择工作区文件夹 / 用系统方式打开目录 ----
  ipcMain.handle(IPC_PICK_FOLDER, async (): Promise<string> => {
    try {
      const win = deps.getWindow();
      const options = {
        properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
        title: '选择开发工作区文件夹',
      };
      const result = win && !win.isDestroyed()
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? '' : result.filePaths[0] ?? '';
    } catch (err) {
      console.warn('[ipc] 选择文件夹失败：', err);
      return '';
    }
  });

  ipcMain.handle(IPC_OPEN_PATH, async (_event, raw: unknown): Promise<string> => {
    const target = typeof raw === 'string' ? raw.trim() : '';
    if (!target) return '路径为空';
    try {
      const err = await shell.openPath(target); // 成功返回空字符串
      return err || '';
    } catch (err) {
      return (err as Error).message ?? String(err);
    }
  });

  ipcMain.handle(IPC_SETTINGS_GET, (): AppSettings => {
    const settings = loadAppSettings();
    // API Key 只在主进程使用；renderer 只需看到空值，避免通过页面脚本泄露密钥。
    return { ...settings, aiApiKey: undefined };
  });
  ipcMain.handle(
    IPC_SETTINGS_SET,
    (_event, raw: unknown): { ok: boolean; error?: string } => {
      const settings = sanitizeSettings(raw);
      if (!settings) return { ok: false, error: '设置格式无效' };
      try {
        const current = loadAppSettings();
        const next = settings.aiApiKey ? settings : { ...settings, aiApiKey: current.aiApiKey };
        saveAppSettings(next);
        deps.chat.updateSettings(next);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    }
  );

  // ---- IPC_SEND_MESSAGE -----------------------------------------------------
  ipcMain.handle(IPC_SEND_MESSAGE, (_event, text: unknown): { ok: boolean; error?: string } => {
    const message = typeof text === 'string' ? text.trim() : '';
    if (!message) return { ok: false, error: '消息为空' };

    const reply = (full: string): { ok: boolean } => {
      try {
        deps.getWindow()?.webContents.send(IPC_AI_DONE, { full });
      } catch {
        /* 窗口不可用忽略 */
      }
      return { ok: true };
    };

    // ---- 斜杠命令（本地处理，不调 LLM）----
    if (message.startsWith('/')) {
      const cmd = message.slice(1).trim().toLowerCase();
      switch (cmd) {
        case 'todo':
          try {
            deps.getWindow()?.webContents.send(IPC_TODO_SHOW, {});
          } catch {
            /* ignore */
          }
          return reply('已为你打开待办笔记本。');
        case 'notes':
          return reply(deps.toolbox.listNotes() || '当前没有笔记。');
        case 'skills':
          return reply(deps.chat.getSkillCatalog().trim() || '当前没有可用技能（可在 userData/skills 或 assets/skills 放入 .md 技能文件）。');
        case 'tools':
          return reply(`可用工具：\n${TOOL_DEFS.map((t) => `- ${(t.function as { name?: string }).name ?? ''}`).join('\n')}`);
        case 'reset':
          deps.chat.resetContext();
          return reply('已清空对话上下文。');
        case 'usage':
          return reply(deps.chat.getUsageStats());
        default:
          return reply(
            `未知命令：/${cmd}\n可用命令：\n/todo 打开待办面板\n/notes 列出笔记\n/skills 列出技能\n/tools 列出工具\n/reset 清空上下文\n/usage 用量统计`,
          );
      }
    }

    // 聊天打开“待办笔记本”面板（不经 AI、不经工具箱）
    if (/(打开|新建|显示|唤出).{0,6}(待办|清单|笔记本|记事本)/.test(message)) {
      try {
        deps.getWindow()?.webContents.send(IPC_TODO_SHOW, {});
      } catch {
        /* 窗口不可用忽略 */
      }
      // 与 /todo 一致：回一条确认气泡，避免用户发完消息后看不到任何回应
      return reply('已为你打开待办笔记本。');
    }

    deps.registry.emitUserInput?.(message);

    // 先走本地工具箱：命中（待办/提醒闹钟等）→ 直接气泡回执，不消耗外部 AI
    const toolReply = deps.toolbox.route(message);
    if (toolReply !== null) {
      deps.chat.noteExchange?.(message, toolReply);
      try {
        deps.getWindow()?.webContents.send(IPC_AI_DONE, { full: toolReply });
      } catch {
        /* 窗口暂不可用等场景忽略 */
      }
      return { ok: true };
    }

    // 真正要调用 AI 了：先让主进程把思考浮窗打开（用户提问 → 思考浮窗自动出现）
    try {
      deps.onChatStarted?.();
    } catch {
      /* 浮窗开关失败不影响对话本身 */
    }
    void deps.chat
      .startChat(message)
      .catch((err: unknown) => {
        // startChat 自身错误走 onError；此处兜底防御（正常不应触发）
        console.error('[ipc] startChat 意外异常', err);
      });
    return { ok: true }; // 流式结果经 IPC_AI_CHUNK/DONE/ERROR 推送
  });

  // ---- IPC_TODO_* 待办笔记本 ------------------------------------------------
  ipcMain.handle(IPC_TODO_GET, (): unknown => deps.toolbox.getTodos());
  ipcMain.handle(IPC_TODO_ADD, (_event, raw: unknown): unknown => {
    return deps.toolbox.addTodoRaw(typeof raw === 'string' ? raw : '');
  });
  ipcMain.handle(IPC_TODO_TOGGLE, (_event, raw: unknown): unknown => {
    const id = typeof raw === 'number' && Number.isFinite(raw) ? raw : -1;
    return deps.toolbox.toggleTodo(id);
  });
  ipcMain.handle(IPC_TODO_DEL, (_event, raw: unknown): unknown => {
    const id = typeof raw === 'number' && Number.isFinite(raw) ? raw : -1;
    return deps.toolbox.delTodo(id);
  });

  // ---- 独立聊天窗口（对话框在模型窗口外展开）--------------------------------
  // ---- 可插拔资产（模型 / 插件）：扫描 / 打开文件夹 / 加入 / 移除 ------------------
  ipcMain.handle(IPC_ASSET_SCAN, (): AssetScanResult => {
    const builtin = deps.pathResolver
      .modelList()
      .filter((n) => !listUserModels().some((m) => m.name === n));
    // 用户模型带上"预设摘要 + 预设问题"：设置页能一眼看到这个模型被怎么适配过、哪里写坏了
    const models = listUserModels().map((m) => {
      const { preset, issues } = deps.pathResolver.modelPreset(m.name);
      const found = readModelPresetFile(m.name, m.dir);
      // 手动把模型文件夹丢进 live2d-models 的情况：扫描时补做一次能力归类（幂等、只填空缺）
      if (!found.exists) {
        const applied = applyDetectedCapabilities(m.dir, m.name);
        if (!applied.ok) console.warn(`[ipc] 扫描时能力归类失败（${m.name}）：${applied.error}`);
      }
      const caps = preset.capabilities;
      const emotionCount = preset.emotionMap ? Object.keys(preset.emotionMap).length : 0;
      const parameterCount = preset.parameterMap ? Object.keys(preset.parameterMap).length : 0;
      return {
        ...m,
        ...(emotionCount || parameterCount || preset.framing || caps
          ? {
              preset: {
                framing: preset.framing,
                emotionCount,
                parameterCount,
                fromUserData: found.fromUserData,
                ...(caps
                  ? {
                      capabilities: {
                        click: caps.click?.length ?? 0,
                        costume: caps.costume?.length ?? 0,
                        emotion: caps.emotion ? Object.keys(caps.emotion).length : 0,
                        motions: caps.motions?.length ?? 0,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(issues.length ? { presetIssues: issues } : {}),
      };
    });
    return {
      models,
      plugins: listUserPlugins(),
      dirs: { model: userModelsDir(), plugin: userPluginsDir() },
      builtinModels: builtin,
    };
  });

  // ---- 模型预设（pet-model.json）：读 / 生成模板 / 打开 ------------------------
  ipcMain.handle(
    IPC_ASSET_PRESET,
    async (_event, rawAction: unknown, rawName: unknown): Promise<AssetPresetResult> => {
      const action = rawAction === 'template' || rawAction === 'open' || rawAction === 'detect' ? rawAction : 'get';
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name) return { ok: false, error: '模型名为空' };
      const modelDir = deps.pathResolver.modelDirAbs(name);
      const expressions = modelDir ? readModelExpressionNames(modelDir) : [];
      // 重新识别能力（设置页按钮；幂等，只填空缺，手改过的值不动）
      if (action === 'detect') {
        if (!modelDir) return { ok: false, error: `找不到模型目录：${name}`, expressions };
        const applied = applyDetectedCapabilities(modelDir, name);
        if (!applied.ok) return { ok: false, error: applied.error, expressions };
        const det = applied.detection;
        return {
          ok: true,
          path: applied.path,
          created: applied.created,
          changed: applied.changed,
          exists: true,
          fromUserData: false,
          expressions,
          ...(det ? { capabilities: det.capabilities, capabilityIssues: det.issues } : {}),
        };
      }
      if (action === 'get') {
        const found = readModelPresetFile(name, modelDir);
        const { preset, issues } = deps.pathResolver.modelPreset(name);
        return {
          ...(preset.capabilities ? { capabilities: preset.capabilities } : {}),
          ok: true,
          path: found.path ?? undefined,
          exists: found.exists,
          fromUserData: found.fromUserData,
          preset: Object.keys(preset).length ? preset : undefined,
          issues,
          expressions,
        };
      }
      const written = writeModelPresetTemplate(name, expressions);
      if (!written.ok) return { ok: false, error: written.error, expressions };
      if (action === 'template') {
        console.log(`[ipc] 模型预设模板：${name} → ${written.path}（${written.created ? '新建' : '已存在，未覆盖'}）`);
        return { ok: true, path: written.path, created: written.created, exists: true, fromUserData: true, expressions };
      }
      // open：用系统默认程序打开预设文件（记事本能直接改，改完切模型/重启生效）
      try {
        const openErr = await shell.openPath(written.path!);
        if (openErr) return { ok: false, error: openErr, path: written.path, expressions };
        return { ok: true, path: written.path, created: written.created, exists: true, fromUserData: true, expressions };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err), path: written.path, expressions };
      }
    }
  );

  ipcMain.handle(IPC_ASSET_OPEN_DIR, async (_event, raw: unknown): Promise<string> => {
    const kind: AssetKind = raw === 'plugin' ? 'plugin' : 'model';
    try {
      return await openAssetDir(kind);
    } catch (err) {
      return (err as Error).message ?? String(err);
    }
  });

  ipcMain.handle(IPC_ASSET_IMPORT, async (_event, raw: unknown): Promise<AssetImportResult> => {
    const kind: AssetKind = raw === 'plugin' ? 'plugin' : 'model';
    const picked = await dialog.showOpenDialog({
      title: kind === 'model' ? '选择 Live2D 模型文件夹' : '选择插件文件夹',
      properties: ['openDirectory'],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, kind, error: '已取消' };
    const dir = picked.filePaths[0];
    const res = kind === 'model' ? registerModelDir(dir) : registerPluginDir(dir);
    if (!res.ok) return { ok: false, kind, error: res.error };
    const entry = res.entry!;
    const issues = 'issues' in entry ? entry.issues : [];
    console.log(`[ipc] 已加入${kind === 'model' ? '模型' : '插件'}：${entry.name}（${dir}）问题 ${issues.length} 条`);
    return { ok: true, kind, name: entry.name, issues };
  });

  ipcMain.handle(
    IPC_ASSET_IMPORT_PATH,
    (_event, rawPath: unknown, rawKind: unknown): AssetImportResult => {
      // kind 缺省/为 'auto' 时按目录内容自行判断（拖放不需要用户先分类）
      const forced: AssetKind | null = rawKind === 'model' || rawKind === 'plugin' ? rawKind : null;
      const target = typeof rawPath === 'string' ? rawPath.trim() : '';
      if (!target) return { ok: false, kind: forced ?? 'model', error: '路径为空' };
      let dir = target;
      try {
        if (!fs.existsSync(dir)) return { ok: false, kind: forced ?? 'model', error: `路径不存在：${path.basename(dir)}` };
        if (!fs.statSync(dir).isDirectory()) {
          // 拖进来的是单个文件：模型/插件都必须是文件夹，给出可读原因而不是静默失败
          return {
            ok: false,
            kind: forced ?? 'model',
            error: '请拖入文件夹（模型或插件目录），而不是单个文件',
          };
        }
      } catch (err) {
        return { ok: false, kind: forced ?? 'model', error: (err as Error).message ?? String(err) };
      }
      // 自动判定：目录里有 .model3.json / .moc3 → 模型；有 pet-plugin.json → 插件
      let kind: AssetKind = forced ?? 'model';
      if (!forced) {
        try {
          const entries = fs.readdirSync(dir);
          const hasPlugin = entries.includes(PLUGIN_MANIFEST);
          const hasModel = entries.some((n) => /\.(model3\.json|model\.json|moc3|moc)$/i.test(n));
          if (hasPlugin && !hasModel) kind = 'plugin';
          else if (!hasModel && !hasPlugin) {
            const sub = entries.slice(0, 6).join('、');
            return {
              ok: false,
              kind: 'model',
              error: `这个文件夹既不像 Live2D 模型也不像插件（需要 .model3.json 或 ${PLUGIN_MANIFEST}）；里面是：${sub || '（空目录）'}`,
            };
          }
        } catch (err) {
          return { ok: false, kind, error: (err as Error).message ?? String(err) };
        }
      }
      const res = kind === 'model' ? registerModelDir(dir) : registerPluginDir(dir);
      if (!res.ok) return { ok: false, kind, error: res.error };
      const entry = res.entry!;
      const issues = 'issues' in entry ? entry.issues : [];
      console.log(`[ipc] 拖放加入${kind === 'model' ? '模型' : '插件'}：${entry.name}（${dir}）问题 ${issues.length} 条`);
      return { ok: true, kind, name: entry.name, issues };
    }
  );

  ipcMain.handle(
    IPC_ASSET_REMOVE,
    (_event, rawKind: unknown, rawName: unknown): { ok: boolean; error?: string; removedFiles?: boolean } => {
      const kind: AssetKind = rawKind === 'plugin' ? 'plugin' : 'model';
      const name = typeof rawName === 'string' ? rawName : '';
      if (!name) return { ok: false, error: '名字为空' };
      return kind === 'model' ? unregisterModel(name) : unregisterPlugin(name);
    }
  );

  // ---- 服务端可用模型列表（设置页的模型选择用）--------------------------------
  ipcMain.handle(IPC_AI_MODEL_LIST, async (): Promise<AiModelListResult> => {
    try {
      return await fetchAvailableModels();
    } catch (err) {
      return { ok: false, models: [], error: (err as Error).message ?? String(err) };
    }
  });

  // ---- 语音输入：录音 → 云端 ASR 转写 -----------------------------------------
  // 隐私：音频只在内存里过一手（渲染层 → IPC → HTTPS 转发），本进程不写盘、不缓存、不打印密钥。
  ipcMain.handle(IPC_VOICE_STATUS, (): VoiceStatusResult => {
    const voice = resolveVoiceConfig();
    const normalized = normalizeVoiceConfig({ baseUrl: voice.baseUrl, apiKey: voice.apiKey, model: voice.model });
    let endpoint = normalized.baseUrl;
    try {
      const u = new URL(normalized.baseUrl);
      endpoint = `${u.host}${u.pathname.replace(/\/+$/, '')}`; // 只留主机+路径，避免带出查询串里的任何凭据
    } catch {
      /* 地址不合法就原样展示（多半是用户还没填） */
    }
    const route = knownRoute(normalized.baseUrl, normalized.model ?? '') ?? (voice.route === 'auto' ? undefined : voice.route);
    return {
      configured: !!normalized.apiKey,
      model: normalized.model ?? '',
      endpoint,
      reuseAiConfig: voice.reuse,
      ...(route ? { route } : {}),
      ...(normalized.apiKey ? {} : { hint: '语音输入需要先在设置里填写 AI 接口地址与密钥' }),
    };
  });

  // 转写模型索引：按 API 地址拉 /models，挑出转写类候选并体检当前模型/路由
  // （地址里没有这个模型 / 没有转写类模型 / 拉不到列表 → 都给出可执行提示，不静默）
  ipcMain.handle(IPC_VOICE_MODELS, async (): Promise<VoiceModelIndexResult> => {
    const voice = resolveVoiceConfig();
    try {
      const res = await indexVoiceModels({ baseUrl: voice.baseUrl, apiKey: voice.apiKey, model: voice.model }, { route: voice.route });
      console.log(
        `[ipc] 转写模型索引：endpoint=${res.endpoint} ok=${res.ok} total=${res.total} 候选=${res.candidates.length} 当前=${res.current || '-'} verdict=${res.verdict}｜前几个候选：${res.candidates.slice(0, 6).join('、') || '-'}`,
      );
      return res;
    } catch (err) {
      return {
        ok: false,
        endpoint: voice.baseUrl,
        total: 0,
        candidates: [],
        current: voice.model ?? '',
        currentSupported: false,
        verdict: 'error',
        reason: `索引模型失败：${(err as Error).message ?? String(err)}`,
        action: '可以手填转写模型名，再点「🎙 自检语音识别」实测两条路由',
      };
    }
  });

  // 自检：用内置合成音频分别打两条路由（不依赖麦克风、不消耗用户录音）
  ipcMain.handle(IPC_VOICE_CHECK, async (): Promise<VoiceCheckResult> => {    const voice = resolveVoiceConfig();
    try {
      const res = await checkVoiceRoutes({ baseUrl: voice.baseUrl, apiKey: voice.apiKey, model: voice.model });
      console.log(`[ipc] 语音自检：model=${res.model} endpoint=${res.endpoint} ok=${res.ok} route=${res.route ?? '-'}`);
      return res;
    } catch (err) {
      return {
        ok: false,
        model: voice.model ?? '',
        endpoint: voice.baseUrl,
        reports: [],
        hint: `自检异常：${(err as Error).message ?? String(err)}`,
      };
    }
  });

  ipcMain.handle(
    IPC_VOICE_TRANSCRIBE,
    async (_event, raw: unknown): Promise<VoiceTranscribeResult> => {
      const req = (raw ?? {}) as Partial<VoiceTranscribeRequest>;
      const voice = resolveVoiceConfig();
      const bytes = toBytes(req.bytes as Uint8Array | ArrayBuffer);
      if (!bytes.length) return { ok: false, text: '', ms: 0, error: '没有收到音频数据' };
      return await transcribeAudio({
        baseUrl: voice.baseUrl,
        apiKey: voice.apiKey,
        model: voice.model,
        route: voice.route,
        bytes,
        mime: typeof req.mime === 'string' ? req.mime : undefined,
        language: typeof req.language === 'string' && req.language ? req.language : 'zh',
      });
    }
  );

  ipcMain.handle(IPC_CHAT_WINDOW_OPEN, async (): Promise<ChatWindowResult> => {
    if (!deps.openChatWindow) return { ok: false, error: '主进程未实现聊天窗口' };
    try {
      return await deps.openChatWindow();
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? String(err) };
    }
  });

  ipcMain.handle(IPC_CHAT_WINDOW_CLOSE, (): { ok: boolean } => {
    try {
      deps.closeChatWindow?.();
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  });

  // ---- 思考浮窗（提问时自动开、答完自动关；＋ 菜单可手动开关）------------------
  ipcMain.handle(IPC_THINK_WINDOW_SHOW, (): { ok: boolean } => {
    try {
      deps.showThinkWindow?.();
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_THINK_WINDOW_HIDE, (): { ok: boolean } => {
    try {
      deps.hideThinkWindow?.();
      return { ok: true };
    } catch (err) {
      return { ok: false };
    }
  });

  // ---- IPC_PLUGIN_REGISTER --------------------------------------------------
  ipcMain.handle(
    IPC_PLUGIN_REGISTER,
    async (_event, manifest: unknown): Promise<{ ok: boolean; error?: string }> => {
      const m = manifest as PluginManifest | null;
      if (!m || typeof m !== 'object' || typeof m.name !== 'string' || typeof m.version !== 'string' || typeof m.entry !== 'string') {
        return { ok: false, error: 'PluginManifest 非法：需含 name/entry 字符串' };
      }
      try {
        const result = await deps.registry.register(m);
        return typeof result === 'object' && result !== null
          ? { ok: Boolean(result.ok), error: typeof result.error === 'string' ? result.error : undefined }
          : { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message ?? String(err) };
      }
    }
  );

  return { pushToRenderer };
}

function sanitizeSettings(raw: unknown): AppSettings | null {
  if (!raw || typeof raw !== 'object') return null;
  const input = raw as Record<string, unknown>;
  const settings: AppSettings = {};
  const strings: Array<[keyof AppSettings, string]> = [
    ['aiBaseUrl', 'aiBaseUrl'],
    ['aiApiKey', 'aiApiKey'],
    ['aiModel', 'aiModel'],
    ['provider', 'provider'],
    ['azureApiVersion', 'azureApiVersion'],
  ];
  for (const [key, source] of strings) {
    if (input[source] !== undefined && typeof input[source] !== 'string') return null;
    if (typeof input[source] === 'string') {
      (settings as Record<string, string | number | undefined>)[key] = input[source].trim();
    }
  }
  const numbers: Array<[keyof AppSettings, string, number, number]> = [
    ['temperature', 'temperature', 0, 2],
    ['contextRounds', 'contextRounds', 0, 100],
    ['maxContextTokens', 'maxContextTokens', 256, 200000],
  ];
  for (const [key, source, min, max] of numbers) {
    const value = input[source];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return null;
    (settings as Record<string, string | number | undefined>)[key] = value;
  }
  if (input.confirmTools !== undefined) {
    if (typeof input.confirmTools !== 'boolean') return null;
    settings.confirmTools = input.confirmTools;
  }
  if (input.showThinking !== undefined) {
    if (typeof input.showThinking !== 'boolean') return null;
    settings.showThinking = input.showThinking;
  }
  // 音效：开关必须是布尔；音量做 0~1 夹取（滑杆浮点误差不应导致整次保存失败）
  if (input.sfxEnabled !== undefined) {
    if (typeof input.sfxEnabled !== 'boolean') return null;
    settings.sfxEnabled = input.sfxEnabled;
  }
  if (input.sfxVolume !== undefined) {
    const volume = input.sfxVolume;
    if (typeof volume !== 'number' || !Number.isFinite(volume)) return null;
    settings.sfxVolume = Math.max(0, Math.min(1, volume));
  }
  // 开发工作区：非空时必须是绝对路径（工具层还会再做一次根目录内校验）
  // Windows：盘符带分隔符 (C:\) 或 UNC (\\server\share)；类 Unix：以 / 开头。
  // 注意不能用 path.isAbsolute 代替：Windows 上 'C:foo'（盘符相对）也会被判为绝对，那是个陷阱路径。
  if (input.devWorkspaceRoot !== undefined) {
    if (typeof input.devWorkspaceRoot !== 'string') return null;
    const root = input.devWorkspaceRoot.trim();
    const isWinAbs = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith('\\\\');
    const isPosixAbs = root.startsWith('/');
    if (root && !isWinAbs && !isPosixAbs) return null;
    settings.devWorkspaceRoot = root;
  }
  if (input.allowShell !== undefined) {
    if (typeof input.allowShell !== 'boolean') return null;
    settings.allowShell = input.allowShell;
  }
  // 权限模式：只接受三个取值，其它一律拒绝保存
  if (input.permissionMode !== undefined) {
    const mode = input.permissionMode;
    if (mode !== 'ask' && mode !== 'auto-edit' && mode !== 'plan-only') return null;
    settings.permissionMode = mode;
  }
  // 取景：全身 / 半身
  if (input.displayMode !== undefined) {
    const mode = input.displayMode;
    if (mode !== 'full' && mode !== 'half') return null;
    settings.displayMode = mode;
  }
  // 全屏自动收起（布尔）
  if (input.hideOnFullscreen !== undefined) {
    if (typeof input.hideOnFullscreen !== 'boolean') return null;
    settings.hideOnFullscreen = input.hideOnFullscreen;
  }
  // 点击穿透（布尔；默认关闭）
  if (input.clickThrough !== undefined) {
    if (typeof input.clickThrough !== 'boolean') return null;
    settings.clickThrough = input.clickThrough;
  }
  // 语音识别：模型 / 路由 / 单独网关（都与聊天配置解耦，留空则复用聊天配置）
  if (input.voiceModel !== undefined) {
    if (typeof input.voiceModel !== 'string') return null;
    if (input.voiceModel.length > 120) return null;
    settings.voiceModel = input.voiceModel.trim();
  }
  if (input.voiceRoute !== undefined) {
    const route = input.voiceRoute;
    if (route !== 'auto' && route !== 'chat-audio' && route !== 'transcriptions') return null;
    settings.voiceRoute = route;
  }
  if (input.voiceBaseUrl !== undefined) {
    if (typeof input.voiceBaseUrl !== 'string') return null;
    const url = input.voiceBaseUrl.trim();
    // 与 aiBaseUrl 同样的宽松校验：允许 http(s)、局域网 IP、MCP/自建网关常见的裸路径
    if (url && !/^https?:\/\//i.test(url) && !/^[a-z0-9.-]+(:\d+)?(\/|$)/i.test(url)) return null;
    settings.voiceBaseUrl = url;
  }
  if (input.voiceApiKey !== undefined) {
    if (typeof input.voiceApiKey !== 'string') return null;
    if (input.voiceApiKey.length > 300) return null;
    settings.voiceApiKey = input.voiceApiKey.trim();
  }
  // 邮箱 IMAP（mail_check 用）。这几个字段必须在**写入侧**也接住：
  // 用户可能直接编辑 settings.json 填好，之后随便在设置界面点一次保存——
  // 若这里不认这些键，那次保存就会把 IMAP 配置整段抹掉。
  if (input.mailImapHost !== undefined) {
    if (typeof input.mailImapHost !== 'string') return null;
    const host = input.mailImapHost.trim();
    // 只要主机名/IP，不要协议前缀或路径（这是 IMAP 主机，不是 URL）
    if (host && !/^[a-z0-9.-]+$/i.test(host)) return null;
    if (host.length > 200) return null;
    settings.mailImapHost = host;
  }
  if (input.mailImapPort !== undefined) {
    if (typeof input.mailImapPort !== 'number' || !Number.isInteger(input.mailImapPort)) return null;
    if (input.mailImapPort < 1 || input.mailImapPort > 65535) return null;
    settings.mailImapPort = input.mailImapPort;
  }
  if (input.mailImapUser !== undefined) {
    if (typeof input.mailImapUser !== 'string') return null;
    if (input.mailImapUser.length > 200) return null;
    settings.mailImapUser = input.mailImapUser.trim();
  }
  if (input.mailImapPass !== undefined) {
    if (typeof input.mailImapPass !== 'string') return null;
    if (input.mailImapPass.length > 300) return null;
    // 不去 trim 以外的加工：授权码里可能有空格，但首尾空白一定是误输
    settings.mailImapPass = input.mailImapPass.trim();
  }
  // 桌宠窗口位置/尺寸：整数、范围宽松夹取（不合法就整体拒绝保存，与其它字段一致）。
  // 范围只防明显的脏值；"是否在可见显示器内"由 mainImpl 在恢复时判断。
  const geometry: Array<[keyof AppSettings, string, number, number]> = [
    ['petX', 'petX', -100000, 100000],
    ['petY', 'petY', -100000, 100000],
    ['petW', 'petW', 120, 4000],
    ['petH', 'petH', 120, 4000],
  ];
  for (const [key, source, min, max] of geometry) {
    const value = input[source];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    (settings as Record<string, number | undefined>)[key as string] = Math.round(Math.max(min, Math.min(max, value)));
  }
  return settings;
}

/**
 * 解析"语音识别"这一路实际要用的地址/密钥/模型：
 * 优先用语音专用配置（voiceBaseUrl/voiceApiKey），留空则复用聊天用的 AI 配置。
 * 为什么允许单独配：有些网关（例如百炼**工作区**域名）只做聊天、没有语音转写接口，
 * 或者用户的聊天密钥没有 ASR 权限——这时单独指一个能转写的地址就行。
 */
function resolveVoiceConfig(): {
  baseUrl: string;
  apiKey: string;
  model?: string;
  route: VoiceRoute;
  reuse: boolean;
} {
  const cfg = loadAppSettings();
  const voiceBase = (cfg.voiceBaseUrl ?? '').trim();
  const voiceKey = (cfg.voiceApiKey ?? '').trim();
  const reuse = !voiceBase && !voiceKey;
  return {
    baseUrl: voiceBase || (cfg.aiBaseUrl ?? ''),
    apiKey: voiceKey || (cfg.aiApiKey ?? ''),
    model: (cfg.voiceModel ?? '').trim() || undefined,
    route: cfg.voiceRoute === 'transcriptions' || cfg.voiceRoute === 'chat-audio' ? cfg.voiceRoute : 'auto',
    reuse,
  };
}

/** 组装 ModelManifest：默认取模型列表第一项（main 启动即加载默认模型的语义出口） */function buildModelManifest(deps: IpcDeps, requested?: string): ModelManifest {
  const resolver = deps.pathResolver;
  // renderer 可能传空字符串表示"取默认第一项"：空串/空白必须走默认兜底（不能用 ??，它不兜底 ''）
  const requestedName = typeof requested === 'string' && requested.trim() ? requested.trim() : '';
  const name = requestedName || resolver.modelList()[0] || '';
  if (!name) {
    console.warn('[ipc] IPC_LOAD_MODEL 无可加载模型（assets/models.json 与目录扫描均为空）');
    return { name: '', url: '', type: 'moc3', model3Path: '' };
  }
  const desc = resolver.modelDescriptor(name);
  if (!desc) {
    console.warn(`[ipc] 模型 "${name}" 缺少主资源文件（.model3.json 或图片），URL 置空`);
    return { name, url: '', type: 'moc3', model3Path: '' };
  }
  // URL 各段 encodeURIComponent（中文/空格文件名安全）；file 内部用正斜杠。
  // base：随包模型走 assets/，用户自己加的走 user-models/（静态服务额外挂载点，不进包）
  const encoded = [desc.base ?? 'assets', encodeURIComponent(desc.name)]
    .concat(desc.file.split('/').map((seg) => encodeURIComponent(seg)))
    .join('/');
  // 可选的模型级预设（pet-model.json）：读不到就是空，读坏了只报 issues（不阻断加载）
  let preset: ModelManifest['preset'];
  let presetIssues: string[] | undefined;
  try {
    const found = resolver.modelPreset(desc.name);
    preset = Object.keys(found.preset).length ? found.preset : undefined;
    presetIssues = found.issues.length ? found.issues : undefined;
    if (presetIssues) console.warn(`[ipc] 模型 "${desc.name}" 预设有问题：${presetIssues.join('；')}`);
  } catch (err) {
    presetIssues = [`pet-model.json 读取失败：${(err as Error).message.slice(0, 80)}`];
  }
  // 模型体检（普适适配）：不管模型来自随包还是用户目录，都给一句"能不能渲染 + 为什么 + 怎么办"。
  // 不 ok 的时候同时打日志——出问题时启动日志里就有原因，不用猜。
  let compat: ModelManifest['compat'];
  try {
    const dirAbs = resolver.modelDirAbs(desc.name);
    if (dirAbs) {
      compat = inspectModelDir(dirAbs, desc.name);
      if (compat.verdict !== 'ok') {
        console.warn(`[ipc] ${describeCompat(desc.name, compat)}${compat.action ? `；怎么办：${compat.action}` : ''}`);
      }
    }
  } catch (err) {
    console.warn(`[ipc] 模型体检失败（${desc.name}）：${(err as Error).message}`);
  }
  return {
    name: desc.name,
    url: `${deps.staticBaseUrl()}/${encoded}`,
    type: desc.type,
    model3Path: `${desc.base ?? 'assets'}/${desc.name}/${desc.file.split('/').map((s) => encodeURIComponent(s)).join('/')}`,
    mocVersion: desc.type === 'moc3' ? resolver.modelMocVersion(desc.name) ?? undefined : undefined,
    // 体检结果随 manifest 一起下发：渲染层据此决定"直接提示原因"还是"硬着头皮加载"。
    // 随包模型也要体检（用户可能只是没把用户模型放进来），所以这里按模型目录统一走一遍。
    ...(compat ? { compat } : {}),
    ...(preset ? { preset } : {}),
    ...(presetIssues ? { presetIssues } : {}),
  };
}
