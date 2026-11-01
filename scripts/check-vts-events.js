#!/usr/bin/env node
/**
 * check-vts-events.js —— 真实 VTube Studio 的「事件订阅」联调（**不纳入 npm test**，需要本机 VTS 正在运行）
 *
 * 验证目标（VTS → 桌宠反向同步的前半段）：
 *   1. 授权成功后真的发出了 EventSubscriptionRequest（HotkeyTriggeredEvent + ModelLoadedEvent）；
 *   2. VTS 的 EventSubscriptionResponse 确认订阅（subscribedEvents 里有这两个事件）；
 *   3. 触发热键后，VtsClient 能收到 HotkeyTriggeredEvent，并带着 hotkeyName/hotkeyID 原样回调
 *      —— 这一步就是渲染层 `onVtsEvent` → `applyVtsEvent` 的输入；
 *   4. ModelLoadedEvent 若在此期间发生也会一并打印（不强制）。
 *
 * 用法：
 *   node scripts/check-vts-events.js                 # 默认 ws://127.0.0.1:8001 + 已缓存 token
 *   node scripts/check-vts-events.js --port 8001
 *   node scripts/check-vts-events.js --token "%APPDATA%\pet-desktop-app\vts-token.json"
 *   node scripts/check-vts-events.js --name 热键名   # 指定要触发的热键（默认第一个）
 *   node scripts/check-vts-events.js --manual        # 不主动触发，等你手动在 VTS 里按热键
 *   node scripts/check-vts-events.js --wait 8000     # 等事件的最长时间（ms）
 *
 * 需要先 `npm run build:tsc`（脚本读 dist/）。失败会以非 0 退出并把真实原因打出来。
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

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function defaultTokenPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return vtsTokenPath(path.join(appData, 'pet-desktop-app'));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const url = argValue('--url') || (argValue('--port') ? `ws://127.0.0.1:${argValue('--port')}` : DEFAULT_URL);
  const tokenStorePath = argValue('--token') || defaultTokenPath();
  const wantedName = argValue('--name').trim();
  const manual = hasFlag('--manual');
  const waitMs = Math.max(1000, Number(argValue('--wait') || 6000));

  const events = [];
  const report = { startedAt: new Date().toISOString(), url, tokenStorePath, manual, waitMs };
  const service = new VtsService({
    logger: (level, message) => {
      if (level !== 'debug') console.log(`[vts:${level}] ${message}`);
    },
    onEvent: (event) => {
      events.push(event);
      console.log(`[event] ${event.kind}${event.kind === 'hotkeyTriggered' ? `：${event.hotkeyName}` : `：${event.modelName}`}`);
    },
  });
  let exitCode = 1;

  try {
    const started = await service.start({ enabled: true, url, tokenStorePath });
    report.connect = { connected: started.connected, authenticated: started.authenticated, lastError: started.lastError };
    const client = service.vtsClient;
    if (!client || !started.connected) throw new Error(started.lastError || '连不上 VTS');
    if (!started.authenticated) {
      throw new Error(started.lastError || 'VTS 授权未通过（先跑一次 Pet 或在设置页点「授权」）');
    }
    report.model = { modelName: started.modelName, modelLoaded: started.modelLoaded };

    // 主进程服务启动时已经自动订阅过一次；这里再订阅一次拿 VTS 的确认列表（重复订阅是幂等的）。
    const subscribed = await client.subscribeEvents();
    report.subscription = {
      confirmed: subscribed,
      hasHotkeyEvent: subscribed.includes('HotkeyTriggeredEvent'),
      hasModelLoadedEvent: subscribed.includes('ModelLoadedEvent'),
      eventListenerCount: client.eventListenerCount,
    };
    console.log(`订阅确认：${subscribed.join('、') || '(空)'}`);

    // 选一个热键（默认第一个）
    let hotkeys = [];
    try {
      hotkeys = await service.listHotkeys();
    } catch (err) {
      report.hotkeys = { error: err instanceof Error ? err.message : String(err) };
    }
    report.hotkeys = {
      ...(report.hotkeys || {}),
      count: hotkeys.length,
      names: hotkeys.map((h) => h.name),
      types: hotkeys.map((h) => h.type),
    };

    const before = events.length;
    let triggered = '';
    if (manual) {
      triggered = wantedName || '(任意热键)';
      console.log(`请现在到 VTS 里手动触发一个热键${wantedName ? `（期望「${wantedName}」）` : ''}，最多等 ${waitMs}ms…`);
    } else {
      const target = (wantedName ? hotkeys.find((h) => h.name === wantedName) : hotkeys[0]) || null;
      if (wantedName && !target) {
        report.trigger = { ok: false, error: `VTS 当前模型没有名为「${wantedName}」的热键；可用：${hotkeys.map((h) => h.name).join('、') || '(无)'}` };
        throw new Error(report.trigger.error);
      }
      if (!target) {
        report.trigger = { ok: false, error: 'VTS 当前模型没有热键；先在 VTS 里给模型配一个热键（或加 --manual 手动按）' };
        throw new Error(report.trigger.error);
      }
      triggered = target.name;
      console.log(`触发热键：「${target.name}」(${target.type})…`);
      await service.triggerHotkeyByName(target.name);
      report.trigger = { ok: true, name: target.name, type: target.type };
    }

    // 等事件（热键事件是 VTS 异步推回来的，可能在 HotkeyTriggerResponse 之后几十毫秒）
    const deadline = Date.now() + waitMs;
    let matched = null;
    while (Date.now() < deadline) {
      matched = events.slice(before).find((evt) => evt.kind === 'hotkeyTriggered' && (!triggered || !wantedName || evt.hotkeyName === wantedName));
      if (matched) break;
      await wait(80);
    }

    report.events = events;
    report.matchedEvent = matched;
    report.ok = Boolean(matched) && report.subscription.hasHotkeyEvent === true;
    if (matched) {
      console.log(
        `收到 HotkeyTriggeredEvent：「${matched.hotkeyName}」id=${matched.hotkeyID || '(空)'} ` +
          `action=${matched.hotkeyAction || '(空)'} byAPI=${matched.hotkeyTriggeredByAPI}（该事件即渲染层反向同步的输入）`,
      );
    } else {
      console.log(
        `❌ ${waitMs}ms 内没收到 HotkeyTriggeredEvent（已触发：${triggered || '无'}）。` +
          '可能原因：VTS 版本事件名不同 / 订阅被拒 / 热键没有真正执行。',
      );
    }
    exitCode = report.ok ? 0 : 1;
  } catch (err) {
    report.ok = false;
    report.error = err instanceof Error ? err.message : String(err);
    report.status = service.status();
    console.log(`❌ ${report.error}`);
  } finally {
    service.dispose();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(exitCode);
})();
