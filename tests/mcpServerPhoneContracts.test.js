'use strict';
/** 手机接口契约回归：pet_chat_detail / pet_chat_history 的 JSON 结构，防止两端漂移。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpServer.js'));
const TOKEN = 'contract-token-0123456789abcdef';

async function startServer(extraDeps = {}) {
  const deps = {
    say: (t) => t, emotion: () => 'ok', motion: () => 'ok', status: () => 'status',
    todoAdd: () => 'ok', todoList: () => 'none',
    screenshot: async () => ({ base64: '', savedPath: 'x' }),
    chat: async (t) => t, ask: async () => 'ok', noteAdd: () => 'ok', reminderAdd: () => 'ok',
    resourceList: () => [], resourceRead: () => null,
    ...extraDeps,
  };
  const server = new mod.PetMcpServer({
    configPath: path.join(__dirname, 'fixtures', 'never-written.json'),
    readInitial: () => ({ enabled: true, lan: false, port: 0, token: TOKEN }),
    persist: () => {},
    phoneCallTimeoutMs: 500,
    deps,
  });
  await server.start();
  const m = server.statusText().match(/:(\d+)\/mcp/);
  assert.ok(m);
  const port = Number(m[1]);
  const rpc = async (method, params) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: Math.floor(Math.random() * 1e6), method, params }),
    });
    assert.equal(res.status, 200);
    return await res.json();
  };
  return { server, rpc };
}

test('pet_chat_detail 契约：返回 JSON {reply, thinking}', async () => {
  const { server, rpc } = await startServer({
    chatDetail: async () => ({ reply: '等于 4', thinking: '2+2=4' }),
  });
  try {
    const res = await rpc('tools/call', { name: 'pet_chat_detail', arguments: { text: '2+2 等于几' } });
    const text = res.result.content[0].text;
    assert.deepEqual(JSON.parse(text), { reply: '等于 4', thinking: '2+2=4' });
  } finally {
    server.dispose();
  }
});

test('pet_chat_history 契约：列表与读取都是 JSON，字段固定', async () => {
  const sessions = [{ id: 's1', title: '新对话', startedAt: 1, count: 2 }];
  const entries = [{ role: 'user', text: 'hi', at: 1 }, { role: 'pet', text: 'hello', at: 2 }];
  const { server, rpc } = await startServer({
    chatHistory: (sessionId, limit) => JSON.stringify(sessionId ? entries.slice(-limit) : sessions),
  });
  try {
    const list = await rpc('tools/call', { name: 'pet_chat_history', arguments: {} });
    assert.deepEqual(JSON.parse(list.result.content[0].text), sessions);
    const read = await rpc('tools/call', { name: 'pet_chat_history', arguments: { sessionId: 's1', limit: 10 } });
    assert.deepEqual(JSON.parse(read.result.content[0].text), entries);
  } finally {
    server.dispose();
  }
});
