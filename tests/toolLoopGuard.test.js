'use strict';
/**
 * 重复工具调用守卫（参考 deepseek-harness repeat-tool-guard）：
 *  - 连续相同「工具名 + 规范化参数」才计数；不同调用重置为 1；
 *  - 第 3 次短提醒、第 5 次详细提醒，各只触发一次，之后不再刷屏；
 *  - 参数对象 key 顺序不同视为同一次调用。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const g = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'toolLoopGuard.js'));

test('参数规范化：对象 key 顺序不影响 key，数组/嵌套值可区分', () => {
  assert.equal(g.toolCallKey('x', { a: 1, b: 2 }), g.toolCallKey('x', { b: 2, a: 1 }));
  assert.notEqual(g.toolCallKey('x', { a: 1 }), g.toolCallKey('x', { a: 2 }));
  assert.notEqual(g.toolCallKey('x', {}), g.toolCallKey('y', {}));
  assert.equal(g.toolCallKey('x', null), g.toolCallKey('x', null));
});

test('连续相同调用：第 3 次短提醒、第 5 次详细提醒，其余无提醒', () => {
  let state = g.createToolLoopGuard();
  const out = [];
  for (let i = 1; i <= 6; i++) {
    const r = g.nextToolLoopGuard(state, 'workspace_search', { query: 'foo' });
    state = r.state;
    out.push(r.reminder);
  }
  assert.equal(out[0], null);
  assert.equal(out[1], null);
  assert.match(String(out[2]), /第 3 次/);
  assert.equal(out[3], null);
  assert.match(String(out[4]), /5 次/);
  assert.equal(out[5], null, '超过阈值后不再重复提醒');
});

test('不同调用重置计数；再次回到原调用重新从 1 开始', () => {
  let state = g.createToolLoopGuard();
  let r = g.nextToolLoopGuard(state, 'a', { x: 1 });
  state = r.state;
  r = g.nextToolLoopGuard(state, 'a', { x: 1 });
  state = r.state;
  assert.equal(r.state.count, 2);
  // 换一个不同的调用 → 计数重置
  r = g.nextToolLoopGuard(state, 'b', {});
  state = r.state;
  assert.equal(state.count, 1);
  assert.equal(r.reminder, null);
  // 回到 a：从 1 开始，不会立刻提醒
  r = g.nextToolLoopGuard(state, 'a', { x: 1 });
  assert.equal(r.state.count, 1);
  assert.equal(r.reminder, null);
});

test('第 5 次提醒包含工具名与参数预览（截断）', () => {
  let state = g.createToolLoopGuard();
  let last = null;
  for (let i = 0; i < 5; i++) {
    const r = g.nextToolLoopGuard(state, 'shell_run', { command: 'x'.repeat(500) });
    state = r.state;
    last = r.reminder;
  }
  assert.ok(String(last).includes('shell_run'));
  assert.ok(String(last).includes('x'.repeat(20)));
  assert.ok(String(last).length < 500, '参数预览要截断，不能把长参数整段塞回上下文');
});
