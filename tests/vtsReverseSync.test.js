/**
 * vtsReverseSync.test.js —— VTS 热键事件 → 桌宠本地表情/动作（渲染层真实逻辑，无头运行）
 *
 * 背景：以前只有「桌宠 → VTS」单向（视线/MouthOpen 注入）。本功能加的是反方向：
 * VTS 里触发热键（VTS UI 或我们按钮）→ 主进程收到 HotkeyTriggeredEvent → IPC_VTS_EVENT_PUSH
 * → 渲染层 applyVtsEvent：
 *   1) 本地 handle.listExpressions() 有同名 → setExpression(name)
 *   2) 否则 listMotions() 有同名 → playMotion(name)
 *   3) 都没有 → 忽略并记日志（不弹窗、不报错）
 *   4) **绝不回写 VTS**（否则热键事件会回环）
 *
 * 怎么测：从编译产物 dist/renderer/renderer.js 里取出 applyVtsEvent / matchLocalName 两个
 * 顶层函数（`\n}\n` 是 tsc 输出的顶层函数边界），放进 vm 上下文，用桩 currentHandle 调它。
 * 这样跑的是**真实渲染层代码**，不需要 Electron 窗口（本机沙箱起不了 Electron，见 AGENTS.md）。
 *
 * 前置：npm test 会先 build:tsc。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(__dirname, '..');
const RENDERER = path.join(APP, 'dist', 'renderer', 'renderer.js');

/** 从编译产物里截出一个顶层函数（tsc 输出：顶格 `function name(` … 顶格 `}`） */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `dist/renderer/renderer.js 里找不到 ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, `${name} 的函数体边界异常`);
  return source.slice(start, end + 3);
}

/** 用桩 handle + 桩名字表搭一个能跑 applyVtsEvent 的上下文 */
function createHarness(options = {}) {
  const source = fs.readFileSync(RENDERER, 'utf8');
  const code = `${extractFunction(source, 'matchLocalName')}\n${extractFunction(source, 'applyVtsEvent')}`;
  const calls = [];
  const logs = [];
  let expressionNames = options.expressions ?? [];
  let motionNames = options.motions ?? [];
  const context = {
    currentHandle: options.handle ?? null,
    vtsEventCount: 0,
    lastVtsEvent: null,
    lastVtsEventAction: '',
    listCurrentExpressions: () => expressionNames.slice(),
    listCurrentMotions: () => motionNames.slice(),
    console: {
      info: (message) => logs.push(String(message)),
      warn: (message) => logs.push(String(message)),
      log: () => {},
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context, { filename: 'renderer-applyVtsEvent.js' });
  return {
    calls,
    logs,
    context,
    apply: (event) => context.applyVtsEvent(event),
    setHandle(handle) {
      context.currentHandle = handle;
    },
    setNames(nextExpressions, nextMotions) {
      expressionNames = nextExpressions;
      motionNames = nextMotions;
    },
  };
}

function stubHandle(options = {}) {
  const calls = options.calls ?? [];
  return {
    calls,
    setExpression(name) {
      if (options.throwOnExpression) throw new Error('表情失败');
      calls.push({ type: 'expression', name });
    },
    playMotion(group) {
      calls.push({ type: 'motion', name: group });
    },
  };
}

function hotkeyEvent(hotkeyName, extra = {}) {
  return {
    kind: 'hotkeyTriggered',
    hotkeyID: 'id-1',
    hotkeyName,
    hotkeyAction: 'ToggleExpression',
    hotkeyTriggeredByAPI: false,
    modelID: 'mid',
    modelName: '示例模型',
    at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

test('热键名命中本地表情 → setExpression（优先于动作组）', () => {
  const calls = [];
  const harness = createHarness({ expressions: ['开心', 'Idle'], motions: ['Idle'], handle: stubHandle({ calls }) });
  harness.apply(hotkeyEvent('开心'));
  assert.deepEqual(calls, [{ type: 'expression', name: '开心' }]);
  assert.equal(harness.context.lastVtsEventAction, 'expression:开心');
  assert.equal(harness.context.vtsEventCount, 1);
  assert.deepEqual(harness.context.lastVtsEvent.hotkeyName, '开心');
  assert.deepEqual(harness.logs, []);
});

test('热键名命中本地动作组 → playMotion（没有同名表情时）', () => {
  const calls = [];
  const harness = createHarness({ expressions: ['开心'], motions: ['挥手', 'Idle'], handle: stubHandle({ calls }) });
  harness.apply(hotkeyEvent('挥手'));
  assert.deepEqual(calls, [{ type: 'motion', name: '挥手' }]);
  assert.equal(harness.context.lastVtsEventAction, 'motion:挥手');
});

test('名字大小写不敏感（VTS 热键名本来就大小写不敏感）', () => {
  const calls = [];
  const harness = createHarness({ expressions: ['Happy'], handle: stubHandle({ calls }) });
  harness.apply(hotkeyEvent('happy'));
  assert.deepEqual(calls, [{ type: 'expression', name: 'Happy' }], '要按本地真实名字应用，而不是 VTS 发来的大小写');
  assert.equal(harness.context.lastVtsEventAction, 'expression:Happy');
});

test('本地没有同名表情/动作组 → 忽略并记日志，不抛错、不弹窗', () => {
  const calls = [];
  const harness = createHarness({ expressions: ['呆猫'], motions: ['Idle'], handle: stubHandle({ calls }) });
  assert.doesNotThrow(() => harness.apply(hotkeyEvent('兔牙')));
  assert.deepEqual(calls, []);
  assert.equal(harness.context.vtsEventCount, 1);
  assert.equal(harness.context.lastVtsEventAction, 'ignored:兔牙');
  assert.equal(harness.logs.length, 1);
  assert.match(harness.logs[0], /兔牙/);
  assert.match(harness.logs[0], /已忽略/);
});

test('空热键名 / 模型没挂载 → 安静忽略（不抛错）', () => {
  const calls = [];
  const harness = createHarness({ expressions: ['开心'], handle: stubHandle({ calls }) });
  assert.doesNotThrow(() => harness.apply(hotkeyEvent('')));
  assert.deepEqual(calls, []);
  assert.equal(harness.context.lastVtsEventAction, 'ignored:(空)');

  harness.setHandle(null);
  assert.doesNotThrow(() => harness.apply(hotkeyEvent('开心')));
  assert.deepEqual(calls, []);
  assert.equal(harness.context.lastVtsEventAction, 'ignored:开心', '没挂模型时不该有调用，但要留"忽略"记录');
});

test('表情设置抛错时退回同名动作组（不把事件整个吞掉）', () => {
  const calls = [];
  const harness = createHarness({
    expressions: ['开心'],
    motions: ['开心'],
    handle: stubHandle({ calls, throwOnExpression: true }),
  });
  harness.apply(hotkeyEvent('开心'));
  assert.deepEqual(calls, [{ type: 'motion', name: '开心' }]);
  assert.equal(harness.context.lastVtsEventAction, 'motion:开心');
});

test('ModelLoadedEvent 只记录、不驱动模型（换模型不等于播动作）', () => {
  const calls = [];
  const harness = createHarness({ handle: stubHandle({ calls }) });
  harness.apply({ kind: 'modelLoaded', modelLoaded: true, modelName: '示例模型', modelID: 'mid', at: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(calls, []);
  assert.equal(harness.context.vtsEventCount, 1);
  assert.equal(harness.context.lastVtsEventAction, 'modelLoaded');
});

test('脏事件（null / 非对象）不会抛错', () => {
  const harness = createHarness({ handle: stubHandle({}) });
  assert.doesNotThrow(() => harness.apply(null));
  assert.doesNotThrow(() => harness.apply(undefined));
  assert.doesNotThrow(() => harness.apply('hotkey'));
  assert.equal(harness.context.vtsEventCount, 0);
});
