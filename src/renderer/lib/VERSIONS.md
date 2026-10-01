# 渲染运行库版本与来源（**已升级到 Cubism 5**，2026-09-23）

> 改运行库前先看 `docs/MODEL_COMPAT.md` §3「运行库升级」——那里记着踩过的坑与验证方法。
> 重取整套：`node scripts/fetch-live2d-runtime.js`

## 当前随包

| 文件 | 版本 / 来源 | 许可 | 能读的 moc3 |
|---|---|---|---|
| `pixi.min.js` | PixiJS **8.14.0**（`pixi.js@8.14.0/dist/pixi.min.js`，693KB） | MIT | — |
| `live2dcubismcore.min.js` | Live2D Cubism Core **5.0**（官方 CDN `sdk-web/cubismcore/live2dcubismcore.min.js`，202KB） | Live2D Proprietary Software License（Redistributable） | **v3 / v4 / v5** |
| `live2d-engine.min.js` | **`untitled-pixi-live2d-engine@1.4.0`** 的 `dist/cubism.min.js`（218KB，Pixi8 原生 RenderPipe；另有 `cubism-legacy.min.js` 支持 Cubism 2） | MIT（引擎）+ Live2D Cubism SDK 许可（内含 Cubism 5 框架） | v3 / v4 / v5 |

**为什么是 Core 5.0 而不是更新的 5.3/Core 6**：引擎 1.4.0 内含的框架镜像与 **Core 5.0 的 API 对齐**；
换成 SDK R5 的 Core 6（moc3 v6）后，`getDrawableRenderOrders()` 返回 undefined，渲染直接抛
`TypeError: Cannot read properties of undefined (reading '0')`（实测）。所以随包锁 **Core 5.0**，
moc3 v6（Cubism 5.3）模型由体检层明确标成超出上限（`unsupported`）并给出出路。

## 升级后为了让新引擎正常工作，代码里做了这 4 处兼容（都在 `src/renderer/live2d.ts`）

1. **按 Pixi 版本自动分流**：`PIXI.VERSION` 主版本 ≥8 走 `new Application()` + `await app.init(...)`，
   否则走旧的构造式写法 —— 同一份代码两代运行库都能跑。
2. **设置文件归一化**（`normalizeModelSettings`）：新引擎在模型没写 `HitAreas` 时会
   `TypeError: _a.map is not a function`（框架把 JSON 键名字符串 `Object.assign` 进了设置对象），
   喂库前在内存里补 `HitAreas: []`（同时补 `url` / Textures / Expressions / Motions 的形态）。
3. **三处新引擎必需的接线**（仅 Pixi8 分支）：
   - `Live2DModel.registerTicker(PIXI.Ticker)`：不注册则动作/物理/顶点更新不被驱动；
   - `model.renderer = app.renderer` + 全局 `window.app`：否则它的绘制回调**静默不画**；
   - 贴图源补 `_gpuData` 字段（Pixi 8.13+ 的 `TextureSource` 没有这个字段，引擎读它会抛
     `Failed to upload Live2D texture.`），并关闭高精度遮罩（`useHighPrecisionMask(false)`）。
4. **参数容器两代兼容**：老栈读 `coreModel._model.parameters`，新栈读
   `_parameterValues` / `_parameterMinimumValues` / `_parameterMaximumValues`；
   参数名→索引先扫 `_parameterIds`（csmString 取值），再退回 `getParameterIndex` 且必须落在合法区间
   （新框架对找不到的 id 会返回 count 这个越界哨兵）。

## 实测结果（升级后）

按 **moc3 版本**归纳（不列用户模型名称）：

| moc3 版本 | 结果 |
|---|---|
| v3 | ✅ 正常渲染；`ParamAngleX/Y/Z`、眼、嘴参数全部解析到（头/眼跟踪 + 口型可用） |
| v4 | ✅ 正常渲染 |
| v5（Cubism 5） | ✅ 正常渲染（升级前只能是占位卡） |
| 立绘（PNG portrait） | ✅ 正常渲染 |
| v6（Cubism 5.3） | ⚠️ 体检标 `unsupported`（引擎框架与 Core 6 不匹配，等引擎更新） |

## 回退办法（万一新栈出问题）

老栈三件套可从上游版本重新获取（Core 4.2）；本目录只保留当前运行库。
`pixi.js@6.5.10/dist/browser/pixi.min.js` 与 `pixi-live2d-display@0.4.0/dist/cubism4.min.js`；
`live2d.ts` 里两代运行库都兼容，换回文件即可（不需要改代码）。
