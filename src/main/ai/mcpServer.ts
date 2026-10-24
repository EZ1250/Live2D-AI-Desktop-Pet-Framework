/** MCP 服务端：在本机回环地址暴露桌宠工具。 */
import * as fs from 'fs';
import * as http from 'http';
import * as crypto from 'crypto';
import * as path from 'path';

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
}

export interface PetMcpServerOptions {
  configPath: string;
  version?: string;
  log?: (message: string) => void;
  deps: PetMcpServerDeps;
  /** 从设置读初始配置（设置页驱动；不传则回退读 mcp-server.json，供测试/旧配置用） */
  readInitial?: () => { enabled: boolean; port: number; token: string };
  /** 实际端口/token 生成后回写（main 用来存进 settings.json） */
  persist?: (cfg: { enabled: boolean; port: number; token: string }) => void;
}

interface PetMcpServerConfig {
  enabled: boolean;
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
    name: 'pet_screenshot',
    description: '截取当前整个屏幕（PNG），返回图片与保存路径。注意：内容可能含用户隐私，只在用户知情时调用。',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
  },
];

export function loadPetMcpServerConfig(text: string | null): { cfg: PetMcpServerConfig; error: string } {
  const fallback: PetMcpServerConfig = { enabled: false, port: DEFAULT_PORT, token: '' };
  if (text === null) return { cfg: fallback, error: '' };
  try {
    const raw = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const enabled = raw.enabled === true;
    const portRaw = typeof raw.port === 'number' && Number.isFinite(raw.port) ? Math.round(raw.port) : DEFAULT_PORT;
    const port = portRaw >= 0 && portRaw <= 65535 ? portRaw : DEFAULT_PORT;
    const token = typeof raw.token === 'string' && raw.token.trim() ? raw.token.trim() : '';
    return { cfg: { enabled, port, token }, error: '' };
  } catch (err) {
    return { cfg: fallback, error: (err as Error).message };
  }
}

export class PetMcpServer {
  private server: http.Server | null = null;
  private cfg: PetMcpServerConfig = { enabled: false, port: DEFAULT_PORT, token: '' };
  private actualPort = 0;
  private started = false;
  private readonly opts: PetMcpServerOptions;

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
        this.opts.persist({ enabled: true, port: this.actualPort, token: this.cfg.token });
      } catch (err) {
        this.log(`MCP 服务端：配置回写失败（${(err as Error).message}）`);
      }
    } else {
      this.persistConfig();
    }
    const where = this.opts.readInitial ? 'token 见设置页' : 'token 见 mcp-server.json';
    this.log(`MCP 服务端已启动：http://127.0.0.1:${this.actualPort}/mcp（tool ${TOOL_DEFS.length} 个，${where}）`);
  }

  private listenWithFallback(): Promise<number> {
    const base = this.cfg.port;
    const attempts = base === 0 ? 1 : 20;
    return (async () => {
      for (let offset = 0; offset < attempts; offset++) {
        const port = base === 0 ? 0 : base + offset;
        const server = http.createServer((req, res) => this.handleHttp(req, res));
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
          server.listen(port, '127.0.0.1');
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
        JSON.stringify({ enabled: true, port: this.actualPort, token: this.cfg.token }, null, 2),
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
    return `反向接入（桌宠 MCP 服务端）：已启动 http://127.0.0.1:${this.actualPort}/mcp（tool ${TOOL_DEFS.length} 个；${where}）` +
      `\n可用：${TOOL_DEFS.map((t) => t.name).join(', ')}`;
  }

  /** 热重载 mcp-server.json：先关监听，再按当前配置重启（端口/开关变化都会生效） */
  async reload(): Promise<void> {
    this.dispose();
    this.actualPort = 0;
    await this.start();
  }

  dispose(): void {
    const srv = this.server;
    this.server = null;
    this.started = false;
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
        return { tools: TOOL_DEFS };
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
        return await this.callTool(name, args);
      }
      default:
        throw new Error(`不支持的方法：${method}`);
    }
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
