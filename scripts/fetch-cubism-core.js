#!/usr/bin/env node
/**
 * scripts/fetch-cubism-core.js — 拉取并校验 Live2D Cubism Core（Web）
 *
 * 背景：src/renderer/lib/live2dcubismcore.min.js 若是 emscripten「wasm 引导版」，
 * 运行时还需要同目录的伴随二进制（默认名 _em_module.wasm / live2dcubismcore.wasm）。
 * 早期下载只存了 .js，没存 .wasm → renderer 里 moc3 模型加载时 core 初始化
 * fetch 404 → 降级为"当前环境无法渲染 Live2D(moc3)"占位。
 *
 * 本脚本（纯 Node 标准库，无三方依赖）：
 *   1. 依次尝试多个源下载 live2dcubismcore.min.js（官方 cubism.live2d.com → jsDelivr 镜像）。
 *   2. 下载后用内容特征判定版本：
 *        - 含 WebAssembly.instantiate / "_em_module.wasm" / "wasmBinaryFile" → wasm 引导版，
 *          需继续下载伴随 wasm（_em_module.wasm / <名>.wasm / <名>.min.wasm，按同目录试）；
 *        - 否则视为单文件 asm.js 版（无需伴随文件）。
 *   3. 写入 src/renderer/lib/ 并输出结果；随后请执行 `npm run assemble`（或 build:all）。
 *
 * 用法：node scripts/fetch-cubism-core.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const LIB_DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'lib');

/**
 * --from <zip|目录>：从**本地** Live2D 官方 SDK（或任何含 Core 的文件夹/压缩包）安装 Core。
 * 为什么需要：官方 CDN 上的新 Core（支持 moc3 v5 / Cubism 5）是 emscripten wasm 引导版，
 * 需要同目录的 _em_module.wasm，而这个 .wasm 官方 CDN 不提供（实测 404），只在 SDK 包里。
 * 本机拿不到 SDK 时，就在 Cubism Editor 里把模型导出目标改成 4.2（见 README/MODEL_COMPAT.md）。
 */
const FROM_ARG = (() => {
  const i = process.argv.indexOf('--from');
  return i > 0 ? process.argv[i + 1] : '';
})();

const CORE_CANDIDATES = [
  'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
  // pixi-live2d-display 官方仓库自带 core/ 目录（多为无 wasm 依赖的单文件版本），
  // 若官方主源是新版 wasm 引导（需伴随 .wasm）而本机拉不到，此处镜像可作替换源
  'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@master/core/live2dcubismcore.min.js',
  'https://raw.githubusercontent.com/guansss/pixi-live2d-display/master/core/live2dcubismcore.min.js',
  'https://cdn.jsdelivr.net/gh/nickylee007/nickylee007.github.io/js/live2dcubismcore.min.js',
];
const WASM_CANDIDATES = [
  '_em_module.wasm',
  'live2dcubismcore.wasm',
  'live2dcubismcore.min.wasm',
];
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]); // \0asm

function fatal(msg) {
  console.error(`\n[fetch-cubism-core] 错误: ${msg}\n`);
  process.exit(1);
}

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft <= 0) return reject(new Error(`重定向次数过多: ${url}`));
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        console.log(`[fetch-cubism-core]   → 重定向 ${code}: ${next}`);
        return resolve(download(next, redirectsLeft - 1));
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code} @ ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error(`超时: ${url}`)));
  });
}

/** 判断 core JS 是否为「wasm 引导版」（需要伴随 .wasm） */
function isWasmGlue(buf) {
  const t = buf.toString('utf8');
  return /WebAssembly\.instantiate|wasmBinaryFile|["']_em_module\.wasm["']/.test(t);
}

function sameDirUrl(jsUrl, wasmName) {
  try {
    const u = new URL(jsUrl);
    return new URL(wasmName, u).toString();
  } catch {
    return null;
  }
}

async function fetchCore() {
  let lastErr = null;
  for (const url of CORE_CANDIDATES) {
    try {
      console.log(`[fetch-cubism-core] 尝试 core: ${url}`);
      const buf = await download(url);
      if (buf.length < 50_000) {
        console.log(`[fetch-cubism-core]   忽略：体积异常小(${buf.length}B)，可能非 core。`);
        lastErr = new Error('core 体积异常');
        continue;
      }
      return { url, buf };
    } catch (e) {
      lastErr = e;
      console.log(`[fetch-cubism-core]   失败: ${e.message}`);
    }
  }
  throw lastErr || new Error('所有 core 源均失败');
}

/** 解析 core JS 里能读的最高 moc3 版本（MocVersion_* 枚举的最大值） */
function maxMocVersion(buf) {
  const text = buf.toString('utf8');
  let max = 0;
  for (const m of text.matchAll(/MocVersion_[A-Za-z0-9_]+=(\d+)/g)) {
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > max) max = v;
  }
  return max;
}

/** 在目录里（含 3 层）找文件名匹配的文件 */
function findInDir(dir, match, depth = 3) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && match(e.name)) out.push(full);
    else if (e.isDirectory() && depth > 0) out.push(...findInDir(full, match, depth - 1));
  }
  return out;
}

/** 从本地 SDK（zip 或目录）安装 Core：备份 → 校验 → 落地，任何一步失败都回滚 */
async function installFromLocal(input) {
  const src = path.resolve(input);
  console.log(`[fetch-cubism-core] ===== 从本地安装 Core：${src} =====`);
  if (!fs.existsSync(src)) fatal(`路径不存在：${src}`);

  let workDir = src;
  let tmpDir = '';
  if (fs.statSync(src).isFile()) {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cubism-sdk-'));
    const { spawnSync } = require('child_process');
    // Windows 10+ 自带 bsdtar，能直接解 zip；失败再退回 PowerShell Expand-Archive
    let r = spawnSync('tar', ['-xf', src, '-C', tmpDir], { stdio: 'ignore' });
    if (r.status !== 0) {
      r = spawnSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${src}' -DestinationPath '${tmpDir}' -Force`], { stdio: 'ignore' });
    }
    if (r.status !== 0) fatal(`解压失败：${src}（试试先手动解压，再用 --from <目录>）`);
    workDir = tmpDir;
    console.log(`[fetch-cubism-core]   已解压到临时目录：${tmpDir}`);
  }

  const jsFiles = findInDir(workDir, (n) => /^live2dcubismcore(\.min)?\.js$/i.test(n) || /^live2dcubismcore.*\.js$/i.test(n));
  if (!jsFiles.length) fatal('在给定路径里没找到 live2dcubismcore*.js —— 确认选的是 SDK 的 Core 目录或其压缩包');
  // 优先 min 版
  jsFiles.sort((a, b) => (/(\.min)?\.js$/i.test(a) ? -1 : 1) - (/(\.min)?\.js$/i.test(b) ? -1 : 1));
  const jsSrc = jsFiles.find((f) => /\.min\.js$/i.test(f)) || jsFiles[0];
  const jsBuf = fs.readFileSync(jsSrc);
  const glue = isWasmGlue(jsBuf);
  const ver = maxMocVersion(jsBuf);

  let wasmSrc = '';
  if (glue) {
    const wasmFiles = findInDir(path.dirname(jsSrc), (n) => /\.wasm$/i.test(n), 1);
    wasmSrc = wasmFiles.find((f) => /_em_module\.wasm$/i.test(f)) || wasmFiles.find((f) => /live2dcubismcore.*\.wasm$/i.test(f)) || wasmFiles[0] || '';
    if (!wasmSrc) {
      fatal(
        `这份 Core 是 wasm 引导版（需要伴随 .wasm），但在 ${path.dirname(jsSrc)} 里没找到 .wasm。\n` +
          '  · 官方 SDK 压缩包里 Core 目录应同时含 live2dcubismcore.min.js 与 live2dcubismcore.wasm；\n' +
          '  · 拿不到时就别升级运行库：改用 Cubism Editor 把模型导出目标改成 4.2（见 docs/MODEL_COMPAT.md）。'
      );
    }
    const wasmBuf = fs.readFileSync(wasmSrc);
    if (wasmBuf.length < 100_000 || !wasmBuf.subarray(0, 4).equals(WASM_MAGIC)) {
      fatal(`伴随 wasm 不合法（${path.basename(wasmSrc)}，${wasmBuf.length}B，魔数不符）`);
    }
  }

  // 备份 → 落地。备份放系统临时目录（不要污染 src/renderer，也别进打包产物）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(require('os').tmpdir(), `pet-lib-backup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const installed = [];
  const rollback = () => {
    for (const f of installed) {
      const prev = path.join(backupDir, path.basename(f));
      try {
        if (fs.existsSync(prev)) fs.copyFileSync(prev, f);
        else fs.rmSync(f, { force: true });
      } catch (e) {
        console.error(`[fetch-cubism-core]   回滚失败：${f}（${e.message}）`);
      }
    }
    console.error(`[fetch-cubism-core] 已回滚到原来的 Core（备份在 ${backupDir}）`);
  };

  const jsDest = path.join(LIB_DIR, 'live2dcubismcore.min.js');
  try {
    if (fs.existsSync(jsDest)) fs.copyFileSync(jsDest, path.join(backupDir, path.basename(jsDest)));
    fs.writeFileSync(jsDest, jsBuf);
    installed.push(jsDest);
    if (wasmSrc) {
      const wasmDest = path.join(LIB_DIR, path.basename(wasmSrc));
      if (fs.existsSync(wasmDest)) fs.copyFileSync(wasmDest, path.join(backupDir, path.basename(wasmDest)));
      fs.writeFileSync(wasmDest, fs.readFileSync(wasmSrc));
      installed.push(wasmDest);
      console.log(`[fetch-cubism-core]   已安装伴随 wasm：${path.basename(wasmDest)}`);
    }
    if (ver < 5) {
      console.warn(`[fetch-cubism-core] WARN: 这份 Core 最高只支持 moc3 v${ver}（装上了也读不了 Cubism 5 模型）`);
    }
    console.log(`[fetch-cubism-core] 完成：Core 最高支持 moc3 v${ver}${glue ? '（wasm 版）' : '（单文件版）'}`);
    console.log(`[fetch-cubism-core] 备份在 ${backupDir}；下一步 npm run assemble（或 build:all）后重启应用。`);
    console.log('[fetch-cubism-core] 验证：node scripts/check-model.js "<某个 Cubism 5 模型目录>" 应显示 ok。');
  } catch (err) {
    rollback();
    fatal(err && err.message ? err.message : String(err));
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  fs.mkdirSync(LIB_DIR, { recursive: true });
  if (FROM_ARG) return installFromLocal(FROM_ARG);
  const coreFile = path.join(LIB_DIR, 'live2dcubismcore.min.js');

  console.log('[fetch-cubism-core] ===== 拉取 Cubism Core =====');
  const { url, buf } = await fetchCore();
  fs.writeFileSync(coreFile, buf);
  console.log(`[fetch-cubism-core]   已写入 ${path.relative(process.cwd(), coreFile)} (${buf.length}B)`);

  if (!isWasmGlue(buf)) {
    console.log('[fetch-cubism-core] 当前 core 为单文件版（无 wasm 伴随依赖）→ 完成。');
    console.log('[fetch-cubism-core] 下一步：npm run assemble（或 npm run build:all）后重启应用。');
    return;
  }

  console.log('[fetch-cubism-core] core 为 wasm 引导版，探测伴随 .wasm …');
  let gotWasm = false;
  for (const name of WASM_CANDIDATES) {
    const wasmUrl = sameDirUrl(url, name);
    if (!wasmUrl) continue;
    try {
      console.log(`[fetch-cubism-core]   → ${name} @ ${wasmUrl}`);
      const w = await download(wasmUrl);
      if (w.length < 10_000 || !w.subarray(0, 4).equals(WASM_MAGIC)) {
        console.log('[fetch-cubism-core]     非有效 wasm（体积/魔数不符），跳过。');
        continue;
      }
      fs.writeFileSync(path.join(LIB_DIR, name), w);
      console.log(`[fetch-cubism-core]   已写入 ${name} (${w.length}B)`);
      gotWasm = true;
      break;
    } catch (e) {
      console.log(`[fetch-cubism-core]     失败: ${e.message}`);
    }
  }

  if (!gotWasm) {
    console.warn(
      '\n[fetch-cubism-core] WARN: 未能自动取得伴随 wasm。\n' +
      '  请手动下载 core 同目录的 wasm 文件（名称通常为 _em_module.wasm 或 live2dcubismcore.wasm），\n' +
      '  放到 src/renderer/lib/ 后重跑 assemble。也可改用单文件 asm.js 版 core 替代。'
    );
    process.exitCode = 2;
  } else {
    console.log('[fetch-cubism-core] 完成：core + wasm 均已就位。');
  }
  console.log('[fetch-cubism-core] 下一步：npm run assemble（或 npm run build:all）后重启应用。');
}

main().catch((e) => fatal(e && e.message ? e.message : String(e)));
