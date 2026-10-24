'use strict';
/**
 * 测试夹具：最小 MCP stdio 服务器（仅用于 tests/mcpClient.test.js，不参与打包）。
 * 实现 initialize / tools/list / tools/call；工具：echo（回显）、fail（isError）。
 */
const readline = require('node:readline');

const TOOLS = [
  {
    name: 'echo',
    description: '回显输入文本',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'fail',
    description: '总是返回错误',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: false },
  },
];

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg.id;
  const respond = (result) => {
    if (id === undefined) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  };
  const respondError = (code, message) => {
    if (id === undefined) return;
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
  };

  if (msg.method === 'initialize') {
    respond({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1.0.0' } });
    return;
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    respond({ tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (name === 'echo') {
      respond({ content: [{ type: 'text', text: `ECHO:${String(args.text ?? '')}` }] });
      return;
    }
    if (name === 'fail') {
      respond({ content: [{ type: 'text', text: 'boom' }], isError: true });
      return;
    }
    respondError(-32601, `未知工具：${String(name)}`);
    return;
  }
  respondError(-32601, `不支持的方法：${String(msg.method)}`);
});
process.stdin.on('end', () => process.exit(0));
