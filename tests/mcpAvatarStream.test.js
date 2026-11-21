'use strict';
/**
 * 头像推流协议单测：
 *  - 新协议：avatarStart 可传 maxWidth/fps/format/quality/binary/trim，WS 二进制帧推送图片原始字节；
 *  - 旧协议兼容：binary=false 时仍走 JSON + base64 的 pet/avatarFrame 通知；
 *  - stop 后不再推帧。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const WebSocket = require('ws');

const mod = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpServer.js'));
const TOKEN = 'avatar-test-token-0123456789abcdef';

function baseDeps(extra = {}) {
  return {
    say: (t) => t,
    emotion: () => 'ok',
    motion: () => 'ok',
    status: () => 'status',
    todoAdd: () => 'ok',
    todoList: () => 'none',
    screenshot: async () => ({ base64: '', savedPath: 'x' }),
    chat: async (t) => t,
    ask: async () => 'ok',
    noteAdd: () => 'ok',
    reminderAdd: () => 'ok',
    resourceList: () => [],
    resourceRead: () => null,
    ...extra,
  };
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const frames = [];
    const textMessages = [];
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        frames.push(Buffer.from(data));
      } else {
        try {
          textMessages.push(JSON.parse(String(data)));
        } catch {
          /* ignore */
        }
      }
    });
    ws.on('open', () => resolve({ ws, frames, textMessages }));
    ws.on('error', reject);
  });
}

function waitFor(check, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('头像流：二进制帧 + 参数透传 + 旧 JSON 兼容 + stop 生效', async () => {
  const seenOpts = [];
  const server = new mod.PetMcpServer({
    configPath: path.join(__dirname, 'fixtures', 'never-written.json'),
    readInitial: () => ({ enabled: true, lan: false, port: 0, token: TOKEN }),
    persist: () => {},
    deps: baseDeps({
      avatarFrame: async (opts) => {
        seenOpts.push(opts);
        return { buffer: Buffer.from('fake-image-bytes'), width: 12, height: 34, format: opts.format, bytes: 16 };
      },
    }),
  });
  await server.start();
  const port = Number(server.statusText().match(/:(\d+)\/mcp/)[1]);
  const { ws, frames, textMessages } = await openWs(port);
  try {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }));
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'pet/avatarStart',
        params: { maxWidth: 1024, fps: 30, format: 'jpeg', quality: 90, binary: true, trim: true },
      }),
    );
    await waitFor(() => seenOpts.length > 0 && frames.length > 0);
    assert.deepEqual(seenOpts[0], {
      maxWidth: 1024,
      fps: 30,
      quality: 90,
      format: 'jpeg',
      trim: true,
      binary: true,
    });
    assert.equal(frames[0].toString(), 'fake-image-bytes');
    const ack = textMessages.find((m) => m.id === 2);
    assert.equal(ack.result.ok, true);
    assert.equal(ack.result.binary, true);
    assert.equal(ack.result.format, 'jpeg');

    // 停流后不再有新帧
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'pet/avatarStop', params: {} }));
    await new Promise((r) => setTimeout(r, 120));
    const count = frames.length;
    await new Promise((r) => setTimeout(r, 260));
    assert.equal(frames.length, count);

    // 旧客户端：binary=false → JSON + base64 通知
    seenOpts.length = 0;
    frames.length = 0;
    textMessages.length = 0;
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'pet/avatarStart',
        params: { maxWidth: 220 },
      }),
    );
    await waitFor(() => textMessages.some((m) => m.method === 'pet/avatarFrame'));
    assert.equal(seenOpts[0].format, 'png');
    assert.equal(seenOpts[0].binary, false);
    assert.equal(seenOpts[0].trim, true);
    const legacy = textMessages.find((m) => m.method === 'pet/avatarFrame');
    assert.equal(Buffer.from(legacy.params.data, 'base64').toString(), 'fake-image-bytes');
    assert.equal(legacy.params.width, 12);
    assert.equal(legacy.params.height, 34);
  } finally {
    try { ws.close(); } catch { /* ignore */ }
    server.dispose();
  }
});
