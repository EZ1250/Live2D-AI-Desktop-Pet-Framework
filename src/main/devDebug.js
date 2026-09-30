/**
 * devDebug.js —— 开发 / 自动化调试钩子（全部由 `PET_*` 环境变量开关）
 *
 * 单独成文件的原因：这些钩子约 800 行，但**正常运行一行都不执行**。入口（mainImpl.js bootstrap）
 * 只在存在任意 `PET_*` 变量时 require 本模块；没设变量时本文件根本不会被加载。
 *
 * 覆盖的开关：
 *   PET_OPEN_CHAT / PET_OPEN_THINK / PET_OPEN_THINK_DELAY / PET_DRAG_TEST / PET_ZOOM_TEST /
 *   PET_FRAMING_TEST / PET_TRACKING_TEST / PET_BOOT_TIMING / PET_R16_TEST / PET_BLUR_AB /
 *   PET_FRAMING / PET_UI_DEMO / PET_VOICELAB_TEST / PET_PRESET_TEST / PET_OPEN_SETTINGS /
 *   PET_SETTINGS_AUDIT / PET_MODEL / PET_AUTO_CLICK_ASK / PET_SHOT_DIR / PET_SHOT_DELAY /
 *   PET_SHOT_EXIT / PET_CHAT_SEND
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

/** 有没有任何 PET_* 调试变量（没有就不加载本模块） */
function debugEnabled(env = process.env) {
  return Object.keys(env).some((k) => k.startsWith('PET_'));
}

/**
 * 挂载全部调试钩子。
 * ctx 提供主进程内部的句柄：窗口用 getter（钩子可能晚于开窗执行，不能取快照）。
 */
async function installDevDebug(ctx) {
  const {
    contracts,
    userAssets,
    resolver,
    srv,
    chat,
    registry,
    PathResolver,
    openChatWindow,
    showThinkWindowWindow,
    debugDragPet,
    debugZoomModel,
    debugSendChat,
    captureDebugScreenshots,
    getMainWindow,
    getChatWindow,
    // 点击穿透的状态读取器（只读）：用于"穿透极性自检"直接读真实状态，
    // 而不是靠推理判断方向对不对
    getHitIgnoreState,
    clickThroughEnabledOn,
  } = ctx;
      // 调试钩子（仅在显式设置环境变量时生效）
      //     PET_OPEN_CHAT=1      启动即打开独立聊天窗口
      //     PET_SHOT_DIR=<目录>  载入完成后把桌宠窗口 / 聊天窗口各截一张 png
      //     PET_SHOT_DELAY=<ms>  截图延迟（默认 9000；模型与对话都要时间加载）
      //     PET_SHOT_EXIT=1      截图后自动退出
      // 穿透极性时序记录：每秒采一次（光标位置 / 命中结果 / 真实穿透状态）。
      // 目的是客观判定"命中角色=不穿透、透明区=穿透"是否成立，而不是靠推理。
      if (process.env.PET_HIT_TRACE === '1') {
          const fsMod = require('fs');
          const osMod = require('os');
          const pathMod = require('path');
          const outFile = process.env.PET_HIT_TRACE_FILE || pathMod.join(osMod.tmpdir(), 'pet_hit_trace.txt');
          const t0 = Date.now();
          const samples = [];
          const flush = () => {
              try {
                  fsMod.writeFileSync(outFile, samples.map((s) =>
                      '  +' + String(s.t).padStart(6) + 'ms  光标客户区(' + s.cx + ',' + s.cy + ')'
                      + '  窗内=' + s.inside + '  面板=' + s.overlay + '  命中=' + s.hit + '  期望穿透=' + s.want
                      + '  实际穿透=' + s.ignore + '  ' + s.verdict
                  ).join('\n') + '\n', 'utf8');
              }
              catch { /* ignore */ }
          };
          const timer = setInterval(async () => {
              try {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed()) return;
                  if (typeof getHitIgnoreState !== 'function') return;
                  const ignore = getHitIgnoreState();
                  const pt = require('electron').screen.getCursorScreenPoint();
                  const b = win.getBounds();
                  const cx = Math.round(pt.x - b.x);
                  const cy = Math.round(pt.y - b.y);
                  const inside = cx >= 0 && cy >= 0 && cx < b.width && cy < b.height;
                  let hit = null;
                  if (inside) {
                      try {
                          hit = await win.webContents.executeJavaScript(
                              '(function(){var d=window.__petDebug;'
                              + 'if(!d||typeof d.hitTest!=="function")return null;'
                              + 'var r=d.hitTest(' + cx + ',' + cy + ');return r?{ok:!!r.ok,hit:!!r.hit}:null;})()'
                          );
                      }
                      catch { /* ignore */ }
                  }
                  let overlay = null;
                  if (inside) {
                      try {
                          overlay = await win.webContents.executeJavaScript(
                              '(function(){var d=window.__petDebug;return (d&&typeof d.overlayOpen==="function")?d.overlayOpen():null;})()'
                          );
                      }
                      catch { /* ignore */ }
                  }
                  const hitV = hit && typeof hit === 'object' ? hit.hit : null;
                  const okV = hit && typeof hit === 'object' ? hit.ok : null;
                  const want = (okV === false || hitV === null) ? null : !hitV;
                  const verdict = (want === null) ? '(不判定)' : (ignore === want ? 'OK' : 'XX 方向反了');
                  samples.push({ t: Date.now() - t0, cx, cy, inside, overlay, hit: hitV, want, ignore, verdict });
                  flush();
              }
              catch { /* 采样失败不影响主流程 */ }
          }, 1000);
          if (timer.unref) timer.unref();
          console.log('[main][debug] PET_HIT_TRACE=1 → 记录穿透极性时序到 ' + outFile);
      }
      if (process.env.PET_OPEN_CHAT === '1') {
          const opened = await openChatWindow(resolver, srv);
          console.log(`[main][debug] PET_OPEN_CHAT=1 → 气泡窗 ${opened.ok ? '已打开' : `打开失败：${opened.error}`}`);
      }
      if (process.env.PET_OPEN_THINK === '1') {
          showThinkWindowWindow(resolver, srv);
          console.log('[main][debug] PET_OPEN_THINK=1 → 思考浮窗已打开');
      }
      const thinkDelay = Number(process.env.PET_OPEN_THINK_DELAY) || 0;
      if (thinkDelay > 0) {
          // 延迟打开思考浮窗：用来验证"气泡已经占了一侧时，思考浮窗要换到另一侧"
          setTimeout(() => {
              showThinkWindowWindow(resolver, srv);
              console.log('[main][debug] PET_OPEN_THINK_DELAY → 思考浮窗已打开');
          }, thinkDelay);
      }
      if (process.env.PET_DRAG_TEST === '1') {
          setTimeout(() => {
              void debugDragPet();
          }, 6000);
      }
      if (process.env.PET_ZOOM_TEST === '1') {
          setTimeout(() => {
              void debugZoomModel();
          }, 6000);
      }
      // 调试用：启动后实测"全身/半身"取景是否真的改变了角色的可见范围（打印数字，不靠肉眼）
      if (process.env.PET_FRAMING_TEST === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      const dump = await win.webContents.executeJavaScript(`(() => {
                 const d = window.__petDebug;
                 if (!d || typeof d.framing !== 'function') return { error: 'no __petDebug' };
                 const before = d.bounds();
                 d.framing('half');
                 const half = d.bounds();
                 d.framing('full');
                 const full = d.bounds();
                 return { modeAfter: d.framingMode(), before, half, full };
               })()`);
                      console.log('[main][debug] 取景实测：' + JSON.stringify(dump));
                  }
                  catch (err) {
                      console.warn('[main][debug] 取景实测失败：', err.message);
                  }
              })();
          }, 7000);
      }
      // 调试用：实测"追踪参数层 + 情感 → 表情 + 语音口型"是否真的进了渲染层（打印数字/名字，不靠肉眼）
      if (process.env.PET_TRACKING_TEST === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      const dump = await win.webContents.executeJavaScript(`(async () => {
                 const d = window.__petDebug;
                 if (!d || typeof d.tracking !== 'function') return { error: 'no __petDebug.tracking' };
                 const before = d.tracking();
                 const pushed = d.pushTracking({ head: { yaw: 0.6, pitch: -0.4, roll: 0.2 }, eyes: { blinkL: 0.25, blinkR: 0.1 }, mouth: { openY: 0.5 } }, 'debug');
                 await new Promise((r) => setTimeout(r, 120));
                 const after = d.tracking();
                 const expr = d.emotion('太好了，谢谢你！');
                 // 模型预设（pet-model.json 的 emotionMap）：运行时指定一个真实存在的表情名，验证"情绪→本模型表情"这条路
                 const exprs = typeof d.expressions === 'function' ? (d.expressions() || []) : [];
                 const mappedName = exprs.length ? exprs[0] : null;
                 d.emotionMap(mappedName ? { happy: mappedName } : {});
                 const exprMapped = d.emotion('太好了，谢谢你！');
                 const speech = (() => { d.speech(0.8, 400); return d.tracking().handle; })();
                 const voice = typeof d.voice === 'function' ? d.voice() : null;
                 const micBtn = document.getElementById('chat-mic');
                 // 输入行三个控件的实测高度：vl 目检说"麦克风略高"，这里用像素值判定到底齐不齐
                 const rowHeights = (() => {
                   const pick = (id) => { const el = document.getElementById(id); return el ? Math.round(el.getBoundingClientRect().height * 10) / 10 : null; };
                   return { input: pick('chat-input'), mic: pick('chat-mic'), send: pick('chat-send') };
                 })();
                 // 参数映射（parameterMap）：正常映射 / 故意写错（错的名字应表现为"参数不存在"，而不是崩）
                 const paramBefore = typeof d.paramInfo === 'function' ? d.paramInfo() : null;
                 const paramMapped = typeof d.setParamMap === 'function' ? d.setParamMap({ AngleX: 'ParamAngleX', MouthOpenY: 'ParamMouthOpenY' }) : null;
                 const paramAfter = typeof d.paramInfo === 'function' ? d.paramInfo() : null;
                 const paramBroken = typeof d.setParamMap === 'function' ? d.setParamMap({ AngleX: 'NotARealParamXYZ', MouthOpenY: 'ParamMouthOpenY' }) : null;
                 const paramBrokenInfo = typeof d.paramInfo === 'function' ? d.paramInfo() : null;
                 // 复原，别把角色留在坏映射上
                 if (typeof d.setParamMap === 'function') d.setParamMap({ AngleX: 'ParamAngleX', MouthOpenY: 'ParamMouthOpenY' });
                 return {
                   pushed,
                   beforeHandle: before && before.handle,
                   afterHandle: after && after.handle,
                   sources: after && (after.sources || []).map((s) => s.id),
                   driver: after && after.driver,
                   lastSource: after && after.handle && after.handle.lastSource,
                   emotionExpression: expr,
                   expressions: exprs,
                   mappedEmotionExpression: exprMapped,
                   lastEmotion: after && after.lastEmotion,
                   speechLayers: speech && speech.sources,
                   voice,
                   paramBefore,
                   paramMapped,
                   paramAfter,
                   paramBroken,
                   paramBrokenInfo,
                   micPresent: !!micBtn,
                   micVisible: micBtn ? (micBtn.getBoundingClientRect().width > 0) : false,
                   rowHeights,
                 };
               })()`);
                      console.log('[main][debug] 追踪/情感/语音实测：' + JSON.stringify(dump));
                  }
                  catch (err) {
                      console.warn('[main][debug] 追踪实测失败：', err.message);
                  }
              })();
          }, 7000);
      }
      // 调试用：启动耗时打点——主进程时间线 + 渲染层时间线（回答"exe 启动慢到底慢在哪"）
      if (process.env.PET_BOOT_TIMING === '1') {
          const marks = [];
          const mt0 = process.hrtime.bigint();
          const mark = (label) => {
              marks.push([label, Number(process.hrtime.bigint() - mt0) / 1e6]);
          };
          mark('now');
          app.whenReady().then(() => {
              mark('whenReady');
              setTimeout(() => {
                  void (async () => {
                      mark('after 6s');
                      const win = getMainWindow();
                      const lines = marks.map(([l, ms]) => `${l}=${ms.toFixed(0)}ms`);
                      let renderer = null;
                      if (win && !win.isDestroyed()) {
                          try {
                              renderer = await win.webContents.executeJavaScript(`(() => { const b = window.__petBoot; return b ? { t0: Math.round(b.t0), timeline: b.timeline } : null; })()`);
                          }
                          catch (err) {
                              renderer = { error: err.message };
                          }
                      }
                      console.log(`[main][debug] 启动打点（主进程）: ${lines.join(' | ')}`);
                      console.log(`[main][debug] 启动打点（渲染层）: ${JSON.stringify(renderer)}`);
                  })();
              }, 6000);
          });
      }
      // 调试用（本轮）：①半身取景截图 ②右键菜单是否还在窗口里 ③语音自检走渲染层整条链路
      if (process.env.PET_R16_TEST === '1') {
          setTimeout(() => {
              void (async () => {
                  const out = {};
                  const win = getMainWindow();
                  if (win && !win.isDestroyed()) {
                      try {
                          // ② 右键菜单：贴窗口底边开一次，看它是否被裁（rect 必须完全落在窗口内）
                          win.webContents.send(contracts.IPC_CONTEXT_MENU, { x: 30, y: 500 });
                          await new Promise((r) => setTimeout(r, 500));
                          out.menu = await win.webContents.executeJavaScript(`(() => {
                   const m = document.getElementById('context-menu');
                   if (!m || m.hidden) return { error: 'menu not shown' };
                   const r = m.getBoundingClientRect();
                   const cs = getComputedStyle(m);
                   const items = m.querySelectorAll('button').length;
                   return {
                     items, top: Math.round(r.top), height: Math.round(r.height), width: Math.round(r.width),
                     maxHeight: cs.maxHeight, overflowY: cs.overflowY,
                     insideWindow: r.top >= 0 && r.bottom <= window.innerHeight + 0.5,
                     scrollable: m.scrollHeight > m.clientHeight,
                     // 能力归类落到菜单的证据：服饰/道具组（模型没有这一类时必须整组隐藏）
                     costumeHidden: (() => { const g = document.getElementById('cm-costume'); return g ? g.hidden : null; })(),
                     costumeItems: Array.from(document.querySelectorAll('#cm-costume-list button')).map((b) => b.textContent),
                     expressionHidden: (() => { const g = document.getElementById('cm-expressions'); return g ? g.hidden : null; })(),
                     expressionCount: document.querySelectorAll('#cm-expression-list button').length,
                     lastItemVisible: (() => {
                       const bs = m.querySelectorAll('button');
                       const last = bs[bs.length - 1];
                       if (!last) return null;
                       const lr = last.getBoundingClientRect();
                       return lr.bottom <= window.innerHeight + 0.5 && lr.top >= 0;
                     })(),
                   };
                 })()`);
                          await win.webContents.executeJavaScript(`document.getElementById('context-menu').hidden = true; 'ok'`);
                          // ③ 语音自检：走设置页按钮 → IPC → 两条真实路由（合成音频，不含用户录音）
                          await win.webContents.executeJavaScript(`(async () => { await window.electron?.setSettings?.({}); document.getElementById('context-menu [data-menu-action="settings"]')?.click(); return 'ok'; })()`);
                          await new Promise((r) => setTimeout(r, 800));
                          await win.webContents.executeJavaScript(`document.getElementById('setting-voice-check')?.click(); 'clicked'`);
                          await new Promise((r) => setTimeout(r, 12000));
                          out.voice = await win.webContents.executeJavaScript(`(() => {
                   const st = document.getElementById('setting-voice-status');
                   const route = document.getElementById('setting-voice-route');
                   const model = document.getElementById('setting-voice-model');
                   return {
                     statusText: st ? st.textContent : null,
                     hasRoute: !!route, routeValue: route ? route.value : null,
                     hasModel: !!model, panelOpen: !document.getElementById('settings-panel').hidden,
                   };
                 })()`);
                      }
                      catch (err) {
                          out.error = err.message;
                      }
                  }
                  try {
                      console.log('[main][debug] R16 实测：' + JSON.stringify(out));
                  }
                  catch (serr) {
                      console.log('[main][debug] R16 实测（序列化失败）：' + (serr && serr.message));
                  }
              })().catch((err) => console.log('[main][debug] R16 异常：' + (err && err.message)));
          }, 7000);
      }
      // 调试用：边缘"虚化层"的 A/B 取证——有/无 backdrop-filter 各截一张原分辨率边缘图，
      // 便于用像素高频能量证明"确实糊了"（不是只写了 CSS 就说糊了）
      if (process.env.PET_BLUR_AB === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  const shotDir = process.env.PET_SHOT_DIR;
                  if (!win || win.isDestroyed() || !shotDir)
                      return;
                  try {
                      fs.mkdirSync(shotDir, { recursive: true });
                      const size = win.getContentSize();
                      // 用**静态条纹探针**做确定性取证：角色本身在 60fps 动，两次截图的时间差会淹没有效信号。
                      // 探针铺满窗口、叠在 #stage 之上但低于虚化层(z=5)，边缘带的条纹被模糊后高频能量必然大跌。
                      await win.webContents.executeJavaScript(`(() => {
                 let p = document.getElementById('blur-probe');
                 if (!p) {
                   p = document.createElement('div');
                   p.id = 'blur-probe';
                   p.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none;background:repeating-linear-gradient(90deg,#ffffff 0 4px,#000000 4px 8px)';
                   document.body.appendChild(p);
                 }
                 return 'ok';
               })()`);
                      const band = { x: 0, y: Math.round(size[1] * 0.4), width: 90, height: 140 };
                      const info = await win.webContents.executeJavaScript(`(() => {
                 const layer = document.getElementById('stage-blur');
                 const cs = layer ? getComputedStyle(layer) : null;
                 return {
                   exists: !!layer,
                   display: cs ? cs.display : null,
                   backdrop: cs ? (cs.backdropFilter || cs.webkitBackdropFilter || '') : null,
                   maskHead: cs ? (cs.maskImage || cs.webkitMaskImage || 'none').slice(0, 80) : null,
                 };
               })()`);
                      const withBlur = await win.webContents.capturePage(band);
                      fs.writeFileSync(path.join(shotDir, 'edge-with-blur.png'), withBlur.toPNG());
                      await win.webContents.executeJavaScript(`(() => { const s = document.createElement('style'); s.id = 'no-blur-probe'; s.textContent = 'body.framing-half .stage-blur{display:none !important}'; document.head.appendChild(s); return 'ok'; })()`);
                      await new Promise((r) => setTimeout(r, 400));
                      const noBlur = await win.webContents.capturePage(band);
                      fs.writeFileSync(path.join(shotDir, 'edge-no-blur.png'), noBlur.toPNG());
                      // 第三次：再开虚化，但给 html 一个"几乎看不见"的底色——验证 backdrop-filter 是否因为
                      // 透明窗口没有 backdrop 才失效（若这次糊了，说明能用"1% 底色"这个 hack 换到真虚化）
                      await win.webContents.executeJavaScript(`(() => {
                 document.getElementById('no-blur-probe')?.remove();
                 const s = document.createElement('style'); s.id = 'bg-probe';
                 s.textContent = 'html{background:rgba(0,0,0,0.01) !important}';
                 document.head.appendChild(s);
                 return 'ok';
               })()`);
                      await new Promise((r) => setTimeout(r, 400));
                      const bgHack = await win.webContents.capturePage(band);
                      fs.writeFileSync(path.join(shotDir, 'edge-bg-hack.png'), bgHack.toPNG());
                      await win.webContents.executeJavaScript(`document.getElementById('bg-probe')?.remove(); document.getElementById('blur-probe')?.remove(); 'ok'`);
                      console.log('[main][debug] 边缘虚化 A/B：' + JSON.stringify({ info, band }));
                  }
                  catch (err) {
                      console.warn('[main][debug] 边缘虚化 A/B 失败：', err.message);
                  }
              })();
          }, 6000);
      }
      // 调试用：渲染质量取证——把 WebGL 上下文属性、画布像素比、贴图 mipmap 状态、
      // CSS 合成层（filter/mask）与帧耗时全部打印出来，用来定位"模型毛边/糊"的根因。
      if (process.env.PET_GPU_AUDIT === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      const dump = await win.webContents.executeJavaScript(`(async () => {
                 const stage = document.getElementById('stage');
                 const canvas = stage ? stage.querySelector('canvas') : null;
                 let gl = null, glAttrs = null;
                 if (canvas) {
                   gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
                   glAttrs = gl ? gl.getContextAttributes() : null;
                 }
                 const d = window.__petDebug;
                 const dbg = d && typeof d.moc3Debug === 'function' ? d.moc3Debug() : null;
                 // 帧耗时采样：取 60 帧
                 const t0 = performance.now();
                 await new Promise((r) => {
                   let n = 0;
                   const step = () => { if (++n >= 60) r(); else requestAnimationFrame(step); };
                   requestAnimationFrame(step);
                 });
                 const frameMs = (performance.now() - t0) / 60;
                 const ms = stage ? getComputedStyle(stage) : null;
                 const mc = canvas ? getComputedStyle(canvas) : null;
                 // 命中遮罩体检：问渲染层"遮罩对几个采样点判为命中"。
                 // 没有这个，"穿透不生效"只能靠猜（历史上正是读画布的时机不对，遮罩恒为空）。
                 let hitDiag = null;
                 try {
                   const d2 = window.__petDebug;
                   if (d2 && typeof d2.hitTest === 'function' && canvas) {
                     const cw = canvas.clientWidth || 1;
                     const chh = canvas.clientHeight || 1;
                     const pts = [[0.5, 0.5], [0.5, 0.25], [0.5, 0.75], [0.2, 0.5], [0.8, 0.5],
                                  [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7],
                                  [0.5, 0.1], [0.5, 0.9], [0.1, 0.5], [0.9, 0.5]];
                     // 再从遮罩包围盒内部取两个点：这两点必须判为命中，否则说明命中判定没接上
                     const st = (typeof d2.hitMaskStats === 'function') ? d2.hitMaskStats() : null;
                     if (st && st.bbox) {
                       const [bx0, by0, bx1, by1] = st.bbox;
                       pts.push([(bx0 + bx1) / 2, (by0 + by1) / 2], [bx0 + (bx1 - bx0) * 0.25, by0 + (by1 - by0) * 0.5]);
                     }
                     hitDiag = {
                       hasApi: true,
                       stats: (typeof d2.hitMaskStats === 'function') ? d2.hitMaskStats() : null,
                       bounds: (typeof d2.contentBounds === 'function') ? d2.contentBounds() : null,
                       probes: pts.map((p) => {
                         const r = d2.hitTest(p[0] * cw, p[1] * chh);
                         return { at: p, ok: !!(r && r.ok), hit: !!(r && r.hit) };
                       }),
                     };
                   } else {
                     hitDiag = { hasApi: false };
                   }
                 } catch (e) { hitDiag = { error: String(e && e.message) }; }
                 return {
                   dpr: window.devicePixelRatio,
                   inner: [window.innerWidth, window.innerHeight],
                   canvasCss: canvas ? [canvas.clientWidth, canvas.clientHeight] : null,
                   canvasBuffer: canvas ? [canvas.width, canvas.height] : null,
                   glAttrs: glAttrs ? { antialias: glAttrs.antialias, alpha: glAttrs.alpha, premultipliedAlpha: glAttrs.premultipliedAlpha, preserveDrawingBuffer: glAttrs.preserveDrawingBuffer, powerPreference: glAttrs.powerPreference } : null,
                   glVersion: gl ? gl.getParameter(gl.VERSION) : null,
                   canvasFilter: mc ? mc.filter : null,
                   stageMask: ms ? (ms.maskImage || ms.webkitMaskImage || 'none').slice(0, 40) : null,
                   canvasMask: mc ? (mc.maskImage || mc.webkitMaskImage || 'none').slice(0, 40) : null,
                   bodyClass: document.body.className,
                   frameMs: Math.round(frameMs * 100) / 100,
                   moc3: dbg,
                   hitMask: hitDiag,
                 };
               })()`);
                      console.log('[main][debug] GPU/渲染审计：' + JSON.stringify(dump));
                      // 打包版是 GUI 子系统程序、不带控制台，stdout 拿不到；
                      // 设了 PET_AUDIT_FILE 就同时落盘一份，便于在真实运行环境里读取。
                      if (process.env.PET_AUDIT_FILE) {
                          try {
                              require('fs').appendFileSync(process.env.PET_AUDIT_FILE, 'GPU/渲染审计：' + JSON.stringify(dump) + '\n', 'utf8');
                          }
                          catch (e) {
                              console.warn('[main][debug] 审计落盘失败：', e.message);
                          }
                      }
                      // 穿透极性自检：直接读主进程侧 setIgnoreMouseEvents 的真实状态，
                      // 与渲染层命中结果对照。极性对不对不该靠推理。
                      try {
                          const hm = dump && dump.hitMask;
                          const probes = (hm && Array.isArray(hm.probes)) ? hm.probes : [];
                          const ignoreState = (typeof getHitIgnoreState === 'function') ? getHitIgnoreState() : null;
                          const lines = probes.map((q) => {
                              const wantIgnore = !q.hit;
                              const verdict = (ignoreState === null) ? '?' : (ignoreState === wantIgnore ? 'OK' : '✗方向反了');
                              return '    位置 ' + JSON.stringify(q.at) + '  命中=' + q.hit + '  期望穿透=' + wantIgnore + '  实际穿透=' + ignoreState + '  ' + verdict;
                          });
                          const txt = '[main][debug] 穿透极性自检（enabled=' + (typeof clickThroughEnabledOn === 'function' ? clickThroughEnabledOn() : '?') + '）：\n' + (lines.length ? lines.join('\n') : '    (无采样点)');
                          console.log(txt);
                          if (process.env.PET_AUDIT_FILE) {
                              try { require('fs').appendFileSync(process.env.PET_AUDIT_FILE, txt + '\n', 'utf8'); } catch { /* ignore */ }
                          }
                      }
                      catch (e) {
                          console.warn('[main][debug] 穿透极性自检失败：', e.message);
                      }
                  }
                  catch (err) {
                      console.warn('[main][debug] GPU 审计失败：', err.message);
                  }
              })();
          }, 6500);
      }
      // 调试用：把取景固定成某个值再截图（PET_FRAMING=half 时启动即半身，用来和参考图比对）
      if (process.env.PET_FRAMING === 'half' || process.env.PET_FRAMING === 'full') {
          const want = process.env.PET_FRAMING;
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      const res = await win.webContents.executeJavaScript(`(() => {
                 const d = window.__petDebug;
                 if (!d) return null;
                 d.framing('${want}');
                 const stage = document.getElementById('stage');
                 const canvas = stage ? stage.querySelector('canvas') : null;
                 const ms = stage ? getComputedStyle(stage) : null;
                 const mc = canvas ? getComputedStyle(canvas) : null;
                 return {
                   mode: d.framingMode(),
                   bounds: d.bounds(),
                   bodyClass: document.body.className,
                   stageMask: ms ? (ms.maskImage || ms.webkitMaskImage || 'none').slice(0, 120) : null,
                   canvasMask: mc ? (mc.maskImage || mc.webkitMaskImage || 'none').slice(0, 120) : null,
                 };
               })()`);
                      console.log(`[main][debug] 取景固定为 ${want}：${JSON.stringify(res)}`);
                  }
                  catch (err) {
                      console.warn('[main][debug] 设置取景失败：', err.message);
                  }
              })();
          }, 3500);
      }
      // 调试用：往对话里插演示行（不写聊天记录）+ 驱动声纹，给 vl 目检气泡/波形用
      if (process.env.PET_UI_DEMO === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getChatWindow() && !getChatWindow().isDestroyed() ? getChatWindow() : getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      const dump = await win.webContents.executeJavaScript(`(() => {
                 const d = window.__petDebug;
                 const count = d && typeof d.chatDemo === 'function' ? d.chatDemo() : -1;
                 // 声纹图标 + 气泡框两侧淡出的"客观取证"：不看图也能确认 DOM/计算样式是否真的生效
                 const mic = document.getElementById('chat-mic');
                 const bar = document.getElementById('chatbar');
                 const frame = bar ? getComputedStyle(bar, '::before') : null;
                 const barCs = bar ? getComputedStyle(bar) : null;
                 const iconInfo = {
                   hasSvg: !!(mic && mic.querySelector('svg')),
                   lineCount: mic ? mic.querySelectorAll('.chat-mic-ico line').length : 0,
                   emojiLeft: mic ? /\uD83C\uDFA4/.test(mic.textContent || '') : null,
                   iconBox: mic && mic.querySelector('.chat-mic-ico')
                     ? (() => { const r = mic.querySelector('.chat-mic-ico').getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })()
                     : null,
                 };
                 const frameInfo = {
                   pseudoContent: frame ? frame.content : null,
                   maskImage: frame ? (frame.maskImage || frame.webkitMaskImage || '').slice(0, 120) : null,
                   frameBg: frame ? frame.backgroundColor : null,
                   elementBg: barCs ? barCs.backgroundColor : null,
                   elementBorder: barCs ? barCs.borderTopWidth : null,
                   fade: barCs ? barCs.getPropertyValue('--frame-fade').trim() : null,
                 };
                 const rows = Array.from(document.querySelectorAll('#chat-log .chat-row')).map((r) => {
                   const cs = getComputedStyle(r);
                   const rc = r.getBoundingClientRect();
                   return { cls: r.className, w: Math.round(rc.width), h: Math.round(rc.height), x: Math.round(rc.left), bg: cs.backgroundColor, radius: cs.borderRadius };
                 });
                 return { count, iconInfo, frameInfo, rows: rows.slice(-6), voiceLab: d && typeof d.voiceLab === 'function' ? d.voiceLab() : null };
               })()`);
                      console.log('[main][debug] 对话 UI 演示：' + JSON.stringify(dump));
                      // 再截两张**原分辨率小图**（整窗截图会被缩放，18~20px 的图标和 30px 的淡出都会糊掉）：
                      //   zoom-mic.png  麦克风按钮局部放大（看声纹图标）
                      //   zoom-edge.png 气泡框左边缘竖条（看两侧是否真的淡出）
                      const shotDir = process.env.PET_SHOT_DIR;
                      if (shotDir && dump && dump.iconInfo && dump.rows && dump.rows.length) {
                          try {
                              fs.mkdirSync(shotDir, { recursive: true });
                              const micRect = await win.webContents.executeJavaScript(`(() => { const m = document.getElementById('chat-mic'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.left) - 6), y: Math.max(0, Math.round(r.top) - 6), width: Math.round(r.width) + 12, height: Math.round(r.height) + 12 }; })()`);
                              if (micRect) {
                                  const img = await win.webContents.capturePage(micRect);
                                  fs.writeFileSync(path.join(shotDir, 'zoom-mic.png'), img.toPNG());
                              }
                              const size = win.getContentSize();
                              const edge = await win.webContents.capturePage({ x: 0, y: 0, width: 56, height: Math.max(80, size[1]) });
                              fs.writeFileSync(path.join(shotDir, 'zoom-edge.png'), edge.toPNG());
                              console.log('[main][debug] 已保存原分辨率局部图：zoom-mic.png / zoom-edge.png');
                          }
                          catch (err) {
                              console.warn('[main][debug] 局部截图失败：', err.message);
                          }
                      }
                  }
                  catch (err) {
                      console.warn('[main][debug] 对话 UI 演示失败：', err.message);
                  }
              })();
          }, 7000);
      }
      // 调试用：声纹波形实测——用合成电平驱动（不需要真麦克风），打印状态/路径/几何，
      // 并顺带把对话气泡行的计算样式与输入行控件高度打出来（截图配合 vl 目检）
      if (process.env.PET_VOICELAB_TEST === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getChatWindow() && !getChatWindow().isDestroyed() ? getChatWindow() : getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      const dump = await win.webContents.executeJavaScript(`(async () => {
                 const lab = window.PetVoiceLab;
                 if (!lab) return { error: 'no PetVoiceLab' };
                 const token = lab.begin({ label: '正在连接语音' });
                 const afterBegin = { ...lab.state(), mounted: lab.__mounted() };
                 // 合成一段"说话"电平：先小后大再回落（覆盖映射与镜像带）
                 const seq = [0.02, 0.05, 0.12, 0.3, 0.55, 0.7, 0.4, 0.2, 0.08, 0.02];
                 let now = performance.now();
                 for (const rms of seq) {
                   lab.level(token, rms, Math.min(1, rms * 1.6));
                   now += 60;
                   lab.__tick(now);
                 }
                 const el = document.getElementById('pet-voice-lab');
                 const rect = el ? el.getBoundingClientRect() : null;
                 const path = lab.__path();
                 const rowStyles = Array.from(document.querySelectorAll('#chat-log .chat-row')).slice(-4).map((r) => {
                   const cs = getComputedStyle(r);
                   return { cls: r.className, bg: cs.backgroundColor, radius: cs.borderRadius, margin: cs.margin, pad: cs.padding };
                 });
                 const inputRow = document.querySelector('.chat-input-row');
                 const ics = inputRow ? getComputedStyle(inputRow) : null;
                 const heights = (() => {
                   const pick = (sel) => { const e = document.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().height * 10) / 10 : null; };
                   return { input: pick('#chat-input'), mic: pick('#chat-mic'), send: pick('#chat-send'), voiceLab: pick('#pet-voice-lab') };
                 })();
                 return {
                   afterBegin,
                   state: lab.state(),
                   mounted: lab.__mounted(),
                   pathHead: path.slice(0, 70),
                   pathPoints: (path.match(/ L/g) || []).length + 1,
                   phase: el ? el.dataset.phase : null,
                   ariaValue: el ? el.getAttribute('aria-valuetext') : null,
                   hidden: el ? el.hidden : null,
                   rect: rect ? { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) } : null,
                   beforeInputRow: !!(el && inputRow && el.nextElementSibling === inputRow),
                   rowStyles,
                   inputRowStyle: ics ? { radius: ics.borderRadius, border: ics.borderTopColor, bg: ics.backgroundColor } : null,
                   heights,
                 };
               })()`);
                      console.log('[main][debug] 声纹实测：' + JSON.stringify(dump));
                  }
                  catch (err) {
                      console.warn('[main][debug] 声纹实测失败：', err.message);
                  }
              })();
          }, 7000);
      }
      // 调试用：模型预设（pet-model.json）——读当前模型预设 + 为探针名字生成模板再删掉，
      // 同时把设置页那行预设摘要的文字打出来（配合 PET_OPEN_SETTINGS=1 一起跑）
      if (process.env.PET_PRESET_TEST === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  const probe = '__preset_probe__';
                  const out = {};
                  try {
                      const resolver = PathResolver.PathResolver.resolve();
                      const current = resolver.modelList()[0] ?? '';
                      out.currentModel = current;
                      const read = resolver.modelPreset(current);
                      out.currentPreset = read.preset;
                      out.currentIssues = read.issues;
                      const modelDir = resolver.modelDirAbs(current);
                      out.expressions = modelDir ? (0, userAssets.readModelExpressionNames)(modelDir) : [];
                      const written = (0, userAssets.writeModelPresetTemplate)(probe, out.expressions);
                      out.templateWritten = written.ok;
                      out.templatePath = written.path;
                      out.templateParses = (() => {
                          try {
                              const raw = fs.readFileSync(written.path, 'utf8');
                              const json = JSON.parse(raw);
                              return { framing: json.framing, exprHints: Array.isArray(json._可用表情) ? json._可用表情.length : 0 };
                          }
                          catch (err) {
                              return { error: err.message };
                          }
                      })();
                      const again = (0, userAssets.writeModelPresetTemplate)(probe, []);
                      out.templateNotOverwritten = again.created === false;
                      try {
                          fs.rmSync(written.path, { force: true });
                      }
                      catch { /* 清理失败不影响结论 */ }
                      out.templateCleanedUp = !fs.existsSync(written.path);
                  }
                  catch (err) {
                      out.error = err.message;
                  }
                  if (win && !win.isDestroyed()) {
                      try {
                          out.settingsRowText = await win.webContents.executeJavaScript(`(() => {
                   const info = document.getElementById('asset-preset-info');
                   const btn = document.getElementById('asset-preset-edit');
                   const hint = document.getElementById('asset-preset-hint');
                   const row = info ? info.closest('.asset-preset-row') : null;
                   const panel = document.getElementById('settings-panel');
                   const rect = row ? row.getBoundingClientRect() : null;
                   const panelRect = panel ? panel.getBoundingClientRect() : null;
                   const infoRect = info ? info.getBoundingClientRect() : null;
                   // 滚到这一行，方便截图目检（设置面板很长，资产块默认在折叠区之外）
                   if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
                   const scrollTop = panel ? panel.scrollTop : null;
                   const afterScroll = info ? info.getBoundingClientRect() : null;
                   return {
                     text: info ? info.textContent : null,
                     infoHidden: info ? info.hidden : null,
                     hintHidden: hint ? hint.hidden : null,
                     hasButton: !!btn,
                     buttonText: btn ? btn.textContent : null,
                     hintText: hint ? hint.textContent : null,
                     hintHeight: hint ? Math.round(hint.getBoundingClientRect().height) : null,
                     rowRect: rect ? { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) } : null,
                     infoRect: infoRect ? { top: Math.round(infoRect.top), width: Math.round(infoRect.width), height: Math.round(infoRect.height) } : null,
                     panelRect: panelRect ? { top: Math.round(panelRect.top), height: Math.round(panelRect.height) } : null,
                     panelScrollTop: scrollTop,
                     topAfterScroll: afterScroll ? Math.round(afterScroll.top) : null,
                     infoClipped: info ? info.scrollWidth > info.clientWidth + 1 : null,
                   };
                 })()`);
                      }
                      catch (err) {
                          out.settingsRowError = err.message;
                      }
                  }
                  console.log('[main][debug] 模型预设实测：' + JSON.stringify(out));
              })();
          }, 6000);
      }
      // 调试用：启动后自动打开设置页并展开「AI 模型」列表（截图/排查用）
      if (process.env.PET_OPEN_SETTINGS === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      await win.webContents.executeJavaScript(`document.querySelector('#context-menu [data-menu-action="settings"]')?.click(); 'ok'`);
                      await new Promise((r) => setTimeout(r, 900));
                      await win.webContents.executeJavaScript(`document.getElementById('setting-ai-model-refresh')?.click(); 'ok'`);
                      console.log('[main][debug] PET_OPEN_SETTINGS=1 → 已打开设置并展开模型列表');
                      await new Promise((r) => setTimeout(r, 1200));
                      // 顺便点开「转写模型 · 按地址索引」的下拉，验证它真能列出候选
                      try {
                          await win.webContents.executeJavaScript(`document.getElementById('setting-voice-model-pick')?.click(); 'ok'`);
                          await new Promise((r) => setTimeout(r, 1500));
                      }
                      catch (err) {
                          console.warn('[main][debug] 打开转写模型下拉失败：', err.message);
                      }
                      const dump = await win.webContents.executeJavaScript(`(() => {
                 const panel = document.getElementById('setting-ai-model-panel');
                 const list = document.getElementById('setting-ai-model-list');
                 const items = list ? Array.from(list.querySelectorAll('.model-item')) : [];
                 const filter = document.getElementById('setting-ai-model-filter');
                 const rect = panel ? panel.getBoundingClientRect() : null;
                 return {
                   panelHidden: panel ? panel.hidden : null,
                   itemCount: items.length,
                   first: items.slice(0, 6).map((b) => b.textContent),
                   hasFilter: !!filter,
                   currentValue: (document.getElementById('setting-ai-model') || {}).value || '',
                   currentHighlighted: items.filter((b) => b.classList.contains('is-current')).map((b) => b.textContent),
                   rect: rect ? { top: Math.round(rect.top), height: Math.round(rect.height), width: Math.round(rect.width) } : null,
                   settingsScrollable: (() => { const s = document.getElementById('settings-panel'); return s ? s.scrollHeight > s.clientHeight : null; })(),
                   assetModels: Array.from(document.querySelectorAll('#asset-model-list .asset-item .asset-name')).map((n) => n.textContent),
                   assetModelPath: (document.getElementById('asset-model-dir') || {}).textContent || '',
                   assetPlugins: Array.from(document.querySelectorAll('#asset-plugin-list .asset-item .asset-name')).map((n) => n.textContent),
                   assetIssues: Array.from(document.querySelectorAll('#asset-model-list .asset-issues')).map((n) => n.textContent.slice(0, 60)),
                   // 转写模型的「按地址索引」结果：输入框值 / 提示行文字与颜色档 / 下拉是否展开
                   voiceModelValue: (document.getElementById('setting-voice-model') || {}).value || '',
                   voiceHint: (document.getElementById('setting-voice-model-hint') || {}).textContent || '',
                   voiceHintLevel: (() => {
                       const el = document.getElementById('setting-voice-model-hint');
                       if (!el)
                           return null;
                       if (el.classList.contains('is-ok'))
                           return 'ok';
                       if (el.classList.contains('is-warn'))
                           return 'warn';
                       if (el.classList.contains('is-bad'))
                           return 'error';
                       return 'none';
                   })(),
                   voicePickPanel: (() => {
                       const el = document.getElementById('setting-voice-model-panel');
                       return el ? !el.hidden : null;
                   })(),
                   voicePickItems: (() => {
                       const items = Array.from(document.querySelectorAll('#setting-voice-model-list .model-item'));
                       return { count: items.length, first: items.slice(0, 3).map((n) => n.textContent) };
                   })(),
                 };
               })()`);
                      console.log('[main][debug] 模型列表 DOM：' + JSON.stringify(dump));
                  }
                  catch (err) {
                      console.warn('[main][debug] 打开设置失败：', err.message);
                  }
              })();
          }, 4500);
      }
      // 调试用：设置面板几何审计（PET_SETTINGS_AUDIT=1）
      // 用户报过"设置框展开后看不全"——这里把量出来的几何打出来：面板可视高/内容高、折叠态下
      // 尾部元素超出可视区多少像素、滚到底后保存按钮是否真的进得来、内嵌模型列表自己的滚动高度。
      if (process.env.PET_SETTINGS_AUDIT === '1') {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      await win.webContents.executeJavaScript(`document.querySelector('#context-menu [data-menu-action="settings"]')?.click(); 'ok'`);
                      await new Promise((r) => setTimeout(r, 900));
                      const measure = async () => win.webContents.executeJavaScript(`(() => {
                          const panel = document.getElementById('settings-panel');
                          const form = document.getElementById('settings-form');
                          const save = document.getElementById('settings-save');
                          const list = document.getElementById('setting-ai-model-list');
                          const pr = panel.getBoundingClientRect();
                          const fr = form.getBoundingClientRect();
                          panel.scrollTop = 0;
                          form.scrollTop = 0;
                          const tail = {};
                          ['setting-ai-model-panel', 'setting-ai-model-status', 'setting-dev-root', 'asset-model-list', 'asset-plugin-list', 'settings-save'].forEach((id) => {
                              const el = document.getElementById(id);
                              if (el)
                                  tail[id] = Math.round(el.getBoundingClientRect().bottom - fr.bottom);
                          });
                          // 横向溢出审计：谁越过了表单右边界（>1px 视为越界），按宽度倒序给出名字+文案
                          const wide = [];
                          for (const el of form.querySelectorAll('*')) {
                              if (el.tagName === 'OPTION')
                                  continue; // 原生下拉的 option 不参与布局，别当成越界
                              const r = el.getBoundingClientRect();
                              if (r.width === 0 && r.height === 0)
                                  continue; // display:none 的元素 rect 全 0，不是真越界
                              if (r.right > fr.right + 1 || r.left < fr.left - 1) {
                                  wide.push({ id: el.id || el.className || el.tagName, w: Math.round(r.width), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 18) });
                              }
                          }
                          wide.sort((a, b) => b.w - a.w);
                          const wideInfo = { gridCols: getComputedStyle(form).gridTemplateColumns, offenders: wide.slice(0, 8) };
                          // 顶部（未滚动）时保存按钮是否已经在可视区里——sticky 钉底的核心收益
                          const sr = save.getBoundingClientRect();
                          const saveVisibleAtTop = sr.bottom <= fr.bottom + 1 && sr.top >= fr.top - 1;
                          form.scrollTop = form.scrollHeight;
                          const sr2 = save.getBoundingClientRect();
                          const saveVisibleAtBottom = sr2.bottom <= fr.bottom + 1 && sr2.top >= fr.top - 1;
                          const out = {
                              panel: { top: Math.round(pr.top), bottom: Math.round(pr.bottom), clientH: panel.clientHeight, scrollH: panel.scrollHeight },
                              form: { top: Math.round(fr.top), bottom: Math.round(fr.bottom), clientH: form.clientHeight, scrollH: form.scrollHeight, clientW: form.clientWidth, scrollW: form.scrollWidth },
                              overflowWhenTop: tail,
                              horizontalOverflow: wideInfo,
                              saveVisibleAtTop,
                              saveVisibleAtBottom,
                              list: list ? { clientH: list.clientHeight, scrollH: list.scrollHeight } : null,
                          };
                          form.scrollTop = 0;
                          return out;
                      })()`);
                      const before = await measure();
                      await win.webContents.executeJavaScript(`document.getElementById('setting-ai-model-refresh')?.click(); 'ok'`);
                      await new Promise((r) => setTimeout(r, 1600));
                      const after = await measure();
                      console.log('[main][debug] 设置面板几何（未展开）：' + JSON.stringify(before));
                      console.log('[main][debug] 设置面板几何（展开模型列表）：' + JSON.stringify(after));
                      // 截图前把展开的模型列表滚进可视区：这一张就是"展开后看得全 + 保存按钮还在"的证据
                      await win.webContents.executeJavaScript(`document.getElementById('setting-ai-model-panel')?.scrollIntoView({ block: 'center' }); 'ok'`);
                  }
                  catch (err) {
                      console.warn('[main][debug] 设置面板几何审计失败：', err.message);
                  }
              })();
          }, 4500);
      }
      // 调试用：PET_MODEL=<模型名> 用真实 UI 路径切到指定模型（打开设置 → 改下拉框 → 触发 change），
      // 用来验证"新导入的模型真的能渲染出来"，而不是只验证它在列表里。
      if (process.env.PET_MODEL) {
          setTimeout(() => {
              void (async () => {
                  const win = getMainWindow();
                  if (!win || win.isDestroyed())
                      return;
                  try {
                      await win.webContents.executeJavaScript(`document.querySelector('#context-menu [data-menu-action="settings"]')?.click(); 'ok'`);
                      await new Promise((r) => setTimeout(r, 900));
                      const want = process.env.PET_MODEL;
                      const res = await win.webContents.executeJavaScript(`(() => {
                          const sel = document.getElementById('setting-model');
                          if (!sel)
                              return 'no-select';
                          const opt = Array.from(sel.options).find((o) => o.value === ${JSON.stringify(process.env.PET_MODEL)});
                          if (!opt)
                              return 'missing:' + Array.from(sel.options).map((o) => o.value).join('|');
                          sel.value = opt.value;
                          sel.dispatchEvent(new Event('change', { bubbles: true }));
                          return 'switched:' + opt.value;
                      })()`);
                      console.log('[main][debug] PET_MODEL=' + want + ' → ' + res);
                      const wait = Math.max(1200, Number(process.env.PET_MODEL_WAIT || 6000) || 6000);
                      await new Promise((r) => setTimeout(r, wait));
                      const state = await win.webContents.executeJavaScript(`(() => {
                          const stage = document.getElementById('stage');
                          const img = stage ? stage.querySelector('img.pet-portrait') : null;
                          const canvas = stage ? stage.querySelector('canvas') : null;
                          const badge = document.getElementById('model-badge') || document.querySelector('.pet-placeholder, .model-placeholder');
                          const compat = (window.__petDebug && typeof window.__petDebug.modelCompat === 'function') ? window.__petDebug.modelCompat() : null;
                          // 运行库实况：Core 是否就绪 / 最高能读哪一版 moc3 / Pixi 版本（换运行库时靠它出证据）
                          const core = window.Live2DCubismCore;
                          let coreLatest = null;
                          try {
                              coreLatest = (core && core.Version && core.Version.csmGetLatestMocVersion)
                                  ? core.Version.csmGetLatestMocVersion()
                                  : 'no-api';
                          }
                          catch (e) {
                              coreLatest = 'ERR:' + String((e && e.message) || e).slice(0, 80);
                          }
                          return {
                              portrait: img ? { src: decodeURIComponent(img.getAttribute('src') || ''), w: img.naturalWidth, h: img.naturalHeight, complete: img.complete } : null,
                              canvas: canvas ? { w: canvas.width, h: canvas.height } : null,
                              placeholder: badge ? (badge.textContent || '').slice(0, 160) : null,
                              compat,
                              runtime: {
                                  core: typeof core,
                                  coreLatestMocVersion: coreLatest,
                                  pixiLive2d: !!(window.PIXI && window.PIXI.live2d && window.PIXI.live2d.Live2DModel),
                                  pixiVersion: (window.PIXI && (window.PIXI.VERSION || (window.PIXI.utils && window.PIXI.utils.VERSION))) || null,
                                  available: (window.PetLive2d && typeof window.PetLive2d.isLive2DAvailable === 'function') ? window.PetLive2d.isLive2DAvailable() : null,
                                  bounds: (window.__petDebug && typeof window.__petDebug.bounds === 'function') ? window.__petDebug.bounds() : null,
                                  moc3Debug: (window.__petDebug && typeof window.__petDebug.moc3Debug === 'function') ? window.__petDebug.moc3Debug() : null,
                              },
                          };
                      })()`);
                      console.log('[main][debug] 模型渲染状态：' + JSON.stringify(state));
                      // 截图为证：把设置面板收起来，让桌宠窗口里的模型露出来
                      await win.webContents.executeJavaScript(`document.getElementById('settings-close')?.click(); 'ok'`);
                  }
                  catch (err) {
                      console.warn('[main][debug] PET_MODEL 切换失败：', err.message);
                  }
              })();
          }, 4500);
      }
      // 调试用：自动点击确认框里的第一个选项（"允许"）。走的是真实 UI 路径，
      // 用来无人值守验证"确认 → 写文件/跑命令 → 交付产物"整条链路。
      if (process.env.PET_AUTO_CLICK_ASK === '1') {
          setInterval(() => {
              for (const win of [getChatWindow(), getMainWindow()]) {
                  if (!win || win.isDestroyed() || !win.isVisible())
                      continue;
                  void win.webContents
                      .executeJavaScript(`(() => {
                 const box = document.getElementById('ask-box');
                 if (!box || box.hidden) return 'none';
                 const btn = box.querySelector('#ask-options button');
                 if (!btn) return 'none';
                 const label = (btn.textContent || '').slice(0, 24);
                 btn.click();
                 return label;
               })()`)
                      .then((label) => {
                      if (label && label !== 'none')
                          console.log(`[main][debug] 自动确认：${label}`);
                  })
                      .catch(() => undefined);
              }
          }, 1500);
      }
      const shotDir = process.env.PET_SHOT_DIR;
      const sendText = process.env.PET_CHAT_SEND;
      if (sendText) {
          // 端到端验证对话链路：直接驱动聊天窗口的输入框 + 发送按钮（等价于点一次「发送」）
          setTimeout(() => {
              void debugSendChat(sendText);
          }, 5000);
      }
      if (shotDir) {
          // PET_SHOT_DELAY 支持逗号分隔的多个时刻（如 "6000,9000,14000"）：多截几轮，
          // 便于抓到"思考浮窗正开着"和"答完自动收起后"两种状态
          const times = (process.env.PET_SHOT_DELAY || '9000')
              .split(',')
              .map((s) => Math.max(1000, Number(s.trim()) || 0))
              .filter((n) => n > 0);
          console.log(`[main][debug] 将在 ${times.join('ms, ')}ms 截图到 ${shotDir}`);
          times.forEach((ms, idx) => {
              const round = times.length > 1 ? idx + 1 : 0;
              setTimeout(() => {
                  void captureDebugScreenshots(shotDir, round).then(() => {
                      if (process.env.PET_SHOT_EXIT === '1' && idx === times.length - 1)
                          app.quit();
                  });
              }, ms);
          });
      }
}

module.exports = { debugEnabled, installDevDebug };
