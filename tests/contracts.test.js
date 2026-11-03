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
 * 交互事件通道（单击 / 连点 / 长拖 → 语料分组）：同样必须四处同步。
 * 这条是 renderer→main 的 fire-and-forget 通道，漏一处不会报错，只会"点了没反应"。
 */
test('宠物交互事件 IPC：契约、preload、主进程、渲染层、语料五处都接上了', () => {
  const name = 'IPC_PET_EVENT';
  assert.equal(contracts.IPC_PET_EVENT, 'pet:event');
  for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/main/ipc.ts']) {
    assert.ok(readSrc(file).includes(name), `${file} 应当引用 ${name}`);
  }
  // 渲染层调用方法名；契约/preload 提供
  for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/renderer/renderer.ts']) {
    assert.ok(readSrc(file).includes('petEvent'), `${file} 应当提供/调用 petEvent`);
  }
  // 主进程：ipc.ts 声明依赖 → mainImpl 注入；三种事件都要映射到语料分组 + 分组冷却
  assert.ok(readSrc('src/main/ipc.ts').includes('onPetEvent?:'), 'ipc.ts 应声明 onPetEvent 依赖');
  const main = readSrc('src/main/mainImpl.js');
  assert.ok(main.includes('onPetEvent:'), 'mainImpl.js 应注入 onPetEvent');
  for (const group of ['点击宠物', '连续点击', '拖动宠物']) {
    assert.ok(main.includes(group), `mainImpl.js 应登记语料分组「${group}」`);
    assert.ok(readSrc('personas/character.offline.txt').includes(`## ${group}`), `语料应包含「## ${group}」小节`);
  }
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

/**
 * VTube Studio（可选后端）：契约 / preload / 主进程 / 渲染层四处必须同步。
 * 高频追踪通道漏接的表现最隐蔽：设置里"看起来开了"，但 VTS 里的模型一动不动。
 */
test('VTS IPC：契约、preload、主进程、渲染层四处都接上了', () => {
  assert.equal(contracts.IPC_VTS_STATUS, 'vts:status');
  assert.equal(contracts.IPC_VTS_ACTION, 'vts:action');
  assert.equal(contracts.IPC_VTS_TRACKING, 'vts:tracking');
  assert.equal(contracts.IPC_VTS_STATUS_PUSH, 'vts:statusPush');
  assert.equal(contracts.IPC_VTS_EVENT_PUSH, 'vts:eventPush');

  // 通道名：契约 → preload → 主进程
  for (const name of ['IPC_VTS_STATUS', 'IPC_VTS_ACTION', 'IPC_VTS_TRACKING']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/main/ipc.ts']) {
      assert.ok(readSrc(file).includes(name), `${file} 应当引用 ${name}`);
    }
  }
  // 高频追踪必须是 ipcMain.on（不能 await），否则 30fps 注入会堵住 IPC 队列
  const ipc = readSrc('src/main/ipc.ts');
  assert.ok(/ipcMain\.on\(\s*IPC_VTS_TRACKING/.test(ipc), 'ipc.ts 应使用 ipcMain.on 接收高频追踪');

  // 渲染层调用面：preload 暴露 + renderer 调用
  for (const method of ['vtsStatus', 'vtsAction', 'sendVtsTracking', 'onVtsStatus']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts']) {
      assert.ok(readSrc(file).includes(method), `${file} 应当提供 ${method}`);
    }
  }
  const renderer = readSrc('src/renderer/renderer.ts');
  for (const method of ['sendVtsTracking', 'vtsAction', 'vtsStatus']) {
    assert.ok(renderer.includes(method), `renderer.ts 应当调用 ${method}`);
  }
  // 设置页要真有这些控件（否则代码接好了、用户点不到）
  const html = readSrc('src/renderer/index.html');
  for (const id of ['setting-vts-enabled', 'setting-vts-port', 'setting-vts-connect', 'setting-vts-authorize', 'setting-vts-status']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  }

  // 主进程：ipc.ts 声明依赖 → mainImpl 注入并实现（未接 VTS 时也要能安全降级）
  assert.ok(ipc.includes('vtsStatus?:'), 'ipc.ts 应声明 vtsStatus 依赖');
  assert.ok(ipc.includes('vtsAction?:'), 'ipc.ts 应声明 vtsAction 依赖');
  assert.ok(ipc.includes('onVtsTracking?:'), 'ipc.ts 应声明 onVtsTracking 依赖');
  const main = readSrc('src/main/mainImpl.js');
  for (const piece of ['vtsStatus:', 'vtsAction:', 'onVtsTracking:', 'VtsService', 'applyVtsSettings']) {
    assert.ok(main.includes(piece), `mainImpl.js 应包含 ${piece}`);
  }

  // ---- VTS → 桌宠反向同步（事件通道）----
  assert.ok(readSrc('src/shared/contracts.ts').includes('IPC_VTS_EVENT_PUSH'), 'contracts.ts 应定义 IPC_VTS_EVENT_PUSH');
  assert.ok(readSrc('src/preload/preload.ts').includes('IPC_VTS_EVENT_PUSH'), 'preload 应订阅 IPC_VTS_EVENT_PUSH');
  assert.ok(readSrc('src/preload/preload.ts').includes('onVtsEvent'), 'preload 应暴露 onVtsEvent');
  assert.ok(main.includes('pushVtsEvent'), 'mainImpl.js 应把 VTS 事件推给渲染层');
  assert.ok(main.includes('IPC_VTS_EVENT_PUSH'), 'mainImpl.js 应使用 IPC_VTS_EVENT_PUSH 推送');
  assert.ok(renderer.includes('onVtsEvent'), 'renderer 应订阅 onVtsEvent');
  assert.ok(renderer.includes('function applyVtsEvent('), 'renderer 应有 applyVtsEvent（事件 → 本地表情/动作）');
  // 反向同步只本地应用：热键事件里绝不能调 vtsAction（否则 VTS ↔ 桌宠来回触发）
  const applyAt = renderer.indexOf('function applyVtsEvent(');
  const applyEnd = renderer.indexOf('\n}\n', applyAt);
  assert.ok(applyAt >= 0 && applyEnd > applyAt, '找不到 applyVtsEvent 的完整函数体');
  const applyBody = renderer.slice(applyAt, applyEnd);
  assert.ok(!applyBody.includes('vtsAction'), 'applyVtsEvent 里不得回写 VTS（会形成事件回环）');
  assert.ok(/setExpression/.test(applyBody) && /playMotion/.test(applyBody), '热键名应能落到 setExpression / playMotion');
  assert.ok(renderer.includes('vtsEvents:'), '__petDebug.vtsEvents() 用于自查事件是否到达');
});

/** TTS 播放：主进程合成（pet:tts:speak）→ 渲染层 new Audio 播放（pet:tts:audio） */
test('Edge TTS 播放接线：speak handler + 渲染层播放 + 说话时 VTS 张嘴', () => {
  assert.equal(contracts.IPC_TTS_SPEAK, 'pet:tts:speak');
  assert.equal(contracts.IPC_TTS_AUDIO, 'pet:tts:audio');
  assert.equal(contracts.TTS_AUDIO_MIME, 'audio/mpeg');
  for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/main/ipc.ts']) {
    assert.ok(readSrc(file).includes('IPC_TTS_SPEAK'), `${file} 应当引用 IPC_TTS_SPEAK`);
    assert.ok(readSrc(file).includes('IPC_TTS_AUDIO'), `${file} 应当引用 IPC_TTS_AUDIO`);
  }
  assert.ok(/ipcMain\.handle\(\s*IPC_TTS_SPEAK/.test(readSrc('src/main/ipc.ts')), 'ipc.ts 应注册 speak handler');
  const renderer = readSrc('src/renderer/renderer.ts');
  assert.ok(renderer.includes('new Audio('), '渲染层应真的用 new Audio(...) 播放');
  assert.ok(renderer.includes('onTtsAudio'), '渲染层应订阅 onTtsAudio');
  assert.ok(readSrc('src/main/ipc.ts').includes('onVtsMouth'), '说话时应向 VTS 注入 MouthOpen');
  // 对话自动朗读：契约 / preload / 渲染层 / 设置页四处都接上，且旧结果必须被丢弃
  assert.match(readSrc('src/preload/preload.ts'), /ipcRenderer\.invoke\(IPC_TTS_SPEAK,\s*text,\s*voice,\s*requestId\)/, 'preload 必须透传音色和 requestId');
  assert.match(renderer, /payload\.requestId !== latestTtsRequestId/, '渲染层必须丢弃过期 TTS 结果');
  assert.ok(renderer.includes('beginTtsRequest()'), '每次 TTS 请求必须生成并登记 requestId');
  assert.ok(renderer.includes('speakConversation(bridge, payload.full)'), 'AI 回复必须接自动朗读');
  assert.ok(renderer.includes('speakConversation(bridge, payload.text)'), '主动气泡必须接自动朗读');
  assert.ok(renderer.includes('applyTtsSettings(bootSettings)'), '启动时必须初始化朗读开关（不打开设置页也要生效）');
  assert.match(readSrc('src/main/ai/chatClient.ts'), /ttsEnabled: bool\(false, 'ttsEnabled'\)/, 'loadAppSettings 必须读回 ttsEnabled（否则重启丢配置）');
  assert.match(readSrc('src/main/ai/chatClient.ts'), /ttsVoice: str\('ttsVoice'\)/, 'loadAppSettings 必须读回 ttsVoice');
  assert.match(readSrc('src/shared/contracts.ts'), /ttsEnabled\?: boolean/);
  assert.match(readSrc('src/shared/contracts.ts'), /ttsVoice\?: string/);
  assert.ok(readSrc('src/main/ipc.ts').includes('const stopTtsMouth'), '新 TTS 请求必须先收口上一段 VTS 口型');
  const html = readSrc('src/renderer/index.html');
  for (const id of ['setting-tts-enabled', 'setting-tts-voice', 'setting-tts-speak']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  }
  // 自动播放开关已前移到 earlySwitches（由 main.ts 在 mainImpl 之前 import、mainImpl 顶部也 require）：
  // 位置必须"早于任何 app ready / 创建窗口"，所以不能再只查 mainImpl.js 里那一段。
  assert.ok(
    readSrc('src/main/earlySwitches.ts').includes("AUTOPLAY_POLICY_SWITCH = 'autoplay-policy'"),
    'earlySwitches.ts 应装 autoplay-policy（app ready 前生效）',
  );
  assert.ok(
    readSrc('src/main/main.ts').indexOf("import './earlySwitches'") <
      readSrc('src/main/main.ts').indexOf("import './mainImpl'"),
    'main.ts 必须先 import earlySwitches，再 import mainImpl',
  );
  assert.ok(
    readSrc('src/main/mainImpl.js').includes('require("./earlySwitches")'),
    'mainImpl.js 顶部也 require 一次 earlySwitches（直接 require mainImpl 的入口同样有保障）',
  );
});
