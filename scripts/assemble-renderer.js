#!/usr/bin/env node
/**
 * scripts/assemble-renderer.js
 *
 * 把渲染进程的静态资源装配到 public/renderer/（主进程 staticServer 的开发入口，
 * 也随 public/ 一起被 electron-builder extraResources 打包为 resources/renderer）。
 *
 * 复制内容：
 *   - src/renderer/index.html / styles.css（静态）
 *   - src/renderer/lib/（pixi / live2dcubismcore / cubism4）
 *   - dist/renderer/renderer.js / live2d.js（tsc 编译产物，见 build:tsc）
 *   - dist/renderer/ 再补一份 index.html / styles.css / lib/：主进程最后一层兜底
 *     loadFile(dist/renderer/index.html) 必须是一个"完整可用"的入口，而不是没样式没 Pixi 的裸页。
 *
 * 用法：npm run assemble（build / prestart 均会调用）。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const DIST = path.join(ROOT, 'dist', 'renderer');
const DST = path.join(ROOT, 'public', 'renderer');

function copyFile(from, to) {
  if (!fs.existsSync(from)) {
    console.warn(`[assemble] 源缺失，跳过: ${path.relative(ROOT, from)}`);
    return false;
  }
  fs.copyFileSync(from, to);
  return true;
}

function main() {
  fs.rmSync(DST, { recursive: true, force: true });
  fs.mkdirSync(DST, { recursive: true });
  fs.mkdirSync(path.join(DST, 'lib'), { recursive: true });

  const ok = [];
  // 1) 静态文件
  for (const f of ['index.html', 'styles.css']) {
    if (copyFile(path.join(SRC, f), path.join(DST, f))) ok.push(f);
  }
  // 2) lib（目录递归）
  //    先清空目标 lib：换运行库（文件名变化）时旧文件必须消失，否则会被打进包（踩过：
  //    从 cubism4.min.js 换成 live2d-engine.min.js 后，包里还留着老的 cubism4）。
  if (fs.existsSync(path.join(SRC, 'lib'))) {
    for (const dst of [path.join(DST, 'lib'), path.join(DIST, 'lib')]) {
      fs.rmSync(dst, { recursive: true, force: true });
    }
    fs.cpSync(path.join(SRC, 'lib'), path.join(DST, 'lib'), { recursive: true });
    ok.push('lib/ (pixi/cubism/core)');
  }
  // lib 完整性告警：core 若为 wasm 引导版且缺伴随 .wasm → 提醒一句（但**不一定**会失败）。
  // 实测：官方 SDK / CDN 的 live2dcubismcore.min.js 都不单独提供 .wasm，仍能正常初始化并渲染，
  // 所以这里只作为提示，不再写成"moc3 将无法渲染"。
  const coreJs = path.join(DST, 'lib', 'live2dcubismcore.min.js');
  if (fs.existsSync(coreJs)) {
    const txt = fs.readFileSync(coreJs, 'utf8');
    if (/WebAssembly\.instantiate|wasmBinaryFile|_em_module\.wasm/.test(txt)) {
      const hasWasm = fs.existsSync(path.join(DST, 'lib', '_em_module.wasm')) ||
        fs.existsSync(path.join(DST, 'lib', 'live2dcubismcore.wasm'));
      if (!hasWasm) {
        console.log(
          '[assemble] 提示: live2dcubismcore.min.js 含 wasm 引导代码但 lib/ 没有伴随 .wasm —— ' +
          '官方构建本来就不带（实测可正常运行）；若启动日志出现 Core 初始化失败，再跑 ' +
          'node scripts/fetch-cubism-core.js --from <含 wasm 的目录>'
        );
      }
    }
  }
  // 3) tsc 产物（都是全局脚本：renderer 主逻辑 / Live2D 层 / 情感判定 / 声纹显示）
  for (const f of ['renderer.js', 'live2d.js', 'emotion.js', 'voicelab.js']) {
    if (copyFile(path.join(DIST, f), path.join(DST, f))) ok.push(f);
  }

  // 4) 兜底副本：让 dist/renderer/ 成为**完整可用**的渲染入口。
  //    主进程 loadRenderer() 的最后一层兜底是 loadFile(dist/renderer/index.html)
  //    （静态服务拿不到 resources/renderer 时用它从 asar 内直接加载）；
  //    只复制 index.html 而不带 styles.css / lib/ 的话，这个兜底打开就是没样式、没有 Pixi 的裸页。
  const fallbacks = ['index.html', 'styles.css'];
  for (const f of fallbacks) {
    copyFile(path.join(SRC, f), path.join(DIST, f));
  }
  if (fs.existsSync(path.join(SRC, 'lib'))) {
    fs.cpSync(path.join(SRC, 'lib'), path.join(DIST, 'lib'), { recursive: true });
    ok.push('dist/renderer/ 兜底副本 (index.html + styles.css + lib/)');
  }

  if (!ok.includes('index.html') || !ok.includes('renderer.js')) {
    console.error('[assemble] 装配不完整：需先运行 npm run build:tsc（产出 dist/renderer/*.js）');
    process.exit(1);
  }

  // 硬性校验：渲染层必须是「全局脚本」，一旦被编译成 CommonJS（出现 exports/require 垫片），
  // 浏览器里会立刻抛 "exports is not defined"，窗口直接白屏。这里宁可失败也不许装配出去。
  for (const f of ['renderer.js', 'live2d.js', 'emotion.js', 'voicelab.js']) {
    const p = path.join(DST, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (/Object\.defineProperty\(exports|^\s*(module\.exports|exports\.)/m.test(src)) {
      console.error(
        `[assemble] 致命：${f} 被编译成了 CommonJS 模块（出现 exports 垫片）。\n` +
          '          渲染层必须是全局脚本：请把 tsconfig.json 的 module/moduleResolution 改回 commonjs/node 后重跑 npm run build:tsc。'
      );
      process.exit(1);
    }
  }

  console.log(`[assemble] renderer 已装配到 public/renderer/: ${ok.join(', ')}`);
}

main();
