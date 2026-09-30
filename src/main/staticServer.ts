/**
 * staticServer —— 主进程内本地静态 HTTP 服务（渲染进程唯一的文件读取通道，见 CONTRACT.md L36）
 *
 *  - 监听 127.0.0.1:<随机端口(0)>，根目录 = PathResolver.assetsRoot() 的上一级
 *    （开发 = 工程 public/，打包 = resourcesPath 或 execPath 旁），
 *    使 URL 形如 http://127.0.0.1:<port>/assets/<模型>/xxx.model3.json。
 *  - 只允许 GET（OPTIONS 预检给 204 + CORS 头，便于 file:// 或跨源渲染进程取模型）。
 *  - Access-Control-Allow-Origin: *；按扩展名给正确 MIME。
 *  - 中文路径：浏览器 fetch 会自动 encodeURIComponent；服务端 translatePath 时
 *    decodeURIComponent(req.url)（Node http 的 req.url 是已编码串）。
 *  - favicon.ico 一律 404，避免无谓报错。
 */
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

const COMMON_HEADERS: http.OutgoingHttpHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Accept',
  'Cache-Control': 'no-cache',
  // 防内容嗅探：即使扩展名/MIME 被搞错，也不让浏览器把资源当脚本执行
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

/**
 * 只发给 HTML 入口的 CSP：本应用全部资源都来自这个本地服务，
 * 因此禁止远程 script/style/img/connect，锁死 base 标签与嵌套框架。
 * 'unsafe-eval' 是 Pixi 里 new Function（WebGL 程序编译）需要的；'unsafe-inline' 供 JS 设置的样式属性。
 * worker-src/child-src 放行 blob:：Pixi 8 的贴图解码用 blob worker，不给会 SecurityError（模型挂不上）。
 * 若某天出现白屏且怀疑是它：注掉下面这一行 + handleRequest 里的 CSP 赋值即可回滚。
 */
const HTML_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; font-src 'self' data:; " +
  "worker-src 'self' blob:; child-src 'self' blob:; " +
  "object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.moc3': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
};

const FALLBACK_MIME = 'application/octet-stream';

/** 容错 decode（挂载点 key 里可能有中文模型名） */
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class StaticServer {
  private server: http.Server | null = null;
  private _port = 0;

  /**
   * rootDir = assets 上一级目录（工程 public/ 或 resourcesPath）。
   * extraMounts = 额外挂载点：让"像插件一样注册在 userData / 任意目录里的用户模型"也能被渲染层取到，
   * 不必把模型拷进包里。`/<prefix>/<key>/<其余路径>` → `resolve(key)` 返回的目录 + 其余路径。
   */
  constructor(
    private readonly root: string,
    private readonly extraMounts: Array<{ prefix: string; resolve: (key: string) => string | null }> = []
  ) {}

  get port(): number {
    return this._port;
  }

  /** 如 http://127.0.0.1:43123（无尾斜杠） */
  baseUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      let listening = false;
      server.on('error', (err) => {
        if (!listening) {
          // 启动阶段失败（端口/权限等）：必须 reject，否则 bootstrap 的 await 永远挂住
          reject(err);
          return;
        }
        // server.close() 之后仍可能有残留请求触发 error，启动完成后容忍并记录
        console.warn('[staticServer] error', err.message);
      });
      server.listen(0, '127.0.0.1', () => {
        listening = true;
        const addr = server.address();
        this._port = typeof addr === 'object' && addr !== null ? addr.port : 0;
        this.server = server;
        console.log(`[staticServer] listening ${this.baseUrl()}  root=${this.root}`);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      const server = this.server;
      this.server = null;
      server.close(() => resolve());
      server.closeAllConnections?.(); // Node 18.2+：立即断开挂起的长连接
    });
  }

  // ------------------------------------------------------------------ 请求处理

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // 只允许 GET；CORS 预检 OPTIONS 也放行（无业务副作用）
    if (req.method === 'OPTIONS') {
      res.writeHead(204, COMMON_HEADERS);
      res.end();
      return;
    }
    if (req.method !== 'GET') {
      this.respond(res, 405, FALLBACK_MIME, '405 Method Not Allowed');
      return;
    }

    // 1) 解出路径并 decode（Node req.url 是已编码串，中文文件名在这里还原）
    let pathname: string;
    try {
      pathname = decodeURIComponent((req.url ?? '/').split('?')[0]);
    } catch {
      this.respond(res, 400, 'text/plain; charset=utf-8', '400 Bad Request');
      return;
    }
    if (pathname === '/favicon.ico') {
      this.respond(res, 404, 'text/plain; charset=utf-8', '');
      return;
    }

    // 1.5) 额外挂载点（用户模型）：/<prefix>/<key>/<其余> → resolve(key) 目录下的"其余"
    for (const mount of this.extraMounts) {
      const prefix = `/${mount.prefix}/`;
      if (!pathname.startsWith(prefix)) continue;
      const restRaw = pathname.slice(prefix.length).replace(/^\/+/, '');
      const slash = restRaw.indexOf('/');
      const key = decodeURIComponentSafe(slash < 0 ? restRaw : restRaw.slice(0, slash));
      const rest = slash < 0 ? '' : restRaw.slice(slash + 1);
      const base = key ? mount.resolve(key) : null;
      if (!base || !rest) {
        this.respond(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
        return;
      }
      this.serveFrom(base, rest.replace(/\//g, path.sep), res);
      return;
    }

    // 2) translatePath：把 URL 路径安全映射到 root 下的文件
    const rel = pathname.replace(/^\/+/, '').replace(/\//g, path.sep);
    this.serveFrom(this.root, rel, res);
  }

  /** 在 baseRoot 下安全地定位并流式输出 rel 指向的文件（越界/目录/缺失都有明确响应） */
  private serveFrom(baseRoot: string, rel: string, res: http.ServerResponse): void {
    const abs = path.resolve(baseRoot, rel);
    const check = path.relative(baseRoot, abs);
    if (check === '' || check.startsWith('..') || path.isAbsolute(check)) {
      this.respond(res, 403, 'text/plain; charset=utf-8', '403 Forbidden');
      return;
    }

    // 3) 定位文件：目录 → 目录内 index.html（/ 供渲染入口用）
    let target = abs;
    try {
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html');
      }
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        this.respond(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
        return;
      }
      const realRoot = fs.realpathSync(baseRoot);
      const realTarget = fs.realpathSync(target);
      const realRelative = path.relative(realRoot, realTarget);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        this.respond(res, 403, 'text/plain; charset=utf-8', '403 Forbidden');
        return;
      }
      target = realTarget;
    } catch {
      this.respond(res, 500, 'text/plain; charset=utf-8', '500 Internal Error');
      return;
    }

    // 4) 输出（流式，避免整文件进内存；模型 moc3 可能数百 MB）
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] ?? FALLBACK_MIME;
    const headers: http.OutgoingHttpHeaders = {
      ...COMMON_HEADERS,
      'Content-Type': type,
      'Content-Length': fs.statSync(target).size,
    };
    if (ext === '.html' || ext === '.htm') headers['Content-Security-Policy'] = HTML_CSP;
    res.writeHead(200, headers);
    const stream = fs.createReadStream(target);
    stream.on('error', () => {
      if (!res.headersSent) res.writeHead(500, COMMON_HEADERS);
      res.end();
    });
    stream.pipe(res);
  }

  private respond(res: http.ServerResponse, code: number, contentType: string, body: string): void {
    try {
      res.writeHead(code, { ...COMMON_HEADERS, 'Content-Type': contentType });
      res.end(body);
    } catch {
      // 连接已断开等场景，忽略
    }
  }
}
