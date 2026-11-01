/**
 * mockVtsServer.js —— 极简 WebSocket 服务端，用来模拟 VTube Studio 的插件 API（8001）。
 *
 * 为什么不引依赖：项目依赖里只有 ws（随 msedge-tts 引入，供 Electron 主进程用）。
 * 测试这边只要一个能握手、能收发文本帧的假服务端，用 node:http + node:crypto 手写
 * 约 150 行即可，不去动生产依赖，也不依赖 ws 的传递安装位置。
 *
 * 支持：握手、文本帧（含分片）、ping/pong、close；服务端只发文本帧。
 * 不支持的（测试用不到）：扩展协商、压缩、二进制业务帧。
 */
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 组一个服务端→客户端的帧（服务端帧不掩码） */
function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.alloc(2);
    header[1] = data.length;
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

/**
 * 增量帧解析器：把 socket 上收到的字节流切成消息。
 * onMessage(Buffer) / onControl('ping'|'pong'|'close', Buffer)
 */
function createFrameParser(onMessage, onControl) {
  let buffered = Buffer.alloc(0);
  let fragments = [];
  let fragmented = false;

  return function feed(chunk) {
    buffered = Buffer.concat([buffered, chunk]);
    for (;;) {
      if (buffered.length < 2) return;
      const b0 = buffered[0];
      const b1 = buffered[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buffered.length < 4) return;
        len = buffered.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buffered.length < 10) return;
        len = Number(buffered.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buffered.length < offset + 4) return;
        mask = buffered.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffered.length < offset + len) return;
      const payload = Buffer.from(buffered.subarray(offset, offset + len));
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
      buffered = buffered.subarray(offset + len);

      if (opcode === 0x9) { onControl('ping', payload); continue; }
      if (opcode === 0x0a) { onControl('pong', payload); continue; }
      if (opcode === 0x08) { onControl('close', payload); return; }
      if (opcode === 0x00) {
        if (!fragmented) continue;
        fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = [];
          fragmented = false;
          onMessage(whole);
        }
        continue;
      }
      if (opcode === 0x01 || opcode === 0x02) {
        if (!fin) {
          fragments = [payload];
          fragmented = true;
          continue;
        }
        if (fragmented) {
          fragments.push(payload);
          const whole = Buffer.concat(fragments);
          fragments = [];
          fragmented = false;
          onMessage(whole);
        } else {
          onMessage(payload);
        }
      }
    }
  };
}

/**
 * 起一个 mock VTS。
 *
 * @param {(message: any, conn: any) => any|Promise<any>} [handler]
 *        收到请求后返回要发回的对象；返回 undefined/null 表示「这次不回」（用来测超时）。
 * @returns {Promise<{
 *   url: string,
 *   requests: any[],
 *   errors: Error[],
 *   connectionCount(): number,
 *   setHandler(fn: Function): void,
 *   sockets: Set<any>,
 *   close(): Promise<void>
 * }>}
 */
async function createMockVtsServer(handler) {
  const state = {
    handler: typeof handler === 'function' ? handler : () => ({ ok: true }),
    requests: [],
    errors: [],
    sockets: new Set(),
    connectionCount: 0,
  };

  const server = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain' });
    res.end('WebSocket only');
  });

  server.on('upgrade', (req, socket) => {
    socket.on('error', () => { /* 客户端断开是常态，别让测试因为 EPIPE 挂掉 */ });
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));

    state.connectionCount += 1;

    const conn = {
      /** 发一条文本（业务载荷） */
      send(message) {
        const text = typeof message === 'string' ? message : JSON.stringify(message);
        try { socket.write(encodeFrame(0x01, text)); } catch { /* 已断开 */ }
      },
      /** 正常关闭（发 close 帧） */
      close(code = 1000) {
        try { socket.write(encodeFrame(0x08, Buffer.from([(code >> 8) & 0xff, code & 0xff]))); } catch { /* 忽略 */ }
        try { socket.end(); } catch { /* 忽略 */ }
      },
      /** 粗暴断开（模拟进程崩了 / 网线被拔） */
      destroy() {
        try { socket.destroy(); } catch { /* 忽略 */ }
      },
      reply(requestID, messageType, data) {
        conn.send({
          apiName: 'VTubeStudioPublicAPI',
          apiVersion: '1.0',
          timestamp: new Date().toISOString(),
          requestID,
          messageType,
          data: data ?? {},
        });
      },
    };
    state.sockets.add(conn);
    socket.on('close', () => state.sockets.delete(conn));

    const feed = createFrameParser(
      (payload) => {
        const text = payload.toString('utf8');
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          message = { __raw: text };
        }
        state.requests.push(message);
        Promise.resolve()
          .then(() => state.handler(message, conn))
          .then((reply) => {
            if (reply === undefined || reply === null) return;
            conn.send(reply);
          })
          .catch((err) => state.errors.push(err));
      },
      (kind, payload) => {
        if (kind === 'ping') { try { socket.write(encodeFrame(0x0a, payload)); } catch { /* 忽略 */ } }
        else if (kind === 'close') conn.close(1000);
      },
    );
    socket.on('data', feed);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    url: `ws://127.0.0.1:${port}`,
    requests: state.requests,
    errors: state.errors,
    sockets: state.sockets,
    connectionCount: () => state.connectionCount,
    setHandler(fn) { state.handler = fn; },
    /** 只关服务端监听（不动已有连接），用来测「连不上」 */
    async closeServerOnly() {
      await new Promise((resolve) => server.close(() => resolve()));
    },
    async close() {
      for (const conn of state.sockets) conn.destroy();
      state.sockets.clear();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createMockVtsServer };
