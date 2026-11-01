/**
 * ttsService.ts —— TTS 最小接线：合成 mp3 → 以 data URL（base64）推给渲染层播放
 *
 * 为什么走 IPC 推 base64 而不是写临时文件：
 *   - 不落盘（隐私 + 便携版 U 盘场景下临时目录未必可写）
 *   - 渲染层拿到就能塞进 `new Audio(src)` 播放，不需要额外静态路由与文件清理
 *   代价：base64 会让体积涨 1/3、且整段音频要在内存里过一遍。桌宠单句（几秒）完全可接受。
 *
 * 本文件**不 import Electron**：只要求一个 `{ send(channel, payload) }` 的目标
 * （真实接线时传 `mainWindow.webContents`），这样能离线单测，主进程也随时可接。
 *
 * 接线（已接）：
 *   ipc.ts 注册 `IPC_TTS_SPEAK` handler → speak(mainWindow.webContents, text)；
 *   渲染层收到 `IPC_TTS_AUDIO` 后 `new Audio(payload.dataUrl).play()` 播放；
 *   主进程顺带在说话期间给 VTS 注入 MouthOpen（见 ipc.ts 的 VTS 段）。
 *
 * 频道名与载荷类型统一放在 `src/shared/contracts.ts`（preload 也要用同一份，避免字符串漂移），
 * 这里再导出一次，保持 `require('../dist/main/voice/ttsService').IPC_TTS_AUDIO` 这类旧用法可用。
 */
import { Buffer } from 'node:buffer';
import { IPC_TTS_AUDIO, IPC_TTS_SPEAK, TTS_AUDIO_MIME } from '../../shared/contracts';
import type { TtsAudioPayload } from '../../shared/contracts';
import { DEFAULT_VOICE, synthesize as synthesizeEdge } from './edgeTts';
import type { EdgeTtsSynthOptions } from './edgeTts';

export { IPC_TTS_AUDIO, IPC_TTS_SPEAK, TTS_AUDIO_MIME };
export type { TtsAudioPayload };

/** 只需要一个 send：真实场景传 webContents，测试传假的 */
export interface TtsSendTarget {
  send(channel: string, payload: TtsAudioPayload): void;
}

export interface TtsSpeakOptions extends EdgeTtsSynthOptions {
  /** 不传则自动生成 */
  requestId?: string;
  /** 注入合成实现（测试用；默认走 edgeTts.synthesize） */
  synthesize?: (text: string, options: EdgeTtsSynthOptions) => Promise<Buffer>;
  /** 日志回调（默认静默，避免测试/主进程刷屏） */
  logger?: (message: string) => void;
}

export interface TtsSpeakResult {
  ok: boolean;
  requestId: string;
  voice: string;
  bytes: number;
  ms: number;
  error?: string;
}

/** mp3 → 可直接给 <audio src> 的 data URL */
export function toAudioDataUrl(mp3: Buffer): string {
  return `data:${TTS_AUDIO_MIME};base64,${mp3.toString('base64')}`;
}

let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `tts-${Date.now().toString(36)}-${requestSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 合成 + 推送。
 *
 * 永不抛异常（调用方通常是 IPC handler）：失败也推一条 ok=false 的载荷，
 * 让渲染层能把「为什么没声音」显示出来；返回值是同一份结果的摘要。
 */
export async function speak(
  target: TtsSendTarget | null | undefined,
  text: string,
  options: TtsSpeakOptions = {},
): Promise<TtsSpeakResult> {
  const startedAt = Date.now();
  const requestId = typeof options.requestId === 'string' && options.requestId.trim()
    ? options.requestId.trim()
    : nextRequestId();
  const voice = typeof options.voice === 'string' && options.voice.trim() ? options.voice.trim() : DEFAULT_VOICE;
  const synth = typeof options.synthesize === 'function' ? options.synthesize : synthesizeEdge;
  const originalText = typeof text === 'string' ? text : String(text ?? '');

  let payload: TtsAudioPayload;
  try {
    const mp3 = await synth(originalText, options);
    const bytes = mp3 ? mp3.length : 0;
    if (!bytes) {
      payload = {
        ok: false, requestId, text: originalText, voice, mime: TTS_AUDIO_MIME, dataUrl: '',
        bytes: 0, ms: Date.now() - startedAt, error: 'Edge TTS 没有返回音频数据',
      };
    } else {
      payload = {
        ok: true, requestId, text: originalText, voice, mime: TTS_AUDIO_MIME,
        dataUrl: toAudioDataUrl(mp3), bytes, ms: Date.now() - startedAt,
      };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger?.(`[tts] 合成失败：${message}`);
    payload = {
      ok: false, requestId, text: originalText, voice, mime: TTS_AUDIO_MIME, dataUrl: '',
      bytes: 0, ms: Date.now() - startedAt, error: message,
    };
  }

  if (target) {
    try {
      target.send(IPC_TTS_AUDIO, payload);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.logger?.(`[tts] 推送渲染层失败：${message}`);
      payload = { ...payload, ok: false, error: `推送渲染层失败：${message}` };
    }
  }

  return {
    ok: payload.ok,
    requestId,
    voice: payload.voice,
    bytes: payload.bytes,
    ms: payload.ms,
    ...(payload.error ? { error: payload.error } : {}),
  };
}
