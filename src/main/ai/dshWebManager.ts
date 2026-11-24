/**
 * dshWebManager.ts —— 检测/启动本机 DSH 后台（Web/桌面）
 *
 * 目标：桌宠桥接 DSH 时，若后台没有 DSH 在跑，就最小化拉起 `dsh web`，避免重复启动。
 * 使用 PowerShell Win32_Process 读取命令行（不依赖端口/HTTP），启动用 Start-Process -WindowStyle Minimized。
 */
import { spawn } from 'node:child_process';

export interface DshWebSpawnPlan {
  command: string;
  args: string[];
  shell?: boolean;
}

export interface DshWebProcess {
  pid: number;
  commandLine: string;
}

/** 纯函数：命令行是否像 DSH web/desktop 后台进程（可单测）。 */
export function isDshWebCommandLine(commandLine: string | null | undefined): boolean {
  if (!commandLine) return false;
  const text = commandLine.replace(/\s+/g, ' ').trim();
  if (!/dsh/i.test(text)) return false;
  // 排除 PowerShell/cmd 自身：它们的命令行里可能包含用于检测的字符串
  if (/^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|wscript(?:\.exe)?|cscript(?:\.exe)?)["']?(?:\s|$)/i.test(text)) return false;
  return /(?:dsh[\\/](?:lib[\\/])?bin\.js\s+(?:web|desktop))|(?:dsh[^\s]*\.exe(?:\s|$))/i.test(text);
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function runPowerShell(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('DSH 进程检测超时'));
    }, Math.max(1000, timeoutMs));
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `PowerShell 退出（code=${code ?? 'null'}）`));
    });
  });
}

/** 查找本机正在运行的 DSH web/desktop 进程。 */
export async function findDshWebProcesses(): Promise<DshWebProcess[]> {
  if (process.platform !== 'win32') return [];
  const script = `
$rows = @()
try {
  $rows = Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    ($_.Name -eq 'node.exe' -and $_.CommandLine -and ($_.CommandLine -match 'dsh[\\\\/](?:lib[\\\\/])?bin\\.js\\s+(web|desktop)')) -or
    ($_.Name -and ($_.Name -match '^dsh[^\\\\/]*\\.exe$'))
  } | Select-Object ProcessId, CommandLine
} catch { }
if ($rows) { $rows | ConvertTo-Json -Compress } else { '' }
`;
  let raw = '';
  try {
    raw = (await runPowerShell(script)).trim();
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const arr = Array.isArray(parsed) ? parsed : [parsed];
    return arr
      .map((item) => {
        const obj = item as Record<string, unknown>;
        const pid = typeof obj.ProcessId === 'number' ? obj.ProcessId : Number(obj.ProcessId);
        const commandLine = typeof obj.CommandLine === 'string' ? obj.CommandLine : '';
        return Number.isFinite(pid) && pid > 0 && isDshWebCommandLine(commandLine) ? { pid, commandLine } : null;
      })
      .filter((item): item is DshWebProcess => item !== null);
  } catch {
    return [];
  }
}

/** 以最小化窗口启动 DSH；优先 PowerShell Start-Process -WindowStyle Minimized。 */
export async function startDshWebMinimized(plan: DshWebSpawnPlan): Promise<number | null> {
  if (process.platform !== 'win32') {
    const child = spawn(plan.command, plan.args, { detached: true, stdio: 'ignore' });
    child.unref();
    return child.pid ?? null;
  }
  const file = plan.shell ? (process.env.ComSpec || 'cmd.exe') : plan.command;
  const args = plan.shell
    ? ['/d', '/s', '/c', plan.command]
    : plan.args;
  const script = `
$file = ${psQuote(file)}
$argList = @(${args.map(psQuote).join(', ')})
$p = Start-Process -FilePath $file -ArgumentList $argList -WindowStyle Minimized -PassThru -ErrorAction Stop
if ($p) { $p.Id }
`;
  try {
    const out = (await runPowerShell(script, 12000)).trim();
    const pid = Number(out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop());
    if (Number.isFinite(pid) && pid > 0) return pid;
  } catch {
    /* 退回 detached spawn（没有最小化窗口，但保证能启动） */
  }
  try {
    const child = spawn(plan.command, plan.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: plan.shell === true,
    });
    child.unref();
    return child.pid ?? null;
  } catch {
    return null;
  }
}

/** 进程级单例：并发聊天/状态查询共用一次启动流程，避免重复拉起 DSH */
let ensureInFlight: Promise<{ pid: number | null; started: boolean }> | null = null;

/** 检测 → 没有则最小化启动 → 轮询确认；返回 pid 和是否由本次启动。 */
export async function ensureDshWebRunning(
  plan: DshWebSpawnPlan,
  opts: { timeoutMs?: number } = {},
): Promise<{ pid: number | null; started: boolean }> {
  if (ensureInFlight) return ensureInFlight;
  ensureInFlight = (async () => {
  const existing = await findDshWebProcesses();
  if (existing.length > 0) return { pid: existing[0].pid, started: false };
  const pid = await startDshWebMinimized(plan);
  const deadline = Date.now() + Math.max(2000, Math.min(20000, opts.timeoutMs ?? 12000));
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
    const found = await findDshWebProcesses();
    if (found.length > 0) return { pid: found[0].pid, started: true };
  }
  return { pid, started: true };
  })().finally(() => { ensureInFlight = null; });
  return ensureInFlight;
}
