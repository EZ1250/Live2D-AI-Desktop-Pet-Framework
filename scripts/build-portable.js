#!/usr/bin/env node
/**
 * build-portable.js — 生成 Pet 便携版（win portable）
 *
 * 流程：
 *   1. 读取 package.json 的 version。
 *   2. 生成/更新根目录 README_PORTABLE.md（U 盘运行说明）。
 *   3. 调用 electron-builder --win portable（用 node 直接跑本地 electron-builder 的 CLI 入口，
 *      免 shell/.cmd 平台差异），产物输出到 release/（见 electron-builder.yml）。
 *   5. （已停用桌面自动投放：产物仅在 release/，由用户自行取用。）
 *
 * 用法：
 *   node scripts/build-portable.js            # 完整打包（需先 npm install）
 *   node scripts/build-portable.js --readme-only   # 只生成 README_PORTABLE.md，不打包（CI/预览用）
 *
 * 模型资源不进 ASAR：electron-builder.yml 的 extraResources 已把 public/assets 映射到
 * 打包后的 resources/assets，随便携 exe 一起分发。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const README_ONLY = process.argv.includes('--readme-only');

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const { version } = pkg;

// ---------------------------------------------------------------- README_PORTABLE.md
function writePortableReadme() {
  const md = [
    '# Pet 便携版运行说明',
    '',
    `本文档由 \`scripts/build-portable.js\` 自动生成（版本 **${version}**）。`,
    '',
    '## 产物位置',
    '',
    `- 安装包：\`release/Pet-${version}-setup.exe\``,
    `- 便携单文件：\`release/Pet-${version}-portable.exe\``,
    '- 免安装目录：\`release/win-unpacked/\`',
    '',
    '## 使用建议',
    '',
    '1. 默认优先安装包（启动更快，自动创建快捷方式）。',
    '2. 需要单文件携带时使用 portable（每次启动会先解包到临时目录）。',
    '3. 需要免安装且更快启动时，直接使用 \`win-unpacked/Pet.exe\`。',
    '',
    '## 模型与资源',
    '',
    '- 模型资源不打进 ASAR；构建时会将 \`public/assets\` 映射到 \`resources/assets\`。',
    '- 用户自有模型目录：`%APPDATA%\\pet-desktop-app\\live2d-models\\<模型名>\\`。',
    '- 可分发资源请放在 \`local-assets/\` 后执行 \`npm run import\`。',
    '',
    '## 安全与权限提示',
    '',
    '- 可执行文件未签名时，Windows 可能弹出 SmartScreen 提示。',
    '- 不要把 API key 或本机配置打包进发布产物；发布前建议运行：\`npm run check:privacy --all\`。',
    '',
    '## 常见问题',
    '',
    '- 便携版首次启动较慢通常是解包行为。',
    '- 白屏或资源缺失请先确认已执行 \`npm run import\` 与 \`npm run build:all\`。',
    '',
  ].join('\n');

  const out = path.join(PROJECT_ROOT, 'README_PORTABLE.md');
  fs.writeFileSync(out, md, 'utf8');
  console.log(`[build-portable] 已生成 ${path.relative(PROJECT_ROOT, out)}`);
}


writePortableReadme();
if (README_ONLY) {
  console.log('[build-portable] --readme-only：跳过打包。');
  process.exit(0);
}

// ---------------------------------------------------------------- 调 electron-builder
function resolveBuilderCli() {
  const metaPath = path.join(PROJECT_ROOT, 'node_modules', 'electron-builder', 'package.json');
  if (!fs.existsSync(metaPath)) return null;
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const bin = meta.bin == null ? null
    : (typeof meta.bin === 'string' ? meta.bin : (meta.bin['electron-builder'] || meta.bin.electronBuilder));
  return bin ? path.join(path.dirname(metaPath), bin) : null;
}

function runElectronBuilder() {
  const cli = resolveBuilderCli();
  if (!cli || !fs.existsSync(cli)) {
    console.error('[build-portable] 未找到本地 electron-builder（node_modules/electron-builder）。请先 npm install 再重试。');
    return false;
  }
  if (process.platform !== 'win32') {
    console.warn('[build-portable] 当前非 Windows 平台：win 目标需要 wine 才能完成打包。');
  }
  console.log(`[build-portable] 运行 electron-builder --win nsis portable（cwd=${PROJECT_ROOT}）...`);
  // 目标：nsis 安装包、portable 单文件、win-unpacked 免安装目录。
  const res = spawnSync(process.execPath, [cli, '--win', 'nsis', 'portable'], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  return res.error ? (console.error(`[build-portable] 启动失败: ${res.error.message}`), false) : res.status === 0;
}

// ---------------------------------------------------------------- 主流程
// 打包前置检查：extraResources 依赖这两个目录已生成，缺了就打成"白屏包"，宁可提前失败
const REQUIRED_DIRS = [
  ['public/renderer', 'node scripts/assemble-renderer.js'],
  ['public/assets', 'node scripts/import-model.js'],
];
for (const [rel, fix] of REQUIRED_DIRS) {
  if (!fs.existsSync(path.join(PROJECT_ROOT, rel))) {
    console.error(`[build-portable] 缺少 ${rel}/（extraResources 源），已中止打包。`);
    console.error(`              请先执行：${fix}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------- 隐私闸门（打包前）
// 个人配置（settings.json / chat-log.json / pet-tools.json / memory.md / API Key 等）只允许待在
// %APPDATA%\pet-desktop-app\；一旦混进 dist/ public/ local-assets/ 就中止，绝不带进主包。
function runPrivacyCheck(args, label) {
  const cli = path.join(PROJECT_ROOT, 'scripts', 'check-privacy.js');
  if (!fs.existsSync(cli)) {
    console.warn(`[build-portable] 未找到 scripts/check-privacy.js（跳过${label}隐私检查）`);
    return true;
  }
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: PROJECT_ROOT, stdio: 'inherit' });
  if (res.error) {
    console.warn(`[build-portable] 隐私检查启动失败：${res.error.message}`);
    return true;
  }
  return res.status === 0;
}

if (!runPrivacyCheck(['--inputs'], '输入')) {
  console.error('[build-portable] 隐私检查未通过：打包输入里混进了个人配置/密钥，已中止（清单见上）。');
  process.exit(1);
}

const buildOk = runElectronBuilder();
if (!buildOk) {
  console.error('[build-portable] electron-builder 执行失败，release/ 下无新产物。');
  console.error('              请检查：npm install 是否完成、node_modules/electron-builder 是否存在。');
  process.exitCode = 1;
} else {
  // ---------------------------------------------------------------- 隐私闸门（打包后）
  // 直接扫产出的 app.asar 与 resources/：asar 不压缩，明文密钥一定搜得到。
  const unpacked = path.join(PROJECT_ROOT, 'release', 'win-unpacked');
  if (!runPrivacyCheck(['--packed', unpacked], '产物')) {
    console.error('[build-portable] 产物里发现了个人配置/密钥，这个包不能分发（清单见上）。');
    process.exitCode = 1;
  }
  const releaseDir = path.join(PROJECT_ROOT, 'release');
  const setup = path.join(releaseDir, `Pet-${version}-setup.exe`);
  if (fs.existsSync(setup)) {
    console.log(`[build-portable] 安装包:   ${setup}`);
    console.log('                 启动最快（装完 ≈0.5s），且会自动建桌面/开始菜单快捷方式 —— 默认推荐。');
  } else {
    console.warn(`[build-portable] 未找到 ${path.basename(setup)}，请检查 electron-builder 输出。`);
  }
  const portable = path.join(releaseDir, `Pet-${version}-portable.exe`);
  if (fs.existsSync(portable)) {
    console.log(`[build-portable] 便携单文件: ${portable}`);
    console.log('                 免安装、可直接拷 U 盘；但每次启动要解包整个应用到 %TEMP%（较慢），');
    console.log('                 且没有启动闪屏，解包期间界面无反应属正常，别误认为卡死。');
  }
  // win-unpacked 是同一份产物的免安装形态：整个文件夹拷走即可用，双击 Pet.exe 秒开。
  if (fs.existsSync(path.join(releaseDir, 'win-unpacked', 'Pet.exe'))) {
    console.log('[build-portable] 免安装目录: release/win-unpacked/Pet.exe（整目录拷走即可，双击秒开）');
  }
  console.log('[build-portable] 完成。三种形态的启动速度与用途对比见 README_PORTABLE.md。');
}
