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
    report.injectTracking.effective = moved && restored && !service.status().lastError;
    console.log(
      `注入 FaceAngleX=15/EyeLeftX=0.6/MouthOpen=0.7 → ParamAngleX ${before.ParamAngleX}→${holding.ParamAngleX}→${after.ParamAngleX}` +
        `（有效=${report.injectTracking.effective}）`,
    );
    if (!report.injectTracking.effective) {
      console.log('  ⚠ 注入未通过判定：确认 VTS 里没在播动画/Idle 覆盖 ParamAngleX（等动画播完再测），或模型没有对应参数。');
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

    // 成功率判定：授权 + 模型 + 注入生效 才算通过；热键没有/失败单独标注，不掩盖
    report.ok = report.connect.connected === true
      && report.connect.authenticated === true
      && report.model.modelLoaded === true
      && report.injectTracking.effective === true;
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
