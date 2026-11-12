'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSceneAutoTaskPrompt,
  classifyScene,
  isQuietHours,
} = require('../dist/main/ai/sceneContext');

const base = {
  mode: 'scene_brief',
  customPrompt: '',
  petName: '小宠',
  todoText: '写测试',
  mcpText: 'MCP 服务端：已启动；外部工具：1 个',
  scenarioText: '[屏幕] 用户在写代码',
  now: new Date('2026-11-12T14:30:00').getTime(),
};

test('场景分类：代码窗口 → 生产创作，提示词包含窗口、情景记录和 MCP', () => {
  const result = buildSceneAutoTaskPrompt({
    ...base,
    screen: { app: 'Code.exe', title: 'main.ts - pet', isFullscreen: false, idleSeconds: 20 },
  });
  assert.equal(result.skip, false);
  assert.equal(result.sceneId, 'production');
  assert.match(result.prompt, /当前屏幕/);
  assert.match(result.prompt, /main\.ts - pet/);
  assert.match(result.prompt, /MCP 服务端：已启动/);
  assert.match(result.prompt, /近期情景记录/);
  assert.match(result.prompt, /用户在写代码/);
  assert.match(result.prompt, /不超过 60 字/);
});

test('场景分类：会议锁定 → 跳过，不调用 AI', () => {
  const result = buildSceneAutoTaskPrompt({
    ...base,
    screen: { app: 'Zoom.exe', title: '会议中 - 团队同步', isFullscreen: false, idleSeconds: 0 },
  });
  assert.equal(result.skip, true);
  assert.equal(result.sceneId, 'meeting');
  assert.match(result.reason, /会议/);
});

test('场景分类：全屏娱乐 → 跳过', () => {
  const result = buildSceneAutoTaskPrompt({
    ...base,
    screen: { app: 'PotPlayer.exe', title: '电影', isFullscreen: true, idleSeconds: 0 },
  });
  assert.equal(result.skip, true);
  assert.match(result.reason, /全屏/);
});

test('场景分类：空闲超过 5 分钟 → idle，提示词带空闲时长', () => {
  const result = buildSceneAutoTaskPrompt({
    ...base,
    screen: { app: '', title: '', isFullscreen: false, idleSeconds: 600 },
  });
  assert.equal(result.sceneId, 'idle');
  assert.match(result.prompt, /已离开约 10 分钟/);
});

test('自定义模式：任务提示词与 MCP 一起进入情景提示词', () => {
  const result = buildSceneAutoTaskPrompt({
    ...base,
    mode: 'custom',
    customPrompt: '提醒我整理下载目录',
    screen: { app: 'Code.exe', title: 'main.ts', isFullscreen: false, idleSeconds: 0 },
  });
  assert.equal(result.skip, false);
  assert.match(result.prompt, /提醒我整理下载目录/);
  assert.match(result.prompt, /MCP 服务端：已启动/);
});

test('场景分类：普通浏览器 → 信息浏览；深夜判定', () => {
  const scene = classifyScene({ app: 'chrome.exe', title: '搜索 - Google', isFullscreen: false, idleSeconds: 0 });
  assert.equal(scene.id, 'browsing');
  assert.equal(isQuietHours(new Date('2026-11-12T23:30:00').getTime()), true);
  assert.equal(isQuietHours(new Date('2026-11-12T14:30:00').getTime()), false);
});
