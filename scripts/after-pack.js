#!/usr/bin/env node
/**
 * scripts/after-pack.js —— electron-builder 的 afterPack 钩子：给打包后的 Pet.exe 翻 Electron fuses
 *
 * 为什么需要：Electron 默认允许 `ELECTRON_RUN_AS_NODE=1 Pet.exe`、`--inspect` 与 `NODE_OPTIONS`
 * 等调试入口。用户机器上能启动 Pet.exe 的人就能借这些开关把它当任意 Node 脚本宿主用，
 * 把「只能跑这个桌宠」的边界打掉。这里关掉不需要且可被滥用的开关：
 *   - RunAsNode=false：禁止 ELECTRON_RUN_AS_NODE
 *   - EnableNodeOptionsEnvironmentVariable=false：忽略 NODE_OPTIONS
 *   - EnableNodeCliInspectArguments=false：禁止 --inspect/--inspect-brk
 *   - OnlyLoadAppFromAsar=true：只允许从 app.asar 加载应用代码，防止替换 dist/ 里的裸文件
 *
 * 刻意不启用 `EnableEmbeddedAsarIntegrityValidation`：它在 Windows 上依赖打包器注入的
 * 说明：`EnableEmbeddedAsarIntegrityValidation` 也一并打开 —— electron-builder 26 在 afterPack 之前
 * 会往 Pet.exe 注入 `ElectronAsarIntegrity` 资源（打包日志里的 "updating asar integrity executable
 * resource"），本机实测：开启该 fuse 后打包产物能正常启动（packaged=true）。若将来换回旧版 builder
 * 或改动 asar 配置导致启动失败，先关掉这一项排查。
 *
 * 刻意不打开 `GrantFileProtocolExtraPrivileges` 的关闭项：渲染层最后一层兜底是
 * `loadFile(dist/renderer/index.html)`（file:// 加载），关掉会给兜底路径加额外限制，
 * 需要单独实测后再做。
 *
 * 失败策略：fuses 翻转失败直接抛错让打包失败，不静默产出「以为加固了其实没有」的安装包。
 */
'use strict';

const path = require('node:path');

module.exports = async function afterPack(context) {
  // 只处理 Windows 产物；其它平台沿用 Electron 默认 fuses（本项目发布目标只有 Windows）
  if (context.electronPlatformName !== 'win32') return;

  const { flipFuses, FuseVersion, FuseV1Options } = await import('@electron/fuses');
  const productFilename = context.packager?.appInfo?.productFilename || 'Pet';
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);

  const count = await flipFuses(exePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });

  console.log(`[after-pack] fuses 已翻转 ${count} 项：${path.basename(exePath)}`);
};
