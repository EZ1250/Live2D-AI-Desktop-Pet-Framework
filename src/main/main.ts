/**
 * 主进程入口：仅转发到 mainImpl。
 *
 * 说明：mainImpl.js 目前是运行时实现来源，并通过 TypeScript `allowJs`
 * 编译到 dist。改动主进程逻辑时需同时验证构建与打包流程。
 */
import './mainImpl';
