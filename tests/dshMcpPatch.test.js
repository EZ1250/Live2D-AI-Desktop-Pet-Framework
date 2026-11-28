/**
 * dshMcpPatch.test.js —— DSH 通过 stdio 代理调用桌宠 MCP 的 patch/代理生成（不连外网）。
 */
'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const m = require('../dist/main/ai/dshMcpPatch.js');

/** 每个用例都是独立临时目录，用完删掉 */
function tempDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pet-dsh-${tag}-`));
}

describe('dshMcpPatch', () => {
  it('only accepts loopback http endpoints', () => {
    assert.equal(m.isLoopbackMcpUrl('http://127.0.0.1:37653/mcp'), true);
    assert.equal(m.isLoopbackMcpUrl('http://localhost:37653/mcp'), true);
    assert.equal(m.isLoopbackMcpUrl('http://[::1]:37653/mcp'), true);
    assert.equal(m.isLoopbackMcpUrl('https://127.0.0.1/mcp'), false);
    assert.equal(m.isLoopbackMcpUrl('http://example.com/mcp'), false);
    assert.equal(m.isLoopbackMcpUrl('not a url'), false);
  });

  it('renders a stdio MCP insert patch with escaped values', () => {
    const yaml = m.renderDshPatch(
      { url: 'http://127.0.0.1:37653/mcp', token: "a'b" },
      'C:\\Users\\me\\dsh-bridge-tools\\pet-mcp-stdio.cjs',
      'C:\\Users\\me\\dsh-bridge-tools\\pet-reasoning-stream.js',
    );
    assert.match(yaml, /^- insert:/m);
    assert.match(yaml, /id: pet-mcp/);
    assert.match(yaml, /transport: stdio/);
    assert.match(yaml, /command: node/);
    assert.match(yaml, /C:\/Users\/me\/dsh-bridge-tools\/pet-mcp-stdio\.cjs/);
    assert.match(yaml, /PET_MCP_URL: 'http:\/\/127\.0\.0\.1:37653\/mcp'/);
    assert.match(yaml, /PET_MCP_TOKEN: 'a''b'/);
    // 实时推理插件始终插入（思考浮窗不依赖反向接入）
    assert.match(yaml, /id: pet-reasoning-stream/);
    assert.match(yaml, /pet-reasoning-stream\.js/);
  });

  it('writes proxy + reasoning plugin patch into the given tools dir', () => {
    const dir = tempDir('mcp');
    const patch = m.prepareDshPatch({ url: 'http://127.0.0.1:37653/mcp', token: 'tok' }, dir);
    assert.ok(patch && fs.existsSync(patch));
    const proxy = path.join(dir, 'pet-mcp-stdio.cjs');
    assert.ok(fs.existsSync(proxy));
    assert.match(fs.readFileSync(proxy, 'utf8'), /PET_MCP_URL/);
    // 会反向驱动桌宠 AI / 长阻塞的工具不暴露给 DSH
    assert.match(fs.readFileSync(proxy, 'utf8'), /BLOCKED_TOOLS/);
    const plugin = path.join(dir, 'pet-reasoning-stream.js');
    assert.ok(fs.existsSync(plugin));
    assert.match(fs.readFileSync(plugin, 'utf8'), /pet-reasoning:' \+ JSON\.stringify/);
    const text = fs.readFileSync(patch, 'utf8');
    assert.match(text, /serverName: pet/);
    assert.match(text, /pet-reasoning-stream/);

    // 非回环端点不生成 MCP 代理，但仍保留实时推理插件。
    const dir2 = tempDir('mcp2');
    const patch2 = m.prepareDshPatch({ url: 'http://example.com/mcp', token: 'tok' }, dir2);
    assert.ok(patch2 && fs.existsSync(patch2));
    assert.equal(fs.existsSync(path.join(dir2, 'pet-mcp-stdio.cjs')), false);
    assert.doesNotMatch(fs.readFileSync(patch2, 'utf8'), /serverName: pet/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  });

  it('stdio proxy hides self-recursive tools and rejects calling them', async () => {
    const seenAuth = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        seenAuth.push(req.headers.authorization ?? '');
        const msg = JSON.parse(body);
        // 模拟桌宠服务端：不认识的新方法（如新版 MCP 的 server/discover 探测）回 202 空 body
        if (msg.method === 'server/discover') {
          res.writeHead(202);
          res.end();
          return;
        }
        const result = msg.method === 'tools/list'
          ? { tools: [{ name: 'pet_say' }, { name: 'pet_chat' }, { name: 'pet_ask' }] }
          : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const url = `http://127.0.0.1:${port}/mcp`;
    const dir = tempDir('proxy');
    assert.ok(m.prepareDshPatch({ url, token: 'tok' }, dir));

    const child = spawn(process.execPath, [path.join(dir, 'pet-mcp-stdio.cjs')], {
      env: { ...process.env, PET_MCP_URL: url, PET_MCP_TOKEN: 'tok' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rl = readline.createInterface({ input: child.stdout });
    const pending = new Map();
    rl.on('line', (line) => {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      const settle = obj && pending.get(obj.id);
      if (!settle) return;
      pending.delete(obj.id);
      settle(obj);
    });
    const rpc = (id, method, params) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`代理没有响应 ${method}`));
        }, 5000);
        pending.set(id, (obj) => {
          clearTimeout(timer);
          resolve(obj);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });

    try {
      const listed = await rpc(1, 'tools/list', {});
      assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['pet_say']);
      const blocked = await rpc(2, 'tools/call', { name: 'pet_chat', arguments: {} });
      assert.equal(blocked.error.code, -32601);
      // 有 id 的请求遇到 202 空响应必须立刻回错误：否则 DSH 的 server/discover 探测会干等 60s
      const discovered = await rpc(3, 'server/discover', {});
      assert.equal(discovered.error.code, -32601);
      // token 只经环境变量传给代理，再由代理按 Bearer 发请求（被拦截的 tools/call 不出网）
      assert.deepEqual(seenAuth, ['Bearer tok', 'Bearer tok']);
    } finally {
      rl.close();
      child.kill();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
