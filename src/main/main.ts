/**
 * src/main/main.ts —— 主进程入口（薄壳）
 *
 * 只做两件事：
 *   1) `import './earlySwitches'`：把必须在 app ready 之前生效的命令行开关
 *      （autoplay-policy 等）在**所有其它模块之前**装好——tsc 的 CommonJS 产物按
 *      import 顺序 require，所以这一行必须是第一行 import。
 *   2) `import './mainImpl'`：真正的主进程实现。
 *
 * 实现保留在 `mainImpl.js`，由 tsconfig 的 `allowJs` 编译到 dist。
 * 模块划分见 docs/PROJECT_LAYOUT.md。
 */
import './earlySwitches';
import './mainImpl';
