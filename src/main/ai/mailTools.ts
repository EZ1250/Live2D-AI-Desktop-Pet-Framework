//
// 此模块提供两种邮件功能：
// 1. mailCompose：调用系统默认邮件客户端起草新邮件，无需配置。
// 2. mailCheck：通过 IMAP 协议检查邮箱中的未读邮件，需用户提供 IMAP 配置。
//
// 设计说明：
// - mailCompose 使用 mailto: 协议唤起本地客户端，安全可靠且无需账号权限。
// - mailCheck 自行实现 IMAP 客户端逻辑，避免引入第三方库导致的安全风险和打包体积问题。
// - 所有网络操作均限制超时时间和数据大小，防止阻塞或资源耗尽。
// - BODY.PEEK 是关键点，确保获取邮件时不将“未读”标记为“已读”。

import { shell } from 'electron';
import * as net from 'net';
import * as tls from 'tls';

// ==================== 工具函数 ====================

function isValidEmail(email: string): boolean {
  return email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return '未知时间';

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());

  const diffDays = Math.floor((today.getTime() - msgDate.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return `今天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  } else if (diffDays === 1) {
    return `昨天 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  } else {
    return `${msgDate.getMonth() + 1}月${msgDate.getDate()}日 ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
  }
}

function decodeMimeWord(str: string): string {
  try {
    const match = str.match(/\=\?([^?]+)\?([BQ])\?([^?]*)\?\=/i);
    if (!match) return str;

    const [, charset, encoding, payload] = match;
    let buffer: Buffer;

    if (encoding.toUpperCase() === 'B') {
      buffer = Buffer.from(payload, 'base64');
    } else if (encoding.toUpperCase() === 'Q') {
      buffer = Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
    } else {
      return str;
    }

    return decodeBytes(buffer, charset);
  } catch {
    return str;
  }
}

/**
 * 按 charset 解码字节，**不依赖 iconv-lite**：Node 自带 ICU 的 TextDecoder 就支持 gbk/big5/
 * shift_jis 等常见邮件编码。TextDecoder 不认的编码退回 utf-8，再不行退回 latin1（保证不抛）。
 */
function decodeBytes(buffer: Buffer, charset: string): string {
  const cs = (charset || 'utf-8').trim().toLowerCase().replace(/^["']|["']$/g, '');
  const alias: Record<string, string> = {
    'gb2312': 'gbk', 'gb18030': 'gbk', 'cp936': 'gbk',
    'utf8': 'utf-8', 'utf-8': 'utf-8',
    'ks_c_5601-1987': 'euc-kr', 'iso-8859-1': 'latin1',
  };
  const name = alias[cs] || cs;
  try {
    return new TextDecoder(name).decode(buffer);
  } catch {
    try { return new TextDecoder('utf-8').decode(buffer); }
    catch { return buffer.toString('latin1'); }
  }
}

/**
 * 展开折行（RFC 5322 header folding）：以空白开头的行是上一行的续行。
 * 必须先展开再解析，否则超长主题会被截断成半句。
 */
function unfoldHeaders(block: string): string[] {
  const out: string[] = [];
  for (const raw of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(raw) && out.length) out[out.length - 1] += ' ' + raw.trim();
    else if (raw.trim()) out.push(raw);
  }
  return out;
}

function parseHeaderLine(line: string): [string, string] | null {
  const colonIndex = line.indexOf(':');
  if (colonIndex === -1) return null;

  const key = line.substring(0, colonIndex).trim().toLowerCase();
  let value = line.substring(colonIndex + 1).trim();

  // 折行由 unfoldHeaders() 在解析前处理，这里不再自行拼接
  // （早先这里写了个 `const nextLine = ''` 的死循环，既没展开折行、又会吃掉以逗号结尾的值）

  // 解码 MIME word（=?...?B/Q?...?=，中文主题几乎都是这种）
  value = value.replace(/\=\?[^?]+\?[BQ]\?[^?]*\?\=/gi, (part) => decodeMimeWord(part));

  return [key, value];
}

// ==================== 接口定义 ====================

export interface ComposeArgs {
  to?: unknown;
  subject?: unknown;
  body?: unknown;
}

export interface ImapConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  secure?: boolean;
}

export interface CheckArgs {
  limit?: unknown;
  unseen_only?: unknown;
}

// ==================== 功能实现 ====================

export async function mailCompose(args: ComposeArgs): Promise<string> {
  const toRaw = typeof args.to === 'string' ? args.to : '';
  const subjectRaw = typeof args.subject === 'string' ? args.subject : '';
  const bodyRaw = typeof args.body === 'string' ? args.body : '';

  if (toRaw.length > 200) return '收件人太长了，请控制在 200 字以内';
  if (subjectRaw.length > 200) return '主题太长了，请控制在 200 字以内';
  if (bodyRaw.length > 4000) return '正文太长了，请控制在 4000 字以内';

  let toList = '';
  if (toRaw) {
    const emails = toRaw.split(',').map(e => e.trim()).filter(Boolean);
    for (const email of emails) {
      if (!isValidEmail(email)) {
        return `看起来有个邮箱地址不太对劲：“${email}”，不过你还是可以继续发送`;
      }
    }
    toList = emails.join(',');
  }

  const subject = encodeURIComponent(subjectRaw);
  const body = encodeURIComponent(bodyRaw).replace(/%0A/g, '%0D%0A');

  let url = 'mailto:';
  if (toList) {
    // 收件人这一段按 RFC 6068 属于 addr-spec：`@` 与分隔多个地址的 `,` 本身就是允许字符，
    // 编码成 %40/%2C 虽然多数客户端也认，但裸写兼容性更好（部分老客户端不解码 %40）。
    // 其余字符（空格、非 ASCII 等）仍必须编码。
    url += encodeURIComponent(toList).replace(/%40/gi, '@').replace(/%2C/gi, ',');
  }
  if (subject || body) {
    url += '?';
    const parts = [];
    if (subject) parts.push(`subject=${subject}`);
    if (body) parts.push(`body=${body}`);
    url += parts.join('&');
  }

  try {
    await shell.openExternal(url);
    const displayTo = toList || '未填';
    return `已打开邮件草稿（收件人：${displayTo}）。内容有需要改的地方直接在客户端里改就行啦！`;
  } catch (err) {
    return `没能打开邮件客户端：${(err as Error).message || '未知错误'}`;
  }
}

export async function mailCheck(args: CheckArgs, cfg: ImapConfig): Promise<string> {
  // 校验配置
  if (
    typeof cfg.host !== 'string' ||
    typeof cfg.port !== 'number' ||
    typeof cfg.user !== 'string' ||
    typeof cfg.pass !== 'string'
  ) {
    return '还没配置邮箱。想看邮件请在设置里填 IMAP 服务器、端口、账号和密码（授权码）。只想写信的话可以直接让我起草。';
  }

  if (!cfg.host || cfg.port <= 0 || cfg.port > 65535 || !cfg.user || !cfg.pass) {
    return '还没配置邮箱。想看邮件请在设置里填 IMAP 服务器、端容（授权码）。只想写信的话可以直接让我起草。';
  }

  const limit = (() => {
    const val = Number(args.limit);
    if (Number.isInteger(val) && val >= 1 && val <= 30) return val;
    return 10;
  })();

  const unseenOnly = args.unseen_only !== false;

  return new Promise((resolve) => {
    let resolved = false;
    const timeoutTimer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        resolve('连接超时，请稍后再试');
      }
    }, 20000);

    // 用对象形式的 tls.connect：三元表达式里混用 tls/net 会让 TS 的重载解析失败
    // （tls.connect(port, host, cb) 这个重载在 @types/node 里不存在）。统一成 net.Socket 类型。
    const socket: net.Socket = cfg.secure !== false
      ? tls.connect({ port: cfg.port, host: cfg.host, rejectUnauthorized: true })
      : net.connect({ port: cfg.port, host: cfg.host });

    socket.setTimeout(20000);
    let buffer = '';
    let tagCounter = 1;
    let totalMessages = 0;
    let messageIds: number[] = [];

    const sendCommand = (cmd: string): string => {
      const tag = `a${tagCounter++}`;
      socket.write(`${tag} ${cmd}\r\n`);
      return tag;
    };

    const readLines = (): string[] => {
      const lines = buffer.split('\r\n');
      buffer = lines.pop() || '';
      return lines;
    };

    const closeSocket = () => {
      try {
        socket.destroy();
      } catch {}
    };

    const failWithMessage = (msg: string) => {
      clearTimeout(timeoutTimer);
      if (!resolved) {
        resolved = true;
        closeSocket();
        resolve(msg);
      }
    };

    socket.on('error', (err) => {
      failWithMessage(`连接失败：${(err as Error).message}`);
    });

    socket.on('timeout', () => {
      failWithMessage('连接超时，请检查网络或服务器是否可达');
    });

    socket.on('data', async (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = readLines();

      for (const line of lines) {
        if (/^a\d+ (OK|NO|BAD)/.test(line)) {
          const tagMatch = line.match(/^a(\d+)/);
          if (!tagMatch) continue;

          const tagNum = parseInt(tagMatch[1], 10);
          if (tagNum === 1) { // LOGIN response
            if (!line.includes('OK')) {
              failWithMessage('登录被拒绝，多数邮箱需要先在网页端开启 IMAP 并生成授权码（不是登录密码）');
              return;
            }
          } else if (tagNum === 2) { // SELECT response
            if (!line.includes('OK')) {
              failWithMessage('无法选择收件箱，请确认账户权限正常');
              return;
            }
          } else if (tagNum === 3) { // SEARCH response
            if (!line.includes('OK')) {
              failWithMessage('搜索邮件失败');
              return;
            }
            const matches = line.match(/\* SEARCH ([\d\s]+)/);
            if (matches && matches[1]) {
              messageIds = matches[1].split(/\s+/).map(Number).filter(n => n > 0);
            }
          } else if (tagNum === 4) { // FETCH responses handled separately
            continue;
          } else if (tagNum === 5) { // LOGOUT response
            closeSocket();
            clearTimeout(timeoutTimer);
            if (!resolved) {
              resolved = true;
              resolve(buildResult(totalMessages, messageIds));
            }
            return;
          }
        } else if (line.startsWith('* ')) {
          if (line.includes('EXISTS')) {
            const match = line.match(/\* (\d+) EXISTS/);
            if (match) totalMessages = parseInt(match[1], 10);
          } else if (line.includes('FETCH')) {
            handleFetchResponse(line);
          }
        }
      }
    });

    const fetchedHeaders: Record<number, { from?: string; subject?: string; date?: string }> = {};
    let fetchCount = 0;

    const handleFetchResponse = (line: string) => {
      const idMatch = line.match(/\* (\d+) FETCH/);
      if (!idMatch) return;

      const id = parseInt(idMatch[1], 10);
      const headerMatch = line.match(/\{(\d+)\}/);
      if (!headerMatch) return;

      const size = parseInt(headerMatch[1], 10);
      if (size > 10240) return; // Skip large headers

      const startIdx = line.indexOf('\r\n') + 2;
      if (startIdx < 2) return;

      const rawHeader = line.substring(startIdx);
      const headerLines = rawHeader.split('\r\n').filter(l => l.trim());

      const parsed: { from?: string; subject?: string; date?: string } = {};
      for (const hLine of headerLines) {
        const parsedLine = parseHeaderLine(hLine);
        if (!parsedLine) continue;
        const [key, value] = parsedLine;
        if (key === 'from') parsed.from = value;
        else if (key === 'subject') parsed.subject = value;
        else if (key === 'date') parsed.date = value;
      }

      fetchedHeaders[id] = parsed;
      fetchCount++;

      if (fetchCount === Math.min(limit, messageIds.length)) {
        sendCommand('LOGOUT');
      }
    };

    const buildResult = (total: number, ids: number[]): string => {
      const filteredIds = ids.slice(-limit);
      const resultLines = [`收件箱：${filteredIds.length} 封${unseenOnly ? '未读' : ''}（共 ${total} 封）\r\n`];

      if (filteredIds.length === 0) {
        return `收件箱${unseenOnly ? '没有未读邮件' : '暂无邮件'}（共 ${total} 封）。`;
      }

      for (let i = 0; i < filteredIds.length; i++) {
        const id = filteredIds[i];
        const info = fetchedHeaders[id] || {};
        const fromDisplay = info.from?.substring(0, 40) || '未知发件人';
        const subjectDisplay = (info.subject || '(无主题)').substring(0, 60) + ((info.subject || '').length > 60 ? '…' : '');
        const dateDisplay = info.date ? formatDate(info.date) : '未知时间';

        resultLines.push(`${id}.  ${fromDisplay.padEnd(40)}   ${dateDisplay}\r\n    ${subjectDisplay}\r\n`);
      }

      return resultLines.join('');
    };

    socket.on('connect', () => {
      sendCommand(`LOGIN "${cfg.user.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}" "${cfg.pass.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
      sendCommand('SELECT INBOX');
      sendCommand(unseenOnly ? 'SEARCH UNSEEN' : 'SEARCH ALL');
      setTimeout(() => {
        const lastBatch = messageIds.slice(-limit);
        for (const id of lastBatch) {
          sendCommand(`FETCH ${id} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`);
        }
      }, 100);
    });
  });
}
