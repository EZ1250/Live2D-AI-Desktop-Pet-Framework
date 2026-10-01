# 项目目录约定

分类标准只有两条：这个文件是**人写的**还是**机器生成的**；它属于**生产链路**还是只在**开发/排障**时用。
下面每个文件都能找到归属；找不到归属的，就是该删的信号。

## 1. 顶层分类

| 路径 | 性质 | 说明 |
|---|---|---|
| `src/` | 人写的源码（唯一真源） | 主进程、渲染层、共享契约 |
| `scripts/` | 人写的工具脚本 | 构建、导入、迁移、体检、运行库升级 |
| `tests/` | 人写的测试 | `npm test` 入口（devTools 单测） |
| `docs/` | 文档 | 模型适配说明与 `pet-model.json` 模板 |
| `local-assets/` | 种子/覆盖层 | import 时合并进 `public/assets/`；模型投放点 `live2d_models/`、技能 `skills/`、内置立绘 `大肥鱼/`、托盘图标 `tray-icon.png` |
| `personas/` | 语料层 | import 时并进 `assets/knowledge/`（同名覆盖） |
| `public/` | 生成物 | `assets/`（import 产物）、`renderer/`（assemble 产物） |
| `dist/` | 生成物 | tsc 产物；`dist/renderer` 是加载页面的最后一层兜底 |
| `release/` | 生成物 | electron-builder 产物 |
| 根目录 `*.md` | 文档 | `README.md`、`CONTRACT.md`、`README_PORTABLE.md` |
| 根目录 `*.json/yml` | 配置 | `package.json`、`tsconfig.json`、`electron-builder.yml`、`.gitignore` |

## 2. src/ 内部

```
src/
├── main/                     主进程
│   ├── main.ts               入口薄壳（只 import './mainImpl'）
│   ├── mainImpl.js           编排实现（窗口/IPC/模型/静态服务/生命周期）
│   ├── devDebug.js           PET_* 调试钩子（只在设了 PET_* 时 require）
│   ├── ipc.ts                IPC 处理器（资产/设置/模型/对话/语音…）
│   ├── PathResolver.ts       资源根与模型路径解析（开发/打包/便携 + 兜底）
│   ├── staticServer.ts       本地静态服务（/assets、/user-models、/renderer）
│   ├── tools.ts              本地工具箱（待办/提醒/笔记）
│   ├── assets/
│   │   ├── userAssets.ts     扫描/校验/注册用户模型与插件
│   │   └── modelCompat.ts    模型体检（能不能渲染/为什么/怎么办）
│   ├── ai/
│   │   ├── chatClient.ts     对话主循环（SSE/工具调用/记忆/技能注入）
│   │   ├── devTools.ts       开发辅助工具（建目录/写文件/跑命令）
│   │   ├── workTools.ts      工作区读写检索
│   │   ├── webTools.ts       网页抓取
│   │   ├── voice.ts          语音转写（双路由 ASR）
│   │   ├── memory.ts         用户记忆（memory.md）
│   │   └── skills.ts         技能目录（skills/*.md）
│   ├── monitor/windowMonitor.ts   活动窗口监测（2s 轮询 → 桌宠反应 + 插件事件）
│   └── plugin-system/registry.ts  插件注册表（无插件时降级 no-op）
├── renderer/                 渲染层（无打包器：全局脚本 + <script> 标签）
│   ├── index.html / styles.css / renderer.ts / live2d.ts / emotion.ts / voicelab.ts
│   └── lib/                  第三方运行库（pixi / Cubism Core / Live2D 引擎）——不要手改
├── preload/preload.ts        contextBridge 窄接口
└── shared/contracts.ts       跨模块契约（IPC 通道、类型）——唯一真源
```

## 3. 生成物怎么再生成

| 生成物 | 由谁生成 | 命令 |
|---|---|---|
| `public/assets/**` | `scripts/import-model.js` | `npm run import` |
| `public/renderer/**` | `scripts/assemble-renderer.js` | `npm run assemble` |
| `dist/**` | `tsc`（含 `allowJs` 编译的 `mainImpl.js`/`devDebug.js`） | `npm run build:tsc` |
| `release/**` | `electron-builder` | `npm run build` |

### 3.1 scripts/ 索引

| 脚本 | 何时用 | 是否被自动调用 |
|---|---|---|
| `import-model.js` | 导入模型/语料/技能到 `public/assets` | ✅ `npm run import` / `npm run build` |
| `assemble-renderer.js` | 把 `src/renderer` 拼成 `public/renderer` | ✅ `npm run assemble` / `build:all` |
| `build-portable.js` | 调 electron-builder 出 nsis + portable，并生成 `README_PORTABLE.md` | ✅ `npm run build` |
| `check-privacy.js` | 打包前后扫隐私边界 | ✅ `npm run check:privacy`（也由 build 调用） |
| `check-model.js` | 体检单个模型能否被当前运行库渲染 | 手动：`node scripts/check-model.js "<模型目录>"` |
| `import-bundled-whale.js` | 从内置立绘重生成 `local-assets/大肥鱼/` | 手动（一次性）；**别删**：它是该资产的唯一再生成途径 |
| `migrate-models-to-userdata.js` | 把随包模型迁到用户数据目录 | 手动（一次性迁移） |
| `make_launchers.js` | 生成 `release/` 下的双击启动器（`.bat`，纯 ASCII 内容以适配 cmd 的 GBK 解析） | 手动：`node scripts/make_launchers.js` |
| `fetch-cubism-core.js` / `fetch-live2d-runtime.js` | 升级 Cubism Core / Live2D 运行库 | 手动（升级时才用） |

> 判定"能不能删"的依据是**有没有再生成途径或调用方**，不是引用次数。
> 上面标"手动"的脚本被引用次数少是正常的，删掉会永久失去对应能力。

## 4. 故意的重复——别当冗余删掉

1. **`dist/renderer/`**：渲染页加载失败时的最后一层兜底（`public/renderer` → `resources/renderer`
   → `dist/renderer`）。`electron-builder.yml` 的 `files: dist/**/*` 会把它带进 app.asar，
   删掉等于砍掉"资源缺失时仍能出界面"的能力。
2. **`public/renderer/lib/`**：开发态页面用的运行库，是 `src/renderer/lib` 的拷贝。
3. **`local-assets/live2d_models/`**：内置/种子模型的投放点。`public/assets` 会被 import 清空重建，
   所以想内置的模型只能放这里。目录当前为空，说明见其 `README.md`。
4. **`public/assets/大肥鱼/`**：内置模型，源头在 `local-assets/大肥鱼/`。
5. **`personas/*` 与 `public/assets/knowledge/*` 内容相同**：前者是源，后者是 import 产物，属正常。

## 4.1 语料（knowledge）的合并顺序

`npm run import` 按以下顺序叠加，后者覆盖前者：

1. `personas/` —— 人设与通用台词池（`character.offline.txt`、`<模型名>.md`）；
2. `local-assets/`（除 `live2d_models/` 外的顶层条目，最后合并、优先级最高）。

> 曾有一个工程外的"参考源"`DesktopPet-main/assets/knowledge/`作为第 0 层，**已废弃**（见 §5.2）——
> 它只提供一份 `character.md`，却让 import 依赖一个可能不存在的机器相关绝对路径。

**通用台词池 `character.offline.txt` 的唯一源在 `personas/`**。`local-assets/knowledge/` 下曾有一份
与它字节完全相同的副本；由于 `local-assets` 合并在后、会静默覆盖，两份同内容副本并存只会在日后
改动其一时埋下"改了不生效"的坑，故已删除。实测 import 产物哈希不变（`214f6c03…`），行为无损。
若确实需要临时覆盖，在 `local-assets/knowledge/` 放一份同名文件即可（该目录会被合并，优先级最高）。

**改完语料必须确认它真的生效到已装好的应用**：语料经 import 合并进 `public/assets/knowledge/`，
再由 `migrate-models-to-userdata.js` 搬到 `%APPDATA%/pet-desktop-app/live2d-models/<模型>/knowledge/`。
那一步**必须每次覆盖**（搬运是覆盖写）；早先写成"目标已存在就跳过"，导致改完 `personas/` 跑 import 后
用户目录里的旧副本纹丝不动——改动对应用完全不生效。搬运时打印 `语料已更新：…` 即表示覆盖成功。

## 4.2 台词池写作规范（`*.offline.txt`）

这份语料是**宠物随机说的话**，不是功能说明书。踩过的坑与规矩：

**① `## 分组名` 是程序精确匹配的触发键，一个字都不能改。**
触发源有两类：`windowMonitor.ts` 的 `evaluateTriggers()` 按前台窗口把 11 类软件映射到分组名
（会议/音乐/社交/视频/设计/终端/邮件/网页/代码/文档/全屏游戏），
以及 `mainImpl.js` 的 `handleSceneGroup`（鼠标静止/活跃、长时间工作、健康护眼、早安/深夜/整点/周末）。
改名的后果是**那段台词永远不会被触发**，而界面上看不出任何异常。
（用 AI 改写语料时尤其危险：模型会把标题当文学文本"润色"成"音乐伴侣""办公闲谈"。
可靠做法是**只把台词行交给模型、标题由脚本拼回**。）

**② 绝不声称"我已经帮你做了 X"，也不许声称能感知硬件。**
宠物能观察到的只有：你在用哪类软件、鼠标动没动、过了多久。它**测不到** CPU/内存/温度/风扇/电量/
磁盘/缓存大小/蓝光/瞳孔/心率，也**读不到**你邮箱里有几封什么邮件、你的效率百分比。
写成建议而不是汇报：「CPU温度过高，已暂停高负载任务」→「跑这么久了，机器该热了。你也起身走两步吧」。

**③ 气质是"主宠陪伴"，不是参谋部或系统管理员。**
默认台词池曾有一份整份写成军情参谋（索敌/战术/火力/补给线/阵地）：75 处军事比喻、
13 处命令腔（"这是命令""请立刻执行""系统判定"），已改写为 4 处点缀、0 处命令腔。
那只模型的人设文件本来就写着"军事比喻偶尔使用，不要句句都像指挥"——台词池当时违反了人设。

**④ 人设文件里的能力边界要与代码一致**（反向错误同样有害）。
四份 `.md` 曾都写着"无法访问文件、执行命令或联网"，而项目**其实支持**——
前提是用户先在设置里指定工作区（`devTools.ts`：「未配置则全部拒绝」），危险命令会被拦、
按权限模式逐次确认；联网只能 `web_fetch` 单个 URL。
这些边界应在修改语料或触发逻辑后，通过 `npm test` 和实际场景检查确认。

**⑤ 工程内不写任何具体模型名。**
本仓库是可选模型的框架：默认语料只有 `character.md` / `character.offline.txt`，仓库当前另含一份静态立绘。
模型专属的人设与台词池放该模型自己的目录
（`%APPDATA%/pet-desktop-app/live2d-models/<模型名>/knowledge/`），
程序优先读那份、读不到才回退默认（见 §5.3）。

## 5. 把一个模型做成「内置」

1. 模型整个文件夹放进 `local-assets/live2d_models/<模型名>/`（需 `*.model3.json` + `.moc3` + 贴图）。
2. 先体检：`node scripts/check-model.js "local-assets\live2d_models\<模型名>"`。
3. `npm run import` 合并进 `public/assets/`；需要固定顺序时**自建** `local-assets/model-order.json`（见 §5.0）。
4. `npm run build` 打包。

> `local-assets/` 下**除 `live2d_models/` 外**的顶层条目会被原样合并进 `public/assets/`。
> 说明性文档不要放在 `local-assets/` 根下，放 `docs/`。

### 5.0 两个「模型顺序」文件，别搞混

它们**作用阶段不同**，改错地方会"改了不生效"：

| 文件 | 谁读 | 什么时候生效 | 作用 |
|---|---|---|---|
| `local-assets/model-order.json`（**需要时自建**，当前不存在） | `scripts/import-model.js` | **仅 `npm run import` 期间** | 决定 import 出来的模型顺序；**清单第一项 = 默认模型** |
| `%APPDATA%\pet-desktop-app\live2d-models\.order.json` | `userAssets.readModelOrder()` | **运行期** | 决定用户模型列表顺序；同样第一项 = 默认启动模型 |

要点：

- `local-assets/model-order.json` **不会**被复制进 `public/assets/`（`import-model.js` 显式跳过配置类文件），
  所以运行期看不到它——不要再去找"为什么运行期不读它"。
- `npm run import` 会把种子模型**搬进用户数据目录**（不再随包内置），随包只剩内置立绘「大肥鱼」。
  因此**当前决定默认启动模型的是运行期的 `.order.json`**，`model-order.json` 只在"重新导入"时起作用。
- **只写"种子目录里真实存在"的模型名**（当前种子目录为空，所以这个文件此刻不产生效果）。
  写了种子目录里没有的名字会触发 `WARN: model-order.json 里的模型不在种子目录，已忽略`。
- 种子目录为空**不是错误**：`import` 照样完成（只是没有模型要导入）。
  用户目录里的模型要排序，改运行期的 `.order.json`。

## 5.2 「参考源」已废弃（别再引入工程外路径）

`import-model.js` 曾支持一个工程外的**参考源**目录：

```js
// 已删除，别再写回来
const SOURCE_ROOT = process.env.MODEL_SOURCE_ROOT ||
  'C:\\Users\\enze\\Desktop\\DesktopPet-main\\assets\\live2d_models';
const KNOWLEDGE_SOURCE = process.env.KNOWLEDGE_SOURCE || path.join(path.dirname(SOURCE_ROOT), 'knowledge');
```

废弃理由：

1. **机器相关**：把"素材在哪"写死成某台机器的绝对路径，换机就得改常量或设 `MODEL_SOURCE_ROOT`；
2. **硬失败**：参考源缺失时 import 直接 `exit(1)`，而全新机器上它必然不存在；
3. **已被取代**：模型最终都要搬进 `%APPDATA%\pet-desktop-app\live2d-models`，
   参考源只是多绕一层。种子投放点 `local-assets/live2d_models/` 已经够用（工程自包含）。

现在的**唯一**模型来源：`local-assets/live2d_models/<模型名>/`（单来源，无环境变量、无外部依赖）。


## 5.1 数据目录必须统一（别删那段 setPath）

**`mainImpl.js` 顶部有一段 `app.setPath('userData', …)`，钉死到 `%APPDATA%\pet-desktop-app`。删掉它会
让两种形态读两套数据。**

原因：`app.getPath('userData')` 默认是 `%APPDATA%\<productName>`，而两种形态的 productName 不同：

| 形态 | productName 取自 | 默认 userData |
|---|---|---|
| 开发态（`electron .`） | `package.json` 的 `name` | `%APPDATA%\pet-desktop-app` |
| 打包态（`Pet.exe`） | electron-builder 的 `productName` | `%APPDATA%\Pet` |

于是打包版会**看不到用户已有的模型、设置、聊天记录**，实际表现是"默认模型换了 / 显示不正常 /
API Key 丢了 / 设置改了不生效"——两套配置各改各的，排查时极易误判为功能 bug（真实踩过）。

统一之后两种形态共用一份数据。副作用：Chromium 仍会在 `%APPDATA%\Pet` 建一个空目录，
里面没有任何应用数据，忽略即可。

> 另注：**用户模型的顺序**由 `%APPDATA%\pet-desktop-app\live2d-models\.order.json` 决定
> （见 `userAssets.readModelOrder()`），它决定列表第一项 = **默认启动模型**。
> 种子模型的顺序用 `local-assets/model-order.json`（**需要时自建**；只在 import 阶段生效，不会进 `public/assets/`；
> 需要时自己建，见 §5.0）。

## 5.3 仓库资产与本机数据边界

**原则：仓库只保留可再分发的示例资产，不提交本机路径、配置或密钥。用户模型放在用户数据目录。**

这条被违反过，代价是"项目看起来只在那台机器上成立"。已经清掉的东西：

| 曾经在仓库里 | 现在 |
|---|---|
| `personas/` 下某只模型的人设与台词池 | 只留通用 `character.md` / `character.offline.txt` |
| 代码注释里的"实测 <模型名>" | 改成按 **moc3 版本 / 特征**归纳（信息不减，不含名字） |
| 面板窗口标题硬编码 `<模型名> · 对话` | 标题由渲染层按 `modelList()[0]` 动态生成，取不到就用通用标题 |
| `local-assets/model-order.json` 里列着本机模型名 | 已删除（种子为空时它本就不产生效果） |
| 文档里"在本机实测正常"的模型清单表 | 改成版本支持表 |

**模型专属内容放哪**：`%APPDATA%/pet-desktop-app/live2d-models/<模型名>/knowledge/` 下放
`<模型名>.md`（人设）与 `<模型名>.offline.txt`（台词池）。`chatClient.pickKnowledgeFile()`
优先读模型目录里的那份，读不到才回退 `character.md`——所以个人化不会丢，同时不污染仓库。

**随包不进去的东西**：模型、`settings.json`（含 API Key）、聊天记录、待办、记忆——
它们全在 `%APPDATA%/pet-desktop-app/`。`public/assets/` 里只有内置立绘（`大肥鱼`）、
通用语料、技能与图标。改完用 `verify_no_local_model_info.js` 自查（见 §10）。

## 6. 渲染质量的几个关键开关（改动前先读）

1. **`premultipliedAlpha: false`**（两个引擎分支的 PIXI Application 参数）。
   透明窗口下预乘 alpha 会让抗锯齿的半透明边缘与桌面底色混合出一圈发白描边。
   实测确认：GPU 审计里 `glAttrs.premultipliedAlpha = false`、`antialias = true`（WebGL2）。
2. **`hasShadow: false` + `backgroundColor: '#00000000'`**（主窗口与浮窗）。透明无边框窗口上
   系统阴影会渲染成角色外圈的灰色光晕。

### 6.0 贴图：引擎的 `lod` 开关无效，改用**自己降采样**

**（a）引擎的 `textureOptions.lod` 是无效的 —— 别再被它误导。**
`src/renderer/live2d.ts` 里的 `lod: 'single-auto'` 在**当前运行库 + 本工程加载路径**下
对画面没有可测量影响。同一模型、同一取景、只改这一个值实测：

| 取值 | GPU 审计里贴图 source→effective |
|---|---|
| `false` | 8192² → 8192² |
| `'single-auto'` | 8192² → 8192² |
| `'full'` | 8192² → 8192² |

`effective` 始终等于 `source`，说明纹理**没有**走引擎那条 LOD 分支（走了的话 `effective` 会明显更小）。
**不要用这个开关当作"毛边已解决"或"显存已下降"的依据。**

**（b）真正生效的是 `downscaleModelTextures()`（`TEXTURE_MAX_EDGE = 2048`）。**
在贴图**进显存之前**（必须在 `texture.bind` 之前调用，见源码里的时序注释）把原图 drawImage 到
缩小后的 canvas，再换掉 Pixi TextureSource 的 `resource`。实测（`PET_GPU_AUDIT=1`）：

```
改前 textureLod: 4096x4096, 4096x4096, 8192x8192, 8192x8192
改后 textureLod: 2048x2048, 2048x2048, 2048x2048, 2048x2048
```

- 显存：**640 MB → 64 MB（降约 90%）**
- 帧耗时：6.03ms → 5.44ms
- 依据：桌宠里模型只占屏约 200×470 逻辑像素（DPR 1.5 约 300×700 设备像素），
  2048² 余量充足（即便 DPR=2 且半身放大 2.5 倍也不到 1200 设备像素）。

**（c）关于"有没有变好看"：现有像素指标判定不了，别拿它下结论。**
加了 A/A 对照（**同一配置**跑两次）后发现：`aliasEnergy` 波动达 **±39%**、`hardEdgeRate` ±38.7%，
因为模型一直在呼吸/动作，两次截图的动画相位不同（实测两张 PNG 逐字节不同）。
这个噪声远大于要检测的效应，所以早期"改前 28.47 → 改后 34.17"之类的数字**都是噪声**。
要判定画质，得先冻结动画（固定参数+固定时间步）再比；这一步尚未做。

设备像素比（DPR）在 `refit()` 内每帧检测：窗口跨屏拖动或改系统缩放时 DPR 会变而宽高不变，
漏检会让画布缓冲停在旧倍率上（发虚或白耗显存）。

### 6.0.1 WebGL 上下文必须成对释放（长期挂机的稳定性前提）

每挂一个 moc3 模型都会 `new PIXI.Application`，**每个 app 就是一个 WebGL 上下文**；浏览器对同页
上下文数量有上限（约 16 个）。反复切换模型时若有不释放的分支，上下文会累积，最终表现为
"模型加载不了"或渲染进程失稳——属于挂机几小时才暴露的问题。

`mountLive2D` 的**每一条退出路径**都必须释放 app：

| 退出路径 | 处理 |
|---|---|
| `app.init()` 失败 | `app.destroy(true)` |
| 拿不到 canvas（`!view`） | `app.destroy(true)` |
| `.from()` 期间被弃用（`destroyed`） | `model.destroy()` **且** `app.destroy()` ← 曾漏掉 app，已修 |
| 加载 reject（`.catch`） | `app.destroy(true)` |
| 正常卸载（`handle.destroy()`） | `model.destroy()` + `app.destroy(true, {children,texture})` |

改这段时请跑 `verify_gl_context_lifecycle.js`（审计脚本目录内）核对，别只看"能不能渲染"。

## 6.1 托盘的作用（别删）

窗口尺寸默认 360×520 且可缩放。主窗口**曾经**带 `skipTaskbar`（不占任务栏、不进 Alt-Tab），
现已移除：那个设置叠加"窗口没正常显示"时，用户不仅看不到窗口，连程序在跑的迹象都没有
（任务栏与 Alt-Tab 都找不到），只能翻任务管理器。现在任务栏里能找到它，托盘是便捷入口而非唯一退路
（浮窗仍保留 `skipTaskbar`，它本来就是隐藏弹出的小贴纸）。

托盘菜单包含「显示/隐藏」「把桌宠摆回屏幕内」「取景」「点击穿透」「设置」「退出」。

- 图标源：`local-assets/tray-icon.png`（256×256，由内置立绘 `大肥鱼/whale.png` 裁头部生成）。
  `npm run import` 会把它复制进 `public/assets/`，与模型一样随 `extraResources` 打包；
  进程内从 `PathResolver.assetsRoot()` 取，找不到时降级为空图标（不崩、菜单仍可用）。
- 「把桌宠摆回屏幕内」复用位置记忆的可见性判定（见 §6.2），不另写一套。
- 全局快捷键（下表）是"连托盘都点不到"时的兜底召回方式，托盘菜单底部会列出它们。
  注册失败必须容忍（组合键可能被截图/录屏等软件占用），只警告不中断启动；退出时逐个注销，
  否则这些组合键会被一直占着、用户会以为键盘坏了。

| 快捷键 | 动作 |
| --- | --- |
| `Ctrl+Alt+P` | 显示 / 隐藏桌宠（与托盘同一个开关） |
| `Ctrl+Alt+O` | 打开设置 |

（源码里写 `CommandOrControl`，macOS 上即 `Cmd`；界定在 `src/main/mainImpl.js` 的 `GLOBAL_SHORTCUTS`。）

## 6.2 位置记忆

桌宠窗口的位置与尺寸写在 `settings.json` 的 `petX/petY/petW/petH`，移动/缩放后**防抖 600ms** 落盘。
启动时只在"与某个显示器工作区至少重叠 40×40"时才沿用；否则回落默认位置——换屏、拔屏、
分辨率变小之后旧坐标可能落在可见区外，直接沿用会让桌宠"消失"。

⚠️ `saveAppSettings` 是**整体覆盖写入**（`{ ai: settings }`）。任何新的写入方都必须
**读-改-写**（`{ ...loadAppSettings(), 字段 }`），否则会把 API Key 等配置一起清掉。

## 6.3 全屏时自动收起桌宠

桌宠是 `alwaysOnTop`，而全屏游戏/视频/演示会铺满整屏，桌宠压在上面很碍事。
活动窗口监测（默认 2s 轮询）发现前台全屏时收起桌宠，退出全屏再自动放回来；
设置项 `hideOnFullscreen` 默认开启，可在设置页关掉。

三个状态必须分开记，否则会互相打架（`src/main/mainImpl.js`）：

| 状态 | 含义 | 规则 |
|---|---|---|
| `userHiddenPet` | 用户主动隐藏（托盘 / 关窗） | **永不自动弹出**，只能用户自己叫回来 |
| `petAutoHidden` | 本次隐藏是因全屏触发 | 退出全屏后自动恢复 |
| `petShownDuringFullscreen` | 用户在这次全屏里手动显示过 | 本次全屏期间不再收回，直到全屏结束才复位 |

第三条是必需的：活动窗口每 2s 轮询一次，若不记这一笔，用户刚点「显示桌宠」就会被下一次轮询
按回隐藏，表现为"点了没用"。托盘的显隐与「摆回屏幕内」统一走 `setPetVisibleByUser()`，
保证三个状态不会留下互斥残留。

## 6.4 拖放加入资产

把模型或插件**文件夹**拖到桌宠身上即可加入（与设置页的「＋ 添加模型 / 插件…」等价）。
主进程按目录内容自行判定：含 `.model3.json`/`.moc3` → 模型；含 `pet-plugin.json` → 插件；
两者都不是时回一句可读原因并列出目录内容。加入走的是同一套 `registerModelDir`/`registerPluginDir`。

两个容易踩的点（改动前务必知道）：

1. **必须全局阻止 `dragover`/`drop` 的默认行为**。否则把文件拖进窗口时 Chromium 会导航去打开
   那个文件——桌宠窗口直接变成文件预览页，看起来就是"白屏坏了"。
2. **Electron 31+ 渲染层拿不到 `File.path`**。唯一受支持的方式是 preload 里的
   `webUtils.getPathForFile(file)`（`window.electron.pathForFile`），所以新增了
   `IPC_ASSET_IMPORT_PATH`（`assets:importPath`）这条"直接给路径"的通道；
   它与 `IPC_ASSET_IMPORT` 的区别只是不经系统文件夹选择器。

## 6.5 浏览器权限闸门（最小授权）

渲染层的语音输入要调 `navigator.mediaDevices.getUserMedia({audio:true})`。**Electron 默认自动批准**
媒体权限、且不弹系统提示——等于任何跑在这个页面里的脚本都能静默打开麦克风。现在在 `bootstrap`
第 1.2 步（**开窗之前**）装了 `session.defaultSession` 的 request + check 两个处理器：

- `media` 且 `mediaTypes` **恰好是 `['audio']`** → 放行；
- 一旦捎带 `video`（摄像头）→ 拒绝；
- 其余权限（`geolocation`/`notifications`/`clipboard-read`/`hid`/`serial`/`usb`/`display-capture`…）→ 一律拒绝；
- `mediaTypes` 缺失时放行（语音是核心功能，误拒会让"按住说话"直接报错；此时仍只有音频这一项被放）。
- 拒绝都会打日志，便于排查"某个网页 API 为什么不好使"。

⚠️ 这**不能替代操作系统的隐私开关**：Windows 的「麦克风访问」仍由系统设置决定，放行 ≠ 一定能录到音。

## 6.6 点击穿透 + 命中测试（默认关闭）

透明区域不拦截鼠标（点击落到下面的窗口/桌面），只有角色身体范围可交互。
**默认关闭**（设置项 `clickThrough`）——这是全项目风险最高的交互变更：判太宽，桌宠会把桌面点击
全吃掉（用户以为电脑坏了）；判太窄，桌宠点不动。

**分工**：主进程知道窗口位置与全局光标，换算出**相对客户区**坐标经 `IPC_HIT_PROBE` 发给渲染层；
渲染层用命中遮罩判定后经 `IPC_HIT_RESULT` 回报，主进程据此 `setIgnoreMouseEvents(ignore, {forward:true})`。
为什么不让主进程判：贴图上某个像素"可见"还取决于网格顶点、变形器、遮罩与混合，
**只有渲染层拿得到最终合成后的像素**，那才是用户看到/点到的东西。

**命中遮罩**：把画布降采样成 128×128 的 alpha 位图缓存起来（`getImageData` 一次约 256KB），
按 500ms 节流刷新（角色在动，但位移很小）。刷新失败保留上一次结果，不清空。

> ⚠️ **取样必须在"本帧绘制刚结束"时进行**（`captureHitMaskNow()`，由渲染循环在
> `renderer.render(stage)` 之后紧接着调用）。
> 上下文是 `preserveDrawingBuffer: false`（GPU 审计里的 `glAttrs`），浏览器合成后可以随时清空绘制缓冲；
> **在帧外**用 `drawImage` 读画布只会拿到**全透明**，于是每次都判定"不在角色身上"——
> 穿透表现为**完全不生效**（这是修复前的真实故障，见下）。
> 因此 `refreshHitMask()` 只做"排队等下一帧"，真正的读取在帧内完成。
>
> 另有一道**空帧防线**：若取样结果的不透明像素 ≤4（视为拿到空帧），直接丢弃、不覆盖旧值。
> 否则一旦取到空帧就会得出"到处都不在角色身上"，穿透会反向变成**整窗穿透**——
> 用户连右键和设置都点不动（这是更早一次踩过的坑）。
>
> 实机验证方式：设 `PET_GPU_AUDIT=1` 与 `PET_AUDIT_FILE=<路径>`（打包版无控制台，必须落盘），
> 审计里的 `hitMask` 会给出 `stats.opaque` / `stats.bbox` 与 15 个采样点的判定。
> 正常表现：`opaque` 明显大于 0，且**包围盒内部的采样点判为 hit=true**。

**四条安全兜底**（改这段时一条都不能少）：

1. 渲染层拿不到 handle、遮罩未就绪（`ok=false`）、或判定抛错 → 一律回报**不穿透**；
2. 光标离开窗口 / 落在边框区 / 取几何失败 → 立刻恢复可交互；
3. 隐藏、显示、退出全屏都会 `resetHitIgnore()`，穿透状态绝不跨显示状态保留；
4. 托盘有「点击穿透」开关作**逃生口**，关掉即刻恢复；设置页关掉后 2s 内也会自动恢复。

`forward: true` 不能省：穿透状态下仍需把鼠标移动事件转给本窗口，否则渲染层收不到探测、
移回角色身上时永远无法恢复可交互。

## 7. 开发专用代码的边界

- `PET_*` 调试钩子集中在 `src/main/devDebug.js`。入口只有一句条件 require，没设 `PET_*` 时该文件
  不会被加载；打包体积上它仍在 asar 内，但不参与正常运行。
- 渲染层调试入口：`window.__petDebug`（只读查询：`bounds()`/`tracking()`/`paramInfo()` 等）。
- `PET_GPU_AUDIT=1`：打印 WebGL 上下文属性（含 antialias / premultipliedAlpha）、画布缓冲与 DPR、
  CSS 合成层、moc3 内部状态与 60 帧平均耗时——排查"毛边/糊/掉帧"时先看它。

## 7.1 AI 工具一览（加工具要改哪三处）

工具要生效必须**同时**出现在三个地方，漏一处就是"模型调了但没反应"，而且不报错、很难查
（`verify_tools.js` 会逐个核对）：

| # | 位置 | 作用 |
|---|---|---|
| ① | `src/main/ai/chatClient.ts` 的 `TOOL_DEFS` | 告诉模型"有这个工具、参数是什么" |
| ② | 同文件的 `validateToolArgs` | 必填参数挡在调用之前（别让错别字触发一次真实操作） |
| ③ | `src/main/mainImpl.js` 的 switch / `if (name === …)` | 真正执行 |

实现放 `src/main/ai/<名字>Tools.ts`，导出 `export async function xxx(args): Promise<string>`，
**绝不抛异常**——返回的那句话会直接显示给用户。

### 各工具的能力与"要不要先问用户"

| 工具 | 依赖 | 是否弹确认 | 说明 |
|---|---|---|---|
| `weather_get` | Open-Meteo（免费无密钥） | 否 | **故意不做 IP 定位**：那会把位置发给第三方且常定位错城市，宁可让 AI 先问一句 |
| `media_control` | 系统媒体键 | 否 | 不针对具体播放器，对任意播放器（含浏览器视频）有效 |
| `screen_capture` | `desktopCapturer` | **是** | 截屏会把屏幕内容落盘，属于"留痕迹"的操作 |
| `meeting_create` | 无（生成 .ics） | 否 | 不接日历 API，靠系统默认日历导入，零授权 |
| `translate_text` | 用户已配的 AI 接口 | 否 | 长文翻译不占主对话上下文；术语更统一 |
| `mail_compose` | 系统默认邮件客户端 | 否 | 只打开草稿，**不会替用户发信** |
| `mail_check` | 用户自配 IMAP | 否（只读） | 没配就如实说明；用 `BODY.PEEK` 取信头，**不改动未读状态** |

**新增工具的三条经验**（都踩过）：
1. 用外部模型生成模块时，**必须显式禁止引入新依赖**——否则它会 `import iconv-lite` 之类；
   需要 GBK 解码用 Node 自带的 `new TextDecoder('gbk')` 就够（ICU 已内置）。
2. 白名单校验要用 `Object.prototype.hasOwnProperty.call(map, key)`，
   写 `key in map` 会让 `'toString'`/`'constructor'` 通过（原型链继承），取出的值是 `undefined`。
3. 模型给的代码要逐条核对边界：本轮修掉了"折行解析写成死循环""`.ics` 结尾缺 CRLF"
   "`tls.connect(port, host, cb)` 重载不存在""`save_path` 变量可能未赋值"等问题。

## 8. 自检命令

```bash
node scripts/check-model.js "<模型文件夹>"   # 模型能不能渲染
npm run build:all                            # 类型 + 装配
npm test                                     # 单测（devTools）
npm run check:privacy --all                  # 打包前后密钥/隐私闸门
```

项目内置校验范围见上面的命令；窗口交互、渲染和权限提示仍需在 Windows 目标环境中手动确认。

## 9. 已知未做 / 待实机确认

- **渲染质量（毛边）**：根因与修复见 §6（`lod: 'single-auto'` + `premultipliedAlpha:false` +
  关阴影）。修复已在代码与产物中，但**缺实机确认**——用 `PET_GPU_AUDIT=1` 看
  `moc3.textureLod` 的 `effective` 是否小于 `source`，或直接目视。
- **动画状态机**：待机/移动/被拖/点击/睡觉/随机行为目前是散落的即时逻辑，没有显式状态机。
  重构需要看着动画调状态切换，属"没有运行环境不该盲改"的部分。
- **双击**：需求未定义双击该做什么，未实现（随意绑定有干扰单击的风险）。
- **序列帧动画**：当前模型集是 Live2D + 立绘，无序列帧素材来源。

## 10. 验证边界

自动化检查覆盖类型、开发工具和隐私边界；Live2D 渲染质量、窗口交互、托盘、快捷键与系统权限
仍需在 Windows 目标环境中手动确认。

