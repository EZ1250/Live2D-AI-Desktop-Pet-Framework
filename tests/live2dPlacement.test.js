/** moc3 取景落位纯函数回归测试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST_LIVE2D = path.join(__dirname, '..', 'dist', 'renderer', 'live2d.js');

function loadLive2d() {
  // live2d.js 依赖浏览器全局对象，测试中提供最小 window。
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

  // 缩放按画布包围盒计算。
  const expectScale = Math.min((VIEW.vw * 0.89) / CANVAS.natW, (VIEW.vh * 0.89) / CANVAS.natH);
  assert.ok(Math.abs(r.scale - expectScale) < 1e-9, `缩放应只按画布包围盒：${r.scale} vs ${expectScale}`);

  // 内容中心应位于窗口中央。
  const centerX = r.x + (CONTENT_INSIDE.x + CONTENT_INSIDE.w / 2) * r.scale;
  const centerY = r.y + (CONTENT_INSIDE.y + CONTENT_INSIDE.h / 2) * r.scale;
  assert.ok(Math.abs(centerX - VIEW.vw / 2) < 0.5, `内容应在窗口水平中间：${centerX}`);
  assert.ok(Math.abs(centerY - VIEW.vh / 2) < 0.5, `内容应在窗口垂直中间：${centerY}`);
});

test('内容框不可信：退回画布包围盒（角色绝不被摆出窗口）', () => {
  const { __computeMoc3Placement: place } = loadLive2d();
  // 无效情形：小得离谱 / 大得离谱 / 非有限值 / 偏移得没边。
  // 注意：**不能**再拿"内容超出画布包围盒"当无效 —— 真机上 Hiyori 的正确内容框就在画布
  // 包围盒之外（见下面那条用例），那是引擎坐标系的原点问题，不是量歪。
  const bogus = [
    { name: '小得离谱（挂载瞬间量出来的点）', rect: { x: 0, y: -1, w: 1, h: 2 } },
    { name: '比画布大得多', rect: { x: -900, y: -900, w: 2000, h: 2000 } },
    { name: '非有限值', rect: { x: Number.NaN, y: 0, w: 200, h: 400 } },
    { name: '偏移得没边', rect: { x: 5000, y: 50, w: 200, h: 400 } },
  ];
  for (const { name, rect } of bogus) {
    const r = place({ ...VIEW, ...CANVAS, framing: 'full', content: rect });
    assert.ok(r, `${name}：仍应给出落位（退回包围盒）`);
    assert.equal(r.contentRejected, true, `${name}：应回报内容锚点被否掉`);
    assert.equal(r.used, 'bbox', `${name}：应退回画布包围盒`);

    // 回退后画布应基本位于窗口内。
    const expectX = VIEW.vw / 2 - (CANVAS.natW / 2) * r.scale;
    assert.ok(Math.abs(r.x - expectX) < 0.5, `${name}：应把画布居中（x=${r.x}，期望 ${expectX}）`);
    const left = r.x;
    const right = r.x + CANVAS.natW * r.scale;
    assert.ok(left > -VIEW.vw * 0.05 && right < VIEW.vw * 1.05, `${name}：画布应基本落在窗口里（${left}..${right}）`);
  }
});

test('局部原点不在内容左上角（Hiyori 实测形状）：内容框必须被接受并按内容居中', () => {
  // 真机数值（2026-10-21，Hiyori 在 pixi-live2d 引擎上实测）：
  //   画布 1211×3778，但真实内容在局部坐标 x≈932..2102 —— **原点并不在内容左上角**，
  //   `model.width/height` 只给尺寸、不给偏移。
  // 旧规则"内容必须落在 [0,natW] 内"会把这条**正确**的测量否掉；退回画布包围盒后
  // 角色只剩右边缘一条（用户看到的"只显示一部分 + 严重偏移"）。这里把它锁死。
  const { __computeMoc3Placement: place } = loadLive2d();
  const HIYORI = { natW: 1211.22, natH: 3777.86 };
  const CONTENT = { x: 932, y: 328, w: 1170, h: 3745 };
  const vw = 364;
  const vh = 522;

  const full = place({ vw, vh, ...HIYORI, framing: 'full', content: CONTENT });
  assert.ok(full);
  assert.equal(full.used, 'content', '偏移原点的模型必须接受内容框，否则会被摆到窗口外');
  assert.equal(full.contentRejected, false);
  const cx = full.x + (CONTENT.x + CONTENT.w / 2) * full.scale;
  const cy = full.y + (CONTENT.y + CONTENT.h / 2) * full.scale;
  assert.ok(Math.abs(cx - vw / 2) < 0.5, `全身：内容中心应在窗口水平中间（${cx}）`);
  assert.ok(Math.abs(cy - vh / 2) < 0.5, `全身：内容中心应在窗口垂直中间（${cy}）`);

  const half = place({ vw, vh, ...HIYORI, framing: 'half', content: CONTENT });
  assert.ok(half);
  assert.equal(half.used, 'content');
  const hcx = half.x + (CONTENT.x + CONTENT.w / 2) * half.scale;
  assert.ok(Math.abs(hcx - vw / 2) < 0.5, `半身：横向仍应居中（${hcx}）`);
  const topY = half.y + CONTENT.y * half.scale;
  assert.ok(Math.abs(topY - vh * 0.04) < 1, `半身：内容顶部应贴窗口上沿附近（${topY}）`);
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
