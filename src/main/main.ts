/**
 * src/main/main.ts —— 主进程入口（薄壳）
 *
 * 只做一件事：加载 `./mainImpl`。
 *
 * 实现保留在 `mainImpl.js`，由 tsconfig 的 `allowJs` 编译到 dist。
 *
 * 模块划分见 docs/PROJECT_LAYOUT.md。
 */
import './mainImpl';
