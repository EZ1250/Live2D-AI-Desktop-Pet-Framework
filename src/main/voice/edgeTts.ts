/**
 * edgeTts.ts —— Edge 在线 TTS（微软 Edge 的「大声朗读」接口，无需 API Key）
 *
 * 用 npm 包 `msedge-tts`（它自己处理 Sec-MS-GEC 令牌、SSML、WebSocket 分帧），本模块只做：
 *   - 参数校验与归一化（voice / rate / pitch / volume → SSML prosody 字符串）
 *   - 文本转义（msedge-tts 的 SSML 模板**不**转义输入，直接拼进去，传 `&` `<` 会炸）
 *   - 一次性把音频流收成 Buffer，带整体超时 + 失败清理
 *   - 声音列表解析/挑选（离线可测）
 *
 * 约束：纯 Node 模块，不 import Electron；不读写磁盘；不含任何密钥
 * （msedge-tts 用的是微软公开的 Edge 客户端令牌，不是用户 API Key）。
 *
 * 参数语义（与本模块的公开 API 对齐）：
 *   voice   声音短名，默认 zh-CN-XiaoxiaoNeural
 *   rate    数字=倍速（1.0 原速，1.2=+20%，0.8=-20%）；字符串=原样（'+10%' / 'fast' 等）
 *   pitch   数字=Hz 偏移（0 原调，+20=+20Hz）；字符串=原样（'+20Hz' / '+5%'）
 *   volume  数字=绝对音量百分比（100 原音量，0..100）；字符串=原样（'+10%' / 'loud'）
 */
import { Buffer } from 'node:buffer';
import type { Readable } from 'node:stream';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

export const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
export const DEFAULT_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 单次合成的文本上限（再长请调用方自己分段；不分段是刻意的，避免把一句话拆成几段听感变差） */
export const MAX_TEXT_CHARS = 2000;

export interface EdgeTtsSynthOptions {
  voice?: string;
  rate?: number | string;
  pitch?: number | string;
  volume?: number | string;
  /** 整体超时（连接 + 合成），默认 30000 */
  timeoutMs?: number;
}

export interface EdgeVoiceInfo {
  /** 声音短名，如 zh-CN-XiaoxiaoNeural（合成时用这个） */
  shortName: string;
  /** 展示名，如 Microsoft 晓晓 Online (Natural) - Chinese (Mainland) */
  name: string;
  /** 语言区域，如 zh-CN */
  locale: string;
  gender: string;
  friendlyName?: string;
}

export interface ProsodyValues {
  rate: string;
  pitch: string;
  volume: string;
}

/** prosody 允许的关键字（SSML 规范）；字符串参数只允许这些或「带单位的数字」 */
const PROSODY_KEYWORDS = new Set([
  'x-slow', 'slow', 'medium', 'fast', 'x-fast', 'default',
  'x-low', 'low', 'high', 'x-high',
  'silent', 'x-soft', 'soft', 'loud', 'x-loud',
]);

/** 允许的字符串形式：+10% / -5Hz / +2st / 100（数字，音量用）——刻意收紧，避免拼进 SSML 搞注入 */
const PROSODY_VALUE_RE = /^[+-]?\d+(?:\.\d+)?(?:%|Hz|st)?$/;

function describeValue(value: unknown): string {
  return typeof value === 'string' ? `"${value}"` : String(value);
}

/**
 * 把单个 prosody 参数归一化成 SSML 属性值。
 * 数字语义见文件头注释；字符串必须是关键字或「数字+单位」，否则抛 TypeError。
 */
export function formatProsodyValue(
  value: number | string | undefined,
  kind: 'rate' | 'pitch' | 'volume',
): string {
  if (value === undefined || value === null) {
    if (kind === 'rate') return '+0%';
    if (kind === 'pitch') return '+0Hz';
    return '100';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${kind} 必须是有限数字（收到 ${String(value)}）`);
    if (kind === 'rate') {
      if (value <= 0) throw new RangeError(`rate 倍速必须大于 0（收到 ${value}）`);
      const percent = Math.round((value - 1) * 100);
      return `${percent >= 0 ? '+' : ''}${percent}%`;
    }
    if (kind === 'pitch') {
      const hz = Math.round(value);
      return `${hz >= 0 ? '+' : ''}${hz}Hz`;
    }
    if (value < 0 || value > 100) throw new RangeError(`volume 必须在 0..100 之间（100 = 原音量，收到 ${value}）`);
    return String(Math.round(value));
  }
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!raw) {
      if (kind === 'rate') return '+0%';
      if (kind === 'pitch') return '+0Hz';
      return '100';
    }
    if (PROSODY_KEYWORDS.has(raw.toLowerCase())) return raw.toLowerCase();
    if (PROSODY_VALUE_RE.test(raw)) return raw;
    throw new TypeError(`${kind} 参数不合法：${describeValue(raw)}（只接受数字、'+10%'、'-5Hz'、'+2st' 或 SSML 关键字）`);
  }
  throw new TypeError(`${kind} 必须是数字或字符串（收到 ${typeof value}）`);
}

/** rate/pitch/volume 三个值一起归一化（离线可测，不联网） */
export function normalizeProsody(options: EdgeTtsSynthOptions = {}): ProsodyValues {
  return {
    rate: formatProsodyValue(options.rate, 'rate'),
    pitch: formatProsodyValue(options.pitch, 'pitch'),
    volume: formatProsodyValue(options.volume, 'volume'),
  };
}

/** 语音短名校验：只允许字母数字与连字符（这个值会被拼进 SSML 属性，必须收紧） */
export function normalizeVoiceName(voice?: string): string {
  if (voice === undefined || voice === null) return DEFAULT_VOICE;
  if (typeof voice !== 'string') throw new TypeError('voice 必须是字符串');
  const name = voice.trim();
  if (!name) return DEFAULT_VOICE;
  if (!/^[A-Za-z0-9-]+$/.test(name)) {
    throw new TypeError(`voice 名字不合法（只允许字母、数字和 -）：${name}`);
  }
  return name;
}

/** 文本清洗 + 校验：去控制字符、统一换行、去首尾空白；空文本/超长直接抛错 */
export function validateText(text: string): string {
  if (typeof text !== 'string') throw new TypeError('Edge TTS 需要字符串文本');
  const cleaned = text
    .replace(/\r\n?/g, '\n')
    // 保留 \n \t，去掉其余控制字符（它们会让 SSML/服务端直接报错）
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
  if (!cleaned) throw new TypeError('Edge TTS 文本为空');
  if (cleaned.length > MAX_TEXT_CHARS) {
    throw new RangeError(`Edge TTS 单次文本过长（${cleaned.length} 字符 > 上限 ${MAX_TEXT_CHARS}）`);
  }
  return cleaned;
}

/** XML 转义（msedge-tts 的 SSML 模板不转义输入，这一步必须自己做） */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 粗判是不是 mp3（ID3 头或帧同步）；只用于自检/日志，不作为失败依据 */
export function looksLikeMp3(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 3) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true; // 'ID3'
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function pickString(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

/**
 * 声音列表归一化：兼容 msedge-tts 的 Voice[]（Edge 接口原样字段 Name/ShortName/Locale/Gender）
 * 与「已经小驼峰化」的对象，另外接受 { voices: [...] } 包一层。
 */
export function normalizeVoices(raw: unknown): EdgeVoiceInfo[] {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { voices?: unknown }).voices)
      ? (raw as { voices: unknown[] }).voices
      : [];
  const out: EdgeVoiceInfo[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const shortName = pickString(record.ShortName, record.shortName);
    if (!shortName || seen.has(shortName)) continue;
    seen.add(shortName);
    out.push({
      shortName,
      name: pickString(record.Name, record.name, record.FriendlyName, record.friendlyName, shortName),
      locale: pickString(record.Locale, record.locale),
      gender: pickString(record.Gender, record.gender),
      ...(() => {
        const friendly = pickString(record.FriendlyName, record.friendlyName);
        return friendly ? { friendlyName: friendly } : {};
      })(),
    });
  }
  return out;
}

/** 从 Edge 声音接口的原始 JSON 文本解析（离线可测；字段缺失的条目会被跳过） */
export function parseVoicesJson(text: string): EdgeVoiceInfo[] {
  if (typeof text !== 'string' || !text.trim()) throw new TypeError('声音列表 JSON 为空');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new TypeError(`声音列表不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  return normalizeVoices(parsed);
}

/** 中文声音（zh-CN / zh-TW / zh-HK 以及方言） */
export function chineseVoices(voices: EdgeVoiceInfo[]): EdgeVoiceInfo[] {
  return voices.filter((voice) => /^zh(-|$)/i.test(voice.locale));
}

/**
 * 按用户输入挑声音：先精确短名 → 再 locale（'zh-CN'）→ 再短名包含 → 再展示名包含。
 * 空查询返回 undefined（调用方自己决定默认声音）。
 */
export function pickVoice(voices: EdgeVoiceInfo[], query?: string): EdgeVoiceInfo | undefined {
  const wanted = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!wanted) return undefined;
  const exact = voices.find((voice) => voice.shortName.toLowerCase() === wanted);
  if (exact) return exact;
  const byLocale = voices.find((voice) => voice.locale.toLowerCase() === wanted);
  if (byLocale) return byLocale;
  const byShort = voices.find((voice) => voice.shortName.toLowerCase().includes(wanted));
  if (byShort) return byShort;
  return voices.find((voice) => voice.name.toLowerCase().includes(wanted) || (voice.friendlyName ?? '').toLowerCase().includes(wanted));
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（${timeoutMs}ms）`)), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** 把音频流收成 Buffer；超时/出错都会销毁流并清理 */
function collectAudioStream(stream: Readable, timeoutMs: number, cleanup: () => void): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('error', onError);
      cleanup();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const onData = (chunk: Buffer | string): void => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    };
    const onEnd = (): void => finish();
    const onError = (err: Error): void => finish(err);
    const timer = setTimeout(() => {
      try { stream.destroy(); } catch { /* 已经结束 */ }
      finish(new Error(`Edge TTS 合成超时（${timeoutMs}ms）`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    stream.on('data', onData);
    stream.on('end', onEnd);
    stream.on('error', onError);
  });
}

/**
 * 合成一段语音，返回 mp3 Buffer。
 * 失败（网络/服务端/超时）统一抛 Error，message 是可读的中文原因。
 */
export async function synthesize(text: string, options: EdgeTtsSynthOptions = {}): Promise<Buffer> {
  const clean = validateText(text);
  const voice = normalizeVoiceName(options.voice);
  const prosody = normalizeProsody(options);
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);

  const tts = new MsEdgeTTS({
    connectionTimeoutMs: Math.min(timeoutMs, 15_000),
    synthesisTimeoutMs: timeoutMs,
  });
  const close = (): void => {
    try { tts.close(); } catch { /* 已经关了 */ }
  };

  try {
    await tts.setMetadata(voice, DEFAULT_FORMAT);
    const { audioStream } = tts.toStream(escapeXml(clean), prosody);
    const buffer = await collectAudioStream(audioStream, timeoutMs, close);
    if (!buffer.length) throw new Error('Edge TTS 没有返回音频数据');
    return buffer;
  } catch (err) {
    close();
    if (err instanceof TypeError || err instanceof RangeError) throw err;
    throw new Error(`Edge TTS 合成失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 拉取 Edge 的可用声音列表（联网）。返回归一化后的结构，便于设置页直接展示。 */
export async function listVoices(options: { timeoutMs?: number } = {}): Promise<EdgeVoiceInfo[]> {
  const timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const tts = new MsEdgeTTS({ connectionTimeoutMs: Math.min(timeoutMs, 15_000) });
  try {
    const raw = await withTimeout(tts.getVoices(), timeoutMs, '获取 Edge TTS 声音列表');
    const voices = normalizeVoices(raw);
    if (!voices.length) throw new Error('Edge TTS 返回的声音列表是空的');
    return voices;
  } catch (err) {
    if (err instanceof TypeError) throw err;
    throw new Error(`获取 Edge TTS 声音列表失败：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try { tts.close(); } catch { /* 已经关了 */ }
  }
}
