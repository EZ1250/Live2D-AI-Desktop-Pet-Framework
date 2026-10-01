/**
 * contracts.test.js — IPC 通道常量的基本约束。
 *
 * 为什么值得单独测：IPC 通道名是**字符串约定**，没有类型保护。
 * 两个常量写成同一个字符串时，后注册的 handler 会覆盖前一个，
 * 表现是"某个功能静默失效、控制台不报错"——很难查。这里把它钉死。
 *
 * 需要先 `npm run build:tsc`（npm test 已包含），因为读的是 dist 产物。
 * 来源：GitHub Copilot 在 PR #1 里提出的测试，经核对后保留。
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const contracts = require('../dist/shared/contracts.js');

test('IPC 通道常量非空且不重复', () => {
  const entries = Object.entries(contracts).filter(
    ([key, value]) => key.startsWith('IPC_') && typeof value === 'string'
  );
  assert.ok(entries.length > 0, '应当导出至少一个 IPC_ 常量');

  const values = entries.map(([, value]) => value.trim());
  for (const [key, value] of entries) {
    assert.ok(value.trim().length > 0, `${key} 的通道名不能为空`);
  }

  // 找出重复项并直接报出是哪两个常量撞了，而不是只说"集合大小不对"
  const seen = new Map();
  const dup = [];
  for (const [key, value] of entries) {
    const v = value.trim();
    if (seen.has(v)) dup.push(`${seen.get(v)} 与 ${key} 都是 "${v}"`);
    else seen.set(v, key);
  }
  assert.deepEqual(dup, [], `IPC 通道名重复：\n${dup.join('\n')}`);
});
