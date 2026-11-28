/**
 * dshMcpPatch —— 把桌宠的 MCP 服务端接到 DSH 里。
 *
 * DSH 的 MCP client 插件支持 stdio / streamable-http；桌宠服务端是「只接受 POST」的
 * 简化 MCP HTTP 端点，DSH 的 streamable-http 客户端连不稳。这里生成一个很小的
 * stdio→HTTP 代理：DSH 按标准 stdio MCP 启动代理，代理把 JSON-RPC 原样 POST 到
 * 桌宠 MCP 服务端，再把响应逐行写回 stdout。
 *
 * 代理脚本、推理流插件和 patch 都写在 `<userData>/dsh-bridge-tools`（**在 DSH 工作目录之外**）：
 * patch 里带 token、插件会被 DSH 直接执行，放进 DSH 可写目录等于让 AI 能改写自己的执行环境。
 * token 只经进程环境变量传给代理，不拼进命令行。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface DshMcpEndpoint {
  url: string;
  token: string;
}

const PROXY_FILE = 'pet-mcp-stdio.cjs';
const PATCH_FILE = 'pet-mcp-patch.yml';
const REASONING_PLUGIN_FILE = 'pet-reasoning-stream.js';

/** 只接受本机回环 MCP 端点，避免把 token 发到外网。 */
export function isLoopbackMcpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:') return false;
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
  } catch {
    return false;
  }
}

function yamlSingle(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const PROXY_SCRIPT = String.raw`'use strict';
const http = require('node:http');
const readline = require('node:readline');
const endpoint = new URL(process.env.PET_MCP_URL || 'http://127.0.0.1/');
const token = process.env.PET_MCP_TOKEN || '';
if (endpoint.protocol !== 'http:' || !/^(127\.0\.0\.1|localhost|\[::1\]|::1)$/.test(endpoint.hostname)) {
  process.stderr.write('PET_MCP_URL 必须是本机 http 地址\n');
  process.exit(1);
}
// pet_chat 会反向再驱动一次桌宠 AI（另一个 DSH 进程，且与当前会话共用会话文件）；
// pet_ask 最长等 120s 手机确认，超过 DSH 的工具超时。桥接层既不给模型看、也不执行。
const BLOCKED_TOOLS = new Set(['pet_chat', 'pet_ask']);
function send(obj) {
  try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch {}
}
function filterToolList(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return text; }
  const tools = obj && obj.result && obj.result.tools;
  if (Array.isArray(tools)) obj.result.tools = tools.filter((tool) => tool && !BLOCKED_TOOLS.has(tool.name));
  return JSON.stringify(obj);
}
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (msg.method === 'tools/call' && msg.params && BLOCKED_TOOLS.has(msg.params.name)) {
    if (msg.id !== undefined && msg.id !== null) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'tool not available through the pet bridge: ' + msg.params.name } });
    }
    return;
  }
  const wantToolList = msg.method === 'tools/list';
  const body = Buffer.from(JSON.stringify(msg));
  const req = http.request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Content-Length': body.length,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
  }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (res.statusCode < 200 || res.statusCode >= 300) {
        if (msg.id !== undefined && msg.id !== null) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'MCP HTTP ' + res.statusCode + ': ' + raw.slice(0, 240) } });
        }
        return;
      }
      // 桌宠服务端对不认识的方法（如新版 MCP 的 server/discover 探测）回 202 空 body；
      // 有 id 的请求绝不能静默丢弃，否则客户端会一直等自己的发现超时（实测 60s）才继续。
      if (!raw) {
        if (msg.id !== undefined && msg.id !== null) {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not supported: ' + (msg.method || '?') } });
        }
        return;
      }
      for (const part of raw.split(/\r?\n/)) {
        const lineText = part.trim();
        if (!lineText) continue;
        let data;
        if (lineText.startsWith('data:')) data = lineText.slice(5).trim();
        else data = lineText;
        if (!data) continue;
        process.stdout.write((wantToolList ? filterToolList(data) : data) + '\n');
      }
    });
  });
  req.on('error', (err) => {
    if (msg.id !== undefined && msg.id !== null) {
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'MCP proxy: ' + err.message } });
    }
  });
  req.end(body);
});
`;

/**
 * DSH headless 的 --json 投影只在一轮 assistant/message 提交后输出 thinking，
 * 思考浮窗会“最后才弹一大段”。这个本地 Cordis 插件监听实时 assistant-stream，
 * 把 reasoning-delta 逐块写 stderr（每块一行、JSON 编码，父进程按行解析不会把
 * 半行标记/换行混进思考内容）。桥接层收到后逐块转发。
 */
const REASONING_PLUGIN = `export const name = 'pet-reasoning-stream';
export const inject = [];
export function apply(ctx) {
  ctx.on('agent/assistant-stream', ({ frame }) => {
    const chunk = frame && frame.type === 'chunk' ? frame.chunk : null;
    if (chunk && chunk.type === 'reasoning-delta' && chunk.text) {
      process.stderr.write('pet-reasoning:' + JSON.stringify(chunk.text) + '\\n');
    }
  });
}
`;

/** 生成 DSH profile patch：推理流插件 +（可选）MCP stdio 代理。 */
export function renderDshPatch(endpoint: DshMcpEndpoint | null, proxyPath: string | null, pluginPath: string): string {
  const lines = ['- insert:', '    - id: pet-reasoning-stream', '      name: ' + yamlSingle(pathToFileURL(pluginPath).href)];
  if (endpoint && proxyPath) {
    lines.push(
      '    - id: pet-mcp',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: pet',
      '        transport: stdio',
      '        command: node',
      '        args: [' + yamlSingle(proxyPath.replace(/\\/g, '/')) + ']',
      '        env:',
      '          PET_MCP_URL: ' + yamlSingle(endpoint.url),
      '          PET_MCP_TOKEN: ' + yamlSingle(endpoint.token),
      '        failOnStartupError: false',
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** 内容没变就不重写：每轮对话都会调用，避免无谓的磁盘写入。 */
function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return;
  } catch {
    /* 不存在/读不到：继续写 */
  }
  fs.writeFileSync(file, content, { encoding: 'utf8', mode: 0o600 });
}

/**
 * 写入推理流插件 + 可选 MCP 代理 + patch，返回 patch 路径。
 * toolsDir 必须是 DSH 工作目录之外的独立目录（见文件头）。端点不合法时仍写推理插件。
 */
export function prepareDshPatch(endpoint: DshMcpEndpoint | null, toolsDir: string): string | null {
  try {
    fs.mkdirSync(toolsDir, { recursive: true });
    const pluginPath = path.join(toolsDir, REASONING_PLUGIN_FILE);
    writeIfChanged(pluginPath, REASONING_PLUGIN);
    let proxyPath: string | null = null;
    if (endpoint && isLoopbackMcpUrl(endpoint.url) && endpoint.token) {
      proxyPath = path.join(toolsDir, PROXY_FILE);
      writeIfChanged(proxyPath, PROXY_SCRIPT);
    }
    const patchPath = path.join(toolsDir, PATCH_FILE);
    writeIfChanged(patchPath, renderDshPatch(endpoint && proxyPath ? endpoint : null, proxyPath, pluginPath));
    return patchPath;
  } catch (err) {
    // 反向接入和实时思考都靠这些文件；写不出来要让用户能查，不能静默降级
    console.warn('[dsh] 生成 patch 失败（反向接入与实时思考将不可用）：', (err as Error).message ?? String(err));
    return null;
  }
}
