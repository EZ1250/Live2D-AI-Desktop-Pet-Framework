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
| `check-privacy.js` | 扫描源码、生成物和打包产物中的隐私文件与密钥 | ✅ `npm run check:privacy`（`build-portable.js` 在打包前后自动调用） |
| `check-model.js` | 体检单个模型能否被当前运行库渲染 | 手动：`node scripts/check-model.js "<模型目录>"` |
| `import-bundled-whale.js` | 从内置立绘重生成 `local-assets/大肥鱼/` | 手动（一次性）；**别删**：它是该资产的唯一再生成途径 |
| `migrate-models-to-userdata.js` | 把随包模型迁到用户数据目录 | `import-model.js` 导入完成后自动调用，也可手动运行 |
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

**① `## 分组名` 必须使用已登记的触发键或同义键。**
触发源有两类：`windowMonitor.ts` 的 `evaluateTriggers()` 按前台窗口把 11 类软件映射到分组名
（会议/音乐/社交/视频/设计/终端/邮件/网页/代码/文档/全屏游戏），
以及 `mainImpl.js` 的 `handleSceneGroup`（鼠标静止/活跃、长时间工作、健康护眼、早安/深夜/周末）。
健康、摸鱼、早安等合并分类已在 `mainImpl.js` 登记同义键；其他分类改名仍可能导致
台词无法触发，而界面上看不出任何异常。
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
  path.join(os.homedir(), 'Desktop', 'DesktopPet-main', 'assets', 'live2d_models');
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
通用语料、技能与图标。改完运行 `npm run check:privacy` 检查是否有本机路径或密钥进入打包内容。

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

改这段时应检查 `mountLive2D` 的所有退出路径都释放 WebGL 资源，并运行 `npm test`。

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

## 6.7 取景标定（内容锚点）——"角色只显示一条边/严重偏移"的病根

moc3 取景的居中基准不是画布包围盒，而是从**命中遮罩**量出来的真实内容框（画布留白大的模型
按包围盒居中会偏）。两条真机教训（2026-10-21，Cubism 3 模型实测）：

1. **遮罩只包含窗口可见部分**。角色一旦被裁掉一块，量出来的内容框就缺一块、中心必然偏；
   按它摆位就是"启动时角色偏出窗口"。所以标定**必须只在内容完整可见时**采信测量值 ——
   代码里的做法是 `measure` 阶段强制全身并逐步缩小（`calibExtra ×= 0.55`），
   直到遮罩四边都不贴窗口边（`CALIB_EDGE_MARGIN`），才把这一帧的量测当作内容框。
2. **局部原点不一定在内容左上角**：这台引擎里 `model.position` 参照的原点与
   `model.width/height`（只给尺寸、不给偏移）不是同一个角。该模型画布 1211×3778，
   真实内容却在局部坐标 `x≈932..2102`。所以**不能**要求"内容框落在 `[0,natW]×[0,natH]` 内"
   —— 那会把正确测量否掉，退回包围盒后角色只剩右边缘一条（用户看到的"只显示一部分"）。

标定流程（`live2d.ts` 的 `calibPhase`）：`measure`（缩小到完整可见 → 量内容框）→
`verify`（按内容锚点 fit 摆一帧，复核内容完整可见且居中，偏差 ≤12%）→ `done`（套用户取景）。
三步都过不去才退回画布包围盒。自查：控制台 `[live2d] 内容锚点标定（measure）…完整可见=true`
与 `内容锚点复核通过：偏离中心 N×Mpx` 两行就是标定成功的证据。

## 7. 开发专用代码的边界

- `PET_*` 调试钩子集中在 `src/main/devDebug.js`。入口只有一句条件 require，没设 `PET_*` 时该文件
  不会被加载；打包体积上它仍在 asar 内，但不参与正常运行。
- 渲染层调试入口：`window.__petDebug`（只读查询：`bounds()`/`tracking()`/`paramInfo()` 等；
  另有 `voiceStrip(true|false)` 与 `expandChat()` 用来验证"语音状态条显隐时麦克风按钮坐标不变"）。
- `PET_GPU_AUDIT=1`：打印 WebGL 上下文属性（含 antialias / premultipliedAlpha）、画布缓冲与 DPR、
  CSS 合成层、moc3 内部状态与 60 帧平均耗时——排查"毛边/糊/掉帧"时先看它。
- `PET_VOICELAB_TEST=1`：用合成电平驱动声纹，打印波形 path / 相位 / 几何，并**断言**
  `micUnmoved`（状态条显隐前后麦克风按钮坐标一致）、`stripAboveBar`（状态条在气泡上方）、
  `windowGrew`（窗口长高了状态条那一条）。

## 7.1 AI 工具一览（加工具要改哪三处）

工具要生效必须**同时**出现在三个地方，漏一处就是"模型调了但没反应"，而且不报错、很难查
（修改后应通过相关测试核对）：

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

## 7.2 语音状态条的位置契约（改布局前先读）

语音输入（按住说话）的**声纹波形与全部文案**都画在 `#pet-voice-lab` 这条状态条上。两条约束：

1. **它绝不能回到输入行的文档流里**。以前声纹条插在 `.chat-input-row` 之前，一显示就把输入行
   连同**按住的麦克风按钮**顶走；浏览器在下一次鼠标移动时补发 `pointerleave`，指针其实一步没动
   却被判成"用户走开"，录音当场取消 —— 表现就是"在正常对话框里按住说话毫无反应"。
   现在状态条是绝对定位（不参与布局），并且 `cancelByPointerAway` 还会按**按钮当前矩形**
   复核坐标，只有指针真的离远才取消。
2. **高度是跨进程约定**：气泡窗本体是一整块固定尺寸的窗口，没有"气泡外面"的地方可画，
   所以显示状态条时由主进程把窗口向上长高一条、**底边钉住**（气泡与输入行在屏幕上原地不动）。
   渲染层 CSS 的 `--voice-strip-h` 与主进程的 `CHAT_WINDOW_VOICE_STRIP_HEIGHT` 必须相等
   （`tests/contracts.test.js` 会比对这两个数字），高度经 `IPC_CHAT_WINDOW_VOICE_STRIP` 通知。
   桌宠窗口内的回退输入条上方没有窗外空间，状态条在那里改为悬浮在输入行上方。

另外两条与它直接相关的实现约定：
- 语音文案**不写进聊天记录**：消息区（`#chat-log`）在气泡窗折叠态是整片隐藏的，而折叠态正是
  气泡窗打开时的默认形态 —— 报错写进去等于没提示。
- 状态文案的自动收起集中在 `setVoiceState` → `scheduleVoiceRowHide`：每个分支各写一个
  `setTimeout` 时，漏写的那条（例如"当前版本没有接入语音转写"）会让状态条与窗口高度一直留着。

## 7.3 转写模型怎么选（"一直语音识别失败"的病根）

本应用只有两条转写路：`POST <base>/audio/transcriptions` 与 `POST <base>/chat/completions`
（`input_audio` data URL）。**能不能用取决于模型名，而不是模型在不在 `/models` 列表里。**

2026-10-11 在用户自己的百炼工作区域名（`ws-*.maas.aliyuncs.com/compatible-mode/v1`）上逐项实测：

| 模型名 | 结果 |
|---|---|
| `qwen3-asr-flash` | ✅ chat-audio 0.4~0.8s 出文本（合成 wav 与真实 ogg/opus 都过）——**唯一可用**，而它**不在** `/models` 列表里 |
| `fun-asr-flash-2026-06-15` | ❌ transcriptions 404 / chat-audio 400（它是原生/异步接口专用）；偏偏是 `/models` 里排第一的"转写候选" |
| `qwen3-asr-flash-realtime` 等 `*-realtime` | ❌ 实时 WebSocket 专用，chat-audio 500 或空响应 |
| `qwen3.8-omni-flash`、`qwen-audio-3.0-asr-flash` 等 omni/audio | ⚠️ 能收音频，但返回的是"对音频的回答"而不是逐字听写 |
| `paraformer-*` / `sensevoice-*` | ❌ 非 OpenAI 兼容口，报 url error |

三条结论（都写进了代码与测试）：

1. **列表 ≠ 可调用**：`/models` 不含某个模型时不能判"名字写错"（`indexVoiceModels` 对实测可用的
   `qwen3-asr-flash` 只给 warn + "去自检"，不再劝用户换名字）。
2. **候选排序要按"本应用能不能驱动"排**：`asrRouteCompat()` 把实时/原生专用（`*-realtime`、
   `^fun-asr`、`paraformer`、`sensevoice`、`s2s`、`livetranslate`、`tts`）压到最后，omni/audio 类
   标成"能听但会聊天"，`qwen3-asr-flash` 系列置顶（`asrScore` 给 5）。
3. **失败提示要能落地**：两条路由都失败时，先判断是不是模型名不对，直接给出
   "把转写模型改成 `qwen3-asr-flash`"，而不是笼统地说"换个支持 ASR 的网关"。

> 换网关/换模型前**先点「🎙 自检语音识别」**：它用内置合成音频实测两条路由，是唯一权威结论；
> `/models` 索引只当参考。相关单测：`tests/voiceModelRanking.test.js`（假 fetch，不联网）。

## 7.4 行为触发（设置里的「行为 → 动作/表情」绑定）

设置页把 6 种行为（用户发消息 / 调用工具 / 执行命令 / 开始回答 / 待机搭话 / 出错）各绑一个
目标，值形如 `motion:<动作组>` / `expr:<表情>` / `emotion:<标签>` / `click` / `costume`。
三条铁律：

1. **映射必须随启动载入**（`init()` → `loadBehaviorTriggers`，模型挂载后还会按新模型再载一次）。
   曾经只在打开设置面板时（`populateSettings`）才赋值，于是"配好之后不打开设置 / 重启应用"时
   映射是空的，每个行为退回 `'auto'` 猜一个目标（多数是 `motion:Idle`，几乎看不出变化）——
   用户看到的就是"设置里配了，实际一点都不触发"。
2. **绑定按模型分桶**（`motionTriggersByModel[模型名]`，旧版全局 `motionTriggers` 只作回退）。
   不同模型的动作组/表情完全不同（模型 A 的某个表情在模型 B 上不存在），只存一份全局映射时
   换个模型绑定就全失效 —— 那也是"设置没被记住"的典型观感。保存时只更新当前模型这一桶。
3. **可绑定目标只认模型真实声明的动作组/表情**（`model3.json` 的 `Motions` / `Expressions`
   经引擎暴露，见 `live2d.ts` 的 `listMotions/listExpressions`）。模型的"能力归类"
   （`pet-model.json` 的 `capabilities`）只是**建议清单**，不等于可播放。
4. **解析不到目标不能静默**：`emitBehavior` 对"明确配了但当前模型没有"的绑定只 `console.warn`
   一次（附上该模型可用的动作组/表情清单），避免"完全没反应又查不出原因"。
5. **设置页的「模型」下拉必须显示当前模型**（`populateSettings` 里按 `settings.modelName` 设
   `select.value`；不设就会停在列表第一个，用户以为模型选择没保存）。
6. **动作组/表情下拉必须在模型挂载完成之后再刷新**。`mountManifest` 里 `currentHandle` 在
   挂载前还是 null，此时 `refreshMotionTriggerOptions()` 只能拿到空清单，已保存的绑定会被
   全部标成「（当前模型没有）」；而且挂载完成后没人再刷新 → 用户看到的就是"切回原模型仍然
   显示当前模型没有"。正确时机：`switchModel` 在 `await mountManifest(...)` 之后调
   `loadBehaviorTriggers`；启动路径在启动设置块里调 `applyBehaviorTriggersFromSettings`。
   回归测试：`tests/behaviorTriggers.test.js` 的第二条（切模型后标签不得残留）。

自查入口（桌宠窗口控制台）：`__petDebug.behaviors()` 看映射 + 模型可用清单 + 每个行为的解析结果；
`__petDebug.fireBehavior('user_message')` 立刻触发一次；`__petDebug.resolveTrigger('expr:眼镜')`
看某个值在当前模型上到底指什么。回归测试：`tests/behaviorTriggers.test.js`（假 DOM + 假 Live2D
handle 跑真实 `init()`，从推送通道一路断到 `setExpression`）。

## 7.5 交互反馈（点击/连点/长拖）、桌宠名字、窗口外视线追踪

**① 交互事件 → 语料**：渲染层在 `installWindowInteractions` 里识别三种交互，经新通道
`IPC_PET_EVENT`（`pet:event`，fire-and-forget）上报，主进程 `handleSceneGroup` 按分组冷却出气泡：

| 事件 | 判定 | 语料分组 | 组冷却 |
|---|---|---|---|
| `click` | 左键单击（未拖动、非 UI 区） | `点击宠物` | 10s |
| `multiClick` | 2.5s 窗口内第 6 次点击（"超过 5 次"） | `连续点击` | 20s |
| `dragLong` | 同一次拖动持续 >5s（越过 3px 拖拽阈值后才计时） | `拖动宠物` | 20s |

三条实现约定：
- 冷却用 `SCENE_GROUP_GAP_OVERRIDE_MS` 覆盖默认 25s；**交互反馈走 `pushBubble(..., {instant:true})`**，
  否则会被"任意两次气泡间隔 8s"节流吃掉（连点第 6 下通常就在单击气泡后 1~2s）。
- 分组名要同时登记进 `GROUP_SYNONYMS`（否则 docs §5 说的"触发键漂移"检查会认为没登记）。
- 语料写在 `personas/character.offline.txt` 的 `## 点击宠物 / ## 连续点击 / ## 拖动宠物` 小节；
  `tests/contracts.test.js` 会核对通道四处同步 + 这三个分组和语料小节都存在。

**② 桌宠名字**：设置项 `petName`（设置页第一行，≤24 字，留空 = 用模型名）。作用三处：
注入 AI system prompt（`chatClient.buildSystemPrompt` 的 nameLine，被问"你叫什么"以它为准）、
启动/切换模型时的问候语、聊天输入框 placeholder。改名保存后立即生效（不需要重启）。

> ⚠️ **新增设置项要补三处**，漏一处就是"能存进去、重启读不回来"（本项第一版就漏了第三处）：
> ① `contracts.ts` 的 `AppSettings`；② `ipc.ts` 的 `sanitizeSettings`（写入侧）；③
> **`chatClient.ts` 的 `loadAppSettings`（读取侧白名单，`getSettings()` 就返回它）**。
> 读取侧是显式列字段的，不加就永远读不回 —— 设置页输入框重开变空、AI 也不认名字，都是这个原因。

**③ 窗口外视线追踪**：视线目标有两条来源 —— 窗口内 `pointermove`，窗口外主进程推送的
`IPC_GLOBAL_CURSOR`。链路本身是通的，坑有两个：
1. **推送只在鼠标移动时发**：鼠标停在窗口外不动，渲染层 3s 后按 `GAZE_IDLE_MS` 判定"视线过期"
   回正 → 看起来就是"出了窗口就不追踪"。修法：主进程按 `CURSOR_HEARTBEAT_MS`(400ms) 心跳补推
   （`moved || now - lastCursorPushAt >= 心跳`）。
2. **幅度太小看不出**：原先半身取景增益 0.42、头部上限 12°，屏幕上只有约 5° 的转动，几乎看不出来
   （实测截图对比都不明显）。现在 `HEAD_TRACK_MAX_X/Y = 30/20`、半身增益 0.8（≈24°），
   并且**眼球按满量程驱动**（`gazeCX / framingGazeGain()` 再钳到 ±1）。
自查：`__petDebug.gaze()` 给出渲染层换算值（nx/ny/是否过期/收到多少次全局推送）和模型实际参数
（`ParamAngleX/Y`、`ParamEyeBallX/Y`），鼠标停在窗口外时应看到 `stale:false` 且参数非 0
（半身取景：AngleX≈±24°、EyeBallX≈±1）。

**④ 窗口拖动**：拖动靠窗口四周的 CSS `app-region: drag` 条带（`#drag-top/bottom/left/right`，
左/右 10px、上 12px、下 16px）。两个坑：
1. 设置面板 `inset: 10px` 几乎铺满窗口，只剩边缘一条能拖 → `.settings-header` 也做成拖动区
   （关闭按钮保持 `no-drag`），拖标题即可移动窗口。

## 7.6 四层系统提示词 + 情景提示词（AI 上下文架构）

**① 自带提示词库（随包）**：源文件在 `local-assets/prompts/*.md`，`npm run import` 会原样合并到
`public/assets/prompts/`，打包后是 `resources/assets/prompts/`。七个文件：

| 文件 | 层 | 内容 |
|---|---|---|
| `layer1-identity.md` | 第 1 层 | 身份与边界：桌宠定位、服务场景、硬规则（不碰系统目录/凭证、危险命令拒绝、不编造结果、隐私优先） |
| `layer2-tools.md` | 第 2 层 | 工具说明：一次只输出一个动作、不猜参数、失败如实说、信息不足先问 |
| `layer3-context.md` | 第 3 层 | 任务上下文的阅读约定（动态内容由代码填充） |
| `layer4-phase-{think,act,reflect}.md` | 第 4 层 | 思考 / 行动 / 反思三阶段指令，按思考轮循环切换 |
| `scenario-template.md` | — | 情景提示词文件的初始模板（写进用户数据目录） |

**行为准则对齐**（对照 Claude Code 等成熟 agent 提示词后补齐；`tests/promptLayers.test.js` 会校验这些关键词不丢）：
- 权限模式解释（第 2 层）：默认「每次询问」/「自动接受编辑」/「只读·计划」三种模式各自的确认行为，
  拒绝后不要原封不动重发同一动作，确认框 120s 超时会失败，`confirmTools`/`allowShell` 设置项的作用；
- 「先诊断再重试」（第 2 层）：失败先看错误（权限/路径/参数/命令输出/超时）定位原因再改，不要盲目重发；
- 「报告要忠实」（第 1 层 + 反思阶段）：没验证的步骤必须明说「没有验证」，不把没做/没验证说成已完成；
- 「产物与需求验证」（第 2 层 + 行动/反思阶段）：工具返回后回读文件、确认目录存在、看命令退出码，
  再与用户原始要求逐条对照（数量/命名/位置/格式/行为），验证不了就说明。

加载/拼接在 `src/main/ai/promptLayers.ts`（**不 import electron**，路径由调用方传入，便于单测）：
`loadPromptLibrary(dir)` 逐文件读取、缺失时回退内置兜底；`assembleSystemPrompt()` 固定拼三层；
`buildPhaseInstruction()` 生成第 4 层；`buildRoundSystemPrompt()` 合成整轮 system。
主进程在 `bootstrap` 里创建 `promptLibrary` 并 `chat.setPromptLibrary()`。

**② 思考轮循环（状态机，不是 while(true)）**：`chatClient.startChatWithTools` 里维护
`phase: 'think' | 'act' | 'reflect'`，每轮请求前把第 4 层指令拼到 system 末尾（`messages[0]` 每轮重建）：

```
行动 → 执行 → 反思（按需）→ 思考 → 行动 …
```

反思**不是每轮都做**，只在四个时机触发（`nextPhase`）：
工具执行失败（结果以"工具执行失败/错误"开头、或 exit code 非 0）、连续两轮 thought 高度相似
（字符二元组重合 ≥0.8，说明卡住）、完成子目标（本轮调了 `plan_update`/`plan_propose`）、
轮数过半（只校准一次）。其余顺利步骤直接从 observation 进下一轮思考，省 token 也省延迟。
首轮不强制"先思考不调工具"，保持普通闲聊的响应速度。

**③ 情景提示词（只在本机用户数据目录）**：`src/main/ai/scenario.ts` 维护
`<userData>/prompts/scenario-prompt.md`（首次启动自动创建，带模板头）。记录三类：
- `screen`：活动窗口监测（`WindowMonitor.onInfo`，应用名 + 标题 + 是否全屏；同一窗口 3 分钟内不重复记）；
- `action`：AI 每次工具调用 + 结果摘要（`chatClient` 执行完工具后 `recordAction`）；
- `event`：场景切换、桌宠互动事件（单击/连点/长拖）。

注入（第 3 层）用**时间衰减**：`weight = 0.5^(age/半衰期)`，默认半衰期 30 分钟；`injectText()` 按
新→旧排序、标注当前权重（两位小数）、低于 0.05 的丢弃、超出字符预算（默认 1000 字）的旧记录截断。
所以模型看到的是"用户最近在做什么"的加权摘要，不会把历史全塞进 system prompt，也不会被旧记录带偏。

隐私与安全：
- 情景提示词**只写 userData**；`ScenarioContext` 有 `mustBeUnder` 护栏，路径越界拒绝写入（只告警不崩）。
- 记录前统一清洗 `sanitizeScenarioText`：折叠控制字符/换行、脱敏 `sk-…`/`Bearer …`/`api_key=…`/长 hex、单条限长。
- `scripts/check-privacy.js` 把 `scenario-prompt.md` 加入**禁止进包文件名**：万一被误放进 `public/` 直接构建失败。
- 自带提示词库本身不含任何个人信息（`tests/promptLayers.test.js` 会扫密钥/本机路径/邮箱）。
- 开发版与打包版用同一套代码：提示词库随包读 `assets/prompts`，情景记录只在 userData；仓库里不落任何用户数据。

自检：`__petDebug` 之外可直接看日志 `[main] 系统提示词库：随包四层提示词；情景提示词：<路径>`；
设 `PET_LOG_PROMPT=1` 启动后，每次组装 system prompt 会打印
`[chat] 系统提示词：<字数>（第 1~3 层）| 情景提示词：<字数或"暂无记录"> | 第 4 层阶段指令按轮注入`。
`tests/promptLayers.test.js` 与 `tests/scenario.test.js` 覆盖层拼接、阶段指令、衰减权重、预算截断、去重与隐私清洗。

## 7.7 MCP 外部工具接入（可选，默认关闭）

让桌宠接入本机/远程的 MCP（Model Context Protocol）服务，把外部工具加进现有 AI 工具循环
（"行动 → 执行 → 反思"不改）。**没有 `mcp.json` 时完全跳过：不 spawn 进程、不联网、工具数不变、提示词不变。**

**配置**：`<userData>/mcp.json`（只在本机用户数据目录，绝不进安装包；`scripts/check-privacy.js` 已把它列为禁止进包文件名）

```json
{
  "servers": [
    { "serverName": "local", "transport": "stdio", "command": "node", "args": ["server.js"],
      "cwd": "C:\\tools\\my-mcp", "env": { "API_TOKEN": "${env:MY_TOKEN}" },
      "toolCallTimeoutMs": 60000, "autoApprove": false },
    { "serverName": "web", "transport": "http", "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer ${env:MCP_TOKEN}" } }
  ]
}
```

字段：`serverName`（1~32 位字母/数字/_/-，唯一）、`transport`（`stdio`|`http`）；
stdio 用 `command/args/cwd/env`，http 用 `url/headers`；`toolCallTimeoutMs` 默认 60000；
`autoApprove: true` 表示该服务器的调用免确认（默认 false = 每次都弹确认）。`${env:NAME}` 会替换成进程环境变量。
改动配置后**重启应用**生效（不做热加载）。

**工具命名与调用**：工具以 `mcp__<serverName>__<原始工具名>` 出现（超长/冲突追加 8 位哈希）；
发给 MCP 的始终是原始工具名，公开名不会回传给服务端。单个服务器最多 60 个工具、总数最多 120 个，超出的丢弃。

**确认与权限**：MCP 调用默认逐次弹确认（显示 server/工具/参数摘要）；`autoApprove` 的服务器跳过确认；
「只读/计划」权限模式下 MCP 调用直接拒绝。`MCP 工具返回错误：…` 会作为失败结果交给模型反思，不假装成功。

**实现与限制**（`src/main/ai/mcpClient.ts`，不引入新依赖，手写最小 JSON-RPC）：
- 只实现 `initialize` / `tools/list`（含分页）/ `tools/call` 与 `tools/list_changed` 通知；
- 只支持 `stdio` 与 `streamable-http`（含自定义 headers 与 `Mcp-Session-Id`）；不支持旧 SSE 双向、OAuth、资源订阅；
- 启动后台连接不阻塞主进程；连接失败只标记该服务器（工具不出现），其他服务器和现有功能不受影响；
- 调用失败会重连一次后重试；退出时 `dispose()` 杀掉 stdio 子进程（`taskkill /T`）；
- stdio 子进程环境先清洗（剔除名字含 KEY/PASSWORD/SECRET/TOKEN 的变量）再合并 `env`，日志不打印 env/headers 内容。

自检：聊天里发 `/mcp` 查看各服务器连接状态、工具数与**具体工具名**；`/mcp reload` 无需重启即可
重新读取 `mcp.json` / `mcp-server.json`（改配置、换端口、开关服务端都走它）。无配置时返回提示与配置路径。
`tests/mcpClient.test.js` 覆盖配置校验、命名映射、结果格式化、env 清洗与 stdio/http 端到端。

**反方向：桌宠作为 MCP 服务端（可选，默认关闭）**
`src/main/ai/mcpServer.ts` 把桌宠能力暴露成本机 MCP 服务，供 DSH / QQ bridge / 其它 agent 远程驱动。
**在设置页「MCP 与自主任务」里勾选「开启反向接入」并保存即可**（默认关闭）：开关/端口/token 存进 `settings.json`，token 留空时首次启动自动生成并回写；旧 `<userData>/mcp-server.json` 仅作无设置页驱动的回退。



外部客户端按标准 MCP streamable-http 连 `http://127.0.0.1:<port>/mcp`，请求头
`Authorization: Bearer <token>`（token 在 mcp-server.json 里）。只绑定 127.0.0.1、仅 POST /mcp、
无鉴权直接 401；端口被占用会向后找 1~19 个空闲端口并回写配置。工具：

| 工具 | 用途 | 只读 |
|---|---|---|
| `pet_say` | 让桌宠气泡说话（远程提醒/播报） | 否 |
| `pet_status` | 模型/桌宠名/活动窗口/待办数/MCP 连接情况 | 是 |
| `pet_emotion` | 切换表情（空串恢复默认） | 否 |
| `pet_motion` | 播放动作（Idle / wave） | 否 |
| `pet_todo_add` / `pet_todo_list` | 待办笔记本增/查 | 否 / 是 |
| `pet_note_add` | 往笔记里记一条 | 否 |
| `pet_reminder_add` | 加一次性提醒（afterMinutes 分钟后） | 否 |
| `pet_chat` | 让桌宠 AI 回一句话（外部桥接；3 秒最小间隔、单飞，避免频繁烧模型额度） | 否 |
| `pet_ask` | 通过桌宠向用户提问并等待回答（120 秒超时，选项 2~4 个） | 否 |
| `pet_screenshot` | 全屏截图（PNG base64 + 保存路径，存 userData/shots） | 否 |

只读资源（MCP `resources/list` + `resources/read`，文本）：`pet://status`、`pet://todos`、`pet://scenario`、`pet://skills`。
客户端不支持 resources 时不影响 tools；未知 uri 返回 JSON-RPC 错误。

启用后设置页与 `/mcp` 会同时显示「外部工具连接」与「本机 MCP 服务端」两段状态（含可用工具名/地址/token 提示）；
外部 agent 调用桌宠工具会写进情景提示词（`外部自动化：…`），本地 AI 能感知到"刚才被远程操作过"。
`tests/mcpServer.test.js` 覆盖配置回退、token 鉴权、initialize/tools/list/tools/call、热重载与错误分支。

**接入示例**
- DSH（作为 MCP 客户端连桌宠，放到 DSH 的插件配置里）：

  ```yaml
  - id: pet-mcp
    name: '@deepseek-ai/dsh-mcp-client'
    config:
      serverName: pet
      transport: streamable-http
      url: http://127.0.0.1:37653/mcp
      headers:
        Authorization: !!js '`Bearer ${process.env.PET_MCP_TOKEN}`'
  ```

- 桌宠连 QQ bridge 提供的 MCP server（stdio；先在该目录 `npm install` 好它自己的依赖）：

  ```json
  {
    "servers": [
      { "serverName": "qq-bridge", "transport": "stdio", "command": "node",
        "args": ["C:\\tools\\qq-bridge-plus-main\\src\\mcp-host-server.js"] }
    ]
  }
  ```

  连接成功后对 AI 说"看看 QQ 网关状态"它就能调用对应工具；默认每次调用都会弹确认，
  确认信任该服务后再在该 server 配置里加 `"autoApprove": true`。

## 7.8 定时 / 后台自主任务（可选，默认关闭）

设置页「MCP 与自主任务」里开启；规则在 `src/main/ai/autonomy.ts`（纯函数、可单测）：

- **频率**：每分钟检查一次是否到点；间隔 5~240 分钟、每日上限 1~200 次（默认 30 分钟 / 20 次），跨天自动清零；
  计数与上次运行时间存 `<userData>/autonomy-state.json`。
- **避让**：AI 正在回复、有等待回答的确认框、上一次还没跑完时一律跳过；刚启动不会立刻跑。
- **模式**：`mcp_check`（默认，纯本地检查两个方向状态，只在异常时提醒，不调 AI）；`scene_brief`（把活动窗口/待办/MCP
  状态作为上下文，静默 ChatClient 让模型说一句 ≤40 字，回复"无需提醒"就安静）；`custom`（用设置里的提示词做同样一次静默提问）。
- **结果**：气泡显示 12 秒 + 写入情景提示词（`自主任务（模式）：…`）；「立即运行一次」跳过间隔与每日上限，但不打断正在进行的对话。
- **后台只读 MCP 工具**（设置页勾选「自主任务可调用只读 MCP 工具」，默认关闭）：
  - 只允许 **服务器配置了 `autoApprove: true` 且工具声明 `annotations.readOnlyHint: true`** 的 MCP 工具（策略在 `mcpClient.isAutoApprovedReadOnly`，一处判断）；
  - 后台不弹确认；每次自主任务最多 6 次工具调用、同一工具+参数最多 2 次（防死循环，参考 DSH 的有界工具循环与重复调用保护）；
  - 未勾选/无允许工具时，静默 ChatClient 保持"无工具"原行为，提示词也不追加工具清单；
  - 工具调用写进情景提示词（`自主任务调用工具：…`）。
- **事件触发**（设置页同一区域，默认关闭）：
  - `事件触发` 开关 + `匹配串`（活动窗口的**应用名或标题包含**即命中，不区分大小写；留空不启用窗口触发）+ `冷却（分钟）`（5~120，默认 15）；
  - 命中后跑一次与定时任务相同的模式；**与定时任务共用每日上限**、同样避让"AI 正在回复/有确认框/上一次没跑完"；
  - **提醒到点**也算事件触发（不需要匹配串）：开关开启时，到点气泡 + 跑一次自主任务；
  - 错过的定时点不补跑（只按当前时间判断），事件冷却独立于定时间隔。

## 7.9 窗口层级（置顶优先级）

所有窗口都 `alwaysOnTop`（高于电脑上其他应用），彼此间由 `restackOwnWindows()` 定顺序（从高到低）：

1. 设置面板及其展开内容（设置面板在桌宠主窗里 → 设置打开时主窗提到最上；系统文件夹选择框是原生模态，天然最高）
2. 思考 / 回答浮窗
3. 对话气泡窗
4. 桌宠模型主窗

实现要点：`renderer` 打开/收起设置时经 `ui:settingsPanelOpen` 通知主进程；任一窗口显示/获得焦点后重排（`setAlwaysOnTop(true) + moveTop()`），
避免"设了 alwaysOnTop 但同层级窗口互相盖住/气泡窗掉到普通窗口层"。

## 7.10 工具目录与循环卫生（架构）

参考 Claude Code / deepseek-harness 的工具体系与 qq-bridge 的分组限制、LocationSpoofer 的模块分层：

- **工具目录外置**：44 个模型可见工具定义从 `chatClient.ts` 抽到 `src/main/ai/tools/catalog/`，
  按领域拆文件（system / workspace / dev / web / media / schedule / mail / life / pet / agent），
  `all.ts` 负责按**拆分前完全一致**的顺序组装，`index.ts` 只做出口；
  `chatClient` 仍导出同一个 `TOOL_DEFS`（老引用不破）。名称/顺序属行为的一部分，`tests/toolCatalog.test.js` 有快照。
  为什么顺序重要：工具清单顺序会进入提示词与 API tools 数组，改顺序会无谓地影响模型选择与缓存前缀。
- **重复工具调用守卫**（`src/main/ai/toolLoopGuard.ts`，参考 DSH repeat-tool-guard）：
  对「工具名 + 规范化参数（对象按 key 排序）」统计**连续**相同调用；第 3 次追加简短提醒、第 5 次追加含工具名/参数预览的详细提醒，
  **只提醒、不阻断**；换一个调用即重置；超过阈值不再重复打扰。接入函数调用与文本协议两条工具循环，提醒随工具结果一起回到模型。
  为什么是"建议性"：合法场景可能真要重复检查（轮询/重读变化中的文件），阻断会惩罚正确行为。

后续架构项（未做，需单独确认）：把工具**执行器**从 `mainImpl.js` 按领域抽到 `tools/exec/`；`mainImpl.js` 按
窗口/IPC/托盘/自启动拆模块；`chatClient` 的 phase 循环抽成 `agentLoop.ts` 并加老对话压缩；事件总线/审计日志；下次到期调度器（orb 思路）。

## 7.11 远程访问 / WebSocket / 手机 MCP 桥接（PC 端）

- **局域网开关**：设置页「允许局域网访问」（`mcpServerLanEnabled`，默认关闭）；关闭时只监听 127.0.0.1，开启时监听 0.0.0.0 并要求 Bearer token（明文 HTTP，仅可信网络；防火墙需放行端口）。
- **双通道**：HTTP `POST /mcp`（既有）与 WebSocket `/ws`。手机/浏览器 WS 无法自定义 Authorization 头，token 走 query，服务端用 timingSafeEqual 校验；最小 RFC6455 实现（握手/mask/分片合并/ping-pong/close），与 HTTP 共用同一 JSON-RPC dispatch。
- **手机原生工具桥**（VCPToolBox 异步插件 + qq-bridge host bridge 思路）：
  - 手机调 `phone/register` 上报工具（名称白名单校验，最多 32 个）；
  - PC 端 `tools/list` 动态合并为 `phone_<name>`，schema/annotations 均来自手机上报，不硬编码；
  - PC 端调用 `phone_*` → 手机 `phone/poll` 长轮询取任务 → 执行 → `phone/result` 回执 → 调用方拿到结果；默认 30s 超时返回 isError（fail-closed），dispose 清理 pending/等待者；
  - 手机工具数量/可用列表进入启动日志与 `/mcp` 状态文本。
- **Android 客户端**：`android-mcp-client/`（Kotlin + Compose，WS 优先、HTTP 回退；工具列表运行时拉取；每调用带超时与错误提示；危险工具二次确认；手机原生能力注册）。构建需 JDK 17 + Android SDK 35，本仓库开发机未装，APK 需在 Android Studio 构建。

## 7.12 自主任务思考回看（对话信息）

- 自主任务调用 AI 的模式（scene_brief / custom）会记录**最近一次**运行的：时间、触发来源（定时/手动/事件）、提示词、思考过程（推理增量 + 工具步骤）、回复；
- 记录存 `%APPDATA%\pet-desktop-app\autotask-last-round.json`（仅本机，不进安装包），并可在聊天窗口的「💬 对话信息」里看到（打开聊天窗口时自动追加，不写入 chat-log.json，避免每 5 分钟污染用户对话历史）；
- 设置页自主任务区域有「查看上次思考」按钮：打开对话信息，最后一条即自主任务的提示词/思考/回复；
- 模型未返回推理内容时显示「（本次模型没有返回思考内容）」，回复照常显示。

## 8. 自检命令

```bash
node scripts/check-model.js "<模型文件夹>"   # 模型能不能渲染
npm run build:all                            # 类型 + 装配
npm test                                     # 类型 + 装配 + 单测（IPC 契约 / 声纹 / 语音状态机 / 取景落位 / 转写模型 / 行为触发）
npm run check:privacy --all                  # 打包前后密钥/隐私闸门
```

> `npm test` 里带着 `assemble`：`public/renderer/**` 是打包真正吃进去的那份渲染层，
> 曾经出现过"源码改了但没 assemble → 测试跑旧产物、打出来的包也是旧代码"的坑，
> 所以测试入口顺手把它刷新，别把它挪出去。

项目内置校验范围见上面的命令；窗口交互、渲染和权限提示仍需在 Windows 目标环境中手动确认。

## 9. 已知未做 / 待实机确认

- **渲染质量（毛边）**：根因与修复见 §6（`lod: 'single-auto'` + `premultipliedAlpha:false` +
  关阴影）。修复已在代码与产物中，但**缺实机确认**——用 `PET_GPU_AUDIT=1` 看
  `moc3.textureLod` 的 `effective` 是否小于 `source`，或直接目视。
- **动画状态机**：待机/移动/被拖/点击/睡觉/随机行为目前是散落的即时逻辑，没有显式状态机。
  重构需要看着动画调状态切换，属"没有运行环境不该盲改"的部分。
- **双击**：需求未定义双击该做什么，未实现（随意绑定有干扰单击的风险）。
- **序列帧动画**：当前模型集是 Live2D + 立绘，无序列帧素材来源。
- **语音状态条的窗口长高**：位置契约见 §7.2，逻辑已由 `tests/voiceInput.test.js`（假 DOM 驱动
  真实渲染层状态机）与 `tests/contracts.test.js`（高度跨进程一致）覆盖，但"窗口真的向上长高一条、
  气泡在屏幕上不动"仍建议用 `PET_OPEN_CHAT=1 PET_VOICELAB_TEST=1 PET_SHOT_DIR=<目录>` 目视一次。
- **内容锚点取景**：落位规则已抽成纯函数并单测（`tests/live2dPlacement.test.js`），但"用错帧
  量出来的锚点"只有真机跑模型才会出现，建议用 `PET_FRAMING=half/full` + `PET_BOOT_TIMING=1`
  看 `[live2d] 内容锚点` / `内容锚点复核不通过` 两条日志。

## 10. 验证边界

自动化检查覆盖类型、IPC 契约、语音状态机（假 DOM 驱动真实渲染层）、取景落位纯函数、开发工具
和隐私边界；Live2D 渲染质量、窗口交互、托盘、快捷键与系统权限仍需在 Windows 目标环境中手动确认
（本条与 §9 的"待实机确认"是同一件事的两处提示）。
