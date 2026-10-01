# 第三方资源与许可 / Third-Party Notices

本仓库原创的代码与文档采用 **MIT**（见 [`LICENSE`](LICENSE)）。

下面这些第三方资源**不由 MIT 覆盖**，各自遵循其原始许可条款，再分发前请逐项核验。

The original code and documentation in this repository are licensed under **MIT**
(see [`LICENSE`](LICENSE)). The third-party resources below are **not** covered by
that MIT grant and keep their own terms — verify each one before redistributing.

---

## 运行库 / Runtime libraries

| 文件 | 组件 | 说明 |
|---|---|---|
| `src/renderer/lib/pixi.min.js` | PixiJS | 2D 渲染引擎 |
| `src/renderer/lib/live2dcubismcore.min.js` | **Live2D Cubism Core** | Live2D 官方运行库，**有独立授权条款**，商用/再分发条件需自行确认 |
| `src/renderer/lib/live2d-engine.min.js` | Live2D 引擎适配层 | 与 Pixi 的桥接 |
| `src/renderer/lib/live2d-engine-cubism2.min.js` | Cubism 2 兼容层 | 当前渲染入口未启用 |

> ⚠️ **Live2D Cubism Core 是最需要注意的一个。** 它是 Live2D Inc. 的产品，
> 有独立的使用与再分发条款（尤其商用场景）。公开或商用前请到 Live2D 官网确认你符合其许可。
> 本项目仓库只包含一张静态示例立绘和托盘图标；用户的 Live2D 骨骼模型应放入本机用户数据目录。

## 素材 / Assets

| 文件 | 说明 |
|---|---|
| `local-assets/大肥鱼/whale.png` | 本项目内置的静态立绘占位图 |
| `local-assets/tray-icon.png` | 托盘图标 |

## npm 依赖 / npm dependencies

见 [`package.json`](package.json) 与 `package-lock.json`；
各依赖遵循其自身许可（多数为 MIT / ISC / Apache-2.0）。
其中 `active-win` 为原生模块，安装时会执行 `node-gyp rebuild`。
