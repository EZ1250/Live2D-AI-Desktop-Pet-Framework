# 外部模型适配说明（普适加载）

> 这份文档对应 `src/main/assets/modelCompat.ts`（模型体检层）与 `scripts/check-model.js`。
> 目标是：**不管模型从哪来、是哪个版本、目录怎么放，应用都要给出"能不能显示 + 为什么 + 怎么办"，而不是黑屏或一张没信息的占位卡。**

## 1. 支持什么

| 类别 | 支持情况 | 说明 |
|---|---|---|
| Live2D **moc3 v3 / v4 / v5**（Cubism 4.0 / 4.2 / 5 导出） | ✅ 正常渲染 | 随包运行库 = Pixi 6.5.10 + pixi-live2d-display 0.4.0 + 官方 Cubism Core 5.1（上限就是 moc3 v5） |
| Live2D **moc3 v6**（Cubism 5.3 导出） | ❌ 暂不支持 | Core 5.1 读不了 v6；Core 6 与引擎内含的框架不匹配（实测渲染崩溃）。体检会明确标 `unsupported` 并给出出路 |
| **Cubism 2.1**（`.moc` / `.model.json`） | ❌ 暂不支持 | 当前渲染入口不加载 Cubism 2 运行库；请用 Cubism Editor 重新导出为 moc3 |
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

## 3. Cubism 5（moc3 v5/v6）现状与运行库

**结论（实测）**：**moc3 v5（Cubism 5）已经支持** —— 运行库为
**Pixi 6.5.10 + `pixi-live2d-display@0.4.0` + 官方 Cubism Core 5.1**，
v5 模型实测正常渲染。**moc3 v6（Cubism 5.3）暂不支持**（Core 5.1 读不了 v6，Core 6 与引擎内含框架不匹配）。
VTS 导出的模型（带 `.vtube.json`）会在挂载前合并表情/动作，并按 `ParameterSettings` 做参数映射
（自定义 `AngleX/PositionX` 等控制器参数），见 `src/renderer/lib/VERSIONS.md`。

### 3.1 已处理的兼容点（都已在代码里修好）

| 现象 | 底层原因 | 我们怎么修的 |
|---|---|---|
| 头/眼/口型全失效（`present` 全 false） | 参数容器两代形状不同：`_model.parameters` 与 `_parameterValues/_parameterMinimumValues`；`getParameterIndex(字符串)` 找不到时返回 count 哨兵 | 两种容器都认 + 先按名字扫 `_parameterIds` 再退回索引，并校验区间 |
| 模型加载晚于挂载瞬间 → 参数解析全空 | 框架的 `_parameterValues` 不是挂载当刻就绪 | 前 12 帧内再解析几次（`ensureParamsReady`） |
| 贴图解码 `SecurityError: Failed to construct 'Worker'` | CSP 未放行 blob worker | CSP 加 `worker-src 'self' blob:`（index.html + 静态服务两处） |
| VTS 模型右键菜单没有表情/动作 | 表情/动作写在 `.vtube.json`，`model3.json` 的 `FileReferences` 是空的 | 挂载前把 Exp3/Animation 合并进内存 model3（`normalizeModelSettings`） |
| VTS 模型只有眨眼、头不跟鼠标 | 模型用自定义控制器参数（`AngleX/PositionX`），标准 `ParamAngleX` 并不存在 | 读 `.vtube.json` 的 `ParameterSettings` 做映射，并在 `internalModel.updateFocus` 写参数（物理才会跟随） |

### 3.2 还想支持 moc3 v6（Cubism 5.3）怎么办

- **等引擎更新**：`pixi-live2d-display` 把内含框架升到与 Core 6 对齐后，改
  `scripts/fetch-live2d-runtime.js` 里的 Core URL 重新取库；体检上限是**解析 Core 得到的**，
  换 Core 后 `check-model.js` 会自动显示新的上限。
- **或自建打包**：官方 Cubism 5 框架（SDK R5 内 `Framework/` 源码）+ esbuild 打自己的渲染入口，不依赖第三方引擎。

### 3.3 Cubism 2.1（`.moc`）

当前渲染入口不支持 `.moc` / `.model.json`（`pixi-live2d-display` 的 cubism4 构建只读 moc3）；
体检会把 Cubism 2 模型标成 `unsupported` 并提示用 Cubism Editor 重新导出为 moc3。

### 3.4 换运行库/升级时怎么做

运行库三件套由 `scripts/fetch-live2d-runtime.js` 统一取回（原子写 + 体积/版本校验 + 清理旧文件）。
不要用 `git checkout` 单独回退 `src/renderer/lib/`：当前 `live2d.ts` 只支持这一套单栈
（Pixi 6 + pixi-live2d-display 0.4），回退文件而不回退代码会直接渲染失败。
要换版本：改脚本顶部的 URL/版本标记 → 重跑脚本 → `npm run build:all`。

## 4. 代码在哪里

| 位置 | 职责 |
|---|---|
| `src/main/assets/modelCompat.ts` | 体检逻辑：挑描述文件、读 moc3 版本、解析运行库上限、查引用完整性、产出结论与文案 |
| `src/main/assets/userAssets.ts` | 资产扫描时给每个模型带上 `compat`；版本上限不再写死（用 `compat.coreMax`） |
| `src/main/ipc.ts` | 模型 manifest 里带上 `compat`；不 ok 时打启动日志 |
| `src/renderer/renderer.ts` | `compat.verdict === 'unsupported'` 时直接提示原因 + 怎么办；`__petDebug.modelCompat()` 可查 |
| `scripts/check-model.js` | 命令行体检（CI / 排障） |
| `scripts/fetch-live2d-runtime.js` | 取回/升级运行库三件套（原子写 + 校验 + 清理旧文件） |

## 5. 已知边界

- **Cubism 2 模型**（含 `.moc`）只能用 Cubism Editor 重新导出为 `.moc3`；当前渲染入口不加载 legacy 分支。
- **只有 `.moc3` 但没有 `.model3.json`**：`pixi-live2d-display` 需要描述文件（贴图列表在里面），应用会提示补描述文件；不自动改写用户的模型目录。
- moc3 **v6**：Core 5.1 读不了，应用选择"不尝试 + 明确告知"，等运行库升级后再支持。
- 体检只读文件、不写用户的模型目录（除了 `pet-model.json` 这类由应用管理的预设文件）。
