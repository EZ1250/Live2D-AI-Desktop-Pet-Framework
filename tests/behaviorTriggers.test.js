/**
 * behaviorTriggers.test.js — 设置里「行为触发」到底有没有真的播出去。
 *
 * 背景（用户实测）：设置 → 行为触发里给每个行为绑了表情（猫咪滤镜/眼镜/拿笔/围裙/呆猫），
 * 但实际使用中一个都不触发。根因：**这份映射只在打开设置面板时才被载入**，不打开设置
 * （或重启后）`motionTriggers` 一直是空对象 → 每个行为退回 'auto' 猜一个目标，多数是
 * `motion:Idle`（几乎看不出变化），用户配的表情永远不播。
 *
 * 这个测试在 Node 里用假 DOM + **假的 Live2D handle** 启动**桌宠主窗口**（非气泡窗），
 * 让真实的 `init()` 跑一遍，然后：
 *   ① 断言映射随启动就载入了（修复点：以前这里是空的）；
 *   ② 断言 6 个行为在当前模型上都能解析出目标（用户截图里那组配置）；
 *   ③ 通过真实的推送通道（onAction / onThink / onChat / onBubble）触发行为，
 *      断言真的调到了 `setExpression(对应表情)`。
 *
 * 前置：`npm test` 会先 build:tsc + assemble，这里加载 dist 的编译产物（不是 public 的拷贝，
 * 避免"测试跑旧产物"）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const RENDERER = path.join(APP, 'dist', 'renderer', 'renderer.js');
const VOICELAB = path.join(APP, 'dist', 'renderer', 'voicelab.js');
const GAZE = path.join(APP, 'dist', 'renderer', 'gazeController.js');
const EMOTION = path.join(APP, 'dist', 'renderer', 'emotion.js');
const KERNEL = path.join(APP, 'dist', 'renderer', 'kernel.js');
const EMOTION_PLUGIN = path.join(APP, 'dist', 'renderer', 'plugins', 'emotion.js');
const BEHAVIOR_PLUGIN = path.join(APP, 'dist', 'renderer', 'plugins', 'behavior.js');
const FX = path.join(APP, 'dist', 'renderer', 'fx.js');
const TODO_PANEL = path.join(APP, 'dist', 'renderer', 'panels', 'todo.js');
const ASK_BOX = path.join(APP, 'dist', 'renderer', 'panels', 'askBox.js');

/* ---------------- 假 DOM（够 init()/设置页/气泡跑） ---------------- */
class FakeEl {
  constructor(tag = 'div', id = '') {
    this.tagName = String(tag).toUpperCase();
    this._id = id;
    this.children = [];
    this.parentElement = null;
    this.hidden = false;
    this.textContent = '';
    this.value = '';
    this.className = '';
    this.title = '';
    this.disabled = false;
    this.scrollTop = 0;
    this.scrollHeight = 100;
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this._attrs = {};
    const self = this;
    this.classList = {
      _set: new Set(),
      add(...cs) { cs.forEach((c) => this._set.add(c)); },
      remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      toggle(c, force) { const on = force === undefined ? !this._set.has(c) : !!force; if (on) this._set.add(c); else this._set.delete(c); return on; },
      contains(c) { return this._set.has(c); },
      get value() { return [...self.classList._set].join(' '); },
    };
  }
  get id() { return this._id; }
  set id(v) { this._id = String(v); }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'id') this._id = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; }
  removeAttribute(k) { delete this._attrs[k]; }
  appendChild(c) { if (c) { c.parentElement = this; this.children.push(c); } return c; }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); if (c) { c.parentElement = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); } return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  replaceChildren(...cs) { this.children = cs; return undefined; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  /** 真实 DOM 里 select.options 会展开 optgroup 里的 option；设置页刷新下拉时要用 */
  get options() {
    const out = [];
    for (const c of this.children) {
      if (c.tagName === 'OPTGROUP') out.push(...c.children.filter((o) => o.tagName === 'OPTION'));
      else if (c.tagName === 'OPTION') out.push(c);
    }
    return out;
  }
  get nextElementSibling() { const p = this.parentElement; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return true; }
  closest() { return this; }
  contains(n) { return n === this || this.children.includes(n); }
  querySelector(sel) { return this._dom ? this._dom.getEl(String(sel).replace(/^[#.]/, '')) : new FakeEl('div'); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 28, height: 28, toJSON: () => ({}) }; }
  addEventListener(type, fn) { if (this._events) { if (!this._events.has(type)) this._events.set(type, []); this._events.get(type).push(fn); } }
  removeEventListener() {}
  dispatch(type, event = {}) { for (const fn of this._events?.get(type) ?? []) fn({ preventDefault() {}, stopPropagation() {}, relatedTarget: null, target: this, ...event }); }
  /** 兼容真实 DOM 写法：dispatchEvent('change') 或 dispatchEvent(new Event('change')) */
  dispatchEvent(type, event = {}) {
    this.dispatch(typeof type === 'string' ? type : (type && type.type) || 'event', event);
    return true;
  }
  focus() {} blur() {} click() {} setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
  insertAdjacentHTML() {}
  append(...nodes) { nodes.forEach((n) => this.appendChild(n)); }
}

/** 用户的真实配置（截图里那组）+ 真实模型能力 */
const USER_TRIGGERS = {
  user_message: 'expr:猫咪滤镜',
  tool_call: 'expr:眼镜',
  command_exec: 'expr:眼镜',
  ai_start: 'expr:拿笔',
  model_idle: 'expr:围裙',
  error: 'expr:呆猫',
};
const MODEL_EXPRESSIONS = ['呆猫', '呆猫眼珠摇晃', '围裙', '拍照', '拿笔', '点一下', '猫咪滤镜', '眼镜'];
const MODEL_MOTIONS = ['Idle'];
const MODEL_MANIFEST = {
  name: '模型A',
  url: 'http://127.0.0.1:1/user-models/模型A/model_a.model3.json',
  type: 'moc3',
  model3Path: 'model_a.model3.json',
  mocVersion: 5,
  compat: { type: 'moc3', mocVersion: 5, verdict: 'ok', issues: [], coreMax: 5, reason: null, action: null },
  preset: {
    capabilities: {
      click: ['点一下'],
      costume: ['围裙', '拍照', '拿笔', '猫咪滤镜', '眼镜'],
      emotion: { surprised: '呆猫' },
      idle: ['Idle'],
    },
    emotionMap: { surprised: '呆猫' },
  },
};
/** 第二个模型：没有表情、只有 Idle 动作组（真实模型就是这样） */
const MODEL_B_MANIFEST = {
  name: '模型B',
  url: 'http://127.0.0.1:1/user-models/模型B/model_b.model3.json',
  type: 'moc3',
  model3Path: 'model_b.model3.json',
  mocVersion: 5,
  compat: { type: 'moc3', mocVersion: 5, verdict: 'ok', issues: [], coreMax: 5, reason: null, action: null },
  preset: { capabilities: { idle: ['Idle'] }, emotionMap: {} },
};

function bootPetWindow(triggers = USER_TRIGGERS) {
  const byId = new Map();
  const handlers = {}; // bridge.on* 的回调，测试里直接"推"事件
  const calls = { setExpression: [], playMotion: [], framed: [], gaze: [], petEvent: [] };
  const docListeners = new Map();

  const dom = {
    getEl(id) {
      if (!byId.has(id)) { const el = new FakeEl('div', id); el._dom = dom; el._events = new Map(); byId.set(id, el); }
      return byId.get(id);
    },
  };
  const document = {
    readyState: 'complete',
    title: '',
    body: (() => { const b = new FakeEl('body', 'body'); b._dom = dom; b._events = new Map(); return b; })(),
    documentElement: (() => { const b = new FakeEl('html', 'html'); b._dom = dom; b._events = new Map(); return b; })(),
    getElementById: (id) => dom.getEl(id),
    querySelector: (sel) => dom.getEl(String(sel)),
    querySelectorAll: () => [],
    createElement: (tag) => { const el = new FakeEl(tag); el._dom = dom; el._events = new Map(); return el; },
    createElementNS: (_ns, tag) => { const el = new FakeEl(tag); el._dom = dom; el._events = new Map(); return el; },
    addEventListener(type, fn) { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
    removeEventListener() {},
    dispatchEvent() { return true; },
  };

  const winListeners = new Map();
  const window = {
    location: { search: '', href: 'http://127.0.0.1:1/' }, // 空 search = 桌宠主窗口
    innerWidth: 360,
    innerHeight: 520,
    screenX: 0,
    screenY: 0,
    devicePixelRatio: 1,
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    requestAnimationFrame: () => 0, // 不真跑帧循环，测试只要状态
    cancelAnimationFrame: () => {},
    addEventListener(type, fn) { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
    removeEventListener() {},
  };
  /** 派发 window / document 上的事件（真实处理链：pointerdown 在 document、pointerup 在 window） */
  const dispatchWin = (type, event = {}) => {
    for (const fn of winListeners.get(type) ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: null, button: 0, ...event });
  };
  const dispatchDoc = (type, event = {}) => {
    for (const fn of docListeners.get(type) ?? []) fn({ preventDefault() {}, stopPropagation() {}, target: null, button: 0, ...event });
  };

  /** 假的 Live2D handle：只记录"到底播了什么"。表情清单按当前模型变化（模型B 没有表情） */
  let activeModel = '模型A';
  const handle = {
    kind: 'moc3',
    update() {},
    destroy() {},
    bounds: () => ({ top: 10, height: 480 }),
    listExpressions: () => (activeModel === '模型B' ? [] : MODEL_EXPRESSIONS.slice()),
    listMotions: () => MODEL_MOTIONS.slice(),
    setExpression(name) { calls.setExpression.push(name); },
    playMotion(group) { calls.playMotion.push(group); },
    refreshHitMask: () => true,
    hitTest: () => ({ ok: true, hit: false }),
    applyEmotionLabel: () => '呆猫',
    setFraming() {},
    setGaze(nx, ny) { calls.gaze.push([nx, ny]); },
  };
  window.PetLive2d = {
    isLive2DAvailable: () => true,
    mountLive2D: async () => handle,
    mountPortrait: () => handle,
    mountPlaceholder: () => handle,
  };

  const bridge = {
    loadModel: async (name) => {
      activeModel = String(name || '模型A');
      return activeModel === '模型B' ? MODEL_B_MANIFEST : MODEL_MANIFEST;
    },
    modelList: async () => ['模型A'],
    getSettings: async () => ({
      displayMode: 'half',
      sfxEnabled: false,
      sfxVolume: 0,
      showThinking: true,
      // 按模型分桶保存：当前模型（模型A）用自己的那桶；另一模型（模型B）配的是动作组。
      // 旧版全局字段故意留空 → 能证明运行时用的是"按模型"那一份，而不是全局回退。
      motionTriggers: {},
      motionTriggersByModel: {
        模型A: { ...triggers },
        模型B: { user_message: 'motion:Idle' },
      },
      modelName: '模型A',
    }),
    setSettings: async () => ({ ok: true }),
    chatLogGet: async () => ({ sessions: [] }),
    chatLogAppend: async () => ({ ok: true }),
    chatWindowSetCollapsed: async () => ({ ok: true }),
    chatWindowVoiceStrip: async () => ({ ok: true }),
    reportPetBounds: () => {},
    reportHitResult: () => {},
    voiceStatus: async () => ({ configured: true, model: 'qwen3-asr-flash' }),
    voiceTranscribe: async () => ({ ok: true, text: '', ms: 0 }),
    todoList: async () => [],
    pathForFile: () => '',
    petEvent(type) { calls.petEvent.push(type); },
    moveWindow() {},
    endWindowDrag() {},
  };
  for (const ev of ['onChat', 'onAction', 'onThink', 'onBubble', 'onGlobalCursor', 'onHitProbe', 'onAskQuestion', 'onAskCancel', 'onTodoShow', 'onWindowChange', 'onContextMenu', 'onPlan', 'onChatWindowState', 'onThinkWindowState']) {
    // 同一个通道可能有**多个**订阅者（行为触发 / 思考浮窗各订一次），这里全部保留并按序回调
    handlers[ev] = [];
    bridge[ev] = (cb) => { handlers[ev].push(cb); return () => {}; };
  }
  window.electron = bridge;
  const emit = (ev, payload) => { for (const cb of handlers[ev] ?? []) cb(payload); };

  const globals = {
    document, window, URLSearchParams,
    location: window.location,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
    MediaRecorder: class { static isTypeSupported() { return true; } start() {} stop() {} },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    SVGElement: class {}, HTMLElement: class {}, Element: class {}, Node: class {},
    AudioContext: undefined,
  };
  for (const [k, v] of Object.entries(globals)) {
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } },
  });

  const errors = [];
  process.on('unhandledRejection', (e) => errors.push(e));

  delete require.cache[require.resolve(EMOTION)];
  delete require.cache[require.resolve(VOICELAB)];
  delete require.cache[require.resolve(GAZE)];
  delete require.cache[require.resolve(KERNEL)];
  delete require.cache[require.resolve(EMOTION_PLUGIN)];
  delete require.cache[require.resolve(BEHAVIOR_PLUGIN)];
  delete require.cache[require.resolve(FX)];
  delete require.cache[require.resolve(TODO_PANEL)];
  delete require.cache[require.resolve(ASK_BOX)];
  delete require.cache[require.resolve(RENDERER)];
  require(EMOTION); // 情绪规则库：emotion 插件启动时读 window.PetEmotion
  window.PetEmotion = globalThis.PetEmotion;
  require(VOICELAB);
  window.PetVoiceLab = globalThis.PetVoiceLab;
  require(GAZE); // 视线模块：renderer 初始化时注入 getter（index.html 里同样先于 renderer.js）
  require(KERNEL); // 渲染层内核：index.html 里在 renderer.js 之前
  require(EMOTION_PLUGIN); // 内置策略插件：在 kernel 之后、renderer.js 之前注册
  require(BEHAVIOR_PLUGIN);
  require(FX); // 渲染层 UI 模块：install(deps) 注入依赖
  require(TODO_PANEL);
  require(ASK_BOX);
  require(RENDERER);

  return { dom, document, window, handlers, calls, errors, emit, dispatchWin, dispatchDoc };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
  return false;
}

test('切模型时「行为触发」下拉标签不能残留「当前模型没有」', async () => {
  const env = bootPetWindow();
  const mounted = await waitFor(() => env.window.__petDebug, 4000);
  assert.equal(mounted, true, `init 未跑完；unhandled=${env.errors.map((e) => (e && e.message) || String(e)).join(' | ')}`);
  const dbg = env.window.__petDebug;
  assert.equal(await waitFor(() => dbg.behaviors().resolved.user_message, 3000), true);

  /** 读 6 个下拉的"值 + 选中项文字" */
  const labels = () => {
    const out = {};
    for (const key of ['user_message', 'tool_call', 'command_exec', 'ai_start', 'model_idle', 'error']) {
      const sel = env.document.getElementById(`setting-motion-${key}`);
      const cur = [...sel.children].flatMap((c) => (c.tagName === 'OPTGROUP' ? c.children : [c])).find((o) => o.value === sel.value);
      out[key] = { value: sel.value, text: cur ? cur.textContent : null };
    }
    return out;
  };

  // 打开设置面板（此时模型=模型A，6 个绑定都指向模型A真实存在的表情）
  dbg.openSettings();
  assert.equal(await waitFor(() => env.document.getElementById('setting-motion-user_message')?.value, 1500), true);
  await sleep(200);
  const onModelA = labels();
  assert.equal(onModelA.user_message.value, 'expr:猫咪滤镜', '模型A下应回填它自己的绑定');
  for (const key of Object.keys(onModelA)) {
    assert.ok(
      !/当前模型没有/.test(String(onModelA[key].text)),
      `模型A下「${key}」不该被标成"当前模型没有"（实际：${onModelA[key].text}）—— 刷新时机必须等模型挂载完成`
    );
  }

  // 切到 模型B（没有表情）：应该用 模型B 自己的绑定（这里配的是 Idle 动作组），而不是把模型A的表情标成"没有"
  const sel = env.document.getElementById('setting-model');
  sel.value = '模型B';
  sel.dispatchEvent('change', { bubbles: true });
  assert.equal(await waitFor(() => labels().user_message.value === 'motion:Idle', 3000), true, '切模型后应换成该模型自己的绑定');
  const onModelB = labels();
  assert.equal(onModelB.user_message.value, 'motion:Idle');
  assert.equal(onModelB.user_message.text, 'Idle', '模型B 的 Idle 是合法目标，不该带"当前模型没有"');
  assert.equal(onModelB.error.value, 'auto', '模型B 没有配过「出错」→ 应显示自动，而不是继承模型A的呆猫');

  // 切回模型A：标签必须恢复成正常名字（不能残留"当前模型没有"）
  sel.value = '模型A';
  sel.dispatchEvent('change', { bubbles: true });
  assert.equal(await waitFor(() => labels().user_message.value === 'expr:猫咪滤镜', 3000), true, '切回模型A应恢复它的绑定');
  const back = labels();
  for (const key of Object.keys(back)) {
    assert.ok(
      !/当前模型没有/.test(String(back[key].text)),
      `切回模型A后「${key}」不该残留"当前模型没有"（实际：${back[key].text}）`
    );
  }
  assert.deepEqual(
    Object.fromEntries(Object.entries(back).map(([k, v]) => [k, v.value])),
    USER_TRIGGERS,
    '切回模型A后 6 个绑定应完整还原'
  );
});

test('行为触发：随启动载入、6 个绑定都能解析、并且真的播到模型上', async () => {
  const env = bootPetWindow();
  const mounted = await waitFor(() => env.window.__petDebug, 4000);
  assert.equal(
    mounted, true,
    `renderer 主窗口 init 未跑完；unhandled=${env.errors.map((e) => (e && e.message) || String(e)).join(' | ')}`
  );
  const dbg = env.window.__petDebug;
  assert.ok(typeof dbg.behaviors === 'function', '主窗口应挂上 __petDebug.behaviors()');

  // 等模型挂载完成（currentHandle 就绪后 resolved 才有值）
  const ready = await waitFor(() => dbg.behaviors().resolved.user_message);
  assert.equal(ready, true, `模型/行为未就绪；unhandled=${env.errors.map((e) => e && e.message).join(' | ')}`);

  const info = dbg.behaviors();
  // ① 映射随启动就载入（修复前这里是 {}，行为全部退回 auto → 配的表情永远不播）
  assert.deepEqual(info.triggers, USER_TRIGGERS, '行为触发映射必须在启动时就载入，而不是等打开设置面板');
  assert.deepEqual(info.motions, MODEL_MOTIONS);
  assert.deepEqual(info.expressions, MODEL_EXPRESSIONS);

  // ② 用户截图里那 6 个绑定，在当前模型上都必须能解析出真实目标
  assert.deepEqual(info.resolved.user_message, { kind: 'expression', name: '猫咪滤镜' });
  assert.deepEqual(info.resolved.tool_call, { kind: 'expression', name: '眼镜' });
  assert.deepEqual(info.resolved.command_exec, { kind: 'expression', name: '眼镜' });
  assert.deepEqual(info.resolved.ai_start, { kind: 'expression', name: '拿笔' });
  assert.deepEqual(info.resolved.model_idle, { kind: 'expression', name: '围裙' });
  assert.deepEqual(info.resolved.error, { kind: 'expression', name: '呆猫' });

  // ③ 走真实推送通道触发，断言真的调到了 setExpression
  const lastExpr = () => env.calls.setExpression[env.calls.setExpression.length - 1];
  const expectPlays = async (label, fire, want) => {
    const before = env.calls.setExpression.length;
    fire();
    await sleep(30);
    assert.ok(env.calls.setExpression.length > before, `${label}：没有调用 setExpression`);
    assert.equal(lastExpr(), want, `${label}：应播放「${want}」，实际「${lastExpr()}」`);
  };

  // 用户在气泡窗发消息 → 主进程转发 behavior → 桌宠窗口播放
  await expectPlays('用户发送消息', () => env.emit('onAction', { type: 'behavior', payload: { name: 'user_message' } }), '猫咪滤镜');
  // 开始回答（思考流 start 事件）
  await expectPlays('开始回答', () => env.emit('onThink', { kind: 'start', text: '开始思考…' }), '拿笔');
  // 调用工具 / 执行命令
  await expectPlays('调用工具', () => env.emit('onThink', { kind: 'tool', text: '调用 web_fetch', tool: 'web_fetch' }), '眼镜');
  await expectPlays('执行命令', () => env.emit('onThink', { kind: 'tool', text: '调用 shell_run', tool: 'shell_run' }), '眼镜');
  // 出错
  await expectPlays('出错', () => env.emit('onChat', { message: '模拟一次 AI 调用失败' }), '呆猫');
  // 待机搭话（主进程主动推气泡）
  await expectPlays('待机搭话', () => env.emit('onBubble', { text: '摸鱼时间到～' }), '围裙');

  // ④ 解析规则本身：三种前缀 / 能力别名 / 不存在的名字
  assert.deepEqual(dbg.resolveTrigger('expr:猫咪滤镜'), { kind: 'expression', name: '猫咪滤镜' });
  assert.deepEqual(dbg.resolveTrigger('motion:Idle'), { kind: 'motion', name: 'Idle' });
  assert.deepEqual(dbg.resolveTrigger('click'), { kind: 'expression', name: '点一下' }, 'click 别名应落到能力归类里的表情');
  assert.equal(dbg.resolveTrigger('expr:不存在的表情'), null, '模型没有的表情必须解析为 null');
  assert.equal(dbg.resolveTrigger('motion:NoSuchMotion'), null);
  assert.equal(dbg.resolveTrigger(''), null);
});

test('窗口外视线跟随：全局光标推送会更新视线目标（渲染层换算）', async () => {
  const env = bootPetWindow();
  assert.equal(await waitFor(() => env.window.__petDebug, 4000), true);
  const dbg = env.window.__petDebug;
  assert.equal(await waitFor(() => dbg.behaviors().resolved.user_message, 3000), true);

  // 窗口 360x520 在屏幕 (0,0)，中心 (180,260)；软区 w/2+220=400、h/2+220=480
  // 窗口外远处用 tanh 平滑饱和：不能硬 clamp（否则视线卡边缘）；远处渐近 ±1
  env.emit('onGlobalCursor', { x: 180 + 500, y: 198 }); // 半身：视线原点在脖颈(38%高度)，同一水平线应取脖颈高度
  await sleep(50);
  let g = dbg.gaze();
  assert.ok(g.renderer.ny !== undefined, '应提供 __petDebug.gaze() 自查入口');
  assert.ok(g.renderer.nx > 0.8 && g.renderer.nx < 1, `鼠标在窗口右侧远处 → nx 应平滑饱和（实际 ${g.renderer.nx}）`);
  assert.ok(Math.abs(g.renderer.ny) < 0.05, `脖颈水平线 → ny 应≈0（实际 ${g.renderer.ny}）`);
  assert.equal(g.renderer.stale, false, '刚收到推送不应判过期');

  env.emit('onGlobalCursor', { x: 180 - 500, y: 198 - 480 });
  await sleep(50);
  g = dbg.gaze();
  assert.ok(g.renderer.nx < -0.8, `鼠标在窗口左侧远处 → nx 应平滑饱和为负（实际 ${g.renderer.nx}）`);
  assert.ok(g.renderer.ny > 0.6, `鼠标在窗口上方远处 → ny 应平滑饱和为正（向上为正，实际 ${g.renderer.ny}）`);

  // 极远处应接近但仍不超过 1，且不会因 clamp 卡死在某一侧
  env.emit('onGlobalCursor', { x: 180 + 5000, y: 198 });
  await sleep(50);
  g = dbg.gaze();
  assert.ok(g.renderer.nx > 0.99 && g.renderer.nx <= 1, `极远处 nx 应趋近 1（实际 ${g.renderer.nx}）`);
  assert.ok(g.renderer.globalCursorPushes >= 3, '应统计到全局光标推送次数（排查"窗口外不跟"用）');
});

test('交互语料事件：单击/连点/长拖三种事件都会上报给主进程', async () => {
  const env = bootPetWindow();
  assert.equal(await waitFor(() => env.window.__petDebug, 4000), true);
  const dbg = env.window.__petDebug;
  assert.equal(await waitFor(() => dbg.behaviors().resolved.user_message, 3000), true);

  const pointer = (screenX = 40, screenY = 40) => ({ button: 0, pointerId: 1, pointerType: 'mouse', screenX, screenY, clientX: 40, clientY: 40 });
  const click = async () => { env.dispatchDoc('pointerdown', pointer()); env.dispatchWin('pointerup', pointer()); };

  // 单击一次 → click
  await click();
  await sleep(30);
  assert.deepEqual(env.calls.petEvent, ['click'], '单击应上报一次 click');

  // 2.5s 窗口内点到第 6 次 → 追加 multiClick
  for (let i = 0; i < 5; i++) { await click(); await sleep(20); }
  await sleep(50);
  assert.equal(env.calls.petEvent.filter((t) => t === 'click').length, 6, '6 次单击都应上报 click');
  assert.equal(env.calls.petEvent.filter((t) => t === 'multiClick').length, 1, '第 6 次（超过 5 次）应上报 multiClick');

  // 长拖：按下 → 移动（超过 3px 拖拽阈值）→ 等 >5s → 再移动一次触发 dragLong
  const down = pointer(50, 50);
  env.dispatchDoc('pointerdown', down);
  env.dispatchDoc('pointermove', pointer(58, 54));
  await sleep(5100);
  env.dispatchDoc('pointermove', pointer(70, 60));
  env.dispatchWin('pointerup', pointer(70, 60));
  await sleep(50);
  assert.equal(env.calls.petEvent.filter((t) => t === 'dragLong').length, 1, '拖动超过 5 秒应上报一次 dragLong');
});
