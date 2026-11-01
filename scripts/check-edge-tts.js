#!/usr/bin/env node
/**
 * check-edge-tts.js —— 联网实测 Edge TTS（**不纳入 npm test**）
 *
 * 用法：
 *   node scripts/check-edge-tts.js                # 默认一句中文
 *   node scripts/check-edge-tts.js "想说点别的"    # 自定义文本
 *   PET_TTS_VOICE=zh-CN-YunxiNeural node scripts/check-edge-tts.js
 *
 * 需要先 npm run build:tsc（脚本读 dist/）。
 * 输出一段 JSON：ok / bytes / looksLikeMp3 / ms / file（mp3 落在 %TEMP%）、
 * 以及声音列表条数。失败时打印真实原因并以 1 退出——不把失败当成功。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  synthesize,
  listVoices,
  looksLikeMp3,
  chineseVoices,
  DEFAULT_VOICE,
} = require('../dist/main/voice/edgeTts');

(async () => {
  const text = process.argv[2] || '你好，我是你的桌面宠物，语音合成链路已经接通了。';
  const voice = process.env.PET_TTS_VOICE || DEFAULT_VOICE;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const report = { startedAt, text, voice };

  try {
    const mp3 = await synthesize(text, { voice, rate: 1, pitch: 0, volume: 100 });
    const file = path.join(os.tmpdir(), `pet-edge-tts-${Date.now()}.mp3`);
    fs.writeFileSync(file, mp3);
    report.ok = true;
    report.bytes = mp3.length;
    report.looksLikeMp3 = looksLikeMp3(mp3);
    report.ms = Date.now() - t0;
    report.file = file;

    // 顺带验一下声音列表接口（同一个域名，联网可用才拿得到）
    try {
      const voices = await listVoices({ timeoutMs: 20000 });
      report.voiceCount = voices.length;
      report.chineseVoiceCount = chineseVoices(voices).length;
    } catch (err) {
      report.voiceListError = err instanceof Error ? err.message : String(err);
    }
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.message : String(err);
    report.ms = Date.now() - t0;
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
})();
