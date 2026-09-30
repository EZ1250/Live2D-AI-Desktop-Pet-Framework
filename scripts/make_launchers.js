'use strict';
/**
 * make_launchers.js —— 生成编码正确的 Windows 启动器（.bat）。
 *
 * 两条硬约束（都是踩过坑的）：
 *  1. 中文 Windows 的 cmd.exe 按 **GBK/CP936** 解析 .bat。用 UTF-8 存中文注释会被解成乱码、
 *     把命令行切碎，报 "'xxx' 不是内部或外部命令"。所以正文**只用 ASCII**。
 *  2. Chromium 解析命令行时，`--switch` 要放在**位置参数（app 路径）之前**才可靠。
 *     写成 `electron.exe "app路径" --no-sandbox` 时 --no-sandbox 可能不被识别；
 *     正确写法是 `electron.exe --no-sandbox "app路径"`。
 *
 * 产出（release/ 下）：
 *   启动桌宠.bat    —— 双击即用，不显示控制台
 *   _调试启动.bat   —— 保留控制台；同时把输出写进 release\启动日志.txt，便于排错
 */
const fs = require('fs');
const path = require('path');

const APP = 'C:/Users/enze/Desktop/PET/DesktopPet-App';
const REL = path.join(APP, 'release');

const MAIN_BAT = [
  '@echo off',
  'rem ===================================================================',
  'rem  Pet desktop pet - launcher (double-click to run)',
  'rem',
  'rem  Runs the app in dev mode via the project\'s own Electron.',
  'rem  Verified working on this PC: window in ~119ms, tray + hotkeys ok.',
  'rem',
  'rem  NOTE: switches must come BEFORE the app path, or Chromium may',
  'rem        ignore them. Hence: electron --no-sandbox "<appdir>".',
  'rem',
  'rem  Needs: npm install already done (node_modules\\electron present).',
  'rem  Code:  uses current dist\\ and public\\ - run npm run build:all after edits.',
  'rem',
  'rem  If nothing appears, run _debug.bat instead and read the log.',
  'rem ===================================================================',
  'chcp 65001 >nul 2>&1',
  'setlocal',
  'set "APPDIR=%~dp0.."',
  'set "ELECTRON=%APPDIR%\\node_modules\\electron\\dist\\electron.exe"',
  '',
  'if not exist "%ELECTRON%" (',
  '  echo.',
  '  echo  [ERROR] Electron not found:',
  '  echo         %ELECTRON%',
  '  echo.',
  '  echo  Run "npm install" in the project folder first.',
  '  echo.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'cd /d "%APPDIR%"',
  'start "" "%ELECTRON%" --no-sandbox "%APPDIR%"',
  'exit /b 0',
  '',
].join('\r\n');

const DEBUG_BAT = [
  '@echo off',
  'rem ===================================================================',
  'rem  Pet desktop pet - DEBUG launcher (keeps console, writes a log file)',
  'rem  Everything printed here is also saved to: release\\launch-log.txt',
  'rem  If the pet does not appear, send that log file.',
  'rem  (log filename is ASCII on purpose: non-ASCII in .bat gets mangled',
  'rem   because cmd.exe parses these files as GBK on Chinese Windows)',
  'rem ===================================================================',
  'chcp 65001 >nul 2>&1',
  'setlocal',
  'set "APPDIR=%~dp0.."',
  'set "ELECTRON=%APPDIR%\\node_modules\\electron\\dist\\electron.exe"',
  'set "LOG=%~dp0launch-log.txt"',
  '',
  'echo === Pet debug launcher ===',
  'echo project : %APPDIR%',
  'echo electron: %ELECTRON%',
  'echo log     : %LOG%',
  'echo.',
  '',
  'if not exist "%ELECTRON%" (',
  '  echo [ERROR] Electron not found: %ELECTRON%',
  '  echo         Run "npm install" in the project folder first.',
  '  pause',
  '  exit /b 1',
  ')',
  '',
  'echo [1/3] electron --version:',
  '"%ELECTRON%" --version --no-sandbox',
  'echo.',
  '',
  'echo [2/3] starting app (foreground, logging to file)...',
  'cd /d "%APPDIR%"',
  '"%ELECTRON%" --no-sandbox --enable-logging "%APPDIR%" > "%LOG%" 2>&1',
  'set "RC=%ERRORLEVEL%"',
  '',
  'echo [3/3] app exited with code %RC%',
  'echo.',
  'echo ---- log tail (full file: %LOG%) ----',
  'if exist "%LOG%" (',
  '  powershell -NoProfile -Command "Get-Content -LiteralPath \'%LOG%\' -Tail 40"',
  ') else (',
  '  echo (no log file was created)',
  ')',
  'echo -------------------------------------',
  'echo.',
  'echo Keep this window open and report the text above.',
  'pause',
  '',
].join('\r\n');

function writeAscii(file, text) {
  const bad = [...text].filter((c) => c.charCodeAt(0) > 127);
  if (bad.length) throw new Error(`正文含非 ASCII（会被 GBK 解析破坏）: ${bad.slice(0, 8).join('')}`);
  fs.writeFileSync(file, Buffer.from(text, 'ascii'));
}

const mainPath = path.join(REL, '启动桌宠.bat');
const dbgPath = path.join(REL, '_调试启动.bat');
writeAscii(mainPath, MAIN_BAT);
writeAscii(dbgPath, DEBUG_BAT);

console.log('已生成（纯 ASCII，GBK 安全）：');
for (const p of [mainPath, dbgPath]) console.log(`  ${p}  (${fs.statSync(p).size} bytes)`);
