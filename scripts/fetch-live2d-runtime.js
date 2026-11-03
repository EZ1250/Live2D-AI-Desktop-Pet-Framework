#!/usr/bin/env node
/**
 * fetch-live2d-runtime.js —— 把 Live2D 运行库三件套重新下载到 src/renderer/lib/
 *
 *   pixi.min.js               PixiJS 6.5.10 浏览器全局构建（MIT）
 *   live2dcubismcore.min.js   Live2D Cubism Core 5.x（专有许可，可再分发；最高 moc3 v5）
 *   live2d-engine.min.js      pixi-live2d-display 0.4.0 的 cubism4 构建（MIT + Cubism SDK 许可）
 *
 * 写入策略：先下到同目录临时文件 → 校验（体积 / 版本标记）→ 原子 rename 覆盖。
 * 任一步失败都会保留旧运行库、删除临时文件，不会留下半截文件（半截文件会让渲染层静默降级）。
 *
 * 用法：node scripts/fetch-live2d-runtime.js
 */
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'renderer', 'lib');

const SOURCES = [
  {
    file: 'pixi.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi.js@6.5.10/dist/browser/pixi.min.js',
    minBytes: 400 * 1024,
    maxBytes: 600 * 1024,
    mustContain: ['pixi.js - v6.5.10', 'PIXI'],
  },
  {
    file: 'live2dcubismcore.min.js',
    url: 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js',
    minBytes: 150 * 1024,
    maxBytes: 400 * 1024,
    mustContain: ['MocVersion_50=5', 'Live2DCubismCore'],
  },
  {
    file: 'live2d-engine.min.js',
    url: 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js',
    minBytes: 100 * 1024,
    maxBytes: 300 * 1024,
    mustContain: ['Cubism4ModelSettings', 'VERSION="0.4.0"'],
  },
];

/** 当前运行库清单之外的旧文件：换栈后必须清掉，否则会被 assemble 整目录拷进安装包 */
const STALE_FILES = ['live2d-engine-cubism2.min.js'];

function download(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).toString(), dest, redirects - 1));
        return;
      }
      if (code !== 200) {
        res.resume();
        reject(new Error(`HTTP ${code} @ ${url}`));
        return;
      }
      const declared = Number(res.headers['content-length']);
      const out = fs.createWriteStream(dest);
      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        out.destroy();
        try { req.destroy(); } catch { /* already gone */ }
        reject(err);
      };
      out.on('error', fail);
      out.on('finish', () => {
        if (settled) return;
        settled = true;
        out.close((err) => (err ? reject(err) : resolve({ declared })));
      });
      res.on('error', fail);
      res.on('aborted', () => fail(new Error(`下载中断 @ ${url}`)));
      res.pipe(out);
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error(`下载超时 @ ${url}`)));
  });
}

function verify(item, file, declared) {
  const size = fs.statSync(file).size;
  if (size < item.minBytes || size > item.maxBytes) {
    throw new Error(`${item.file} 体积异常（${size}B，期望 ${item.minBytes}~${item.maxBytes}B）`);
  }
  if (Number.isFinite(declared) && declared > 0 && size !== declared) {
    throw new Error(`${item.file} 未下完（${size}B / Content-Length ${declared}B）`);
  }
  const text = fs.readFileSync(file, 'utf8');
  for (const marker of item.mustContain) {
    if (!text.includes(marker)) throw new Error(`${item.file} 内容校验失败：缺少标记 "${marker}"（可能被 CDN 换成了别的版本）`);
  }
  return size;
}

async function main() {
  fs.mkdirSync(LIB, { recursive: true });
  const downloaded = [];
  try {
    for (const item of SOURCES) {
      const dest = path.join(LIB, item.file);
      const tmp = `${dest}.download`;
      process.stdout.write(`下载 ${item.file} … `);
      try {
        const { declared } = await download(item.url, tmp);
        const size = verify(item, tmp, declared);
        fs.renameSync(tmp, dest); // 同目录 rename：原子替换，失败不会破坏旧文件
        downloaded.push(item.file);
        console.log(`${(size / 1024).toFixed(0)}KB`);
      } catch (err) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        throw err;
      }
    }
  } catch (err) {
    console.error(`\n失败：${err && err.message ? err.message : err}`);
    console.error('已下载完成的文件保留；未完成的三件套仍是旧版本（不会被半截文件覆盖）。');
    process.exit(1);
  }
  for (const stale of STALE_FILES) {
    const p = path.join(LIB, stale);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      console.log(`已清理旧运行库：${stale}`);
    }
  }
  console.log(`完成：src/renderer/lib/ 已更新（${downloaded.join(' / ')}）。下一步 npm run assemble 让渲染层生效。`);
}

main();
