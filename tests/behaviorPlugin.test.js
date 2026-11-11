/**
 * behaviorPlugin.test.js —— 行为触发插件（plugins/behavior.js）
 *
 * 覆盖：新增的点击/连点/拖动/MCP 行为键、"动作 + 同时表情"组合、去抖与失效目标。
 * 用假 model/render 服务观察插件是否把正确的调用交给渲染层。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'renderer');
const KERNEL = path.join(DIST, 'kernel.js');
const PLUGIN = path.join(DIST, 'plugins', 'behavior.js');

const ALL_KEYS = [
  'startup',
  'user_message',
  'tool_call',
  'command_exec',
  'ai_start',
  'model_idle',
  'error',
  'click',
  'multiClick',
  'drag',
  'mcp',
];

function boot() {
  for (const file of [PLUGIN, KERNEL]) delete require.cache[require.resolve(file)];
  require(KERNEL);
  const kernel = globalThis.PetKernel;
  const calls = [];
  const model = {
    motions: () => ['Idle', 'Tap'],
    expressions: () => ['smile', 'sad'],
    capabilities: () => ({ click: ['smile'] }),
    emotionMap: () => ({ happy: 'smile' }),
  };
  const render = {
    ready: () => true,
    playMotion: (name) => calls.push(['motion', name]),
    holdExpression: (name) => calls.push(['expr', name]),
  };
  kernel.provide('model', model);
  kernel.provide('render', render);
  kernel.setActionBridge(() => undefined);
  require(PLUGIN);
  const configure = (byModel, expressions = {}, extra = {}) => {
    kernel.emit('behavior:config', {
      byModel,
      legacy: {},
      expressions,
      pairModes: extra.pairModes ?? {},
      chainDelayMs: extra.chainDelayMs,
      modelName: 'M',
      labels: {},
      keys: ALL_KEYS,
    });
  };
  return { kernel, calls, configure };
}

test('新增行为键：click / multiClick / drag / mcp 都能触发并解析到动作', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({
    M: {
      click: 'motion:Tap',
      multiClick: 'motion:Idle',
      drag: 'motion:Tap',
      mcp: 'motion:Idle',
    },
  });
  kernel.emit('behavior', 'click');
  kernel.emit('behavior', 'multiClick');
  kernel.emit('behavior', 'drag');
  kernel.emit('behavior', 'mcp');
  assert.deepEqual(calls, [
    ['motion', 'Tap'],
    ['motion', 'Idle'],
    ['motion', 'Tap'],
    ['motion', 'Idle'],
  ]);
});

test('启动行为键：可单独绑定动作，启动时播一次', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { startup: 'motion:Idle' } });
  kernel.emit('behavior', 'startup');
  assert.deepEqual(calls, [['motion', 'Idle']]);
});

test('动作 + 同时表情：一次触发先播动作再叠表情（可同时生效）', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'motion:Tap' } }, { click: 'smile' });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [
    ['motion', 'Tap'],
    ['expr', 'smile'],
  ]);
});

test('只配"同时表情"、不配动作：表情也能单独生效', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: '' } }, { click: 'sad' });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [['expr', 'sad']]);
});

test('同时表情在模型上不存在：不应用、也不影响动作', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'motion:Tap' } }, { click: 'not-exist' });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [['motion', 'Tap']]);
});

test('去抖：同一行为短时间内只触发一次（click 250ms）', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'motion:Tap' } });
  kernel.emit('behavior', 'click');
  kernel.emit('behavior', 'click');
  assert.equal(calls.length, 1);
});

test('行为绑定目标失效：不播放，但不抛错', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'motion:NotThere' } });
  assert.doesNotThrow(() => kernel.emit('behavior', 'click'));
  assert.deepEqual(calls, []);
});

test('附加目标不限制种类：可以是动作组（同时播放）', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'expr:smile' } }, { click: 'motion:Idle' });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [
    ['expr', 'smile'],
    ['motion', 'Idle'],
  ]);
});

test('衔接模式：主目标先播，附加表情延时后再播', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'motion:Tap' } }, { click: 'expr:sad' }, { pairModes: { click: 'chain' }, chainDelayMs: 30 });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [['motion', 'Tap']], '衔接模式下附加目标不能立刻播放');
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(calls, [
    ['motion', 'Tap'],
    ['expr', 'sad'],
  ]);
});

test('衔接模式也允许附加动作组', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'expr:smile' } }, { click: 'motion:Idle' }, { pairModes: { click: 'chain' }, chainDelayMs: 20 });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [['expr', 'smile']]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(calls, [
    ['expr', 'smile'],
    ['motion', 'Idle'],
  ]);
});

test('同时模式缺省：不配 pairModes 时附加目标立刻应用', async () => {
  const { kernel, calls, configure } = boot();
  await kernel.start();
  configure({ M: { click: 'motion:Tap' } }, { click: 'expr:sad' });
  kernel.emit('behavior', 'click');
  assert.deepEqual(calls, [
    ['motion', 'Tap'],
    ['expr', 'sad'],
  ]);
});
