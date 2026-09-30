/**
 * devTools —— 「动手干活」能力：建目录 / 写文件 / 精确改文件 / 执行命令
 *
 * 设计要点：
 *  - 一切操作限制在用户在设置里指定的**开发工作区根目录**内；未配置则全部拒绝。
 *  - 路径同时接受「相对路径」与「位于根目录内的绝对路径」，并挡住 `..` 逃逸、UNC、
 *    盘符相对路径（C:foo）以及通过符号链接逃出根目录的情况。
 *  - 写文件/改文件用「临时文件 + rename」原子替换，避免写一半崩掉留半截文件。
 *  - 执行命令用 PowerShell（优先 pwsh.exe，缺失则回退 powershell.exe），非交互、有超时上限、
 *    输出截断；明显破坏性的命令在执行前就被 isDangerousCommand 拦下。
 *  - 本模块不 import electron，全部函数**不抛异常**，失败以中文文本返回，方便无头测试。
 *
 * 注意：真正的「是否允许执行」由主进程的确认框负责（每次调用都会问用户）；这里只做安全兜底。
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';

let workspaceRoot = '';
/** 记住上一条命令实际使用的目录（命令之间不必反复传 cwd；换工作区时重置） */
let lastCwd = '';

/** 记住的目录是否仍可用：存在、是目录、且仍在工作区内 */
function usableLastCwd(): string {
  if (!lastCwd || !workspaceRoot) return '';
  try {
    if (!fs.existsSync(lastCwd) || !fs.statSync(lastCwd).isDirectory()) return '';
    const rel = path.relative(workspaceRoot, lastCwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return '';
    return lastCwd;
  } catch {
    return '';
  }
}

/** 归一化根目录：绝对路径 + 去掉尾部斜杠（保留系统分隔符，Windows 下混用正斜杠会引入麻烦） */
function normalizeRoot(root: string): string {
  const abs = path.resolve(root);
  return abs.length > 3 ? abs.replace(/[\\/]+$/, '') : abs;
}

/** 设置/刷新工作区根目录（主进程在每次工具调用前用最新设置刷新）。root 为空字符串 = 未配置。 */
export function setWorkspaceRoot(root: string): void {
  const next = root && root.trim() ? normalizeRoot(root.trim()) : '';
  if (next !== workspaceRoot) lastCwd = ''; // 换工作区 → 忘掉旧目录
  workspaceRoot = next;
}

export function getWorkspaceRoot(): string {
  // 单一真源：设置里选的工作区优先，其次环境变量（测试/命令行）。未配置返回空串。
  // 本模块刻意不 import electron，"未配置时的兜底目录"由调用方（workTools）自己补。
  if (workspaceRoot) return workspaceRoot;
  const env = process.env.PET_WORKSPACE_ROOT;
  return env && env.trim() ? normalizeRoot(env.trim()) : '';
}

const NOT_CONFIGURED = '未配置开发工作区：请在右键设置里选择「开发工作区」文件夹后再让我动手。';

interface Resolved {
  ok: true;
  abs: string;
  rel: string;
}
interface Rejected {
  ok: false;
  reason: string;
}

/** target 是否位于 root 之内（含 root 自身） */
function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 解析并校验路径；失败返回中文原因 */
function resolveInRoot(input: unknown): Resolved | Rejected {
  if (!workspaceRoot) return { ok: false, reason: NOT_CONFIGURED };
  if (typeof input !== 'string' || !input.trim()) return { ok: false, reason: '路径必须是非空字符串。' };
  const raw = input.trim();
  if (/^\\\\/.test(raw)) return { ok: false, reason: '不允许使用 UNC 路径（\\\\server\\share）。' };
  // 盘符相对路径（C:foo）：有盘符但第 3 个字符不是分隔符
  if (/^[a-zA-Z]:(?![\\/])/.test(raw)) return { ok: false, reason: '不允许使用盘符相对路径（如 C:foo）。' };
  // 通配符不参与文件读写
  if (/[*?]/.test(raw)) return { ok: false, reason: '路径不能包含通配符。' };

  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(workspaceRoot, raw);
  if (!isInside(workspaceRoot, abs)) return { ok: false, reason: '路径越界：只能操作开发工作区内的文件。' };

  // 符号链接检查：校验最近的已存在祖先 + 目标自身（目标不存在时父目录可能是软链）
  try {
    const realRoot = fs.realpathSync(workspaceRoot);
    let probe = abs;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
    if (!isInside(realRoot, fs.realpathSync(probe))) {
      return { ok: false, reason: '路径越界：该路径经符号链接指向了工作区之外。' };
    }
    if (fs.existsSync(abs) && !isInside(realRoot, fs.realpathSync(abs))) {
      return { ok: false, reason: '路径越界：该路径经符号链接指向了工作区之外。' };
    }
  } catch {
    /* realpath 失败（权限等）：交给后续真实 IO 报错 */
  }

  const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/') || '.';
  return { ok: true, abs, rel };
}

/**
 * 需要 BOM 的扩展名：Windows PowerShell 5.1 读 .ps1 默认按 ANSI(GBK) 解码，
 * UTF-8 无 BOM 的中文会变成乱码（实测：脚本里一句中文标题就会 `char:45` 解析失败）。
 * .bat/.cmd 同理（cmd 按当前代码页读）。写这些文件时补一个 UTF-8 BOM，中文脚本才能直接跑。
 */
const BOM_EXTENSIONS = new Set(['.ps1', '.psm1', '.bat', '.cmd']);

function withBomIfNeeded(abs: string, content: string): string {
  const ext = path.extname(abs).toLowerCase();
  if (!BOM_EXTENSIONS.has(ext)) return content;
  return content.startsWith('\uFEFF') ? content : `\uFEFF${content}`;
}

/** 原子写：写临时文件再 rename 覆盖；失败回退直接写 */
function atomicWrite(abs: string, content: string): void {
  const payload = withBomIfNeeded(abs, content);
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, payload, 'utf8');
  try {
    fs.renameSync(tmp, abs);
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 临时文件可能已不在 */
    }
    fs.writeFileSync(abs, payload, 'utf8');
  }
}

function shortError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.length > 200 ? `${msg.slice(0, 200)}…` : msg;
}

/** 在根目录内建立目录（递归创建父目录） */
export function devMkdir(args: { path?: unknown }): string {
  const r = resolveInRoot(args?.path);
  if (!r.ok) return r.reason;
  try {
    if (fs.existsSync(r.abs)) {
      return fs.statSync(r.abs).isDirectory()
        ? `目录已存在：${r.rel}`
        : `无法创建：${r.rel} 已存在且不是目录。`;
    }
    fs.mkdirSync(r.abs, { recursive: true });
    return `已创建目录：${r.rel}`;
  } catch (err) {
    return `创建目录失败：${shortError(err)}`;
  }
}

/** 创建/覆盖文件（自动建父目录） */
export function devWrite(args: { path?: unknown; content?: unknown }): string {
  const r = resolveInRoot(args?.path);
  if (!r.ok) return r.reason;
  if (typeof args?.content !== 'string') return 'content 必须是字符串（空字符串表示创建空文件）。';

  const bytes = Buffer.byteLength(args.content, 'utf8');
  const MAX_BYTES = 2 * 1024 * 1024;
  if (bytes > MAX_BYTES) {
    return `内容过大：${Math.round(bytes / 1024)} KB，单次写入上限 2 MB。请拆成多次写入。`;
  }

  try {
    let existed = false;
    let oldLines = 0;
    if (fs.existsSync(r.abs)) {
      if (fs.statSync(r.abs).isDirectory()) return `无法写入：${r.rel} 是一个目录。`;
      existed = true;
      oldLines = fs.readFileSync(r.abs, 'utf8').split(/\r?\n/).length;
    }
    fs.mkdirSync(path.dirname(r.abs), { recursive: true });
    atomicWrite(r.abs, args.content);

    const newLines = args.content.split(/\r?\n/).length;
    const sizeKb = (bytes / 1024).toFixed(1);
    return existed
      ? `已覆盖文件：${r.rel}（原 ${oldLines} 行 → 新 ${newLines} 行，${sizeKb} KB）`
      : `已创建文件：${r.rel}（${newLines} 行，${sizeKb} KB）`;
  } catch (err) {
    return `写入文件失败：${shortError(err)}`;
  }
}

/** 精确字符串替换（old_string 必须唯一，除非 replace_all） */
export function devEdit(args: {
  path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
  replace_all?: unknown;
}): string {
  const r = resolveInRoot(args?.path);
  if (!r.ok) return r.reason;
  const oldStr = args?.old_string;
  const newStr = args?.new_string;
  if (typeof oldStr !== 'string' || !oldStr) return 'old_string 必须是非空字符串。';
  if (typeof newStr !== 'string') return 'new_string 必须是字符串。';
  if (oldStr === newStr) return 'old_string 与 new_string 相同，无需修改。';

  try {
    if (!fs.existsSync(r.abs)) return `文件不存在：${r.rel}。请先用 workspace_search 找到正确路径。`;
    if (!fs.statSync(r.abs).isFile()) return `不是文件：${r.rel}。`;
    const size = fs.statSync(r.abs).size;
    if (size > 8 * 1024 * 1024) return `文件过大（${Math.round(size / 1024)} KB），改文件上限 8 MB。`;

    const content = fs.readFileSync(r.abs, 'utf8');
    const count = content.split(oldStr).length - 1;
    if (count === 0) return `未找到要替换的内容（${r.rel}）。请先用 workspace_file_read 确认原文。`;
    if (count > 1 && args?.replace_all !== true) {
      return `匹配到 ${count} 处，无法确定改哪一处：请补足更多上下文使其唯一，或传 replace_all: true 全部替换。`;
    }

    const next = args?.replace_all === true ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    atomicWrite(r.abs, next);

    const oldLines = content.split(/\r?\n/).length;
    const newLines = next.split(/\r?\n/).length;
    const diff = newLines - oldLines;
    const replaced = args?.replace_all === true ? count : 1;
    return `已修改 ${r.rel}：替换 ${replaced} 处（${diff >= 0 ? '+' : ''}${diff} 行）`;
  } catch (err) {
    return `修改文件失败：${shortError(err)}`;
  }
}

const DANGEROUS_RULES: Array<{ test: (cmd: string, parts: string[]) => boolean; reason: string }> = [
  {
    test: (_cmd, parts) => parts.some((p) => /^(format|diskpart|bcdedit)\b/.test(p) || /vssadmin\s+delete/.test(p) || /cipher\s+\/w/.test(p)),
    reason: '涉及磁盘格式化/分区/引导的破坏性命令',
  },
  {
    test: (_cmd, parts) => parts.some((p) => /^(shutdown|logoff)\b/.test(p) || /^(restart-computer|stop-computer)\b/.test(p)),
    reason: '关机 / 重启 / 注销类命令',
  },
  {
    test: (cmd, parts) =>
      parts.some(
        (p) =>
          /^(rd|rmdir)\s+\/s/.test(p) ||
          /^del\s+.*\/[fs]/i.test(p) ||
          /^rm\s+-[rf]{1,2}\s+\/(\s|$)/.test(p) ||
          (/^(remove-item|ri)\b/.test(p) && /-recurse/.test(p) && /([a-z]:\\(windows|program files|users|\*)?\s*$|[a-z]:\\?(\s|$))/i.test(p)),
      ) || /remove-item[^\n]*([a-z]:\\windows|[a-z]:\\\*)/i.test(cmd),
    reason: '批量删除系统目录或整个磁盘的命令',
  },
  {
    test: (_cmd, parts) =>
      parts.some((p) => /^net\s+(user|localgroup)\b/.test(p) || /^(takeown|icacls)\b/.test(p) || /^reg\s+delete\b/.test(p)),
    reason: '账户 / 权限 / 注册表变更类命令',
  },
  {
    test: (_cmd, parts) => parts.some((p) => /^schtasks\b.*\/create/.test(p) || /^sc\s+delete\b/.test(p) || /^new-service\b/.test(p)),
    reason: '计划任务 / 系统服务变更类命令',
  },
  {
    test: (cmd) =>
      /invoke-expression|downloadstring|\biex\s*\(|\|\s*iex\b/i.test(cmd) ||
      /(curl|iwr|invoke-webrequest)[^\n|]*\|\s*(iex|sh|bash)/i.test(cmd),
    reason: '从网络下载并直接执行的命令',
  },
  {
    test: (_cmd, parts) => parts.some((p) => /^set-executionpolicy\b/.test(p) || /^start-process\b.*-verb\s+runas/.test(p)),
    reason: '提权 / 绕过执行策略的命令',
  },
];

/** 危险命令检查：命中返回中文拒绝原因，未命中返回 null */
export function isDangerousCommand(command: string): string | null {
  const cmd = String(command ?? '').toLowerCase().trim();
  if (!cmd) return null;
  // 按 ; & | 拆成子命令，避免 `git commit -m "format"` 这类被整串误伤
  const parts = cmd
    .split(/[;&|]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  for (const rule of DANGEROUS_RULES) {
    if (rule.test(cmd, parts)) return rule.reason;
  }
  return null;
}

interface ShellRunOutcome {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  missingShell?: boolean;
}

/** 结束整个进程树（Windows 上孙进程——PowerPoint / python 子进程——不会随父进程一起死） */
function killTree(child: ReturnType<typeof spawn>): void {
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    }
  } catch {
    /* ignore */
  }
  try {
    child.kill();
  } catch {
    /* ignore */
  }
}

/** 起一个 PowerShell 子进程跑一条命令（单次，不含回退逻辑） */
function runShellOnce(shellPath: string, fullCommand: string, cwd: string, timeoutMs: number): Promise<ShellRunOutcome> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(shellPath, ['-NoProfile', '-NonInteractive', '-Command', fullCommand], {
        cwd,
        windowsHide: true,
        // stdin 给 null：命令若读输入立刻拿到 EOF，而不是傻等（否则又是一处"卡死"）
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', error: shortError(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      clearTimeout(timer);
      resolve({ ok: !timedOut, code, stdout, stderr, error: timedOut ? `__TIMEOUT__${timeoutMs}` : undefined });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // 超时不再等管道关闭：直接收尾（孙进程可能还占着管道，等下去就是永久卡死）
      setTimeout(() => finish(null), 200);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      if (graceTimer) clearTimeout(graceTimer);
      clearTimeout(timer);
      resolve({
        ok: false,
        code: null,
        stdout,
        stderr,
        error: shortError(err),
        missingShell: err?.code === 'ENOENT',
      });
    });
    // ★ 关键：以 'exit' 为准，而不是 'close'。
    //   'close' 要等所有 stdio 关闭；命令里只要启动过带继承管道的孙进程
    //   （Start-Process / Invoke-Item / PowerPoint COM / python 起的子进程），
    //   父进程退出后管道仍然开着 → 'close' 永不触发 → 工具调用就"卡死"了。
    //   这里给 400ms 宽限收尾剩下的输出，然后无论如何都返回。
    child.on('exit', (code) => {
      if (settled) return;
      graceTimer = setTimeout(() => finish(code), 400);
    });
    child.on('close', (code) => finish(code));
  });
}

/** 执行 PowerShell 命令：返回退出码 + stdout/stderr 摘要 */
export async function devShell(args: { command?: unknown; cwd?: unknown; timeout_ms?: unknown }): Promise<string> {
  if (!workspaceRoot) return NOT_CONFIGURED;
  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  if (!command) return '命令不能为空。';
  if (command.length > 2000) return `命令过长（${command.length} 字符），上限 2000 字符。`;

  const danger = isDangerousCommand(command);
  if (danger) return `已拒绝危险命令（${danger}），未执行。`;

  let cwd = workspaceRoot;
  if (args?.cwd !== undefined && args?.cwd !== null && args?.cwd !== '') {
    const r = resolveInRoot(args.cwd);
    if (!r.ok) return `工作目录无效：${r.reason}`;
    if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isDirectory()) return `工作目录不存在：${r.rel}`;
    cwd = r.abs;
  } else {
    // 没显式指定 → 继承上一条命令的目录（像终端一样），换工作区时已重置
    cwd = usableLastCwd() || workspaceRoot;
  }

  const rawTimeout = typeof args?.timeout_ms === 'number' && Number.isFinite(args.timeout_ms) ? args.timeout_ms : 60_000;
  const timeoutMs = Math.max(1_000, Math.min(Math.round(rawTimeout), 300_000));
  const prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';
  const full = prefix + command;

  let outcome = await runShellOnce('pwsh.exe', full, cwd, timeoutMs);
  if (!outcome.ok && outcome.missingShell) {
    // 没装 PowerShell 7 的机器回退到 Windows PowerShell 5.1
    outcome = await runShellOnce('powershell.exe', full, cwd, timeoutMs);
  }
  if (!outcome.ok && outcome.missingShell) {
    return '执行失败：本机既没有 pwsh.exe 也没有 powershell.exe。';
  }
  if (outcome.error === `__TIMEOUT__${timeoutMs}`) {
    lastCwd = cwd;
    return `命令执行超时（${Math.round(timeoutMs / 1000)}s）已被终止。若命令确实需要更久，请拆小或调大 timeout_ms（上限 300s）。`;
  }
  if (!outcome.ok && outcome.error) {
    return `命令启动失败：${outcome.error}`;
  }

  const truncate = (text: string): string =>
    text.length > 8000 ? `${text.slice(0, 8000)}\n…（输出已截断，共 ${text.length} 字符）` : text;
  const stdout = truncate(outcome.stdout).trim();
  const stderr = truncate(outcome.stderr).trim();
  lastCwd = cwd;
  const relCwd = path.relative(workspaceRoot, cwd).split(path.sep).join('/') || '.';
  return [
    `命令已执行（退出码 ${outcome.code ?? '未知'}）`,
    '--- stdout ---',
    stdout || '（空）',
    '--- stderr ---',
    stderr || '（空）',
    `（当前目录：${relCwd}）`,
  ].join('\n');
}

// ==================== 后台任务管理 ====================

interface BgTask {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  status: 'running' | 'done' | 'failed' | 'killed';
  exitCode: number | null;
  process: ReturnType<typeof spawn> | null;
  stdoutTail: string;
  stderrTail: string;
}

let bgTasks: BgTask[] = [];
let taskIdCounter = 1;

function addBgTask(task: BgTask): void {
  bgTasks.push(task);
  // 保持最多8个任务，移除最旧的已结束任务
  if (bgTasks.length > 8) {
    const oldestFinishedIndex = bgTasks.findIndex(t =>
      t.status !== 'running'
    );
    if (oldestFinishedIndex !== -1) {
      bgTasks.splice(oldestFinishedIndex, 1);
    } else {
      // 如果都是运行中的任务，移除最旧的一个
      bgTasks.shift();
    }
  }
}

function findBgTask(id: string): BgTask | undefined {
  return bgTasks.find(task => task.id === id);
}

/** 每个任务只保留最后 4000 字符输出 */
const BG_OUTPUT_TAIL_CHARS = 4000;

function updateTaskOutput(task: BgTask, data: string, isStderr = false): void {
  const next = (isStderr ? task.stderrTail : task.stdoutTail) + data;
  const truncated = next.length > BG_OUTPUT_TAIL_CHARS ? next.slice(-BG_OUTPUT_TAIL_CHARS) : next;
  if (isStderr) task.stderrTail = truncated;
  else task.stdoutTail = truncated;
}

/** 启动后台命令，立刻返回任务信息（不等待） */
export function devShellStart(args: { command?: unknown; cwd?: unknown }): string {
  if (!workspaceRoot) return NOT_CONFIGURED;

  const command = typeof args?.command === 'string' ? args.command.trim() : '';
  if (!command) return '命令不能为空。';
  if (command.length > 2000) return `命令过长（${command.length} 字符），上限 2000 字符。`;

  const danger = isDangerousCommand(command);
  if (danger) return `已拒绝危险命令（${danger}），未执行。`;

  let cwd = workspaceRoot;
  if (args?.cwd !== undefined && args?.cwd !== null && args?.cwd !== '') {
    const r = resolveInRoot(args.cwd);
    if (!r.ok) return `工作目录无效：${r.reason}`;
    if (!fs.existsSync(r.abs) || !fs.statSync(r.abs).isDirectory()) return `工作目录不存在：${r.rel}`;
    cwd = r.abs;
  } else {
    cwd = usableLastCwd() || workspaceRoot;
  }

  const taskId = `bg-${taskIdCounter++}`;
  const prefix = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; ';
  const fullCommand = prefix + command;

  let child: ReturnType<typeof spawn>;
  const spawnShell = (exe: string): ReturnType<typeof spawn> =>
    spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', fullCommand], {
      cwd,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    });
  child = spawnShell('pwsh.exe');
  // spawn 对"可执行文件不存在"是异步报 ENOENT（不是同步抛错），所以用 error 事件回退到 Windows PowerShell
  // 回退失败（连 powershell.exe 也没有）时同样走失败分支：否则 ChildProcess 的 'error' 无人接收
  // 会变成未处理事件（EventEmitter 直接抛出），任务会永远停在 running。
  const onSpawnError = (proc: ReturnType<typeof spawn>): void => {
    proc.on('error', (err: NodeJS.ErrnoException) => {
      if (err?.code === 'ENOENT' && proc === child) {
        try {
          const retry = spawnShell('powershell.exe');
          child = retry;
          task.process = retry;
          wire(retry);
          onSpawnError(retry);
          return;
        } catch {
          /* 落到下面的失败分支 */
        }
      }
      task.status = 'failed';
      task.exitCode = null;
      task.process = null;
      updateTaskOutput(task, `进程启动失败: ${err.message}`, true);
    });
  };

  const task: BgTask = {
    id: taskId,
    command,
    cwd,
    startedAt: Date.now(),
    status: 'running',
    exitCode: null,
    process: child,
    stdoutTail: '',
    stderrTail: '',
  };

  const wire = (proc: ReturnType<typeof spawn>): void => {
    proc.stdout?.on('data', (data: Buffer | string) => {
      updateTaskOutput(task, String(data));
    });
    proc.stderr?.on('data', (data: Buffer | string) => {
      updateTaskOutput(task, String(data), true);
    });
    proc.on('close', (code) => {
      task.status = code === 0 ? 'done' : 'failed';
      task.exitCode = code;
      task.process = null;
    });
  };
  wire(child);
  onSpawnError(child);

  addBgTask(task);

  return `已启动后台任务 ${taskId}：${command}`;
}

/** 查看后台任务（不传 id 则列出全部；最多保留 8 个任务，超出丢弃最旧的已结束任务） */
export function devShellOutput(args: { id?: unknown; maxChars?: unknown }): string {
  if (!workspaceRoot) return NOT_CONFIGURED;

  const id = typeof args?.id === 'string' ? args.id : '';
  const maxChars = Math.max(200, Math.min(4000,
    typeof args?.maxChars === 'number' ? Math.floor(args.maxChars) : 2000
  ));

  if (id) {
    const task = findBgTask(id);
    if (!task) {
      return `没有这个后台任务：${id}`;
    }

    const duration = Math.round((Date.now() - task.startedAt) / 1000);
    const exitCodeDisplay = task.exitCode !== null ? task.exitCode : '—';

    // 截取stdout和stderr
    const stdoutPreview = task.stdoutTail.length > maxChars
      ? task.stdoutTail.slice(-maxChars)
      : task.stdoutTail;

    const stderrPreview = task.stderrTail.length > maxChars
      ? task.stderrTail.slice(-maxChars)
      : task.stderrTail;

    const relCwdForDisplay = path.relative(workspaceRoot, task.cwd).split(path.sep).join('/') || '.';
    return [
      `任务 ${task.id}（${task.status}）命令：${task.command} 当前目录：${relCwdForDisplay} 已运行 ${duration}s 退出码：${exitCodeDisplay}`,
      '--- stdout 末尾 ---',
      stdoutPreview || '（空）',
      '--- stderr 末尾 ---',
      stderrPreview || '（空）'
    ].join('\n');
  } else {
    if (bgTasks.length === 0) {
      return '当前没有后台任务。';
    }

    return bgTasks.map(task => {
      const duration = Math.round((Date.now() - task.startedAt) / 1000);
      return `${task.id} ${task.status} ${duration}s  ${task.command}`;
    }).join('\n');
  }
}

/** 终止后台任务 */
export function devShellKill(args: { id?: unknown }): string {
  if (!workspaceRoot) return NOT_CONFIGURED;

  const id = typeof args?.id === 'string' ? args.id : '';
  if (!id) {
    return '请提供要终止的任务ID。';
  }

  const task = findBgTask(id);
  if (!task) {
    return `没有这个后台任务：${id}`;
  }

  if (task.status !== 'running') {
    return `任务 ${id} 已经结束（${task.status}）。`;
  }

  if (task.process) {
    try {
      task.process.kill();
    } catch (err) {
      // 忽略错误，直接标记为killed
    }
  }

  task.status = 'killed';
  task.exitCode = null;
  task.process = null;

  return `已终止后台任务 ${id}。`;
}

// 清理所有后台任务（当工作区变更时调用）
export function clearBgTasks(): void {
  for (const task of bgTasks) {
    if (task.process && task.status === 'running') {
      try {
        task.process.kill();
      } catch (err) {
        // 忽略错误
      }
    }
  }
  bgTasks = [];
}
