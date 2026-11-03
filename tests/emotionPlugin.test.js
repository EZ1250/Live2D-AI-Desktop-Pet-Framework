/**
 * emotionPlugin.test.js —— 情绪策略插件的判定与阈值（纯 Node，不启 Electron）
 *
 * 直接加载编译产物：emotion.js（规则库）→ kernel.js → plugins/emotion.js，
 * 用假 render 服务观察插件是否按原语义发出表情。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'renderer');
const EMOTION = path.join(DIST, 'emotion.js');
const KERNEL = path.join(DIST, 'kernel.js');
const PLUGIN = path.join(DIST, 'plugins', 'emotion.js');

/** 每个用例重新加载一套：规则库 → 内核 → 插件（插件在加载时注册） */
function boot() {
  for (const file of [PLUGIN, KERNEL, EMOTION]) delete require.cache[require.resolve(file)];
  require(EMOTION);
  require(KERNEL);
  const kernel = globalThis.PetKernel;
  require(PLUGIN);
  const applied = [];
  kernel.provide('render', { applyEmotion: (label) => (applied.push(label), `expr:${label}`) });
  const actions = [];
  kernel.setActionBridge((action, payload) => actions.push([action, payload]));
  return { kernel, applied, actions };
}

test('对话文本：命中情绪 → 走 render.applyEmotion，返回应用到的表情名', async () => {
  const { kernel, applied } = boot();
  await kernel.start();
  kernel.emit('chat:reply', '今天真的好开心');
  assert.deepEqual(applied, ['happy']);
  assert.equal(kernel.call('emotion.applyText', '今天真的好开心'), 'expr:happy');
});

test('对话文本：中性/被否定 → 不切表情', async () => {
  const { kernel, applied } = boot();
  await kernel.start();
  kernel.emit('chat:reply', '今天吃什么');
  kernel.emit('chat:reply', '不太开心');
  kernel.emit('chat:reply', '');
  assert.deepEqual(applied, []);
});

test('追踪帧情绪：置信度 ≥0.34 才发 expression 动作，低于阈值丢弃', async () => {
  const { kernel, actions } = boot();
  await kernel.start();
  kernel.emit('tracking:emotion', { label: 'sad', confidence: 0.34 });
  kernel.emit('tracking:emotion', { label: 'sad', confidence: 0.1 });
  kernel.emit('tracking:emotion', {});
  assert.deepEqual(actions, [['expression', { label: 'sad' }]]);
});

test('render 服务缺失：同步入口返回 null 不抛（其余功能不受影响）', async () => {
  for (const file of [PLUGIN, KERNEL, EMOTION]) delete require.cache[require.resolve(file)];
  require(EMOTION);
  require(KERNEL);
  const kernel = globalThis.PetKernel;
  require(PLUGIN);
  await kernel.start();
  const silence = console.error;
  console.error = () => {};
  try {
    assert.equal(kernel.call('emotion.applyText', '今天真的好开心'), undefined);
  } finally {
    console.error = silence;
  }
});
