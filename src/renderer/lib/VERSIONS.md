# 渲染运行库版本与来源

> 重取整套：`node scripts/fetch-live2d-runtime.js`；改运行库前先看 `docs/MODEL_COMPAT.md` §3。

## 当前随包

| 文件 | 版本 / 来源 | 许可 | 能读的 moc3 |
|---|---|---|---|
| `pixi.min.js` | PixiJS **6.5.10**（`pixi.js@6.5.10/dist/browser/pixi.min.js`，460KB） | MIT | — |
| `live2dcubismcore.min.js` | Live2D Cubism Core **5.1**（官方 CDN `sdk-web/cubismcore/live2dcubismcore.min.js`，207KB；`csmGetVersion()=0x05010000`） | Live2D Proprietary Software License（Redistributable） | **v3 / v4 / v5** |
| `live2d-engine.min.js` | **`pixi-live2d-display@0.4.0`** 的 `dist/cubism4.min.js`（120KB） | MIT（引擎）+ Live2D Cubism SDK 许可（内含 Cubism 框架） | v3 / v4 / v5 |

## 为什么是这套

- **单一渲染路径**：`live2d.ts` 只按 Pixi 6 + pixi-live2d-display 0.4 写，不按 `PIXI.VERSION` 分流，
  也没有旧栈的 Pixi 8 专属补丁（`_gpuData` / `useHighPrecisionMask` / `registerTicker` / `window.app`）。
- **VTS 模型支持**（`live2d.ts`，模型目录里有 `.vtube.json` 时）：
  1) 表情（Exp3）与动作（Animation）合并进 `FileReferences`（否则右键菜单是空的）；
  2) 读 `ParameterSettings` 做参数映射（`FaceAngleX → AngleX/PositionX` 等自定义控制器参数），
     在 `internalModel.updateFocus` 里写参数（motion/表情/眨眼之后、呼吸/物理之前，物理会跟随头部）。
     映射只接管它真正写到的参数：没被映射覆盖的标准参数仍走原有驱动；
     不支持的输入（如 `VoiceA`）在启动日志里列一次；
  3) `pet-model.json` 的 `hiddenDrawables` 在每次 draw 前按 **drawable ID** 隐藏指定遗留贴图
     （不依赖序号/绘制顺序）；接管失败或 ID 找不到会打 warn，不会静默失效。
- **上限 moc3 v5**：moc3 v6（Cubism 5.3）不支持 —— Core 5.1 读不了 v6，Core 6 与引擎内含框架不匹配。

## 下载脚本行为

`scripts/fetch-live2d-runtime.js`：先写同目录临时文件，校验体积区间与版本标记
（`pixi.js - v6.5.10`、`MocVersion_50=5`、`Cubism4ModelSettings` + `VERSION="0.4.0"`）后原子 rename；
任一步失败保留旧运行库并删除临时文件；同时清理清单外的旧文件（如 `live2d-engine-cubism2.min.js`）。
