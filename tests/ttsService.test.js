/**
 * ttsService.ts 的离线测试：验证「合成 → base64 推送渲染层」这条接线本身
 * （IPC 频道、载荷形状、失败回报），合成器用注入的假实现，不联网。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  speak,
  toAudioDataUrl,
  IPC_TTS_AUDIO,
  IPC_TTS_SPEAK,
  TTS_AUDIO_MIME,
} = require('../dist/main/voice/ttsService');

const FAKE_MP3 = Buffer.from([0xff, 0xf3, 0x64, 0x00, 0x11, 0x22, 0x33, 0x44]);

/** 假的 webContents：只实现 send */
function createTarget() {
  const pushed = [];
  return {
    pushed,
    send(channel, payload) { pushed.push({ channel, payload }); },
  };
}

test('speak：合成成功后把 mp3 以 data URL 推到固定频道', async () => {
  const target = createTarget();
  const result = await speak(target, '你好世界', {
    requestId: 'req-1',
    synthesize: async (text) => {
      assert.equal(text, '你好世界');
      return FAKE_MP3;
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-1');
  assert.equal(result.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(result.bytes, FAKE_MP3.length);
  assert.equal(typeof result.ms, 'number');
  assert.ok(result.ms >= 0);

  assert.equal(target.pushed.length, 1);
  const { channel, payload } = target.pushed[0];
  assert.equal(channel, IPC_TTS_AUDIO);
  assert.equal(channel, 'pet:tts:audio');
  assert.equal(payload.ok, true);
  assert.equal(payload.requestId, 'req-1');
  assert.equal(payload.mime, TTS_AUDIO_MIME);
  assert.equal(payload.mime, 'audio/mpeg');
  assert.equal(payload.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(payload.text, '你好世界');
  assert.equal(payload.bytes, FAKE_MP3.length);
  assert.ok(payload.dataUrl.startsWith('data:audio/mpeg;base64,'), payload.dataUrl.slice(0, 40));
  const base64 = payload.dataUrl.slice('data:audio/mpeg;base64,'.length);
  assert.deepEqual(Buffer.from(base64, 'base64'), FAKE_MP3, 'base64 解回来必须和原 mp3 一致');
  assert.equal(payload.error, undefined);
});

test('speak：声音/参数透传给合成器，requestId 自动生成', async () => {
  const target = createTarget();
  let seenOptions = null;
  const result = await speak(target, '测试', {
    voice: 'zh-CN-YunxiNeural',
    rate: 1.2,
    pitch: 10,
    volume: 80,
    synthesize: async (_text, options) => {
      seenOptions = options;
      return FAKE_MP3;
    },
  });
  assert.equal(result.voice, 'zh-CN-YunxiNeural');
  assert.equal(result.requestId.startsWith('tts-'), true);
  assert.equal(seenOptions.voice, 'zh-CN-YunxiNeural');
  assert.equal(seenOptions.rate, 1.2);
  assert.equal(target.pushed[0].payload.voice, 'zh-CN-YunxiNeural');
});

test('speak：合成失败也推一条 ok=false（渲染层能说明原因），并且不抛异常', async () => {
  const target = createTarget();
  const logs = [];
  const result = await speak(target, '你好', {
    logger: (message) => logs.push(message),
    synthesize: async () => { throw new Error('Edge TTS 合成失败：网络不可达'); },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /网络不可达/);
  assert.equal(target.pushed.length, 1);
  const { payload } = target.pushed[0];
  assert.equal(payload.ok, false);
  assert.equal(payload.dataUrl, '');
  assert.equal(payload.bytes, 0);
  assert.match(payload.error, /网络不可达/);
  assert.equal(logs.length, 1);
});

test('speak：真实合成器对空文本直接拒绝（不联网），失败会回报', async () => {
  const target = createTarget();
  const result = await speak(target, '   ');
  assert.equal(result.ok, false);
  assert.match(result.error, /文本为空/);
  assert.equal(target.pushed[0].payload.ok, false);
});

test('speak：目标窗口已销毁（send 抛错）时返回失败而不是崩溃', async () => {
  const target = { send() { throw new Error('Object has been destroyed'); } };
  const result = await speak(target, '你好', { synthesize: async () => FAKE_MP3 });
  assert.equal(result.ok, false);
  assert.match(result.error, /推送渲染层失败/);
  assert.match(result.error, /destroyed/);
});

test('speak：没有目标窗口时只合成不推送', async () => {
  const result = await speak(null, '你好', { synthesize: async () => FAKE_MP3 });
  assert.equal(result.ok, true);
  assert.equal(result.bytes, FAKE_MP3.length);
});

test('speak：音色不被 Edge 支持时自动回退默认音色，并带 fallbackFrom 提示', async () => {
  const target = createTarget();
  const voices = [];
  const result = await speak(target, '你好', {
    voice: 'zh-CN-XiaomoNeural',
    synthesize: async (_text, options) => {
      voices.push(options.voice);
      if (options.voice === 'zh-CN-XiaomoNeural') {
        throw new Error('Edge TTS 合成失败：Stream closed before the synthesis completed (no turn.end received). The audio is likely truncated.');
      }
      return FAKE_MP3;
    },
  });
  assert.deepEqual(voices, ['zh-CN-XiaomoNeural', 'zh-CN-XiaoxiaoNeural'], '应先用原音色，再回退默认音色');
  assert.equal(result.ok, true);
  assert.equal(result.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(result.fallbackFrom, 'zh-CN-XiaomoNeural');
  assert.equal(target.pushed[0].payload.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(target.pushed[0].payload.fallbackFrom, 'zh-CN-XiaomoNeural');
});

test('speak：默认音色本身失败时不再回退，按失败返回', async () => {
  const target = createTarget();
  let calls = 0;
  const result = await speak(target, '你好', {
    synthesize: async () => {
      calls += 1;
      throw new Error('Edge TTS 合成失败：Stream closed before the synthesis completed (no turn.end received).');
    },
  });
  assert.equal(calls, 1, '默认音色失败不应再重试');
  assert.equal(result.ok, false);
  assert.match(result.error, /Stream closed/);
});

test('speak：非音色类错误不触发回退（网络错误直接失败）', async () => {
  const target = createTarget();
  let calls = 0;
  const result = await speak(target, '你好', {
    voice: 'zh-CN-YunxiNeural',
    synthesize: async () => {
      calls += 1;
      throw new Error('网络不可达');
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, false);
  assert.equal(result.fallbackFrom, undefined);
});

test('toAudioDataUrl 与建议频道常量', () => {
  assert.equal(toAudioDataUrl(Buffer.from('ab')), 'data:audio/mpeg;base64,YWI=');
  assert.equal(IPC_TTS_SPEAK, 'pet:tts:speak');
  assert.equal(IPC_TTS_AUDIO, 'pet:tts:audio');
});
