'use strict';
/** 验证 MCP 服务端配置、鉴权、JSON-RPC 和工具调用。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpServer.js');
const srvMod = require(DIST);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-mcp-server-'));
}

function fakeDeps(calls) {
  return {
    say: (text) => {
      calls.push(['say', text]);
      return `已让桌宠说：${text}`;
    },
    emotion: (name) => {
      calls.push(['emotion', name]);
      return `已切换表情：${name}`;
    },
    motion: (group) => {
      calls.push(['motion', group]);
      return `已播放动作：${group}`;
    },
    status: () => {
      calls.push(['status']);
      return '桌宠状态：测试模型 / 待办 2 条';
    },
    todoAdd: (text) => {
      calls.push(['todoAdd', text]);
      return '已添加待办，共 3 条。';
    },
    todoList: () => {
      calls.push(['todoList']);
      return '[ ] 1. 买菜';
    },
    screenshot: async () => {
      calls.push(['screenshot']);
      return { base64: Buffer.from('fake-png').toString('base64'), savedPath: 'C:/fake/shot.png' };
    },
    chat: async (prompt) => {
      calls.push(['chat', prompt]);
      return `AI:${prompt}`;
    },
    ask: async (question, options) => {
      calls.push(['ask', question, options]);
      return '允许';
    },
    noteAdd: (text) => {
      calls.push(['noteAdd', text]);
      return `已保存笔记：${text}`;
    },
    reminderAdd: (text, afterMinutes) => {
      calls.push(['reminderAdd', text, afterMinutes]);
      return `已添加提醒（${afterMinutes} 分钟后）：${text}`;
    },
    resourceList: () => [
      { uri: 'pet://status', name: '桌宠状态' },
      { uri: 'pet://todos', name: '待办列表' },
    ],
    resourceRead: (uri) => (uri === 'pet://status' ? '状态：测试' : null),
  };
}

function postJson(port, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, text });
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

test('配置：缺失=不启动；非法 JSON=不启动；enabled=true 才启动并生成 token', async () => {
  // 缺失
  const dir1 = tempDir();
  const calls = [];
  const a = new srvMod.PetMcpServer({ configPath: path.join(dir1, 'mcp-server.json'), deps: fakeDeps(calls) });
  await a.start();
  assert.match(a.statusText(), /未启用/);
  a.dispose();
  fs.rmSync(dir1, { recursive: true, force: true });

  // 非法 JSON
  const dir2 = tempDir();
  const bad = path.join(dir2, 'mcp-server.json');
  fs.writeFileSync(bad, '{oops', 'utf8');
  const b = new srvMod.PetMcpServer({ configPath: bad, deps: fakeDeps([]), log: () => {} });
  await b.start();
  assert.match(b.statusText(), /未启用/);
  b.dispose();
  fs.rmSync(dir2, { recursive: true, force: true });

  // enabled=false
  const dir3 = tempDir();
  const off = path.join(dir3, 'mcp-server.json');
  fs.writeFileSync(off, JSON.stringify({ enabled: false }), 'utf8');
  const c = new srvMod.PetMcpServer({ configPath: off, deps: fakeDeps([]) });
  await c.start();
  assert.match(c.statusText(), /未启用/);
  c.dispose();
  fs.rmSync(dir3, { recursive: true, force: true });

  // enabled=true：自动生成 token 并回写
  const dir4 = tempDir();
  const cfgPath = path.join(dir4, 'mcp-server.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, port: 0 }), 'utf8');
  const d = new srvMod.PetMcpServer({ configPath: cfgPath, deps: fakeDeps([]) });
  await d.start();
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.equal(saved.enabled, true);
  assert.ok(typeof saved.token === 'string' && saved.token.length >= 16, '应生成 token');
  assert.ok(saved.port > 0, '随机端口应回写');
  assert.match(d.statusText(), /已启动 http:\/\/127\.0\.0\.1:\d+\/mcp/);
  assert.match(d.statusText(), /可用：pet_say, pet_status/, '/mcp 应列出服务端工具名');
  d.dispose();
  fs.rmSync(dir4, { recursive: true, force: true });
});

test('热重载 mcp-server.json：关闭后停监听，重新开启后换端口重启', async () => {
  const dir = tempDir();
  const cfgPath = path.join(dir, 'mcp-server.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, port: 0 }), 'utf8');
  const server = new srvMod.PetMcpServer({ configPath: cfgPath, deps: fakeDeps([]), log: () => {} });
  await server.start();
  const firstPort = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).port;
  assert.ok(firstPort > 0);
  try {
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: false }), 'utf8');
    await server.reload();
    assert.match(server.statusText(), /未启用/);
    fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, port: 0 }), 'utf8');
    await server.reload();
    assert.match(server.statusText(), /已启动/);
    const secondPort = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).port;
    assert.ok(secondPort > 0);
  } finally {
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('设置驱动模式：readInitial 提供开关/端口，persist 回写生成的 token 与实际端口', async () => {
  const dir = tempDir();
  const persisted = [];
  const server = new srvMod.PetMcpServer({
    configPath: path.join(dir, 'mcp-server.json'),
    deps: fakeDeps([]),
    log: () => {},
    readInitial: () => ({ enabled: true, port: 0, token: '' }),
    persist: (cfg) => persisted.push(cfg),
  });
  try {
    await server.start();
    assert.match(server.statusText(), /已启动 http:\/\/127\.0\.0\.1:\d+\/mcp/);
    assert.match(server.statusText(), /设置页/);
    assert.equal(persisted.length, 1, '启动后应回写一次配置');
    assert.ok(persisted[0].port > 0 && persisted[0].token.length >= 16, '回写实际端口与生成 token');
    assert.ok(!fs.existsSync(path.join(dir, 'mcp-server.json')), '设置驱动模式不应再写 mcp-server.json');
    await server.reload();
    assert.equal(persisted.length, 2, '重载后应再回写一次');
  } finally {
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP：鉴权 + initialize/tools/list/tools/call + 通知 202 + GET 405', async () => {
  const dir = tempDir();
  const cfgPath = path.join(dir, 'mcp-server.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ enabled: true, port: 0 }), 'utf8');
  const calls = [];
  const server = new srvMod.PetMcpServer({ configPath: cfgPath, version: 'test-1', deps: fakeDeps(calls), log: () => {} });
  await server.start();
  const saved = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const port = saved.port;
  const token = saved.token;
  try {
    // 无 token / 错 token
    const unauth = await postJson(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(unauth.status, 401);
    const wrong = await postJson(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, 'wrong-token');
    assert.equal(wrong.status, 401);

    // initialize
    const init = await postJson(port, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, token);
    assert.equal(init.status, 200);
    assert.equal(init.json.result.serverInfo.name, 'pet-desktop-app');
    assert.ok(init.json.result.capabilities.tools, '应声明 tools 能力');
    assert.equal(init.json.result.protocolVersion, '2025-06-18');

    // 通知 → 202
    const note = await postJson(port, { jsonrpc: '2.0', method: 'notifications/initialized' }, token);
    assert.equal(note.status, 202);

    // tools/list
    const list = await postJson(port, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token);
    const names = list.json.result.tools.map((t) => t.name);
    for (const expected of ['pet_say', 'pet_status', 'pet_emotion', 'pet_motion', 'pet_todo_add', 'pet_todo_list', 'pet_screenshot', 'pet_chat', 'pet_ask', 'pet_note_add', 'pet_reminder_add']) {
      assert.ok(names.includes(expected), `缺少工具：${expected}`);
    }
    const statusTool = list.json.result.tools.find((t) => t.name === 'pet_status');
    assert.equal(statusTool.annotations.readOnlyHint, true);

    // tools/call：status / say / todo / screenshot
    const status = await postJson(port, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'pet_status', arguments: {} } }, token);
    assert.ok(status.json.result.content[0].text.includes('桌宠状态'));
    const say = await postJson(port, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'pet_say', arguments: { text: '远程提醒：喝水' } } }, token);
    assert.ok(say.json.result.content[0].text.includes('喝水'));
    const todo = await postJson(port, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'pet_todo_add', arguments: { text: '买菜' } } }, token);
    assert.ok(todo.json.result.content[0].text.includes('已添加待办'));
    const shot = await postJson(port, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'pet_screenshot', arguments: {} } }, token);
    assert.equal(shot.json.result.content[0].type, 'image');
    assert.ok(shot.json.result.content[1].text.includes('已截屏'));

    // 未知工具 / 参数错误 → isError（不抛 JSON-RPC 错误）
    const unknown = await postJson(port, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } }, token);
    assert.equal(unknown.json.result.isError, true);
    const emptySay = await postJson(port, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'pet_say', arguments: {} } }, token);
    assert.equal(emptySay.json.result.isError, true);

    // 未知方法 → JSON-RPC error
    const badMethod = await postJson(port, { jsonrpc: '2.0', id: 9, method: 'no/such', params: {} }, token);
    assert.ok(badMethod.json.error && badMethod.json.error.code === -32603);

    // 新增工具：chat / note / reminder / ask
    const chatRes = await postJson(port, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'pet_chat', arguments: { text: '你好' } } }, token);
    assert.ok(chatRes.json.result.content[0].text.includes('AI:你好'));
    const noteRes = await postJson(port, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'pet_note_add', arguments: { text: '买牛奶' } } }, token);
    assert.ok(noteRes.json.result.content[0].text.includes('已保存笔记'));
    const reminderRes = await postJson(port, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'pet_reminder_add', arguments: { text: '喝水', afterMinutes: 5 } } }, token);
    assert.ok(reminderRes.json.result.content[0].text.includes('5 分钟'));
    const badReminder = await postJson(port, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'pet_reminder_add', arguments: { text: '喝水', afterMinutes: 0 } } }, token);
    assert.equal(badReminder.json.result.isError, true);
    const askRes = await postJson(port, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'pet_ask', arguments: { question: '继续吗？', options: ['继续', '停下'] } } }, token);
    assert.ok(askRes.json.result.content[0].text.includes('允许'));

    // resources/list + resources/read
    const resources = await postJson(port, { jsonrpc: '2.0', id: 15, method: 'resources/list', params: {} }, token);
    assert.ok(resources.json.result.resources.some((r) => r.uri === 'pet://status'));
    const read = await postJson(port, { jsonrpc: '2.0', id: 16, method: 'resources/read', params: { uri: 'pet://status' } }, token);
    assert.ok(read.json.result.contents[0].text.includes('状态'));
    const badRead = await postJson(port, { jsonrpc: '2.0', id: 17, method: 'resources/read', params: { uri: 'pet://nope' } }, token);
    assert.ok(badRead.json.error, '未知资源应返回 JSON-RPC 错误');

    // GET → 405
    const get = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/mcp', method: 'GET' }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', () => resolve(0));
      req.end();
    });
    assert.equal(get, 405);

    // 依赖确实被调用
    assert.ok(calls.some((c) => c[0] === 'say' && c[1] === '远程提醒：喝水'));
    assert.ok(calls.some((c) => c[0] === 'screenshot'));
  } finally {
    server.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
