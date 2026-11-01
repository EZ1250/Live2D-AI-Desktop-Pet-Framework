/**
 * ttsMouth.test.js —— TTS 播放期间的本地桌宠口型（可注入 handle 桩 + 假时钟）
 *
 * 背景：TTS 音频由渲染层 `new Audio(dataUrl).play()` 播放，但以前只驱动了 VTS 的
 * MouthOpen（主进程注入），**本地桌宠模型的嘴不动**。修法是在 playTtsAudio 的播放链路里
 * 用 ttsMouth.ts 按音频时长打拍子驱动当前 handle，ended/error/pause 时停止归零。
 *
 * 这里不启动 Electron、不碰 DOM：直接加载编译产物 dist/renderer/ttsMouth.js，
 * 用桩 handle 记录 applySpeech 调用，用假定时器精确推进节拍，断言：
 *   ① start() 立刻驱动一拍，openY ∈ [0.15,0.75]、ttl=150；
 *   ② 节拍间隔落在 90~120ms；
 *   ③ stop() 后归零（最后一拍 openY=0）且不再有后续写入；
 *   ④ 本来没在播时 stop() 不写任何东西（不覆盖打字机等别的口型来源）；
 *   ⑤ 重复 start() 不会叠加定时器；
 *   ⑥ 没有 applySpeech 的 handle 退回追踪层 MouthOpen（applyTrackingFrame）；
 *   ⑦ 没有 handle 时不抛错。
 *
 * 前置：npm test 会先 build:tsc（dist/renderer/ttsMouth.js 必须存在）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const MODULE = path.join(APP, 'dist', 'renderer', 'ttsMouth.js');

require(MODULE);
const PetTtsMouth = globalThis.PetTtsMouth;

/** 可手动推进的假时钟（与真实 window.setTimeout/clearTimeout 同签名） */
function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { at: now + Math.max(0, Number(ms) || 0), fn });
      return seq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    /** 推进 ms，按到期顺序执行回调（回调里新排的定时器也参与本轮） */
    advance(ms) {
      const end = now + Math.max(0, Number(ms) || 0);
      for (;;) {
        let nextId = null;
        let nextAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= end && timer.at < nextAt) {
            nextAt = timer.at;
            nextId = id;
          }
        }
        if (nextId === null) break;
        const timer = timers.get(nextId);
        timers.delete(nextId);
        now = timer.at;
        timer.fn();
      }
      now = end;
    },
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    },
  };
}

/** 记录所有写入口型的调用 */
function recordingHandle() {
  const calls = [];
  return {
    calls,
    handle: {
      applySpeech(mouth, ttlMs) {
        calls.push({ via: 'speech', openY: mouth && mouth.openY, ttlMs });
      },
    },
  };
}

function createDriver(opts) {
  return PetTtsMouth.createDriver(opts);
}

test('模块导出：节拍/开口/TTL 常量就是约定的 90~120ms / 0.15~0.75 / 150ms', () => {
  assert.equal(typeof PetTtsMouth.createDriver, 'function');
  assert.equal(PetTtsMouth.TICK_MIN_MS, 90);
  assert.equal(PetTtsMouth.TICK_MAX_MS, 120);
  assert.equal(PetTtsMouth.TTL_MS, 150);
  assert.equal(PetTtsMouth.OPEN_MIN, 0.15);
  assert.equal(PetTtsMouth.OPEN_MAX, 0.75);
});

test('start 立刻驱动一拍：openY 在 0.15~0.75、ttl=150；随后按 90~120ms 继续', () => {
  const clock = makeClock();
  const rec = recordingHandle();
  const driver = createDriver({
    getHandle: () => rec.handle,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    random: () => 0.5,
  });

  driver.start();
  assert.equal(rec.calls.length, 1, 'start() 必须立刻驱动一拍（否则第一拍要等 90ms 才张嘴）');
  const first = rec.calls[0];
  assert.equal(first.via, 'speech');
  assert.equal(first.ttlMs, 150);
  assert.ok(first.openY >= 0.15 && first.openY <= 0.75, `openY 越界：${first.openY}`);
  assert.equal(driver.state().active, true);
  assert.equal(driver.state().ticks, 1);
  assert.equal(driver.state().timerRunning, true);

  // random=0.5 → 间隔 = 90 + round(0.5*30) = 105ms
  clock.advance(104);
  assert.equal(rec.calls.length, 1, '还没到 105ms，不该有第二拍');
  clock.advance(1);
  assert.equal(rec.calls.length, 2, '到点必须继续驱动');
  assert.equal(rec.calls[1].ttlMs, 150);
  assert.ok(rec.calls[1].openY >= 0.15 && rec.calls[1].openY <= 0.75);
  assert.equal(driver.state().ticks, 2);

  clock.advance(105);
  assert.equal(rec.calls.length, 3);
  driver.stop();
});

test('节拍间隔钳在 90~120ms（random=0 → 90ms，random=1 → 120ms）', () => {
  for (const [randomValue, expectedMs] of [[0, 90], [0.999999, 120]]) {
    const clock = makeClock();
    const rec = recordingHandle();
    const driver = createDriver({
      getHandle: () => rec.handle,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
      random: () => randomValue,
    });
    driver.start();
    assert.equal(rec.calls.length, 1);
    clock.advance(expectedMs - 1);
    assert.equal(rec.calls.length, 1, `random=${randomValue} 时间隔应 ≥ ${expectedMs}ms`);
    clock.advance(1);
    assert.equal(rec.calls.length, 2, `random=${randomValue} 时间隔应 ≤ ${expectedMs}ms`);
    driver.stop();
  }
});

test('stop：停止并归零（最后一拍 openY=0），之后不再有任何写入', () => {
  const clock = makeClock();
  const rec = recordingHandle();
  const driver = createDriver({
    getHandle: () => rec.handle,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    random: () => 0.9,
  });

  driver.start();
  clock.advance(300);
  const beforeStop = rec.calls.length;
  assert.ok(beforeStop >= 3, `300ms 内应有 ≥3 拍（实际 ${beforeStop}）`);

  const stopped = driver.stop();
  assert.equal(stopped, true, '正在播时 stop() 应返回 true');
  assert.equal(rec.calls.length, beforeStop + 1, 'stop() 必须写一拍归零');
  assert.equal(rec.calls.at(-1).openY, 0, '归零那一拍 openY 必须是 0（嘴闭上）');
  assert.equal(rec.calls.at(-1).ttlMs, 150);
  assert.equal(driver.state().active, false);
  assert.equal(driver.state().timerRunning, false);
  assert.equal(driver.state().lastOpenY, 0);

  clock.advance(1000);
  assert.equal(rec.calls.length, beforeStop + 1, 'stop() 后定时器必须清掉，不能再驱动');
});

test('本来就没在播时 stop() 不写任何东西（别覆盖打字机等别的口型来源）', () => {
  const rec = recordingHandle();
  const driver = createDriver({ getHandle: () => rec.handle, random: () => 0.5 });
  assert.equal(driver.stop(), false);
  assert.equal(rec.calls.length, 0);
  assert.equal(driver.state().active, false);
});

test('重复 start() 幂等：不会叠加定时器（两倍节拍）', () => {
  const clock = makeClock();
  const rec = recordingHandle();
  const driver = createDriver({
    getHandle: () => rec.handle,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    random: () => 0.5,
  });
  driver.start();
  driver.start();
  driver.start();
  assert.equal(rec.calls.length, 1, '重复 start 只应有第一次的一拍');
  clock.advance(105);
  assert.equal(rec.calls.length, 2, '重复 start 后节拍仍是单倍');
  assert.equal(clock.pending, 1, '只应挂着一个定时器');
  driver.stop();
});

test('没有 applySpeech 的 handle 退回追踪层 MouthOpen（applyTrackingFrame）', () => {
  const clock = makeClock();
  const frames = [];
  const handle = {
    applyTrackingFrame(frame) {
      frames.push(frame);
    },
  };
  const driver = createDriver({
    getHandle: () => handle,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    random: () => 0.5,
  });

  driver.start();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].source, 'external');
  assert.ok(frames[0].mouth.openY >= 0.15 && frames[0].mouth.openY <= 0.75);
  driver.stop();
  assert.equal(frames.at(-1).mouth.openY, 0, '追踪层兜底也要归零');
});

test('模型还没挂载（handle=null）时不抛错，挂载后继续驱动', () => {
  const clock = makeClock();
  const rec = recordingHandle();
  let handle = null;
  const driver = createDriver({
    getHandle: () => handle,
    setTimer: clock.setTimeout,
    clearTimer: clock.clearTimeout,
    random: () => 0.3,
  });

  assert.doesNotThrow(() => driver.start());
  clock.advance(120);
  assert.equal(rec.calls.length, 0, '没有 handle 时不应该有写入');
  handle = rec.handle; // 模型挂载完成
  clock.advance(120);
  assert.ok(rec.calls.length >= 1, 'handle 就绪后应继续驱动');
  assert.doesNotThrow(() => driver.stop());
});

test('随机源给脏值（NaN/越界）也只会产生合法的 0..1 开口', () => {
  for (const bad of [Number.NaN, -3, 5]) {
    const clock = makeClock();
    const rec = recordingHandle();
    const driver = createDriver({
      getHandle: () => rec.handle,
      setTimer: clock.setTimeout,
      clearTimer: clock.clearTimeout,
      random: () => bad,
    });
    driver.start();
    const open = rec.calls[0].openY;
    assert.ok(Number.isFinite(open) && open >= 0 && open <= 1, `openY 非法：${open}`);
    driver.stop();
  }
});

/* ==========================================================================
 * 接线（静态）：playTtsAudio 必须真的 start/stop 这个驱动，页面也要加载该脚本
 * ========================================================================== */
const fs = require('node:fs');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

test('playTtsAudio 播放链路：开始驱动、ended/error/pause 停止归零', () => {
  const renderer = read('src/renderer/renderer.ts');
  const start = renderer.indexOf('function playTtsAudio(');
  assert.ok(start >= 0, '找不到 playTtsAudio');
  const end = renderer.indexOf('/** 设置页「试听语音」', start);
  const body = renderer.slice(start, end > start ? end : start + 4000);

  assert.match(body, /ttsMouth\(\)\?\.start\(\)/, 'playTtsAudio 开始播放时必须启动本地口型驱动');
  assert.match(body, /stopTtsMouth\(\)/, 'playTtsAudio 必须能停止/归零本地口型');
  for (const evt of ['ended', 'error', 'pause']) {
    assert.match(
      body,
      new RegExp(`addEventListener\\('${evt}'[\\s\\S]{0,400}stopTtsMouth\\(\\)`),
      `音频 ${evt} 时必须 stopTtsMouth()（停止并归零）`,
    );
  }
  // 打字机口型不能和 TTS 音频口型逐帧互抢
  assert.match(renderer, /if \(ttsMouthActive\(\)\) return;/, 'TTS 播放期间打字机口型要让位（否则两套写入互相覆盖）');
  assert.match(renderer, /mouth: ttsMouthDriver \? ttsMouthDriver\.state\(\) : null/, '__petDebug.tts() 要能看出本地口型状态');
});

test('页面与装配：ttsMouth.js 在 renderer.js 之前加载并随包装配', () => {
  const html = read('src/renderer/index.html');
  const mouthAt = html.indexOf('src="./ttsMouth.js"');
  const rendererAt = html.indexOf('src="./renderer.js"');
  assert.ok(mouthAt >= 0, 'index.html 必须加载 ttsMouth.js');
  assert.ok(mouthAt < rendererAt, 'ttsMouth.js 必须先于 renderer.js 加载');

  const assemble = read('scripts/assemble-renderer.js');
  assert.match(assemble, /'ttsMouth\.js'/, 'assemble-renderer.js 必须把 ttsMouth.js 装配进 public/renderer');
  assert.ok(fs.existsSync(path.join(APP, 'public', 'renderer', 'ttsMouth.js')), '装配产物里应有 ttsMouth.js（先 npm run assemble）');
});

