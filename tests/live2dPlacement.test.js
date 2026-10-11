/**
 * live2dPlacement.test.js — moc3 取景落位的纯函数（"角色被摆出窗口"的回归）。
 *
 * 背景（实测故障）：模型启动时**有时**角色向左偏出窗口。取景居中的基准不是画布包围盒，
 * 而是从"命中遮罩"里量出来的真实内容框；遮罩不是每帧都抓，只要换算时把遮罩那一帧的
 * 变换和此刻的 model.position/scale 混着用，量出来的局部内容框就会跑到画布外面去，
 * 按它摆位角色就出窗了。
 *
 * 这里锁住三条：
 *   ① 内容框合理时按内容居中（画布留白大的模型不被带偏）；缩放仍只按画布包围盒算；
 *   ② 内容框不可信（超出画布包围盒 / 太小 / 非有限值）时**必须**退回画布包围盒，
 *      并回报 contentRejected，让渲染层丢掉这个锚点；
 *   ③ 半身取景：缩放 ×2.5、横向仍居中、纵向把头顶顶到窗口上沿附近。
 *
 * 需要先 `npm run build:tsc`（npm test 已包含），加载的是 dist 产物（与运行时同一份代码）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST_LIVE2D = path.join(__dirname, '..', 'dist', 'renderer', 'live2d.js');

function loadLive2d() {
  // live2d.js 是浏览器全局脚本：模块级只做 `const w = window` + 挂 window.PetLive2d，
  // 其余（PIXI/document）都在函数里惰性取用，所以 Node 里给个空 window 就能加载纯函数。
  if (!globalThis.window) globalThis.window = {};
  delete require.cache[require.resolve(DIST_LIVE2D)];
  require(DIST_LIVE2D);
  const api = globalThis.window.PetLive2d ?? globalThis.PetLive2d;
  assert.ok(api && typeof api.__computeMoc3Placement === 'function', 'live2d 应暴露 __computeMoc3Placement');
  return api;
}

const VIEW = { vw: 360, vh: 520 };
const CANVAS = { natW: 400, natH: 500 };
/** 画布居中的内容框（1/2 宽、4/5 高） */
const CONTENT_INSIDE = { x: 100, y: 50, w: 200, h: 400 };

test('内容框可信：按真实内容居中，缩放仍按画布包围盒算', () => {
  const { __computeMoc3Placement: place } = loadLive2d();
  const r = place({ ...VIEW, ...CANVAS, framing: 'full', content: CONTENT_INSIDE });
  assert.ok(r, '应当算出落位');
  assert.equal(r.used, 'content');
  assert.equal(r.contentRejected, false);

  // 缩放 = 画布包围盒 fit（与内容框无关）
  const expectScale = Math.min((VIEW.vw * 0.89) / CANVAS.natW, (VIEW.vh * 0.89) / CANVAS.natH);
  assert.ok(Math.abs(r.scale - expectScale) < 1e-9, `缩放应只按画布包围盒：${r.scale} vs ${expectScale}`);

  // 内容中心必须落在窗口正中
  const centerX = r.x + (CONTENT_INSIDE.x + CONTENT_INSIDE.w / 2) * r.scale;
  const centerY = r.y + (CONTENT_INSIDE.y + CONTENT_INSIDE.h / 2) * r.scale;
  assert.ok(Math.abs(centerX - VIEW.vw / 2) < 0.5, `内容应在窗口水平中间：${centerX}`);
  assert.ok(Math.abs(centerY - VIEW.vh / 2) < 0.5, `内容应在窗口垂直中间：${centerY}`);
});

test('内容框不可信：退回画布包围盒（角色绝不被摆出窗口）', () => {
  const { __computeMoc3Placement: place } = loadLive2d();
  // 三个"换算用错帧"的典型症状：跑到画布外面、比画布大得离谱、小得离谱
  const bogus = [
    { name: '整体跑到画布右侧外', rect: { x: 800, y: 50, w: 200, h: 400 } },
    { name: '超出画布下沿', rect: { x: 100, y: 480, w: 200, h: 400 } },
    { name: '比画布大得多', rect: { x: -900, y: -900, w: 2000, h: 2000 } },
    { name: '小得离谱（挂载瞬间量出来的点）', rect: { x: 0, y: -1, w: 1, h: 2 } },
    { name: '非有限值', rect: { x: Number.NaN, y: 0, w: 200, h: 400 } },
  ];
  for (const { name, rect } of bogus) {
    const r = place({ ...VIEW, ...CANVAS, framing: 'full', content: rect });
    assert.ok(r, `${name}：仍应给出落位（退回包围盒）`);
    assert.equal(r.contentRejected, true, `${name}：应回报内容锚点被否掉`);
    assert.equal(r.used, 'bbox', `${name}：应退回画布包围盒`);

    // 退回包围盒后：画布居中 → 角色一定在窗口里（每边余量 ≥ 窗口的 5%）
    const expectX = VIEW.vw / 2 - (CANVAS.natW / 2) * r.scale;
    assert.ok(Math.abs(r.x - expectX) < 0.5, `${name}：应把画布居中（x=${r.x}，期望 ${expectX}）`);
    const left = r.x;
    const right = r.x + CANVAS.natW * r.scale;
    assert.ok(left > -VIEW.vw * 0.05 && right < VIEW.vw * 1.05, `${name}：画布应基本落在窗口里（${left}..${right}）`);
  }
});

test('半身取景：缩放 ×2.5、横向仍居中、纵向头顶贴上沿附近', () => {
  const { __computeMoc3Placement: place } = loadLive2d();
  const full = place({ ...VIEW, ...CANVAS, framing: 'full', content: CONTENT_INSIDE });
  const half = place({ ...VIEW, ...CANVAS, framing: 'half', content: CONTENT_INSIDE });
  assert.ok(full && half);
  assert.ok(Math.abs(half.scale - full.scale * 2.5) < 1e-9, `半身缩放应是全身的 2.5 倍：${half.scale} vs ${full.scale * 2.5}`);
  const centerX = half.x + (CONTENT_INSIDE.x + CONTENT_INSIDE.w / 2) * half.scale;
  assert.ok(Math.abs(centerX - VIEW.vw / 2) < 0.5, `半身横向仍应对准内容中心：${centerX}`);
  // 头顶：内容 y 处落在窗口上沿 4% 处（±1px）
  const topY = half.y + CONTENT_INSIDE.y * half.scale;
  assert.ok(Math.abs(topY - VIEW.vh * 0.04) < 1, `半身应把头顶顶到上沿附近：${topY}`);
  // 半身会明显超出窗口下沿（脚被裁掉是对的）
  assert.ok(half.y + (CONTENT_INSIDE.y + CONTENT_INSIDE.h) * half.scale > VIEW.vh, '半身应裁掉下半身');
});

test('没有内容框时直接用画布包围盒；尺寸非法时不落位（宁可不动）', () => {
  const { __computeMoc3Placement: place } = loadLive2d();
  const r = place({ ...VIEW, ...CANVAS, framing: 'full', content: null });
  assert.ok(r);
  assert.equal(r.used, 'bbox');
  assert.equal(r.contentRejected, false);
  assert.equal(place({ ...VIEW, ...CANVAS, natW: 0, framing: 'full', content: null }), null);
  assert.equal(place({ vw: 0, vh: 0, ...CANVAS, framing: 'full', content: null }), null);
});
