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
 *     在 `<userData>/dsh-bridge` 这个干净目录里跑，并设 `DSH_PERMISSION_MODE=read-only` 限制副作用；
 *   - 每次对话一个子进程、串行排队（同一时刻只跑一个），超时/取消会杀进程树。
 *
 * 纯逻辑（NDJSON 解析、命令解析、Windows 启动计划）都单独导出，便于离线单测。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDshWebRunning } from './dshWebManager';

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

/** stderr 是否表示"会话不存在/失效"（这种情况清掉本地 session 后重试一次）。 */
export function looksLikeInvalidSession(text: string | undefined | null): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.includes('unknown session') ||
    lower.includes('session not found') ||
    lower.includes('invalid session') ||
    lower.includes('no such session')
  );
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
  resolve: (value: string) => void;
  reject: (reason?: unknown) => void;
}

export class DshBridge {
  private readonly bridgeDir: string;
  private readonly sessionFile: string;
  private readonly commandPath: string;
  private readonly timeoutMs: number;
  private sessionId: string | null = null;
  private version: string | null = null;
  private detected = false;
  private busy = false;
  private lastError: string | null = null;
  private currentProcess: ChildProcess | null = null;
  private abortCurrent: (() => void) | null = null;
  private pending: QueueItem[] = [];
  private processing = false;
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
    this.sessionFile = options.sessionFile?.trim() || path.join(this.bridgeDir, 'session.json');
    this.commandPath =
      (options.commandPath ?? '').trim() || resolveDshCommand({ env, platform, pathExists: options.pathExists });
    if (!isSafeCommandPath(this.commandPath)) {
      this.commandInvalid = true;
      this.lastError = `dsh 命令路径包含不安全字符，已拒绝执行：${this.commandPath}`;
    }
    const envTimeout = (env.PET_DSH_TIMEOUT_MS ?? '').trim();
    const parsedTimeout = envTimeout ? Number(envTimeout) : NaN;
    this.timeoutMs =
      options.timeoutMs ?? (Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 120_000);
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

  /** 发一条对话（串行队列）：返回 DSH 的最终回复文本；失败抛 DshError。 */
  chat(text: string): Promise<string> {
    const content = (text ?? '').trim();
    if (!content) return Promise.resolve('');
    return new Promise((resolve, reject) => {
      this.pending.push({ text: content, resolve, reject });
      void this.processQueue();
    });
  }

  /** 桥接 DSH 前后台没有 DSH web 时，自动最小化拉起一次；失败不阻断 headless 对话。 */
  private async ensureWebRunning(): Promise<void> {
    if (this.webPid) return;
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

  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.ensureWebRunning();
      while (this.pending.length > 0) {
        const item = this.pending.shift();
        if (!item) continue;
        this.busy = true;
        try {
          item.resolve(await this.runChat(item.text));
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

  private async runChat(text: string): Promise<string> {
    if (this.commandInvalid) {
      throw new DshError('NOT_FOUND', this.lastError ?? 'dsh 命令不可用');
    }
    try {
      return await this.runChatOnce(text);
    } catch (err) {
      if (err instanceof DshError && err.code === 'EXIT' && this.sessionId && looksLikeInvalidSession(err.stderr)) {
        this.resetSession();
        return this.runChatOnce(text);
      }
      throw err;
    }
  }

  private runChatOnce(text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = ['--profile', 'headless', '--json'];
      if (this.sessionId) args.push('--session-id', this.sessionId);
      args.push('-');
      const plan = buildDshSpawnPlan(this.commandPath, args);
      const gen = this.generation;

      let finished = false;
      let resultText = '';
      let stdoutBuf = '';
      const stderrChunks: Buffer[] = [];
      let timer: NodeJS.Timeout | null = null;

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        this.currentProcess = null;
        this.abortCurrent = null;
      };
      const finish = (result: string): void => {
        if (finished) return;
        if (gen !== this.generation) { cleanup(); return; }
        finished = true;
        cleanup();
        resolve(result);
      };
      const fail = (err: DshError): void => {
        if (finished) return;
        if (gen !== this.generation) { cleanup(); return; }
        finished = true;
        cleanup();
        this.lastError = err.message;
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
        stderrChunks.push(d);
      });
      proc.stdout?.on('data', (d: Buffer) => {
        if (gen !== this.generation) return;
        stdoutBuf += d.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) {
          const evt = parseDshLine(line);
          if (!evt) continue;
          if (evt.type === 'session' && typeof evt.sessionId === 'string' && evt.sessionId) {
            this.saveSession(evt.sessionId);
          } else if (evt.type === 'text' && typeof evt.text === 'string') {
            resultText += evt.text;
          } else if (evt.type === 'final' && typeof evt.text === 'string') {
            finish(evt.text.trim() ? evt.text : resultText.trim());
          }
        }
      });
      proc.on('close', (code) => {
        if (finished || gen !== this.generation) return;
        if (code === 0) {
          const textOnly = resultText.trim();
          if (!textOnly) {
            fail(new DshError('EXIT', 'DSH 未返回内容（final/text 均为空）'));
            return;
          }
          finish(textOnly);
        } else {
          const stderrText = decodeConsoleBytes(Buffer.concat(stderrChunks));
          const detail = stderrText.trim() ? `：${stderrText.trim().slice(-200)}` : '';
          const error = new DshError('EXIT', `DSH 进程异常退出（code ${code ?? '?'}）${detail}`);
          error.stderr = stderrText;
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
