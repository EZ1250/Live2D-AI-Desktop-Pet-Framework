/** MCP 客户端：通过 stdio 或 HTTP 接入外部工具。 */
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as https from 'https';

export interface McpToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface McpServerConfig {
  serverName: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  autoApprove?: boolean;
}

type ServerState = 'idle' | 'connecting' | 'ready' | 'error';

interface ToolRoute {
  serverName: string;
  rawName: string;
  publicName: string;
  /** 服务端声明的只读标注（后台自主任务只允许只读工具） */
  readOnly: boolean;
}

interface ServerRuntime {
  cfg: McpServerConfig;
  state: ServerState;
  lastError: string;
  tools: Array<{ rawName: string; publicName: string }>;
  toolDefs: Map<string, McpToolDef>;
  toolsBacklog: Array<{
    rawName: string;
    description: string;
    inputSchema: unknown;
    annotations?: { readOnlyHint?: boolean };
  }>;
  child: ChildProcess | null;
  sessionId: string;
  buffer: string;
  stderrTail: string;
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>;
  syncInFlight: Promise<void> | null;
}

const TOOL_PREFIX = 'mcp__';
const MAX_TOOL_NAME = 64;
const MAX_TOOLS_PER_SERVER = 60;
const MAX_TOOLS_TOTAL = 120;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const MAX_RESULT_CHARS = 4000;
const PROTOCOL_VERSION = '2025-06-18';
const SECRET_ENV_RE = /KEY|PASSWORD|SECRET|TOKEN/i;

/** config → 服务器配置；非法条目跳过（返回错误列表便于日志） */
export function parseMcpConfig(raw: unknown): { servers: McpServerConfig[]; errors: string[] } {
  const errors: string[] = [];
  const out: McpServerConfig[] = [];
  const serversRaw = (raw as { servers?: unknown } | null)?.servers;
  if (!Array.isArray(serversRaw)) {
    if (raw != null) errors.push('mcp.json 缺少 servers 数组');
    return { servers: out, errors };
  }
  const seen = new Set<string>();
  for (const item of serversRaw) {
    const obj = item as Record<string, unknown> | null;
    if (!obj || typeof obj !== 'object') {
      errors.push('跳过非对象服务器配置');
      continue;
    }
    const serverName = typeof obj.serverName === 'string' ? obj.serverName.trim() : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(serverName)) {
      errors.push(`serverName 非法（1~32 位字母/数字/_/-）：${serverName || '(空)'}`);
      continue;
    }
    if (seen.has(serverName)) {
      errors.push(`serverName 重复：${serverName}`);
      continue;
    }
    const transport = obj.transport;
    if (transport !== 'stdio' && transport !== 'http') {
      errors.push(`${serverName}: transport 必须是 stdio 或 http`);
      continue;
    }
    const cfg: McpServerConfig = { serverName, transport };
    if (transport === 'stdio') {
      if (typeof obj.command !== 'string' || !obj.command.trim()) {
        errors.push(`${serverName}: stdio 需要 command`);
        continue;
      }
      cfg.command = obj.command.trim();
      if (Array.isArray(obj.args)) cfg.args = obj.args.filter((a): a is string => typeof a === 'string');
      if (typeof obj.cwd === 'string' && obj.cwd.trim()) cfg.cwd = obj.cwd.trim();
      if (obj.env && typeof obj.env === 'object') {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
          if (typeof v === 'string') env[k] = v;
        }
        cfg.env = env;
      }
    } else {
      if (typeof obj.url !== 'string' || !/^https?:\/\//i.test(obj.url)) {
        errors.push(`${serverName}: http 需要 http(s) url`);
        continue;
      }
      cfg.url = obj.url.trim();
      if (obj.headers && typeof obj.headers === 'object') {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj.headers as Record<string, unknown>)) {
          if (typeof v === 'string') headers[k] = v;
        }
        cfg.headers = headers;
      }
    }
    if (typeof obj.toolCallTimeoutMs === 'number' && Number.isFinite(obj.toolCallTimeoutMs)) {
      const ms = Math.round(obj.toolCallTimeoutMs);
      if (ms >= 1000 && ms <= 600_000) cfg.toolCallTimeoutMs = ms;
      else errors.push(`${serverName}: toolCallTimeoutMs 超出 1000~600000，用默认值`);
    }
    if (typeof obj.autoApprove === 'boolean') cfg.autoApprove = obj.autoApprove;
    seen.add(serverName);
    out.push(cfg);
  }
  return { servers: out, errors };
}

/** 配置里的 ${env:NAME} 占位符换成进程环境变量（找不到就空串） */
export function resolveEnvPlaceholders(value: string): string {
  return value.replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name: string) => process.env[name] ?? '');
}

/** 清洗 stdio 子进程环境：去掉名字像密钥的变量，再合并显式配置 */
export function scrubServerEnv(parent: NodeJS.ProcessEnv, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (SECRET_ENV_RE.test(k)) continue;
    env[k] = v;
  }
  for (const [k, v] of Object.entries(extra ?? {})) env[k] = resolveEnvPlaceholders(v);
  return env;
}

/**
 * Windows 上 npx / npm 这类命令实际是 .cmd/.bat，直接 spawn 会 ENOENT；
 * 这里按 PATH+PATHEXT 解析成绝对路径，.cmd/.bat 再包一层 cmd.exe 执行。
 */
export function resolveStdioSpawn(command: string, args: string[]): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command, args };
  const quote = (v: string): string => (/[\s"&|<>^]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const wrapForCmd = (full: string): { command: string; args: string[] } => {
    if (!/\.(cmd|bat)$/i.test(full)) return { command: full, args };
    const line = [quote(full), ...args.map(quote)].join(' ');
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', line] };
  };
  const extsOf = (): string[] => (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (process.env.PATH || '').split(';').filter(Boolean);
  const names = /\.(exe|com|cmd|bat)$/i.test(command) ? [command] : extsOf().map((ext) => `${command}${ext.toLowerCase()}`);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.statSync(full).isFile()) return wrapForCmd(full);
      } catch {
        /* 继续找下一个 */
      }
    }
  }
  return { command, args };
}

/** OpenAI function 名约定：publicName = mcp__<server>__<tool>，超长截断 + 哈希，保证可回到原始名 */
export function makePublicToolName(serverName: string, rawName: string): string {
  const clean = rawName.replace(/[^A-Za-z0-9_-]/g, '_');
  const base = `${TOOL_PREFIX}${serverName}__${clean}`;
  if (base.length <= MAX_TOOL_NAME) return base;
  const hash = crypto.createHash('sha256').update(`${serverName}\u0000${rawName}`).digest('hex').slice(0, 8);
  return `${base.slice(0, MAX_TOOL_NAME - 9)}_${hash}`;
}

/** MCP tools/call 的 content 数组 → 纯文本（图片/资源给可读占位），错误明确标注 */
export function formatCallResult(result: unknown, isError: boolean): string {
  const obj = (result ?? {}) as { content?: unknown; structuredContent?: unknown };
  const parts: string[] = [];
  const content = Array.isArray(obj.content) ? obj.content : [];
  for (const block of content) {
    const b = (block ?? {}) as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : '';
    if (type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (type === 'image') parts.push(`[图片 ${typeof b.mimeType === 'string' ? b.mimeType : ''}]`);
    else if (type === 'audio') parts.push(`[音频 ${typeof b.mimeType === 'string' ? b.mimeType : ''}]`);
    else if (type === 'resource_link') {
      const name = typeof b.name === 'string' ? b.name : '资源';
      const uri = typeof b.uri === 'string' ? b.uri : '';
      parts.push(`[资源链接 ${name}${uri ? ` ${uri}` : ''}]`);
    } else if (type === 'resource') {
      const res = (b.resource ?? {}) as Record<string, unknown>;
      const uri = typeof res.uri === 'string' ? res.uri : '';
      const text = typeof res.text === 'string' ? res.text : '';
      parts.push(text ? text : `[嵌入资源 ${uri}]`);
    }
  }
  if (parts.length === 0 && obj.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(obj.structuredContent));
    } catch {
      parts.push('[结构化结果无法序列化]');
    }
  }
  let text = parts.join('\n').trim() || '(工具没有返回内容)';
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n…（结果已截断）`;
  return isError ? `MCP 工具返回错误：${text}` : text;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export class McpClient {
  private runtimes = new Map<string, ServerRuntime>();
  private routes = new Map<string, ToolRoute>();
  private disposed = false;
  private connecting: Promise<void> | null = null;
  private reloading: Promise<void> | null = null;

  constructor(
    private readonly opts: {
      configPath: string;
      clientVersion?: string;
      log?: (message: string) => void;
      /** 工具集变化（首次连上 / list_changed）时回调，让 ChatClient 重新取工具定义 */
      onToolsChanged?: () => void;
    },
  ) {}

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** 读配置并连接全部服务器（后台调用，不阻塞启动；重复调用只连一次） */
  connectAll(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      let raw: unknown = null;
      try {
        if (!fs.existsSync(this.opts.configPath)) {
          this.log('MCP：未配置（mcp.json 不存在），跳过');
          return;
        }
        const text = fs.readFileSync(this.opts.configPath, 'utf8').replace(/^\uFEFF/, '');
        raw = JSON.parse(text);
      } catch (err) {
        this.log(`MCP：mcp.json 读取/解析失败（${(err as Error).message}），跳过`);
        return;
      }
      const { servers, errors } = parseMcpConfig(raw);
      for (const e of errors) this.log(`MCP 配置错误：${e}`);
      if (servers.length === 0) {
        this.log('MCP：没有可用的服务器配置');
        return;
      }
      await Promise.all(
        servers.map(async (cfg) => {
          const rt: ServerRuntime = {
            cfg,
            state: 'idle',
            lastError: '',
            tools: [],
            toolDefs: new Map<string, McpToolDef>(),
            toolsBacklog: [],
            child: null,
            sessionId: '',
            buffer: '',
            stderrTail: '',
            nextId: 1,
            pending: new Map(),
            syncInFlight: null,
          };
          this.runtimes.set(cfg.serverName, rt);
          await this.connectServer(rt);
        }),
      );
      this.rebuildRoutes();
      const ready = [...this.runtimes.values()].filter((r) => r.state === 'ready');
      this.log(
        `MCP：${ready.length}/${this.runtimes.size} 个服务器已连接，工具 ${this.routes.size} 个` +
          (ready.length ? `（${ready.map((r) => r.cfg.serverName).join(', ')}）` : ''),
      );
    })().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  /** 当前可用工具定义（OpenAI function 格式）；由 ChatClient 每轮取最新 */
  toolDefs(): McpToolDef[] {
    const defs: McpToolDef[] = [];
    for (const rt of this.runtimes.values()) {
      if (rt.state !== 'ready') continue;
      for (const t of rt.tools) {
        const def = rt.toolDefs.get(t.publicName);
        if (def) defs.push(def);
        if (defs.length >= MAX_TOOLS_TOTAL) return defs;
      }
    }
    return defs;
  }

  /** 非配置来源的调用一律拒绝（模型看见的名字都必须是已注册的） */
  isMcpTool(name: string): boolean {
    return name.startsWith(TOOL_PREFIX);
  }

  /** 公开名 → 服务名/原始工具名（确认框展示用）；未注册返回 null */
  describeTool(name: string): { server: string; tool: string } | null {
    const route = this.routes.get(name);
    return route ? { server: route.serverName, tool: route.rawName } : null;
  }

  /** 该服务器是否显式配置了 autoApprove（免确认） */
  isAutoApprove(name: string): boolean {
    const route = this.routes.get(name);
    if (!route) return false;
    return this.runtimes.get(route.serverName)?.cfg.autoApprove === true;
  }

  /**
   * 后台自主任务允许调用的工具：服务器显式 autoApprove **且** 工具声明 readOnlyHint。
   * 两个条件缺一不可——服务端可信 + 工具本身无副作用。
   */
  isAutoApprovedReadOnly(name: string): boolean {
    const route = this.routes.get(name);
    if (!route || route.readOnly !== true) return false;
    return this.runtimes.get(route.serverName)?.cfg.autoApprove === true;
  }

  /** 调用一个 MCP 工具；返回给模型的文本（失败也走文本，错误带前缀） */
  async callTool(name: string, args: unknown): Promise<string> {
    const route = this.routes.get(name);
    if (!route) return `未知 MCP 工具：${name}（服务可能已断开或配置已变化）`;
    const rt = this.runtimes.get(route.serverName);
    if (!rt) return `MCP 服务器不存在：${route.serverName}`;
    if (this.disposed) return 'MCP 客户端已关闭。';
    const argumentsObj = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
    const timeoutMs = rt.cfg.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    const attempt = async (): Promise<unknown> => {
      if (rt.state !== 'ready') {
        await this.connectServer(rt);
      }
      return await this.request(rt, 'tools/call', { name: route.rawName, arguments: argumentsObj }, timeoutMs);
    };
    let lastErr: Error | null = null;
    for (let i = 0; i < 2; i++) {
      try {
        const result = (await attempt()) as { isError?: boolean };
        return formatCallResult(result, result?.isError === true);
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (i === 0 && !this.disposed) {
          this.log(`MCP：${route.serverName} 调用失败，重连后重试一次（${lastErr.message}）`);
          this.closeServer(rt);
          rt.state = 'idle';
        }
      }
    }
    return `MCP 工具执行失败：${lastErr?.message ?? '未知错误'}`;
  }

  /** /mcp 命令用的状态文本（不含任何 token/header/env 内容） */
  statusText(): string {
    if (this.runtimes.size === 0) {
      return `外部工具（mcp.json）：未配置\n※ 这是「桌宠调用外部 MCP 工具」方向，可选；不配置不影响反向接入和其他功能。\n配置文件：${this.opts.configPath}\n格式见 docs/PROJECT_LAYOUT.md §7.7`;
    }
    const lines: string[] = [`外部工具（mcp.json）：${this.runtimes.size} 个服务`];
    for (const rt of this.runtimes.values()) {
      const state = rt.state === 'ready' ? '已连接' : rt.state === 'connecting' ? '连接中' : rt.state === 'error' ? '连接失败' : '未连接';
      const auto = rt.cfg.autoApprove ? '，免确认' : '，需确认';
      const names = rt.tools.slice(0, 8).map((t) => t.publicName).join(', ') + (rt.tools.length > 8 ? ', …' : '');
      lines.push(`- ${rt.cfg.serverName}（${rt.cfg.transport}）：${state}，工具 ${rt.tools.length} 个${auto}` + (names ? `
  可用：${names}` : ''));
      if (rt.state === 'error' && rt.lastError) lines.push(`  错误：${rt.lastError.slice(0, 160)}`);
    }
    return lines.join('\n');
  }

  /** 退出前清理：杀掉 stdio 子进程、清空挂起请求 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const rt of this.runtimes.values()) {
      this.closeServer(rt);
      for (const p of rt.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP 客户端已关闭'));
      }
      rt.pending.clear();
    }
    this.routes.clear();
  }

  /** 热重载 mcp.json：断开现有连接/子进程，按当前配置重新连接（/mcp reload 用） */
  async reload(): Promise<void> {
    if (this.reloading) return this.reloading;
    this.reloading = (async () => {
      const currentConnection = this.connecting;
      if (currentConnection) await currentConnection.catch(() => undefined);
      for (const rt of this.runtimes.values()) {
        this.closeServer(rt);
        this.rejectAll(rt, new Error('MCP 客户端重载中'));
      }
      this.runtimes.clear();
      this.routes.clear();
      this.connecting = null;
      this.disposed = false;
      await this.connectAll();
    })().finally(() => {
      this.reloading = null;
    });
    return this.reloading;
  }

  // ------------------------------------------------------------------ private

  private rebuildRoutes(): void {
    this.routes.clear();
    let total = 0;
    for (const rt of this.runtimes.values()) {
      if (rt.state !== 'ready') continue;
      rt.toolDefs.clear();
      rt.tools = [];
      for (const tool of rt.toolsBacklog) {
        if (rt.tools.length >= MAX_TOOLS_PER_SERVER || total >= MAX_TOOLS_TOTAL) break;
        const publicName = makePublicToolName(rt.cfg.serverName, tool.rawName);
        if (this.routes.has(publicName)) continue;
        const desc = `${tool.description || '（无描述）'}（MCP 服务 ${rt.cfg.serverName}）`;
        rt.toolDefs.set(publicName, {
          type: 'function',
          function: {
            name: publicName,
            description: desc.length > 500 ? `${desc.slice(0, 500)}…` : desc,
            parameters:
              tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema)
                ? (tool.inputSchema as Record<string, unknown>)
                : { type: 'object', properties: {} },
          },
        });
        rt.tools.push({ rawName: tool.rawName, publicName });
        this.routes.set(publicName, {
          serverName: rt.cfg.serverName,
          rawName: tool.rawName,
          publicName,
          readOnly: tool.annotations?.readOnlyHint === true,
        });
        total++;
      }
    }
    this.log(`MCP：工具路由更新，共 ${this.routes.size} 个`);
    try {
      this.opts.onToolsChanged?.();
    } catch {
      /* 回调失败不影响 MCP 自身 */
    }
  }

  private async connectServer(rt: ServerRuntime): Promise<void> {
    if (this.disposed || rt.state === 'ready' || rt.state === 'connecting') return;
    rt.state = 'connecting';
    rt.lastError = '';
    try {
      if (rt.cfg.transport === 'stdio') this.startChild(rt);
      await this.request(rt, 'initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'pet-desktop-app', version: this.opts.clientVersion || '1.0.0' },
      });
      this.notify(rt, 'notifications/initialized', {});
      await this.syncTools(rt);
      rt.state = 'ready';
      this.log(`MCP：${rt.cfg.serverName} 已连接（${rt.tools.length} 个工具）`);
    } catch (err) {
      rt.state = 'error';
      rt.lastError = (err as Error).message;
      this.log(`MCP：${rt.cfg.serverName} 连接失败：${rt.lastError}`);
      this.closeServer(rt);
    }
  }

  private async syncTools(rt: ServerRuntime): Promise<void> {
    if (rt.syncInFlight) return rt.syncInFlight;
    rt.syncInFlight = (async () => {
      const collected: Array<{
        rawName: string;
        description: string;
        inputSchema: unknown;
        annotations?: { readOnlyHint?: boolean };
      }> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 20; page++) {
        const result = (await this.request(rt, 'tools/list', cursor ? { cursor } : {})) as {
          tools?: Array<{
          name?: string;
          description?: string;
          inputSchema?: unknown;
          annotations?: { readOnlyHint?: boolean };
        }>;
          nextCursor?: string;
        };
        for (const t of Array.isArray(result?.tools) ? result.tools : []) {
          const rawName = typeof t?.name === 'string' ? t.name : '';
          if (!rawName) continue;
          collected.push({
            rawName,
            description: typeof t.description === 'string' ? t.description : '',
            inputSchema: t.inputSchema,
            annotations: t.annotations,
          });
          if (collected.length >= MAX_TOOLS_PER_SERVER) break;
        }
        const next = typeof result?.nextCursor === 'string' ? result.nextCursor : '';
        if (!next || collected.length >= MAX_TOOLS_PER_SERVER) break;
        cursor = next;
      }
      // 整批替换：先收集完整清单，再统一重建公开名/路由（与参考实现"要么完整世代、要么没有"一致）
      rt.toolsBacklog = collected;
      rt.tools = collected.map((t) => ({ rawName: t.rawName, publicName: makePublicToolName(rt.cfg.serverName, t.rawName) }));
      if (rt.state === 'ready') this.rebuildRoutes();
    })().finally(() => {
      rt.syncInFlight = null;
    });
    return rt.syncInFlight;
  }

  private startChild(rt: ServerRuntime): void {
    const env = scrubServerEnv(process.env, rt.cfg.env);
    const target = resolveStdioSpawn(rt.cfg.command as string, rt.cfg.args ?? []);
    const child = spawn(target.command, target.args, {
      cwd: rt.cfg.cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    rt.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => this.onStdout(rt, chunk));
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      rt.stderrTail = (rt.stderrTail + chunk).slice(-500);
    });
    child.on('error', (err) => {
      rt.state = 'error';
      rt.lastError = `spawn 失败：${err.message}`;
      this.rejectAll(rt, new Error(rt.lastError));
    });
    child.on('exit', (code) => {
      if (rt.state === 'ready') {
        rt.state = 'error';
        rt.lastError = `子进程退出（code=${code ?? 'null'}）${rt.stderrTail ? `：${rt.stderrTail.trim().slice(0, 200)}` : ''}`;
        this.log(`MCP：${rt.cfg.serverName} 子进程退出（code=${code ?? 'null'}）`);
      }
      rt.child = null;
      this.rejectAll(rt, new Error(rt.lastError || 'MCP 子进程已退出'));
    });
  }

  private closeServer(rt: ServerRuntime): void {
    const child = rt.child;
    rt.child = null;
    if (!child || child.killed) return;
    try {
      if (process.platform === 'win32' && child.pid) {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch {
      /* 退出清理失败不影响主流程 */
    }
  }

  private rejectAll(rt: ServerRuntime, err: Error): void {
    for (const p of rt.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    rt.pending.clear();
  }

  private onStdout(rt: ServerRuntime, chunk: string): void {
    rt.buffer += chunk;
    let idx = rt.buffer.indexOf('\n');
    while (idx >= 0) {
      const line = rt.buffer.slice(0, idx).trim();
      rt.buffer = rt.buffer.slice(idx + 1);
      if (line) this.onMessage(rt, line);
      idx = rt.buffer.indexOf('\n');
    }
    if (rt.buffer.length > 4 * 1024 * 1024) rt.buffer = '';
  }

  private onMessage(rt: ServerRuntime, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      return; // 非 JSON 行（部分服务器会往 stdout 打日志）忽略
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const msg = item as Record<string, unknown> | null;
      if (!msg || typeof msg !== 'object') continue;
      const id = typeof msg.id === 'number' ? msg.id : null;
      if (id !== null && rt.pending.has(id)) {
        if (msg.error) {
          const e = msg.error as { message?: string; code?: number };
          this.settlePending(rt, id, undefined, new Error(`MCP 错误 ${e.code ?? ''}：${e.message || '未知错误'}`));
        } else {
          this.settlePending(rt, id, msg.result);
        }
        continue;
      }
      if (typeof msg.method !== 'string') continue;
      if (msg.method === 'notifications/tools/list_changed' && rt.state === 'ready') {
        void this.syncTools(rt).catch((err) => this.log(`MCP：${rt.cfg.serverName} 刷新工具失败：${(err as Error).message}`));
        continue;
      }
      if (id !== null) this.replyServerRequest(rt, id, msg.method);
    }
  }

  /** 服务器反向请求（ping / sampling 等）：stdio 上明确回包，避免服务器一直等 */
  private replyServerRequest(rt: ServerRuntime, id: number, method: string): void {
    if (rt.cfg.transport !== 'stdio') return;
    const payload = method === 'ping'
      ? { jsonrpc: '2.0', id, result: {} }
      : { jsonrpc: '2.0', id, error: { code: -32601, message: `不支持的客户端能力：${method}` } };
    try {
      rt.child?.stdin?.write(`${JSON.stringify(payload)}\n`);
    } catch {
      /* 管道已断：由调用超时兜底 */
    }
  }

  private settlePending(rt: ServerRuntime, id: number, value?: unknown, err?: Error): void {
    const p = rt.pending.get(id);
    if (!p) return;
    rt.pending.delete(id);
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(value);
  }
  private notify(rt: ServerRuntime, method: string, params: Record<string, unknown>): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params });
    if (rt.cfg.transport === 'stdio') {
      try {
        rt.child?.stdin?.write(`${body}\n`);
      } catch {
        /* 管道已断：等调用失败时再报错 */
      }
      return;
    }
    void this.httpPost(rt, body).catch(() => undefined);
  }

  private request(rt: ServerRuntime, method: string, params: Record<string, unknown>, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error('MCP 客户端已关闭'));
    const id = rt.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        rt.pending.delete(id);
        reject(new Error(`${method} 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timer.unref?.();
      rt.pending.set(id, { resolve, reject, timer });
      if (rt.cfg.transport === 'stdio') {
        if (!rt.child) {
          rt.pending.delete(id);
          clearTimeout(timer);
          reject(new Error('MCP 子进程不存在'));
          return;
        }
        try {
          rt.child.stdin?.write(`${body}\n`);
        } catch (err) {
          rt.pending.delete(id);
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        this.httpSend(rt, body, id);
      }
    });
    return withTimeout(promise, timeoutMs + 500, method);
  }

  private httpHeaders(rt: ServerRuntime): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(rt.cfg.headers ?? {}),
    };
    for (const key of Object.keys(headers)) headers[key] = resolveEnvPlaceholders(headers[key]);
    if (rt.sessionId) headers['Mcp-Session-Id'] = rt.sessionId;
    return headers;
  }

  /** HTTP 请求：JSON 或 SSE 增量解析，命中本请求 id 立即结算（服务器可能保持 SSE 长连接） */
  private httpSend(rt: ServerRuntime, body: string, id: number): void {
    const url = new URL(rt.cfg.url as string);
    const client = url.protocol === 'https:' ? https : http;
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: this.httpHeaders(rt),
        timeout: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const session = res.headers['mcp-session-id'];
        if (typeof session === 'string' && session) rt.sessionId = session;
        if (res.statusCode && res.statusCode >= 400) {
          this.settlePending(rt, id, undefined, new Error(`MCP HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const contentType = String(res.headers['content-type'] || '');
        const isSse = contentType.includes('text/event-stream');
        let buffer = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (!rt.pending.has(id)) return;
          if (!isSse) {
            buffer += chunk;
            return;
          }
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data:')) this.tryResolveHttp(rt, id, line.slice(5).trim());
            if (!rt.pending.has(id)) {
              res.destroy(); // 已拿到结果：不必等服务器关闭长连接
              return;
            }
          }
        });
        res.on('end', () => {
          if (rt.pending.has(id)) this.tryResolveHttp(rt, id, buffer.trim());
          this.settlePending(rt, id, undefined, new Error('MCP HTTP 响应结束但没有匹配结果'));
        });
        res.on('error', (err) => this.settlePending(rt, id, undefined, err instanceof Error ? err : new Error(String(err))));
      },
    );
    req.on('timeout', () => req.destroy(new Error('MCP HTTP 超时')));
    req.on('error', (err) => this.settlePending(rt, id, undefined, err instanceof Error ? err : new Error(String(err))));
    req.end(body);
  }

  /** 从一段文本里找 JSON-RPC 响应；匹配本请求 id 就结算 */
  private tryResolveHttp(rt: ServerRuntime, id: number, text: string): void {
    if (!text || !rt.pending.has(id)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of list) {
      const msg = item as Record<string, unknown> | null;
      if (!msg || typeof msg.id !== 'number' || msg.id !== id) continue;
      if (msg.error) {
        const e = msg.error as { message?: string; code?: number };
        this.settlePending(rt, id, undefined, new Error(`MCP 错误 ${e.code ?? ''}：${e.message || '未知错误'}`));
      } else {
        this.settlePending(rt, id, msg.result);
      }
      return;
    }
  }

  /** 通知用（不关心响应结果）：失败不影响主流程 */
  private httpPost(rt: ServerRuntime, body: string): Promise<string> {
    const url = new URL(rt.cfg.url as string);
    const client = url.protocol === 'https:' ? https : http;
    return new Promise<string>((resolve, reject) => {
      const req = client.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'POST',
          headers: this.httpHeaders(rt),
          timeout: DEFAULT_REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const session = res.headers['mcp-session-id'];
          if (typeof session === 'string' && session) rt.sessionId = session;
          res.resume();
          res.on('end', () => resolve(''));
        },
      );
      req.on('timeout', () => req.destroy(new Error('MCP HTTP 超时')));
      req.on('error', (err) => reject(err instanceof Error ? err : new Error(String(err))));
      req.end(body);
    });
  }
}
