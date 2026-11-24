/**
 * mediaAttachments.ts —— 用户↔AI 的图片/音频/文件附件（API 与 DSH 两种接入方式共用）
 *
 * 设计要点（按用户要求）：
 *  1. 发送前先做兼容性检查：能直接发就发；需要转换（图片→视觉模型转述、音频→ASR 转写）就转换后发；
 *     真不支持（如没配视觉模型/ASR 失败）给出可读提示，不静默丢弃。
 *  2. API 模式：图片走「视觉模型转述」——当前聊天模型不支持视觉也不影响；文本文件内联；其它文件给本地路径
 *     （模型可用工具读取）。
 *  3. DSH 模式：图片复制到 bridge/inbox 并提示用 read_image 工具查看（实测 DSH 支持）；音频走 ASR；
 *     文本内联+路径；其它文件给路径（DSH 用文件工具读）。
 *  4. AI 回发媒体：
 *     - API：由工具 `send_to_user` 触发（mainImpl 执行，校验白名单后推送 IPC_CHAT_MEDIA）。
 *     - DSH：bridge 以 workspace-write 运行，任务文本约定「文件写当前目录 + [[send:相对路径]] 标注」，
 *       final 后由本模块解析标记、校验在 bridge 目录内、复制到 <userData>/chat-media 并推送。
 *
 * 安全：附件只从用户显式给出的本地路径读；AI 回发路径必须落在白名单目录；大小/数量有限制；不执行任何命令。
 */
import * as fs from 'fs';
import * as path from 'path';
import type {
  AppSettings,
  AttachmentKind,
  AttachmentRef,
  ChatMediaPayload,
  MediaCheckItem,
  MediaCheckResult,
} from '../../shared/contracts';
import { transcribeAudio, DEFAULT_VOICE_MODEL, MAX_AUDIO_BYTES } from './voice';

export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_AUDIO_BYTES_LIMIT = MAX_AUDIO_BYTES;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 6;
export const MAX_TEXT_INLINE = 20000;
export const MAX_MEDIA_OUT_BYTES = 15 * 1024 * 1024;
/** 一条消息所有附件合计上限（避免一次转述/编码把内存和上下文撑爆） */
export const MAX_TOTAL_ATTACHMENT_BYTES = 40 * 1024 * 1024;
/** 单张图片视觉转述的文本上限（OCR 太长会膨胀上下文） */
export const MAX_IMAGE_DESCRIPTION_CHARS = 4000;
const MAX_DATA_URL_BYTES = 8 * 1024 * 1024;

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'heic'];
const AUDIO_EXT = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'opus', 'flac', 'weba', 'webm'];
const TEXT_EXT = [
  'txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'yml', 'yaml', 'xml', 'html', 'htm',
  'css', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs',
  'rb', 'php', 'sh', 'ps1', 'bat', 'cmd', 'ini', 'toml', 'conf', 'sql', 'env', 'gitignore', 'vue', 'svelte',
];

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  opus: 'audio/opus', flac: 'audio/flac', weba: 'audio/webm', webm: 'audio/webm',
  txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv', html: 'text/html',
  css: 'text/css', js: 'text/javascript', ts: 'text/plain', py: 'text/plain', pdf: 'application/pdf',
};

/** 扩展名（小写、不带点）。 */
export function extOf(name: string): string {
  return path.extname(name).replace(/^\./, '').toLowerCase();
}

/** 按扩展名/MIME 判断附件类型。 */
export function classifyAttachment(name: string, mime?: string): AttachmentKind {
  const ext = extOf(name);
  const m = (mime ?? '').toLowerCase();
  if (IMAGE_EXT.includes(ext) || m.startsWith('image/')) return 'image';
  if (AUDIO_EXT.includes(ext) || m.startsWith('audio/')) return 'audio';
  if (TEXT_EXT.includes(ext) || m.startsWith('text/') || m === 'application/json') return 'text';
  return 'file';
}

/** 扩展名 → MIME（不知道时 application/octet-stream）。 */
export function mimeForName(name: string): string {
  return MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream';
}

/** 模型名是否像视觉/多模态模型（API 模式用于决定"直接发图"还是"视觉转述"）。 */
export function isVisionModelName(name: string): boolean {
  const n = (name ?? '').toLowerCase();
  return /(^|[-_/.])(vl|vision|omni|multimodal|4v|1v)([-_/.]|$)|qwen[-_.]?[\d.]*[-_.]?vl|gpt-4o|gpt-4\.1|gemini|claude-3|llava|internvl|pixtral|minicpm-v|molmo|deepseek-vl|glm-4v|yi-vl|step-1v|qwen-vl|qvq/i.test(n);
}

/**
 * 视觉模型名解析：
 *  - 聊天模型本身就是视觉模型 → 用它（直接发图）；
 *  - 设置里显式填了 visionModel → 用它；
 *  - 有 /models 列表（availableModels）：从列表里挑第一个名字像视觉模型的；
 *    列表明确没有任何视觉模型 → 返回空串（表示"这个端点发不了图片"）；
 *  - 列表拉不到（网络失败/无 Key）→ 兜底 qwen3-vl-plus（发送时若失败给可读错误）。
 */
export function resolveVisionModel(settings: AppSettings, availableModels?: string[] | null): string {
  const chatModel = (settings.aiModel ?? '').trim();
  const explicit = (settings.visionModel ?? '').trim();
  const route = settings.visionRoute === 'chat' || settings.visionRoute === 'custom' ? settings.visionRoute : 'auto';
  if (route === 'chat') return chatModel;
  if (route === 'custom') return explicit;
  if (isVisionModelName(chatModel)) return chatModel;
  if (explicit) return explicit;
  if (availableModels && availableModels.length) {
    return pickVisionModelFromList(availableModels);
  }
  return 'qwen3-vl-plus';
}

/** 视觉识别实际使用的地址/Key：专用配置优先，留空复用聊天 API。 */
export function resolveVisionTransport(settings: AppSettings): { baseUrl: string; apiKey: string } {
  return {
    baseUrl: (settings.visionBaseUrl ?? '').trim() || (settings.aiBaseUrl ?? '').trim(),
    apiKey: (settings.visionApiKey ?? '').trim() || (settings.aiApiKey ?? '').trim(),
  };
}

/**
 * 从 /models 列表里挑视觉模型：排除实时语音/音频/向量等"名字像多模态但不能用来读图"的模型，
 * 优先名字带 vl/vision 的（如 qwen3-vl-plus），omni 是次选。
 */
export function pickVisionModelFromList(ids: string[]): string {
  const blacklist = /(realtime|audio|tts|asr|embedding|rerank|image-?gen|wanx|flux|stable-diffusion|sdxl|cosyvoice)/i;
  const candidates = ids.filter((id) => isVisionModelName(id) && !blacklist.test(id));
  if (!candidates.length) return '';
  const score = (id: string): number => {
    const n = id.toLowerCase();
    let s = 0;
    if (/qwen[\d.]*-?vl-plus/.test(n)) s += 100;
    if (/(^|[-_/])vl([-_/.]|$)/.test(n)) s += 40;
    if (n.includes('vision')) s += 30;
    if (n.includes('omni')) s += 10;
    if (n.includes('gpt-4o') || n.includes('gemini') || n.includes('claude')) s += 20;
    return s;
  };
  return [...candidates].sort((a, b) => score(b) - score(a))[0];
}

// ------------------------------------------------------------------ /models 探测

const modelListCache = new Map<string, { at: number; ids: string[] }>();
const MODEL_LIST_TTL_MS = 10 * 60 * 1000;

function modelsUrl(baseUrl: string): string {
  let url = (baseUrl || '').trim().replace(/\/+$/, '');
  url = url.replace(/\/chat\/completions$/i, '');
  return `${url}/models`;
}

/**
 * 拉取端点可用模型列表（GET <base>/models，缓存 10 分钟）。
 * ok=false 表示"拉不到/端点不支持"，调用方应回退到乐观策略而不是直接判不支持。
 */
export async function fetchModelIds(
  settings: AppSettings,
  timeoutMs = 8000,
  override?: { baseUrl?: string; apiKey?: string },
): Promise<{ ok: boolean; ids: string[]; error?: string }> {
  const baseUrl = (override?.baseUrl ?? settings.aiBaseUrl ?? '').trim();
  const apiKey = (override?.apiKey ?? settings.aiApiKey ?? '').trim();
  if (!baseUrl || !apiKey) return { ok: false, ids: [], error: '未配置 API 地址/Key' };
  const cacheKey = `${baseUrl}\u0000${apiKey.slice(-8)}`;
  const hit = modelListCache.get(cacheKey);
  if (hit && Date.now() - hit.at < MODEL_LIST_TTL_MS) return { ok: true, ids: hit.ids };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(modelsUrl(baseUrl), {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, ids: [], error: `HTTP ${res.status}` };
    const payload = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (payload.data ?? [])
      .map((m) => (m && typeof m.id === 'string' ? m.id : ''))
      .filter((id): id is string => !!id);
    modelListCache.set(cacheKey, { at: Date.now(), ids });
    return { ok: true, ids };
  } catch (err) {
    return { ok: false, ids: [], error: (err as Error).message };
  }
}

/** 语音（ASR）配置：voice* 留空时复用聊天 API 配置（与主进程语音输入的规则一致）。 */
export function resolveVoiceConfig(settings: AppSettings): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = (settings.voiceBaseUrl ?? '').trim() || (settings.aiBaseUrl ?? '').trim();
  const apiKey = (settings.voiceApiKey ?? '').trim() || (settings.aiApiKey ?? '').trim();
  const model = (settings.voiceModel ?? '').trim() || DEFAULT_VOICE_MODEL;
  return { baseUrl, apiKey, model };
}

/** 单附件大小上限（按类型）：超限返回可读原因。 */
export function attachmentSizeError(att: AttachmentRef): string | null {
  const limit = att.kind === 'image' ? MAX_IMAGE_BYTES : att.kind === 'audio' ? MAX_AUDIO_BYTES_LIMIT : MAX_FILE_BYTES;
  if (att.size > limit) {
    return `「${att.name}」超过大小限制（${Math.round(limit / 1024 / 1024)}MB）`;
  }
  return null;
}

// ------------------------------------------------------------------ 兼容性检查

function dshImageRoute(): string {
  return '复制到桥接目录，让 DSH 用 read_image 查看';
}

/**
 * 发送前兼容性检查（不做网络请求，只给结论；真正的转述/转写在发送时执行）。
 * API：
 *   - 图片：聊天模型本身支持视觉 → 直接发；否则用视觉模型转述（converted）。
 *   - 音频：ASR 转写（converted）；没有可用的 ASR 地址/Key → unsupported。
 *   - 文本：内联；其它文件：本地路径（模型可用工具读取）。
 * DSH：
 *   - 图片：DSH 有 read_image（实测）→ ok；音频：ASR 转写；文本：内联+路径；其它文件：路径。
 */
export interface CompatOptions {
  /** /models 拿到的可用模型列表；null/undefined = 没拿到（回退乐观策略） */
  availableModels?: string[] | null;
}

/** 同步核心检查（不联网；单测用；IPC 调异步包装版）。 */
export function checkMediaCompatibilityCore(
  settings: AppSettings,
  attachments: AttachmentRef[],
  opts: CompatOptions = {},
): MediaCheckResult {
  const mode: 'api' | 'dsh' = settings.aiMode === 'dsh' ? 'dsh' : 'api';
  const model = (settings.aiModel ?? '').trim() || '未知模型';
  const voice = resolveVoiceConfig(settings);
  const asrReady = !!voice.baseUrl && !!voice.apiKey;
  const visionTransport = resolveVisionTransport(settings);
  const hasVisionApi = !!visionTransport.baseUrl && !!visionTransport.apiKey;
  const availableModels = opts.availableModels ?? null;
  const explicitVision = (settings.visionModel ?? '').trim();
  const chatIsVision = isVisionModelName(model);
  const visionRoute = settings.visionRoute === 'chat' || settings.visionRoute === 'custom' ? settings.visionRoute : 'auto';
  const visionName = mode === 'api' && hasVisionApi ? resolveVisionModel(settings, availableModels) : '';
  const visionReady = mode === 'api' && hasVisionApi && !!visionName;
  // 视觉模型可用性的精细状态（用于给不同提示）：
  // 'direct'(聊天模型本身视觉) / 'ok'(有可用视觉模型转述) / 'no-model'(端点明确没有)
  // / 'bad-explicit'(设置里填的视觉模型不在列表) / 'unknown'(列表拉不到)
  let visionState: 'direct' | 'ok' | 'no-model' | 'bad-explicit' | 'unknown' = 'unknown';
  if (chatIsVision && hasVisionApi && visionRoute !== 'custom') visionState = 'direct';
  else if (!hasVisionApi) visionState = 'unknown';
  else if (visionRoute === 'chat' && !chatIsVision) visionState = 'no-model';
  else if (visionRoute === 'custom' && !explicitVision) visionState = 'no-model';
  else if (availableModels && availableModels.length) {
    if (explicitVision && visionRoute !== 'chat') {
      visionState = availableModels.includes(explicitVision) ? 'ok' : 'bad-explicit';
    } else if (availableModels.some((id) => isVisionModelName(id))) visionState = 'ok';
    else visionState = 'no-model';
  } else visionState = 'unknown';
  const visionHint = (): string => {
    if (visionRoute === 'custom' && !explicitVision) {
      return '视觉路由设为「只用指定视觉模型」，但没有填写视觉模型；请补上模型名，或把路由改为自动。';
    }
    if (visionRoute === 'chat' && !chatIsVision) {
      return `视觉路由设为「聊天模型直读」，但聊天模型「${model}」不像视觉模型；请换视觉模型或把路由改为自动。`;
    }
    if (visionState === 'bad-explicit') {
      return `设置里的视觉模型「${explicitVision}」不在该端点的模型列表里：请检查名字，或改用支持的图片模型 / 桥接 DSH（DSH 能直接看图）。`;
    }
    if (visionState === 'no-model') {
      return '当前 API 端点没有可用的视觉模型，图片发不出去。可以：①把 AI 模型换成支持图片的型号 ②在设置里填写一个可用的视觉模型 ③改用「桥接 DSH」（DSH 能直接看图）。';
    }
    if (visionState === 'unknown') {
      return '没有可用的视觉模型：请确认 API 地址/Key，或在设置里填写「视觉模型」（如 qwen3-vl-plus），也可改用「桥接 DSH」。';
    }
    return '';
  };
  const items: MediaCheckItem[] = [];
  const notes: string[] = [];

  if (attachments.length > MAX_ATTACHMENTS) {
    return {
      ok: false,
      mode,
      model,
      items: [],
      summary: `一条消息最多 ${MAX_ATTACHMENTS} 个附件，请分批发送。`,
    };
  }
  const totalBytes = attachments.reduce((sum, a) => sum + Math.max(0, a.size), 0);
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      mode,
      model,
      items: [],
      summary: `附件合计超过 ${Math.round(MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024)}MB，请分批发送。`,
    };
  }

  for (const att of attachments) {
    const sizeErr = attachmentSizeError(att);
    if (sizeErr) {
      items.push({ attachment: att, status: 'unsupported', route: '—', hint: sizeErr });
      continue;
    }
    if (att.kind === 'image') {
      if (mode === 'dsh') {
        items.push({ attachment: att, status: 'ok', route: dshImageRoute() });
      } else if (visionState === 'direct') {
        items.push({ attachment: att, status: 'ok', route: '直接发送给视觉模型' });
      } else if (visionState === 'ok') {
        items.push({
          attachment: att,
          status: 'converted',
          route: `视觉模型转述（${visionName}）`,
          hint: `当前模型「${model}」不支持图片，会先用视觉模型「${visionName}」识别图片内容再发给它。`,
        });
      } else if (visionReady && visionState === 'unknown') {
        // 列表拉不到（unknown）但配置看起来可用：乐观放行，失败时给可读错误
        items.push({
          attachment: att,
          status: 'converted',
          route: `视觉模型转述（${visionName}）`,
          hint: `当前模型「${model}」不支持图片，会尝试用视觉模型「${visionName}」识别（未能从 /models 确认其可用性）。`,
        });
      } else {
        items.push({ attachment: att, status: 'unsupported', route: '—', hint: visionHint() });
      }
      continue;
    }
    if (att.kind === 'audio') {
      if (asrReady) {
        items.push({ attachment: att, status: 'converted', route: 'ASR 转写成文字', hint: '语音会先转成文字再发给 AI。' });
      } else {
        items.push({
          attachment: att,
          status: 'unsupported',
          route: '—',
          hint: '语音识别未配置（需要语音 API 地址/Key，可在设置里填语音接口，留空会复用聊天 API）。',
        });
      }
      continue;
    }
    if (att.kind === 'text') {
      items.push({ attachment: att, status: 'ok', route: '内联文本' });
      continue;
    }
    items.push({
      attachment: att,
      status: 'ok',
      route: mode === 'dsh' ? '复制到桥接目录，给路径让 DSH 读取' : '本地路径（模型可用工具读取）',
    });
  }

  const unsupported = items.filter((i) => i.status === 'unsupported');
  const converted = items.filter((i) => i.status === 'converted');
  if (converted.length) {
    notes.push(
      ...converted
        .map((i) => i.hint)
        .filter((h): h is string => !!h)
        .slice(0, 3),
    );
  }
  const ok = unsupported.length === 0;
  const summary = ok
    ? converted.length
      ? notes.join(' ')
      : ''
    : unsupported
        .map((i) => `「${i.attachment.name}」：${i.hint ?? '不支持'}`)
        .join('；');
  return { ok, mode, model, items, summary };
}

/** 异步兼容性检查（IPC 用）：先探测 /models 判断视觉模型是否真的可用；探测失败回退乐观策略。 */
export async function checkMediaCompatibility(
  settings: AppSettings,
  attachments: AttachmentRef[],
): Promise<MediaCheckResult> {
  const mode: 'api' | 'dsh' = settings.aiMode === 'dsh' ? 'dsh' : 'api';
  const needsVision = mode === 'api' && attachments.some((a) => a.kind === 'image');
  if (!needsVision) return checkMediaCompatibilityCore(settings, attachments);
  const vision = resolveVisionTransport(settings);
  const models = await fetchModelIds(settings, 8000, vision);
  return checkMediaCompatibilityCore(settings, attachments, { availableModels: models.ok ? models.ids : null });
}

// ------------------------------------------------------------------ 视觉转述 / ASR

function completionsUrl(baseUrl: string): string {
  let url = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!/\/chat\/completions$/i.test(url)) url += '/chat/completions';
  return url;
}

function readFileBase64(filePath: string, maxBytes: number): string | null {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > maxBytes) return null;
    return fs.readFileSync(filePath).toString('base64');
  } catch {
    return null;
  }
}

/** 用视觉模型描述一批图片（返回每张图的描述；失败抛出可读错误）。 */
export async function describeImages(
  settings: AppSettings,
  images: Array<{ path: string; name: string; mime: string }>,
): Promise<string[]> {
  const transport = resolveVisionTransport(settings);
  const baseUrl = transport.baseUrl;
  const apiKey = transport.apiKey;
  if (!baseUrl || !apiKey) throw new Error('未配置视觉识别地址/Key（可在设置里填视觉专用配置，留空会复用聊天 API）');
  const model = resolveVisionModel(settings);
  if (!model) throw new Error('视觉路由没有解析出可用的视觉模型，请检查「视觉模型」/「视觉路由」设置');
  const results: string[] = [];
  for (const img of images) {
    const mime = img.mime || mimeForName(img.name) || 'image/png';
    const b64 = readFileBase64(img.path, MAX_IMAGE_BYTES);
    if (!b64) throw new Error(`读取图片失败或超过大小限制：${img.name}`);
    const body = {
      model,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请用中文详细描述这张图片；如果图片里有文字，请逐字转写出来（OCR）。只输出描述内容，不要客套。',
            },
            { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } },
          ],
        },
      ],
      max_tokens: 900,
      temperature: 0.1,
    };
    let res: Response;
    try {
      res = await fetch(completionsUrl(baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`视觉模型请求失败：${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`视觉模型返回 HTTP ${res.status}：${text.slice(0, 300)}`);
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error('视觉模型返回内容无法解析');
    }
    const p = payload as { choices?: Array<{ message?: { content?: unknown } }> };
    const content = p.choices?.[0]?.message?.content;
    const desc =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text?: unknown }).text ?? '') : ''))
              .join('\n')
          : '';
    if (!desc.trim()) throw new Error('视觉模型没有返回图片描述');
    results.push(desc.trim().slice(0, MAX_IMAGE_DESCRIPTION_CHARS));
  }
  return results;
}

/** 用 ASR 转写音频附件（失败抛出可读错误）。 */
export async function transcribeAudioAttachments(settings: AppSettings, audio: AttachmentRef[]): Promise<string[]> {
  const voice = resolveVoiceConfig(settings);
  if (!voice.baseUrl) throw new Error('未配置语音识别地址（可在设置里填语音接口，留空会复用聊天 API）');
  if (!voice.apiKey) throw new Error('未配置语音识别 Key（可在设置里填语音接口，留空会复用聊天 API）');
  const out: string[] = [];
  for (const att of audio) {
    let bytes: Buffer;
    try {
      const st = fs.statSync(att.path);
      if (st.size > MAX_AUDIO_BYTES_LIMIT) throw new Error('超过 20MB');
      bytes = fs.readFileSync(att.path);
    } catch (err) {
      throw new Error(`读取音频失败：${att.name}（${(err as Error).message}）`);
    }
    const result = await transcribeAudio({
      baseUrl: voice.baseUrl,
      apiKey: voice.apiKey,
      model: voice.model,
      bytes: new Uint8Array(bytes),
      mime: att.mime || mimeForName(att.name),
      timeoutMs: 60000,
    });
    if (!result.ok || !result.text.trim()) throw new Error(result.error || `语音转写失败：${att.name}`);
    out.push(result.text.trim());
  }
  return out;
}

// ------------------------------------------------------------------ 发送前准备（两种模式）

export interface PreparedAttachments {
  /** 拼进对话的文本（原消息 + 附件说明/转写） */
  promptText: string;
  /** 不兼容/转换失败时的错误（存在时不要发送，直接提示用户） */
  blockedError?: string;
}

function readTextInline(filePath: string, limit = MAX_TEXT_INLINE): string {
  try {
    const raw = fs.readFileSync(filePath);
    const buf = raw.subarray(0, Math.min(raw.length, limit * 3));
    const text = buf.toString('utf8');
    return text.length > limit ? `${text.slice(0, limit)}\n…（已截断，完整文件共 ${raw.length} 字节）` : text;
  } catch (err) {
    return `（读取失败：${(err as Error).message}）`;
  }
}

/** API 模式：构造最终 prompt（图片→视觉转述；音频→ASR；文本→内联；其它→路径）。 */
export async function prepareAttachmentsForApi(
  settings: AppSettings,
  attachments: AttachmentRef[],
): Promise<PreparedAttachments> {
  if (!attachments.length) return { promptText: '' };
  const model = (settings.aiModel ?? '').trim();
  const sections: string[] = [];
  const dirApi = '（可用 read_file 等工具按路径读取；回复时不要臆测内容）';
  try {
    const images = attachments.filter((a) => a.kind === 'image');
    if (images.length) {
      if (isVisionModelName(model)) {
        // 聊天模型本身就是视觉模型：走「视觉转述」也可以，但直接让它看更好——这里仍转述以统一历史与工具循环。
        // （说明：转述由同一模型完成，等价于它看到了图片；好处是工具循环/上下文不引入多模态消息。）
        const descs = await describeImages(settings, images);
        sections.push(`【图片自动识别】\n${descs.map((d, i) => `图${i + 1}（${images[i].name}）：${d}`).join('\n')}`);
      } else {
        const descs = await describeImages(settings, images);
        sections.push(
          `【图片自动识别（当前模型不支持图片，已用 ${resolveVisionModel(settings)} 识别）】\n` +
            descs.map((d, i) => `图${i + 1}（${images[i].name}）：${d}`).join('\n'),
        );
      }
    }
    const audios = attachments.filter((a) => a.kind === 'audio');
    if (audios.length) {
      const texts = await transcribeAudioAttachments(settings, audios);
      sections.push(`【语音转写】\n${texts.map((t, i) => `语音${i + 1}（${audios[i].name}）：${t}`).join('\n')}`);
    }
    const texts = attachments.filter((a) => a.kind === 'text');
    for (const att of texts) {
      sections.push(`【文本文件：${att.name}】\n${readTextInline(att.path)}`);
    }
    const others = attachments.filter((a) => a.kind === 'file');
    if (others.length) {
      sections.push(
        `【文件（本地路径）】\n${others
          .map((a) => `- ${a.name}（${a.path}，${a.size} 字节）`)
          .join('\n')}\n${dirApi}`,
      );
    }
  } catch (err) {
    let message = (err as Error).message ?? String(err);
    if (/HTTP 4\d\d|not found|does not exist|model/i.test(message)) {
      message += '（提示：当前 API 端点可能没有可用的视觉模型——可换支持图片的模型、在设置里填可用视觉模型，或改用「桥接 DSH」直接看图。）';
    }
    return { promptText: '', blockedError: message };
  }
  // 上下文保护：图片 OCR/描述 + 文本内联可能很长，超限截断（避免请求超长/费用激增）。
  const MAX_PROMPT_CHARS = 12000;
  let promptText = sections.join('\n\n');
  if (promptText.length > MAX_PROMPT_CHARS) {
    promptText = `${promptText.slice(0, MAX_PROMPT_CHARS)}\n…（附件内容过长，已截断）`;
  }
  return { promptText };
}

/** DSH 模式：附件全部复制到 bridge/inbox，prompt 里给路径/类型/大小和读取提示；音频先 ASR。 */
export async function prepareAttachmentsForDsh(
  settings: AppSettings,
  bridgeDir: string,
  attachments: AttachmentRef[],
): Promise<PreparedAttachments> {
  if (!attachments.length) return { promptText: '' };
  const inbox = path.join(bridgeDir, 'inbox');
  try {
    fs.mkdirSync(inbox, { recursive: true });
  } catch {
    /* 后面复制会失败并给可读错误 */
  }
  const lines: string[] = ['以下是用户随消息发来的真实附件（路径均可读取，不要忽略；先读取/查看再回答）：'];
  try {
    for (const att of attachments) {
      const dest = path.join(inbox, uniqueCopyName(att.name));
      fs.copyFileSync(att.path, dest);
      const mime = att.mime || mimeForName(att.name);
      const meta = `${mime}，${att.size} 字节`;
      if (att.kind === 'image') {
        let visionNote = '';
        try {
          const [desc] = await describeImages(settings, [{ path: dest, name: att.name, mime }]);
          if (desc) visionNote = `\n  视觉转述：${desc}`;
        } catch (err) {
          visionNote = `\n  （视觉转述不可用：${(err as Error).message}；请优先用 read_image 读取）`;
        }
        lines.push(`- 图片：${dest}（${meta}）。请先用 read_image 工具查看这张图片，再结合图片内容回答；不要凭空猜测。${visionNote}`);
      } else if (att.kind === 'audio') {
        try {
          const texts = await transcribeAudioAttachments(settings, [att]);
          lines.push(`- 音频：${dest}（${meta}）。转写：${texts[0]}`);
        } catch (err) {
          lines.push(`- 音频：${dest}（${meta}）。当前没有可用语音转写（${(err as Error).message}），只能提供文件路径与元数据。`);
        }
      } else if (att.kind === 'text') {
        lines.push(`- 文本文件：${dest}（${meta}）。内容如下：\n${readTextInline(dest)}`);
      } else {
        lines.push(`- 文件：${dest}（${meta}）。如果是 PDF/Office/压缩包/视频等二进制，请用当前可用的文件读取或解析工具；无法读取时如实说明，不要编造内容。`);
      }
    }
  } catch (err) {
    return { promptText: '', blockedError: (err as Error).message };
  }
  return { promptText: `【用户附件】\n${lines.join('\n')}` };
}

/** 给 DSH 的固定约定：需要回发文件时怎么写标记。 */
export const DSH_MEDIA_OUT_INSTRUCTION =
  '【给用户回发文件】如果要把图片/音频/其它文件发给用户，请把文件写到当前工作目录下的 outbox/ 子目录' +
  '（没有就创建），并在最终回复里用 [[send:outbox/文件名]] 标注（可多个）。用户会收到这些文件。';

function uniqueCopyName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_').slice(-120) || 'file';
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${base}`;
}

// ------------------------------------------------------------------ AI 回发媒体

/** 从文件构造媒体卡片（图片/音频带 base64 dataUrl，供聊天里直接显示/播放）。 */
export function mediaPayloadForFile(filePath: string, caption?: string): ChatMediaPayload | null {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile() || st.size > MAX_MEDIA_OUT_BYTES) return null;
    const name = path.basename(filePath);
    const mime = mimeForName(name);
    const kind: ChatMediaPayload['kind'] = classifyAttachment(name, mime) === 'image'
      ? 'image'
      : classifyAttachment(name, mime) === 'audio'
        ? 'audio'
        : 'file';
    let dataUrl: string | undefined;
    if (kind !== 'file' && st.size <= MAX_DATA_URL_BYTES) {
      const b64 = fs.readFileSync(filePath).toString('base64');
      dataUrl = `data:${mime};base64,${b64}`;
    }
    return { kind, name, mime, size: st.size, path: filePath, dataUrl, caption };
  } catch {
    return null;
  }
}

/** 路径是否在目录内（防目录穿越/越权读任意文件）。
 *  优先用 realpath（符号链接/junction 指向目录外时要拒绝）；目标不存在时回退到 resolve 比较。 */
export function isPathInside(dir: string, target: string): boolean {
  try {
    let root = path.resolve(dir);
    let full = path.resolve(target);
    try {
      root = fs.realpathSync(root);
    } catch {
      /* 目录不存在：用 resolve 结果 */
    }
    try {
      full = fs.realpathSync(full);
    } catch {
      /* 文件不存在：用 resolve 结果 */
    }
    const rel = path.relative(root, full);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

/** 解析并校验「可以发送给用户的文件」：必须是普通文件，且 realpath 落在某个白名单目录内。 */
export function resolveSafeSendFile(
  target: string,
  roots: string[],
): { ok: boolean; real?: string; reason?: string } {
  if (!target || typeof target !== 'string') return { ok: false, reason: '路径为空' };
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    return { ok: false, reason: '文件不存在' };
  }
  try {
    if (!fs.statSync(real).isFile()) return { ok: false, reason: '不是普通文件' };
  } catch {
    return { ok: false, reason: '无法读取文件' };
  }
  if (!roots.some((root) => isPathInside(root, real))) {
    return { ok: false, reason: '路径不在允许发送的目录内' };
  }
  return { ok: true, real };
}

/** AI 可回发文件的目录白名单：只给「AI 产出的媒体区 / 用户附件暂存区 / DSH 输出区 / 用户配置的开发工作区」。 */
export function allowedSendRoots(userDataDir: string, devWorkspaceRoot: string, dshBridgeDir: string): string[] {
  return [
    path.join(userDataDir, 'chat-media'),
    path.join(userDataDir, 'uploads'),
    path.join(dshBridgeDir, 'outbox'),
    (devWorkspaceRoot || '').trim(),
  ].filter(Boolean);
}

/** 拒绝发送明显敏感/可执行的文件（即使落在白名单目录里，也避免提示注入把配置密钥发出去）。 */
export function isForbiddenSendFile(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  if (/^(settings|chat-log|mcp|session|memory|token|credentials?)\b/.test(name)) return true;
  if (/\.(exe|bat|cmd|ps1|msi|dll|scr|com|lnk|reg)$/i.test(name)) return true;
  return false;
}

/**
 * 解析 DSH final 文本里的 [[send:相对路径]] 标记：
 *  - 只允许 bridge 目录内的文件；不存在的标记原样保留（并给警告）。
 *  - 返回去掉标记后的文本 + 已校验的绝对路径列表。
 */
export function parseMediaMarkers(
  text: string,
  allowedDir: string,
): { text: string; files: Array<{ path: string; caption?: string }>; warnings: string[] } {
  const warnings: string[] = [];
  const files: Array<{ path: string; caption?: string }> = [];
  const re = /\[\[send:([^\]\n]{1,400})\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1].trim();
    // DSH 可能写 [[send:outbox/x.png]]（相对工作目录）也可能写 [[send:x.png]]（相对 outbox）——两种都接受，
    // 但最终解析目录仍限定 outbox，越权仍然会被 resolveSafeSendFile 拒绝。
    const candidates = path.isAbsolute(raw)
      ? [raw]
      : [path.resolve(allowedDir, raw), path.resolve(allowedDir, raw.replace(/^outbox[\\/]/i, ''))];
    let safe: { ok: boolean; real?: string; reason?: string } = { ok: false, reason: '文件不存在' };
    for (const candidate of candidates) {
      safe = resolveSafeSendFile(candidate, [allowedDir]);
      if (safe.ok) break;
    }
    if (!safe.ok || !safe.real) {
      warnings.push(`${raw}：${safe.reason ?? '不允许发送'}`);
      continue;
    }
    try {
      if (fs.statSync(safe.real).size > MAX_MEDIA_OUT_BYTES) {
        warnings.push(`${raw}：超过 15MB 限制`);
        continue;
      }
    } catch {
      warnings.push(`${raw}：无法读取`);
      continue;
    }
    files.push({ path: safe.real });
  }
  const cleaned = text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: cleaned, files, warnings };
}

/** 附件暂存：把渲染层字节写到 uploads 目录，返回路径（剪贴板图片等没有本地路径时用）。 */
export function stageAttachmentBuffer(
  uploadsDir: string,
  data: ArrayBuffer | Uint8Array,
  name: string,
  mime: string,
): { ok: boolean; path?: string; error?: string } {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
    const buf = data instanceof Uint8Array ? Buffer.from(data) : Buffer.from(new Uint8Array(data));
    if (!buf.length) return { ok: false, error: '附件为空' };
    if (buf.length > MAX_FILE_BYTES) return { ok: false, error: '附件超过 25MB 限制' };
    const safeName = uniqueCopyName(name || `attachment-${Date.now()}`);
    const dest = path.join(uploadsDir, safeName);
    fs.writeFileSync(dest, buf);
    return { ok: true, path: dest };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
