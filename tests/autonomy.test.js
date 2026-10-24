'use strict';
/**
 * 定时自主任务规则测试（不联网、不调 AI）：
 *  1) 设置归一化与值域夹取（间隔最小 5 分钟、每日上限）
 *  2) 触发条件：关闭/忙碌/有确认框/并发/间隔不足/每日上限/自定义模式没提示词
 *  3) 跨天清零与手动触发（跳过间隔与上限，但不打断对话）
 *  4) 提示词与本地 MCP 检查摘要
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const a = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'autonomy.js'));

function state(now, count = 0, lastRunAt = 0) {
  return { dayKey: a.dayKeyOf(now), countToday: count, lastRunAt };
}
const cfg = (over = {}) => a.normalizeAutoTaskSettings({ enabled: true, mode: 'mcp_check', prompt: '', intervalMin: 30, dailyLimit: 20, ...over });

test('设置归一化：非法/越界值夹取到安全范围', () => {
  const n = a.normalizeAutoTaskSettings({ enabled: 1, mode: 'nope', prompt: '  x  ', intervalMin: 0, dailyLimit: 9999 });
  assert.equal(n.enabled, false, '非 true 一律视为关闭');
  assert.equal(n.mode, 'mcp_check');
  assert.equal(n.prompt, 'x');
  assert.equal(n.intervalMin, a.AUTO_TASK_MIN_INTERVAL_MIN);
  assert.equal(n.dailyLimit, 200);
  const n2 = a.normalizeAutoTaskSettings({ enabled: true, mode: 'custom', intervalMin: 999, dailyLimit: 0 });
  assert.equal(n2.intervalMin, a.AUTO_TASK_MAX_INTERVAL_MIN);
  assert.equal(n2.dailyLimit, 1);
});

test('触发条件：关闭/忙碌/确认框/并发都跳过', () => {
  const now = Date.now();
  const base = { busy: false, pendingAsk: false, running: false, manual: false };
  assert.equal(a.shouldRunAutoTask(now, cfg(), state(now), base).run, true);
  assert.equal(a.shouldRunAutoTask(now, cfg({ enabled: false }), state(now), base).run, false);
  assert.equal(a.shouldRunAutoTask(now, cfg(), state(now), { ...base, busy: true }).run, false);
  assert.equal(a.shouldRunAutoTask(now, cfg(), state(now), { ...base, pendingAsk: true }).run, false);
  assert.equal(a.shouldRunAutoTask(now, cfg(), state(now), { ...base, running: true }).run, false);
});

test('间隔不足 / 每日上限 / 跨天清零 / 自定义模式缺提示词', () => {
  const now = Date.now();
  const base = { busy: false, pendingAsk: false, running: false, manual: false };
  const recent = state(now, 1, now - 5 * 60_000);
  assert.equal(a.shouldRunAutoTask(now, cfg(), recent, base).run, false, '5 分钟前跑过、间隔 30 分钟 → 跳过');
  const due = state(now, 1, now - 31 * 60_000);
  assert.equal(a.shouldRunAutoTask(now, cfg(), due, base).run, true);
  const capped = state(now, 20, now - 60 * 60_000);
  assert.equal(a.shouldRunAutoTask(now, cfg(), capped, base).run, false, '达到每日上限');
  // 跨天：昨天用满 → 今天清零可跑
  const yesterday = { dayKey: '2000-01-01', countToday: 20, lastRunAt: 0 };
  const d = a.shouldRunAutoTask(now, cfg(), yesterday, base);
  assert.equal(d.run, true);
  assert.equal(d.state.countToday, 0);
  // 自定义模式没写提示词
  assert.equal(a.shouldRunAutoTask(now, cfg({ mode: 'custom', prompt: '' }), state(now), base).run, false);
  // 手动触发跳过间隔/上限
  const manual = a.shouldRunAutoTask(now, cfg({ enabled: false }), capped, { ...base, manual: true });
  assert.equal(manual.run, true, '手动立即运行不受开关/上限限制');
});

test('事件触发：开关/匹配串/冷却/每日上限，与定时互不影响', () => {
  const now = Date.now();
  const eventCfg = cfg({ eventEnabled: true, eventMatch: 'Edge', eventCooldownMin: 15 });
  const base = { busy: false, pendingAsk: false, running: false };
  const st = (count = 0, lastEventAt = 0) => ({ ...state(now, count), lastEventAt });
  assert.equal(a.shouldRunAutoTask(now, eventCfg, st(), { ...base, trigger: 'event', eventMatched: true }).run, true);
  // 未开启事件触发
  assert.equal(a.shouldRunAutoTask(now, cfg({ eventEnabled: false, eventMatch: 'Edge' }), st(), { ...base, trigger: 'event', eventMatched: true }).run, false);
  // 没有匹配串且调用方没声明命中 → 跳过
  assert.equal(a.shouldRunAutoTask(now, cfg({ eventEnabled: true, eventMatch: '' }), st(), { ...base, trigger: 'event' }).run, false);
  // 冷却中
  assert.equal(a.shouldRunAutoTask(now, eventCfg, st(1, now - 60_000), { ...base, trigger: 'event', eventMatched: true }).run, false);
  // 冷却已过
  assert.equal(a.shouldRunAutoTask(now, eventCfg, st(1, now - 16 * 60_000), { ...base, trigger: 'event', eventMatched: true }).run, true);
  // 每日上限共用
  assert.equal(a.shouldRunAutoTask(now, eventCfg, st(20, 0), { ...base, trigger: 'event', eventMatched: true }).run, false);
  // 忙碌/并发同样避让
  assert.equal(a.shouldRunAutoTask(now, eventCfg, st(), { ...base, busy: true, trigger: 'event', eventMatched: true }).run, false);
  // 事件字段不影响定时判断
  assert.equal(a.shouldRunAutoTask(now, eventCfg, st(20, 0), { ...base, trigger: 'schedule' }).run, false);
  // 匹配函数：应用或标题包含即可，忽略大小写
  assert.equal(a.matchesAutoTaskEvent(eventCfg, 'msedge', '文档 - Microsoft Edge'), true);
  assert.equal(a.matchesAutoTaskEvent(eventCfg, 'Code', '项目 - Visual Studio Code'), false);
  assert.equal(a.matchesAutoTaskEvent(cfg({ eventEnabled: true, eventMatch: '' }), 'Edge', 'x'), false);
});

test('提示词：后台任务口吻 + 一句中文 + 上下文', () => {
  const now = new Date('2026-10-24T10:00:00').getTime();
  const prompt = a.buildAutoTaskPrompt(now, {
    mode: 'scene_brief',
    prompt: '',
    petName: '白子',
    model: 'm',
    activeWindow: 'Edge — 文档',
    todoText: '喝水',
    mcpText: 'MCP 服务（1 个）',
  });
  assert.ok(prompt.includes('后台自主任务'));
  assert.ok(prompt.includes('不超过 40 字'));
  assert.ok(prompt.includes('Edge — 文档'));
  assert.ok(prompt.includes('白子'));
  const custom = a.buildAutoTaskPrompt(now, { mode: 'custom', prompt: '提醒喝水', petName: '', model: '', activeWindow: '', todoText: '', mcpText: '' });
  assert.ok(custom.includes('提醒喝水'));
});

test('MCP 检查摘要：无异常不打扰，有异常返回 ok=false', () => {
  const ok = a.buildMcpCheckSummary('MCP 服务（1 个）：\n- echo（stdio）：已连接，工具 2 个，需确认', 'MCP 服务端：未启用');
  assert.equal(ok.ok, true);
  const bad = a.buildMcpCheckSummary('MCP 服务（1 个）：\n- echo（stdio）：连接失败\n  错误：spawn 失败', 'MCP 服务端：未启用');
  assert.equal(bad.ok, false);
  const portBad = a.buildMcpCheckSummary('MCP 服务（0 个）：', 'MCP 服务端：端口都被占用，启动失败');
  assert.equal(portBad.ok, false);
});
