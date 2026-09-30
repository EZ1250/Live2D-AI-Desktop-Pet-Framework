'use strict';
/**
 * import-bundled-whale.js —— 将大肥鱼静态立绘加入内置模型目录。
 *
 * 该资源按 portrait 模型导入，只提供呼吸和浮动待机，不包含动作与表情。
 *
 * 放在 local-assets/ 而不是 public/assets/ 的原因：
 *   `npm run import` 会先 `rmSync(public/assets)` 再从 personas/ + local-assets/ 重建，
 *   直接放 public/assets 的模型每次构建都会被删掉（实测踩过）；
 *   local-assets/ 会被合并回 public/assets/ 并参与打包。
 *
 * 源图缺失时退出；已存在的 pet-model.json 不覆盖。
 * 用法：node scripts/import-bundled-whale.js [资源根目录]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const REF = process.argv[2] || path.join(ROOT, '..', 'AI调用方案', 'outputs', '_ref_aaaagent', 'AAAAGENT-main');
const SRC_PNG = path.join(REF, 'assets', 'original-design', 'whale-transparent.png');
const DEST = path.join(ROOT, 'local-assets', '大肥鱼');

if (!fs.existsSync(SRC_PNG)) {
  console.error(`[import-whale] 找不到源图：${SRC_PNG}`);
  console.error('[import-whale] 用法：node scripts/import-bundled-whale.js <资源根目录>');
  process.exit(1);
}
fs.mkdirSync(DEST, { recursive: true });

const png = path.join(DEST, 'whale.png');
if (!fs.existsSync(png) || fs.statSync(png).size !== fs.statSync(SRC_PNG).size) {
  fs.copyFileSync(SRC_PNG, png);
  console.log(`[import-whale] 复制立绘：${path.relative(ROOT, png)}（${Math.round(fs.statSync(png).size / 1024)}KB）`);
} else {
  console.log(`[import-whale] 立绘已存在且大小一致，跳过：${path.relative(ROOT, png)}`);
}

const presetFile = path.join(DEST, 'pet-model.json');
if (fs.existsSync(presetFile)) {
  console.log('[import-whale] pet-model.json 已存在，保留不覆盖（人手调过就以人为准）');
} else {
  const preset = {
    _说明: '静态立绘模型：提供呼吸与浮动待机，不包含动作或表情。使用前请确认资源授权。',
    _位置说明:
      '本目录在 local-assets/ 下：npm run import 会先清空 public/assets 再重建，' +
      '只放在 public/assets 里的模型每次构建都会被删掉；local-assets/ 会被原样合并回 public/assets/ 并参与打包。',
    framing: 'full',
  };
  fs.writeFileSync(presetFile, `${JSON.stringify(preset, null, 2)}\n`, 'utf8');
  console.log('[import-whale] 写入 pet-model.json（framing=full）');
}
console.log('[import-whale] 完成。运行 npm run import 将资源合并并写入打包输入。');
