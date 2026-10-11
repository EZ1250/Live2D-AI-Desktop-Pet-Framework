/**
 * voiceModelRanking.test.js — 转写模型选型与"失败到底为什么"的文案。
 *
 * 背景（真机实测 2026-10-11，用户自己的百炼工作区域名）：
 *   - 网关没有 /audio/transcriptions（404），只有 chat/completions + input_audio 能走；
 *   - **唯一能用的模型是 `qwen3-asr-flash`**（0.5s 出文本，真实 ogg/opus 也过）；
 *   - 它**不在** /models 列表里；而列表里排第一的 `fun-asr-flash-2026-06-15` 两条路由都报错；
 *   - `*-realtime` / `fun-asr-*` / `paraformer-*` 是实时/原生接口专用；`*-omni-*`、
 *     `qwen-audio-*` 能收音频但会"回答"而不是听写。
 *
 * 于是"按地址索引"曾经把用户引到一个走不通的模型上，并且列表里没有 qwen3-asr-flash 时
 * 还反过来判它"名字写错"。这里把这些结论钉死：排序规则、结论文案、失败提示。
 *
 * `indexVoiceModels` / `checkVoiceRoutes` 用**假 fetch** 驱动，不联网、不碰真密钥。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const voice = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'voice.js'));

/** 造一个只回固定响应的 fetch（按 URL 区分 /models 与两条转写路由） */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), method: (init && init.method) || 'GET' });
    return handler(String(url), init, calls);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

test('路由兼容性分级：实测可用的 / 实时原生专用 / 会聊天但不听写', () => {
  assert.equal(voice.asrRouteCompat('qwen3-asr-flash'), 'verified');
  assert.equal(voice.asrRouteCompat('qwen3-asr-flash-2026-02-10'), 'verified');
  for (const n of ['fun-asr-flash-2026-06-15', 'qwen3-asr-flash-realtime', 'paraformer-realtime-v2', 'sensevoice-v1', 'qwen3-tts-flash-realtime']) {
    assert.equal(voice.asrRouteCompat(n), 'incompatible', `${n} 应当是"本应用驱动不了"`);
  }
  for (const n of ['qwen3.8-omni-flash', 'qwen-audio-3.0-asr-flash', 'qwen3-omni-flash']) {
    assert.equal(voice.asrRouteCompat(n), 'chatty', `${n} 应当被标成"能听但会聊天"`);
  }
});

test('候选排序：qwen3-asr-flash 必须排第一，实时/原生专用的被压到最后', () => {
  // 这就是用户网关 /models 的真实形态（qwen3-asr-flash 不在列表里时由调用方补进来）
  const models = [
    'fun-asr-flash-2026-06-15',
    'qwen3-asr-flash-realtime',
    'qwen-audio-3.0-asr-flash',
    'qwen3.8-omni-flash-realtime',
    'qwen3.8-omni-flash',
    'qwen3.5-omni-flash',
    'qwen3-asr-flash',
    'text-embedding-v4',
  ];
  const ranked = voice.rankAsrCandidates(models);
  assert.equal(ranked[0], 'qwen3-asr-flash', `榜首必须是实测可用的模型，实际=${ranked[0]}`);
  assert.equal(ranked.includes('text-embedding-v4'), false, '与转写无关的模型不该进候选');
  // 实时/原生专用的一律排在"会聊天"的多模态之后
  const iIncompatible = ranked.indexOf('fun-asr-flash-2026-06-15');
  const iChatty = ranked.indexOf('qwen3.8-omni-flash');
  assert.ok(iIncompatible > iChatty, `fun-asr 应在多模态之后（fun=${iIncompatible}, omni=${iChatty}）`);
  for (const n of ['fun-asr-flash-2026-06-15', 'qwen3-asr-flash-realtime', 'qwen3.8-omni-flash-realtime']) {
    assert.ok(ranked.indexOf(n) > ranked.indexOf('qwen-audio-3.0-asr-flash'), `${n} 应排在多模态之后`);
  }
  // 自动挑模型也要落在可用那条线上
  assert.equal(voice.pickAutoVoiceModel(models, ranked), 'qwen3-asr-flash');
});

test('列表里排第一的走不通时，结论必须说清"驱动不了"，而不是"列表里有=可用"', async () => {
  const stub = stubFetch(async () => jsonRes(200, {
    data: [
      { id: 'fun-asr-flash-2026-06-15' },
      { id: 'qwen3-asr-flash-realtime' },
      { id: 'qwen3.8-omni-flash' },
    ],
  }));
  try {
    const idx = await voice.indexVoiceModels({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'fun-asr-flash-2026-06-15' });
    assert.equal(idx.currentSupported, true);
    assert.equal(idx.verdict, 'warn', '列表里有但它驱动不了 → 不能给 ok');
    assert.match(idx.reason, /实时|原生/);
    assert.match(idx.action || '', /qwen3-asr-flash/);
  } finally {
    stub.restore();
  }
});

test('实测可用的模型不在列表里时，不许判"名字写错"', async () => {
  const stub = stubFetch(async () => jsonRes(200, {
    data: [{ id: 'fun-asr-flash-2026-06-15' }, { id: 'qwen3-asr-flash-realtime' }],
  }));
  try {
    const idx = await voice.indexVoiceModels({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'qwen3-asr-flash' });
    assert.equal(idx.currentSupported, false);
    assert.equal(idx.verdict, 'warn', '列表不含 ≠ 不可用，不能判 error');
    assert.match(idx.reason, /列表/);
    assert.match(idx.action || '', /自检/);
  } finally {
    stub.restore();
  }
});

test('两条路由都失败时，提示要指向"换模型"而不是笼统的"换网关"', async () => {
  const stub = stubFetch(async (url) => {
    if (url.includes('/audio/transcriptions')) return jsonRes(404, '');
    return jsonRes(400, '{}');
  });
  try {
    // ① 模型是实时/原生专用 → 明确让人换 qwen3-asr-flash
    const r1 = await voice.checkVoiceRoutes({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'fun-asr-flash-2026-06-15' });
    assert.equal(r1.ok, false);
    assert.match(r1.hint || '', /qwen3-asr-flash/);
    assert.equal(r1.reports.length, 2);

    // ② 模型本身没问题但仍不通 → 也先建议试默认模型
    const r2 = await voice.checkVoiceRoutes({ baseUrl: 'https://example.test/v1', apiKey: 'k', model: 'whisper-1' });
    assert.match(r2.hint || '', /qwen3-asr-flash/);
  } finally {
    stub.restore();
  }
});
