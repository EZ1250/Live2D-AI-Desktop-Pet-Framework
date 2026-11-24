const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const lib = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'promptLayers.js'));
const promptLib = lib.loadPromptLibrary(null);
test('任务顺序：1,2,3,4', () => {
  const text = lib.assembleSystemPrompt(promptLib, { identityExtra: '身份X', toolsCatalog: '工具X', contextText: '上下文X' }, 'task', '阶段X');
  const a = text.indexOf('第 1 层'), b = text.indexOf('第 2 层'), c = text.indexOf('第 3 层'), d = text.indexOf('阶段X');
  assert.ok(a >= 0 && b > a && c > b && d > c, `任务层序不对: ${a},${b},${c},${d}`);
});
test('聊天顺序：3,4,1,2', () => {
  const text = lib.assembleSystemPrompt(promptLib, { identityExtra: '身份X', toolsCatalog: '工具X', contextText: '上下文X' }, 'chat', '阶段X');
  const a = text.indexOf('第 1 层'), b = text.indexOf('第 2 层'), c = text.indexOf('第 3 层'), d = text.indexOf('阶段X');
  assert.ok(c >= 0 && d > c && a > d && b > a, `聊天层序不对: ${a},${b},${c},${d}`);
});
test('buildRoundSystemPrompt 支持聊天顺序', () => {
  const text = lib.buildRoundSystemPrompt(promptLib, { contextText: '上下文X' }, 'act', {}, 'chat');
  const c = text.indexOf('第 3 层'), d = text.indexOf('【当前阶段'), a = text.indexOf('第 1 层'), b = text.indexOf('第 2 层');
  assert.ok(c >= 0 && d > c && a > d && b > a, `round 聊天层序不对: ${a},${b},${c},${d}`);
});
