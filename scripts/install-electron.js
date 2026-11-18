#!/usr/bin/env node
/**
 * scripts/install-electron.js —— 确保 Electron 二进制已下载（postinstall 钩子）
 *
 * 为什么需要这个脚本：Electron 45 的 npm 包不再声明 `scripts.postinstall`（改为提供
 * `install-electron` bin），npm 安装完不会自动下载 dist/ 里的二进制；结果是
 * `npm install` 看似成功，但 `npm start` / `npm run dist` 找不到 Electron 可执行文件。
 * 这里在根仓库 postinstall 里显式补这一步，保证"clone → npm install → npm start"可用。
 *
 * 行为约定：
 *   - install.js 自身幂等（已安装会立即 exit 0），重复执行不重复下载；
 *   - 未安装 electron（例如 `npm install --omit=dev`）时安静跳过，不阻塞安装；
 *   - 下载失败返回非 0，避免"装了一半还能继续"的静默坏环境。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const installer = path.join(__dirname, '..', 'node_modules', 'electron', 'install.js');

if (!fs.existsSync(installer)) {
  console.log('[install-electron] 未安装 electron（可能是 --omit=dev），跳过二进制下载');
  process.exit(0);
}

try {
  execFileSync(process.execPath, [installer], { stdio: 'inherit' });
} catch (err) {
  console.error('[install-electron] Electron 二进制下载失败：', err instanceof Error ? err.message : err);
  process.exit(1);
}
