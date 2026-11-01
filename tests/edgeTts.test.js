/**
 * edgeTts.ts 的离线测试：只覆盖参数校验、SSML 归一化、声音列表解析这些**不联网**的部分。
 * 真实联网合成不放在 npm test 里（见 scripts/check-edge-tts.js）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const edge = require('../dist/main/voice/edgeTts');

/** 模拟微软 Edge 声音接口的原始字段（Name/ShortName/... 大驼峰） */
const EDGE_VOICES_FIXTURE = [
  {
    Name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
    ShortName: 'zh-CN-XiaoxiaoNeural',
    Gender: 'Female',
    Locale: 'zh-CN',
    SuggestedCodec: 'audio-24khz-48kbitrate-mono-mp3',
    FriendlyName: 'Xiaoxiao',
    Status: 'GA',
    VoiceTag: { ContentCategories: ['General'], VoicePersonalities: ['Warm'] },
  },
  {
    Name: 'Microsoft Yunxi Online (Natural) - Chinese (Mainland)',
    ShortName: 'zh-CN-YunxiNeural',
    Gender: 'Male',
    Locale: 'zh-CN',
    FriendlyName: 'Yunxi',
    Status: 'GA',
  },
  {
    Name: 'Microsoft Xiaoyi Online (Natural) - Chinese (Taiwan)',
    ShortName: 'zh-TW-HsiaoChenNeural',
    Gender: 'Female',
    Locale: 'zh-TW',
    Status: 'GA',
  },
  {
    Name: 'Microsoft Aria Online (Natural) - English (United States)',
    ShortName: 'en-US-AriaNeural',
    Gender: 'Female',
    Locale: 'en-US',
    Status: 'GA',
  },
];

test('validateText：空文本 / 非字符串 / 超长都要拒掉，控制字符要清掉', () => {
  assert.throws(() => edge.validateText(''), /文本为空/);
  assert.throws(() => edge.validateText('   \n\t '), /文本为空/);
  assert.throws(() => edge.validateText(123), /字符串/);
  assert.throws(() => edge.validateText('a'.repeat(edge.MAX_TEXT_CHARS + 1)), /过长/);
  assert.equal(edge.validateText('  你好  '), '你好');
  assert.equal(edge.validateText('a\u0000b\u0007c'), 'abc');
  assert.equal(edge.validateText('第一行\r\n第二行'), '第一行\n第二行');
});

test('escapeXml：msedge-tts 不转义输入，这里必须自己转', () => {
  assert.equal(edge.escapeXml('a & b'), 'a &amp; b');
  assert.equal(edge.escapeXml('<voice>'), '&lt;voice&gt;');
  assert.equal(edge.escapeXml('正常文本，不加料'), '正常文本，不加料');
});

test('normalizeProsody：默认值 / 倍速 / Hz / 音量百分比', () => {
  assert.deepEqual(edge.normalizeProsody({}), { rate: '+0%', pitch: '+0Hz', volume: '100' });

  // rate 数字 = 倍速
  assert.equal(edge.formatProsodyValue(1.2, 'rate'), '+20%');
  assert.equal(edge.formatProsodyValue(0.8, 'rate'), '-20%');
  assert.equal(edge.formatProsodyValue(1, 'rate'), '+0%');
  assert.throws(() => edge.formatProsodyValue(0, 'rate'), /大于 0/);
  assert.throws(() => edge.formatProsodyValue(-1, 'rate'), /大于 0/);

  // pitch 数字 = Hz 偏移
  assert.equal(edge.formatProsodyValue(20, 'pitch'), '+20Hz');
  assert.equal(edge.formatProsodyValue(-5, 'pitch'), '-5Hz');
  assert.equal(edge.formatProsodyValue(0, 'pitch'), '+0Hz');

  // volume 数字 = 绝对百分比 0..100
  assert.equal(edge.formatProsodyValue(100, 'volume'), '100');
  assert.equal(edge.formatProsodyValue(50, 'volume'), '50');
  assert.throws(() => edge.formatProsodyValue(150, 'volume'), /0\.\.100/);

  // 字符串：SSML 关键字（大小写归一）与带单位数值
  assert.equal(edge.formatProsodyValue('FAST', 'rate'), 'fast');
  assert.equal(edge.formatProsodyValue('+10%', 'rate'), '+10%');
  assert.equal(edge.formatProsodyValue('+2st', 'pitch'), '+2st');
  assert.equal(edge.formatProsodyValue('loud', 'volume'), 'loud');
});

test('normalizeProsody：字符串里的注入尝试必须被拒（这些值会拼进 SSML 属性）', () => {
  const bad = [
    '1; drop',
    '"+0%"',
    '<script>',
    '//',
    '%',
    '1%2',
  ];
  for (const value of bad) {
    assert.throws(() => edge.formatProsodyValue(value, 'rate'), TypeError, `应当拒绝：${value}`);
  }
  assert.throws(() => edge.formatProsodyValue(Number.POSITIVE_INFINITY, 'rate'), /有限数字/);
  assert.throws(() => edge.formatProsodyValue({}, 'rate'), /数字或字符串/);
});

test('normalizeVoiceName：默认/空白回落默认声音，非法字符拒绝', () => {
  assert.equal(edge.normalizeVoiceName(), edge.DEFAULT_VOICE);
  assert.equal(edge.normalizeVoiceName('   '), edge.DEFAULT_VOICE);
  assert.equal(edge.normalizeVoiceName(' zh-CN-YunxiNeural '), 'zh-CN-YunxiNeural');
  assert.throws(() => edge.normalizeVoiceName('zh-CN-XiaoxiaoNeural" rate="+50%'), /不合法/);
  assert.throws(() => edge.normalizeVoiceName(42), /字符串/);
});

test('normalizeVoices / parseVoicesJson：解析 Edge 声音列表（大驼峰、去重、坏条目跳过）', () => {
  const voices = edge.normalizeVoices(EDGE_VOICES_FIXTURE);
  assert.equal(voices.length, 4);
  assert.deepEqual(voices[0], {
    shortName: 'zh-CN-XiaoxiaoNeural',
    name: 'Microsoft Xiaoxiao Online (Natural) - Chinese (Mainland)',
    locale: 'zh-CN',
    gender: 'Female',
    friendlyName: 'Xiaoxiao',
  });
  assert.equal(voices[1].shortName, 'zh-CN-YunxiNeural');

  // 重复条目只留第一条；缺 ShortName 的跳过；非对象跳过；非数组给空数组
  const messy = edge.normalizeVoices([
    ...EDGE_VOICES_FIXTURE.slice(0, 2),
    { ShortName: 'zh-CN-XiaoxiaoNeural', Locale: 'zh-CN' },
    { Name: 'no short name' },
    null,
    'string',
  ]);
  assert.equal(messy.length, 2);
  assert.deepEqual(edge.normalizeVoices(null), []);
  assert.deepEqual(edge.normalizeVoices({ voices: EDGE_VOICES_FIXTURE }), voices);

  // 原始 JSON 文本（Edge 接口返回的就是数组）
  const parsed = edge.parseVoicesJson(JSON.stringify(EDGE_VOICES_FIXTURE));
  assert.equal(parsed.length, 4);
  assert.equal(parsed[2].shortName, 'zh-TW-HsiaoChenNeural');
  assert.throws(() => edge.parseVoicesJson(''), /为空/);
  assert.throws(() => edge.parseVoicesJson('{oops'), /不是合法 JSON/);
  assert.deepEqual(edge.parseVoicesJson('{"voices": "nope"}'), []); // 结构不对 → 空列表，不抛错
});

test('chineseVoices / pickVoice：按短名、locale、模糊匹配挑声音', () => {
  const voices = edge.normalizeVoices(EDGE_VOICES_FIXTURE);
  assert.deepEqual(edge.chineseVoices(voices).map((v) => v.shortName), [
    'zh-CN-XiaoxiaoNeural',
    'zh-CN-YunxiNeural',
    'zh-TW-HsiaoChenNeural',
  ]);

  assert.equal(edge.pickVoice(voices, 'zh-cn-xiaoxiaoneural').shortName, 'zh-CN-XiaoxiaoNeural');
  assert.equal(edge.pickVoice(voices, 'zh-CN').shortName, 'zh-CN-XiaoxiaoNeural');
  assert.equal(edge.pickVoice(voices, 'yunxi').shortName, 'zh-CN-YunxiNeural');
  assert.equal(edge.pickVoice(voices, 'Aria').shortName, 'en-US-AriaNeural');
  assert.equal(edge.pickVoice(voices, '不存在的嗓音'), undefined);
  assert.equal(edge.pickVoice(voices, '  '), undefined);
});

test('looksLikeMp3：ID3 / 帧同步 / 太短', () => {
  assert.equal(edge.looksLikeMp3(Buffer.from([0x49, 0x44, 0x33, 0x04])), true); // 'ID3'
  assert.equal(edge.looksLikeMp3(Buffer.from([0xff, 0xf3, 0x64, 0x00])), true);
  assert.equal(edge.looksLikeMp3(Buffer.from('RIFF')), false);
  assert.equal(edge.looksLikeMp3(Buffer.alloc(2)), false);
});

test('synthesize 的参数校验在网络请求之前生效（空文本/非法 rate 不会去联网）', async () => {
  await assert.rejects(() => edge.synthesize(''), /文本为空/);
  await assert.rejects(() => edge.synthesize('你好', { rate: 'bad; value' }), TypeError);
  await assert.rejects(() => edge.synthesize('你好', { voice: 'x" y' }), /不合法/);
});
