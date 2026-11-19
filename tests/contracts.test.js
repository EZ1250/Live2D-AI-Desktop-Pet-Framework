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
const { readSrcSources } = require('./helpers/rendererSandbox');

const ROOT = path.join(__dirname, '..');
/**
 * 渲染层已从 renderer.ts 拆出多个全局脚本（settingsPanel/voiceInput/thinkingOverlay）。
 * 这些断言关心"渲染层代码里有没有这段逻辑"，不关心它此刻在哪个文件里，
 * 因此虚拟路径 'src/renderer/renderer.ts' 统一读渲染层全部源码（顺序同 index.html）。
 */
const rendererSource = () => readSrcSources().join('\n');
const readSrc = (rel) =>
  rel === 'src/renderer/renderer.ts' ? rendererSource() : fs.readFileSync(path.join(ROOT, rel), 'utf8');

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
  // 音色列表：契约/preload/主进程/设置页按钮四处齐全（"拉取全部音色"）
  assert.match(readSrc('src/shared/contracts.ts'), /IPC_TTS_VOICES/, '契约应有 IPC_TTS_VOICES');
  assert.match(readSrc('src/shared/contracts.ts'), /ttsVoices\?\(\)/, 'ElectronAPI 应暴露 ttsVoices');
  assert.match(readSrc('src/preload/preload.ts'), /ipcRenderer\.invoke\(IPC_TTS_VOICES\)/, 'preload 应转发 IPC_TTS_VOICES');
  assert.ok(readSrc('src/main/ipc.ts').includes('ipcMain.handle(IPC_TTS_VOICES'), '主进程应注册 IPC_TTS_VOICES');
  assert.ok(html.includes('id="setting-tts-voices-refresh"'), '设置页应有「拉取全部音色」按钮');
  // 行为触发：点击/连点/拖动/MCP 四个行为键必须在契约、渲染层、插件三处同步
  for (const [file, key] of [
    ['src/shared/contracts.ts', "'mcp'"],
    ['src/shared/contracts.ts', "'multiClick'"],
    ['src/renderer/plugins/behavior.ts', 'multiClick'],
    ['src/renderer/plugins/behavior.ts', 'click'],
  ]) {
    assert.ok(readSrc(file).includes(key), `${file} 应包含行为键 ${key}`);
  }
  assert.ok(
    readSrc('src/main/ai/mcpServer.ts').includes('onToolCall'),
    'MCP 服务端应回调 onToolCall（用于触发"行为触发 → MCP 调用"）',
  );
  // 新增设置项的持久化四路必须齐全：契约 / 写入(sanitizeSettings) / 读取(loadAppSettings) / 渲染层保存
  for (const [file, snippet] of [
    ['src/shared/contracts.ts', 'motionTriggerExpressions?: Partial<Record<BehaviorKey, string>>'],
    ['src/main/ipc.ts', 'settings.motionTriggerExpressionsByModel = byModel'],
    ['src/main/ai/chatClient.ts', "motionTriggerExpressionsByModel: readStringMapByModel('motionTriggerExpressionsByModel')"],
    ['src/renderer/renderer.ts', 'motionTriggerExpressions: collectMotionTriggerExpressions()'],
    ['src/renderer/renderer.ts', 'motionTriggerExpressionsByModel: (() => {'],
    ['src/renderer/renderer.ts', "settings.motionTriggerExpressionsByModel as"],
    // 联网拉取的音色不在内置候选里时，重开设置必须补选项，否则保存会覆盖回默认
    ['src/renderer/renderer.ts', 'ensureSelectValue(ttsVoiceSelect'],
  ]) {
    assert.ok(readSrc(file).includes(snippet), `${file} 缺少持久化必需片段：${snippet}`);
  }
  // 附加目标：可动作可表情 + 同时/衔接 模式，四路持久化 + 插件实现
  for (const [file, snippet] of [
    ['src/shared/contracts.ts', 'motionTriggerPairModes?: Partial<Record<BehaviorKey'],
    ['src/main/ipc.ts', 'cleanModeMap'],
    ['src/main/ai/chatClient.ts', "motionTriggerPairModesByModel: readModeMapByModel('motionTriggerPairModesByModel')"],
    ['src/renderer/renderer.ts', 'motionTriggerPairModesByModel: (() => {'],
    ['src/renderer/renderer.ts', 'collectMotionTriggerPairModes'],
    ['src/renderer/plugins/behavior.ts', 'pairModes'],
    ['src/renderer/plugins/behavior.ts', 'PAIR_CHAIN_EXPRESSION_MS'],
  ]) {
    assert.ok(readSrc(file).includes(snippet), `${file} 缺少附加目标/模式片段：${snippet}`);
  }
  // 拖动行为：检测到拖动的瞬间触发（pointermove），不是松手后
  const rendererSrc = readSrc('src/renderer/renderer.ts');
  assert.ok(
    rendererSrc.indexOf("emitBehavior('drag')") < rendererSrc.indexOf("window.addEventListener('pointerup'"),
    '「拖动」行为必须在 pointermove 阶段即刻触发',
  );
  // 裁剪蒙版分辨率：Cubism 默认 256²，桌宠缩放后会出现方块/斜三角边缘，必须提升
  assert.ok(
    readSrc('src/renderer/live2d.ts').includes('setClippingMaskBufferSize'),
    'live2d.ts 应提升裁剪蒙版缓冲分辨率（避免模型边缘方块/斜三角锯齿）',
  );
  // TTS 试听按钮已挪到 Edge TTS 区（在 VTS 区之前），且位于「自动朗读」与「音色」之间
  assert.ok(
    html.indexOf('id="setting-tts-speak"') < html.indexOf('id="setting-vts-enabled"'),
    '「试听语音」按钮应位于 TTS 设置区',
  );
  assert.ok(
    html.indexOf('id="setting-tts-enabled"') < html.indexOf('id="setting-tts-speak"') &&
      html.indexOf('id="setting-tts-speak"') < html.indexOf('id="setting-tts-voice"'),
    '「试听语音」按钮应位于「自动朗读」与「音色」之间',
  );
  // 行为触发行的「同时/衔接」按钮必须有深色主题样式（不能是浏览器默认白底）
  const stylesSrc = readSrc('src/renderer/styles.css');
  assert.ok(
    stylesSrc.includes('button.trigger-pair-mode') && stylesSrc.includes('background: rgba(255, 255, 255, 0.08)'),
    '「同时/衔接」按钮应有深色主题样式',
  );
  // 全屏：默认不再自动收起，而是 screen-saver 顶层覆盖
  assert.ok(
    readSrc('src/main/mainImpl.js').includes("setAlwaysOnTop(true, 'screen-saver')"),
    '全屏覆盖应使用 screen-saver 层级',
  );
  assert.ok(
    readSrc('src/main/mainImpl.js').includes('fullscreenAutoHide'),
    '全屏策略应读取 fullscreenAutoHide（默认 false=置顶显示）',
  );
  assert.match(readSrc('src/main/ai/chatClient.ts'), /fullscreenAutoHide: bool\(false/, '全屏自动收起默认应为 false');
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

/**
 * 更新检测（GitHub Release）：契约 / preload / 主进程 / 渲染层 / 设置页五处同步。
 * 漏一处的表现：设置页一直"尚未检查"、或点击"前往下载"没反应——所以钉住。
 */
test('更新检测 IPC：契约、preload、主进程、渲染层、设置页五处都接上了', () => {
  assert.equal(contracts.IPC_UPDATE_STATUS_GET, 'update:status:get');
  assert.equal(contracts.IPC_UPDATE_CHECK, 'update:check');
  assert.equal(contracts.IPC_UPDATE_STATUS, 'update:status');
  for (const name of ['IPC_UPDATE_STATUS_GET', 'IPC_UPDATE_CHECK', 'IPC_UPDATE_STATUS']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/main/ipc.ts']) {
      assert.ok(readSrc(file).includes(name), `${file} 应引用 ${name}`);
    }
  }
  // 主进程：启动检查 + 推送（更新提示的唯一入口是设置页，不往托盘/右键菜单塞更新项）
  const main = readSrc('src/main/mainImpl.js');
  for (const token of ['registerUpdateHost', 'startAutoUpdateCheck', 'getCurrentUpdateSnapshot', 'IPC_UPDATE_STATUS']) {
    assert.ok(main.includes(token), `mainImpl.js 应包含 ${token}`);
  }
  assert.ok(!main.includes('发现新版本'), '更新提示只放设置页，托盘菜单不应插入"发现新版本"项');
  assert.ok(!main.includes('cm-update'), '更新提示只放设置页，mainImpl 不应有右键菜单更新项');
  // 检测逻辑在独立模块里（纯函数可单测 + 网络可注入）
  const updater = readSrc('src/main/updateCheck.ts');
  for (const fn of [
    'export function compareVersion',
    'export function isTrustedReleaseUrl',
    'export async function checkForUpdates',
    'export async function fetchLatestRelease',
  ]) {
    assert.ok(updater.includes(fn), `updateCheck.ts 应导出 ${fn}`);
  }
  // preload：三个方法都在
  for (const method of ['getUpdateStatus', 'checkForUpdates', 'onUpdateStatus']) {
    assert.ok(readSrc('src/preload/preload.ts').includes(method), `preload 应提供 ${method}`);
  }
  // 渲染层：拉快照 + 订阅推送 + 状态渲染 + 前往下载
  for (const token of ['installUpdateUi', 'renderUpdateStatus', 'onUpdateStatus', 'btn-open-release', 'isTrustedGithubReleaseUrl']) {
    assert.ok(rendererSource().includes(token), `渲染层应包含 ${token}`);
  }
  assert.ok(!rendererSource().includes('cm-update'), '渲染层不应再有右键菜单更新项');
  // 设置页：开关要能回填 / 保存（"存进去、重启读不回来"的坑）
  assert.ok(readSrc('src/renderer/settingsPanel.ts').includes('setting-check-for-updates'));
  assert.ok(readSrc('src/renderer/renderer.ts').includes('checkForUpdates: elementById'));
  assert.match(readSrc('src/main/ai/chatClient.ts'), /checkForUpdates: bool\(true/, 'loadAppSettings 必须读回 checkForUpdates');
  // index.html：更新区收在"⭐ 您的 Star…"折叠区里，并替代原来的「📦 拿最新版」按钮
  const html = readSrc('src/renderer/index.html');
  const detailsStart = html.indexOf('class="settings-links"');
  const detailsEnd = html.indexOf('</details>', detailsStart);
  const updateStart = html.indexOf('id="settings-update"');
  assert.ok(detailsStart > 0, 'index.html 应有设置页折叠区');
  assert.ok(updateStart > detailsStart && updateStart < detailsEnd, '更新区应放在折叠区（settings-links）里');
  for (const id of ['setting-check-for-updates', 'update-status-text', 'btn-check-update', 'btn-open-release', 'settings-current-version']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  }
  assert.ok(!html.includes('cm-update'), 'index.html 不应再有右键菜单更新项');
  assert.ok(!html.includes('拿最新版'), '原来的「📦 拿最新版」按钮应被更新区替代');
  // 更新设置区必须在设置表单内（不能贴到表单外，否则保存时读不到）
  const formStart = html.indexOf('id="settings-form"');
  assert.ok(formStart > 0 && updateStart > formStart, '更新设置区应在设置表单里');
});

/**
 * AI 接入方式（API / 桥接 DSH）：契约 / preload / 主进程 / 渲染层 / 设置页五处同步。
 * 漏一处的表现：设置页选 DSH 后状态行一直"读取中"、或聊天仍走 API——所以钉住。
 */
test('DSH 桥接 IPC：契约、preload、主进程、渲染层、设置页五处都接上了', () => {
  assert.equal(contracts.IPC_DSH_STATUS, 'dsh:status');
  assert.equal(contracts.IPC_DSH_RESET_SESSION, 'dsh:reset-session');
  for (const name of ['IPC_DSH_STATUS', 'IPC_DSH_RESET_SESSION']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts', 'src/main/ipc.ts']) {
      assert.ok(readSrc(file).includes(name), `${file} 应引用 ${name}`);
    }
  }
  // preload + 契约方法名
  for (const method of ['getDshStatus', 'resetDshSession']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts']) {
      assert.ok(readSrc(file).includes(method), `${file} 应提供 ${method}`);
    }
  }
  // 主进程：独立桥接模块 + 设置页状态/重置 + 聊天分流 + 设置读回
  const dshSrc = readSrc('src/main/ai/dshBridge.ts');
  for (const token of ['class DshBridge', 'export function parseDshLine', 'looksLikeInvalidSession', 'DSH_PERMISSION_MODE']) {
    assert.ok(dshSrc.includes(token), `dshBridge.ts 应包含 ${token}`);
  }
  const chat = readSrc('src/main/ai/chatClient.ts');
  for (const token of ['DshBridge', 'private aiMode', 'dshStatus()', 'resetDshSession()', "this.aiMode === 'dsh'"]) {
    assert.ok(chat.includes(token), `chatClient.ts 应包含 ${token}`);
  }
  assert.match(chat, /aiMode: \(\(\): 'api' \| 'dsh'/, 'loadAppSettings 必须读回 aiMode');
  const main = readSrc('src/main/mainImpl.js');
  for (const token of ['dshStatus: () => chat.dshStatus()', 'dshResetSession: () => chat.resetDshSession()']) {
    assert.ok(main.includes(token), `mainImpl.js 应包含 ${token}`);
  }
  // 渲染层：保存 aiMode + 二选一 UI + DSH 状态/重置
  for (const token of ['setting-ai-mode-dsh', 'syncAiModeDetails', 'refreshDshStatus', 'resetDshSessionFromUi']) {
    assert.ok(rendererSource().includes(token), `渲染层应包含 ${token}`);
  }
  assert.ok(readSrc('src/renderer/renderer.ts').includes('aiMode: elementById'), 'saveSettings 必须提交 aiMode');
  const html = readSrc('src/renderer/index.html');
  for (const id of [
    'setting-ai-mode-api',
    'setting-ai-mode-dsh',
    'ai-api-details',
    'ai-dsh-details',
    'dsh-status-text',
    'dsh-refresh-status',
    'dsh-reset-session',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  }
  // 模型名不再被省略号截断
  const styles = readSrc('src/renderer/styles.css');
  assert.ok(/\.asset-name\s*\{[^}]*white-space:\s*normal/.test(styles), '.asset-name 应允许换行显示完整模型名');
  assert.ok(!/\.asset-name\s*\{[^}]*text-overflow:\s*ellipsis/.test(styles), '.asset-name 不应再用省略号截断');
});


/**
 * 聊天媒体附件（用户↔AI：图片/音频/文件）+ 发送前兼容性检查：五处同步。
 * 漏一处的表现：能选附件但发不出去、提示不出现、AI 回发的文件不显示——所以钉住。
 */
test('聊天媒体附件：契约、preload、主进程、工具、渲染层五处都接上了', () => {
  assert.equal(contracts.IPC_MEDIA_CHECK, 'chat:media-check');
  assert.equal(contracts.IPC_ATTACHMENT_STAGE, 'chat:attachment-stage');
  assert.equal(contracts.IPC_CHAT_MEDIA, 'chat:media');
  for (const name of ['IPC_MEDIA_CHECK', 'IPC_ATTACHMENT_STAGE', 'IPC_CHAT_MEDIA']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts']) {
      assert.ok(readSrc(file).includes(name), `${file} 应引用 ${name}`);
    }
  }
  for (const name of ['IPC_MEDIA_CHECK', 'IPC_ATTACHMENT_STAGE']) {
    assert.ok(readSrc('src/main/ipc.ts').includes(name), `ipc.ts 应引用 ${name}`);
  }
  // 契约类型 + 方法
  const c = readSrc('src/shared/contracts.ts');
  for (const token of ['AttachmentKind', 'AttachmentRef', 'MediaCheckResult', 'ChatMediaPayload', 'ChatMediaMeta']) {
    assert.ok(c.includes(token), `contracts.ts 应定义 ${token}`);
  }
  for (const token of ['checkMedia', 'stageAttachment', 'onChatMedia']) {
    for (const file of ['src/shared/contracts.ts', 'src/preload/preload.ts']) {
      assert.ok(readSrc(file).includes(token), `${file} 应提供 ${token}`);
    }
  }
  assert.match(c, /sendMessage\(text: string, attachments\?: AttachmentRef\[\]\)/, 'sendMessage 应接受附件参数');
  assert.match(c, /interface ChatLogEntry[\s\S]{0,200}media\?: ChatMediaMeta\[\]/, 'ChatLogEntry 应带 media');
  assert.match(c, /interface AppSettings[\s\S]*?visionModel\?: string/, 'AppSettings 应有 visionModel');
  assert.ok(c.includes("visionRoute?: 'auto' | 'chat' | 'custom'"), 'AppSettings 应有 visionRoute');
  assert.ok(c.includes('visionBaseUrl?: string') && c.includes('visionApiKey?: string'), 'AppSettings 应有视觉专用地址/Key');
  // 主进程：附件模块 + chatClient 分流 + dsh 允许写文件 + 设置读写
  const media = readSrc('src/main/ai/mediaAttachments.ts');
  for (const token of [
    'checkMediaCompatibility',
    'prepareAttachmentsForApi',
    'prepareAttachmentsForDsh',
    'parseMediaMarkers',
    'mediaPayloadForFile',
    'stageAttachmentBuffer',
    'describeImages',
  ]) {
    assert.ok(media.includes(token), `mediaAttachments.ts 应包含 ${token}`);
  }
  const chat = readSrc('src/main/ai/chatClient.ts');
  for (const token of ['prepareAttachmentsForApi', 'prepareAttachmentsForDsh', 'parseMediaMarkers', 'checkMediaCompatibility', 'startChat(text: string, attachments?: AttachmentRef[])']) {
    assert.ok(chat.includes(token), `chatClient.ts 应包含 ${token}`);
  }
  assert.ok(readSrc('src/main/ai/dshBridge.ts').includes("DSH_PERMISSION_MODE: 'workspace-write'"), 'DSH 需允许在工作目录内写文件（AI 回发文件）');
  const ipcSrc = readSrc('src/main/ipc.ts');
  for (const token of ['mediaCheck', 'stageAttachment', 'sanitizeChatMedia', 'sanitizeAttachments']) {
    assert.ok(ipcSrc.includes(token), `ipc.ts 应包含 ${token}`);
  }
  assert.ok(readSrc('src/main/mainImpl.js').includes("name === 'send_to_user'"), 'mainImpl 应实现 send_to_user 工具');
  // 工具目录
  const tools = readSrc('src/main/ai/tools/catalog/media.ts');
  assert.ok(tools.includes("name: 'send_to_user'"), '工具目录应包含 send_to_user');
  assert.ok(readSrc('src/main/ai/tools/catalog/all.ts').includes('tool_send_to_user'));
  // 渲染层
  const html = readSrc('src/renderer/index.html');
  for (const id of ['chat-attach', 'chat-file-input', 'chat-attachments', 'chat-attachments-hint', 'setting-vision-model', 'setting-vision-route', 'setting-vision-base-url', 'setting-vision-api-key']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 应包含 #${id}`);
  }
  const renderer = readSrc('src/renderer/renderer.ts');
  for (const token of ['buildMediaCards', 'installChatAttachmentUi', 'appendIncomingMedia', 'refreshAttachmentCompatibility', 'visionModel: value(', "setting-vision-route"]) {
    assert.ok(renderer.includes(token), `renderer.ts 应包含 ${token}`);
  }
  assert.ok(readSrc('src/renderer/voiceInput.ts').includes('sendMessage(text, attachments)'), 'sendChat 应带附件发送');
  assert.ok(readSrc('src/renderer/settingsPanel.ts').includes('setting-vision-model'), '设置页应回填视觉模型');
  const styles = readSrc('src/renderer/styles.css');
  for (const token of ['.chat-attachment-chip', '.chat-media-card', '.chat-media-image', '.chat-attachments-hint']) {
    assert.ok(styles.includes(token), `styles.css 应包含 ${token}`);
  }
});


/**
 * 性能优化（纹理降采样缓存 / VTS 空闲抑制 / 流式增量合并）：接线与开关别被改回去。
 */
test('性能优化：纹理降采样缓存、流式增量合并、VTS 空闲抑制都接上了', () => {
  // 设置项 + 读写
  const c = readSrc('src/shared/contracts.ts');
  assert.ok(c.includes('textureMaxSize?: number'), 'AppSettings 应有 textureMaxSize');
  assert.ok(readSrc('src/main/ipc.ts').includes('textureMaxSize'), '设置白名单应允许 textureMaxSize');
  assert.ok(readSrc('src/main/ai/chatClient.ts').includes("num(4096, 'textureMaxSize')"), 'loadAppSettings 应读回 textureMaxSize');
  // 纹理缓存模块 + 静态服务 overlay + 模型加载后调度
  const cache = readSrc('src/main/modelTextureCache.ts');
  for (const token of ['ensureUserModelTextureCache', 'scheduleUserModelTextureCache', 'userModelCacheDir', 'nativeImage']) {
    assert.ok(cache.includes(token), `modelTextureCache.ts 应包含 ${token}`);
  }
  assert.ok(cache.includes('20000'), '缓存构建应防抖（停留 20s 再构建，避免拖慢切模型）');
  const info = readSrc('src/main/modelTextureInfo.ts');
  for (const token of ['readImageInfo', 'normalizeTextureMax', 'sanitizeCacheKey']) {
    assert.ok(info.includes(token), `modelTextureInfo.ts 应包含 ${token}`);
  }
  assert.ok(readSrc('src/main/staticServer.ts').includes('cacheRoot?:'), '静态服务应支持缓存 overlay');
  assert.ok(readSrc('src/main/mainImpl.js').includes('cacheRoot: (name) => (0, modelTextureCache_1.userModelCacheDir)(name)'));
  assert.ok(readSrc('src/main/ipc.ts').includes('scheduleUserModelTextureCache(manifest.name)'), '加载模型后应调度缓存构建');
  // 设置页
  const html = readSrc('src/renderer/index.html');
  assert.ok(html.includes('id="setting-texture-max"'), '设置页应有纹理精度选择');
  assert.ok(readSrc('src/renderer/settingsPanel.ts').includes('setting-texture-max'));
  assert.ok(readSrc('src/renderer/renderer.ts').includes("value('setting-texture-max')") || readSrc('src/renderer/renderer.ts').includes("'setting-texture-max'"));
  // 流式增量合并（16ms）
  const main = readSrc('src/main/mainImpl.js');
  assert.ok(main.includes('queueChatDelta(delta)'), 'onChunk 应走合并缓冲');
  assert.ok(main.includes('flushChatDeltas();'), 'onDone/onError 前应 flush 合并缓冲');
  assert.ok(/setTimeout\(\(\) => \{\s*chatDeltaTimer = null;/.test(main), '合并器应 16ms 定时 flush');
  // VTS 空闲抑制
  const renderer = readSrc('src/renderer/renderer.ts');
  assert.ok(renderer.includes('vtsConnected'), 'VTS 推送应记录连接状态');
  assert.ok(renderer.includes('!vtsTrackingEnabled || !vtsConnected'), 'VTS 未连接时不应发追踪帧');
  assert.ok(renderer.includes('refreshVtsConnection'), '应有 VTS 连接状态探测');
});
