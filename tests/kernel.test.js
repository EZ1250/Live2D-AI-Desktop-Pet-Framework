/**
 * kernel.test.js —— 渲染层微内核（kernel.js）的契约与生命周期
 *
 * 内核是全局脚本（无 exports），这里用 require 执行一遍再从 globalThis 取实例；
 * 每个用例重新 require 一次，拿到干净实例，避免用例之间互相影响。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const KERNEL = path.join(APP, 'dist', 'renderer', 'kernel.js');

function freshKernel() {
  delete require.cache[require.resolve(KERNEL)];
  require(KERNEL);
  return globalThis.PetKernel;
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('注册 + 启动：setup 拿到上下文，广播能到订阅者', async () => {
  const kernel = freshKernel();
  const seen = [];
  kernel.register({
    name: 'echo',
    setup(ctx) {
      ctx.on('chat:reply', (text) => seen.push(text));
    },
  });
  await kernel.start();
  kernel.emit('chat:reply', '你好');
  assert.deepEqual(seen, ['你好']);
});

test('服务表：renderer 提供、插件取用，拿到同一个对象', async () => {
  const kernel = freshKernel();
  const render = { applyEmotion: () => 'smile' };
  kernel.provide('render', render);
  let got = null;
  kernel.register({
    name: 'consumer',
    setup(ctx) {
      got = ctx.service('render');
    },
  });
  await kernel.start();
  assert.equal(got, render);
  assert.throws(() => kernel.service('missing'), /未注册服务/);
});

test('动作桥：插件 emit 的动作转给核心', async () => {
  const kernel = freshKernel();
  const actions = [];
  kernel.setActionBridge((action, payload) => actions.push([action, payload]));
  kernel.register({
    name: 'actor',
    setup(ctx) {
      ctx.emit('expression', { label: 'happy' });
    },
  });
  await kernel.start();
  assert.deepEqual(actions, [['expression', { label: 'happy' }]]);
});

test('依赖：按声明顺序启动，被依赖者先就绪', async () => {
  const kernel = freshKernel();
  const order = [];
  kernel.register({ name: 'base', setup: () => order.push('base') });
  kernel.register({ name: 'leaf', dependencies: ['base'], setup: () => order.push('leaf') });
  await kernel.start();
  kernel.register({ name: 'late', dependencies: ['leaf'], setup: () => order.push('late') });
  await tick();
  assert.deepEqual(order, ['base', 'leaf', 'late']);
});

test('依赖缺失 / 成环：不启动、不抛到调用方', async () => {
  const kernel = freshKernel();
  let called = 0;
  kernel.register({ name: 'orphan', dependencies: ['nope'], setup: () => (called += 1) });
  kernel.register({ name: 'ringA', dependencies: ['ringB'], setup: () => (called += 1) });
  kernel.register({ name: 'ringB', dependencies: ['ringA'], setup: () => (called += 1) });
  const silence = console.error;
  console.error = () => {};
  try {
    await kernel.start();
  } finally {
    console.error = silence;
  }
  assert.equal(called, 0);
});

test('同步入口：handle 注册、call 返回值；入口抛错被隔离', async () => {
  const kernel = freshKernel();
  kernel.register({
    name: 'math',
    setup(ctx) {
      ctx.handle('math.add', (a, b) => a + b);
      ctx.handle('math.boom', () => {
        throw new Error('boom');
      });
    },
  });
  await kernel.start();
  assert.equal(kernel.call('math.add', 1, 2), 3);
  const silence = console.error;
  console.error = () => {};
  try {
    assert.equal(kernel.call('math.boom'), undefined);
  } finally {
    console.error = silence;
  }
  assert.equal(kernel.call('math.none'), undefined);
});

test('卸载：清监听、清同步入口、调 teardown；被依赖时拒绝卸载', async () => {
  const kernel = freshKernel();
  const seen = [];
  let teardownCalled = 0;
  kernel.register({
    name: 'temp',
    setup(ctx) {
      ctx.on('chat:reply', (text) => seen.push(text));
      ctx.handle('temp.echo', (text) => text);
    },
    teardown() {
      teardownCalled += 1;
    },
  });
  kernel.register({ name: 'needs-temp', dependencies: ['temp'], setup() {} });
  await kernel.start();

  await assert.rejects(() => kernel.unregister('temp'), /仍被依赖/);
  assert.equal(await kernel.unregister('needs-temp'), true);
  assert.equal(await kernel.unregister('temp'), true);
  assert.equal(teardownCalled, 1);
  kernel.emit('chat:reply', '卸载后');
  assert.deepEqual(seen, []);
  assert.equal(kernel.call('temp.echo', 'x'), undefined);
  assert.equal(await kernel.unregister('temp'), false);
});

test('订阅者抛错不影响其它订阅者与后续派发', async () => {
  const kernel = freshKernel();
  const seen = [];
  kernel.register({
    name: 'bad',
    setup(ctx) {
      ctx.on('chat:reply', () => {
        throw new Error('subscriber boom');
      });
    },
  });
  kernel.register({
    name: 'good',
    setup(ctx) {
      ctx.on('chat:reply', (text) => seen.push(text));
    },
  });
  const silence = console.error;
  console.error = () => {};
  try {
    await kernel.start();
    kernel.emit('chat:reply', '第一次');
    kernel.emit('chat:reply', '第二次');
  } finally {
    console.error = silence;
  }
  assert.deepEqual(seen, ['第一次', '第二次']);
});

test('加载顺序：kernel.js → 插件 → UI 模块 → renderer.js（index.html 与装配清单一致）', () => {
  const html = fs.readFileSync(path.join(APP, 'src', 'renderer', 'index.html'), 'utf8');
  const at = (src) => html.indexOf(`src="./${src}"`);
  assert.ok(at('kernel.js') > 0, 'index.html 应加载 kernel.js');
  assert.ok(at('plugins/emotion.js') > at('kernel.js'), '插件必须在 kernel.js 之后');
  assert.ok(at('plugins/behavior.js') > at('kernel.js'), '行为插件也必须在 kernel.js 之后');
  for (const src of ['fx.js', 'panels/todo.js', 'panels/askBox.js']) {
    assert.ok(at(src) > 0, `index.html 应加载 ${src}`);
    assert.ok(at('renderer.js') > at(src), `${src} 必须在 renderer.js 之前（renderer 负责 install(deps) 注入）`);
  }
  assert.ok(at('renderer.js') > at('plugins/emotion.js'), 'renderer.js 必须在插件之后（它负责提供 render 服务）');

  const assemble = fs.readFileSync(path.join(APP, 'scripts', 'assemble-renderer.js'), 'utf8');
  assert.ok(assemble.includes("'kernel.js'"), 'assemble 清单必须包含 kernel.js');
  assert.ok(assemble.includes("'fx.js'"), 'assemble 清单必须包含 fx.js');
  for (const dir of ['plugins', 'panels']) {
    assert.ok(assemble.includes(`'${dir}'`), `assemble 必须拷贝 ${dir}/ 目录`);
  }
  assert.ok(/commonScripts\.push\(path\.join\(dir, f\)\)/.test(assemble), `模块目录也要做全局脚本（非 CJS）校验`);
});
