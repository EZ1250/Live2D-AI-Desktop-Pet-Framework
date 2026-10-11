/**
 * contracts.test.js — IPC 通道常量的基本约束。
 *
 * IPC 通道名是**字符串约定**，没有类型保护。
 * 两个常量写成同一个字符串时，后注册的 handler 会覆盖前一个，
 * 表现是"某个功能静默失效、控制台不报错"——很难查。这里把它钉死。
 *
 * 需要先 `npm run build:tsc`（npm test 已包含），因为读的是 dist 产物。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const contracts = require('../dist/shared/contracts.js');

const ROOT = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('IPC 通道常量非空且不重复', () => {
  const entries = Object.entries(contracts).filter(
    ([key, value]) => key.startsWith('IPC_') && typeof value === 'string'
  );
  assert.ok(entries.length > 0, '应当导出至少一个 IPC_ 常量');

  const values = entries.map(([, value]) => value.trim());
  for (const [key, value] of entries) {
    assert.ok(value.trim().length > 0, `${key} 的通道名不能为空`);
  }
  
  const seen = new Map();
  const dup = [];
  for (const [key, value] of entries) {
    const v = value.trim();
    if (seen.has(v)) dup.push(`${seen.get(v)} 与 ${key} 都是 "${v}"`);
    else seen.set(v, key);
  }
  assert.deepEqual(dup, [], `IPC 通道名重复：\n${dup.join('\n')}`);
});

/**
 * CONTRACT.md 的硬规定：改 IPC 必须同步四处（契约 / preload / 主进程 / 渲染层）。
 * 漏一处的表现是"某个功能静默失效、控制台不报错"，所以这里把"语音状态条"这条通道钉住。
 */
test('语音状态条 IPC：契约、preload、主进程、渲染层四处都接上了', () => {
  const name = 'IPC_CHAT_WINDOW_VOICE_STRIP';
  assert.equal(contracts.IPC_CHAT_WINDOW_VOICE_STRIP, 'chat:windowVoiceStrip');
  // 通道名：契约 → preload 的 invoke → 主进程的 handler
  for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/main/ipc.ts']) {
    assert.ok(readSrc(file).includes(name), `${file} 应当引用 ${name}`);
  }
  // 渲染层经 ElectronAPI 的方法名调用；preload / 契约都得有这个方法
  for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/renderer/renderer.ts']) {
    assert.ok(readSrc(file).includes('chatWindowVoiceStrip'), `${file} 应当提供/调用 chatWindowVoiceStrip`);
  }
  // 主进程侧不经通道名：ipc.ts 声明依赖，mainImpl.js 注入并实现"改窗口高度"
  assert.ok(readSrc('src/main/ipc.ts').includes('setChatWindowVoiceStrip?:'), 'ipc.ts 应声明 setChatWindowVoiceStrip 依赖');
  assert.ok(readSrc('src/main/mainImpl.js').includes('setChatWindowVoiceStrip'), 'mainImpl.js 应注入并实现 setChatWindowVoiceStrip');
});

/**
 * 状态条的位置与高度是**跨进程约定**：渲染层的 CSS 留出多少，主进程就得把窗口长高多少。
 * 两边数字不一致的表现是"气泡被裁掉/多出一条空白"，很难一眼看出，故在此比一次。
 */
test('语音状态条：标记、绝对定位、以及跨进程一致的高度', () => {
  const html = readSrc('src/renderer/index.html');
  const barAt = html.indexOf('id="chatbar"');
  const rowAt = html.indexOf('class="chat-input-row"');
  const stripAt = html.indexOf('id="pet-voice-lab"');
  assert.ok(stripAt > 0 && barAt >= 0 && stripAt > barAt, '状态条应作为 #chatbar 的子节点（绝对定位挂在气泡上）');
  assert.ok(rowAt >= 0 && stripAt > rowAt, '状态条不得插在输入行之前——插进去就会顶走麦克风按钮、取消录音');
  for (const id of ['pet-voice-status', 'pet-voice-wave']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  }

  const css = readSrc('src/renderer/styles.css');
  assert.ok(/\.pet-voice-lab\s*\{[^}]*position:\s*absolute/.test(css), '状态条必须绝对定位（不参与布局）');
  assert.ok(
    /body\.is-chat-window\.is-voice-strip #chatbar\s*\{[^}]*top:\s*var\(--voice-strip-h/.test(css),
    '气泡窗模式：状态条显示时气泡整体下移一条（窗口同步长高，屏幕上原地不动）'
  );

  const cssH = /--voice-strip-h:\s*(\d+)px/.exec(css);
  const mainH = /CHAT_WINDOW_VOICE_STRIP_HEIGHT\s*=\s*(\d+)/.exec(readSrc('src/main/mainImpl.js'));
  assert.ok(cssH && mainH, '两边都应显式声明状态条高度');
  assert.equal(cssH[1], mainH[1], `状态条高度必须一致：CSS=${cssH[1]}px，主进程=${mainH[1]}px`);
});
