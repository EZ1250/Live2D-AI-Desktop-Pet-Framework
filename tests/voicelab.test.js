/**
 * voicelab.test.js — 声纹（实时输入电平波形）显示层。
 *
 * 两条线：
 *   ① 无 DOM 时的纯数据行为（token 代际、镜像带 path、stop 归零）—— 老设计就支持，
 *      这里把它钉住，避免以后改成"必须有 DOM 才能跑"；
 *   ② **接管状态条而不是往输入行里插行**。这是"按住说话起不来"的根因所在的回归点：
 *      声纹条以前插在 `.chat-input-row` 之前，一显示就把输入行（连同按住的麦克风按钮）
 *      顶走 → 指针"离开"按钮 → pointerleave 把录音取消。这里断言 DOM 里**没有**任何插入，
 *      并且 stop() 不隐藏状态条本体（紧接着要显示"转写中…/转写失败…"，隐藏了就吞掉文案）。
 *
 * 需要先 `npm run build:tsc`（npm test 已包含），因为加载的是 dist 产物。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const DIST_VOICELAB = path.join(__dirname, '..', 'dist', 'renderer', 'voicelab.js');

/** 极简 DOM 假实现：只覆盖 voicelab 用到的那几个 API（getElementById/createElement/createElementNS/querySelector） */
function makeDom() {
  const registry = new Map();
  class FakeNode {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase();
      this.children = [];
      this.hidden = true;
      this.dataset = {};
      this.style = {};
      this.attrs = {};
      this.textContent = '';
      this.className = '';
      this._id = '';
      this.classList = { add: () => {}, remove: () => {}, toggle: () => {} };
    }
    get id() { return this._id; }
    set id(v) { this._id = String(v); if (v) registry.set(String(v), this); }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    appendChild(child) { this.children.push(child); return child; }
    querySelector(sel) {
      const want = typeof sel === 'string' && sel.startsWith('#') ? sel.slice(1) : null;
      if (!want) return null;
      const walk = (node) => {
        for (const child of node.children) {
          if (child._id === want) return child;
          const hit = walk(child);
          if (hit) return hit;
        }
        return null;
      };
      return walk(this);
    }
  }
  const document = {
    body: new FakeNode('body'),
    getElementById: (id) => registry.get(String(id)) ?? null,
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
  };
  return { document, FakeNode, registry };
}

/**
 * 用给定 document 重新加载 voicelab（全局脚本：执行后挂到 globalThis.PetVoiceLab）。
 * 注意：doc 要一直留在 global 上直到断言结束 —— 模块里的 `document` 是**运行时**查的
 * （`typeof document !== 'undefined'`），提前还原就等于"无 DOM"。
 */
function loadVoicelab(doc) {
  global.document = doc;
  delete require.cache[require.resolve(DIST_VOICELAB)];
  require(DIST_VOICELAB);
  const lab = globalThis.PetVoiceLab;
  assert.ok(lab && typeof lab.begin === 'function', 'voicelab 应挂到 globalThis.PetVoiceLab');
  return lab;
}

test('无 DOM：token 代际、镜像带 path、stop 归零', () => {
  const lab = loadVoicelab(undefined);  const token = lab.begin({ label: '正在连接语音' });
  assert.equal(typeof token, 'number');
  assert.equal(lab.isActive(), true);
  assert.equal(lab.__mounted(), false, '没有 document 时不应尝试挂载');

  let now = 0;
  for (const rms of [0.02, 0.3, 0.6, 0.1]) {
    lab.level(token, rms, rms);
    now += 60;
    lab.__tick(now);
  }
  const state = lab.state();
  assert.equal(state.phase, 'recording');
  assert.ok(state.updates > 0, '喂了电平应当有重绘');
  const d = lab.__path();
  assert.ok(d.startsWith('M0'), `path 应从 x=0 起画：${d.slice(0, 20)}`);
  assert.ok(d.trim().endsWith('Z'), '镜像带应闭合');

  // 旧代际的电平一律丢弃（防止上一段录音的尾巴污染新会话）
  const stale = token;
  const fresh = lab.begin({ label: '重新开始' });
  assert.notEqual(fresh, stale);
  lab.level(stale, 0.9, 0.9);
  assert.equal(lab.state().latest, 0, '旧 token 的电平必须被丢弃');

  lab.stop();
  assert.equal(lab.isActive(), false);
  assert.equal(lab.state().updates, 0);
  assert.equal(lab.__path(), '');
});

test('接管 index.html 里画好的状态条：不往输入行插元素，stop 不隐藏状态条', () => {
  const { document, FakeNode } = makeDom();
  // 复刻 index.html 的结构：#chatbar > (.chat-input-row, #pet-voice-lab > 文本 + 波形)
  const bar = new FakeNode('div'); bar.id = 'chatbar';
  const inputRow = new FakeNode('div'); inputRow.className = 'chat-input-row';
  const strip = new FakeNode('div'); strip.id = 'pet-voice-lab'; strip.hidden = true;
  const status = new FakeNode('span'); status.id = 'pet-voice-status';
  const wave = new FakeNode('span'); wave.id = 'pet-voice-wave'; wave.hidden = true;
  strip.appendChild(status);
  strip.appendChild(wave);
  bar.appendChild(inputRow);
  bar.appendChild(strip);
  document.body.appendChild(bar);

  const lab = loadVoicelab(document);
  const token = lab.begin({ label: '正在连接语音' });

  assert.equal(lab.__mounted(), true);
  // ① 用的是页面里已有的那三个元素，没有另建一套
  assert.equal(document.getElementById('pet-voice-lab'), strip);
  assert.equal(document.getElementById('pet-voice-status'), status);
  assert.equal(strip.children.length, 2, '不应再往状态条里塞重复元素');
  // ② 输入行里 / 输入行前面都没有被插入任何东西（老 bug 就是在这里顶走麦克风按钮）
  assert.equal(bar.children.length, 2, '#chatbar 的子节点数不该因为声纹而变化');
  assert.equal(bar.children[0], inputRow, '输入行必须仍是 #chatbar 的第一个子节点');
  assert.equal(inputRow.children.length, 0, '不应往输入行里插元素');
  // ③ 波形 SVG 建好了
  assert.ok(wave.querySelector('#pet-voice-wave-path'), '波形 path 应已创建');
  // ④ begin 让状态条本体可见（renderer 负责窗口长高，这里只保证内容可见）
  assert.equal(strip.hidden, false);
  assert.equal(status.textContent, '正在连接语音');

  let now = 0;
  for (const rms of [0.05, 0.4, 0.2]) {
    lab.level(token, rms, rms);
    now += 60;
    lab.__tick(now);
  }
  assert.equal(strip.dataset.phase, 'recording');
  assert.equal(wave.hidden, false, '有了 PCM 应显示波形');
  assert.equal(status.hidden, true, '波形出现后应让位给波形');

  // ⑤ stop：只收波形，**不隐藏状态条本体** —— renderer 紧接着要写"转写中…/转写失败…"
  lab.stop();
  assert.equal(wave.hidden, true);
  assert.equal(status.hidden, false);
  assert.equal(strip.hidden, false, 'stop() 不得吞掉状态条（否则转写中的文案看不见）');
  assert.equal(strip.dataset.phase, 'idle');
});
