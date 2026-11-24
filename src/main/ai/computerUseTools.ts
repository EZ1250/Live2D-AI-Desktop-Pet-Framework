/**
 * computerUseTools.ts —— 桌宠内置 Windows 电脑控制工具（不依赖 DSH 插件）。
 * UI 定位/动作：本地 ui-helper/PetUi.exe（UIAutomation）
 * 鼠标/键盘：本地 mouse-helper/PetMouse.exe（PerMonitorV2 + SendInput/mouse_event）
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, screen } from 'electron';
import { runPetMouse } from './mouseControl';

const activeUiHelpers = new Set<ChildProcess>();

/** 应用退出时清理由电脑控制工具启动的 UI 子进程 */
export function killActiveUiHelpers(): void {
  for (const child of activeUiHelpers) {
    try { child.kill(); } catch { /* ignore */ }
  }
  activeUiHelpers.clear();
}

function resolveUiHelper(): string {
  const candidates: string[] = [];
  try {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ui-helper', 'PetUi.exe'));
  } catch { /* ignore */ }
  try {
    candidates.push(path.join(app.getAppPath(), 'local-assets', 'ui-helper', 'PetUi.exe'));
  } catch { /* ignore */ }
  // 开发态/测试态兜底（dist/main/ai → 项目根）
  try { candidates.push(path.resolve(__dirname, '..', '..', '..', 'local-assets', 'ui-helper', 'PetUi.exe')); } catch { /* ignore */ }
  try { candidates.push(path.join(process.cwd(), 'local-assets', 'ui-helper', 'PetUi.exe')); } catch { /* ignore */ }
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}

function b64(text: unknown): string {
  return Buffer.from(String(text ?? ''), 'utf8').toString('base64');
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function selectorArgs(args: any): string[] {
  return [
    b64(args?.name),
    String(args?.control_type ?? ''),
    b64(args?.automation_id),
    b64(args?.class_name),
    String(Math.max(0, Math.round(num(args?.index, 0)))),
  ];
}

function runUi(args: string[], timeoutMs = 10000): Promise<any> {
  const exe = resolveUiHelper();
  if (!exe) return Promise.reject(new Error('内置 UI 助手未安装（ui-helper/PetUi.exe）'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    activeUiHelpers.add(child);
    const cleanup = (): void => { activeUiHelpers.delete(child); };
    let out = '';
    let err = '';
    child.stdout?.on('data', (c: Buffer) => { out += c.toString('utf8'); });
    child.stderr?.on('data', (c: Buffer) => { err += c.toString('utf8'); });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      cleanup();
      reject(new Error('UI 助手执行超时'));
    }, Math.max(1000, Math.min(30000, timeoutMs)));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(new Error(`UI 助手启动失败：${e.message}`));
    });
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      let parsed: any = null;
      try { parsed = JSON.parse(out); } catch { /* ignore */ }
      if (code !== 0 || !parsed || parsed.ok === false) {
        reject(new Error(parsed?.error || err.trim() || `UI 助手退出（code=${code ?? 'null'}）`));
        return;
      }
      resolve(parsed.data);
    });
  });
}

function dipToPhysical(x: number, y: number): { x: number; y: number } {
  try { return screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) }); } catch { return { x: Math.round(x), y: Math.round(y) }; }
}

export async function executeComputerTool(name: string, rawArgs: unknown): Promise<string> {
  const args = (rawArgs ?? {}) as any;
  const hwnd = Math.round(num(args.hwnd, 0));
  switch (name) {
    case 'computer_list_windows': {
      const data = await runUi(['windows', b64(args.filter || ''), String(Math.max(1, Math.min(100, Math.round(num(args.limit, 30)))))]);
      return JSON.stringify(data);
    }
    case 'computer_ui_tree': {
      if (!hwnd) return '缺少 hwnd，请先用 computer_list_windows 获取窗口句柄。';
      const data = await runUi(['tree', String(hwnd), String(Math.max(1, Math.min(8, Math.round(num(args.depth, 4))))), String(Math.max(10, Math.min(1500, Math.round(num(args.max_nodes, 500)))))]);
      return JSON.stringify(data);
    }
    case 'computer_ui_find': {
      if (!hwnd) return '缺少 hwnd。';
      const data = await runUi(['find', String(hwnd), ...selectorArgs(args), String(Math.max(1, Math.min(50, Math.round(num(args.limit, 10))))),]);
      return JSON.stringify(data);
    }
    case 'computer_window_activate': {
      if (!hwnd) return '缺少 hwnd。';
      const data = await runUi(['activate', String(hwnd)]);
      return JSON.stringify(data);
    }
    case 'computer_ui_click': {
      if (!hwnd) return '缺少 hwnd。';
      const button = args.button === 'right' ? 'right' : 'left';
      const data = await runUi(['click', String(hwnd), ...selectorArgs(args), button]);
      return JSON.stringify(data);
    }
    case 'computer_ui_type': {
      const text = String(args.text ?? '');
      if (!text) return 'text 不能为空。';
      if (hwnd && args.name) {
        try {
          const data = await runUi(['setvalue', String(hwnd), ...selectorArgs(args), b64(text)]);
          if (data) return JSON.stringify(data);
        } catch {
          // ValuePattern 不可用时回退到焦点 + 剪贴板输入
          await runUi(['focus', String(hwnd), ...selectorArgs(args)]).catch(() => null);
        }
      }
      await runPetMouse(['text', b64(text)], 4000);
      return `已输入 ${Array.from(text).length} 个字符`;
    }
    case 'computer_key_press': {
      const keys = String(args.keys ?? '').trim();
      if (!keys) return 'keys 不能为空，例如 "ctrl+a" 或 "enter"。';
      await runPetMouse(['key', keys], 3000);
      return `已发送按键：${keys}`;
    }
    case 'computer_mouse_scroll': {
      const x = num(args.x, NaN), y = num(args.y, NaN);
      let px = 0, py = 0;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const p = dipToPhysical(x, y);
        px = p.x; py = p.y;
      }
      const delta = Math.max(-1200, Math.min(1200, Math.round(num(args.delta, 3)) * 120));
      const horizontal = args.horizontal === true;
      await runPetMouse(['scroll', String(px), String(py), String(delta), horizontal ? 'h' : 'v'], 3000);
      return `已滚动 ${delta > 0 ? '向上' : '向下'} ${Math.abs(Math.round(num(args.delta, 3)))} 格`;
    }
    case 'computer_screen_click': {
      const x = num(args.x, NaN), y = num(args.y, NaN);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return '缺少屏幕坐标 x/y。';
      const p = dipToPhysical(x, y);
      const button = args.button === 'right' ? 'right' : 'left';
      const double = args.double === true;
      if (double && button === 'left') {
        await runPetMouse(['move', String(p.x), String(p.y)]);
        await runPetMouse(['doubleclick']);
      } else if (button === 'right') {
        await runPetMouse(['moverightclick', String(p.x), String(p.y)]);
      } else {
        await runPetMouse(['moveclick', String(p.x), String(p.y)]);
      }
      return `已${double ? '双击' : button === 'right' ? '右键' : '单击'} (${p.x}, ${p.y})`;
    }
    default:
      return `未知电脑控制工具：${name}`;
  }
}
