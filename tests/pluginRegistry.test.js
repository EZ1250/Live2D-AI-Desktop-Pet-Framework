const test = require('node:test');
const assert = require('node:assert/strict');
const { PluginRegistry } = require('../dist/plugin-system/registry.js');

const manifest = (name) => ({ name, version: '1.0.0', entry: `${name}.js` });

test('插件按依赖顺序启动，并只收到自己的 start 事件', async () => {
  const registry = new PluginRegistry();
  const events = [];
  registry.register(manifest('base'), () => ({
    name: 'base',
    version: '1.0.0',
    setup(ctx) {
      ctx.on('start', () => events.push('base:start'));
      ctx.on('tick', (delta) => events.push(`base:tick:${delta}`));
    },
  }));
  registry.register(manifest('feature'), () => ({
    name: 'feature',
    version: '1.0.0',
    dependencies: ['base'],
    setup(ctx) {
      ctx.on('start', () => events.push('feature:start'));
      ctx.on('tick', (delta) => events.push(`feature:tick:${delta}`));
    },
  }));

  await registry.start();
  registry.tick(0.05);
  assert.deepEqual(events, [
    'base:start',
    'feature:start',
    'base:tick:0.05',
    'feature:tick:0.05',
  ]);
});

test('卸载插件会清理订阅，并拒绝卸载仍被依赖的插件', async () => {
  const registry = new PluginRegistry();
  let ticks = 0;
  let teardownCount = 0;
  registry.register(manifest('base'), () => ({
    name: 'base',
    version: '1.0.0',
    setup() {},
    teardown() {
      teardownCount += 1;
    },
  }));
  registry.register(manifest('feature'), () => ({
    name: 'feature',
    version: '1.0.0',
    dependencies: ['base'],
    setup(ctx) {
      ctx.on('tick', () => {
        ticks += 1;
      });
    },
  }));

  await registry.start();
  await assert.rejects(() => registry.unregister('base'), /required by: feature/);
  assert.equal(await registry.unregister('feature'), true);
  registry.tick(1);
  assert.equal(ticks, 0);
  assert.equal(await registry.unregister('base'), true);
  assert.equal(teardownCount, 1);
});
