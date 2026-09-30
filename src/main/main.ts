/**
 * src/main/main.ts —— 主进程入口（薄壳）
 *
 * 只做一件事：加载 `./mainImpl`。
 *
 * ⚠️ 勿把实现搬回本文件：`mainImpl.js` 是最后一次成功编译的产物固化的实现（2026-09-21 一次
 * 批量改写的编码事故损坏了原 TS 源码，产物保留了完整逻辑与中文文案）。它由 tsconfig 的
 * `allowJs` 原样编译进 dist，行为与事故前一致，且已通过构建与打包验证。
 * 若要回迁 TS，务必逐段迁移并重跑 `npm run build:all` 与隐私闸门，不要整文件重写。
 *
 * 模块划分见 docs/PROJECT_LAYOUT.md。
 */
import './mainImpl';
