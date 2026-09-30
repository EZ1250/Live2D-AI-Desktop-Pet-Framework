/**
 * voice.ts —— 语音输入：录音二进制 → 云端 ASR（OpenAI 兼容 /audio/transcriptions）
 *
 * 设计约束（隐私 + 免依赖 + 不炸主进程）：
 *   - 音频**只存在于内存**：本模块不读写磁盘、不落盘、不缓存；调用方负责在转写结束后立刻丢弃 buffer。
 *   - 不新增任何 npm 依赖：只用 Node 20 自带的 fetch / FormData / Blob / File / AbortController。
 *   - 任何失败都**不抛异常**（调用方是 IPC handler）：统一收敛成 { ok:false, error }。
 *   - 不打印 apiKey / Authorization（日志只记错误摘要）。
 *
 * 兼容性：默认对接阿里云百炼兼容模式（qwen3-asr-flash）；任何 OpenAI 兼容网关只要
 * settings.aiBaseUrl 指向 `<base>`（含或不含 /audio/transcriptions 均可）就能用。
 */
import { Buffer } from 'node:buffer';

export interface VoiceConfig {
  /** 网关根地址，例：https://dashscope.aliyuncs.com/compatible-mode/v1 */
  baseUrl: string;
  apiKey: string;
  /** 转写模型，缺省 qwen3-asr-flash */
  model?: string;
}

export interface TranscribeInput extends VoiceConfig {
  /** 音频二进制（webm/opus、wav、mp3…） */
  bytes: Uint8Array;
  /** 例：audio/webm;codecs=opus */
  mime?: string;
  /** 例：zh */
  language?: string;
  /** 缺省 60000 */
  timeoutMs?: number;
  /**
   * 转写路由：
   *  - 'transcriptions'：OpenAI 经典 multipart（POST <base>/audio/transcriptions）
   *  - 'chat-audio'    ：走 chat/completions + input_audio（data URL）——**阿里云百炼工作区域名只支持这条**
   *  - 'auto'（默认）  ：按"上次成功过的路由"优先；没有记忆时先试 transcriptions，404/空体再降级到 chat-audio
   */
  route?: VoiceRoute;
}

export type VoiceRoute = 'auto' | 'transcriptions' | 'chat-audio';

export interface TranscribeResult {
  ok: boolean;
  /** ok=false 时为空串 */
  text: string;
  /** 实际耗时（ms） */
  ms: number;
  /** 人类可读的中文错误（含 HTTP 状态码与上游 message） */
  error?: string;
  /** 实际生效的路由（成功时一定能拿到，便于设置页展示与后续记忆） */
  route?: Exclude<VoiceRoute, 'auto'>;
  /** 上游附带的语种/情绪（DashScope 的 annotations；有就回传，没有就省略） */
  language?: string;
  emotion?: string;
}

export const DEFAULT_VOICE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const DEFAULT_VOICE_MODEL = 'qwen3-asr-flash';
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024; // 20MB
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * "上次成功的路由"记忆：key = baseUrl|model。
 * 为什么需要：auto 每次先撞 404 会白白多花 200~400ms；记住一次之后后续直接走对的那条。
 * 只存在内存里（进程退出即忘），不落盘、不含密钥。
 */
const routeMemory = new Map<string, Exclude<VoiceRoute, 'auto'>>();

function routeKey(baseUrl: string, model: string): string {
  return `${baseUrl}|${model}`;
}

/** 记住某网关上一次成功的路由，下次 auto 优先走它。 */
export function rememberRoute(baseUrl: string, model: string, route: Exclude<VoiceRoute, 'auto'>): void {
  routeMemory.set(routeKey(baseUrl, model), route);
}

export function knownRoute(baseUrl: string, model: string): Exclude<VoiceRoute, 'auto'> | null {
  return routeMemory.get(routeKey(baseUrl, model)) ?? null;
}

/** HTTP 状态 + 上游 message → 一句中文（空体时给"网关没有这个接口"的解释） */
function describeHttpFailure(status: number, body: string, endpoint: string): string {
  const summary = summarizeErrorBody(body);
  const empty = !body.trim();
  const host = (() => {
    try {
      return new URL(endpoint).host;
    } catch {
      return endpoint;
    }
  })();
  if (empty && (status === 404 || status === 405)) return `HTTP ${status}（${host} 没有这个接口）`;
  return `HTTP ${status}：${summary}`;
}


function trimEndSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** 归一化配置：去尾斜杠、去掉误填的 /audio/transcriptions 后缀、空值回落默认。 */
export function normalizeVoiceConfig(cfg: Partial<VoiceConfig> | null | undefined): VoiceConfig {
  const src = cfg ?? {};
  let baseUrl = typeof src.baseUrl === 'string' ? src.baseUrl.trim() : '';
  baseUrl = trimEndSlash(baseUrl);
  const suffix = '/audio/transcriptions';
  if (baseUrl.toLowerCase().endsWith(suffix)) {
    baseUrl = trimEndSlash(baseUrl.slice(0, baseUrl.length - suffix.length));
  }
  if (!baseUrl) baseUrl = DEFAULT_VOICE_BASE_URL; // 空 → 默认百炼兼容模式
  const model = typeof src.model === 'string' && src.model.trim() ? src.model.trim() : DEFAULT_VOICE_MODEL;
  const apiKey = typeof src.apiKey === 'string' ? src.apiKey.trim() : '';
  return { baseUrl, apiKey, model };
}

/** MIME → 文件扩展名（上游按扩展名判格式，缺省 webm）。 */
export function guessAudioExtension(mime: string | undefined): string {
  if (!mime) return 'webm';
  const m = mime.toLowerCase();
  if (m.includes('webm') || m.includes('opus')) return 'webm';
  if (m.includes('wav') || m.includes('x-wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  return 'bin';
}

/** 三种常见响应体形状里取第一段非空文本（{text} / {output:{text}} / {choices:[{message:{content}}]}）。 */
function extractTextFromResponse(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  // 注意：这里**不**过滤空白串——"识别到了但是空的"要能让调用方给出"没有识别到语音内容"，
  // 而不是误报成"返回内容无法解析"。
  if (typeof obj.text === 'string') return obj.text;
  const output = obj.output;
  if (output && typeof output === 'object') {
    const t = (output as Record<string, unknown>).text;
    if (typeof t === 'string') return t;
  }
  const choices = obj.choices;
  if (Array.isArray(choices)) {
    for (const c of choices) {
      const content = (c as { message?: { content?: unknown } } | null)?.message?.content;
      if (typeof content === 'string') return content;
    }
  }
  return null;
}

/** 错误响应体 → 简短中文摘要（优先 message/error.message，其次前 200 字原文）。 */
function summarizeErrorBody(raw: string): string {
  const s = (raw || '').trim();
  if (!s) return '空响应';
  try {
    const j = JSON.parse(s) as Record<string, unknown>;
    const msg = (j.message ?? (j.error as Record<string, unknown> | undefined)?.message ?? j.code) as unknown;
    if (typeof msg === 'string' && msg) return msg.slice(0, 200);
  } catch {
    /* 非 JSON：走下面的原文截断 */
  }
  return s.slice(0, 200);
}

/** 从响应里取语种/情绪（DashScope choices[].message.annotations[]，没有就返回空对象） */
function extractAnnotations(json: unknown): { language?: string; emotion?: string } {
  const out: { language?: string; emotion?: string } = {};
  const choices = (json as { choices?: unknown } | null)?.choices;
  if (!Array.isArray(choices)) return out;
  for (const c of choices) {
    const anns = (c as { message?: { annotations?: unknown } } | null)?.message?.annotations;
    if (!Array.isArray(anns)) continue;
    for (const a of anns) {
      const rec = a as { language?: unknown; emotion?: unknown } | null;
      if (!out.language && typeof rec?.language === 'string' && rec.language) out.language = rec.language;
      if (!out.emotion && typeof rec?.emotion === 'string' && rec.emotion) out.emotion = rec.emotion;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 两条转写路由 */

interface RouteAttempt {
  route: Exclude<VoiceRoute, 'auto'>;
  ok: boolean;
  text: string;
  ms: number;
  error?: string;
  language?: string;
  emotion?: string;
}

/** 路由 A：OpenAI 经典 multipart（POST <base>/audio/transcriptions） */
async function tryTranscriptions(
  input: TranscribeInput,
  config: Required<VoiceConfig>,
  timeoutMs: number
): Promise<RouteAttempt> {
  const t0 = Date.now();
  const endpoint = `${config.baseUrl}/audio/transcriptions`;
  const mime = input.mime || 'audio/webm';
  const blob = new Blob([input.bytes as unknown as BlobPart], { type: mime });
  const file = new File([blob], `speech.${guessAudioExtension(input.mime)}`, { type: mime });
  const form = new FormData();
  form.append('file', file);
  form.append('model', config.model);
  if (input.language) form.append('language', input.language);
  try {
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      // 不要手写 Content-Type —— FormData 需要自带 boundary
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form,
    }, timeoutMs);
    const ms = Date.now() - t0;
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      return { route: 'transcriptions', ok: false, text: '', ms, error: describeHttpFailure(res.status, raw, endpoint) };
    }
    const json = parseJson(raw);
    if (json === undefined) {
      return { route: 'transcriptions', ok: false, text: '', ms, error: `返回内容无法解析：${raw.trim().slice(0, 120)}` };
    }
    const text = extractTextFromResponse(json);
    if (text === null) {
      return { route: 'transcriptions', ok: false, text: '', ms, error: `返回内容无法解析：${JSON.stringify(json).slice(0, 120)}` };
    }
    return { route: 'transcriptions', ok: true, text: text.trim(), ms, ...extractAnnotations(json) };
  } catch (err) {
    return { route: 'transcriptions', ok: false, text: '', ms: Date.now() - t0, error: errText(err, timeoutMs) };
  }
}

/**
 * 路由 B：chat/completions + input_audio（data URL）。
 * 阿里云百炼的**工作区域名**（ws-*.maas.aliyuncs.com）没有 /audio/transcriptions，
 * 但支持把音频当消息内容发进来（实测 qwen3-asr-flash 返回 200 + 文本）。
 */
async function tryChatAudio(
  input: TranscribeInput,
  config: Required<VoiceConfig>,
  timeoutMs: number
): Promise<RouteAttempt> {
  const t0 = Date.now();
  const endpoint = `${config.baseUrl}/chat/completions`;
  const mime = input.mime || 'audio/webm';
  const b64 = Buffer.from(input.bytes).toString('base64');
  const body = {
    model: config.model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${b64}` } }],
      },
    ],
  };
  try {
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeoutMs);
    const ms = Date.now() - t0;
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      return { route: 'chat-audio', ok: false, text: '', ms, error: describeHttpFailure(res.status, raw, endpoint) };
    }
    const json = parseJson(raw);
    if (json === undefined) {
      return { route: 'chat-audio', ok: false, text: '', ms, error: `返回内容无法解析：${raw.trim().slice(0, 120)}` };
    }
    const text = extractTextFromResponse(json);
    if (text === null) {
      return { route: 'chat-audio', ok: false, text: '', ms, error: `返回内容无法解析：${JSON.stringify(json).slice(0, 120)}` };
    }
    return { route: 'chat-audio', ok: true, text: text.trim(), ms, ...extractAnnotations(json) };
  } catch (err) {
    return { route: 'chat-audio', ok: false, text: '', ms: Date.now() - t0, error: errText(err, timeoutMs) };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function errText(err: unknown, timeoutMs: number): string {
  if (err instanceof Error && err.name === 'AbortError') {
    return timeoutMs >= 1000 ? `超时（${Math.round(timeoutMs / 1000)}s）` : `超时（${timeoutMs}ms）`;
  }
  return `请求失败：${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
}

/**
 * 转写一段音频。永不抛异常。
 * 调用方（IPC）拿到的错误文案可直接展示给用户。
 */
export async function transcribeAudio(input: TranscribeInput): Promise<TranscribeResult> {
  const start = Date.now();
  const done = (ok: boolean, text: string, error?: string): TranscribeResult => ({
    ok,
    text,
    ms: Date.now() - start,
    ...(error ? { error } : {}),
  });

  try {
    const bytes = input?.bytes;
    if (!bytes || bytes.length === 0) return done(false, '', '没有收到音频数据');
    if (bytes.length > MAX_AUDIO_BYTES) return done(false, '', '音频过大（>20MB），请缩短录音');

    const config: Required<VoiceConfig> = {
      ...normalizeVoiceConfig(input),
      model: input.model?.trim() || DEFAULT_VOICE_MODEL,
    };
    if (!config.apiKey) return done(false, '', '语音识别未配置密钥（设置 → AI 接口）');

    const timeoutMs = Number.isFinite(input.timeoutMs) && (input.timeoutMs as number) > 0
      ? (input.timeoutMs as number)
      : DEFAULT_TIMEOUT_MS;

    const wanted: VoiceRoute = input.route === 'transcriptions' || input.route === 'chat-audio' ? input.route : 'auto';
    const remembered = knownRoute(config.baseUrl, config.model);
    // auto 的顺序：记住过就先用它；没记住时先试 chat-audio（百炼/阿里系网关实测只支持这条），
    // 失败再退回 OpenAI 经典 multipart（openai.com / 自建网关常见）。两条都会试，不存在"试错就失败"。
    const order: Array<Exclude<VoiceRoute, 'auto'>> = wanted === 'auto'
      ? remembered
        ? remembered === 'transcriptions' ? ['transcriptions', 'chat-audio'] : ['chat-audio', 'transcriptions']
        : ['chat-audio', 'transcriptions']
      : [wanted];

    const attempts: RouteAttempt[] = [];
    for (const route of order) {
      const attempt = route === 'transcriptions'
        ? await tryTranscriptions(input, config, timeoutMs)
        : await tryChatAudio(input, config, timeoutMs);
      attempts.push(attempt);
      if (attempt.ok && attempt.text) {
        rememberRoute(config.baseUrl, config.model, route); // 记住可用路由：下次不再白撞 404
        return {
          ok: true,
          text: attempt.text,
          ms: Date.now() - start,
          route,
          ...(attempt.language ? { language: attempt.language } : {}),
          ...(attempt.emotion ? { emotion: attempt.emotion } : {}),
        };
      }
      if (attempt.ok && !attempt.text) {
        // 接口通了但没识别到内容：不必再试另一条路由（不是路由问题）
        return done(false, '', '没有识别到语音内容，请再说一次');
      }
    }

    // 两条都失败：把每条的原因压成一行，并给一句"该怎么办"
    const detail = attempts.map((a) => `${a.route}: ${a.error ?? '失败'}`).join('；');
    const allMissing = attempts.every((a) => /没有这个接口/.test(a.error ?? ''));
    const hint = allMissing
      ? `（网关 ${(() => { try { return new URL(config.baseUrl).host; } catch { return config.baseUrl; } })()} 不支持语音转写，请在设置→语音识别里单独填一个支持 ASR 的地址/模型）`
      : '（可在设置→语音识别点「自检」看到两条路由的详细返回）';
    console.warn('[voice] 转写两条路由都失败：', detail.slice(0, 300));
    return done(false, '', `语音识别失败：${detail.slice(0, 180)}${hint}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[voice] 转写异常：', msg.slice(0, 200));
    return done(false, '', `语音识别请求失败：${msg.slice(0, 200)}`);
  }
}

/* ------------------------------------------------------------------ 自检

   设置页的「自检」按钮用**内置合成音频**（0.6s 正弦 WAV）分别打两条路由，
   把"HTTP 状态 + 上游 message + 命中哪条"直接展示出来 —— 不依赖麦克风、不消耗用户录音。
   音频只在内存里构造，不发往任何第三方之外的地址（就是用户自己配的网关）。 */

/** 生成一段 0.6s 16kHz 单声道正弦 WAV（自检用，不落盘） */
export function makeProbeWav(secs = 0.6, sampleRate = 16000): Uint8Array {
  const n = Math.max(1, Math.floor(sampleRate * secs));
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'latin1');
  buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'latin1');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(Math.sin(i / 20) * 4000), 44 + i * 2);
  return new Uint8Array(buf);
}

export interface VoiceCheckRouteReport {
  route: Exclude<VoiceRoute, 'auto'>;
  ok: boolean;
  status: string;
  ms: number;
  text?: string;
  error?: string;
}

/* ================================================================
   转写模型的自动索引与体检：按 API 地址拉 /models，挑出转写类候选，
   并在"当前模型不在列表里 / 列表里没有转写类模型 / 拉不到列表"时给出明确提示。
   ================================================================ */

/** 专做转写的命名（最强特征）：名字里带 asr 的基本就是转写模型 */
const ASR_TOP = [/asr/i];
/** "带 asr 但同时也是多模态/音频大杂烩"的排除词：这类排在纯转写模型之后 */
const ASR_TOP_EXCLUDE = [/audio/i, /omni/i];
/** 转写模型的其它常见命名 */
const ASR_STRONG = [/whisper/i, /transcri/i, /speech[-_]?to[-_]?text/i, /speech[-_]?recogn/i, /sensevoice/i, /paraformer/i];
/** 语音/音频类命名（弱特征：可能不是转写，但值得优先展示） */
const ASR_WEAK = [/audio/i, /voice/i, /realtime/i, /omni/i];

/** 0=不像转写模型；1=音频/语音类；2=明确转写类；3=带 asr；4=带 asr 的**专用**转写模型（最像） */
export function asrScore(name: string): number {
  const n = String(name ?? '');
  if (!n) return 0;
  if (ASR_TOP.some((re) => re.test(n))) {
    // qwen3-asr-flash 这类"纯转写"排在 qwen-audio-*-asr-flash 这类多模态前面
    return ASR_TOP_EXCLUDE.some((re) => re.test(n)) ? 3 : 4;
  }
  if (ASR_STRONG.some((re) => re.test(n))) return 2;
  if (ASR_WEAK.some((re) => re.test(n))) return 1;
  return 0;
}

/** 从服务端模型列表里挑转写候选：专用 asr → asr → 转写类 → 音频语音类（各自保持服务端顺序） */
export function rankAsrCandidates(models: string[]): string[] {
  const scored = models.map((m, i) => ({ m, i, s: asrScore(m) }));
  return scored
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.m);
}

/**
 * 自动挑一个转写模型：
 *  1) 服务端有本应用默认模型（qwen3-asr-flash）→ 直接用；
 *  2) 有它的**日期快照**（qwen3-asr-flash-2026-02-10）→ 优先非 realtime 的那个；
 *  3) 否则用排序第一的候选。
 * 这样"留空自动识别"会落在与默认同一条线上，而不是被某个更新潮的 audio 模型带跑。
 */
export function pickAutoVoiceModel(models: string[], candidates: string[]): string | undefined {
  if (models.includes(DEFAULT_VOICE_MODEL)) return DEFAULT_VOICE_MODEL;
  const prefix = DEFAULT_VOICE_MODEL.toLowerCase();
  const snapshots = candidates.filter((m) => m.toLowerCase().startsWith(prefix));
  if (snapshots.length) return snapshots.find((m) => !/realtime/i.test(m)) ?? snapshots[0];
  return candidates[0];
}

export interface VoiceModelIndex {
  /** 是否成功从地址拿到模型列表 */
  ok: boolean;
  /** 只留主机+路径，绝不含密钥 */
  endpoint: string;
  /** 列表里的模型总数 */
  total: number;
  /** 转写类候选（强特征在前） */
  candidates: string[];
  /** 当前配置的转写模型（设置里填的；空串=没填） */
  current: string;
  /** 当前模型是否出现在服务端列表里（列表没拿到时为 false，含义见 verdict） */
  currentSupported: boolean;
  /** 当前模型为空时，建议自动填入的候选（没有合适候选则为 undefined） */
  autoPicked?: string;
  /** 结论：ok=当前模型可用；warn=能用但需要人确认（例如自动填了/没候选）；error=拉不到列表或模型不存在 */
  verdict: 'ok' | 'warn' | 'error';
  /** 一句话原因（中文，给用户看） */
  reason: string;
  /** 一句话怎么办（中文，给用户看） */
  action?: string;
  /** 上次实测可用的路由（自检/转写成功后记忆下来的） */
  knownRoute?: Exclude<VoiceRoute, 'auto'>;
  /** 路由层面的提醒（例如固定了 transcriptions 但网关不一定支持） */
  routeHint?: string;
}

/** 从 /models 响应里宽松取模型名（兼容 {data:[{id}]} / {models:[...]} / 裸数组） */
export function parseModelIds(payload: unknown): string[] {
  const pick = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .map((x) => {
        if (typeof x === 'string') return x.trim();
        if (x && typeof x === 'object') {
          const id = (x as { id?: unknown; name?: unknown; model?: unknown }).id
            ?? (x as { name?: unknown }).name
            ?? (x as { model?: unknown }).model;
          return typeof id === 'string' ? id.trim() : '';
        }
        return '';
      })
      .filter(Boolean);
  };
  if (Array.isArray(payload)) return Array.from(new Set(pick(payload)));
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>;
    const merged = [...pick(obj.data), ...pick(obj.models)];
    if (merged.length) return Array.from(new Set(merged));
  }
  return [];
}

/** 脱敏展示：只留主机 + 路径（查询串里可能带凭据） */
export function voiceEndpointLabel(baseUrl: string): string {
  try {
    const u = new URL(baseUrl);
    return `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return baseUrl;
  }
}

/**
 * 按 API 地址索引转写模型，并对"当前模型 / 路由"做体检。
 * 网络失败不抛异常：一律落在 error 结论 + 可执行建议里（设置页直接展示）。
 */
export async function indexVoiceModels(
  cfg: Partial<VoiceConfig> | null | undefined,
  opts: { route?: VoiceRoute; timeoutMs?: number } = {},
): Promise<VoiceModelIndex> {
  const config = normalizeVoiceConfig(cfg);
  const endpoint = voiceEndpointLabel(config.baseUrl);
  const current = typeof cfg?.model === 'string' ? cfg.model.trim() : '';
  const route = opts.route === 'transcriptions' || opts.route === 'chat-audio' ? opts.route : 'auto';
  const known = knownRoute(config.baseUrl, current || config.model || '');
  const base: VoiceModelIndex = {
    ok: false,
    endpoint,
    total: 0,
    candidates: [],
    current,
    currentSupported: false,
    verdict: 'error',
    reason: '还没拿到服务端模型列表',
    ...(known ? { knownRoute: known } : {}),
  };
  if (!config.apiKey) {
    return {
      ...base,
      verdict: 'warn',
      reason: '还没填密钥，无法读取这个地址的模型列表',
      action: '在「AI 接口」里填密钥，或在本节的「语音专用 Key」里单独填',
    };
  }

  let payload: unknown = null;
  try {
    let url = trimEndSlash(config.baseUrl);
    if (!/\/models$/i.test(url)) url += '/models';
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const res = await fetchWithTimeout(
      url,
      { method: 'GET', headers: { Accept: 'application/json', Authorization: `Bearer ${config.apiKey}` } },
      timeoutMs,
    );
    const raw = await res.text();
    if (res.status !== 200) {
      return {
        ...base,
        verdict: 'error',
        reason: `这个地址取不到模型列表（HTTP ${res.status}）`,
        action: raw.trim()
          ? `检查 API 地址与密钥（服务端说：${summarizeErrorBody(raw)}）`
          : '确认地址指向 …/v1（OpenAI 兼容口）；也可以直接手填转写模型名',
      };
    }
    payload = parseJson(raw);
  } catch (err) {
    return {
      ...base,
      verdict: 'error',
      reason: `连不上这个地址：${errText(err, opts.timeoutMs ?? 20_000)}`,
      action: '确认地址/网络可达；离线环境可以手填模型名，语音识别本身仍按地址直连',
    };
  }

  const models = parseModelIds(payload);
  const candidates = rankAsrCandidates(models);
  const currentSupported = !!current && models.includes(current);
  const autoPicked = !current ? pickAutoVoiceModel(models, candidates) : undefined;
  const routeHint = route === 'transcriptions'
    ? '已固定 audio/transcriptions 路由：部分网关（如百炼 compatible-mode）没有这个接口，报 404 就改成「自动」或「chat+音频」'
    : known
      ? `上次实测可用路由：${known === 'chat-audio' ? 'chat 接口 + 音频' : 'audio/transcriptions'}`
      : undefined;

  if (!models.length) {
    return {
      ...base,
      ok: true,
      verdict: 'warn',
      reason: '这个地址的模型列表是空的',
      action: '确认地址指向 …/v1（不是 …/v1/audio/transcriptions）；或直接手填转写模型名再点「🎙 自检语音识别」实测',
      ...(routeHint ? { routeHint } : {}),
    };
  }
  if (currentSupported) {
    return {
      ...base,
      ok: true,
      total: models.length,
      candidates,
      currentSupported: true,
      verdict: 'ok',
      reason: `当前转写模型「${current}」在这个地址的模型列表里（共 ${models.length} 个模型）`,
      ...(candidates.length > 1 ? { action: `其它转写候选：${candidates.filter((c) => c !== current).slice(0, 4).join('、')}` } : {}),
      ...(routeHint ? { routeHint } : {}),
    };
  }
  if (!current) {
    return {
      ...base,
      ok: true,
      total: models.length,
      candidates,
      ...(autoPicked ? { autoPicked } : {}),
      verdict: candidates.length ? 'warn' : 'warn',
      reason: candidates.length
        ? `转写模型留空：已按地址自动识别到 ${candidates.length} 个转写类模型`
        : `这个地址的 ${models.length} 个模型里没找到明显是转写类的（可能是纯文本模型地址）`,
      action: candidates.length
        ? `已建议填入「${candidates[0]}」，保存即生效；也可以点「▾ 选择转写模型」自己挑`
        : '手填一个转写模型名（如 qwen3-asr-flash / whisper-1），或点「🎙 自检语音识别」实测两条路由',
      ...(routeHint ? { routeHint } : {}),
    };
  }
  return {
    ...base,
    ok: true,
    total: models.length,
    candidates,
    currentSupported: false,
    verdict: 'error',
    reason: `这个地址的模型列表里没有「${current}」`,
    action: candidates.length
      ? `可能是名字写错或该模型未开通；可改用候选：${candidates.slice(0, 4).join('、')}`
      : '可能是名字写错、模型未开通，或地址指错了；也可以点「🎙 自检语音识别」实测路由',
    ...(routeHint ? { routeHint } : {}),
  };
}

export interface VoiceCheckResult {
  ok: boolean;
  /** 建议直接使用的路由（两条都失败时为 undefined） */
  route?: Exclude<VoiceRoute, 'auto'>;
  model: string;
  /** 只留主机名，绝不含密钥 */
  endpoint: string;
  reports: VoiceCheckRouteReport[];
  hint?: string;
}

/** 两条路由各打一次（合成音频）；结果可直接在设置页展示 */
export async function checkVoiceRoutes(cfg: Partial<VoiceConfig> | null | undefined): Promise<VoiceCheckResult> {
  const config: Required<VoiceConfig> = {
    ...normalizeVoiceConfig(cfg),
    model: (cfg?.model ?? '').trim() || DEFAULT_VOICE_MODEL,
  };
  let endpoint = config.baseUrl;
  try {
    const u = new URL(config.baseUrl);
    endpoint = `${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    /* 地址不合法就原样展示 */
  }
  if (!config.apiKey) {
    return {
      ok: false,
      model: config.model,
      endpoint,
      reports: [],
      hint: '还没填密钥（设置 → AI 接口里的密钥会被复用；也可以在语音识别里单独填）',
    };
  }
  const bytes = makeProbeWav();
  const reports: VoiceCheckRouteReport[] = [];
  for (const route of ['transcriptions', 'chat-audio'] as const) {
    const attempt = route === 'transcriptions'
      ? await tryTranscriptions({ ...config, bytes, mime: 'audio/wav' }, config, 20_000)
      : await tryChatAudio({ ...config, bytes, mime: 'audio/wav' }, config, 20_000);
    reports.push({
      route,
      ok: attempt.ok,
      status: attempt.ok ? '200 OK' : (attempt.error ?? '失败'),
      ms: attempt.ms,
      ...(attempt.text ? { text: attempt.text.slice(0, 120) } : {}),
      ...(attempt.ok ? {} : { error: attempt.error }),
    });
  }
  const winner = reports.find((r) => r.ok);
  if (winner) rememberRoute(config.baseUrl, config.model, winner.route);
  return {
    ok: !!winner,
    ...(winner ? { route: winner.route } : {}),
    model: config.model,
    endpoint,
    reports,
    ...(winner
      ? {}
      : { hint: '两条路由都没通：多半是这个网关不提供语音转写，请在设置→语音识别里单独填一个支持 ASR 的地址与模型' }),
  };
}

/** Buffer 版本（主进程从渲染层收到 ArrayBuffer 后常用）——保留给 IPC 层，避免各处重复转换。 */
export function toBytes(data: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data as ArrayBuffer);
}
