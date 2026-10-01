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
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const README_ONLY = process.argv.includes('--readme-only');

const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8'));
const { version } = pkg;
const ARTIFACT_NAME = `Pet-${version}-portable.exe`;
const DESKTOP_DIR_NAME = 'DesktopPet-App'; // 与工程目标根目录同名，便于发现

// ---------------------------------------------------------------- README_PORTABLE.md
function writePortableReadme() {
  const md = `# Pet 便携版运行说明

本文档由 \`scripts/build-portable.js\` 自动生成（对应版本 **${version}**）。

## 怎么用

1. 找到便携 exe：\`release/Pet-${version}-portable.exe\`（构建产物仅在 release/，不再自动复制到桌面）。
2. **U 盘即插即用**：把整个 exe 拷进 U 盘，在任意 Windows 电脑上双击即可运行——
   无需安装 Node / npm / 任何运行时依赖，也无需安装（portable 免安装）。

## 三个产物，按需选

| 产物 | 体积 | 启动 | 要不要装 | 用途 |
|---|---|---|---|---|
| \`release/Pet-${version}-setup.exe\` | 约 71 MB | **最快**（装完 ≈0.5s） | 要装一次 | **默认推荐**：本机长期用；会自动建桌面/开始菜单快捷方式 |
| \`release/Pet-${version}-portable.exe\` | 约 71 MB | **慢**（每次启动解包） | 不用装 | 只有一个文件、可拷 U 盘时用 |
| \`release/win-unpacked/\` | 约 232 MB | **双击秒开**（不用解包） | 不用装 | 免安装；整个文件夹拷走即可用（比便携单文件快） |

> **便携单文件为什么慢**：它是 NSIS 自解压包，**每次启动**都要把整个应用解包到 \`%TEMP%\`、
> 退出时再删掉，这份解压**无法缓存复用**（项目文档实测"出现窗口"约 9.7 秒）。
> 而且应用**没有启动闪屏**，解包那十几秒屏幕上什么都没有，很容易被当成卡死 —— 看任务管理器里
> \`Pet-*.exe\` 有没有 CPU 占用即可分辨。慢的是解包，**不是程序本身**（主进程启动只要约 124ms）。

## 关于 compression（影响 portable 体积）

\`electron-builder.yml\` 里的 \`compression\` 对 portable 单 exe 体积影响很大（本机各跑两次，结果稳定）：

| 设置 | portable.exe | 说明 |
|---|---|---|
| \`normal\`（当前值） | 约 71 MB | 体积优先 |
| \`store\` | 约 233 MB | 不压缩，解包≈拷贝 |

当前取 \`normal\`：解包耗时的大头是"把约 232MB 落盘"，压缩设置只影响其中解压那一段（量级 1~3s），
却让文件大 3 倍多。

## 为什么 setup 启动快

主进程本身很快：实测窗口创建 +72ms、主进程就绪 +124ms。慢的全在"解包 / 冷启动"这一段，
而安装版把应用**预先落在磁盘上**，启动时不需要任何解包，所以快。

## 未签名的提示

exe 没有代码签名，Windows SmartScreen 会弹「无法验证发布者 / 未知发布者」。
这是**预期行为**，点「更多信息 → 仍要运行」即可；消除它需要购买代码签名证书。

## 模型资源在哪里

- 模型**没有**打包进 ASAR。构建时 \`public/assets\` 被 electron-builder 的 extraResources
  整体映射到便携包内 \`resources/assets\`（含 \`models.json\` 清单、\`knowledge/\` 语料、\`skills/\` 技能，
  以及随包的内置模型目录）。**当前随包的只有一个静态立绘内置模型「大肥鱼」**：
  没有随包骨骼模型（骨骼模型体积大、且版本兼容性因机器而异，一律由用户放本机用户数据）。
- **骨骼模型放在本机用户数据**：\`%APPDATA%\\pet-desktop-app\\live2d-models\\<模型名>\\\`
  （应用启动时按"用户模型优先、内置模型兜底"排序，清单里没有骨骼模型时也会扫这个目录）。
  想内置/留种子：把模型放进 \`local-assets/live2d_models/<模型名>/\` 再 \`npm run import\`
  （只有放在 \`local-assets/\` 才能活过构建；\`public/assets\` 每次 import 都会被清空重建）。
  详见 \`local-assets/live2d_models/README.md\` 与 \`docs/MODEL_COMPAT.md\`。
- 应用启动时会优先从打包资源路径读取模型（\`process.resourcesPath/assets\`，
  兜底为 exe 同目录的 \`assets/\`），因此随包资源无需联网、无需额外放置。
- 判断某个模型能不能被当前运行库渲染：\`node scripts/check-model.js "<模型文件夹>"\`。

## 常见问题

- 杀毒软件误报：Electron 便携 exe 首次运行可能被 SmartScreen/杀软拦截，选"仍要运行"即可。
- 运行报缺 DLL / 白屏：确认系统为 64 位 Windows 10/11，并保持 exe 所在目录可写（需要临时解包空间）。
- 本文件与 exe 版本严格对应；重新打包后会自动刷新。
`;

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
  // 出两个 exe + 一个目录：
  //   nsis      安装包 —— 启动最快，且会自动建桌面/开始菜单快捷方式（默认推荐）
  //   portable  单文件 —— 免安装、可拷 U 盘；但每次启动都要把整个应用解包到 %TEMP%、
  //             退出再删，无法缓存复用（项目文档实测"出现窗口"约 9.7s），且没有启动闪屏，
  //             所以容易被误认为卡死。用户明确要"单文件便携"时才用它。
  //   win-unpacked 目录 —— 免安装且双击秒开（同一份产物，顺带就有了）
  const res = spawnSync(process.execPath, [cli, '--win', 'nsis', 'portable'], {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  return res.error ? (console.error(`[build-portable] 启动失败: ${res.error.message}`), false) : res.status === 0;
}

// ---------------------------------------------------------------- 产物定位
function findArtifact(releaseDir) {
  const exact = path.join(releaseDir, ARTIFACT_NAME);
  if (fs.existsSync(exact)) return exact;
  if (!fs.existsSync(releaseDir)) return null;
  const hit = fs.readdirSync(releaseDir).find((f) => /-portable\.exe$/i.test(f));
  return hit ? path.join(releaseDir, hit) : null;
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
