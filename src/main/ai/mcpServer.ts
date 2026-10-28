/** MCP 服务端：在本机回环地址暴露桌宠工具。 */
import * as fs from 'fs';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';
import type { Duplex } from 'stream';

const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_PORT = 37653;
const MAX_BODY_BYTES = 1024 * 1024;

export interface PetMcpServerDeps {
  /** 气泡说话；返回给外部调用方的人类可读结果 */
  say(text: string): string;
  emotion(name: string): string;
  motion(group: string): string;
  status(): string;
  todoAdd(text: string): string;
  todoList(): string;
  screenshot(): Promise<{ base64: string; savedPath: string }>;
  /** 让桌宠 AI 回一句（外部桥接/转述用）。会消耗模型额度，main 侧负责串行与限流。 */
  chat(prompt: string): Promise<string>;
  /** 通过桌宠向用户提问并等待回答（外部自动化确认用）。 */
  ask(question: string, options: string[]): Promise<string>;
  noteAdd(text: string): string;
  reminderAdd(text: string, afterMinutes: number): string;
  /** 只读资源清单与读取（pet://…） */
  resourceList(): Array<{ uri: string; name: string; description?: string }>;
  resourceRead(uri: string): string | null;
  /** 抓一帧桌宠窗口（手机 Live2D 头像用），返回 PNG base64 */
  avatarFrame?(maxWidth?: number): Promise<{ data: string; width: number; height: number }>;
  /** 手机触摸：action=move/click，x/y 为桌宠窗口内归一化坐标 0..1 */
  touch?(action: 'move' | 'click', x: number, y: number): Promise<string>;
  /** 电脑端聊天历史：无 sessionId 时返回会话列表，否则返回该会话消息（JSON 文本） */
  chatHistory?(sessionId: string, limit: number): string;
  /** 带思考过程的外部 AI 回复 */
  chatDetail?(prompt: string): Promise<{ reply: string; thinking: string }>;
}

export interface PetMcpServerOptions {
  configPath: string;
  version?: string;
  log?: (message: string) => void;
  deps: PetMcpServerDeps;
  /** 从设置读初始配置（设置页驱动；不传则回退读 mcp-server.json，供测试/旧配置用） */
  readInitial?: () => { enabled: boolean; lan?: boolean; port: number; token: string };
  /** 实际端口/token 生成后回写（main 用来存进 settings.json） */
  persist?: (cfg: { enabled: boolean; lan: boolean; port: number; token: string }) => void;
  /** 手机工具调用超时（测试可覆盖；默认 30s） */
  phoneCallTimeoutMs?: number;
}

interface PetMcpServerConfig {
  enabled: boolean;
  lan: boolean;
  port: number;
  token: string;
}

const TOOL_DEFS = [
  {
    name: 'pet_say',
    description: '让桌宠在屏幕上用气泡说一句话（远程提醒/播报）。text 最长 500 字。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '要说的话' } }, required: ['text'] },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_status',
    description: '查看桌宠当前状态：模型、桌宠名字、活动窗口、待办数量、MCP 连接情况。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'pet_emotion',
    description: '切换桌宠表情（传空字符串恢复默认）。表情名来自当前模型，传入不支持的名字会保持原样。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: '表情名，可为空串' } } },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_motion',
    description: '播放桌宠动作：Idle（待机）或 wave（挥手）。',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', enum: ['Idle', 'idle', 'wave'] } },
      required: ['group'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_todo_add',
    description: '给桌宠的待办笔记本添加一条待办。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '待办内容' } }, required: ['text'] },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_todo_list',
    description: '列出桌宠待办笔记本里的条目。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'pet_chat',
    description:
      '让桌宠的 AI 回一句话（外部客户端桥接/转述用）。会消耗模型额度：非必要不要频繁调用，',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: '要让桌宠回应的输入' } },
      required: ['text'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_ask',
    description: '通过桌宠向用户弹一个问题并等待回答（远程自动化确认用，最多等 120 秒）。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问用户的问题' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '选项标签（2~4 个，默认 允许/拒绝）',
        },
      },
      required: ['question'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_note_add',
    description: '往桌宠的笔记里记一条内容。',
    inputSchema: { type: 'object', properties: { text: { type: 'string', description: '笔记内容' } }, required: ['text'] },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_reminder_add',
    description: '给桌宠加一个一次性提醒（afterMinutes 分钟后弹出）。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '提醒内容' },
        afterMinutes: { type: 'number', description: '多少分钟后提醒（1~10080）' },
      },
      required: ['text', 'afterMinutes'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_avatar',
    description: '抓取当前桌宠窗口的一帧画面（手机端 Live2D 头像用）。maxWidth 可选（120~640）。',
    inputSchema: { type: 'object', properties: { maxWidth: { type: 'number' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'pet_touch',
    description: '手机触摸桌宠：action=move 让桌宠视线跟随到该位置；action=click 在命中可交互区域时触发一次左键点击（不能拖动）。x/y 为桌宠窗口内归一化坐标 0~1。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click'] },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['action', 'x', 'y'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_chat_history',
    description: '读取电脑端聊天历史：不传 sessionId 返回会话列表（JSON）；传 sessionId 返回该会话最近消息（JSON，role/text/at）。',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, limit: { type: 'number' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'pet_chat_detail',
    description: '让桌宠 AI 回复；返回 JSON 文本 {"reply": string, "thinking": string}（手机对话页用；会消耗模型额度）。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'pet_screenshot',
    description: '截取当前整个屏幕（PNG），返回图片与保存路径。注意：内容可能含用户隐私，只在用户知情时调用。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
  },
];

export function loadPetMcpServerConfig(text: string | null): { cfg: PetMcpServerConfig; error: string } {
  const fallback: PetMcpServerConfig = { enabled: false, lan: false, port: DEFAULT_PORT, token: '' };
  if (text === null) return { cfg: fallback, error: '' };
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const enabled = raw.enabled === true;
    const portRaw = typeof raw.port === 'number' && Number.isFinite(raw.port) ? Math.round(raw.port) : DEFAULT_PORT;
    const port = portRaw >= 0 && portRaw <= 65535 ? portRaw : DEFAULT_PORT;
    const token = typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : '';
    const lan = raw.lan === true;
    return { cfg: { enabled, lan, port, token }, error: '' };
  } catch (err) {
    return { cfg: fallback, error: (err as Error).message };
  }
}

interface PhoneTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; timeoutMs?: number };
}

interface PendingPhoneCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const PHONE_PREFIX = 'phone_';
const PHONE_NAME_RE = /^[a-z][a-z0-9_]{1,31}$/;
const PHONE_POLL_MAX_WAIT_MS = 25_000;
const PHONE_TOOL_TIMEOUT_MS = 30_000;

export class PetMcpServer {
  private server: http.Server | null = null;
  private cfg: PetMcpServerConfig = { enabled: false, lan: false, port: DEFAULT_PORT, token: '' };
  private actualPort = 0;
  private started = false;
  private readonly opts: PetMcpServerOptions;
  private readonly wsSockets = new Set<Duplex>();
  private readonly wsAvatarTimers = new Map<Duplex, { timer: NodeJS.Timeout | null; busy: boolean }>();
  /** 头像帧连续失败计数与上次告警时刻（失败静默会让手机卡死无从排查） */
  private avatarFrameFailures = 0;
  private avatarWarnAt = 0;
  private readonly phoneTools = new Map<string, PhoneTool>();
  private readonly phoneQueue: PendingPhoneCall[] = [];
  private readonly phoneWaiters = new Set<(call: PendingPhoneCall | null) => void>();
  private readonly pendingPhoneCalls = new Map<string, { resolve: (result: unknown) => void; timer: NodeJS.Timeout }>();

  constructor(opts: PetMcpServerOptions) {
    this.opts = opts;
  }

  private log(message: string): void {
    this.opts.log?.(message);
  }

  /** 启动（配置不存在/enabled=false 时静默跳过）；端口被占用就往后找 1~19 个并回写配置 */
  async start(): Promise<void> {
    if (this.started) return;
    let cfg: PetMcpServerConfig;
    if (this.opts.readInitial) {
      const initial = this.opts.readInitial();
      const portRaw = typeof initial.port === 'number' && Number.isFinite(initial.port) ? Math.round(initial.port) : DEFAULT_PORT;
      cfg = {
        enabled: initial.enabled === true,
        lan: initial.lan === true,
        port: portRaw >= 0 && portRaw <= 65535 ? portRaw : DEFAULT_PORT,
        token: typeof initial.token === 'string' ? initial.token.trim() : '',
      };
      if (!cfg.enabled) return;
    } else {
      let text: string | null = null;
      try {
        if (!fs.existsSync(this.opts.configPath)) return;
        text = fs.readFileSync(this.opts.configPath, 'utf8');
      } catch (err) {
        this.log(`MCP 服务端：配置读取失败（${(err as Error).message}），不启动`);
        return;
      }
      const parsed = loadPetMcpServerConfig(text);
      if (parsed.error) {
        this.log(`MCP 服务端：配置解析失败（${parsed.error}），不启动`);
        return;
      }
      cfg = parsed.cfg;
      if (!cfg.enabled) return;
    }
    this.cfg = cfg;
    if (!this.cfg.token) this.cfg.token = crypto.randomBytes(24).toString('hex');
    const listenPort = await this.listenWithFallback();
    if (listenPort < 0)
        return;
    this.actualPort = listenPort;
    this.started = true;
    if (this.opts.persist) {
      try {
        this.opts.persist({ enabled: true, lan: this.cfg.lan, port: this.actualPort, token: this.cfg.token });
      } catch (err) {
        this.log(`MCP 服务端：配置回写失败（${(err as Error).message}）`);
      }
    } else {
      this.persistConfig();
    }
    const where = this.opts.readInitial ? 'token 见设置页' : 'token 见 mcp-server.json';
    this.log(`MCP 服务端已启动：${this.cfg.lan ? 'http://0.0.0.0（局域网）' : 'http://127.0.0.1'}:${this.actualPort}/mcp + ws://…:${this.actualPort}/ws（tool ${TOOL_DEFS.length + this.phoneTools.size} 个，${where}）`);
  }

  private listenWithFallback(): Promise<number> {
    const base = this.cfg.port;
    const attempts = base === 0 ? 1 : 20;
    return (async () => {
      for (let offset = 0; offset < attempts; offset++) {
        const port = base === 0 ? 0 : base + offset;
        const server = http.createServer((req, res) => this.handleHttp(req, res));
        server.on('upgrade', (req, socket) => this.handleWsUpgrade(req, socket as Duplex));
        const result = await new Promise<number>((resolve) => {
          const onError = (err: NodeJS.ErrnoException): void => {
            server.removeListener('listening', onListening);
            if (err.code === 'EADDRINUSE' || err.code === 'EACCES')
              resolve(-1);
            else {
              this.log(`MCP 服务端监听失败：${err.message}`);
              resolve(-2);
            }
          };
          const onListening = (): void => {
            server.removeListener('error', onError);
            const addr = server.address();
            resolve(typeof addr === 'object' && addr ? addr.port : port);
          };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(port, this.cfg.lan ? '0.0.0.0' : '127.0.0.1');
        });
        if (result >= 0) {
          this.server = server;
          return result;
        }
        try {
          server.close();
        } catch {
          /* ignore */
        }
        if (result === -2) return -1;
      }
      this.log('MCP 服务端：端口都被占用，启动失败');
      return -1;
    })();
  }
  private persistConfig(): void {
    try {
      const dir = path.dirname(this.opts.configPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.opts.configPath,
        JSON.stringify({ enabled: true, lan: this.cfg.lan, port: this.actualPort, token: this.cfg.token }, null, 2),
        'utf8',
      );
    } catch (err) {
      this.log(`MCP 服务端：配置回写失败（${(err as Error).message}）`);
    }
  }

  /** /mcp 命令展示用状态 */
  statusText(): string {
    if (!this.started || !this.server) {
      return this.opts.readInitial
        ? '反向接入（桌宠 MCP 服务端）：未启用（设置页勾选「开启反向接入」并保存即可）。'
        : '反向接入（桌宠 MCP 服务端）：未启用（在 userData/mcp-server.json 写 {"enabled": true} 后重启即可）。';
    }
    const where = this.opts.readInitial ? '开关/端口/token 见设置页' : 'token 见 mcp-server.json';
    return `反向接入（桌宠 MCP 服务端）：已启动 ${this.cfg.lan ? 'http://0.0.0.0（局域网）' : 'http://127.0.0.1'}:${this.actualPort}/mcp + ws://…:${this.actualPort}/ws（tool ${TOOL_DEFS.length + this.phoneTools.size} 个；${where}）` +
      `\n可用：${[...TOOL_DEFS.map((t) => t.name), ...this.phoneToolDefs().map((t) => t.name)].join(', ')}`;
  }

  /** 运行状态（实际端口/绑定方式），供设置页拼访问地址与手机连接提示 */
  describe(): { running: boolean; port: number; lan: boolean } {
    return { running: this.started && this.server !== null, port: this.actualPort, lan: this.cfg.lan };
  }

  /** 热重载 mcp-server.json：先关监听，再按当前配置重启（端口/开关变化都会生效） */
  async reload(): Promise<void> {
    this.dispose();
    this.actualPort = 0;
    await this.start();
  }

  dispose(): void {
    for (const pending of this.pendingPhoneCalls.values()) clearTimeout(pending.timer);
    this.pendingPhoneCalls.clear();
    this.phoneWaiters.clear();
    this.phoneQueue.length = 0;
    const srv = this.server;
    this.server = null;
    this.started = false;
    for (const state of this.wsAvatarTimers.values()) {
      if (state.timer) clearInterval(state.timer);
    }
    this.wsAvatarTimers.clear();
    for (const socket of this.wsSockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    this.wsSockets.clear();
    if (!srv) return;
    try {
      srv.close();
    } catch {
      /* ignore */
    }
  }

  // ------------------------------------------------------------------ HTTP

  private handleHttp(req: http.IncomingMessage, res: http.ServerResponse): void {
    const sendJson = (status: number, body: unknown): void => {
      const text = JSON.stringify(body);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(text);
    };
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/mcp') {
        sendJson(404, { error: 'not found' });
        return;
      }
      if (req.method === 'GET') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      if (!this.authorized(req)) {
        sendJson(401, { error: 'unauthorized' });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let aborted = false;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES && !aborted) {
          aborted = true;
          sendJson(413, { error: 'payload too large' });
          req.destroy();
          return;
        }
        if (!aborted) chunks.push(c);
      });
      req.on('end', () => {
        if (aborted) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          sendJson(400, { error: 'invalid json' });
          return;
        }
        void this.handleRpc(parsed).then((payload) => {
          if (payload === undefined) {
            res.writeHead(202);
            res.end();
            return;
          }
          sendJson(200, payload);
        });
      });
    } catch (err) {
      this.log(`MCP 服务端：请求处理异常（${(err as Error).message}）`);
      try {
        sendJson(500, { error: 'internal error' });
      } catch {
        /* ignore */
      }
    }
  }
﻿  /** WS 鉴权：手机/浏览器 WS 无法自定义 Authorization 头，token 走 query（仅本机/局域网 + Bearer 等价的 timingSafeEqual 比较） */
  private wsAuthorized(url: URL): boolean {
    const token = (url.searchParams.get('token') ?? '').trim();
    if (!token || token.length !== this.cfg.token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.cfg.token));
    } catch {
      return false;
    }
  }

  private handleWsUpgrade(req: http.IncomingMessage, socket: Duplex): void {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!this.wsAuthorized(url)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string' || !key) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.wsSockets.add(socket);
      let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        buffer = this.consumeWsFrames(socket, buffer);
      });
      socket.on('close', () => {
        this.stopAvatarStream(socket);
        this.wsSockets.delete(socket);
      });
      socket.on('error', () => {
        this.stopAvatarStream(socket);
        this.wsSockets.delete(socket);
      });
    } catch (err) {
      this.log(`MCP 服务端：WS 握手异常（${(err as Error).message}）`);
      try { socket.destroy(); } catch { /* ignore */ }
    }
  }

  /** 解析客户端帧（mask/分片合并/ping/pong/close）；返回未消费残留 */
  private consumeWsFrames(socket: Duplex, buffer: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
    for (;;) {
      if (buffer.length < 2) return buffer;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return buffer;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return buffer;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (length > MAX_BODY_BYTES) {
        socket.destroy();
        return Buffer.alloc(0);
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return buffer;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      offset += maskLength;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        try { socket.end(Buffer.from([0x88, 0x00])); } catch { /* ignore */ }
        this.wsSockets.delete(socket);
        return Buffer.alloc(0);
      }
      if (opcode === 0x9) {
        this.wsSendFrame(socket, 0xa, payload);
        continue;
      }
      if (opcode === 0x1) void this.handleWsMessage(socket, payload.toString('utf8'));
    }
  }

  private wsSendFrame(socket: Duplex, opcode: number, payload: Buffer): void {
    try {
      let header: Buffer;
      if (payload.length < 126) {
        header = Buffer.from([0x80 | opcode, payload.length]);
      } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x80 | opcode;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
      }
      socket.write(Buffer.concat([header, payload]));
    } catch { /* ignore */ }
  }

  private wsSendJson(socket: Duplex, payload: unknown): void {
    this.wsSendFrame(socket, 0x1, Buffer.from(JSON.stringify(payload)));
  }

  private async handleWsMessage(socket: Duplex, text: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.wsSendJson(socket, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid json' } });
      return;
    }
    try {
      const msg = parsed as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
      if (msg && (msg.method === 'pet/avatarStart' || msg.method === 'pet/avatarStop')) {
        const id = typeof msg.id === 'number' ? msg.id : null;
        if (msg.method === 'pet/avatarStart') {
          const raw = typeof msg.params?.maxWidth === 'number' ? Math.round(msg.params.maxWidth) : 300;
          this.startAvatarStream(socket, Math.max(120, Math.min(640, raw)));
        } else {
          this.stopAvatarStream(socket);
        }
        if (id !== null) this.wsSendJson(socket, { jsonrpc: '2.0', id, result: { ok: true } });
        return;
      }
      const payload = await this.handleRpc(parsed);
      if (payload !== undefined) this.wsSendJson(socket, payload);
    } catch (err) {
      this.wsSendJson(socket, { jsonrpc: '2.0', id: null, error: { code: -32603, message: (err as Error).message } });
    }
  }


  /** 24fps 头像推流；上一帧未完成时跳帧（背压），避免拖慢主进程 */
  private startAvatarStream(socket: Duplex, maxWidth: number): void {
    this.stopAvatarStream(socket);
    const state = { timer: null as NodeJS.Timeout | null, busy: false };
    this.wsAvatarTimers.set(socket, state);
    const tick = async (): Promise<void> => {
      if (state.busy || !this.wsSockets.has(socket)) return;
      // 发送端积压时跳帧：慢网络/手机解码慢时别把 PNG 帧堆在 Node 缓冲里
      if (socket.writableLength > 512 * 1024) return;
      if (!this.opts.deps.avatarFrame) return;
      state.busy = true;
      let timeoutTimer: NodeJS.Timeout | null = null;
      try {
        // capturePage 在窗口隐藏/切模型等场景可能不 resolve：超时兜底，否则 busy 永久 true → 手机端画面卡死
        const frame = await Promise.race([
          this.opts.deps.avatarFrame(maxWidth),
          new Promise<never>((_, reject) => {
            timeoutTimer = setTimeout(() => reject(new Error('avatar frame timeout')), 1500);
          }),
        ]);
        this.avatarFrameFailures = 0;
        if (this.wsSockets.has(socket)) {
          this.wsSendJson(socket, { jsonrpc: '2.0', method: 'pet/avatarFrame', params: frame });
        }
      } catch (err) {
        // 单帧失败可跳过，但必须留下限频日志，否则推流静默卡死无法排查
        this.avatarFrameFailures += 1;
        const now = Date.now();
        if (now - this.avatarWarnAt > 5000) {
          this.avatarWarnAt = now;
          console.warn(`[mcp] 头像帧失败（连续 ${this.avatarFrameFailures} 次）：${(err as Error).message}`);
        }
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer); // 成功路径也必须清，否则每帧泄漏一个 1.5s timer
        state.busy = false;
      }
    };
    state.timer = setInterval(() => void tick(), 42);
    state.timer.unref?.();
    void tick();
  }

  private stopAvatarStream(socket: Duplex): void {
    const state = this.wsAvatarTimers.get(socket);
    if (!state) return;
    if (state.timer) clearInterval(state.timer);
    this.wsAvatarTimers.delete(socket);
  }

  private authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const token = header.slice(7).trim();
    if (!token || token.length !== this.cfg.token.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(this.cfg.token));
    } catch {
      return false;
    }
  }

  /** JSON-RPC 批处理：全部是通知 → undefined（202）；否则返回单个/数组响应 */
  private async handleRpc(payload: unknown): Promise<unknown> {
    const list = Array.isArray(payload) ? payload : [payload];
    const responses: unknown[] = [];
    for (const item of list) {
      const req = item as Record<string, unknown> | null;
      if (!req || typeof req !== 'object') continue;
      const id = typeof req.id === 'number' ? req.id : null;
      const method = typeof req.method === 'string' ? req.method : '';
      if (!method) continue;
      if (method.startsWith('notifications/')) continue; // 通知：不响应
      try {
        const result = await this.dispatch(method, (req.params ?? {}) as Record<string, unknown>);
        if (id !== null) responses.push({ jsonrpc: '2.0', id, result });
      } catch (err) {
        if (id !== null) {
          responses.push({ jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error).message } });
        }
      }
    }
    if (responses.length === 0) return undefined;
    return Array.isArray(payload) ? responses : responses[0];
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'pet-desktop-app', version: this.opts.version || '1.0.0' },
          instructions:
            '这是桌宠的 MCP 服务端：可让桌宠说话/做表情/播动作/加待办/笔记/提醒/截图、让它 AI 回一句话、' +
            '或通过桌宠向用户提问；也可以读取 pet:// 只读资源（状态/待办/情景/技能）。' +
            '调用前请确认用户知情；截图与 pet_chat 可能产生隐私暴露或模型费用，非必要不要调用。',
        };
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [...TOOL_DEFS, ...this.phoneToolDefs()] };
      case 'resources/list':
        return { resources: this.opts.deps.resourceList() };
      case 'resources/read': {
        const uri = typeof params.uri === 'string' ? params.uri : '';
        const text = uri ? this.opts.deps.resourceRead(uri) : null;
        if (text === null) throw new Error(`未知资源：${uri}`);
        return { contents: [{ uri, mimeType: 'text/plain', text }] };
      }
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        if (name.startsWith(PHONE_PREFIX)) {
          const phoneName = name.slice(PHONE_PREFIX.length);
          if (!this.phoneTools.has(phoneName)) {
            return { isError: true, content: [{ type: 'text' as const, text: `手机端没有工具：${phoneName}` }] };
          }
          return await this.callPhoneTool(phoneName, args);
        }
        return await this.callTool(name, args);
      }
      case 'phone/register': {
        const list = Array.isArray(params.tools) ? params.tools : [];
        if (list.length > 32) throw new Error('手机工具最多 32 个');
        for (const raw of list) this.registerPhoneTool(raw);
        return { ok: true, tools: this.phoneToolDefs().map((t) => t.name) };
      }
      case 'phone/unregister': {
        const names = Array.isArray(params.names) ? params.names : [];
        for (const raw of names) {
          const name = String(raw).replace(PHONE_PREFIX, '');
          this.phoneTools.delete(name);
        }
        return { ok: true, tools: this.phoneToolDefs().map((t) => t.name) };
      }
      case 'phone/poll': {
        const waitRaw = typeof params.waitMs === 'number' ? Math.round(params.waitMs) : PHONE_POLL_MAX_WAIT_MS;
        const waitMs = Math.max(100, Math.min(PHONE_POLL_MAX_WAIT_MS, waitRaw));
        const call = await this.waitPhoneCall(waitMs);
        return call ? { call } : {};
      }
      case 'phone/result': {
        const id = typeof params.id === 'string' ? params.id : '';
        if (!id) throw new Error('phone/result 缺少 id');
        this.resolvePhoneCall(id, params);
        return { ok: true };
      }
      default:
        throw new Error(`不支持的方法：${method}`);
    }
  }

  /** 暴露给 MCP 的工具定义：名称统一 phone_ 前缀，schema/annotations 由手机端上报 */
  private phoneToolDefs(): Array<{ name: string; description: string; inputSchema: unknown; annotations: unknown }> {
    return [...this.phoneTools.values()].map((tool) => ({
      name: PHONE_PREFIX + tool.name,
      description: `[手机] ${tool.description || tool.name}`,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
    }));
  }

  private registerPhoneTool(raw: unknown): void {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== 'object') throw new Error('手机工具定义必须是对象');
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!PHONE_NAME_RE.test(name)) throw new Error(`手机工具名不合法：${name}（需小写字母/数字/下划线，2~32 位）`);
    const description = typeof item.description === 'string' ? item.description.trim().slice(0, 200) : '';
    const inputSchema = item.inputSchema && typeof item.inputSchema === 'object' ? (item.inputSchema as Record<string, unknown>) : { type: 'object', properties: {} };
    const annotations = item.annotations && typeof item.annotations === 'object' ? (item.annotations as Record<string, unknown>) : {};
    this.phoneTools.set(name, {
      name,
      description,
      inputSchema,
      annotations: {
        readOnlyHint: annotations.readOnlyHint === true,
        destructiveHint: annotations.destructiveHint === true,
        timeoutMs: typeof annotations.timeoutMs === 'number' ? Math.max(1000, Math.min(300_000, Math.round(annotations.timeoutMs))) : undefined,
      },
    });
  }

  private deliverPhoneCall(call: PendingPhoneCall): void {
    for (const waiter of this.phoneWaiters) {
      this.phoneWaiters.delete(waiter);
      waiter(call);
      return;
    }
    this.phoneQueue.push(call);
  }

  private waitPhoneCall(waitMs: number): Promise<PendingPhoneCall | null> {
    const queued = this.phoneQueue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => {
      const waiter = (call: PendingPhoneCall | null): void => {
        clearTimeout(timer);
        resolve(call);
      };
      const timer = setTimeout(() => {
        this.phoneWaiters.delete(waiter);
        resolve(null);
      }, waitMs);
      timer.unref?.();
      this.phoneWaiters.add(waiter);
    });
  }

  private callPhoneTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const id = crypto.randomUUID();
    const timeoutMs = this.opts.phoneCallTimeoutMs ?? PHONE_TOOL_TIMEOUT_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPhoneCalls.delete(id);
        resolve({ isError: true, content: [{ type: 'text' as const, text: `手机端在 ${timeoutMs}ms 内没有返回结果（工具：${name}）` }] });
      }, timeoutMs);
      timer.unref?.();
      this.pendingPhoneCalls.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        timer,
      });
      this.deliverPhoneCall({ id, name, arguments: args });
    });
  }

  private resolvePhoneCall(id: string, params: Record<string, unknown>): void {
    const pending = this.pendingPhoneCalls.get(id);
    if (!pending) return; // 已超时/重复回执：忽略
    this.pendingPhoneCalls.delete(id);
    const rawContent = Array.isArray(params.content) ? params.content : [];
    const content = rawContent.length
      ? rawContent
      : [{ type: 'text' as const, text: typeof params.text === 'string' ? params.text : '手机端已完成' }];
    pending.resolve({ content });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const textOf = (key: string, maxLen: number): string => {
      const v = args[key];
      return typeof v === 'string' ? v.trim().slice(0, maxLen) : '';
    };
    try {
      switch (name) {
        case 'pet_say': {
          const text = textOf('text', 500);
          if (!text) return { isError: true, content: [{ type: 'text', text: '参数 text 不能为空' }] };
          return { content: [{ type: 'text', text: this.opts.deps.say(text) }] };
        }
        case 'pet_status':
          return { content: [{ type: 'text', text: this.opts.deps.status() }] };
        case 'pet_emotion':
          return { content: [{ type: 'text', text: this.opts.deps.emotion(textOf('name', 40)) }] };
        case 'pet_motion': {
          const group = typeof args.group === 'string' ? args.group : '';
          if (!['Idle', 'idle', 'wave'].includes(group))
            return { isError: true, content: [{ type: 'text', text: 'group 只支持 Idle / idle / wave' }] };
          return { content: [{ type: 'text', text: this.opts.deps.motion(group) }] };
        }
        case 'pet_todo_add': {
          const text = textOf('text', 500);
          if (!text) return { isError: true, content: [{ type: 'text', text: '参数 text 不能为空' }] };
          return { content: [{ type: 'text', text: this.opts.deps.todoAdd(text) }] };
        }
        case 'pet_todo_list':
          return { content: [{ type: 'text', text: this.opts.deps.todoList() }] };
        case 'pet_chat': {
          const text = textOf('text', 500);
          if (!text) return { isError: true, content: [{ type: 'text', text: '参数 text 不能为空' }] };
          return { content: [{ type: 'text', text: await this.opts.deps.chat(text) }] };
        }
        case 'pet_ask': {
          const question = textOf('question', 300);
          if (!question) return { isError: true, content: [{ type: 'text', text: '参数 question 不能为空' }] };
          const rawOptions = Array.isArray(args.options) ? args.options.filter((v) => typeof v === 'string' && v.trim()) : [];
          const options = (rawOptions.length >= 2 && rawOptions.length <= 4 ? rawOptions : ['允许', '拒绝']).map((v) => String(v).slice(0, 40));
          return { content: [{ type: 'text', text: await this.opts.deps.ask(question, options) }] };
        }
        case 'pet_note_add': {
          const text = textOf('text', 2000);
          if (!text) return { isError: true, content: [{ type: 'text', text: '参数 text 不能为空' }] };
          return { content: [{ type: 'text', text: this.opts.deps.noteAdd(text) }] };
        }
        case 'pet_reminder_add': {
          const text = textOf('text', 500);
          const minutesRaw = typeof args.afterMinutes === 'number' ? Math.round(args.afterMinutes) : NaN;
          if (!text) return { isError: true, content: [{ type: 'text', text: '参数 text 不能为空' }] };
          if (!Number.isFinite(minutesRaw) || minutesRaw < 1 || minutesRaw > 10080)
            return { isError: true, content: [{ type: 'text', text: 'afterMinutes 必须是 1~10080 的整数' }] };
          return { content: [{ type: 'text', text: this.opts.deps.reminderAdd(text, minutesRaw) }] };
        }
        case 'pet_avatar': {
          if (!this.opts.deps.avatarFrame)
            return { isError: true, content: [{ type: 'text', text: '头像抓帧不可用' }] };
          const maxWidth = typeof args.maxWidth === 'number' ? Math.round(args.maxWidth) : 300;
          const frame = await this.opts.deps.avatarFrame(Math.max(120, Math.min(640, maxWidth)));
          return {
            content: [
              { type: 'image', data: frame.data, mimeType: 'image/png' },
              { type: 'text', text: `${frame.width}×${frame.height}` },
            ],
          };
        }
        case 'pet_touch': {
          if (!this.opts.deps.touch)
            return { isError: true, content: [{ type: 'text', text: '触摸不可用' }] };
          const action = args.action === 'click' ? 'click' : 'move';
          const x = typeof args.x === 'number' && Number.isFinite(args.x) ? args.x : 0.5;
          const y = typeof args.y === 'number' && Number.isFinite(args.y) ? args.y : 0.5;
          return { content: [{ type: 'text', text: await this.opts.deps.touch(action, x, y) }] };
        }
        case 'pet_chat_history': {
          if (!this.opts.deps.chatHistory)
            return { isError: true, content: [{ type: 'text', text: '聊天历史不可用' }] };
          const sessionId = typeof args.sessionId === 'string' ? args.sessionId : '';
          const limit = typeof args.limit === 'number' ? Math.round(args.limit) : 40;
          return { content: [{ type: 'text', text: this.opts.deps.chatHistory(sessionId, Math.max(1, Math.min(100, limit))) }] };
        }
        case 'pet_chat_detail': {
          if (!this.opts.deps.chatDetail)
            return { isError: true, content: [{ type: 'text', text: 'chatDetail 不可用' }] };
          const text = textOf('text', 500);
          if (!text)
            return { isError: true, content: [{ type: 'text', text: '参数 text 不能为空' }] };
          const detail = await this.opts.deps.chatDetail(text);
          return { content: [{ type: 'text', text: JSON.stringify({ reply: detail.reply, thinking: detail.thinking }) }] };
        }
        case 'pet_screenshot': {
          const shot = await this.opts.deps.screenshot();
          return {
            content: [
              { type: 'image', data: shot.base64, mimeType: 'image/png' },
              { type: 'text', text: `已截屏并保存：${shot.savedPath}` },
            ],
          };
        }
        default:
          return { isError: true, content: [{ type: 'text', text: `未知工具：${name}` }] };
      }
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `执行失败：${(err as Error).message}` }] };
    }
  }
}
