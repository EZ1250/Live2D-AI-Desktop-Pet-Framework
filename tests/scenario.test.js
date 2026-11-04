'use strict';
/**
 * scenario 测试 —— 情景提示词（用户数据目录里的自动记录文件）：
 *  1) 首次创建文件（模板头）+ 记录落盘/重新加载
 *  2) 屏幕活动去重（同一窗口不刷屏）、行动日志记录
 *  3) 注入按时间衰减加权：新记录权重高、旧记录逐层淡化，并按字符预算截断
 *  4) 隐私清洗：密钥样式脱敏、控制字符/换行折叠、超长截断
 *  5) 安全护栏：路径必须位于用户数据目录内，否则拒绝写入
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'ai', 'scenario.js');
const sc = require(DIST);

function tempUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-scenario-'));
  return dir;
}

function makeCtx(dir, nowRef, extra = {}) {
  return new sc.ScenarioContext({
    file: sc.scenarioPromptPath(dir),
    template: '# 情景提示词\n\n记录格式：- [时间][类型] 内容\n',
    mustBeUnder: dir,
    now: () => nowRef.t,
    ...extra,
  });
}

test('首次创建情景提示词文件（模板头），记录能落盘并重新加载', () => {
  const dir = tempUserData();
  const nowRef = { t: Date.now() };
  const ctx = makeCtx(dir, nowRef);
  ctx.ensureFile();
  const file = sc.scenarioPromptPath(dir);
  assert.ok(fs.existsSync(file), '情景提示词文件未创建');
  assert.ok(fs.readFileSync(file, 'utf8').includes('情景提示词'), '模板头缺失');

  ctx.load();
  ctx.record('action', 'todo_add → 已添加待办：买菜');
  ctx.flush();

  const reloaded = makeCtx(dir, nowRef);
  reloaded.load();
  const entries = reloaded.entries_();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'action');
  assert.ok(entries[0].text.includes('买菜'));
  // 文件里是可解析的记录行
  const parsed = sc.parseEntries(fs.readFileSync(file, 'utf8'));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].text, entries[0].text);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('屏幕活动去重：同一窗口 3 分钟内不重复记，切换窗口才记', () => {
  const dir = tempUserData();
  const nowRef = { t: 1_700_000_000_000 };
  const ctx = makeCtx(dir, nowRef);
  ctx.ensureFile();
  ctx.load();
  ctx.recordScreen({ app: 'Code', title: 'chatClient.ts' });
  nowRef.t += 5_000;
  ctx.recordScreen({ app: 'Code', title: 'chatClient.ts' }); // 同一窗口：跳过
  assert.equal(ctx.entries_().length, 1);
  nowRef.t += 5_000;
  ctx.recordScreen({ app: 'msedge', title: 'DeepSeek' }); // 切换：记录
  assert.equal(ctx.entries_().length, 2);
  const texts = ctx.entries_().map((e) => e.text).join('|');
  assert.ok(texts.includes('Code') && texts.includes('msedge'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('时间衰减：新记录权重高、旧记录逐层淡化，注入按预算截断', () => {
  const dir = tempUserData();
  const base = 1_700_000_000_000;
  const nowRef = { t: base };
  const ctx = makeCtx(dir, nowRef, { halfLifeMs: 120_000, maxEntries: 50 });
  ctx.ensureFile();
  ctx.load();
  // 5 分钟前、4 分钟前、……、1 分钟前各一条 + 刚刚一条
  const ctx2 = new sc.ScenarioContext({
    file: sc.scenarioPromptPath(dir),
    template: '# 情景提示词\n',
    halfLifeMs: 120_000,
    now: () => nowRef.t,
  });
  nowRef.t = base - 5 * 60_000;
  ctx2.record('screen', '五分钟前的记录');
  nowRef.t = base - 2 * 60_000;
  ctx2.record('screen', '两分钟前的记录');
  nowRef.t = base;
  ctx2.record('action', '刚刚的记录');
  const text = ctx2.injectText({ budgetChars: 2000, now: base });
  assert.ok(text.includes('情景提示词'), '注入文本缺少说明头');
  // 越新越靠前
  const iNew = text.indexOf('刚刚的记录');
  const iOld = text.indexOf('五分钟前的记录');
  assert.ok(iNew >= 0 && iOld >= 0 && iNew < iOld, '注入顺序应为新记录在前');
  // 权重逐层淡化：五分钟前 < 两分钟前
  const weightOf = (marker) => {
    const line = text.split('\n').find((l) => l.includes(marker)) || '';
    const m = /权重 ([\d.]+)/.exec(line);
    return m ? Number(m[1]) : NaN;
  };
  const wNew = weightOf('刚刚的记录');
  const w2 = weightOf('两分钟前的记录');
  const w5 = weightOf('五分钟前的记录');
  assert.ok(wNew > w2 && w2 > w5, `权重应逐层衰减：${wNew} > ${w2} > ${w5}`);
  assert.ok(wNew > 0.95, '最新记录权重应接近 1');
  // 预算截断：很小的预算只保留最新的部分
  const tight = ctx2.injectText({ budgetChars: 120, now: base });
  assert.ok(tight.length <= 200, `预算截断失效：${tight.length}`);
  assert.ok(tight.includes('刚刚的记录'), '预算截断应优先保留最新记录');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('隐私清洗：密钥脱敏、控制字符/换行折叠、超长截断', () => {
  const cleaned = sc.sanitizeScenarioText('用户输入 sk-abcdefgh12345678\n第二行\t带控制符', 100);
  assert.ok(!cleaned.includes('abcdefgh12345678'), 'sk- 密钥未被脱敏');
  assert.ok(cleaned.includes('sk-***'));
  assert.ok(!cleaned.includes('\n') && !cleaned.includes('\t'), '换行/控制字符未折叠');
  const long = sc.sanitizeScenarioText('x'.repeat(500), 40);
  assert.ok(long.length <= 41, '超长内容未截断');
  assert.ok(long.endsWith('…'));
  // Bearer / api_key 也清洗
  assert.ok(!sc.sanitizeScenarioText('Bearer abcdefghijklmnop').includes('abcdefghijklmnop'));
  const credential = sc.sanitizeScenarioText('api_key=abcdef123456');
  assert.ok(!credential.includes('abcdef123456'));
  assert.ok(!credential.includes('$1'), '脱敏结果不应包含替换占位符');
  const privateData = sc.sanitizeScenarioText('alice@example.com C:\\Users\\alice\\secret.txt');
  assert.ok(!privateData.includes('alice@example.com'));
  assert.ok(!privateData.includes('C:\\Users\\alice\\secret.txt'));
});

test('记录条数上限：只保留最新的 maxEntries 条', () => {
  const dir = tempUserData();
  const nowRef = { t: 1_700_000_000_000 };
  const ctx = makeCtx(dir, nowRef, { maxEntries: 5 });
  ctx.ensureFile();
  ctx.load();
  for (let i = 0; i < 12; i++) {
    nowRef.t += 1000;
    ctx.record('action', `动作 ${i}`);
  }
  const entries = ctx.entries_();
  assert.equal(entries.length, 5);
  assert.ok(entries[entries.length - 1].text.includes('11'), '应保留最新记录');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('安全护栏：情景文件不在用户数据目录内时拒绝写入', () => {
  const root = tempUserData();
  const outside = path.join(os.tmpdir(), 'pet-scenario-outside', 'scenario-prompt.md');
  const ctx = new sc.ScenarioContext({
    file: outside,
    template: '# 情景提示词\n',
    mustBeUnder: root,
    now: () => 1_700_000_000_000,
  });
  ctx.ensureFile();
  assert.equal(fs.existsSync(outside), false, '越界路径不应被创建');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.dirname(outside), { recursive: true, force: true });
});

test('衰减权重函数：半衰期语义正确', () => {
  const halfLife = 60_000;
  assert.equal(sc.decayWeight(1000, 1000, halfLife), 1);
  assert.ok(Math.abs(sc.decayWeight(0, halfLife, halfLife) - 0.5) < 1e-9, '一个半衰期后权重应为 0.5');
  assert.ok(Math.abs(sc.decayWeight(0, 2 * halfLife, halfLife) - 0.25) < 1e-9, '两个半衰期后权重应为 0.25');
  assert.equal(sc.decayWeight(1000, 0, halfLife), 1, '未来时间戳按 1 处理');
});

test('默认注入预算：2400 字（旧值 800 对多任务太少），显式预算仍可覆盖', () => {
  assert.equal(sc.DEFAULT_INJECT_BUDGET, 2400, '默认注入预算应为 2400 字');
  const dir = tempUserData();
  const now = 1_700_000_000_000;
  const ctx = new sc.ScenarioContext({
    file: sc.scenarioPromptPath(dir),
    template: '# 情景提示词\n\n记录格式：- [时间][类型] 内容\n',
    mustBeUnder: dir,
    now: () => now,
  });
  ctx.ensureFile();
  for (let i = 0; i < 60; i++) ctx.record('action', `第${i}条记录` + 'x'.repeat(80));
  const text = ctx.injectText({ now });
  assert.ok(text.length > 1000, `默认预算不应停留在旧值 800，实际 ${text.length}`);
  assert.ok(text.length <= 2400 + 120, `默认预算应约为 2400 字（含说明头），实际 ${text.length}`);
  const tight = ctx.injectText({ budgetChars: 300, now });
  assert.ok(tight.length <= 300 + 120, `显式预算应生效，实际 ${tight.length}`);
  ctx.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});
