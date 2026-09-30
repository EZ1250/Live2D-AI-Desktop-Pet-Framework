#!/usr/bin/env node
'use strict';
/**
 * scripts/check-model.js —— 给任意一个模型文件夹做「能不能渲染」体检
 *
 * 用法：
 *   node scripts/check-model.js <模型文件夹>
 *   node scripts/check-model.js <模型文件夹> --json
 *
 * 为什么需要它：外部模型来源五花八门（Cubism 2/3/4/5、只给一半文件、多个描述文件……），
 * 出问题时不该靠"打开应用看看是黑的还是白的"来猜。这个脚本复用主进程的 modelCompat.ts，
 * 直接把「类型 / moc3 版本 / 运行库上限 / 缺哪些文件 / 怎么办」打出来。
 *
 * 依赖 dist/main/assets/modelCompat.js（先跑 npm run build:tsc），并用 electron 桩绕开 app 依赖。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const target = process.argv[2];
const asJson = process.argv.includes('--json');
if (!target) {
  console.error('用法: node scripts/check-model.js <模型文件夹> [--json]');
  process.exit(2);
}
const dir = path.resolve(target);
if (!fs.existsSync(dir)) {
  console.error(`[check-model] 目录不存在：${dir}`);
  process.exit(2);
}

// electron 桩：modelCompat 需要 app.getAppPath() 找 lib/ 里的 cubism core
const orig = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getAppPath: () => ROOT, getPath: () => ROOT } };
  }
  return orig.apply(this, arguments);
};
let compat;
try {
  compat = require(path.join(ROOT, 'dist', 'main', 'assets', 'modelCompat.js'));
} catch (err) {
  Module._load = orig;
  console.error(`[check-model] 读不到 dist/main/assets/modelCompat.js（先跑 npm run build:tsc）：${err.message}`);
  process.exit(2);
}
Module._load = orig;

const result = compat.inspectModelDir(dir, path.basename(dir));
if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const typeText =
    result.type === 'moc3'
      ? `Live2D (moc3 v${result.mocVersion ?? '?'})`
      : result.type === 'portrait'
        ? '静态立绘 (portrait)'
        : result.type === 'cubism2'
          ? 'Cubism 2（老格式，不支持）'
          : '无法识别';
  console.log(`模型：${path.basename(dir)}`);
  console.log(`  路径      ：${dir}`);
  console.log(`  类型      ：${typeText}`);
  console.log(`  运行库上限：moc3 v${result.coreMax}`);
  console.log(`  结论      ：${result.verdict}`);
  if (result.model3) console.log(`  描述文件  ：${result.model3}`);
  if (result.reason) console.log(`  原因      ：${result.reason}`);
  if (result.action) console.log(`  怎么办    ：${result.action}`);
  for (const issue of result.issues) console.log(`  · ${issue}`);
  if (result.verdict === 'unsupported') process.exitCode = 1;
}
