'use strict';
/** 验证 MCP 配置、命名、传输、结果格式化和环境清洗。 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpClient.js');
const mcp = require(DIST);
const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pet-mcp-'));
}

function writeConfig(dir, servers) {
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ servers }), 'utf8');
  return file;
}

test('配置校验：合法条目保留，非法条目跳过并给出原因', () => {
  const { servers, errors } = mcp.parseMcpConfig({
    servers: [
      { serverName: 'local', transport: 'stdio', command: 'node', args: ['a.js'], env: { A: 'b' } },
      { serverName: 'web', transport: 'http', url: 'http://127.0.0.1:3000/mcp', headers: { H: 'v' } },
      { serverName: 'bad name', transport: 'stdio', command: 'node' },
      { serverName: 'local', transport: 'stdio', command: 'node' },
      { serverName: 'nourl', transport: 'http' },
      { serverName: 'nocmd', transport: 'stdio' },
      { serverName: 'badtransport', transport: 'sse', url: 'http://x' },
      { serverName: 'clamped', transport: 'stdio', command: 'node', toolCallTimeoutMs: 99999999 },
    ],
  });
  assert.equal(servers.length, 3);
  assert.deepEqual(
    servers.map((s) => s.serverName),
    ['local', 'web', 'clamped'],
  );
  assert.equal(servers[0].transport, 'stdio');
  assert.equal(servers[0].command, 'node');
  assert.equal(servers[1].transport, 'http');
  assert.equal(servers[2].toolCallTimeoutMs, undefined, '越界超时应回退默认值');
  assert.ok(errors.length >= 5, `应记录非法条目：${errors.length}`);
  assert.ok(errors.some((e) => e.includes('serverName 非法')));
  assert.ok(errors.some((e) => e.includes('serverName 重复')));
  assert.ok(errors.some((e) => e.includes('transport')));
  // 非对象 / 缺 servers 也不崩
  assert.deepEqual(mcp.parseMcpConfig(null), { servers: [], errors: [] });
  assert.ok(mcp.parseMcpConfig({}).errors.length === 1);
});

test('工具命名：清洗非法字符、超长截断加哈希、可回查原始名', () => {
  assert.equal(mcp.makePublicToolName('github', 'create_issue'), 'mcp__github__create_issue');
  assert.equal(mcp.makePublicToolName('srv', 'echo.v2/x'), 'mcp__srv__echo_v2_x');
  const longRaw = 'x'.repeat(200);
  const a = mcp.makePublicToolName('s', longRaw);
  const b = mcp.makePublicToolName('s', `${longRaw}y`);
  assert.ok(a.length <= 64, `公开名超长：${a.length}`);
  assert.notEqual(a, b, '不同原始名不能折叠成同一个公开名');
  assert.equal(mcp.makePublicToolName('s', longRaw), a, '同一输入应稳定');
});

test('结果格式化：文本/图片/结构化/错误/截断', () => {
  const text = mcp.formatCallResult({ content: [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }] }, false);
  assert.equal(text, 'hello\nworld');
  const image = mcp.formatCallResult({ content: [{ type: 'image', mimeType: 'image/png' }] }, false);
  assert.ok(image.includes('图片') && image.includes('image/png'));
  const structured = mcp.formatCallResult({ structuredContent: { ok: true } }, false);
  assert.ok(structured.includes('"ok":true'));
  const failed = mcp.formatCallResult({ content: [{ type: 'text', text: 'boom' }] }, true);
  assert.ok(failed.startsWith('MCP 工具返回错误：'));
  const big = mcp.formatCallResult({ content: [{ type: 'text', text: 'y'.repeat(5000) }] }, false);
  assert.ok(big.length < 4100 && big.includes('结果已截断'));
});

test('stdio 环境清洗：剔除密钥类变量，再合并显式 env 并替换 ${env:NAME}', () => {
  process.env.PET_MCP_TEST_SECRET = 'resolved-secret';
  const env = mcp.scrubServerEnv(
    { PATH: 'C:/bin', GITHUB_TOKEN: 'should-drop', MY_PASSWORD: 'should-drop', NORMAL: 'keep' },
    { TOKEN: '${env:PET_MCP_TEST_SECRET}', PLAIN: 'v' },
  );
  assert.equal(env.PATH, 'C:/bin');
  assert.equal(env.NORMAL, 'keep');
  assert.equal(env.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN 应被剔除');
  assert.equal(env.MY_PASSWORD, undefined, 'MY_PASSWORD 应被剔除');
  assert.equal(env.TOKEN, 'resolved-secret');
  assert.equal(env.PLAIN, 'v');
  delete process.env.PET_MCP_TEST_SECRET;
});

test('Windows 命令解析：.cmd/.bat 经 cmd.exe，.exe 直接执行', () => {
  if (process.platform !== 'win32') return;
  const node = mcp.resolveStdioSpawn('node', ['-v']);
  assert.ok(/node\.exe$/i.test(node.command), `node 应解析成绝对路径：${node.command}`);
  const npx = mcp.resolveStdioSpawn('npx', ['-y', 'pkg']);
  assert.ok(/cmd\.exe$/i.test(npx.command), `npx 应包 cmd.exe：${npx.command}`);
  assert.ok(npx.args.join(' ').includes('/c'), 'cmd 参数应包含 /c');
  assert.ok(npx.args.join(' ').includes('-y'), '原参数应保留');
});

test('stdio 端到端：连接、发现工具、调用、错误结果、退出清理', async () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, [
    { serverName: 'echo', transport: 'stdio', command: process.execPath, args: [FIXTURE] },
  ]);
  const client = new mcp.McpClient({ configPath, clientVersion: 'test' });
  try {
    await client.connectAll();
    const defs = client.toolDefs();
    const names = defs.map((d) => d.function.name).sort();
    assert.deepEqual(names, ['mcp__echo__echo', 'mcp__echo__fail']);
    assert.equal(client.describeTool('mcp__echo__echo').tool, 'echo');
    assert.equal(client.isAutoApprove('mcp__echo__echo'), false);
    assert.match(client.statusText(), /echo（stdio）：已连接，工具 2 个，需确认/);
    assert.match(client.statusText(), /可用：mcp__echo__echo, mcp__echo__fail/, '/mcp 应列出具体工具名');
    const ok = await client.callTool('mcp__echo__echo', { text: 'hi' });
    assert.equal(ok, 'ECHO:hi');
    const failed = await client.callTool('mcp__echo__fail', {});
    assert.ok(failed.startsWith('MCP 工具返回错误：') && failed.includes('boom'));
    const unknown = await client.callTool('mcp__echo__nope', {});
    assert.ok(unknown.includes('未知 MCP 工具'));
  } finally {
    client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('后台工具策略：服务器 autoApprove + 工具只读标注 才允许', async () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, [
    { serverName: 'echo', transport: 'stdio', command: process.execPath, args: [FIXTURE], autoApprove: true },
  ]);
  const client = new mcp.McpClient({ configPath });
  try {
    await client.connectAll();
    assert.equal(client.isAutoApprovedReadOnly('mcp__echo__echo'), true, '只读工具应允许');
    assert.equal(client.isAutoApprovedReadOnly('mcp__echo__fail'), false, '未声明只读的工具不允许');
    assert.equal(client.isAutoApprovedReadOnly('mcp__echo__nope'), false);
    // 服务器未 autoApprove 时即使只读也不许
    const dir2 = tempDir();
    const cfg2 = writeConfig(dir2, [{ serverName: 'plain', transport: 'stdio', command: process.execPath, args: [FIXTURE] }]);
    const plain = new mcp.McpClient({ configPath: cfg2 });
    try {
      await plain.connectAll();
      assert.equal(plain.isAutoApprovedReadOnly('mcp__plain__echo'), false, '未 autoApprove 的服务器不允许后台调用');
    } finally {
      plain.dispose();
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('热重载 mcp.json：重新读取配置并替换工具路由', async () => {
  const dir = tempDir();
  const configPath = writeConfig(dir, [{ serverName: 'old', transport: 'stdio', command: process.execPath, args: [FIXTURE] }]);
  const client = new mcp.McpClient({ configPath });
  try {
    await client.connectAll();
    assert.deepEqual(client.toolDefs().map((d) => d.function.name).sort(), ['mcp__old__echo', 'mcp__old__fail']);
    writeConfig(dir, [{ serverName: 'fresh', transport: 'stdio', command: process.execPath, args: [FIXTURE] }]);
    await client.reload();
    const names = client.toolDefs().map((d) => d.function.name).sort();
    assert.deepEqual(names, ['mcp__fresh__echo', 'mcp__fresh__fail'], '重载后应换到新服务器');
    assert.ok(!client.statusText().includes('old（'), '旧服务器不应残留');
    assert.equal(await client.callTool('mcp__fresh__echo', { text: 'after-reload' }), 'ECHO:after-reload');
  } finally {
    client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HTTP 端到端：initialize/tools/list/tools/call 与 session 头', async () => {
  const dir = tempDir();
  let sessionSeen = '';
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (req.headers['mcp-session-id']) sessionSeen = String(req.headers['mcp-session-id']);
      const send = (payload) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };
      if (body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'session-abc');
        send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'http-echo', version: '1' } } });
        return;
      }
      if (body.method === 'notifications/initialized') {
        res.statusCode = 202;
        res.end('');
        return;
      }
      if (body.method === 'tools/list') {
        send({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'ping', description: '返回 pong', inputSchema: { type: 'object', properties: {} } }] } });
        return;
      }
      if (body.method === 'tools/call') {
        send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `pong:${body.params?.name}` }] } });
        return;
      }
      send({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no method' } });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const configPath = writeConfig(dir, [{ serverName: 'web', transport: 'http', url: `http://127.0.0.1:${port}/mcp` }]);
  const client = new mcp.McpClient({ configPath });
  try {
    await client.connectAll();
    assert.deepEqual(client.toolDefs().map((d) => d.function.name), ['mcp__web__ping']);
    assert.equal(await client.callTool('mcp__web__ping', {}), 'pong:ping');
    assert.equal(sessionSeen, 'session-abc', 'initialize 之后应带上 Mcp-Session-Id');
  } finally {
    client.dispose();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('未配置 mcp.json：不连接、无工具、状态文本提示路径', async () => {
  const dir = tempDir();
  const client = new mcp.McpClient({ configPath: path.join(dir, 'mcp.json') });
  try {
    await client.connectAll();
    assert.deepEqual(client.toolDefs(), []);
    assert.match(client.statusText(), /外部工具（mcp.json）：未配置/);
    assert.equal(client.isMcpTool('mcp__x__y'), true);
  } finally {
    client.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
