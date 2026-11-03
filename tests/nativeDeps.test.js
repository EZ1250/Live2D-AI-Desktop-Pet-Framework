/**
 * nativeDeps.test.js —— 原生依赖守卫
 *
 * node_modules 若是跨机器拷贝/安装脚本没跑，active-win 会静默降级成空函数
 * （桌宠角落的窗口状态永远显示「桌面」，且没有任何报错）。这里在 Windows 上
 * 直接断言原生绑定文件存在，把"静默坏掉"变成测试红。
 *
 * 缺绑定时的修法：npm rebuild active-win（需能访问 GitHub 拉官方预编译包）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('active-win：Windows 上必须有 win32 原生绑定（缺了会静默降级成「桌面」）', () => {
  if (process.platform !== 'win32') return; // 该包按平台分发，非 Windows 不适用
  const bindingDir = path.join(ROOT, 'node_modules', 'active-win', 'lib', 'binding');
  assert.ok(fs.existsSync(bindingDir), '找不到 node_modules/active-win/lib/binding（先 npm install）');
  const win32Dir = fs.readdirSync(bindingDir).find((name) => /^napi-\d+-win32-/.test(name));
  assert.ok(
    win32Dir,
    `active-win 缺 win32 绑定目录（现有：${fs.readdirSync(bindingDir).join('、')}）；运行 npm rebuild active-win 修复`,
  );
  const nodeFile = fs.readdirSync(path.join(bindingDir, win32Dir)).find((name) => name.endsWith('.node'));
  assert.ok(nodeFile, `active-win 的 ${win32Dir} 里没有 .node 文件；运行 npm rebuild active-win 修复`);
  const header = Buffer.alloc(2);
  const fd = fs.openSync(path.join(bindingDir, win32Dir, nodeFile), 'r');
  fs.readSync(fd, header, 0, 2, 0);
  fs.closeSync(fd);
  assert.equal(header.toString('latin1'), 'MZ', 'win32 绑定不是有效的 Windows PE 文件（可能拷错了平台）');
});
