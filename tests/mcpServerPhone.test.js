'use strict';
/**
 * phone/* 桥接单测（qq-bridge host bridge + VCPToolBox 异步插件/手机原生工具思路）：
 * 注册 → tools/list 动态出现 phone_* → 调用挂起 → 手机长轮询取任务 → result 回执解析；超时返回错误。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const mod = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpServer.js'));
const TOKEN = 'phone-bridge-token-0123456789abcdef';
const deps = {
  say: (t) => t, emotion: () => 'ok', motion: () => 'ok', status: () => 'status',
  todoAdd: () => 'ok', todoList: () => 'none',
  screenshot: async () => ({ base64: '', savedPath: 'x' }),
  chat: async (t) => t, ask: async () => 'ok', noteAdd: () => 'ok', reminderAdd: () => 'ok',
  resourceList: () => [], resourceRead: () => null,
};

async function startServer(phoneCallTimeoutMs = 1200) {
  const server = new mod.PetMcpServer({
    configPath: path.join(__dirname, 'fixtures', 'never-written.json'),
    readInitial: () => ({ enabled: true, lan: false, port: 0, token: TOKEN }),
    persist: () => {},
    phoneCallTimeoutMs,
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
  return { server, port, rpc };
}

test('phone/register → tools/list 动态包含 phone_*，非法名称被拒', async () => {
  const { server, rpc } = await startServer();
  const base = (await rpc('tools/list', {})).result.tools;
  const reg = await rpc('phone/register', {
    tools: [
      { name: 'battery', description: '手机电量', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
      { name: 'clipboard_write', description: '写剪贴板', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: false } },
    ],
  });
  assert.deepEqual(reg.result.tools, ['phone_battery', 'phone_clipboard_write']);
  const listed = (await rpc('tools/list', {})).result.tools;
  assert.equal(listed.length, base.length + 2);
  assert.ok(listed.some((t) => t.name === 'phone_battery' && t.annotations.readOnlyHint === true));

  const bad = await rpc('phone/register', { tools: [{ name: 'Bad Name!', description: 'x' }] });
  assert.ok(bad.error, '非法手机工具名应返回错误');
  server.dispose();
});

test('tools/call 手机工具 → phone/poll 取任务 → phone/result 回执', async () => {
  const { server, rpc } = await startServer();
  await rpc('phone/register', {
    tools: [{ name: 'battery', description: '手机电量', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } }],
  });
  const callPromise = rpc('tools/call', { name: 'phone_battery', arguments: {} });
  const poll = await rpc('phone/poll', { waitMs: 3000 });
  assert.ok(poll.result.call, '手机应能轮询到待执行调用');
  assert.equal(poll.result.call.name, 'battery');
  await rpc('phone/result', { id: poll.result.call.id, text: '电量 88%' });
  const called = await callPromise;
  assert.equal(called.result.content[0].text, '电量 88%');
  server.dispose();
});

test('手机超时不回执 → tools/call 返回超时错误（fail-closed）', async () => {
  const { server, rpc } = await startServer(800);
  await rpc('phone/register', {
    tools: [{ name: 'clipboard_write', description: '写剪贴板', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: false } }],
  });
  const started = Date.now();
  const res = await rpc('tools/call', { name: 'phone_clipboard_write', arguments: { text: 'hi' } });
  assert.ok(Date.now() - started >= 700);
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /没有返回结果/);
  server.dispose();
});
