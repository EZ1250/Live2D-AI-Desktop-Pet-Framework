/**
 * assetIntegrity.test.js —— 渲染层资源完整性（仓库/装配/运行库）
 *
 * 目的：把"index.html 引用的脚本不存在""运行库文件丢失/半截/版本不对"这类问题
 * 从"运行时静默降级"变成测试红灯（本地与 CI 共用 `npm test`）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const APP = path.join(__dirname, '..');
const SRC_RENDERER = path.join(APP, 'src', 'renderer');
const DIST_RENDERER = path.join(APP, 'dist', 'renderer');
const PUBLIC_RENDERER = path.join(APP, 'public', 'renderer');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

/** git ls-files 里是否包含该路径；没装 git/没有 .git 时返回 null（跳过检查） */
function isTracked(rel) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: APP, encoding: 'utf8' }).trim();
    if (!root) return null;
    const out = execFileSync('git', ['ls-files', '--', rel], { cwd: APP, encoding: 'utf8' });
    return out.trim().length > 0;
  } catch {
    return null;
  }
}

test('index.html：引用的每个本地资源都在源码或编译产物里存在', () => {
  const html = read('src/renderer/index.html');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length > 10, 'index.html 应引用渲染层脚本/样式');
  // 静态资源（index/styles/lib）在 src；渲染层脚本是 tsc 编译产物，在 dist
  const missing = refs.filter(
    (rel) => !fs.existsSync(path.join(SRC_RENDERER, rel)) && !fs.existsSync(path.join(DIST_RENDERER, rel)),
  );
  assert.deepEqual(missing, [], `index.html 引用了不存在的本地资源（先跑 npm run build:tsc）：${missing.join(', ')}`);
});

test('装配：public/renderer 是完整入口（脚本/样式/插件/面板都在）', () => {
  const html = read('src/renderer/index.html');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  const missing = refs.filter((rel) => !fs.existsSync(path.join(PUBLIC_RENDERER, rel)));
  assert.deepEqual(
    missing,
    [],
    `public/renderer 缺文件（先跑 npm run build:all）：${missing.join(', ')}`,
  );
});

test('运行库三件套：存在、体积合理、版本标记正确（换栈/半截下载会在这里失败）', () => {
  const checks = [
    { file: 'pixi.min.js', min: 400 * 1024, max: 600 * 1024, marker: 'pixi.js - v6.5.10' },
    { file: 'live2dcubismcore.min.js', min: 150 * 1024, max: 400 * 1024, marker: 'MocVersion_50=5' },
    { file: 'live2d-engine.min.js', min: 100 * 1024, max: 300 * 1024, marker: 'Cubism4ModelSettings' },
    { file: 'live2d-engine.min.js', min: 100 * 1024, max: 300 * 1024, marker: 'VERSION="0.4.0"' },
  ];
  for (const c of checks) {
    const p = path.join(SRC_RENDERER, 'lib', c.file);
    assert.ok(fs.existsSync(p), `缺少运行库文件 ${c.file}`);
    const size = fs.statSync(p).size;
    assert.ok(size >= c.min && size <= c.max, `${c.file} 体积异常：${size}B`);
    assert.ok(fs.readFileSync(p, 'utf8').includes(c.marker), `${c.file} 缺少版本标记 ${c.marker}`);
  }
});

test('已删除的旧运行库不会再被打包（cubism2 遗留文件）', () => {
  assert.equal(fs.existsSync(path.join(SRC_RENDERER, 'lib', 'live2d-engine-cubism2.min.js')), false);
});

test('仓库完整性：index.html 依赖的源码与新增模块必须已被 git 跟踪', () => {
  const html = read('src/renderer/index.html');
  const scripts = [...html.matchAll(/src="\.\/([^"]+\.js)"/g)].map((m) => m[1]);
  const candidates = [];
  for (const script of scripts) {
    // renderer.js → renderer.ts；plugins/emotion.js → plugins/emotion.ts
    candidates.push(`src/renderer/${script.replace(/\.js$/, '.ts')}`);
  }
  candidates.push(
    'docs/ANDROID_MCP_CLIENT.md',
    'android-mcp-client/README.md',
    'android-mcp-client/app/src/main/java/com/pet/mcpclient/ui/AppState.kt',
    'android-mcp-client/app/src/main/java/com/pet/mcpclient/data/McpClient.kt',
    'android-mcp-client/app/src/main/java/com/pet/mcpclient/data/Transport.kt',
    'tests/kernel.test.js',
    'tests/emotionPlugin.test.js',
    'tests/nativeDeps.test.js',
    'tests/routes.test.js',
    'tests/assetIntegrity.test.js',
  );
  const required = candidates.filter((rel) => fs.existsSync(path.join(APP, rel)));

  const skipped = isTracked(required[0]);
  if (skipped === null) return; // 没有 git（源码压缩包）时这条检查无意义
  const untracked = required.filter((rel) => isTracked(rel) === false);
  assert.deepEqual(
    untracked,
    [],
    `这些文件存在于工作区但没被 git 跟踪（clone 后会缺文件/功能不完整）：\n  ${untracked.join('\n  ')}`,
  );
});

test('TTS 默认音色在渲染层与主进程两侧一致（两处常量不许漂移）', () => {
  const renderer = read('src/renderer/renderer.ts');
  const edge = read('src/main/voice/edgeTts.ts');
  const rendererVoice = /const TTS_DEFAULT_VOICE = '([^']+)'/.exec(renderer)?.[1];
  const mainVoice = /export const DEFAULT_VOICE = '([^']+)'/.exec(edge)?.[1];
  assert.ok(rendererVoice, '渲染层应定义 TTS_DEFAULT_VOICE');
  assert.equal(rendererVoice, mainVoice, '渲染层 TTS 默认音色必须与 edgeTts.DEFAULT_VOICE 一致');
});

test('TTS 文本上限在渲染层与主进程两侧一致（超长自动朗读会被截断）', () => {
  const renderer = read('src/renderer/renderer.ts');
  const edge = read('src/main/voice/edgeTts.ts');
  const rendererMax = /const TTS_MAX_CHARS = (\d+)/.exec(renderer)?.[1];
  const mainMax = /export const MAX_TEXT_CHARS = ([\d_]+)/.exec(edge)?.[1]?.replace(/_/g, '');
  assert.ok(rendererMax, '渲染层应定义 TTS_MAX_CHARS');
  assert.equal(rendererMax, mainMax, '渲染层 TTS_MAX_CHARS 必须与 edgeTts.MAX_TEXT_CHARS 一致');
});

test('TTS 内置音色候选：数量足够、短名不重复、默认音色在列表内', () => {
  const html = read('src/renderer/index.html');
  const select = /<select id="setting-tts-voice"[\s\S]*?<\/select>/.exec(html)?.[0];
  assert.ok(select, 'index.html 应有音色下拉');
  const values = [...select.matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(values.length >= 20, `内置音色候选应 >= 20 个（当前 ${values.length}）`);
  assert.equal(new Set(values).size, values.length, '内置音色短名不能重复');
  assert.ok(values.includes('zh-CN-XiaoxiaoNeural'), '内置候选应包含默认音色晓晓');
});

test('应用图标资源：托盘 PNG 与快捷方式 ICO 存在、格式正确，且随包带出 ICO', () => {
  const tray = fs.readFileSync(path.join(APP, 'local-assets', 'tray-icon.png'));
  assert.ok(tray.length > 10_000, '托盘图标应是一张正常大小的 PNG');
  assert.deepEqual([...tray.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '托盘图标必须是 PNG');

  const ico = fs.readFileSync(path.join(APP, 'local-assets', 'pet-icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO 保留字段');
  assert.equal(ico.readUInt16LE(2), 1, 'ICO 类型应为 icon');
  assert.ok(ico.readUInt16LE(4) >= 1, 'ICO 至少包含一个尺寸');

  const yml = read('electron-builder.yml');
  assert.ok(yml.includes('local-assets/pet-icon.ico'), 'electron-builder 应把 pet-icon.ico 作为 extraResource 带出');
});

test('设置页：空状态行不占高度（「试听语音」下面不应多出空行）', () => {
  const css = read('src/renderer/styles.css');
  assert.ok(css.includes('.settings-inline .settings-status:empty'), '空状态行应隐藏占位高度');
});
