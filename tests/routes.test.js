/**
 * routes.test.js —— 跨进程路由完整性
 *
 * 目标：IPC 通道"定义、preload 暴露、主进程注册/发送"三处一致，防止改名/漏接导致
 * renderer 调用永远挂起或推送永远收不到。
 *
 * 约定（CONTRACT.md）：通道名只在 src/shared/contracts.ts 定义，preload 只准用常量。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(APP, rel), 'utf8');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** contracts.ts 里的 IPC 常量：name → channel 字符串 */
function contractChannels() {
  const src = read('src/shared/contracts.ts');
  const map = new Map();
  for (const m of src.matchAll(/export const (IPC_[A-Z0-9_]+)\s*=\s*'([^']+)'/g)) map.set(m[1], m[2]);
  return map;
}

function mainSource() {
  return walk(path.join(APP, 'src', 'main'))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

function preloadUsage() {
  const src = read('src/preload/preload.ts');
  const invoked = new Set();
  const subscribed = new Set();
  for (const m of src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*(IPC_[A-Z0-9_]+)/g)) invoked.add(m[1]);
  for (const m of src.matchAll(/subscribeChannel<[^>]*>\(\s*(IPC_[A-Z0-9_]+)/g)) subscribed.add(m[1]);
  return { src, invoked, subscribed };
}

test('契约：每个 IPC 常量名唯一、channel 字符串唯一且形如 <domain>:<action>', () => {
  const src = read('src/shared/contracts.ts');
  const names = [...src.matchAll(/export const (IPC_[A-Z0-9_]+)\s*=/g)].map((m) => m[1]);
  assert.equal(new Set(names).size, names.length, 'IPC 常量名有重复');
  const map = contractChannels();
  const values = [...map.values()];
  assert.equal(new Set(values).size, values.length, 'IPC channel 字符串有重复');
  for (const [name, channel] of map) {
    assert.match(
      channel,
      /^[a-z][a-zA-Z0-9]*(?::[a-zA-Z][a-zA-Z0-9-]*)+$/,
      `${name} 的通道名 "${channel}" 不符合 <domain>:<action>（允许 pet:tts:speak 这种多级）`,
    );
  }
});

test('preload：每个通道都从 contracts 引用常量，不写裸字符串', () => {
  const map = contractChannels();
  const { src, invoked, subscribed } = preloadUsage();
  const used = new Set([...invoked, ...subscribed]);
  for (const name of used) assert.ok(map.has(name), `preload 引用了未定义的常量 ${name}`);

  // 裸字符串形式（'chat:logGet'、'window:drag' 等）一律不允许：改名时两处会漂移
  const raw = [
    ...src.matchAll(/ipcRenderer\.(?:invoke|send)\(\s*'([^']+)'/g),
    ...src.matchAll(/subscribeChannel<[^>]*>\(\s*'([^']+)'/g),
  ].map((m) => m[1]);
  assert.deepEqual(raw, [], `preload 里出现裸通道字符串：${raw.join(', ')}`);
});

test('preload：contracts 定义的所有 IPC 通道都经 preload 暴露（无孤儿契约）', () => {
  const map = contractChannels();
  const { src } = preloadUsage();
  const orphan = [...map.keys()].filter((name) => !src.includes(name));
  assert.deepEqual(orphan, [], `这些通道定义了但 preload 没暴露：${orphan.join(', ')}`);
});

test('主进程：每个 renderer→main 请求通道都有 ipcMain.handle / on 注册', () => {
  const main = mainSource();
  const { invoked } = preloadUsage();
  const missing = [...invoked].filter(
    (name) => !new RegExp(`ipcMain\\.(?:handle|on)\\(\\s*(?:contracts_1\\.)?${name}\\b`).test(main),
  );
  assert.deepEqual(missing, [], `这些 invoke/send 通道没有主进程处理器：${missing.join(', ')}`);
});

test('主进程：每个 main→renderer 推送通道都有对应 send 调用', () => {
  const main = mainSource();
  const { subscribed } = preloadUsage();
  const senders = '(?:webContents\\.send|sendToWindow|sendToRenderer|pushToWindows|sendToAllWindows|\\.send)';
  const missing = [...subscribed].filter(
    (name) => !new RegExp(`${senders}\\s*\\([^;]{0,160}?(?:contracts_1\\.)?${name}\\b`, 's').test(main),
  );
  assert.deepEqual(missing, [], `这些订阅通道在主进程没有任何发送点：${missing.join(', ')}`);
});
