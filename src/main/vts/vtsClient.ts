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

export const DEFAULT_VTS_URL = 'ws://127.0.0.1:8001';
export const VTS_API_NAME = 'VTubeStudioPublicAPI';
export const VTS_API_VERSION = '1.0';

/** 普通请求默认超时 */
const DEFAULT_TIMEOUT_MS = 10_000;
/** 授权默认超时：要等用户去 VTS 点「允许」，10s 根本不够 */
const DEFAULT_AUTH_TIMEOUT_MS = 120_000;

export type VtsLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type VtsLogger = (level: VtsLogLevel, message: string) => void;

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

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  return fallback;
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
   */
  async authenticate(options: { force?: boolean; timeoutMs?: number } = {}): Promise<VtsAuthResult> {
    const timeoutMs = normalizeTimeout(options.timeoutMs, this.authTimeoutMs);

    if (!options.force) {
      const cached = this.readToken();
      if (cached) {
        try {
          const res = await this.request<{ authenticated?: boolean; reason?: string }>(
            'AuthenticationRequest',
            this.authPayload(cached),
            { timeoutMs },
          );
          if (res.authenticated === true) return { authenticated: true, cachedToken: true };
          this.log('warn', `已保存的 token 未通过认证（${res.reason ?? '无原因'}），重新申请授权`);
        } catch (err) {
          this.log('warn', `复用 token 认证失败：${normalizeError(err).message}`);
        }
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

  /** 当前模型的 Live2D 参数列表（VTS 里的参数名与范围） */
  async listParameters(): Promise<VtsParameterInfo[]> {
    const data = await this.request<{ parameters?: unknown }>('Live2DParameterListRequest', {});
    if (!Array.isArray(data.parameters)) return [];
    return data.parameters.filter((item): item is VtsParameterInfo => {
      return !!item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string';
    });
  }
}

export default VtsClient;
