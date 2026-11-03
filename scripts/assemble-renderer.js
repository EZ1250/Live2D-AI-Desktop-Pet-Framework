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
 *   - dist/renderer/renderer.js / live2d.js / gazeController.js / ttsMouth.js 等（tsc 编译产物，见 build:tsc）
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
  // 3) tsc 产物（都是全局脚本：renderer 主逻辑 / Live2D 层 / 情感判定 / 声纹显示 / 视线控制器 / 内核 / 特效）
  for (const f of ['renderer.js', 'live2d.js', 'emotion.js', 'voicelab.js', 'gazeController.js', 'ttsMouth.js', 'kernel.js', 'fx.js']) {
    if (copyFile(path.join(DIST, f), path.join(DST, f))) ok.push(f);
  }
  // 3.1) 渲染层模块目录（插件 plugins/ 与 UI 面板 panels/）：index.html 里都在 renderer.js 之前加载
  const missingModuleDirs = [];
  for (const dir of ['plugins', 'panels']) {
    const from = path.join(DIST, dir);
    if (!fs.existsSync(from)) {
      missingModuleDirs.push(dir);
      continue;
    }
    fs.cpSync(from, path.join(DST, dir), { recursive: true });
    ok.push(`${dir}/ (渲染层模块)`);
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
  if (missingModuleDirs.length) {
    console.error(
      `[assemble] 装配不完整：dist/renderer 下缺少 ${missingModuleDirs.join(', ')}/。\n` +
        '          请确认 src/renderer/ 下对应源码存在，并重跑 npm run build:tsc。'
    );
    process.exit(1);
  }

  // 硬性校验（二）：index.html 引用到的每个本地脚本/样式都必须真的装配进 public/renderer。
  // 这能挡住"源码没提交/漏拷目录 → 页面 404 但装配看起来成功"的情况。
  const html = fs.readFileSync(path.join(DST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  const missingAssets = refs.filter((rel) => !fs.existsSync(path.join(DST, rel)));
  if (missingAssets.length) {
    console.error(
      `[assemble] 装配不完整：index.html 引用了 ${missingAssets.length} 个不存在的本地资源：\n` +
        missingAssets.map((rel) => `          - ${rel}`).join('\n') +
        '\n          请确认对应源码存在且已纳入版本库，再重跑 npm run build:all。'
    );
    process.exit(1);
  }

  // 硬性校验：渲染层必须是「全局脚本」，一旦被编译成 CommonJS（出现 exports/require 垫片），
  // 浏览器里会立刻抛 "exports is not defined"，窗口直接白屏。这里宁可失败也不许装配出去。
  const commonScripts = ['renderer.js', 'live2d.js', 'emotion.js', 'voicelab.js', 'gazeController.js', 'ttsMouth.js', 'kernel.js', 'fx.js'];
  for (const dir of ['plugins', 'panels']) {
    for (const f of fs.existsSync(path.join(DST, dir)) ? fs.readdirSync(path.join(DST, dir)) : []) {
      if (f.endsWith('.js')) commonScripts.push(path.join(dir, f));
    }
  }
  for (const f of commonScripts) {
    const p = path.join(DST, f);
    if (!fs.existsSync(p)) continue;
    const src = fs.readFileSync(p, 'utf8');
    if (/Object\.defineProperty\(exports|^\s*(module\.exports|exports\.)/m.test(src)) {
      console.error(
        `[assemble] 致命：${f} 被编译成了 CommonJS 模块（出现 exports 垫片），浏览器会直接白屏。\n` +
          '          该文件必须保持"全局脚本"：不能有 import/export 语句；只允许 `import("…")` 类型注解（会被擦除）。\n' +
          '          删掉源码里的 import/export 后重跑 npm run build:tsc。'
      );
      process.exit(1);
    }
  }

  console.log(`[assemble] renderer 已装配到 public/renderer/: ${ok.join(', ')}`);
}

main();
