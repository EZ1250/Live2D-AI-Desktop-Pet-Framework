import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import * as zlib from 'zlib';

interface FetchCacheItem {
  timestamp: number;
  content: string;
}

const fetchCache = new Map<string, FetchCacheItem>();
const CACHE_DURATION = 15 * 60 * 1000; // 15 分钟缓存
const CACHE_MAX_ENTRIES = 30; // 缓存条目上限（避免长时间运行无限增长）

/** 判断一个 IP 字面量是否属于本机/内网/保留网段 */
function isPrivateAddress(ip: string): boolean {
  const addr = ip.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!addr) return true;
  // IPv6：回环、链路本地、唯一本地
  if (addr === '::1' || addr === '::' || addr.startsWith('fe80:') || addr.startsWith('fc') || addr.startsWith('fd')) return true;
  // IPv4-mapped IPv6 的十六进制写法：::ffff:7f00:1 → 127.0.0.1（不认这个写法就能绕过内网拦截）
  const mappedHex = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateAddress(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  const v4 = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  const parts = v4.split('.');
  if (parts.length !== 4) return false; // 非 IPv4 字面量（交给 hostname 规则判断）
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = nums;
  if (a === 0 || a === 10 || a === 127) return true; // 本网络/私网/回环
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254 在这段）
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** 主机名规则：本机名、内网后缀、IP 字面量 */
function isBlockedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.home.arpa')) return true;
  if (isPrivateAddress(host)) return true;
  return false;
}

/** DNS 解析后再查一遍，防"公网域名解析到内网 IP"（DNS rebinding） */
async function resolvesToPrivate(hostname: string): Promise<boolean> {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(':')) return false; // IP 字面量已在 isBlockedHost 里查过
  try {
    const records = await dns.promises.lookup(hostname, { all: true });
    return records.some((r) => isPrivateAddress(r.address));
  } catch {
    return true; // 解析失败：不冒险
  }
}

/** 抓取网页并转成纯文本（供模型阅读）；不抛异常，失败返回中文说明 */
export async function webFetch(args: { url?: unknown; max_chars?: unknown }): Promise<string> {
  // 参数校验
  if (!args.url || typeof args.url !== 'string') {
    return 'URL 缺失或无效：请给出完整网址。';
  }

  let urlString = args.url.trim();
  if (urlString.length > 2000) {
    return 'URL 过长（上限 2000 字符）。';
  }

  // 协议检查和自动升级
  if (urlString.startsWith('http://')) {
    urlString = urlString.replace('http://', 'https://');
  } else if (!urlString.startsWith('https://')) {
    return '只支持 http/https 网址（不接受 file://、data: 等）。';
  }

  // 解析URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlString);
  } catch {
    return 'URL 格式无效。';
  }

  // 拒绝本机/内网（先查字面量，再查 DNS 解析结果）
  if (isBlockedHost(parsedUrl.hostname)) return '不允许抓取本机或内网地址。';
  if (await resolvesToPrivate(parsedUrl.hostname)) return '该域名解析到本机/内网地址，已拒绝抓取。';

  // 检查缓存
  const now = Date.now();
  const cached = fetchCache.get(urlString);
  if (cached && now - cached.timestamp < CACHE_DURATION) {
    return `（缓存）${cached.content}`;
  }

  // 处理max_chars参数
  let maxChars = 6000;
  if (args.max_chars !== undefined) {
    if (typeof args.max_chars === 'number' && Number.isInteger(args.max_chars)) {
      maxChars = Math.max(500, Math.min(20000, args.max_chars));
    }
  }

  // 发起请求
  return new Promise((resolve) => {
    const options: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'PetDesktop/1.0',
        'Accept': 'text/html,application/json,text/plain'
      },
      timeout: 20000 // 20秒超时
    };

    let redirectCount = 0;
    const maxRedirects = 5;
    const redirects: string[] = [];

    const doRequest = (reqUrl: string) => {
      const parsed = new URL(reqUrl);
      const reqOptions: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: {
          'User-Agent': 'PetDesktop/1.0',
          'Accept': 'text/html,application/json,text/plain'
        },
        timeout: 20000
      };

      const req = (parsed.protocol === 'https:' ? https : http).request(reqOptions, (res) => {
        // 处理重定向
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectCount >= maxRedirects) {
            resolve(`重定向次数超过限制（${maxRedirects}次）`);
            return;
          }

          let redirectUrl = res.headers.location;
          if (!redirectUrl.startsWith('http://') && !redirectUrl.startsWith('https://')) {
            // 相对路径处理
            const base = new URL(reqUrl);
            redirectUrl = new URL(redirectUrl, base).href;
          }

          // 升级http到https
          if (redirectUrl.startsWith('http://')) {
            redirectUrl = redirectUrl.replace('http://', 'https://');
          }

          // 检查重定向目标是否为内网（与初始请求同一套规则）
          let redirectHost = '';
          try {
            const redirectParsed = new URL(redirectUrl);
            redirectHost = redirectParsed.hostname;
          } catch {
            resolve('重定向 URL 格式无效');
            return;
          }
          if (isBlockedHost(redirectHost)) {
            resolve('重定向到了本机/内网地址，已拒绝继续抓取。');
            return;
          }
          // 防 DNS rebinding：解析后再查一遍（异步，命中内网就停下）
          void resolvesToPrivate(redirectHost).then((bad) => {
            if (bad) {
              resolve('重定向域名的解析结果指向本机/内网地址，已拒绝继续抓取。');
              return;
            }
            redirects.push(`${reqUrl} → ${redirectUrl}`);
            redirectCount++;
            doRequest(redirectUrl);
          });
          return;
        }

        // 检查状态码
        if (!res.statusCode || res.statusCode >= 400) {
          resolve(`请求失败（HTTP ${res.statusCode || '未知'}）`);
          return;
        }

        // 检查Content-Type
        const contentType = res.headers['content-type'] || '';
        const isText = (
          contentType.startsWith('text/') ||
          contentType.includes('application/json') ||
          contentType.includes('application/xml') ||
          contentType.includes('application/javascript')
        );

        if (!isText) {
          resolve(`这不是文本页面（content-type: ${contentType}），无法阅读`);
          return;
        }

        // 处理编码
        let encoding = 'utf-8';
        const charsetMatch = contentType.match(/charset=([^;\s]+)/i);
        if (charsetMatch) {
          encoding = charsetMatch[1].toLowerCase();
        }

        // 处理压缩
        let stream: any = res;
        const contentEncoding = res.headers['content-encoding'];
        if (contentEncoding === 'gzip') {
          stream = res.pipe(zlib.createGunzip());
        } else if (contentEncoding === 'deflate') {
          stream = res.pipe(zlib.createInflate());
        }

        let data = '';
        let dataSize = 0;
        const maxSize = 2 * 1024 * 1024; // 2MB限制

        stream.on('data', (chunk: Buffer) => {
          dataSize += chunk.length;
          if (dataSize > maxSize) {
            // 超过大小限制，截断数据
            const remaining = maxSize - (dataSize - chunk.length);
            if (remaining > 0) {
              data += chunk.subarray(0, remaining).toString(encoding as BufferEncoding);
            }
            // 继续接收但丢弃数据以正确关闭连接
          } else {
            data += chunk.toString(encoding as BufferEncoding);
          }
        });

        stream.on('end', () => {
          // 处理HTML转文本
          let text = data;
          if (contentType.includes('text/html')) {
            text = htmlToText(data);
          }

          // 截取指定字符数
          let truncated = false;
          if (text.length > maxChars) {
            text = text.substring(0, maxChars);
            truncated = true;
          }

          // 构造结果
          let result = '';
          if (redirects.length > 0) {
            result += redirects.join('\n') + '\n';
          }
          
          // 走到这里说明是重新抓取（命中缓存的分支已提前 return），因此不再标"缓存"
          result += `网页：${reqUrl}（HTTP ${res.statusCode}，${text.length} 字符）\n`;
          result += '--- 正文 ---\n';
          result += text;
          
          if (truncated) {
            result += '\n…（正文已截断）';
          }
          
          if (dataSize > maxSize) {
            result += `\n（原始响应体已截断，超过2MB限制）`;
          }

          // 更新缓存
          fetchCache.set(urlString, {
            timestamp: now,
            content: result
          });
          // 缓存条数上限：超了就丢掉最旧的一条，避免长时间运行无限增长
          if (fetchCache.size > CACHE_MAX_ENTRIES) {
            const oldest = [...fetchCache.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp)[0];
            if (oldest) fetchCache.delete(oldest[0]);
          }

          resolve(result);
        });
      });

      req.on('error', (err) => {
        resolve(`网络请求失败：${err.message}`);
      });

      req.on('timeout', () => {
        req.destroy();
        resolve('请求超时（20秒）');
      });

      req.end();
    };

    doRequest(urlString);
  });
}

/** 简单HTML转文本处理 */
function htmlToText(html: string): string {
  // 移除script、style、noscript标签及其内容
  html = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '');
  
  // 将<br>、<p>、<li>等标签替换为换行符
  html = html.replace(/<(br|p|li)([^>]*)>/gi, '\n$&');
  
  // 移除所有HTML标签
  html = html.replace(/<[^>]+>/g, '');
  
  // 解码常见的HTML实体
  const entities: Record<string, string> = {
    '&nbsp;': ' ',
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&apos;': "'",
    '&#39;': "'"
  };
  
  for (const [entity, char] of Object.entries(entities)) {
    html = html.replace(new RegExp(entity, 'g'), char);
  }
  
  // 解码数字实体
  html = html.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  html = html.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  
  // 压缩连续空行
  html = html.replace(/\n\s*\n\s*\n/g, '\n\n');
  
  // 去除首尾空白
  return html.trim();
}
