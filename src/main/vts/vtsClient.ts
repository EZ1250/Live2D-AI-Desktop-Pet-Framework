/**
 * vtsClient.ts —— VTube Studio 插件 API（本地 ws://127.0.0.1:8001）客户端
 *
 * 协议要点（VTS 官方 Plugin API 1.0）：
 *   - 一条 WebSocket 连接上跑 JSON 信封：
 *     { apiName: 'VTubeStudioPublicAPI', apiVersion: '1.0', requestID, messageType, data }
 *     响应同信封（带 requestID）；出错时 messageType = 'APIError'，data = { errorID, message }。
 *   - 授权两步：AuthenticationTokenRequest（VTS 弹窗让用户点「允许」）拿到 token，
 *     再用 AuthenticationRequest 换 authenticated:true。token 会持久化，下次直接复用，
 *     不用再点一次允许。
 *
 * 设计约束：
 *   - 纯 Node 模块，**不 import Electron**：以后主进程 / 测试 / 脚本都能直接用。
 *   - 只用一条连接 + requestID→Promise 的映射；每请求独立超时；断线清空 pending。
 *   - **不做自动重连**（用户明确要求）：断了就是断了，由调用方决定要不要再 connect()。
 *   - 不把 token 打进日志。
 *
 * WebSocket 实现：优先用 `ws`（Electron 31 的主进程是 Node 20，没有全局 WebSocket），
 * 拿不到再退回运行时自带的 global WebSocket（Node 22+ / 浏览器）。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';
import type { VtsEventDto } from '../../shared/contracts';

export const DEFAULT_VTS_URL = 'ws://127.0.0.1:8001';
export const VTS_API_NAME = 'VTubeStudioPublicAPI';
export const VTS_API_VERSION = '1.0';

/** VTS 事件名（EventSubscriptionRequest 的 eventName） */
export const VTS_EVENT_HOTKEY_TRIGGERED = 'HotkeyTriggeredEvent';
export const VTS_EVENT_MODEL_LOADED = 'ModelLoadedEvent';

/**
 * 默认订阅的事件。**顺序有意义**：热键事件最要紧，模型加载事件只用于刷新状态。
 * 订阅是幂等的：重复订阅会用新 config 覆盖旧 config，不会收到两份。
 */
export const VTS_SUBSCRIBED_EVENTS: readonly string[] = Object.freeze([
  VTS_EVENT_HOTKEY_TRIGGERED,
  VTS_EVENT_MODEL_LOADED,
] as string[]);

/** 普通请求默认超时 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 授权默认超时：要等用户去 VTS 点「允许」，10s 根本不够 */
const DEFAULT_AUTH_TIMEOUT_MS = 120_000;

export type VtsLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type VtsLogger = (level: VtsLogLevel, message: string) => void;
/** VTS 事件监听器（VtsService 用它把事件转发给主进程 → 渲染层） */
export type VtsEventListener = (event: VtsEventDto) => void;

export interface VtsClientOptions {
  /** 默认 ws://127.0.0.1:8001 */
  url?: string;
  /** 插件显示名（VTS 弹窗里给用户看的名字），默认 Pet */
  clientName?: string;
  /** 插件开发者名，默认 EZ1250 */
  developer?: string;
  /** token 持久化路径；不传则只在内存里（每次都要重新授权） */
  tokenStorePath?: string;
  /** 普通请求超时，默认 10000 */
  timeoutMs?: number;
  /** 授权超时，默认 120000 */
  authTimeoutMs?: number;
  /** 日志回调，默认只把 warn/error 打到 console.warn */
  logger?: VtsLogger;
  /**
   * 可选：替换 WebSocket 实现。默认 ws（Electron 主进程 Node 20 没有全局 WebSocket），
   * 装不了 ws 时自动退回 global WebSocket（Node 22+）；测试用它覆盖两条适配路径。
   */
  webSocketCtor?: new (url: string) => unknown;
}

export interface VtsParameterValue {
  id: string;
  value: number;
  /** 0..1，缺省由 VTS 按 1 处理 */
  weight?: number;
}

export interface VtsCurrentModel {
  modelLoaded?: boolean;
  modelName?: string;
  modelID?: string;
  vtsModelName?: string;
  vtsModelIconName?: string;
  [key: string]: unknown;
}

export interface VtsParameterInfo {
  name: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  [key: string]: unknown;
}

/** 当前模型里的一个热键（HotkeysInCurrentModelRequest 的 availableHotkeys 条目） */
export interface VtsHotkey {
  /** 热键显示名（VTS 里配置的，如「My Animation 1」） */
  name: string;
  /** 触发时用的 ID（32 位十六进制） */
  hotkeyID: string;
  /** 热键类型，如 TriggerAnimation / ToggleExpression / RemoveAllExpressions */
  type: string;
  description?: string;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ 追踪参数 */

/**
 * 逻辑字段名（本项目的叫法）。**不要**用模型参数名（ParamAngleX 之类）去注入：
 * VTS 会以 #453「你想注入的参数不存在」拒绝，必须走它自己的追踪参数，由 VTS 再映射到模型参数。
 */
export type VtsTrackingField =
  | 'faceAngleX'
  | 'faceAngleY'
  | 'faceAngleZ'
  | 'eyeLeftX'
  | 'eyeLeftY'
  | 'eyeRightX'
  | 'eyeRightY'
  | 'mouthOpen';

/** 逻辑字段 → VTS 追踪参数名（实测 VTS 1.35.10 的 InputParameterListRequest 默认参数表里都有） */
export const VTS_TRACKING_PARAMETERS: Readonly<Record<VtsTrackingField, string>> = Object.freeze({
  faceAngleX: 'FaceAngleX',
  faceAngleY: 'FaceAngleY',
  faceAngleZ: 'FaceAngleZ',
  eyeLeftX: 'EyeLeftX',
  eyeLeftY: 'EyeLeftY',
  eyeRightX: 'EyeRightX',
  eyeRightY: 'EyeRightY',
  mouthOpen: 'MouthOpen',
});

/** 字段的取值区间（VTS 参数的 min/max；越界先夹住，别把脏值甩给 VTS） */
export const VTS_TRACKING_RANGES: Readonly<Record<VtsTrackingField, readonly [number, number]>> = Object.freeze({
  faceAngleX: [-30, 30] as const,
  faceAngleY: [-30, 30] as const,
  faceAngleZ: [-90, 90] as const,
  eyeLeftX: [-1, 1] as const,
  eyeLeftY: [-1, 1] as const,
  eyeRightX: [-1, 1] as const,
  eyeRightY: [-1, 1] as const,
  mouthOpen: [0, 1] as const,
});

/** 全部逻辑字段（顺序即注入顺序，方便对比/日志） */
export const VTS_TRACKING_FIELDS: readonly VtsTrackingField[] = Object.freeze([
  'faceAngleX', 'faceAngleY', 'faceAngleZ',
  'eyeLeftX', 'eyeLeftY', 'eyeRightX', 'eyeRightY',
  'mouthOpen',
] as VtsTrackingField[]);

/** 一帧追踪值：**只注入传进来的字段**，没传的保持 VTS 原值 */
export type VtsTrackingValues = Partial<Record<VtsTrackingField, number>>;

export interface VtsAuthResult {
  authenticated: boolean;
  /** true=用的是磁盘上已保存的 token（没有弹授权窗） */
  cachedToken: boolean;
  reason?: string;
}

export interface VtsTokenFile {
  version: 1;
  token: string;
  url: string;
  pluginName: string;
  savedAt: string;
}

/** VTS 回的业务错误（APIError） */
export class VtsApiError extends Error {
  readonly errorID: number | null;
  readonly vtsMessage: string;
  readonly requestMessageType: string;

  constructor(requestMessageType: string, data: Record<string, unknown>) {
    const errorID = typeof data.errorID === 'number' ? data.errorID : null;
    const vtsMessage = typeof data.message === 'string' && data.message ? data.message : '未知错误';
    super(`VTS 返回错误${errorID === null ? '' : ` #${errorID}`}：${vtsMessage}（${requestMessageType}）`);
    this.name = 'VtsApiError';
    this.errorID = errorID;
    this.vtsMessage = vtsMessage;
    this.requestMessageType = requestMessageType;
  }
}

/* ------------------------------------------------------------------ WebSocket 适配层 */

interface SocketLike {
  readyState?: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  addEventListener?: (event: string, listener: (event: unknown) => void) => unknown;
}

type SocketCtor = new (url: string) => SocketLike;

/** 优先 ws（Electron 主进程 Node 20 没有全局 WebSocket），退化到运行时自带实现 */
function resolveSocketCtor(): SocketCtor {
  try {
    const mod = require('ws') as { WebSocket?: SocketCtor; default?: SocketCtor } | SocketCtor;
    const ctor = (mod as { WebSocket?: SocketCtor }).WebSocket
      ?? (mod as { default?: SocketCtor }).default
      ?? mod;
    if (typeof ctor === 'function') return ctor as SocketCtor;
  } catch {
    /* 没装 ws：走下面的全局 WebSocket */
  }
  const globalCtor = (globalThis as { WebSocket?: SocketCtor }).WebSocket;
  if (typeof globalCtor === 'function') return globalCtor;
  throw new Error('没有可用的 WebSocket 实现：Electron 主进程（Node 20）需要安装 ws');
}

/** 各种实现塞进来的 payload → string（ws 给 Buffer，浏览器/undici 给 string 或 MessageEvent） */
function payloadToText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data === null || data === undefined) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('utf8');
  }
  if (typeof data === 'object' && 'data' in (data as Record<string, unknown>)) {
    return payloadToText((data as { data?: unknown }).data);
  }
  return String(data);
}

function normalizeError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err ?? '未知错误'));
}

interface SocketHandlers {
  onOpen: () => void;
  onMessage: (text: string) => void;
  onError: (err: Error) => void;
  onClose: (code: number, reason: string) => void;
}

/** 同时兼容 ws 的 EventEmitter 风格与标准 EventTarget 风格 */
function attachSocket(socket: SocketLike, handlers: SocketHandlers): void {
  if (typeof socket.on === 'function') {
    socket.on('open', () => handlers.onOpen());
    socket.on('message', (data: unknown) => handlers.onMessage(payloadToText(data)));
    socket.on('error', (err: unknown) => handlers.onError(normalizeError(err)));
    socket.on('close', (code: unknown, reason: unknown) => {
      handlers.onClose(typeof code === 'number' ? code : 1006, payloadToText(reason));
    });
    return;
  }
  if (typeof socket.addEventListener !== 'function') {
    throw new Error('WebSocket 实现既没有 on 也没有 addEventListener，无法监听事件');
  }
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: unknown) => handlers.onMessage(payloadToText(event)));
  socket.addEventListener('error', () => handlers.onError(new Error('WebSocket 连接错误')));
  socket.addEventListener('close', (event: unknown) => {
    const ev = (event ?? {}) as { code?: unknown; reason?: unknown };
    handlers.onClose(typeof ev.code === 'number' ? ev.code : 1006, payloadToText(ev.reason));
  });
}

/* ------------------------------------------------------------------ 参数校验 */

/** 校验并规范化注入参数：id 非空、value 有限、weight 0..1（省略则不带 weight） */
export function normalizeParameterValues(values: VtsParameterValue[]): VtsParameterValue[] {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('injectParameters 需要非空的 parameterValues 数组');
  }
  return values.map((item, index) => {
    if (!item || typeof item !== 'object') throw new TypeError(`parameterValues[${index}] 不是对象`);
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new TypeError(`parameterValues[${index}].id 必须是非空字符串`);
    if (typeof item.value !== 'number' || !Number.isFinite(item.value)) {
      throw new TypeError(`parameterValues[${index}].value 必须是有限数字`);
    }
    const normalized: VtsParameterValue = { id, value: item.value };
    if (item.weight !== undefined) {
      if (typeof item.weight !== 'number' || !Number.isFinite(item.weight)) {
        throw new TypeError(`parameterValues[${index}].weight 必须是有限数字`);
      }
      if (item.weight < 0 || item.weight > 1) {
        throw new RangeError(`parameterValues[${index}].weight 必须在 0..1 之间（收到 ${item.weight}）`);
      }
      normalized.weight = item.weight;
    }
    return normalized;
  });
}

function isTrackingField(key: string): key is VtsTrackingField {
  return (VTS_TRACKING_FIELDS as readonly string[]).includes(key);
}

/**
 * 收窄并夹取一帧追踪值：只留已知字段、只留有限数字、按 VTS 参数区间夹住。
 * 非对象/空对象返回 {}（调用方据此判断"这帧没有可注入的东西"）。
 */
export function normalizeTrackingValues(values: unknown): VtsTrackingValues {
  const out: VtsTrackingValues = {};
  if (!values || typeof values !== 'object') return out;
  for (const [key, raw] of Object.entries(values as Record<string, unknown>)) {
    if (!isTrackingField(key)) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const [min, max] = VTS_TRACKING_RANGES[key];
    out[key] = Math.max(min, Math.min(max, raw));
  }
  return out;
}

/** 逻辑追踪值 → VTS parameterValues（只含传进来的字段；空对象 → []） */
export function trackingToParameterValues(values: VtsTrackingValues | unknown): VtsParameterValue[] {
  const normalized = normalizeTrackingValues(values);
  const list: VtsParameterValue[] = [];
  for (const field of VTS_TRACKING_FIELDS) {
    const value = normalized[field];
    if (typeof value !== 'number') continue;
    list.push({ id: VTS_TRACKING_PARAMETERS[field], value });
  }
  return list;
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
}

/* ------------------------------------------------------------------ 事件解析 */

function textField(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把 VTS 发来的事件消息（`messageType` + `data`）收窄成 `VtsEventDto`。
 *
 * 实测/文档（Events/README.md）里的载荷：
 *   - `HotkeyTriggeredEvent` → { hotkeyID, hotkeyName, hotkeyAction, hotkeyTriggeredByAPI, modelID, modelName, … }
 *   - `ModelLoadedEvent`    → { modelLoaded, modelName, modelID }
 * 不认识的 messageType / 脏数据返回 null（调用方保持"无主消息"的处理方式）。
 * 事件消息不保证带 requestID（VTS 事件通常是空串），所以这里**不看 requestID**。
 */
export function parseVtsEvent(
  messageType: unknown,
  data: unknown,
  at: string = new Date().toISOString(),
): VtsEventDto | null {
  const type = typeof messageType === 'string' ? messageType : '';
  const payload = data && typeof data === 'object' ? data as Record<string, unknown> : {};
  if (type === VTS_EVENT_HOTKEY_TRIGGERED) {
    const hotkeyID = textField(payload, 'hotkeyID');
    const hotkeyName = textField(payload, 'hotkeyName');
    // 名字和 ID 都没有 → 不是可用事件（本地按名字匹配，没名字也做不了什么）
    if (!hotkeyID && !hotkeyName) return null;
    return {
      kind: 'hotkeyTriggered',
      hotkeyID,
      hotkeyName,
      hotkeyAction: textField(payload, 'hotkeyAction'),
      hotkeyTriggeredByAPI: payload.hotkeyTriggeredByAPI === true,
      modelID: textField(payload, 'modelID'),
      modelName: textField(payload, 'modelName'),
      at,
    };
  }
  if (type === VTS_EVENT_MODEL_LOADED) {
    return {
      kind: 'modelLoaded',
      modelLoaded: payload.modelLoaded === true,
      modelName: textField(payload, 'modelName'),
      modelID: textField(payload, 'modelID'),
      at,
    };
  }
  return null;
}

const defaultLogger: VtsLogger = (level, message) => {
  if (level === 'warn' || level === 'error') console.warn(`[vts] ${message}`);
};

/* ------------------------------------------------------------------ 客户端 */

interface PendingRequest {
  resolve: (data: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  messageType: string;
  startedAt: number;
}

export class VtsClient {
  readonly url: string;
  readonly clientName: string;
  readonly developer: string;

  private readonly tokenStorePath: string | undefined;
  private readonly timeoutMs: number;
  private readonly authTimeoutMs: number;
  private readonly log: VtsLogger;
  private readonly customSocketCtor: SocketCtor | null;

  private socket: SocketLike | null = null;
  private connected = false;
  private connecting: Promise<void> | null = null;
  private requestSeq = 0;
  private readonly pending = new Map<string, PendingRequest>();
  /** 事件订阅者（VtsService 一个；测试可挂多个） */
  private readonly eventListeners = new Set<VtsEventListener>();

  constructor(options: VtsClientOptions = {}) {
    const url = typeof options.url === 'string' && options.url.trim() ? options.url.trim() : DEFAULT_VTS_URL;
    if (!/^wss?:\/\//i.test(url)) throw new TypeError(`VTS url 必须是 ws:// 或 wss:// 开头（收到 ${url}）`);
    this.url = url;
    this.clientName = typeof options.clientName === 'string' && options.clientName.trim()
      ? options.clientName.trim()
      : 'Pet';
    this.developer = typeof options.developer === 'string' && options.developer.trim()
      ? options.developer.trim()
      : 'EZ1250';
    this.tokenStorePath = typeof options.tokenStorePath === 'string' && options.tokenStorePath.trim()
      ? options.tokenStorePath
      : undefined;
    this.timeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_TIMEOUT_MS);
    this.authTimeoutMs = normalizeTimeout(options.authTimeoutMs, DEFAULT_AUTH_TIMEOUT_MS);
    this.log = typeof options.logger === 'function' ? options.logger : defaultLogger;
    this.customSocketCtor = typeof options.webSocketCtor === 'function'
      ? options.webSocketCtor as SocketCtor
      : null;
  }

  /** 连接是否真的可用（不是「曾经连过」） */
  get isConnected(): boolean {
    return this.connected && this.socket !== null;
  }

  /** 目前挂着的未完成请求数（测试/诊断用） */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * 订阅 VTS 事件（`EventSubscriptionRequest` 之后 VTS 主动发来的消息）。
   * 返回取消订阅函数；同一个回调重复挂只会收到一次。
   */
  onEvent(listener: VtsEventListener): () => void {
    if (typeof listener !== 'function') throw new TypeError('onEvent 需要回调函数');
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** 目前挂着的事件监听器数量（测试/诊断用） */
  get eventListenerCount(): number {
    return this.eventListeners.size;
  }

  /** 建连；重复调用幂等。不做自动重连——断了要调用方自己再 connect()。 */
  async connect(): Promise<void> {
    if (this.isConnected) return;
    if (this.connecting) return this.connecting;
    const task = this.openSocket();
    this.connecting = task;
    try {
      await task;
    } finally {
      if (this.connecting === task) this.connecting = null;
    }
  }

  private openSocket(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let socket: SocketLike;
      try {
        socket = new (this.customSocketCtor ?? resolveSocketCtor())(this.url);
      } catch (err) {
        reject(new Error(`VTS 连接失败：${normalizeError(err).message}`));
        return;
      }
      this.socket = socket;

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        this.teardown();
        reject(err);
      };

      attachSocket(socket, {
        onOpen: () => {
          if (settled) return;
          settled = true;
          this.connected = true;
          this.log('info', `已连接 ${this.url}`);
          resolve();
        },
        onMessage: (text) => this.handleMessage(text),
        onError: (err) => {
          if (!settled) {
            fail(new Error(`VTS 连接失败：${err.message}`));
            return;
          }
          this.log('warn', `连接出错：${err.message}`);
          this.connected = false;
          this.failPending(new Error(`VTS 连接出错：${err.message}`));
        },
        onClose: (code, reason) => {
          this.connected = false;
          const suffix = reason ? `，${reason}` : '';
          this.failPending(new Error(`VTS 连接已断开（code=${code}${suffix}）`));
          fail(new Error(`VTS 连接在建立前被关闭（code=${code}${suffix}）`));
        },
      });
    });
  }

  /** 主动断开：清 pending、置 isConnected=false。已关的连接再断不报错。 */
  disconnect(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.failPending(new Error('VTS 连接已断开'));
    if (!socket) return;
    try {
      socket.close(1000, 'client disconnect');
    } catch {
      /* 已经关了 */
    }
  }

  /**
   * 发一个请求并等响应。
   * @throws VtsApiError VTS 回 APIError
   * @throws Error 超时 / 未连接 / 连接断开
   */
  async request<T = Record<string, unknown>>(
    messageType: string,
    data: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.socket || !this.connected) throw new Error('VTS 未连接：先调用 connect()');
    if (typeof messageType !== 'string' || !messageType.trim()) throw new TypeError('VTS 请求缺少 messageType');
    const timeoutMs = normalizeTimeout(options.timeoutMs, this.timeoutMs);
    this.requestSeq += 1;
    const requestID = `pet-${Date.now().toString(36)}-${this.requestSeq}-${randomUUID().slice(0, 8)}`;
    const payload = {
      apiName: VTS_API_NAME,
      apiVersion: VTS_API_VERSION,
      requestID,
      messageType,
      data,
    };
    const socket = this.socket;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestID)) return;
        reject(new Error(`VTS 请求超时（${messageType}，${timeoutMs}ms）`));
      }, timeoutMs);
      // 别让定时器拖住进程退出（Electron 退出时尤其重要）
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(requestID, {
        resolve: resolve as (value: Record<string, unknown>) => void,
        reject,
        timer,
        messageType,
        startedAt: Date.now(),
      });
      try {
        socket.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(requestID);
        clearTimeout(timer);
        reject(new Error(`VTS 请求发送失败：${normalizeError(err).message}`));
      }
    });
  }

  private handleMessage(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.log('warn', `收到非 JSON 消息，已忽略：${text.slice(0, 120)}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      this.log('warn', '收到空消息，已忽略');
      return;
    }
    const message = parsed as { requestID?: unknown; messageType?: unknown; data?: unknown };
    // 事件消息没有对应的 pending 请求（requestID 常常是空串），必须在"无主消息"判断**之前**处理，
    // 否则订阅到的事件会被当成无主消息整条丢掉（表现为"VTS 里点了热键，桌宠毫无反应"）。
    const event = parseVtsEvent(message.messageType, message.data);
    if (event) {
      this.log('debug', `收到 VTS 事件 ${String(message.messageType)}${event.kind === 'hotkeyTriggered' ? `（${event.hotkeyName}）` : ''}`);
      this.dispatchEvent(event);
      return;
    }
    const requestID = typeof message.requestID === 'string' ? message.requestID : '';
    const entry = requestID ? this.pending.get(requestID) : undefined;
    if (!entry) {
      this.log('debug', `收到无主消息（requestID=${requestID || '空'}，type=${String(message.messageType)}），已忽略`);
      return;
    }
    this.pending.delete(requestID);
    clearTimeout(entry.timer);
    const data = message.data && typeof message.data === 'object'
      ? message.data as Record<string, unknown>
      : {};
    if (message.messageType === 'APIError') {
      this.log('warn', `VTS 错误响应：${entry.messageType} #${String(data.errorID ?? '?')} ${String(data.message ?? '')}`);
      entry.reject(new VtsApiError(entry.messageType, data));
      return;
    }
    this.log('debug', `${entry.messageType} 完成（${Date.now() - entry.startedAt}ms）`);
    entry.resolve(data);
  }

  private failPending(err: Error): void {
    if (this.pending.size === 0) return;
    const entries = Array.from(this.pending.values());
    this.pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
  }

  /** 分发一条事件；单个监听器抛错不能打断其它监听器（更不能打断 socket 的读循环） */
  private dispatchEvent(event: VtsEventDto): void {
    if (this.eventListeners.size === 0) return;
    for (const listener of Array.from(this.eventListeners)) {
      try {
        listener(event);
      } catch (err) {
        this.log('warn', `VTS 事件监听器抛错：${normalizeError(err).message}`);
      }
    }
  }

  private teardown(): void {
    const socket = this.socket;
    this.socket = null;
    this.connected = false;
    this.failPending(new Error('VTS 连接已断开'));
    if (!socket) return;
    try {
      socket.close(1000, 'teardown');
    } catch {
      /* 已经关了 */
    }
  }

  /* ---------------------------------------------------------------- 授权 */

  /**
   * 授权。
   *  - 有保存过的 token：先拿它试 AuthenticationRequest；成功就直接返回、不弹窗；
   *  - 没有/失效：AuthenticationTokenRequest（VTS 弹窗等用户点允许）→ AuthenticationRequest →
   *    成功后把 token 落盘（tokenStorePath 存在时）。
   * @param options.force true=跳过缓存token，重新走一遍授权弹窗
   * @param options.cachedOnly true=只用磁盘上已保存的 token，没有/失效就抛错
   *        （应用启动时用：**绝不能在用户没点"授权"的时候弹 VTS 授权窗**）
   */
  async authenticate(options: { force?: boolean; timeoutMs?: number; cachedOnly?: boolean } = {}): Promise<VtsAuthResult> {
    const timeoutMs = normalizeTimeout(options.timeoutMs, this.authTimeoutMs);
    const cached = options.force ? null : this.readToken();
    if (options.cachedOnly === true && !cached) {
      throw new Error('没有可用的 VTS token：请在设置页点「授权」让 VTS 弹窗确认一次');
    }

    if (cached) {
      try {
        const res = await this.request<{ authenticated?: boolean; reason?: string }>(
          'AuthenticationRequest',
          this.authPayload(cached),
          { timeoutMs },
        );
        if (res.authenticated === true) return { authenticated: true, cachedToken: true };
        const reason = typeof res.reason === 'string' && res.reason ? res.reason : '无原因';
        if (options.cachedOnly === true) throw new Error(`已保存的 VTS token 未通过认证：${reason}`);
        this.log('warn', `已保存的 token 未通过认证（${reason}），重新申请授权`);
      } catch (err) {
        if (options.cachedOnly === true) throw normalizeError(err);
        this.log('warn', `复用 token 认证失败：${normalizeError(err).message}`);
      }
    }

    const tokenRes = await this.request<{ authenticationToken?: string }>(
      'AuthenticationTokenRequest',
      { pluginName: this.clientName, pluginDeveloper: this.developer },
      { timeoutMs },
    );
    const token = typeof tokenRes.authenticationToken === 'string' ? tokenRes.authenticationToken : '';
    if (!token) throw new Error('VTS 没有返回 authenticationToken（用户可能拒绝了授权）');

    const authRes = await this.request<{ authenticated?: boolean; reason?: string }>(
      'AuthenticationRequest',
      this.authPayload(token),
      { timeoutMs },
    );
    if (authRes.authenticated !== true) {
      const reason = typeof authRes.reason === 'string' && authRes.reason ? authRes.reason : '用户可能点了拒绝';
      throw new Error(`VTS 授权未通过：${reason}`);
    }
    this.writeToken(token);
    return { authenticated: true, cachedToken: false };
  }

  private authPayload(token: string): Record<string, unknown> {
    return {
      pluginName: this.clientName,
      pluginDeveloper: this.developer,
      authenticationToken: token,
      faceFound: true,
    };
  }

  /** 磁盘上是否已有可复用的 token（不读 token 内容给外部，只回答"有没有"） */
  hasCachedToken(): boolean {
    return this.readToken() !== null;
  }

  private readToken(): string | null {
    if (!this.tokenStorePath) return null;
    try {
      const raw = fs.readFileSync(this.tokenStorePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VtsTokenFile>;
      if (parsed && typeof parsed.token === 'string' && parsed.token) return parsed.token;
      this.log('warn', `token 文件格式不对，忽略：${this.tokenStorePath}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.log('warn', `读取 token 失败：${normalizeError(err).message}`);
    }
    return null;
  }

  private writeToken(token: string): void {
    if (!this.tokenStorePath) return;
    try {
      fs.mkdirSync(path.dirname(this.tokenStorePath), { recursive: true });
      const file: VtsTokenFile = {
        version: 1,
        token,
        url: this.url,
        pluginName: this.clientName,
        savedAt: new Date().toISOString(),
      };
      fs.writeFileSync(this.tokenStorePath, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      this.log('info', `token 已保存：${this.tokenStorePath}`);
    } catch (err) {
      this.log('warn', `保存 token 失败：${normalizeError(err).message}`);
    }
  }

  /** 删除已保存的 token（撤销/排障用） */
  clearToken(): void {
    if (!this.tokenStorePath) return;
    try {
      fs.rmSync(this.tokenStorePath, { force: true });
    } catch (err) {
      this.log('warn', `删除 token 失败：${normalizeError(err).message}`);
    }
  }

  /* ---------------------------------------------------------------- 业务方法 */

  /**
   * 注入参数（表情/嘴型/眨眼等）。
   * @param parameterValues [{ id, value, weight? }]
   * @param faceFound 摄像头是否找到人脸（不填 true：桌宠场景通常没人脸追踪）
   * @param mode 'set'（默认，直接赋值）| 'add'（在现有值上叠加）
   */
  async injectParameters(
    parameterValues: VtsParameterValue[],
    faceFound = true,
    mode: 'set' | 'add' = 'set',
  ): Promise<Record<string, unknown>> {
    if (mode !== 'set' && mode !== 'add') throw new TypeError(`injectParameters 的 mode 只能是 set/add（收到 ${String(mode)}）`);
    const parameterList = normalizeParameterValues(parameterValues);
    return this.request('InjectParameterDataRequest', {
      faceFound: faceFound !== false,
      mode,
      parameterValues: parameterList,
    });
  }

  /** 触发热键（按 VTS 里配置的 Hotkey ID） */
  async triggerHotkey(hotkeyID: string): Promise<Record<string, unknown>> {
    const id = typeof hotkeyID === 'string' ? hotkeyID.trim() : '';
    if (!id) throw new TypeError('triggerHotkey 需要非空的 hotkeyID');
    return this.request('HotkeyTriggerRequest', { hotkeyID: id });
  }

  /** 当前加载的模型 */
  async getModel(): Promise<VtsCurrentModel> {
    return this.request<VtsCurrentModel>('CurrentModelRequest', {});
  }

  /**
   * 订阅 VTS 事件（默认 `HotkeyTriggeredEvent` + `ModelLoadedEvent`）。
   *
   * 返回 VTS 确认订阅成功的事件名列表。单个事件订阅失败只记 warn、不抛错：
   * 反向同步是"锦上添花"，不能因为它把已成功的连接/授权搞成失败状态。
   * 订阅会在下次连接时随新会话重新建立（VTS 断线会清空该插件的订阅）。
   */
  async subscribeEvents(eventNames: readonly string[] = VTS_SUBSCRIBED_EVENTS): Promise<string[]> {
    if (!this.socket || !this.connected) throw new Error('VTS 未连接：先调用 connect()');
    const wanted = Array.from(new Set(
      (Array.isArray(eventNames) ? eventNames : [])
        .filter((name): name is string => typeof name === 'string')
        .map((name) => name.trim())
        .filter(Boolean),
    ));
    if (wanted.length === 0) throw new TypeError('subscribeEvents 至少需要一个事件名');
    const subscribed: string[] = [];
    for (const eventName of wanted) {
      try {
        const res = await this.request<{ subscribedEvents?: unknown }>('EventSubscriptionRequest', {
          eventName,
          subscribe: true,
          config: {},
        });
        const confirmed = Array.isArray(res.subscribedEvents)
          ? res.subscribedEvents.filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
          : [eventName];
        for (const name of confirmed) {
          if (!subscribed.includes(name)) subscribed.push(name);
        }
      } catch (err) {
        this.log('warn', `订阅 VTS 事件 ${eventName} 失败：${normalizeError(err).message}`);
      }
    }
    return subscribed;
  }

  /** 当前模型的 Live2D 参数列表（VTS 里的参数名与范围） */
  async listParameters(): Promise<VtsParameterInfo[]> {
    const data = await this.request<{ parameters?: unknown }>('Live2DParameterListRequest', {});
    if (!Array.isArray(data.parameters)) return [];
    return data.parameters.filter((item): item is VtsParameterInfo => {
      return !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string';
    });
  }

  /**
   * 当前模型的热键列表。
   *
   * 实测（VTS 1.35.10）：官方叫 **HotkeysInCurrentModelRequest**，响应里的
   * `availableHotkeys` 才是 {name, hotkeyID, type}；发 `HotkeyListRequest` 会直接
   * 回 APIError #7「Unknown messageType」。为了兼容将来可能改名的服务端，
   * 这里按顺序试两个消息类型，只有"未知消息类型"才换下一个，别的错误照常抛。
   */
  async listHotkeys(): Promise<VtsHotkey[]> {
    let data: Record<string, unknown> | null = null;
    let lastErr: Error | null = null;
    for (const messageType of HOTKEY_LIST_MESSAGE_TYPES) {
      try {
        data = await this.request<Record<string, unknown>>(messageType, {});
        lastErr = null;
        break;
      } catch (err) {
        const normalized = normalizeError(err);
        if (!isUnknownMessageType(normalized)) throw normalized;
        lastErr = normalized;
        this.log('warn', `VTS 不支持 ${messageType}，换下一个候选：${normalized.message}`);
      }
    }
    if (!data) throw lastErr ?? new Error('VTS 热键列表请求失败');
    return parseHotkeyList(data);
  }

  /**
   * 按热键名触发热键。名字先精确匹配、再忽略大小写匹配。
   * @throws Error 名字为空 / 模型没有热键 / 找不到这个名字（错误里列出可用热键）
   */
  async triggerHotkeyByName(name: string): Promise<Record<string, unknown>> {
    const wanted = typeof name === 'string' ? name.trim() : '';
    if (!wanted) throw new TypeError('triggerHotkeyByName 需要非空的热键名');
    const hotkeys = await this.listHotkeys();
    if (!hotkeys.length) {
      throw new Error('当前 VTS 模型没有热键；先在 VTube Studio 里给模型的动捕/表情配一个热键');
    }
    const lower = wanted.toLowerCase();
    const found = hotkeys.find((item) => item.name === wanted)
      ?? hotkeys.find((item) => item.name.toLowerCase() === lower);
    if (!found) {
      const names = hotkeys.slice(0, 12).map((item) => item.name).join('、');
      throw new Error(
        `VTS 热键里没有「${wanted}」；当前模型共 ${hotkeys.length} 个可用热键：${names}${hotkeys.length > 12 ? '…' : ''}`,
      );
    }
    return this.triggerHotkey(found.hotkeyID);
  }

  /**
   * 注入一帧**追踪参数**（FaceAngleX / EyeLeftX / MouthOpen …，VTS 自己映射到模型参数）。
   * 默认只注入传进来的字段；没有已知字段时抛 TypeError（调用方自己决定要不要为空时跳过）。
   */
  async injectTracking(
    values: VtsTrackingValues,
    options: { faceFound?: boolean; mode?: 'set' | 'add' } = {},
  ): Promise<Record<string, unknown>> {
    const parameterValues = trackingToParameterValues(values);
    if (!parameterValues.length) {
      throw new TypeError(`injectTracking 至少需要一个追踪字段（${VTS_TRACKING_FIELDS.join('/')}）`);
    }
    return this.injectParameters(parameterValues, options.faceFound !== false, options.mode ?? 'set');
  }
}

/* ------------------------------------------------------------------ 热键列表解析 */

/** 热键列表候选消息类型（官方实测顺序在前） */
const HOTKEY_LIST_MESSAGE_TYPES = ['HotkeysInCurrentModelRequest', 'HotkeyListRequest'] as const;

/** VTS 回「未知消息类型」（errorID #7）时才算"这条消息类型不被支持" */
function isUnknownMessageType(err: Error): boolean {
  if (err instanceof VtsApiError) {
    if (err.errorID === 7) return true;
    return /unknown message ?type/i.test(err.vtsMessage);
  }
  return false;
}

/** 从响应里取 {name, hotkeyID, type}（不同版本字段名可能不同，都试一遍） */
export function parseHotkeyList(data: Record<string, unknown> | null | undefined): VtsHotkey[] {
  if (!data || typeof data !== 'object') return [];
  const raw = Array.isArray(data.availableHotkeys)
    ? data.availableHotkeys
    : Array.isArray(data.hotkeys)
      ? data.hotkeys
      : Array.isArray(data.hotkeyList)
        ? data.hotkeyList
        : [];
  const list: VtsHotkey[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const hotkeyID = typeof entry.hotkeyID === 'string' ? entry.hotkeyID.trim() : '';
    if (!name || !hotkeyID) continue;
    list.push({
      ...entry,
      name,
      hotkeyID,
      type: typeof entry.type === 'string' ? entry.type : '',
    });
  }
  return list;
}

export default VtsClient;
