/**
 * dshBridge.ts —— 「桥接本机 DSH」对话后端
 *
 * 为什么需要：桌宠除了直连 OpenAI 兼容 API，还可以把对话交给本机已登录的 DeepSeek Harness（dsh）
 * 处理——用户不用再配 API Key/地址，直接用 DSH 里已配置的模型与账号。按用户要求：
 * **桥接 DSH 时以文本协议传对话**：用户文字、附件路径/元数据（图片由 DSH 的 read_image 查看，音频先 ASR），只取最终回复文字；桌宠不向 DSH 注入自己的工具/截图。
 *
 * 实现方式（实测本机 dsh 0.2.0-rc.2）：
 *   dsh --profile headless --json [--session-id <id>] -   ← stdin 传任务文本，stdout 输出 NDJSON 事件
 *   {"type":"session","sessionId":"session-…"} / {"type":"text","text":"…"} / {"type":"final","text":"…"}
 *   - 会话续接：第一次从 session 事件拿到 id，之后每条消息都带 --session-id，DSH 会延续上下文；
 *   - `resetSession()` 清空本地 session.json（"新对话/重置上下文"时调用）；
 *   - headless 把**进程 cwd 当工作区**（会读 cwd 的 AGENTS.md 并可能触发工具），所以这里强制
 *     在 `<userData>/dsh-bridge` 这个干净目录里跑，并设 `DSH_PERMISSION_MODE=workspace-write`
 *     把写入限制在该目录内（AI 生成的回发文件就写这里；其余副作用受 DSH 自己的审批策略限制）；
 *   - 每次对话一个子进程、串行排队（同一时刻只跑一个），超时/取消会杀进程树。
 *
 * 纯逻辑（NDJSON 解析、命令解析、Windows 启动计划）都单独导出，便于离线单测。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { ensureDshWebRunning } from './dshWebManager';
import { prepareDshPatch, type DshMcpEndpoint } from './dshMcpPatch';

export type DshErrorCode = 'NOT_FOUND' | 'TIMEOUT' | 'EXIT' | 'CANCELLED' | 'UNKNOWN';

export class DshError extends Error {
  code: DshErrorCode;
  stderr?: string;
  exitCode?: number;
  constructor(code: DshErrorCode, message: string) {
    super(message);
    this.name = 'DshError';
    this.code = code;
  }
}

/** 设置页展示的 DSH 状态。 */
export interface DshStatus {
  available: boolean;
  commandPath: string;
  version: string | null;
  bridgeDir: string;
  busy: boolean;
  lastError: string | null;
}

export interface DshBridgeOptions {
  bridgeDir: string;
  commandPath?: string;
  timeoutMs?: number;
  /** 调试/测试用：覆盖命令探测（默认走 resolveDshCommand） */
  env?: NodeJS.ProcessEnv;
  /** 调试/测试用：覆盖平台（默认 process.platform） */
  platform?: NodeJS.Platform;
  /** 调试/测试用：注入文件存在性检查 */
  pathExists?: (p: string) => boolean;
  /** 会话 id 文件（默认在 bridge 目录里；建议放到 bridge 之外，避免 DSH 可写目录篡改会话） */
  sessionFile?: string;
  /** 可选：桌宠 MCP 服务端端点。有值时每轮生成 patch，让 DSH 通过 MCP 调用 pet_* 工具。 */
  mcpEndpoint?: () => DshMcpEndpoint | null;
  /** 可选：DSH 的 thinking 事件（显示思考浮窗用） */
  onThink?: (text: string) => void;

}

/** 一条 NDJSON 事件（只保证 type 是字符串，其余字段按需取）。 */
export interface DshLine {
  type: string;
  [key: string]: unknown;
}

/** 解析一行 NDJSON；空行/非法 JSON/无 type 返回 null（调用方跳过，不炸整条流）。 */
export function parseDshLine(line: string): DshLine | null {
  const trimmed = (line ?? '').replace(/^\uFEFF/, '').trim();
  if (!trimmed) return null;
  try {
    const data = JSON.parse(trimmed) as unknown;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    const type = (data as Record<string, unknown>).type;
    if (typeof type !== 'string' || !type) return null;
    return data as DshLine;
  } catch {
    return null;
  }
}

/**
 * 错误文本是否表示"这个本地会话 id 已经不能用了"（清掉本地 session 后用新会话重试一次）。
 * 覆盖 DSH 的几种真实文案：会话不存在、被别的进程（例如 DSH Web GUI 里打开了同一会话）
 * 持有独占写锁、会话由 agent preset/子代理创建而 one-shot runner 不能接管、cwd 不匹配。
 */
export function looksLikeInvalidSession(text: string | undefined | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('unknown session') ||
    lower.includes('session not found') ||
    lower.includes('invalid session') ||
    lower.includes('no such session') ||
    lower.includes('does not exist; omit --session-id') ||
    lower.includes('already owned by an active write handle') ||
    lower.includes('cannot be driven directly') ||
    lower.includes('was recorded in') ||
    lower.includes('does not compose')
  );
}

/**
 * 每个 ChatClient 实例用的会话文件名：主对话沿用 dsh-session.json，
 * 自主任务/手机桥接加后缀——多个桥接实例共用一份会话会互相抢 DSH 的独占写锁。
 */
export function dshSessionFileName(key: string): string {
  const clean = String(key ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  return !clean || clean === 'chat' ? 'dsh-session.json' : `dsh-session-${clean}.json`;
}

/** DSH 会话 id 白名单：只接受字母数字开头、由字母数字/._- 组成（防止带进 cmd 命令行的元字符）。 */
export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
}

/**
 * 命令路径安全检查：Windows shell:true 拼命令行时，引号/百分号/控制字符与 cmd/PowerShell 元字符
 * （& | < > ^ ' $ `）都可能改变命令边界，一律拒绝——合法的 dsh 安装路径不会包含这些字符。
 */
export function isSafeCommandPath(command: string): boolean {
  if (typeof command !== 'string' || !command.trim()) return false;
  return !/["'%^&|<>$`\r\n\u0000]/.test(command);
}

/**
 * 当前 DSH 安装里有没有 `@deepseek-ai/dsh-mcp-client` 插件（反向接入依赖它）。
 * 旧版 DSH 没有该插件：patch 里插入一个不存在的插件可能让 headless 启动直接失败，
 * 所以拿不到就跳过 MCP 块（只保留实时思考插件），对话本身不受影响。
 * 纯文件/解析判断（依赖可注入），不读取任何用户数据。
 */
export function hasDshMcpClientPlugin(
  commandPath: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    pathExists?: (p: string) => boolean;
    resolveSpec?: (spec: string, paths: string[]) => string | null;
  } = {},
): boolean {
  const env = opts.env ?? process.env;
  const exists = opts.pathExists ?? ((p: string) => fs.existsSync(p));
  const resolveSpec =
    opts.resolveSpec ??
    ((spec: string, paths: string[]): string | null => {
      try {
        return require.resolve(spec, { paths });
      } catch {
        return null;
      }
    });
  const roots: string[] = [];
  const pushRoot = (dir: string): void => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  pushRoot(path.dirname(commandPath || ''));
  // npm 全局安装的几种前缀（Windows 上用 APPDATA/LOCALAPPDATA；其它平台/可配置前缀也一起试）
  for (const dir of [env.APPDATA, env.LOCALAPPDATA, env.npm_config_prefix, env.NPM_CONFIG_PREFIX, env.PREFIX]) {
    if (dir) pushRoot(dir);
  }
  if (env.APPDATA) pushRoot(path.join(env.APPDATA, 'npm'));
  if (env.LOCALAPPDATA) pushRoot(path.join(env.LOCALAPPDATA, 'npm'));
  if (env.NPM_CONFIG_PREFIX) pushRoot(path.join(env.NPM_CONFIG_PREFIX, 'lib', 'node_modules'));
  // 常见 POSIX 全局安装布局（dsh 在 bin 下、包在 lib/node_modules 下），Windows 上这些目录不存在就自然跳过
  const binDir = path.dirname(commandPath || '');
  if (binDir) {
    pushRoot(path.join(binDir, '..', 'lib', 'node_modules'));
    pushRoot(path.join(binDir, '..', 'node_modules'));
  }
  for (const root of roots) {
    if (resolveSpec('@deepseek-ai/dsh-mcp-client', [root])) return true;
    const candidates = [
      path.join(root, 'node_modules', '@deepseek-ai', 'dsh-mcp-client', 'package.json'),
      // dsh 自带的嵌套依赖目录（npm 全局安装最常见的布局）
      path.join(
        root,
        'node_modules',
        '@deepseek-ai',
        'dsh',
        'node_modules',
        '@deepseek-ai',
        'dsh-mcp-client',
        'package.json',
      ),
    ];
    if (candidates.some(exists)) return true;
  }
  return false;
}

/**
 * 持久化日志脱敏：`dsh-turns.log` 可能被用户贴出来排查问题，不能带隐私。
 * - 去掉推理流插件输出（`pet-reasoning:"…"`：模型思考原文，属于用户/模型内容）；
 * - 打掉 Bearer token；
 * - 把家目录/用户目录替换成 `~`（用户名属于个人信息）。
 */
export function redactLogText(raw: string): string {
  try {
    let text = String(raw ?? '');
    text = text.replace(/pet-reasoning:(?:"(?:[^"\\]|\\.)*")?/g, ' ');
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
    const home = os.homedir();
    if (home) {
      const variants = [home, home.replace(/\\/g, '/'), JSON.stringify(home).slice(1, -1)];
      for (const v of variants) {
        if (v) text = text.split(v).join('~');
      }
    }
    text = text.replace(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"']+/gi, (m) => m.replace(/[^\\/]+$/, '<user>'));
    text = text.replace(/\s+/g, ' ').trim();
    return text.slice(-400);
  } catch {
    return '';
  }
}

/**
 * 找到 `dsh` 命令的完整路径。
 * 顺序：PET_DSH_CMD 环境变量 → PATH 里的 dsh.cmd/dsh.exe/dsh.ps1 → %APPDATA%\npm\dsh.cmd → 'dsh.cmd'。
 */
export function resolveDshCommand(opts: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  pathExists?: (p: string) => boolean;
} = {}): string {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exists = opts.pathExists ?? ((p: string) => fs.existsSync(p));
  const override = (env.PET_DSH_CMD ?? '').trim();
  if (override) return override;

  const candidates: string[] = [];
  const pathList = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  if (platform === 'win32') {
    for (const dir of pathList) {
      candidates.push(path.join(dir, 'dsh.cmd'), path.join(dir, 'dsh.exe'), path.join(dir, 'dsh.ps1'));
    }
    const appData = (env.APPDATA ?? '').trim();
    if (appData) candidates.push(path.join(appData, 'npm', 'dsh.cmd'), path.join(appData, 'npm', 'dsh.exe'));
    candidates.push('dsh.cmd');
  } else {
    for (const dir of pathList) candidates.push(path.join(dir, 'dsh'));
    candidates.push('dsh');
  }
  for (const candidate of candidates) {
    if (candidate === 'dsh' || candidate === 'dsh.cmd' || exists(candidate)) return candidate;
  }
  return platform === 'win32' ? 'dsh.cmd' : 'dsh';
}

/** 按扩展名决定怎么启动（Windows 的 .cmd/.ps1 不能直接 spawn）。 */
/**
 * 按扩展名决定怎么启动（Windows 的 .cmd/.ps1 不能直接被 spawn 成 argv 命令）：
 *  - .cmd/.bat：拼成一条命令行交给 Node 的 shell:true（由 cmd.exe /d /s /c 执行）；
 *    注意**不能**自己 spawn cmd.exe 并逐参数传（Node 会把参数里的引号转义坏，cmd 看到 \"…\" 就报"不是内部或外部命令"）。
 *  - .ps1：powershell -File（argv 正常传参）。
 */
export function buildDshSpawnPlan(
  command: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[]; shell?: boolean } {
  if (platform !== 'win32') return { command, args };
  const lower = command.toLowerCase();
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    return { command: `"${command}" ${args.join(' ')}`.trim(), args: [], shell: true };
  }
  if (lower.endsWith('.ps1')) {
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command, ...args] };
  }
  return { command, args };
}

/** 给用户看的错误文案（保留可操作信息）。 */
export function formatDshError(err: unknown): string {
  if (err instanceof DshError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * 解码子进程输出：dsh 自己的输出是 UTF-8；但 .cmd 找不到命令时 cmd.exe 的系统错误是 GBK。
 * 先按 UTF-8 严格解码，失败再按 GBK 解（避免中文错误信息变成乱码）。
 */
export function decodeConsoleBytes(buf: Buffer | string): string {
  if (typeof buf === 'string') return buf;
  if (!buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

/** 子进程环境：继承系统变量（PATH/HOME/APPDATA…），去掉宠物的 AI/邮箱等敏感变量。 */
export function buildChildEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_')) continue; // DSH 自己的变量照常传
    const isProviderKey = /^(AI_|OPENAI_|DEEPSEEK_|AZURE_|VOICE_|MAIL_|ANTHROPIC_|GEMINI_|GOOGLE_|GROQ_|COHERE_|HUGGINGFACE_|HF_)/i.test(key);
    const looksSecret = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|AUTH)/i.test(key);
    if (isProviderKey || looksSecret) delete env[key];
  }
  return env;
}

interface QueueItem {
  text: string;
  enqueuedAt: number;
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
}

export class DshBridge {
  private readonly bridgeDir: string;
  /** DSH 工作目录之外的私有目录：放 patch / 推理插件 / MCP 代理（DSH 的写工具动不到） */
  private readonly toolsDir: string;
  private readonly mcpEndpoint?: () => DshMcpEndpoint | null;
  private readonly onThink?: (text: string) => void;
  private readonly sessionFile: string;
  private readonly commandPath: string;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private version: string | null = null;
  private detected = false;
  private busy = false;
  private lastError: string | null = null;
  private currentProcess: ChildProcess | null = null;
  /** 后台预热进程（只挂载/退出，不建会话、不调模型） */
  private warmProcess: ChildProcess | null = null;
  private abortCurrent: (() => void) | null = null;
  private pending: QueueItem[] = [];
  private processing = false;
  /** 当前 DSH 是否带 MCP client 插件（反向接入前置条件）；null = 还没判过 */
  private mcpPluginAvailable: boolean | null = null;
  /** 代际号：cancel/reset 会 +1，旧进程的回调据此丢弃（避免取消后旧结果覆盖新状态） */
  private generation = 0;
  /** 命令路径不安全时置位：不 spawn，状态直接报不可用 */
  private commandInvalid = false;
  /** 同一时刻只跑一次 DSH web 检测/启动 */
  private webEnsurePromise: Promise<void> | null = null;
  private webPid: number | null = null;

  constructor(options: DshBridgeOptions) {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    this.bridgeDir = options.bridgeDir;
    this.toolsDir = path.join(path.dirname(options.bridgeDir), 'dsh-bridge-tools');
    this.mcpEndpoint = options.mcpEndpoint;
    this.onThink = options.onThink;
    this.sessionFile = options.sessionFile?.trim() || path.join(this.bridgeDir, 'session.json');
    this.commandPath =
      (options.commandPath ?? '').trim() || resolveDshCommand({ env, platform, pathExists: options.pathExists });
    if (!isSafeCommandPath(this.commandPath)) {
      this.commandInvalid = true;
      this.lastError = `dsh 命令路径包含不安全字符，已拒绝执行：${this.commandPath}`;
    }
    const envTimeout = (env.PET_DSH_TIMEOUT_MS ?? '').trim();
    const parsedTimeout = envTimeout ? Number(envTimeout) : NaN;
    // DSH 是完整 agent，工具/多步任务（做文件、跑命令）经常超过 2 分钟；120s 会把正常回合杀掉、表现为"没有回复"。
    this.timeoutMs =
      options.timeoutMs ?? (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 180_000);
    this.ensureBridgeDir();
    this.loadSession();
  }

  /** 桥接目录（<userData>/dsh-bridge）：放 session.json，不放任何 AGENTS.md。 */
  get dir(): string {
    return this.bridgeDir;
  }

  private ensureBridgeDir(): void {
    try {
      fs.mkdirSync(this.bridgeDir, { recursive: true });
    } catch {
      /* 目录建不出来时后面 spawn 会失败并给出可读错误 */
    }
  }

  private loadSession(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')) as { sessionId?: unknown };
      this.sessionId = isValidSessionId(raw.sessionId) ? raw.sessionId : null;
    } catch {
      this.sessionId = null;
    }
  }

  private saveSession(id: string): void {
    if (!isValidSessionId(id)) {
      this.lastError = 'DSH 返回了非法会话 id，已忽略（不会写入 session.json）';
      return;
    }
    this.sessionId = id;
    try {
      this.ensureBridgeDir();
      fs.writeFileSync(this.sessionFile, `${JSON.stringify({ sessionId: id }, null, 2)}\n`, 'utf8');
    } catch (err) {
      this.lastError = `保存 DSH 会话失败：${formatDshError(err)}`;
    }
  }

  /** "新对话/重置上下文"：清掉本地会话 id，下一条消息会新开 DSH 会话。 */
  resetSession(): void {
    this.sessionId = null;
    this.lastError = null;
    try {
      if (fs.existsSync(this.sessionFile)) fs.unlinkSync(this.sessionFile);
    } catch {
      /* ignore */
    }
  }

  /** 是否已有可续接的 DSH 会话（供桥接层决定是否注入一次历史上下文）。 */
  hasSession(): boolean {
    return !!this.sessionId;
  }

  private async detect(force = false): Promise<void> {
    if (this.detected && !force) return;
    if (this.commandInvalid) {
      this.detected = true;
      this.version = null;
      return;
    }
    this.detected = true;
    try {
      this.version = await this.runVersion();
    } catch (err) {
      this.version = null;
      this.lastError = formatDshError(err);
    }
  }

  private runVersion(): Promise<string> {
    const plan = buildDshSpawnPlan(this.commandPath, ['-V']);
    return new Promise((resolve, reject) => {
      let settled = false;
      const proc = spawn(plan.command, plan.args, { windowsHide: true, shell: plan.shell === true });
      let out = '';
      let errBuf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.killProcess(proc);
          reject(new DshError('TIMEOUT', '检测 dsh 版本超时（未安装或命令卡住）'));
        }
      }, 5000);
      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8');
      });
      proc.stderr?.on('data', (d: Buffer) => {
        errBuf = Buffer.concat([errBuf, d]);
      });
      proc.on('error', (e: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          e.code === 'ENOENT'
            ? new DshError('NOT_FOUND', '未检测到 dsh 命令（请先安装 DeepSeek Harness）')
            : new DshError('UNKNOWN', `DSH 启动失败：${e.message}`),
        );
      });
      const errText = (): string => decodeConsoleBytes(errBuf);
      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0 && out.trim()) resolve(out.trim());
        else reject(new DshError('EXIT', `dsh -V 失败（code ${code ?? '?'}）${errText() ? `：${errText().slice(-160)}` : ''}`));
      });
    });
  }

  /** 设置页状态：可用性/版本/桥接目录/是否忙/最近错误。 */
  async status(force = false): Promise<DshStatus> {
    await this.detect(force);
    return {
      available: this.version !== null,
      commandPath: this.commandPath,
      version: this.version,
      bridgeDir: this.bridgeDir,
      busy: this.busy,
      lastError: this.lastError,
    };
  }

  /** 取消当前子进程并清空排队（新对话/退出/设置变更时用）。 */
  cancel(): void {
    this.generation++;
    if (this.currentProcess) this.killProcess(this.currentProcess);
    this.abortCurrent?.();
    this.abortCurrent = null;
    for (const item of this.pending) item.reject(new DshError('CANCELLED', '已取消'));
    this.pending = [];
    this.currentProcess = null;
    this.processing = false;
    this.busy = false;
  }

  /**
   * 反向接入是否可用：当前 DSH 版本是否带 `@deepseek-ai/dsh-mcp-client` 插件。
   * 只判一次；不可用时提示一次——对话与实时思考不受影响，只是 DSH 调不到桌宠工具。
   */
  private mcpAvailable(): boolean {
    if (this.mcpPluginAvailable === null) {
      try {
        this.mcpPluginAvailable = hasDshMcpClientPlugin(this.commandPath);
      } catch {
        this.mcpPluginAvailable = false;
      }
      if (!this.mcpPluginAvailable) {
        console.warn(
          '[dsh] 当前 DSH 没有 @deepseek-ai/dsh-mcp-client 插件：反向接入（让 DSH 调用桌宠工具）不可用；对话与实时思考正常',
        );
      }
    }
    return this.mcpPluginAvailable;
  }

  /**
   * 预热一次 DSH 启动：冷启动（node/DSH 模块、profile 解析、插件挂载、MCP 客户端）是本机最贵的固定开销，
   * 第一次发消息可能等几十秒。这里在 App 启动后空闲时先跑一次「只启动、不带任务」的进程——
   * 空 stdin 会在启动完成后报「需要任务」并退出，不建会话、不调模型。
   */
  warmUp(): void {
    if (this.commandInvalid || this.warmProcess || this.processing || this.busy) return;
    try {
      const args = ['--profile', 'headless'];
      try {
        const patch = prepareDshPatch(this.mcpAvailable() ? (this.mcpEndpoint?.() ?? null) : null, this.toolsDir);
        if (patch) args.push('--patch', path.relative(this.bridgeDir, patch) || patch);
      } catch {
        /* patch 失败也照样预热基础启动 */
      }
      args.push('--json', '-');
      const plan = buildDshSpawnPlan(this.commandPath, args);
      const proc = spawn(plan.command, plan.args, {
        cwd: this.bridgeDir,
        windowsHide: true,
        shell: plan.shell === true,
        env: buildChildEnv({ DSH_PERMISSION_MODE: 'workspace-write' }),
        stdio: 'ignore',
      });
      this.warmProcess = proc;
      const done = (): void => {
        if (this.warmProcess === proc) this.warmProcess = null;
      };
      proc.on('close', done);
      proc.on('error', done);
      // 预热最多占 2 分钟；真开始对话时会主动杀掉它
      setTimeout(() => {
        if (this.warmProcess === proc) {
          this.warmProcess = null;
          this.killProcess(proc);
        }
      }, 120_000).unref?.();
    } catch {
      /* 预热失败不影响真实对话 */
    }
  }

  /** 结束预热进程（真实对话开始前调用，避免两个 DSH 同时冷启动抢资源）。 */
  private stopWarmUp(): void {
    const proc = this.warmProcess;
    if (!proc) return;
    this.warmProcess = null;
    this.killProcess(proc);
  }

  /** 发一条对话（串行队列）：返回 DSH 的最终回复文本；失败抛 DshError。 */
  chat(text: string): Promise<string> {
    const content = (text ?? '').trim();
    if (!content) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      this.pending.push({ text: content, enqueuedAt: Date.now(), resolve, reject });
      void this.processQueue();
    });
  }

  /** 桥接 DSH 前后台没有 DSH web 时，自动最小化拉起一次；失败不阻断 headless 对话。 */
  private async ensureWebRunning(): Promise<void> {
    if (this.webPid) {
      // 进程可能在挂机期间被关掉：只查这个 pid 是否还活着，失活才清缓存重新拉起。
      if (this.isProcessAlive(this.webPid)) return;
      console.warn(`[dsh] 后台 DSH (pid=${this.webPid}) 已退出，将重新拉起`);
      this.webPid = null;
    }
    if (this.webEnsurePromise) return this.webEnsurePromise;
    if (this.commandInvalid) return;
    this.webEnsurePromise = (async () => {
      try {
        const plan = buildDshSpawnPlan(this.commandPath, ['web']);
        const result = await ensureDshWebRunning(plan, { timeoutMs: 12000 });
        this.webPid = result.pid;
        console.log(`[dsh] 后台 DSH ${result.started ? '已启动' : '已在运行'}${result.pid ? `（pid=${result.pid}）` : ''}`);
      } catch (err) {
        // DSH headless 对话不依赖 web，启动失败只记录，不阻断桥接
        this.lastError = `DSH 后台启动失败：${formatDshError(err)}`;
        console.warn('[dsh] 后台 DSH 启动失败：', this.lastError);
      }
    })().finally(() => { this.webEnsurePromise = null; });
    return this.webEnsurePromise;
  }

  /** pid 是否仍存活：signal 0 只做存在性检查；EPERM 表示进程存在但属于其它用户，也算存活。 */
  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  /** 追加一行回合耗时到 `<userData>/dsh-turns.log`；超过 256KB 时只保留最后 100 行。 */
  private appendTurnLog(line: string): void {
    try {
      const file = path.join(path.dirname(this.bridgeDir), 'dsh-turns.log');
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`, 'utf8');
      if (fs.statSync(file).size > 256 * 1024) {
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split('\n').slice(-100).join('\n'), 'utf8');
      }
    } catch {
      /* 日志失败不影响对话 */
    }
  }

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      // 后台 DSH web 只是给设置页/GUI 用的附属进程，对话本身不依赖它：
      // 绝不能把它（PowerShell 探测、拉起、轮询）挡在每轮回复的关键路径上。
      void this.ensureWebRunning();
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        if (!item) continue;
        this.busy = true;
        try {
          item.resolve(await this.runChat(item.text, item.enqueuedAt));
        } catch (err) {
          item.reject(err);
        } finally {
          this.busy = false;
        }
      }
    } finally {
      this.processing = false;
    }
  }

  private async runChat(text: string, enqueuedAt: number): Promise<string> {
    if (this.commandInvalid) {
      throw new DshError('NOT_FOUND', this.lastError ?? 'dsh 命令不可用');
    }
    try {
      return await this.runChatOnce(text, Math.max(0, Date.now() - enqueuedAt));
    } catch (err) {
      const unusable =
        err instanceof DshError && err.code === 'EXIT' && this.sessionId
          ? looksLikeInvalidSession(`${err.stderr ?? ''}\n${err.message}`)
          : false;
      if (unusable) {
        // 会话被删除/被其它 DSH 进程占用时，用本地 session 只会每轮都失败；丢掉它、新开一个再试一次。
        console.warn('[dsh] 本地会话不可用，改用新会话重试：', formatDshError(err).slice(-200));
        this.resetSession();
        return this.runChatOnce(text, 0);
      }
      throw err;
    }
  }

  private runChatOnce(text: string, queueMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      this.stopWarmUp();
      const startedAt = Date.now();
      let firstEventMs: number | null = null;
      // --json 投影只在提交 assistant/message 后输出 thinking；实时推理由 patch 里的本地插件写 stderr 得到。
      const args = ['--profile', 'headless'];
      // --patch 是 dsh launcher 参数，必须排在 --session-id/--json 等 app 参数之前。
      try {
        const patch = prepareDshPatch(this.mcpAvailable() ? (this.mcpEndpoint?.() ?? null) : null, this.toolsDir);
        // 传相对路径：dsh 按子进程 cwd（bridgeDir）解析 --patch，而 Windows 用户名可能含空格，
        // 绝对路径在 .cmd 的 shell 命令行里会被拆成两个参数。
        if (patch) args.push('--patch', path.relative(this.bridgeDir, patch) || patch);
      } catch (err) {
        console.warn('[dsh] 生成 patch 失败（反向接入与实时思考将不可用）：', formatDshError(err));
      }
      if (this.sessionId) args.push('--session-id', this.sessionId);
      args.push('--json', '-');
      const plan = buildDshSpawnPlan(this.commandPath, args);
      const gen = this.generation;

      let finished = false;
      let resultText = '';
      let stdoutBuf = '';
      /** --json 的 error 事件文本（启动/参数错误只出现在 stdout，stderr 常为空） */
      let structuredError = '';
      const stderrChunks: Buffer[] = [];
      const stderrDecoder = new StringDecoder('utf8');
      let stderrLineBuf = '';
      let streamedReasoning = false;
      let timer: NodeJS.Timeout | null = null;

      /** 插件按行输出 `pet-reasoning:<JSON 字符串>`；只认这种行，DSH 自己的 stderr 日志不会混进思考内容。 */
      const handleStderrLine = (line: string): void => {
        const marker = 'pet-reasoning:';
        if (!line.startsWith(marker)) return;
        let chunk = '';
        try {
          const parsed = JSON.parse(line.slice(marker.length)) as unknown;
          if (typeof parsed === 'string') chunk = parsed;
        } catch {
          return; // 半行/非 JSON：丢弃，不把标记或残片当思考内容
        }
        if (!chunk) return;
        streamedReasoning = true;
        this.onThink?.(chunk);
      };

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.currentProcess = null;
        this.abortCurrent = null;
      };
      /** 耗时拆解（排队/启动到首个事件/总）：回复变慢时能一眼看出是排队、DSH 启动还是模型慢 */
      const logTurn = (ok: boolean): void => {
        const total = Date.now() - startedAt;
        const slowBoot = firstEventMs !== null && firstEventMs > 5000;
        let line = `回合${ok ? '完成' : '失败'} 总计 ${total}ms（排队 ${queueMs}ms，启动到首事件 ${firstEventMs ?? '-'}ms）`;
        if (!ok || slowBoot) {
          // 启动异常慢时把 DSH 自己的 stderr 尾部带上，能看出卡在插件/MCP/权限哪一步。
          // 落盘/打印前先脱敏：去掉推理流原文（pet-reasoning:…）、Bearer token、家目录里的用户名。
          const errTail = redactLogText(decodeConsoleBytes(Buffer.concat(stderrChunks)));
          if (errTail) line += ` stderr: ${errTail}`;
        }
        console.log(`[dsh] ${line}`);
        // 打包版没有控制台：同一行也落到 <userData>/dsh-turns.log，方便事后排查"为什么慢"
        this.appendTurnLog(line);
      };
      const finish = (result: string): void => {
        if (finished) return;
        if (gen !== this.generation) { cleanup(); return; }
        finished = true;
        cleanup();
        logTurn(true);
        resolve(result);
      };
      const fail = (err: DshError): void => {
        if (finished) return;
        if (gen !== this.generation) { cleanup(); return; }
        finished = true;
        cleanup();
        this.lastError = err.message;
        logTurn(false);
        reject(err);
      };

      const proc = spawn(plan.command, plan.args, {
        cwd: this.bridgeDir,
        windowsHide: true,
        shell: plan.shell === true,
        env: buildChildEnv({ DSH_PERMISSION_MODE: 'workspace-write' }),
      });
      this.currentProcess = proc;
      this.abortCurrent = () => fail(new DshError('CANCELLED', '已取消'));

      timer = setTimeout(() => {
        fail(new DshError('TIMEOUT', `DSH 超时（${Math.round(this.timeoutMs / 1000)}s）`));
        this.killProcess(proc);
      }, this.timeoutMs);

      proc.on('error', (err: NodeJS.ErrnoException) => {
        fail(
          err.code === 'ENOENT'
            ? new DshError('NOT_FOUND', '未检测到 dsh 命令（请先安装 DeepSeek Harness）')
            : new DshError('UNKNOWN', `DSH 启动失败：${err.message}`),
        );
      });
      proc.stderr?.on('data', (d: Buffer) => {
        // 取消/超时后旧代际的残块不再推进思考浮窗
        if (gen !== this.generation) return;
        stderrChunks.push(d);
        const chunk = stderrDecoder.write(d);
        if (!chunk) return;
        stderrLineBuf += chunk;
        const lines = stderrLineBuf.split('\n');
        stderrLineBuf = lines.pop() ?? '';
        for (const line of lines) handleStderrLine(line.replace(/\r$/, ''));
        // 一直没有换行的超长日志（栈/进度条）：只留尾部，避免缓冲无限增长
        if (stderrLineBuf.length > 8192) stderrLineBuf = stderrLineBuf.slice(-8192);
      });
      proc.stdout?.on('data', (d: Buffer) => {
        if (gen !== this.generation) return;
        stdoutBuf += d.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const evt = parseDshLine(line);
          if (!evt) continue;
          if (firstEventMs === null) firstEventMs = Date.now() - startedAt;
          if (evt.type === 'session' && typeof evt.sessionId === 'string' && evt.sessionId) {
            this.saveSession(evt.sessionId);
          } else if (evt.type === 'thinking' && typeof evt.text === 'string') {
            // 插件已实时转过 reasoning 时，--json 提交后的整段 thinking 跳过，避免重复一大段。
            if (!streamedReasoning && evt.text) this.onThink?.(evt.text);
          } else if (evt.type === 'error') {
            if (typeof evt.message === 'string' && evt.message) structuredError = evt.message;
          } else if (evt.type === 'text' && typeof evt.text === 'string') {
            resultText += evt.text;
          } else if (evt.type === 'final' && typeof evt.text === 'string') {
            finish(evt.text.trim() ? evt.text : resultText.trim());
          }
        }
      });
      proc.on('close', (code) => {
        if (finished || gen !== this.generation) return;
        const tail = stderrDecoder.end();
        if (tail) {
          stderrChunks.push(Buffer.from(tail, 'utf8'));
          stderrLineBuf += tail;
        }
        if (stderrLineBuf) {
          for (const line of stderrLineBuf.split('\n')) handleStderrLine(line.replace(/\r$/, ''));
          stderrLineBuf = '';
        }
        if (code === 0) {
          const textOnly = resultText.trim();
          if (!textOnly) {
            fail(new DshError('EXIT', 'DSH 未返回内容（final/text 均为空）'));
            return;
          }
          finish(textOnly);
        } else {
          const stderrText = decodeConsoleBytes(Buffer.concat(stderrChunks));
          const reason = structuredError || stderrText.trim().slice(-200);
          const detail = reason ? `：${reason}` : '';
          const error = new DshError('EXIT', `DSH 进程异常退出（code ${code ?? '?'}）${detail}`);
          error.stderr = stderrText || structuredError;
          error.exitCode = code ?? undefined;
          fail(error);
        }
      });
      proc.stdin?.write(text, 'utf8', (err) => {
        if (err) fail(new DshError('UNKNOWN', `写入 DSH 输入失败：${err.message}`));
        else proc.stdin?.end();
      });
    });
  }

  /** 杀进程树（Windows 用 taskkill /T /F；其它平台 SIGTERM→SIGKILL）。 */
  private killProcess(proc: ChildProcess): void {
    const pid = proc.pid;
    if (!pid) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      return;
    }
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        return;
      } catch {
        /* fallthrough */
      }
    }
    try {
      proc.kill('SIGTERM');
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 5000);
    } catch {
      /* ignore */
    }
  }
}
