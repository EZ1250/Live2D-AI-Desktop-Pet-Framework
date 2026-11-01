/**
 * 回归测试：两处"静默坏掉"的坑（都在真实环境里踩过）
 *
 * A. TTS 自动播放 / CSP
 *    渲染层用 `new Audio(payload.dataUrl).play()` 播放主进程合成的语音，dataUrl 是
 *    `data:audio/mpeg;base64,...`。页面 CSP 的 media-src 只要少了 `data:`，Chromium 就会
 *    "Media load rejected by URL safety check" → play() 抛 NotSupportedError → 用户点试听没声音。
 *    这里用静态断言钉死两处 CSP（staticServer 的响应头 + index.html 的 meta）都允许 data:，
 *    以及 renderer 里确实有"手势内解锁 + 可操作失败提示"。
 *
 * B. VTS 注入诊断
 *    「动鼠标 VTS 里模型不动」必须能自查：__petDebug.vts()、status 的 injectedCount /
 *    lastInjectedAt / lastTracking、设置页「测试注入」按钮与 test-inject 动作缺一不可。
 *
 * 纯静态/文本断言（不需要 Electron、不需要真实 VTS）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * 从一段文本里取出**真正的** media-src 指令值。
 * 注释里也会提到 "media-src ..."（说明为什么放行 data:），所以只认含 `blob:` 的那一条
 * （正式指令必然带 blob:，说明文字不会），避免把注释当成指令。
 */
function mediaSrcOf(text) {
  const re = /media-src\s+([^;"\n]+)/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = m[1].trim();
    if (value.includes('blob:')) return value;
  }
  return '';
}

test('CSP：主进程响应头的 media-src 允许 data:（否则 TTS 的 data URL 会被拦）', () => {
  const src = read('src/main/staticServer.ts');
  const directive = mediaSrcOf(src);
  assert.ok(directive, 'staticServer.ts 里找不到 media-src');
  assert.match(directive, /(^|\s)data:/, `media-src 必须含 data:（当前：${directive}）`);
  assert.match(directive, /'self'/, '不能为了 data: 把 self 弄丢（模型/音效仍从本地服务加载）');
  assert.match(directive, /blob:/, 'blob: 仍要给：Pixi worker / 未来的 blob 音频');
});

test('CSP：index.html 的 meta media-src 也允许 data:（两层 CSP 取交集，缺一不可）', () => {
  const html = read('src/renderer/index.html');
  const meta = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i.exec(html);
  assert.ok(meta, 'index.html 里找不到 CSP meta');
  const directive = mediaSrcOf(meta[1]);
  assert.match(directive, /(^|\s)data:/, `meta media-src 必须含 data:（当前：${directive}）`);
});

test('CSP：装配产物与编译产物同步（public/renderer + dist）', () => {
  const assembled = read('public/renderer/index.html');
  const meta = /<meta[^>]+http-equiv="Content-Security-Policy"[^>]*content="([^"]+)"/i.exec(assembled);
  assert.ok(meta, 'public/renderer/index.html 里找不到 CSP meta（先 npm run assemble）');
  assert.match(mediaSrcOf(meta[1]), /(^|\s)data:/, '装配后的页面 meta CSP 必须含 data:');
  const compiled = read('dist/main/staticServer.js');
  assert.match(mediaSrcOf(compiled), /(^|\s)data:/, '编译后的 staticServer 必须含 data:（先 npm run build:tsc）');
});

test('自动播放：开关在最早的主入口生效（earlySwitches 先于 mainImpl）', () => {
  const early = read('src/main/earlySwitches.ts');
  assert.match(early, /autoplay-policy/, 'earlySwitches 里要有 autoplay-policy');
  assert.match(early, /no-user-gesture-required/);
  assert.match(early, /installEarlySwitches\(\);/, '模块被 require 时就要生效（顶层副作用）');

  const mainTs = read('src/main/main.ts');
  const earlyAt = mainTs.indexOf("import './earlySwitches'");
  const implAt = mainTs.indexOf("import './mainImpl'");
  assert.ok(earlyAt >= 0, "main.ts 必须先 import './earlySwitches'");
  assert.ok(implAt > earlyAt, 'earlySwitches 必须在 mainImpl 之前 import（tsc 按顺序 require）');

  const impl = read('src/main/mainImpl.js');
  const requireAt = impl.indexOf('require("./earlySwitches")');
  const firstOtherRequire = impl.indexOf('require("electron")');
  assert.ok(requireAt >= 0, 'mainImpl.js 顶部也要 require("./earlySwitches")');
  assert.ok(requireAt < firstOtherRequire, 'earlySwitches 必须早于其它 require（确保 app ready 之前）');
});

test('自动播放：窗口显式声明 autoplayPolicy；渲染层有手势解锁与可操作提示', () => {
  const impl = read('src/main/mainImpl.js');
  const policies = impl.match(/autoplayPolicy: 'no-user-gesture-required'/g) || [];
  assert.ok(policies.length >= 2, `主窗与浮窗都要显式声明 autoplayPolicy（当前 ${policies.length} 处）`);

  const renderer = read('src/renderer/renderer.ts');
  assert.match(renderer, /function unlockTtsAudio\(/, '必须有音频解锁函数');
  assert.match(renderer, /installTtsAudioUnlock\(\)/, '首次用户手势要装上解锁监听');
  assert.match(renderer, /unlockTtsAudio\(\);\s*\n\s*if \(btn\)/, '试听按钮必须在 await 之前先解锁（手势内）');
  assert.match(renderer, /NotAllowedError/, 'play() 被拒时要区分 NotAllowedError');
  assert.match(renderer, /浏览器拦截了自动播放/, '被拦时要给可操作提示（点试听再试一次）');
  assert.match(renderer, /ttsLastError/, '播放失败要保留 lastError');
  assert.match(renderer, /tts: \(\) => ttsDebugState\(\)/, '__petDebug.tts() 用于自查');
});

test('VTS 诊断：status 字段 / test-inject 动作 / 设置页按钮 / 33ms 定时推送 / __petDebug.vts()', () => {
  const contracts = read('src/shared/contracts.ts');
  assert.match(contracts, /injectedCount/, 'VtsStatusDto 要有 injectedCount');
  assert.match(contracts, /lastInjectedAt/, 'VtsStatusDto 要有 lastInjectedAt');
  assert.match(contracts, /lastTracking/, 'VtsStatusDto 要有 lastTracking');
  assert.match(contracts, /'test-inject'/, 'VtsActionName 要含 test-inject');

  const service = read('src/main/vts/vtsService.ts');
  assert.match(service, /async testInject\(/, 'VtsService 要有 testInject');
  assert.match(service, /VTS_TEST_INJECT_VALUES/, '测试注入值要集中定义');
  assert.match(service, /droppedCount: this\.current\.droppedCount \+ 1/, '丢帧要计数（不静默）');

  const ipc = read('src/main/ipc.ts');
  assert.match(ipc, /'test-inject'/, 'IPC 白名单要放行 test-inject');

  const impl = read('src/main/mainImpl.js');
  assert.match(impl, /case 'test-inject'/, '主进程要处理 test-inject');
  assert.match(impl, /function onVtsTracking\(/, '追踪入口要有独立函数');
  assert.match(impl, /VTS_DROP_LOG_INTERVAL_MS/, '未连接丢帧要有限频日志（不静默丢）');

  const html = read('src/renderer/index.html');
  assert.match(html, /id="setting-vts-test-inject"/, '设置页要有「测试注入」按钮');

  const renderer = read('src/renderer/renderer.ts');
  assert.match(renderer, /function runVtsTestInjectFromUi\(/, '渲染层要处理测试注入按钮');
  assert.match(renderer, /vtsAction\('test-inject'\)/, '按钮要走 test-inject 动作');
  assert.match(renderer, /vts: \(\) => vtsDebugState\(\)/, '__petDebug.vts() 必须存在');
  assert.match(renderer, /VTS_PUSH_INTERVAL_MS = 33/, '推送间隔固定 33ms');
  assert.match(renderer, /setInterval\(pushVtsTracking, VTS_PUSH_INTERVAL_MS\)/, '启用 VTS 后要用固定 33ms 定时器（不跟主循环降帧）');
  assert.match(renderer, /已注入 \$\{st\.injectedCount\} 帧/, '设置页状态行要显示 injectedCount');
});
