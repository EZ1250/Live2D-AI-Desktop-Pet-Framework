/**
 * rendererSandbox.js —— 在 Node 里按「浏览器语义」加载渲染层全局脚本
 *
 * 为什么需要：渲染层是**经典脚本**（无 import/export，靠 index.html 的 <script> 顺序共享一个
 * 全局作用域）。`require()` 会把每个文件包进 CommonJS 模块作用域，于是：
 *   - renderer.js 看不到拆出去（settingsPanel / voiceInput / thinkingOverlay）的顶层函数；
 *   - 拆出去的文件也看不到 renderer.js 的顶层函数（测试里表现为 "xxx is not defined"）。
 * 这里改用 vm 上下文，并让 `window` 就是全局对象本身（与浏览器一致），再按 index.html 的
 * 顺序执行脚本 —— 得到的是真实加载语义，而不是给测试特供的近似。
 *
 * 注意：vm 上下文有**自己的** Object/Array 内建对象，跨 realm 做 assert.deepEqual 会因为
 * 原型不同而失败；比较这些值时先用 plain() 归一化。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const DIST_RENDERER = path.join(ROOT, 'dist', 'renderer');
const SRC_RENDERER = path.join(ROOT, 'src', 'renderer');

/** 与 src/renderer/index.html 的 <script> 顺序一致（renderer.js 必须最后） */
const RENDERER_SCRIPTS = [
  'emotion.js',
  'voicelab.js',
  'gazeController.js',
  'ttsMouth.js',
  'fx.js',
  'panels/todo.js',
  'panels/askBox.js',
  'kernel.js',
  'plugins/emotion.js',
  'plugins/behavior.js',
  'live2d.js',
  'settingsPanel.js',
  'voiceInput.js',
  'thinkingOverlay.js',
  'renderer.js',
];

const toLf = (text) => text.replace(/\r\n?/g, '\n');

/**
 * 在给定 window 对象上执行全部渲染层脚本（window 同时作为 vm 的全局对象）。
 * @param {object} window 测试搭好的假 window（可带 electron bridge / PetLive2d 等）
 * @param {object} extraGlobals document / navigator / location / MediaRecorder 等宿主对象
 * @param {{skip?: string[]}} options skip：不加载的脚本（例如测试注入了 window.PetLive2d 时跳过 live2d.js）
 * @returns {object} 同一个 window（已挂上脚本声明的全局符号与运行状态）
 */
function loadRendererScripts(window, extraGlobals = {}, options = {}) {
  const sandbox = window;
  sandbox.window = sandbox;
  for (const [key, value] of Object.entries(extraGlobals)) sandbox[key] = value;
  // 宿主能力（setTimeout / URL / console / TextDecoder …）走原型链从 Node 全局取
  Object.setPrototypeOf(sandbox, globalThis);
  vm.createContext(sandbox);
  const skip = new Set(options.skip ?? []);
  for (const rel of RENDERER_SCRIPTS) {
    if (skip.has(rel)) continue;
    const file = path.join(DIST_RENDERER, rel);
    vm.runInContext(toLf(fs.readFileSync(file, 'utf8')), sandbox, { filename: file });
  }
  return sandbox;
}

/** 渲染层全部源码（src 侧，顺序同上，行尾统一成 LF）——用于「必须四处同步」这类源码文本断言 */
function readSrcSources() {
  return RENDERER_SCRIPTS.map((rel) => path.join(SRC_RENDERER, rel.replace(/\.js$/, '.ts'))).map((file) =>
    toLf(fs.readFileSync(file, 'utf8')),
  );
}

/** 跨 realm 归一化：把 vm 里的对象/数组变成当前 realm 的普通结构，供 assert.deepEqual 使用 */
const plain = (value) => JSON.parse(JSON.stringify(value));

module.exports = { RENDERER_SCRIPTS, loadRendererScripts, readSrcSources, plain };
