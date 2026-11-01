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
 * 未来接线（本次刻意不接 UI）：
 *   ipcMain.handle('pet:tts:speak', (_e, text) => speak(mainWindow?.webContents, text));
 *   渲染层：ipcRenderer.on('pet:tts:audio', (_e, p) => { if (p.ok) new Audio(p.dataUrl).play(); });
 */
import { Buffer } from 'node:buffer';
import { DEFAULT_VOICE, synthesize as synthesizeEdge } from './edgeTts';
import type { EdgeTtsSynthOptions } from './edgeTts';

/** 主进程 → 渲染层：一段合成好的语音 */
export const IPC_TTS_AUDIO = 'pet:tts:audio';
/** 建议的「渲染层 → 主进程」请求频道（本次未注册 handler，留给后续接线） */
export const IPC_TTS_SPEAK = 'pet:tts:speak';
export const TTS_AUDIO_MIME = 'audio/mpeg';

/** 推给渲染层的载荷（也用于失败回报，前端据此显示原因） */
export interface TtsAudioPayload {
  ok: boolean;
  /** 调用方给的 id，用于前端把「播放」和「失败」对起来 */
  requestId: string;
  /** 原始文本（前端可用于字幕/日志） */
  text: string;
  /** 实际使用的声音短名 */
  voice: string;
  mime: typeof TTS_AUDIO_MIME;
  /** `data:audio/mpeg;base64,...`；ok=false 时为空串 */
  dataUrl: string;
  /** mp3 字节数（不是 base64 长度） */
  bytes: number;
  /** 合成耗时（ms） */
  ms: number;
  /** ok=false 时的可读原因 */
  error?: string;
}

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
