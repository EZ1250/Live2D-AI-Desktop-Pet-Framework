/**
 * mouseControl.ts —— 投屏鼠标（移动/左键/右键）+ 手机输入法注入 + 视线原点定位。
 * 坐标：投屏 x/y 为 0~1（相对所选显示器），视线原点直接用屏幕 DIP 坐标。
 * PetMouse.exe 保持 DPI-unaware，与桌宠窗口坐标一致。
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { app, screen } from 'electron';

const activeMouseHelpers = new Set<ChildProcess>();

/** 应用退出时清理仍在跑的 PetMouse 子进程（防止孤儿进程） */
export function killActiveMouseHelpers(): void {
  for (const child of activeMouseHelpers) {
    try { child.kill(); } catch { /* ignore */ }
  }
  activeMouseHelpers.clear();
}

function resolveHelper(): string {
  const candidates: string[] = [];
  try {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'mouse-helper', 'PetMouse.exe'));
  } catch { /* ignore */ }
  try {
    candidates.push(path.join(app.getAppPath(), 'local-assets', 'mouse-helper', 'PetMouse.exe'));
  } catch { /* ignore */ }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}

function runHelperCapture(args: string[], timeoutMs = 2500): Promise<string> {
  const exe = resolveHelper();
  if (!exe) return Promise.reject(new Error('未找到鼠标控制助手 PetMouse.exe（请重新构建/安装电脑端）'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeMouseHelpers.add(child);
    const cleanup = (): void => { activeMouseHelpers.delete(child); };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch (e) { console.warn('[mouse] kill helper failed:', (e as Error).message); }
      cleanup();
      reject(new Error('鼠标控制超时'));
    }, Math.max(500, Math.min(5000, timeoutMs)));
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`鼠标控制助手启动失败：${err.message}`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `鼠标控制助手退出（code=${code ?? 'null'}）`));
    });
  });
}

/** 直接执行 PetMouse 命令并返回 stdout（供内置电脑控制工具用） */
export async function runPetMouse(args: string[], timeoutMs = 3000): Promise<string> {
  return runHelperCapture(args, timeoutMs);
}

async function runHelper(args: string[], timeoutMs = 2500): Promise<void> {
  await runHelperCapture(args, timeoutMs);
}

function displayList() {
  const primary = screen.getPrimaryDisplay();
  const others = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...others];
}

function dipToPhysical(point: { x: number; y: number }): { x: number; y: number } {
  try {
    // PetMouse 是 Per-Monitor V2：SetCursorPos 需要物理像素；Electron bounds 是 DIP
    return screen.dipToScreenPoint(point);
  } catch {
    return point;
  }
}

function toScreenPoint(nx: number, ny: number, displayIndex = 1): { x: number; y: number } {
  const displays = displayList();
  const display = displays[Math.max(0, Math.min(displays.length - 1, Math.round(displayIndex) - 1))] ?? screen.getPrimaryDisplay();
  const b = display.bounds;
  const dip = {
    x: Math.round(b.x + nx * Math.max(1, b.width - 1)),
    y: Math.round(b.y + ny * Math.max(1, b.height - 1)),
  };
  return dipToPhysical(dip);
}

/** 直接把鼠标移动到屏幕 DIP 坐标（视线原点用） */
export async function moveCursorToScreen(x: number, y: number): Promise<void> {
  const physical = dipToPhysical({ x: Math.round(x), y: Math.round(y) });
  await runHelper(['move', String(physical.x), String(physical.y)], 2000);
}

export async function moveMouse(nx: number, ny: number, displayIndex = 1): Promise<string> {
  const point = toScreenPoint(nx, ny, displayIndex);
  await runHelper(['move', String(point.x), String(point.y)]);
  return `已移动鼠标到 (${point.x}, ${point.y})`;
}

export async function clickMouse(nx: number, ny: number, displayIndex = 1): Promise<string> {
  const point = toScreenPoint(nx, ny, displayIndex);
  await runHelper(['moveclick', String(point.x), String(point.y)]);
  return `已在 (${point.x}, ${point.y}) 左键单击`;
}

export async function rightClickMouse(nx: number, ny: number, displayIndex = 1): Promise<string> {
  const point = toScreenPoint(nx, ny, displayIndex);
  await runHelper(['moverightclick', String(point.x), String(point.y)]);
  return `已在 (${point.x}, ${point.y}) 右键单击`;
}

export async function isEditableFocused(): Promise<boolean> {
  const out = await runHelperCapture(['is-editable'], 1500);
  return out.trim() === '1';
}

export async function typeText(text: string): Promise<string> {
  const value = Array.from(String(text ?? '')).slice(0, 4000).join('');
  if (!value) return '没有可输入的内容';
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  await runHelper(['text', encoded], 3000);
  return `已输入 ${Array.from(value).length} 个字符`;
}
