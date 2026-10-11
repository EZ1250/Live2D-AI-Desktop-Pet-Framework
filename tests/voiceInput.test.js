/** 按住说话状态机的集成回归测试。 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const RENDERER = path.join(APP, 'dist', 'renderer', 'renderer.js');
const VOICELAB = path.join(APP, 'dist', 'renderer', 'voicelab.js');

/* ------------------------------------------------------------------ 假 DOM */

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
  insertBefore(c, ref) { const i = this.children.indexOf(ref); c.parentElement = this; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c; }
  replaceChildren(...cs) { this.children = cs; return undefined; }
  remove() { if (this.parentElement) this.parentElement.removeChild(this); }
  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] ?? null; }
  get lastChild() { return this.children[this.children.length - 1] ?? null; }
  get nextElementSibling() { const p = this.parentElement; if (!p) return null; return p.children[p.children.indexOf(this) + 1] ?? null; }
  get isConnected() { return true; }
  closest() { return this; }
  contains(n) { return n === this || this.children.includes(n); }
  // 返回一个新元素而不是 null：渲染层对"查不到就跳过"基本都有兜底，但有些分支会直接读属性
  querySelector(sel) { return this._dom ? this._dom.getEl(String(sel).replace(/^[#.]/, '')) : new FakeEl('div'); }
  querySelectorAll() { return []; }
  getBoundingClientRect() { return this._dom ? this._dom.rectOf(this) : zeroRect(); }
  addEventListener(type, fn) { const key = `${this._id}:${type}`; this._dom?.listeners.set(key, [...(this._dom?.listeners.get(key) ?? []), fn]); }
  removeEventListener() {}
  dispatch(type, event = {}) {
    // 页面上按钮的事件是按 id 注册的；这里用同一个注册表回放
    const list = this._dom?.listeners.get(`${this._id}:${type}`) ?? [];
    for (const fn of list) fn({ preventDefault() {}, stopPropagation() {}, relatedTarget: null, target: this, ...event });
  }
  focus() {} blur() {} click() {}
  setPointerCapture() {} releasePointerCapture() {} hasPointerCapture() { return false; }
  insertAdjacentHTML() {}
}

function zeroRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}) }; }

class FakeMediaRecorder {
  constructor(stream, opts) {
    this.stream = stream;
    this.mimeType = (opts && opts.mimeType) || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
  }
  static isTypeSupported() { return true; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: { size: 2048 } });
    if (this.onstop) this.onstop();
  }
}

/**
 * 建一套全新的"运行时"：假 window/document/navigator/MediaRecorder + 可观测的 IPC 桥，
 * 然后加载 voicelab 与 renderer（?panel=chat 分支）。
 */
function bootRenderer() {
  const byId = new Map();
  const listeners = new Map();   // "id:type" -> [fn]
  const docListeners = new Map();
  const winListeners = new Map();
  const rects = new Map();
  const trace = [];

  const dom = {
    getEl(id) { if (!byId.has(id)) { const el = new FakeEl('div', id); el._dom = dom; byId.set(id, el); } return byId.get(id); },
    rectOf(el) { return rects.get(el.id) ?? zeroRect(); },
    listeners,
    trace,
  };

  const document = {
    readyState: 'complete',
    title: '',
    body: new FakeEl('body', 'body'),
    documentElement: new FakeEl('html', 'html'),
    getElementById: (id) => dom.getEl(id),
    querySelector: (sel) => dom.getEl(String(sel)),
    querySelectorAll: () => [],
    createElement: (tag) => { const el = new FakeEl(tag); el._dom = dom; return el; },
    createElementNS: (_ns, tag) => { const el = new FakeEl(tag); el._dom = dom; return el; },
    addEventListener(type, fn) { docListeners.set(type, [...(docListeners.get(type) ?? []), fn]); },
    removeEventListener() {},
    dispatchEvent() { return true; },
  };
  document.body._dom = dom;

  const window = {
    location: { search: '?panel=chat', href: 'http://127.0.0.1:1/?panel=chat' },
    innerWidth: 360,
    innerHeight: 72,
    devicePixelRatio: 1,
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    addEventListener(type, fn) { winListeners.set(type, [...(winListeners.get(type) ?? []), fn]); },
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 16),
    cancelAnimationFrame: (id) => clearTimeout(id),
  };

  const bridge = {
    loadModel: async () => ({ name: '测试模型' }),
    modelList: async () => ['测试模型'],
    onChat: () => () => {},
    onThinkWindowState: () => () => {},
    onAskQuestion: () => () => {},
    onAskCancel: () => () => {},
    chatLogGet: async () => ({ sessions: [] }),
    chatLogAppend: async () => ({ ok: true }),
    chatWindowSetCollapsed: async () => ({ ok: true }),
    chatWindowVoiceStrip: async (visible) => { trace.push(`voiceStrip=${visible}`); return { ok: true }; },
    voiceStatus: async () => { trace.push('voiceStatus'); return { configured: true, model: 'test-asr' }; },
    voiceTranscribe: async () => { trace.push('voiceTranscribe'); return { ok: true, text: '你好呀', ms: 120 }; },
    getSettings: async () => ({}),
    reportPetBounds: () => {},
    onHitProbe: () => () => {},
    reportHitResult: () => {},
  };
  window.electron = bridge;

  // 麦克风可用性"闸门"：测试可以把 getUserMedia 挂住，模拟授权/设备慢
  let gate = null;
  const counters = { recorders: 0 };
  const getUserMedia = async () => {
    if (gate) await gate.promise;
    return { getTracks: () => [{ stop() {} }] };
  };
  /** 让下一次（及后续）getUserMedia 挂起，直到 release() */
  const gateUserMedia = () => {
    let release = () => {};
    gate = { promise: new Promise((r) => { release = r; }) };
    return { release: () => { const g = gate; gate = null; release(); return g; } };
  };
  class CountingRecorder extends FakeMediaRecorder {
    constructor(...args) { super(...args); counters.recorders += 1; }
  }

  const globals = {
    document, window,
    MediaRecorder: CountingRecorder,
    URLSearchParams,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    SVGElement: class {}, HTMLElement: class {}, Element: class {}, Node: class {},
    AudioContext: undefined, // 口型分析不可用 → 代码应静默跳过
  };
  const savedGlobals = new Map();
  for (const [k, v] of Object.entries(globals)) {
    savedGlobals.set(k, Object.getOwnPropertyDescriptor(globalThis, k));
    Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v });
  }
  // 注意：这些全局**故意不还原**。渲染层是单例状态机，测试结束后仍有排队中的定时器/
  // Promise 回调；把 globalThis.document 撤掉会让它们抛 "document is not defined"
  // （Node 会报成"测试结束后仍有异步活动"）。测试进程用完即退，留着最省事。
  void savedGlobals;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });

  delete require.cache[require.resolve(VOICELAB)];
  delete require.cache[require.resolve(RENDERER)];
  require(VOICELAB);
  window.PetVoiceLab = globalThis.PetVoiceLab; // voicelab 挂在 globalThis 上
  require(RENDERER);

  return {
    dom, document, window, trace, byId, counters, gateUserMedia,
    mic: dom.getEl('chat-mic'),
    strip: dom.getEl('pet-voice-lab'),
    stripText: dom.getEl('pet-voice-status'),
    input: dom.getEl('chat-input'),
    /** 设置麦克风按钮的矩形（模拟布局位置/位移） */
    placeMic(x, y) { rects.set('chat-mic', { x, y, left: x, top: y, right: x + 28, bottom: y + 28, width: 28, height: 28, toJSON: () => ({}) }); },
    fireDocument(type, event = {}) { for (const fn of docListeners.get(type) ?? []) fn(event); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
};

/* ------------------------------------------------------------------ 用例 */

test('按住说话：同步进入录音态、布局位移不误取消、真离远才取消、松手只填输入框、文案自动收起', async () => {
  // 一个实例跑完全部环节：渲染层是单例状态机，拆成多个 test 会互相干扰（上一个用例的
  // "转写完成"定时器会落到下一个用例的 DOM 上）。
  const env = bootRenderer();
  await waitFor(() => env.window.petVoice);
  const voice = env.window.petVoice;
  assert.ok(voice, 'renderer 应挂上 window.petVoice（说明 installVoiceInput 跑到了）');
  env.placeMic(300, 30);

  // ① 按下：必须**同步**进入 arming
  env.mic.dispatch('pointerdown', { clientX: 314, clientY: 44, pointerId: 1 });
  assert.equal(voice.state(), 'arming', '按下后必须同步进入 arming（否则松手事件会丢，麦克风会一直开着）');
  assert.equal(env.trace.includes('voiceStrip=true'), true, '状态条显示时应请求气泡窗长高一条');
  assert.equal(env.strip.hidden, false, '状态条应可见');
  await waitFor(() => voice.state() === 'listening');
  assert.equal(voice.state(), 'listening');

  // ② 布局位移：按钮被顶下去（老实现正是这样把按钮顶走的 → pointerleave → 录音被取消）
  //    这里干脆挪远一点（34px）：指针坐标相对**按下当时**的按钮矩形仍在范围内 → 不得取消
  env.placeMic(300, 58);
  env.mic.dispatch('pointerleave', { clientX: 314, clientY: 72, relatedTarget: env.dom.getEl('chatbar') });
  await sleep(20);
  assert.equal(voice.state(), 'listening', '指针没动、只是按钮被挪走 → 不得取消录音');
  // 极端情况：贴屏幕边缘被夹回来，按钮整块移位、而指针落在按钮"现在"的位置之外
  env.placeMic(300, 96);
  env.mic.dispatch('pointerleave', { clientX: 314, clientY: 44, relatedTarget: env.dom.getEl('chatbar') });
  await sleep(20);
  assert.equal(voice.state(), 'listening', '按钮整块挪走也不算用户走开');

  // ③ 真离远：仍要能取消（"拖走取消"的体验不能丢）
  env.mic.dispatch('pointerleave', { clientX: 314, clientY: 400, relatedTarget: env.dom.getEl('chatbar') });
  await sleep(20);
  assert.equal(voice.state(), 'cancelled', '指针真的移开 → 取消');

  // ④ 完整一段：按住 → 松开 → 转写 → 只填进输入框（不自动发送）
  env.placeMic(300, 30);
  env.mic.dispatch('pointerdown', { clientX: 314, clientY: 44, pointerId: 2 });
  await waitFor(() => voice.state() === 'listening');
  await sleep(400); // 超过"最小按住时长"
  env.fireDocument('pointerup');
  await waitFor(() => env.input.value.includes('你好呀'));
  assert.equal(env.trace.includes('voiceTranscribe'), true, '松开后应把录音送去转写');
  assert.equal(env.input.value, '你好呀', '转写结果只填输入框，不自动发送');
  assert.equal(voice.state(), 'ready', '转写完成后停在"待确认"状态');

  // ⑤ 极短点击：按下即松手 —— 必须干净收尾，绝不能卡在 listening（麦克风常开）
  env.mic.dispatch('pointerdown', { clientX: 314, clientY: 44, pointerId: 3 });
  env.fireDocument('pointerup');
  await sleep(300);
  assert.ok(['cancelled', 'idle'].includes(voice.state()), `极短点击应干净收尾，实际=${voice.state()}`);
  assert.equal(env.strip.hidden, false, '取消时也要有可见反馈（文案就在状态条上）');

  // ⑥ 文案自动收起：状态条与气泡窗都回到原样（不让状态条常驻、窗口一直高一条）
  const settled = await waitFor(() => voice.state() === 'idle' && env.strip.hidden === true, 6000);
  assert.equal(settled, true, '状态文案应自动收起');
  assert.equal(env.trace.includes('voiceStrip=false'), true, '收起时应请求气泡窗缩回原高');
});

test('连按两下（麦克风还没就绪就取消再按）：老链路不得把新链路顶掉', async () => {
  const env = bootRenderer();
  await waitFor(() => env.window.petVoice);
  const voice = env.window.petVoice;
  env.placeMic(300, 30);
  const gate = env.gateUserMedia(); // 让 getUserMedia 挂住：模拟授权/设备慢

  // 第一次按下 → 等它走到"正在开麦克风"（挂住）→ 再取消
  env.mic.dispatch('pointerdown', { clientX: 314, clientY: 44, pointerId: 1 });
  await sleep(40); // 让这条链路先过掉 voiceStatus，停在 getUserMedia 上
  env.fireDocument('pointerup');
  await sleep(30);
  assert.ok(['cancelled', 'idle'].includes(voice.state()), `第一次应已取消，实际=${voice.state()}`);

  // 第二次按下并按住 → 放行麦克风
  env.mic.dispatch('pointerdown', { clientX: 314, clientY: 44, pointerId: 2 });
  await sleep(20);
  gate.release();
  await waitFor(() => voice.state() === 'listening');
  assert.equal(voice.state(), 'listening', '第二次按下应正常进入录音');
  // 只允许建一个录音器：老链路（第一次按下）醒来后必须自己作废，不能把麦克风接回来
  assert.equal(env.counters.recorders, 1, `录音器应只建一次，实际=${env.counters.recorders}`);

  // 收尾：松开 → 转写 → 文案收起
  await sleep(400);
  env.fireDocument('pointerup');
  await waitFor(() => env.input.value.includes('你好呀'));
  assert.equal(env.input.value, '你好呀');
});
