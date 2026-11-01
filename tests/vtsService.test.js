/**
 * vtsService.ts 的离线测试：用 mock VTS 服务端验证「可选后端」的状态机与降级行为。
 *
 * 重点（这些是最容易在真实环境里"静默坏掉"的地方）：
 *   - 启动阶段没有 token 时**不能**弹授权窗（否则用户一开应用就被 VTS 弹窗糊脸）；
 *   - 连接失败不 reject（bootstrap 可以直接 void start()）；
 *   - 未连接/未授权时注入被丢弃但**记 lastError**，不向调用方抛；
 *   - 高频注入在途时只保留最后一帧（30fps 不能把请求堆起来）；
 *   - 热键按名字转发、找不到时报明确错误。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createMockVtsServer } = require('./helpers/mockVtsServer');
const { VtsService, vtsUrlForPort, vtsTokenPath, DEFAULT_VTS_PORT } = require('../dist/main/vts/vtsService');

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

const HOTKEYS = [
  { name: 'My Animation 1', type: 'TriggerAnimation', hotkeyID: 'e5d3e7ef6a944c17b3ce58d3066fcd2b' },
  { name: '开心', type: 'ToggleExpression', hotkeyID: '2932bbd33d1b44fb9d947439fac75874' },
];

/** 一个"什么都支持"的 mock VTS：授权、模型、注入、热键 */
function createHandler(overrides = {}) {
  return (message) => {
    switch (message.messageType) {
      case 'AuthenticationTokenRequest':
        return envelope(message, 'AuthenticationTokenResponse', { authenticationToken: 'tok-service-1' });
      case 'AuthenticationRequest':
        return envelope(message, 'AuthenticationResponse', { authenticated: message.data.authenticationToken === 'tok-service-1' });
      case 'CurrentModelRequest':
        return envelope(message, 'CurrentModelResponse', { modelLoaded: true, modelName: 'mock-model', modelID: 'mid' });
      case 'HotkeysInCurrentModelRequest':
        return envelope(message, 'HotkeysInCurrentModelResponse', { modelLoaded: true, availableHotkeys: HOTKEYS });
      case 'HotkeyTriggerRequest':
        return envelope(message, 'HotkeyTriggerResponse', { hotkeyID: message.data.hotkeyID });
      case 'InjectParameterDataRequest':
        return envelope(message, 'InjectParameterDataResponse', {});
      default:
        return envelope(message, 'APIError', { errorID: 7, message: `Unknown messageType: ${message.messageType}` });
    }
  };
}

function tempTokenFile(token) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pet-vts-svc-'));
  const file = path.join(dir, 'vts-token.json');
  if (token) {
    fs.writeFileSync(file, JSON.stringify({ version: 1, token, url: 'ws://127.0.0.1:0', pluginName: 'Pet', savedAt: new Date().toISOString() }));
  }
  return {
    file,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('端口/路径工具：默认 8001，非法端口退回默认，token 固定在 userData 下', () => {
  assert.equal(DEFAULT_VTS_PORT, 8001);
  assert.equal(vtsUrlForPort(), 'ws://127.0.0.1:8001');
  assert.equal(vtsUrlForPort(9000), 'ws://127.0.0.1:9000');
  assert.equal(vtsUrlForPort(0), 'ws://127.0.0.1:8001');
  assert.equal(vtsUrlForPort(999999), 'ws://127.0.0.1:8001');
  assert.equal(vtsTokenPath('C:/data'), path.join('C:/data', 'vts-token.json'));
});

test('未启用时 start 什么都不做；injectTracking 静默丢弃但记 lastError', async (t) => {
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: 'ws://127.0.0.1:1', tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); token.cleanup(); });

  const status = await service.start({ enabled: false });
  assert.equal(status.enabled, false);
  assert.equal(status.connected, false);
  assert.equal(service.vtsClient, null);

  assert.doesNotThrow(() => service.injectTracking({ faceAngleX: 15 }));
  assert.match(service.status().lastError, /未启用/);
});

test('启动阶段没有缓存 token：只连接、不弹授权窗，lastError 提示去点「授权」', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile(); // 故意不放 token
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });

  const status = await service.start({ enabled: true });
  assert.equal(status.enabled, true);
  assert.equal(status.connected, true);
  assert.equal(status.authenticated, false);
  assert.match(status.lastError, /尚未授权/);
  assert.equal(
    server.requests.filter((r) => r.messageType === 'AuthenticationTokenRequest').length,
    0,
    '启动时绝不能触发 VTS 授权弹窗',
  );
});

test('有缓存 token：start 自动认证 + 读模型；注入按追踪参数名发出', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });

  const status = await service.start({ enabled: true });
  assert.equal(status.connected, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.modelName, 'mock-model');
  assert.equal(status.modelLoaded, true);
  assert.equal(status.lastError, '');
  assert.equal(server.requests.filter((r) => r.messageType === 'AuthenticationTokenRequest').length, 0);

  service.injectTracking({ faceAngleX: 15, mouthOpen: 0.7 });
  await wait(80);
  const injections = server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest');
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].data.parameterValues, [
    { id: 'FaceAngleX', value: 15 },
    { id: 'MouthOpen', value: 0.7 },
  ]);
});

test('高频注入：在途时只保留最后一帧，不会把请求堆起来', async (t) => {
  const server = await createMockVtsServer(async (message) => {
    if (message.messageType === 'InjectParameterDataRequest') {
      await wait(60); // 慢服务端：制造"上一帧还没回"
      return envelope(message, 'InjectParameterDataResponse', {});
    }
    return createHandler()(message);
  });
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });

  for (let i = 0; i < 20; i += 1) service.injectTracking({ faceAngleX: i });
  await wait(400);

  const injections = server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest');
  assert.ok(injections.length <= 2, `20 帧应被合并成 ≤2 个请求（实际 ${injections.length}）`);
  assert.equal(injections.at(-1).data.parameterValues[0].value, 19, '最后一帧必须是最新值');
});

test('未授权时注入被静默丢弃（不抛），lastError 说明原因', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile();
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });

  assert.doesNotThrow(() => service.injectTracking({ faceAngleX: 5 }));
  assert.match(service.status().lastError, /未授权/);
  await wait(50);
  assert.equal(server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest').length, 0);
});

test('authorize：没有 token 时走授权流程并落盘（这是唯一允许弹窗的入口）', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile();
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });
  assert.equal(service.status().authenticated, false);

  const status = await service.authorize();
  assert.equal(status.authenticated, true);
  assert.equal(status.modelName, 'mock-model');
  assert.equal(status.lastError, '');
  assert.equal(server.requests.filter((r) => r.messageType === 'AuthenticationTokenRequest').length, 1);
  assert.ok(fs.existsSync(token.file), 'token 应落盘，下次启动就不用再弹窗');
});

test('热键：按名字触发成功；找不到时报明确错误并记 lastError', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });

  const hotkeys = await service.listHotkeys();
  assert.deepEqual(hotkeys.map((h) => h.name), ['My Animation 1', '开心']);

  assert.match(await service.triggerHotkeyByName('开心'), /已触发 VTS 热键「开心」/);
  const triggers = server.requests.filter((r) => r.messageType === 'HotkeyTriggerRequest');
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].data.hotkeyID, '2932bbd33d1b44fb9d947439fac75874');

  await assert.rejects(() => service.triggerHotkeyByName('不存在'), /没有「不存在」/);
  assert.match(service.status().lastError, /触发 VTS 热键失败/);
});

test('未连接时热键操作直接给出可读错误（不假装成功）', async (t) => {
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: 'ws://127.0.0.1:1', tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); token.cleanup(); });

  await assert.rejects(() => service.listHotkeys(), /VTS 未连接/);
  await assert.rejects(() => service.triggerHotkeyByName('任意'), /VTS 未连接/);
  await assert.rejects(() => service.triggerHotkeyByName('  '), /热键名不能为空/);
});

test('连接失败不 reject：start 只记 lastError（不阻塞应用启动）', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const url = server.url;
  await server.closeServerOnly(); // 端口没人监听了
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); token.cleanup(); });

  const status = await service.start({ enabled: true });
  assert.equal(status.connected, false);
  assert.equal(status.authenticated, false);
  assert.match(status.lastError, /VTS 连接失败/);
});

test('stop 之后状态清空，注入恢复为静默丢弃；可以把服务重新 start 起来', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });

  await service.start({ enabled: true });
  assert.equal(service.status().connected, true);
  service.stop();
  assert.deepEqual(service.status(), {
    enabled: false,
    connected: false,
    authenticated: false,
    modelName: '',
    modelLoaded: false,
    lastError: '',
    injectedCount: 0,
    lastInjectedAt: '',
    lastTracking: null,
    droppedCount: 0,
  });
  assert.doesNotThrow(() => service.injectTracking({ faceAngleX: 1 }));

  const again = await service.start({ enabled: true });
  assert.equal(again.connected, true);
  assert.equal(again.authenticated, true);
});

/* ---------------------------------------------------------------- 诊断字段（injectedCount / lastTracking） */

test('注入成功后 status 记 injectedCount / lastInjectedAt / lastTracking，值按 VTS 区间夹取', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });

  assert.equal(service.status().injectedCount, 0);
  assert.equal(service.status().lastInjectedAt, '');
  assert.deepEqual(service.status().lastTracking, null);

  // faceAngleX 100 会被夹到 30；未知字段直接丢掉
  service.injectTracking({ faceAngleX: 100, eyeLeftX: 0.5, notAField: 1 });
  await wait(80);

  const st = service.status();
  assert.equal(st.injectedCount, 1, '成功注入一帧后计数必须 +1（设置页靠它判断"渲染层有没有在发"）');
  assert.match(st.lastInjectedAt, /^\d{4}-\d{2}-\d{2}T/, 'lastInjectedAt 应是 ISO 时间串');
  assert.deepEqual(st.lastTracking, { faceAngleX: 30, eyeLeftX: 0.5 });
  assert.equal(st.droppedCount, 0);

  const injections = server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest');
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].data.parameterValues, [
    { id: 'FaceAngleX', value: 30 },
    { id: 'EyeLeftX', value: 0.5 },
  ]);
});

test('未连接/未授权时丢帧会累加 droppedCount（不静默：状态行能看出丢了多少）', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile(); // 没有 token → 连上了但未授权
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });
  assert.equal(service.status().authenticated, false);

  for (let i = 0; i < 5; i += 1) service.injectTracking({ faceAngleX: i });
  const st = service.status();
  assert.equal(st.droppedCount, 5);
  assert.equal(st.injectedCount, 0);
  assert.equal(st.lastInjectedAt, '');
  assert.match(st.lastError, /未授权/);
  assert.equal(server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest').length, 0);
});

/* ---------------------------------------------------------------- 测试注入（设置页「测试注入」按钮） */

test('testInject：主进程直接注入 15/0.6/0.7，1 秒后归零（两帧都记进计数）', async (t) => {
  const server = await createMockVtsServer(createHandler());
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });

  const result = await service.testInject();
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status.injectedCount, 2, '保持帧 + 归零帧都要计入');

  const injections = server.requests.filter((r) => r.messageType === 'InjectParameterDataRequest');
  assert.equal(injections.length, 2);
  assert.deepEqual(injections[0].data.parameterValues, [
    { id: 'FaceAngleX', value: 15 },
    { id: 'EyeLeftX', value: 0.6 },
    { id: 'MouthOpen', value: 0.7 },
  ]);
  assert.deepEqual(injections[1].data.parameterValues, [
    { id: 'FaceAngleX', value: 0 },
    { id: 'EyeLeftX', value: 0 },
    { id: 'MouthOpen', value: 0 },
  ]);
  assert.deepEqual(injections[0].data.faceFound, true, '桌宠没有人脸追踪：必须显式 faceFound=true');
  assert.equal(injections[0].data.mode, 'set');
  assert.deepEqual(service.status().lastTracking, { faceAngleX: 0, eyeLeftX: 0, mouthOpen: 0 });
  assert.equal(service.status().lastError, '');
});

test('testInject：未连接时返回 ok=false + 可读错误（永不 reject、不假装成功）', async (t) => {
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: 'ws://127.0.0.1:1', tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); token.cleanup(); });

  const result = await service.testInject();
  assert.equal(result.ok, false);
  assert.match(result.error, /VTS 未连接/);
  assert.match(service.status().lastError, /VTS 未连接/);
  assert.equal(service.status().injectedCount, 0);
});

test('testInject：VTS 拒绝注入时把原因写进 lastError（不吞错）', async (t) => {
  const server = await createMockVtsServer(async (message) => {
    if (message.messageType === 'InjectParameterDataRequest') {
      return envelope(message, 'APIError', { errorID: 453, message: 'Parameter does not exist' });
    }
    return createHandler()(message);
  });
  const token = tempTokenFile('tok-service-1');
  const service = new VtsService({ url: server.url, tokenStorePath: token.file, logger: silent });
  t.after(async () => { service.dispose(); await server.close(); token.cleanup(); });
  await service.start({ enabled: true });

  const result = await service.testInject();
  assert.equal(result.ok, false);
  assert.match(result.error, /测试注入失败/);
  assert.match(service.status().lastError, /#453/);
});
