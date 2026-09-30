# 外部模型适配说明（普适加载）

> 这份文档对应 `src/main/assets/modelCompat.ts`（模型体检层）与 `scripts/check-model.js`。
> 目标是：**不管模型从哪来、是哪个版本、目录怎么放，应用都要给出"能不能显示 + 为什么 + 怎么办"，而不是黑屏或一张没信息的占位卡。**

## 1. 支持什么

| 类别 | 支持情况 | 说明 |
|---|---|---|
| Live2D **moc3 v3 / v4 / v5**（Cubism 4.0 / 4.2 / 5 导出） | ✅ 正常渲染 | 随包运行库 = Pixi 8.14 + untitled-pixi-live2d-engine 1.4.0 + 官方 Cubism Core 5.0（上限就是 moc3 v5） |
| Live2D **moc3 v6**（Cubism 5.3 导出） | ❌ 暂不支持 | Core 5.0 读不了；升 Core 6 会与引擎内含的框架不匹配（实测渲染崩溃）。体检会明确标 `unsupported` 并给出出路 |
| **Cubism 2.1**（`.moc` / `.model.json`） | ⚠️ 引擎带了 legacy 分支 | `lib/live2d-engine-cubism2.min.js` 已随包；当前渲染层只加载现代分支，需要时再接入（见 §3.3） |
| 只有图片（png/jpg/webp/gif） | ✅ 按**静态立绘**显示 | 有呼吸 / 浮动待机，没有动作与表情 |
| `*.model3.json` 里没有 `FileReferences.Moc`（立绘壳） | ✅ 按**静态立绘**显示 | 目录里有图片就自动降级 |
| 引用文件缺失（缺 moc / 缺贴图） | ❌/⚠️ | 缺 moc → 不能渲染；缺贴图 → 能渲染但会提示缺几张 |

模型目录结构**不要求**固定：描述文件可以放在子目录（最多向下找 3 层）；目录名可以是中文/空格/`#`（URL 各段都会 `encodeURIComponent`）；贴图可以在子目录。一个目录里有多个 `.model3.json` 时，按「文件名和目录同名 → Moc 真实存在 → 目录更浅」挑一个，并把"有几个候选"写进体检结果。

## 2. 怎么自查一个模型文件夹

```bash
node scripts/check-model.js "<模型文件夹>"          # 人读版
node scripts/check-model.js "<模型文件夹>" --json    # 程序读版（不能渲染时退出码 1）
```

输出包含：类型、moc3 版本、**当前运行库的上限**、结论（ok / warn / unsupported）、命中的描述文件、原因、怎么办、细节清单。

同样的信息在应用里也能看到：
- **设置页 → 可插拔资产 → Live2D 模型**：每个模型那行会列出体检问题（红/黄徽章 + 文字）；
- **启动日志**：`[ipc] [模型体检] <模型>：… · unsupported · <原因>；怎么办：…`；
- **模型渲染不出来时**：桌宠窗口中间直接显示原因 + 怎么办（不再是一张没有信息的占位卡）。

## 3. Cubism 5（moc3 v5/v6）现状与升级记录

**结论（实测）**：**moc3 v5（Cubism 5）已经支持** —— 运行库已升级为
**Pixi 8.14 + `untitled-pixi-live2d-engine@1.4.0` + 官方 Cubism Core 5.0**，
v5 模型实测正常渲染。**moc3 v6（Cubism 5.3）暂不支持**（原因见下）。

### 3.1 升级过程中踩过的坑（都已在代码里修好）

| 现象 | 底层原因 | 我们怎么修的 |
|---|---|---|
| 模型没写 `HitAreas` 就 `TypeError: _a.map is not a function` | 引擎把框架设置类的 JSON 键名字符串 `Object.assign` 进了设置对象 | 喂库前在内存里归一化（补 `HitAreas: []` / `url` / 各 FileReferences 形态） |
| 模型加载成功但画布**全透明** | 引擎的绘制回调需要 `model.renderer` 或全局 `app`，都没有就静默 return | 显式 `model.renderer = app.renderer` + 暴露全局 `app` |
| `Failed to upload Live2D texture.` | 引擎读 `texture.source._gpuData[uid]`，而 Pixi 8.13+ 的 `TextureSource` 没有该字段 | 挂载后给每个贴图源补 `_gpuData`（空对象，仅供其布尔判断）并预热绑定 |
| 高精度遮罩分支崩溃 | 引擎默认开高精度遮罩，在这套环境里走进异常分支 | `renderer.useHighPrecisionMask(false)` |
| 头/眼/口型全失效（`present` 全 false） | 参数容器换代：老栈 `_model.parameters`，新栈 `_parameterValues/_parameterMinimumValues`；且 `getParameterIndex(字符串)` 找不到时返回 count 哨兵，`_parameterIds` 是 csmVector 且 `getString()` 返回 `{s}` | 两代容器都认 + 先按名字扫 `_parameterIds` 再退回索引，并校验区间 |
| 模型加载晚于挂载瞬间 → 参数解析全空 | 新框架的 `_parameterValues` 不是挂载当刻就绪 | 前 12 帧内再解析几次（`ensureParamsReady`） |
| 贴图解码 `SecurityError: Failed to construct 'Worker'` | CSP 未放行 blob worker | CSP 加 `worker-src 'self' blob:`（index.html + 静态服务两处） |
| Core 6 渲染每帧 `reading '0'` | SDK R5 的 Core 6 与引擎内含框架的 `getDrawableRenderOrders()` 不匹配 | **随包锁 Core 5.0**；Core 6 只在 `--sdk-core` 实验开关下安装 |

### 3.2 还想支持 moc3 v6（Cubism 5.3）怎么办

- **等引擎更新**：`untitled-pixi-live2d-engine` / `@laplace.live/pixijs-live2d`（2026-09 仍在更新、
  已声明 moc3 v6 verified）把内含框架升到与 Core 6 对齐后，跑 `node scripts/fetch-live2d-runtime.js --sdk-core` 即可。
  体检上限是**解析 Core 得到的**，换 Core 后 `check-model.js` 会自动显示新的上限。
- **或自建打包**：官方 Cubism 5 框架（SDK R5 内 `Framework/` 源码）+ esbuild 打自己的渲染入口，不依赖第三方引擎。

### 3.3 Cubism 2.1（`.moc`）

引擎的 legacy 构建 `lib/live2d-engine-cubism2.min.js` 已随包，但当前渲染层只加载现代分支；
要支持老模型需要再加载 legacy 分支并把 `.model.json` 路由过去（两套引擎共用 `PIXI.live2d` 命名空间，需隔离）。当前体检会把 Cubism 2 模型标成 `unsupported` 并提示重新导出。

### 3.4 万一要回退到老栈

`src/renderer/lib/VERSIONS.md` 末尾写了回退办法（Pixi 6.5.10 + cubism4 0.4.0 + Core 4.2 的取回命令）；
`live2d.ts` 按 `PIXI.VERSION` 自动分流，两代运行库都能跑，**换文件即回退，不用改代码**。

## 4. 代码在哪里

| 位置 | 职责 |
|---|---|
| `src/main/assets/modelCompat.ts` | 体检逻辑：挑描述文件、读 moc3 版本、解析运行库上限、查引用完整性、产出结论与文案 |
| `src/main/assets/userAssets.ts` | 资产扫描时给每个模型带上 `compat`；版本上限不再写死（用 `compat.coreMax`） |
| `src/main/ipc.ts` | 模型 manifest 里带上 `compat`；不 ok 时打启动日志 |
| `src/renderer/renderer.ts` | `compat.verdict === 'unsupported'` 时直接提示原因 + 怎么办；`__petDebug.modelCompat()` 可查 |
| `scripts/check-model.js` | 命令行体检（CI / 排障） |
| `scripts/fetch-cubism-core.js --from` | 从本地 SDK 安装 Core（备份 + 校验 + 回滚） |

## 5. 已知边界

- **Cubism 2 模型**（含 `.moc`）只能用 Cubism Editor 重新导出为 `.moc3`，运行库层面不支持（pixi-live2d-display 的 cubism2 分支没有随包）。
- **只有 `.moc3` 但没有 `.model3.json`**：`pixi-live2d-display` 需要描述文件（贴图列表在里面），应用会提示补描述文件；不自动改写用户的模型目录。
- moc3 **v5 + 老 Core**：即使强行加载也会失败，所以应用选择"不尝试 + 明确告知"，避免出现半渲染的坏画面。
- 体检只读文件、不写用户的模型目录（除了 `pet-model.json` 这类由应用管理的预设文件）。
