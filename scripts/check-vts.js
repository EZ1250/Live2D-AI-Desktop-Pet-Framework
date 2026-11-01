#!/usr/bin/env node
/**
 * check-vts.js —— 真实 VTube Studio 联调（**不纳入 npm test**，需要本机 VTS 正在运行）
 *
 * 用法：
 *   node scripts/check-vts.js                    # 默认 ws://127.0.0.1:8001 + 已缓存的 token
 *   node scripts/check-vts.js --port 8001
 *   node scripts/check-vts.js --url ws://127.0.0.1:8001
 *   node scripts/check-vts.js --token "%APPDATA%\pet-desktop-app\vts-token.json"
 *   node scripts/check-vts.js --hold 1500        # 注入后保持多久（ms）
 *
 * 它做的事（全部走**真实** VTS 插件 API，不 mock）：
 *   1. connect → authenticate（token 已缓存时不会弹授权窗）
 *   2. CurrentModelRequest → 打印模型名
 *   3. injectTracking faceAngleX=15 → 保持 1s → 归 0；并读 Live2D 参数证明**真的生效**
 *      （VTS 会把追踪参数映射到模型参数，例如 FaceAngleX → ParamAngleX）
 *   4. HotkeysInCurrentModelRequest → 打印热键数量
 *   5. 有热键就按名字触发一个；没有热键就如实报告"跳过"，**不伪造成功**
 *
 * 需要先 `npm run build:tsc`（脚本读 dist/）。用 VtsService（与主进程同一条代码路径）。
 * 失败会以非 0 退出，并把真实原因打出来。
 */
'use strict';

const os = require('node:os');
const path = require('node:path');

const { VtsService, vtsTokenPath } = require('../dist/main/vts/vtsService');

const DEFAULT_URL = 'ws://127.0.0.1:8001';

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return '';
  const value = process.argv[index + 1];
  return typeof value === 'string' && !value.startsWith('--') ? value : '';
}

function defaultTokenPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return vtsTokenPath(path.join(appData, 'pet-desktop-app'));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 从模型参数表里挑几个"能被追踪参数影响"的，用来客观证明注入生效 */
const PROBE_PARAMS = ['ParamAngleX', 'ParamAngleY', 'ParamEyeBallX', 'ParamEyeBallY', 'ParamMouthOpenY'];

async function readProbe(client) {
  const params = await client.listParameters();
  const out = {};
  for (const name of PROBE_PARAMS) {
    const found = params.find((p) => p.name === name);
    out[name] = found ? Number(found.value.toFixed(3)) : null;
  }
  return out;
}

/**
 * 从 VTS 的**输入参数**（tracking 参数，插件能直接注入的那一层）里读回值。
 *
 * 这是"注入到底有没有被 VTS 收下"最直接的证据：
 *   - 模型参数（ParamAngleX）会被 VTS 自己的追踪 / Idle 动画覆盖，单独看它会误判；
 *   - 输入参数（FaceAngleX / MouthOpen）只有插件注入和 VTS 追踪会写，能立刻看到我们发的值。
 */
const INPUT_PROBE_PARAMS = ['FaceAngleX', 'FaceAngleY', 'EyeLeftX', 'EyeRightX', 'MouthOpen'];

async function readInputs(client) {
  const data = await client.request('InputParameterListRequest', {});
  const list = Array.isArray(data.defaultParameters) ? data.defaultParameters : [];
  const out = {};
  for (const name of INPUT_PROBE_PARAMS) {
    const found = list.find((p) => p && p.name === name);
    out[name] = found && typeof found.value === 'number' ? Number(found.value.toFixed(3)) : null;
  }
  return out;
}

/** 测试注入判定：VTS 是否真的收下了我们发的那几个值 */
function testInjectAccepted(during) {
  if (!during) return false;
  const mouth = typeof during.MouthOpen === 'number' && during.MouthOpen > 0.5;
  const face = typeof during.FaceAngleX === 'number' && Math.abs(during.FaceAngleX - 15) < 3;
  const eye = typeof during.EyeLeftX === 'number' && Math.abs(during.EyeLeftX - 0.6) < 0.2;
  return mouth || face || eye;
}

function changed(before, after, name) {
  const a = before[name];
  const b = after[name];
  return typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) : null;
}

(async () => {
  const url = argValue('--url') || (argValue('--port') ? `ws://127.0.0.1:${argValue('--port')}` : DEFAULT_URL);
  const tokenStorePath = argValue('--token') || defaultTokenPath();
  const holdMs = Number(argValue('--hold') || 1000);

  const report = { startedAt: new Date().toISOString(), url, tokenStorePath, holdMs };
  const service = new VtsService({
    logger: (level, message) => {
      if (level !== 'debug') console.log(`[vts:${level}] ${message}`);
    },
  });
  let exitCode = 1;

  try {
    // 1) 连接 + 授权（用已缓存 token：不会弹窗）
    const started = await service.start({ enabled: true, url, tokenStorePath });
    report.connect = { connected: started.connected, authenticated: started.authenticated, lastError: started.lastError };
    const client = service.vtsClient;
    if (!client || !started.connected) throw new Error(started.lastError || '连不上 VTS');
    if (!started.authenticated) throw new Error(started.lastError || 'VTS 授权未通过（先跑一次 Pet 或设置页「授权」）');
    report.auth = { cachedToken: true, modelName: started.modelName, modelLoaded: started.modelLoaded };

    // 2) 模型
    const model = await client.getModel();
    report.model = {
      modelName: model.modelName ?? '',
      modelLoaded: model.modelLoaded === true,
      live2DModelName: model.live2DModelName ?? '',
      numberOfLive2DParameters: model.numberOfLive2DParameters ?? null,
    };
    console.log(`模型：${report.model.modelName}（${report.model.live2DModelName}，${report.model.numberOfLive2DParameters ?? '?'} 个参数）`);

    // 3) 注入追踪参数并验证模型参数真的动了
    //    先归零再量基线：上一次运行留下的动画/热键播放会覆盖 ParamAngleX，
    //    带着残留量基线就会把"注入生效与否"判错（实测踩过：动画还在播时基线是 -1.7）。
    service.injectTracking({ faceAngleX: 0, eyeLeftX: 0, eyeRightX: 0, mouthOpen: 0 });
    await wait(holdMs);
    const before = await readProbe(client);
    const beforeInputs = await readInputs(client);
    service.injectTracking({ faceAngleX: 15, eyeLeftX: 0.6, eyeRightX: 0.6, mouthOpen: 0.7 });
    await wait(holdMs);
    const holding = await readProbe(client);
    service.injectTracking({ faceAngleX: 0, eyeLeftX: 0, eyeRightX: 0, mouthOpen: 0 });
    await wait(holdMs);
    const after = await readProbe(client);

    report.injectTracking = {
      before,
      holding,
      after,
      deltas: {
        ParamAngleX: changed(before, holding, 'ParamAngleX'),
        ParamEyeBallX: changed(before, holding, 'ParamEyeBallX'),
        ParamMouthOpenY: changed(before, holding, 'ParamMouthOpenY'),
      },
      restored: {
        ParamAngleX: changed(after, before, 'ParamAngleX'),
        ParamMouthOpenY: changed(after, before, 'ParamMouthOpenY'),
      },
      lastError: service.status().lastError,
    };
    // 判定：注入后至少一个模型参数明显变了（>0.2），且归 0 后又回到基线附近（<0.2）
    const moved = Object.values(report.injectTracking.deltas).some((d) => typeof d === 'number' && d > 0.2);
    const restored = Object.values(report.injectTracking.restored).every((d) => typeof d !== 'number' || d < 0.2);
    report.injectTracking.visibleOnModel = moved && restored && !service.status().lastError;
    console.log(
      `注入 FaceAngleX=15/EyeLeftX=0.6/MouthOpen=0.7 → ParamAngleX ${before.ParamAngleX}→${holding.ParamAngleX}→${after.ParamAngleX}` +
        `（模型参数可见变化=${report.injectTracking.visibleOnModel}）`,
    );
    if (!report.injectTracking.visibleOnModel) {
      console.log('  ⚠ 模型参数没跟着变：常见原因是 VTS 自己的摄像头追踪/Idle 动画每帧把 ParamAngleX 写回去');
      console.log('            （插件注入对"头/眼"只赢一帧）—— 不代表注入没送到，下一步用输入参数判定。');
    }

    // 3.2) 「测试注入」同一条代码路径（设置页按钮 = VTS_TEST_INJECT_VALUES + 1s 后归零）
    //      判据换成 VTS **输入参数**：它只可能被插件注入或 VTS 自己的追踪写，能证明"主进程 → VTS"通。
    try {
      const injectPromise = service.testInject();
      await wait(350); // 保持期内采样
      const duringInputs = await readInputs(client);
      const result = await injectPromise;
      await wait(300);
      const afterInputs = await readInputs(client);
      report.testInject = {
        ok: result.ok,
        error: result.error ?? '',
        beforeInputs,
        duringInputs,
        afterInputs,
        injectedCount: result.status.injectedCount,
        lastTracking: result.status.lastTracking,
        acceptedByVts: testInjectAccepted(duringInputs),
      };
      console.log(
        `测试注入（test-inject）→ 输入参数 FaceAngleX=${duringInputs.FaceAngleX} EyeLeftX=${duringInputs.EyeLeftX} MouthOpen=${duringInputs.MouthOpen}` +
          `（VTS 收下=${report.testInject.acceptedByVts}，累计注入 ${report.testInject.injectedCount} 帧）`,
      );
      if (!report.testInject.acceptedByVts) {
        console.log('  ⚠ 输入参数里没看到 15 / 0.6 / 0.7：注入没被 VTS 接受，检查授权与模型；');
        console.log('            也可能 VTS 的追踪每帧都在覆盖同一个参数（MouthOpen 通常不会被覆盖，最适合当判据）。');
      }
    } catch (err) {
      report.testInject = { ok: false, error: err instanceof Error ? err.message : String(err) };
      console.log(`测试注入失败：${report.testInject.error}`);
    }

    // 4) 热键列表（实测消息类型是 HotkeysInCurrentModelRequest；HotkeyListRequest 会被 VTS 拒）
    let hotkeys = [];
    try {
      hotkeys = await service.listHotkeys();
      report.hotkeys = { count: hotkeys.length, names: hotkeys.map((h) => h.name), types: hotkeys.map((h) => h.type) };
      console.log(`热键：${hotkeys.length} 个${hotkeys.length ? `（${hotkeys.map((h) => h.name).join('、')}）` : ''}`);
    } catch (err) {
      report.hotkeys = { error: err instanceof Error ? err.message : String(err) };
      console.log(`热键列表失败：${report.hotkeys.error}`);
    }

    // 5) 触发一个热键（真触发；失败就如实记失败）
    if (hotkeys.length) {
      const target = hotkeys[0].name;
      try {
        const message = await service.triggerHotkeyByName(target);
        report.hotkeyTrigger = { ok: true, name: target, type: hotkeys[0].type, message };
        console.log(`热键触发：✅ ${message}`);
      } catch (err) {
        report.hotkeyTrigger = { ok: false, name: target, error: err instanceof Error ? err.message : String(err) };
        console.log(`热键触发：❌ ${report.hotkeyTrigger.error}`);
      }
    } else {
      report.hotkeyTrigger = { ok: false, skipped: true, reason: '当前模型没有热键（在 VTS 里给模型配一个热键后再试）' };
      console.log('热键触发：跳过（当前模型没有热键）');
    }

    // 成功率判定：授权 + 模型 + "VTS 收下了测试注入" 才算通过；热键没有/失败单独标注，不掩盖。
    // 注意：不再用"模型参数可见变化"当通过条件 —— VTS 自己的追踪会覆盖 FaceAngleX，那会把
    // "链路通但看不见"误判成"注入失败"。模型参数可见与否单独放在 injectTracking.visibleOnModel。
    const accepted = report.testInject ? report.testInject.acceptedByVts === true : false;
    report.ok = report.connect.connected === true
      && report.connect.authenticated === true
      && report.model.modelLoaded === true
      && accepted;
    if (!report.ok) {
      console.log('判定：未通过（' + [
        report.connect.connected ? '' : '连接失败',
        report.connect.authenticated ? '' : '未授权',
        report.model.modelLoaded ? '' : '模型未加载',
        accepted ? '' : '测试注入未被 VTS 收下',
      ].filter(Boolean).join('、') + '）');
    } else if (!report.injectTracking.visibleOnModel) {
      console.log('判定：通过（VTS 已收下注入；但模型参数被 VTS 自己的追踪覆盖，画面上看不到头/眼跟随）');
    } else {
      console.log('判定：通过（注入被 VTS 收下，且模型参数可见变化）');
    }
    exitCode = report.ok ? 0 : 1;
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.message : String(err);
    report.status = service.status();
  } finally {
    service.dispose();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
})();
