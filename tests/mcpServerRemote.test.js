'use strict';
/**
 * MCP 服务端远程访问 / WS 双通道单测：
 *  - LAN 配置解析（默认 false，显式 true 才开启）
 *  - HTTP Bearer 鉴权（错误 token 401）
 *  - tools/list 动态返回
 *  - /ws 握手鉴权（无 token 401，带 token 101），为 Android 客户端双通道提供依据
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');

const mod = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpServer.js'));
const TOKEN = 'test-token-0123456789abcdef0123456789';
const deps = {
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
};

function wsHandshake(port, token) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const q = token === null ? '' : `?token=${token}`;
      socket.write(
        `GET /ws${q} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
      );
    });
    let data = '';
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n\r\n')) {
        socket.destroy();
        resolve(data);
      }
    });
    socket.on('error', () => resolve(data));
    setTimeout(() => { socket.destroy(); resolve(data); }, 2000);
  });
}

test('LAN 配置：默认 false，显式 true 才开启', () => {
  assert.equal(mod.loadPetMcpServerConfig(null).cfg.lan, false);
  assert.equal(mod.loadPetMcpServerConfig('{"enabled":true}').cfg.lan, false);
  assert.equal(mod.loadPetMcpServerConfig('{"enabled":true,"lan":true}').cfg.lan, true);
});

test('HTTP 鉴权 + tools/list + WS 握手鉴权', async () => {
  const server = new mod.PetMcpServer({
    configPath: path.join(__dirname, 'fixtures', 'never-written.json'),
    readInitial: () => ({ enabled: true, lan: false, port: 0, token: TOKEN }),
    persist: () => {}, // 测试不落盘
    deps,
  });
  await server.start();
  const status = server.statusText();
  const m = status.match(/:(\d+)\/mcp/);
  assert.ok(m, 'statusText 应包含实际端口');
  const port = Number(m[1]);

  // 未授权
  const bad = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(bad.status, 401);

  // 授权 + 动态工具列表
  const ok = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(ok.status, 200);
  const payload = await ok.json();
  assert.ok(Array.isArray(payload.result.tools) && payload.result.tools.length > 0);
  assert.ok(payload.result.tools.every((t) => typeof t.name === 'string' && t.name.length > 0));

  // WS：无 token 401；有 token 101
  const noToken = await wsHandshake(port, null);
  assert.match(noToken, /^HTTP\/1\.1 401/);
  const goodToken = await wsHandshake(port, TOKEN);
  assert.match(goodToken, /^HTTP\/1\.1 101/);
  assert.match(goodToken, /Sec-WebSocket-Accept:/i);

  server.dispose();
});
