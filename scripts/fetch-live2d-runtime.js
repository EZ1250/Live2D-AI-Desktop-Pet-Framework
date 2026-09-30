'use strict';
/**
 * fetch-live2d-runtime.js —— 一键安装「最新 Live2D 运行库三件套」到 src/renderer/lib/
 *
 *   1) PixiJS 8 浏览器全局构建（MIT）
 *   2) untitled-pixi-live2d-engine 的 cubism（现代，Cubism 3/4/5）与 cubism-legacy（Cubism 2）构建
 *      —— 引擎内含 Cubism 5 框架镜像，MIT（引擎）+ Live2D Cubism SDK 许可（框架）
 *   3) 官方 Cubism Core：默认取 **Core 5.0**（moc3 v5），因为引擎 1.4.0 的框架与 Core 5.0 对齐；
 *      官方 SDK R5 的 Core（moc3 v6）会让引擎的 getDrawableRenderOrders() 拿到 undefined 而崩，
 *      所以只在需要 v6 时才用 --sdk-core 显式安装（装完记得实跑一遍验证）。
 *
 * 用法：
 *   node scripts/fetch-live2d-runtime.js                     # 装当前推荐组合（Pixi8 + 引擎1.4.0 + Core 5.0）
 *   node scripts/fetch-live2d-runtime.js --pixi 8.14.0 --engine 1.4.0
 *   node scripts/fetch-live2d-runtime.js --sdk-core --sdk-zip <CubismSdkForWeb-5-r.5.zip>   # 装 Core 6（实验）
 *   node scripts/fetch-live2d-runtime.js --stable             # 回退到 Pixi6 + cubism4 0.4.0 + Core 4.2（老栈）
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'renderer', 'lib');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(name);
const PIXI_VER = arg('--pixi', '8.14.0');
const ENGINE_VER = arg('--engine', '1.4.0');
const SDK_VER = arg('--sdk', '5-r.5');

const CORE_STABLE = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js'; // Core 5.0（moc3 v5）
const PIXI_STABLE = 'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js';
const LEGACY_ENGINE = 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js';
const CORE_LEGACY = 'https://cdn.jsdelivr.net/gh/guansss/pixi-live2d-display@master/core/live2dcubismcore.min.js';

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
        }
        if (code !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${code} @ ${url}`));
        }
        const out = fs.createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      })
      .on('error', reject)
      .setTimeout(120000, function () {
        this.destroy(new Error('timeout'));
      });
  });
}

const kb = (p) => `${(fs.statSync(p).size / 1024).toFixed(0)}KB`;
const mocVersionOf = (file) => {
  const t = fs.readFileSync(file, 'utf8');
  return Math.max(...[...t.matchAll(/MocVersion_[A-Za-z0-9_]+=(\d+)/g)].map((m) => Number(m[1])), 0);
};

async function installStable() {
  await download(PIXI_STABLE, path.join(LIB, 'pixi.min.js'));
  await download(LEGACY_ENGINE, path.join(LIB, 'cubism4.min.js'));
  await download(CORE_LEGACY, path.join(LIB, 'live2dcubismcore.min.js'));
  fs.rmSync(path.join(LIB, 'live2d-engine.min.js'), { force: true });
  fs.rmSync(path.join(LIB, 'live2d-engine-cubism2.min.js'), { force: true });
  console.log('[runtime] 已装回老栈：Pixi 6.5.10 + cubism4 0.4.0 + Core（最高 moc3 v%d）', mocVersionOf(path.join(LIB, 'live2dcubismcore.min.js')));
  console.log('[runtime] 别忘了把 src/renderer/index.html 的脚本名换回 cubism4.min.js');
}

(async () => {
  fs.mkdirSync(LIB, { recursive: true });
  if (has('--stable')) return installStable();

  const report = [];
  await download(`https://cdn.jsdelivr.net/npm/pixi.js@${PIXI_VER}/dist/pixi.min.js`, path.join(LIB, 'pixi.min.js'));
  report.push(`pixi.min.js            ← pixi.js@${PIXI_VER} (${kb(path.join(LIB, 'pixi.min.js'))})`);

  await download(
    `https://cdn.jsdelivr.net/npm/untitled-pixi-live2d-engine@${ENGINE_VER}/dist/cubism.min.js`,
    path.join(LIB, 'live2d-engine.min.js'),
  );
  report.push(`live2d-engine.min.js   ← untitled-pixi-live2d-engine@${ENGINE_VER} (${kb(path.join(LIB, 'live2d-engine.min.js'))})`);
  await download(
    `https://cdn.jsdelivr.net/npm/untitled-pixi-live2d-engine@${ENGINE_VER}/dist/cubism-legacy.min.js`,
    path.join(LIB, 'live2d-engine-cubism2.min.js'),
  );
  report.push(`live2d-engine-cubism2  ← 同上 legacy 构建（Cubism 2.1，${kb(path.join(LIB, 'live2d-engine-cubism2.min.js'))}）`);

  if (has('--sdk-core')) {
    // 实验：用官方 SDK R5 的 Core 6（moc3 v6）—— 引擎 1.4.0 不匹配，装完必须实跑验证
    const zipArg = arg('--sdk-zip', '');
    let zip = zipArg && fs.existsSync(zipArg) ? zipArg : '';
    if (!zip) {
      const cache = path.join(require('os').tmpdir(), 'pet-cubism-sdk-cache');
      fs.mkdirSync(cache, { recursive: true });
      zip = path.join(cache, `CubismSdkForWeb-${SDK_VER}.zip`);
      if (!fs.existsSync(zip) || fs.statSync(zip).size < 5_000_000) {
        await download(`https://cubism.live2d.com/sdk-web/bin/CubismSdkForWeb-${SDK_VER}.zip`, zip);
      }
    }
    const tmp = path.join(require('os').tmpdir(), `pet-core-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    const listFile = path.join(tmp, 'entries.txt');
    const fd = fs.openSync(listFile, 'w');
    require('child_process').spawnSync('tar', ['-tf', zip], { stdio: ['ignore', fd, 'inherit'] });
    fs.closeSync(fd);
    const entry = fs
      .readFileSync(listFile, 'utf8')
      .split('\n')
      .map((s) => s.replace(/\r$/, '').trim())
      .find((n) => /Core\/live2dcubismcore\.min\.js$/.test(n));
    if (!entry) throw new Error('这个 zip 里没有 Core/live2dcubismcore.min.js');
    require('child_process').spawnSync('tar', ['-xf', zip, '-C', tmp, entry], { stdio: 'inherit' });
    fs.copyFileSync(path.join(tmp, entry), path.join(LIB, 'live2dcubismcore.min.js'));
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('[runtime] ⚠️ 已装 SDK R5 的 Core 6（moc3 v6）—— 引擎 1.4.0 实测不兼容，请实跑验证后再保留');
  } else {
    await download(CORE_STABLE, path.join(LIB, 'live2dcubismcore.min.js'));
  }
  report.push(
    `live2dcubismcore.min.js ← ${has('--sdk-core') ? `CubismSdkForWeb-${SDK_VER} 的 Core` : '官方 CDN Core 5.0'}（最高 moc3 v${mocVersionOf(path.join(LIB, 'live2dcubismcore.min.js'))}，${kb(path.join(LIB, 'live2dcubismcore.min.js'))}）`,
  );

  console.log('[runtime] 已安装：\n  ' + report.join('\n  '));
  console.log('[runtime] 下一步：确认 src/renderer/index.html 引的是 lib/live2d-engine.min.js，然后 npm run build:all');
})();
