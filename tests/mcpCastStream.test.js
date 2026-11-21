'use strict';
/**
 * 投屏/鼠标/输入法协议单测：
 *  - pet/castStart 参数与 binary 协商；
 *  - pushCastFrame 二进制/JSON 两种帧；
 *  - pet/mouseMove/Click/RightClick + inputFocus/typeText。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const WebSocket = require('ws');

const mod = require(path.join(__dirname, '..', 'dist', 'main', 'ai', 'mcpServer.js'));
const TOKEN = 'cast-test-token-0123456789abcdef';

function deps(extra = {}) {
  return {
    say: () => 'ok',
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
    startCastCapture: async () => true,
    stopCastCapture: () => {},
    mouseMove: async () => '移动成功',
    mouseClick: async () => '左键成功',
    mouseRightClick: async () => '右键成功',
    isEditableFocused: async () => true,
    typeText: async (text) => `已输入${text.length}`,
    ...extra,
  };
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const messages = { binary: [], text: [] };
    ws.on('message', (data, isBinary) => {
      if (isBinary) messages.binary.push(Buffer.from(data));
      else messages.text.push(JSON.parse(String(data)));
    });
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
}

function waitFor(check, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

test('投屏协议：binary 协商、帧推送、鼠标/输入法', async () => {
  const server = new mod.PetMcpServer({
    configPath: path.join(__dirname, 'fixtures', 'never-written.json'),
    readInitial: () => ({ enabled: true, lan: false, port: 0, token: TOKEN }),
    persist: () => {},
    deps: deps(),
  });
  await server.start();
  const port = Number(server.statusText().match(/:(\d+)\/mcp/)[1]);
  const { ws, messages } = await openWs(port);
  let id = 100;
  const request = (method, params) => {
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }));
    return id;
  };
  const waitResponse = async (reqId) => {
    await waitFor(() => messages.text.some((m) => m.id === reqId));
    return messages.text.find((m) => m.id === reqId);
  };
  try {
    // binary=true
    const start = request('pet/castStart', { maxWidth: 1280, fps: 24, quality: 70, display: 2, binary: true });
    const ack = await waitResponse(start);
    assert.equal(ack.result.ok, true);
    assert.equal(ack.result.binary, true);
    assert.equal(ack.result.fps, 30);
    assert.equal(ack.result.maxWidth, 1280);
    server.pushCastFrame(Buffer.from('fake-jpeg'));
    await waitFor(() => messages.binary.length > 0);
    assert.equal(messages.binary[0].toString(), 'fake-jpeg');

    // binary=false → 旧客户端 JSON 帧
    const legacy = request('pet/castStart', { maxWidth: 960, binary: false });
    const legacyAck = await waitResponse(legacy);
    assert.equal(legacyAck.result.binary, false);
    server.pushCastFrame(Buffer.from('abc'));
    await waitFor(() => messages.text.some((m) => m.method === 'pet/castFrame'));
    const castNote = messages.text.find((m) => m.method === 'pet/castFrame');
    assert.equal(Buffer.from(castNote.params.data, 'base64').toString(), 'abc');

    // 投屏鼠标/输入法（v0.4.4 恢复）
    assert.equal((await waitResponse(request('pet/mouseMove', { x: 0.5, y: 0.5 }))).result.ok, true);
    assert.equal((await waitResponse(request('pet/mouseClick', { x: 0.2, y: 0.3 }))).result.text, '左键成功');
    assert.equal((await waitResponse(request('pet/mouseRightClick', { x: 0.2, y: 0.3 }))).result.text, '右键成功');
    const bad = await waitResponse(request('pet/mouseMove', { x: 1.5, y: 0.5 }));
    assert.equal(bad.error.code, -32602);
    assert.equal((await waitResponse(request('pet/inputFocus', {}))).result.editable, true);
    assert.equal((await waitResponse(request('pet/typeText', { text: '你好' }))).result.ok, true);
    const empty = await waitResponse(request('pet/typeText', { text: '' }));
    assert.equal(empty.error.code, -32602);
  } finally {
    ws.close();
    server.dispose();
  }
});
