/**
 * vtsClient.ts 的集成测试：跑一个手写的极简 WebSocket 服务端（tests/helpers/mockVtsServer.js）
 * 来模拟 VTube Studio 的插件 API。
 *
 * 本机没有装 VTS（8001 没监听），所以这里验证的是「协议层」：
 *   - 请求信封 / 注入参数格式
 *   - 授权 token 复用（第二次不再弹允许窗）
 *   - 请求超时（服务端不回）
 *   - APIError 转 Error
 *   - 断线清理 pending
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockVtsServer } = require('./helpers/mockVtsServer');
const { VtsClient, VtsApiError, normalizeParameterValues } = require('../dist/main/vts/vtsClient');

const silent = () => {};

function envelope(request, messageType, data) {
  return {
    apiName: 'VTubeStudioPublicAPI',
    apiVersion: '1.0',
    timestamp: new Date().toISOString(),
    requestID: request.requestID,
    messageType,
    data: data ?? {},
  };
}

/** 一个标准的 VTS 授权 mock：第一次给 token，之后 authenticated=true */
function createAuthHandler(token = 'tok-test-1234') {
  return (message) => {
    if (message.messageType === 'AuthenticationTokenRequest') {
      return envelope(message, 'AuthenticationTokenResponse', { authenticationToken: token });
    }
    if (message.messageType === 'AuthenticationRequest') {
      return envelope(message, 'AuthenticationResponse', { authenticated: true });
    }
    return envelope(message, `${message.messageType}Response`, {});
  };
}

function tempTokenPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-vts-'));
  return {
    dir,
    file: path.join(dir, 'vts-token.json'),
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('VTS 请求信封与 injectParameters 参数格式符合 Plugin API 1.0', async (t) => {
  const server = await createMockVtsServer((message) => envelope(message, 'InjectParameterDataResponse', { injected: true }));
  const client = new VtsClient({ url: server.url, logger: silent });
  t.after(async () => { client.disconnect(); await server.close(); });

  await client.connect();
  const data = await client.injectParameters(
    [{ id: 'MouthOpen', value: 0.6 }, { id: 'ParamAngleX', value: -12, weight: 0.5 }],
    false,
    'add',
  );
  assert.deepEqual(data, { injected: true });

  const requests = server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest');
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.deepEqual(Object.keys(request).sort(), ['apiName', 'apiVersion', 'data', 'messageType', 'requestID']);
  assert.equal(request.apiName, 'VTubeStudioPublicAPI');
  assert.equal(request.apiVersion, '1.0');
  assert.equal(typeof request.requestID, 'string');
  assert.ok(request.requestID.length >= 8);
  assert.deepEqual(request.data, {
    faceFound: false,
    mode: 'add',
    parameterValues: [
      { id: 'MouthOpen', value: 0.6 },
      { id: 'ParamAngleX', value: -12, weight: 0.5 },
    ],
  });

  // 默认参数：faceFound=true、mode='set'、weight 省略就不带
  await client.injectParameters([{ id: 'ParamMouthForm', value: 1 }]);
  const second = server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest')[1];
  assert.deepEqual(second.data, {
    faceFound: true,
    mode: 'set',
    parameterValues: [{ id: 'ParamMouthForm', value: 1 }],
  });
});

test('Authorization token 复用：第二次授权直接用保存的 token，不再请求新 token', async (t) => {
  const tokenFile = tempTokenPath();
  const server = await createMockVtsServer(createAuthHandler('tok-abc-999'));
  t.after(async () => { await server.close(); tokenFile.cleanup(); });

  const first = new VtsClient({ url: server.url, tokenStorePath: tokenFile.file, logger: silent });
  t.after(() => first.disconnect());
  await first.connect();
  const firstAuth = await first.authenticate();
  assert.deepEqual(firstAuth, { authenticated: true, cachedToken: false });

  assert.equal(first.isConnected, true, '认证后仍保持连接（VTS 的 token 不会随连接失效）');
  assert.ok(fs.existsSync(tokenFile.file), 'token 应该落盘');
  const saved = JSON.parse(fs.readFileSync(tokenFile.file, 'utf8'));
  assert.equal(saved.token, 'tok-abc-999');
  assert.equal(saved.version, 1);
  assert.equal(saved.url, server.url);
  assert.equal(saved.pluginName, 'Pet');
  first.disconnect();

  const second = new VtsClient({ url: server.url, tokenStorePath: tokenFile.file, logger: silent });
  t.after(() => second.disconnect());
  await second.connect();
  const secondAuth = await second.authenticate();
  assert.deepEqual(secondAuth, { authenticated: true, cachedToken: true });

  const tokenRequests = server.requests.filter((r) => r.messageType === 'AuthenticationTokenRequest');
  const authRequests = server.requests.filter((r) => r.messageType === 'AuthenticationRequest');
  assert.equal(tokenRequests.length, 1, '第二次不应该再弹授权窗（只应有 1 次 AuthenticationTokenRequest）');
  assert.equal(authRequests.length, 2);
  assert.equal(authRequests[1].data.authenticationToken, 'tok-abc-999');
  assert.equal(authRequests[1].data.pluginName, 'Pet');
});

test('保存的 token 失效时会重新走一次授权（并且不会静默失败）', async (t) => {
  const tokenFile = tempTokenPath();
  let tokenIssued = 0;
  const server = await createMockVtsServer((message) => {
    if (message.messageType === 'AuthenticationTokenRequest') {
      tokenIssued += 1;
      return envelope(message, 'AuthenticationTokenResponse', { authenticationToken: `tok-new-${tokenIssued}` });
    }
    if (message.messageType === 'AuthenticationRequest') {
      const token = message.data && message.data.authenticationToken;
      const authenticated = token !== 'tok-stale';
      return envelope(message, 'AuthenticationResponse', authenticated ? { authenticated: true } : { authenticated: false, reason: 'Token 已失效' });
    }
    return envelope(message, `${message.messageType}Response`, {});
  });
  t.after(async () => { await server.close(); tokenFile.cleanup(); });

  fs.mkdirSync(path.dirname(tokenFile.file), { recursive: true });
  fs.writeFileSync(tokenFile.file, JSON.stringify({ version: 1, token: 'tok-stale', url: server.url, pluginName: 'Pet', savedAt: new Date().toISOString() }));

  const client = new VtsClient({ url: server.url, tokenStorePath: tokenFile.file, logger: silent });
  t.after(() => client.disconnect());
  await client.connect();
  const result = await client.authenticate();
  assert.deepEqual(result, { authenticated: true, cachedToken: false });
  assert.equal(tokenIssued, 1, 'token 失效后要重新申请');
  const saved = JSON.parse(fs.readFileSync(tokenFile.file, 'utf8'));
  assert.equal(saved.token, 'tok-new-1', '新 token 要覆盖旧的');
});

test('用户拒绝授权时 authenticate 抛错（不会被当成成功）', async (t) => {
  const server = await createMockVtsServer((message) => {
    if (message.messageType === 'AuthenticationTokenRequest') {
      return envelope(message, 'AuthenticationTokenResponse', { authenticationToken: 'tok-denied' });
    }
    if (message.messageType === 'AuthenticationRequest') {
      return envelope(message, 'AuthenticationResponse', { authenticated: false, reason: '用户拒绝了授权' });
    }
    return envelope(message, `${message.messageType}Response`, {});
  });
  t.after(async () => { await server.close(); });
  const client = new VtsClient({ url: server.url, logger: silent });
  t.after(() => client.disconnect());
  await client.connect();
  await assert.rejects(() => client.authenticate(), /VTS 授权未通过/);
});

test('请求超时：服务端不回时按 timeoutMs 失败，并清掉 pending', async (t) => {
  const server = await createMockVtsServer(() => undefined); // 故意不回
  const client = new VtsClient({ url: server.url, timeoutMs: 120, logger: silent });
  t.after(async () => { client.disconnect(); await server.close(); });
  await client.connect();

  const startedAt = Date.now();
  await assert.rejects(
    () => client.getModel(),
    (err) => {
      assert.match(err.message, /超时/);
      assert.match(err.message, /CurrentModelRequest/);
      assert.match(err.message, /120ms/);
      return true;
    },
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 100, `超时不应该提前触发（实际 ${elapsed}ms）`);
  assert.ok(elapsed < 3000, `超时不应该拖太久（实际 ${elapsed}ms）`);
  assert.equal(client.pendingCount, 0, '超时后 pending 必须清掉');
  assert.equal(server.requests.filter((r) => r.messageType === 'CurrentModelRequest').length, 1);
});

test('APIError 响应转成 VtsApiError（保留 errorID 与服务端文案）', async (t) => {
  const server = await createMockVtsServer((message) => envelope(message, 'APIError', {
    errorID: 301,
    message: '插件未获得授权，请先在 VTube Studio 里允许',
  }));
  const client = new VtsClient({ url: server.url, logger: silent });
  t.after(async () => { client.disconnect(); await server.close(); });
  await client.connect();

  await assert.rejects(
    () => client.listParameters(),
    (err) => {
      assert.equal(err.name, 'VtsApiError');
      assert.ok(err instanceof VtsApiError);
      assert.equal(err.errorID, 301);
      assert.equal(err.vtsMessage, '插件未获得授权，请先在 VTube Studio 里允许');
      assert.equal(err.requestMessageType, 'Live2DParameterListRequest');
      assert.match(err.message, /301/);
      assert.match(err.message, /插件未获得授权/);
      return true;
    },
  );
  assert.equal(client.pendingCount, 0);
});

test('断线清理 pending：对端关闭连接时挂着的请求立即失败，isConnected 变 false', async (t) => {
  const server = await createMockVtsServer(() => {
    setTimeout(() => {
      for (const conn of server.sockets) conn.close(1000);
    }, 30);
    return undefined;
  });
  const client = new VtsClient({ url: server.url, logger: silent });
  t.after(async () => { client.disconnect(); await server.close(); });
  await client.connect();
  assert.equal(client.isConnected, true);

  await assert.rejects(() => client.getModel(), /VTS 连接已断开/);
  assert.equal(client.pendingCount, 0);

  // 等 close 事件落地（服务端先发 close 帧再断开）
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(client.isConnected, false);
  await assert.rejects(() => client.getModel(), /VTS 未连接/);
});

test('未连接时请求直接报错；connect 到没人监听的端口也报错（不做自动重连）', async (t) => {
  const client = new VtsClient({ url: 'ws://127.0.0.1:1', timeoutMs: 2000, logger: silent });
  t.after(() => client.disconnect());
  assert.equal(client.isConnected, false);
  await assert.rejects(() => client.getModel(), /VTS 未连接/);

  const server = await createMockVtsServer();
  const url = server.url;
  await server.closeServerOnly();
  const deadClient = new VtsClient({ url, timeoutMs: 2000, logger: silent });
  t.after(() => deadClient.disconnect());
  await assert.rejects(() => deadClient.connect(), /VTS 连接失败/);
  assert.equal(deadClient.isConnected, false);
});

test('参数校验：非法注入参数在发请求之前就抛错', () => {
  assert.throws(() => normalizeParameterValues([]), /非空/);
  assert.throws(() => normalizeParameterValues('x'), /非空/);
  assert.throws(() => normalizeParameterValues([{ id: '  ', value: 1 }]), /id/);
  assert.throws(() => normalizeParameterValues([{ id: 'A', value: Number.NaN }]), /value/);
  assert.throws(() => normalizeParameterValues([{ id: 'A', value: 1, weight: 2 }]), /weight/);
  assert.deepEqual(normalizeParameterValues([{ id: ' A ', value: 0.5 }]), [{ id: 'A', value: 0.5 }]);
});

test('内置 global WebSocket 兜底路径（EventTarget 风格适配）也能跑通', async (t) => {
  if (typeof globalThis.WebSocket !== 'function') {
    t.skip('当前 Node 没有全局 WebSocket（<22），跳过兜底路径');
    return;
  }
  const server = await createMockVtsServer((message) => envelope(message, `${message.messageType}Response`, {
    modelLoaded: true,
    modelName: 'via-global-websocket',
  }));
  const client = new VtsClient({ url: server.url, webSocketCtor: globalThis.WebSocket, logger: silent });
  t.after(async () => { client.disconnect(); await server.close(); });
  await client.connect();
  assert.equal(client.isConnected, true);
  const model = await client.getModel();
  assert.equal(model.modelName, 'via-global-websocket');
  client.disconnect();
  assert.equal(client.isConnected, false);
  assert.equal(server.requests.filter((r) => r.messageType === 'CurrentModelRequest').length, 1);
});

test('构造参数校验：url 必须是 ws:// 或 wss://', () => {
  assert.throws(() => new VtsClient({ url: 'http://127.0.0.1:8001' }), /ws:\/\//);
  const client = new VtsClient();
  assert.equal(client.url, 'ws://127.0.0.1:8001');
  assert.equal(client.clientName, 'Pet');
});
