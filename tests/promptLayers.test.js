'use strict';
/**
 * promptLayers 测试 —— 四层系统提示词库：
 *  1) 随包提示词库能正常加载（local-assets/prompts 为源，import 后进 assets/prompts）
 *  2) 文件缺失时回退内置文案，功能不依赖文件
 *  3) 三层固定 prompt 按顺序拼接；第 4 层阶段指令（think/act/reflect）单独可拼
 *  4) 隐私：提示词库文件不得出现密钥样式 / 本机用户路径 / 邮箱等个人信息
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'main', 'ai', 'promptLayers.js');
const SRC_DIR = path.join(ROOT, 'local-assets', 'prompts');

const lib = require(DIST);

test('随包提示词库：local-assets/prompts 能被完整加载', () => {
  const promptLib = lib.loadPromptLibrary(SRC_DIR);
  assert.equal(promptLib.source, 'bundled');
  assert.ok(promptLib.identity.length > 40, '第 1 层身份与边界不应为空');
  assert.ok(promptLib.tools.length > 20, '第 2 层工具说明不应为空');
  assert.ok(promptLib.context.length > 20, '第 3 层任务上下文说明不应为空');
  for (const phase of ['think', 'act', 'reflect']) {
    assert.ok(promptLib.phases[phase].length > 10, `缺少 ${phase} 阶段指令`);
  }
  assert.ok(promptLib.scenarioTemplate.includes('情景提示词'), '情景提示词模板缺失');
});

test('文件缺失时回退内置文案（开发版/测试环境不依赖 import）', () => {
  const missing = lib.loadPromptLibrary(path.join(ROOT, 'no-such-prompts-dir'));
  assert.equal(missing.source, 'fallback');
  assert.ok(missing.identity.length > 40);
  assert.ok(missing.tools.length > 20);
  assert.ok(missing.context.length > 20);
  for (const phase of ['think', 'act', 'reflect']) assert.ok(missing.phases[phase].length > 10);
  assert.ok(missing.scenarioTemplate.includes('情景提示词'));
  // null / undefined 也不抛异常
  assert.equal(lib.loadPromptLibrary(null).source, 'fallback');
});

test('固定三层按 1→2→3 拼接，追加内容进入对应层', () => {
  const promptLib = lib.loadPromptLibrary(SRC_DIR);
  const text = lib.assembleSystemPrompt(promptLib, {
    identityExtra: '你的名字是「小蓝」。',
    toolsCatalog: '- todo_add：添加待办',
    contextText: '用户本轮请求：整理桌面',
  });
  const i1 = text.indexOf('第 1 层');
  const i2 = text.indexOf('第 2 层');
  const i3 = text.indexOf('第 3 层');
  assert.ok(i1 >= 0 && i2 > i1 && i3 > i2, '三层顺序应为 1→2→3');
  assert.ok(text.includes('小蓝'), '第 1 层追加（名字/人设）没拼进去');
  assert.ok(text.includes('todo_add'), '第 2 层追加（工具清单）没拼进去');
  assert.ok(text.includes('整理桌面'), '第 3 层追加（任务上下文）没拼进去');
});

test('第 4 层阶段指令按阶段切换，并带轮次/观察摘要', () => {
  const promptLib = lib.loadPromptLibrary(SRC_DIR);
  const think = lib.buildPhaseInstruction(promptLib, 'think', { round: 2, roundBudget: 8 });
  const reflect = lib.buildPhaseInstruction(promptLib, 'reflect', { round: 3, roundBudget: 8, observation: 'shell_run → exit code 1' });
  assert.ok(think.includes('思考'));
  assert.ok(reflect.includes('反思'));
  assert.ok(reflect.includes('exit code 1'), '反思阶段应带上一次结果摘要');
  assert.notEqual(think, reflect);
  const round = lib.buildRoundSystemPrompt(promptLib, { contextText: '上下文' }, 'act');
  assert.ok(round.includes('第 3 层') && round.includes('行动'), '整轮 system 应包含固定三层 + 阶段指令');
});

test('隐私：自带提示词库不含密钥样式/本机用户路径/邮箱', () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.md'));
  assert.ok(files.length >= 5, '提示词库文件数量不足');
  const secret = /sk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._-]{8,}/;
  const userPath = /[A-Za-z]:\\Users\\|\/Users\/|AppData\\Roaming/;
  const email = /[\w.+-]+@[\w-]+\.[\w.]+/;
  for (const file of files) {
    const text = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    assert.ok(!secret.test(text), `${file} 含密钥样式内容`);
    assert.ok(!userPath.test(text), `${file} 含本机用户路径`);
    assert.ok(!email.test(text), `${file} 含邮箱`);
  }
});
