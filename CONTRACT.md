# Pet 跨模块契约

本文件只记录**运行时边界**与**改代码时必须同步的位置**。IPC 通道名与数据类型的完整清单以
`src/shared/contracts.ts` 为唯一来源，此处不重复维护（重复的清单必然过期）。

## 唯一源

- `src/shared/contracts.ts` 定义全部 IPC 通道常量、`ElectronAPI` 接口与共享类型。
- `src/preload/preload.ts` 只通过 `contextBridge` 暴露 `window.electron`（`ElectronAPI`）；
  通道名一律 import 自 contracts，不写字面量。
- 渲染层只能访问 `window.electron`，拿不到 `ipcRenderer`、Node 或文件系统。
- 主窗口、对话气泡窗（`?panel=chat`）、思考浮窗（`?panel=think`）共用同一套 preload 契约。
- 浮窗的**尺寸归主进程**：折叠态、＋ 菜单高度、语音状态条那一条，都由渲染层经 IPC 请求后
  由主进程 `setBounds`（气泡窗"底边钉住"改高，气泡在屏幕上不动）。渲染层的 CSS 高度必须与
  主进程的高度常量一致，否则气泡会被裁掉或多出一条空白。

改 IPC、资源路径或插件 API 时，必须同步检查四处：`contracts.ts`、preload、主进程、渲染层。

## 安全边界

窗口统一使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: false`
（preload 需要 `contextBridge`，故不开 sandbox）。

模型资源由主进程内的本地 HTTP 服务提供，渲染层只拿 URL，不读文件系统。API Key 只在主进程读取。

开发辅助工具只接受配置工作区内的路径，并受文件大小、命令与权限模式限制；写文件、编辑文件与
执行命令按设置要求确认。危险命令（删除系统目录、提权等）始终拦截。

**浏览器权限走最小授权白名单**：主进程在开窗之前给 `session.defaultSession` 装 request + check
处理器，只放行"纯音频输入"（语音转写要用），摄像头、通知、定位、剪贴板读取、HID/串口等一律拒绝
并留日志。这只是应用内的第二道门，**不替代操作系统的隐私开关**。

## 资源路径

| 环境 | assets | renderer |
| --- | --- | --- |
| 开发 | `public/assets` | `public/renderer` |
| 打包 | `resources/assets` | `resources/renderer` |

`PathResolver` 按打包状态与目录存在性选择资源根，不依赖环境变量。渲染页加载顺序：
静态服务根下 `renderer/index.html`（开发 `public/`、打包 `resources/`）→ 根下 `index.html` →
asar 内 `renderer/index.html` → asar 内 `public/renderer/index.html` → `dist/renderer/index.html`。
`dist/renderer/` 因此是**故意的兜底副本**，不是冗余产物。

## 生成物与命令

| 生成物 | 生成者 | 命令 |
| --- | --- | --- |
| `public/assets/**` | `scripts/import-model.js`（`local-assets/` + `personas/` 合并） | `npm run import` |
| `public/renderer/**` + `dist/renderer/` 兜底 | `scripts/assemble-renderer.js` | `npm run assemble` |
| `dist/**` | `tsc`（含 `allowJs` 编译的 `mainImpl.js`/`devDebug.js`） | `npm run build:tsc` |
| `release/**` | `electron-builder` | `npm run build` |

## 插件

插件放在用户数据目录的插件文件夹，附 `pet-plugin.json`（`name`、`version`、相对 `entry`）。
入口是 CommonJS 模块，导出 `default` 或 `plugin`，并提供 `setup(ctx)`。

`entry` 只接受用户数据目录内的相对路径，拒绝 `http:`/`data:`/`file:` 与越界路径。
插件在受限注册表中运行，接收 `start`、`tick`、`windowChange`、`userInput` 事件；
插件能力**不等于**应用的文件系统或命令权限。

## VTube Studio（可选后端）

桌宠自己的 Live2D 渲染是**主后端**；VTS 只是可选的第二后端（设置里启用才连，默认关闭）。
边界：

- 主进程 `src/main/vts/vtsService.ts` 持有唯一 `VtsClient`（`src/main/vts/vtsClient.ts`），
  连接/授权失败只写 `lastError`，**不阻塞应用启动**，也不在启动阶段弹 VTS 授权窗
  （只有设置页「授权」会走 `AuthenticationTokenRequest`）。
- 只能注入 VTS 的**追踪参数**（`FaceAngleX`/`EyeLeftX`/`MouthOpen` …），由 VTS 映射到模型参数；
  直接注入 `ParamAngleX` 这类模型参数会被 VTS 以 #453 拒绝。
- 视线注入走 `IPC_VTS_TRACKING`（renderer→main，`ipcMain.on`，约 30fps，fire-and-forget）；
  未连接/未授权时主进程静默丢弃，不抛回渲染层。
- 热键列表用 `HotkeysInCurrentModelRequest`（VTS 1.35 实测；`HotkeyListRequest` 会被拒 #7）。
- **反向同步（VTS → 桌宠）**：授权成功后主进程用 `EventSubscriptionRequest` 订阅
  `HotkeyTriggeredEvent`（热键触发，含用户在 VTS UI 里手动触发和我们按钮经 API 触发）与
  `ModelLoadedEvent`（换模型）。VTS 推来的事件经 `IPC_VTS_EVENT_PUSH`（main→renderer，
  `vts:eventPush`）交给渲染层 `onVtsEvent` → `applyVtsEvent`：
  热键名先按同名**表情** `setExpression(name)`，没有再按同名**动作组** `playMotion(name)`，
  都没有就忽略并记日志（不弹窗、不报错）。**这条方向只改本地模型，绝不回写 VTS**，
  否则热键事件会在 VTS ↔ 桌宠之间回环触发。VTS 断线会清空该插件的订阅，所以每次
  连接/授权成功后都重新订阅一次；订阅失败只记 warn，不影响连接与注入。
- 热键事件的载荷字段（VTS 原样）：`hotkeyID` / `hotkeyName` / `hotkeyAction` /
  `hotkeyTriggeredByAPI` / `modelID` / `modelName`；事件消息通常**没有 requestID**，
  VtsClient 在"无主消息"判断之前解析，不能因为拿不到 pending 就丢掉。
- 语音由主进程用 Edge TTS 合成后经 `IPC_TTS_AUDIO` 推给渲染层 `new Audio(...).play()`；
  主进程在 app ready 前 `appendSwitch('autoplay-policy', 'no-user-gesture-required')`，
  否则渲染层没有用户手势时播放会被拒。说话期间主进程顺带向 VTS 注入 `MouthOpen`
  （`onVtsMouth`；与本地口型是两条独立链路，保持不变）。
- **本地 TTS 口型**：渲染层 `src/renderer/ttsMouth.ts`（全局脚本 `window.PetTtsMouth`，
  `index.html` 里先于 `renderer.js` 加载）在 `playTtsAudio` 播放期间每 90~120ms 用
  随机 `openY`（0.15~0.75，TTL 150ms）驱动当前 handle：有 `applySpeech` 走语音层，
  没有则退回 `applyTrackingFrame({ mouth: { openY } })`；音频 `ended`/`error`/`pause`
  时停止并归零。

## 对话朗读（Edge TTS）

- 设置项：`AppSettings.ttsEnabled`（默认关）与 `ttsVoice`（Edge 音色短名，空=默认
  `zh-CN-XiaoxiaoNeural`）。写入侧 `sanitizeSettings`、读取侧 `loadAppSettings`、契约
  `contracts.ts`、设置页 UI 四处必须同步（漏读取侧会"保存后重启丢失"）。
- 请求：渲染层每次朗读生成 `requestId`，经 `ttsSpeak(text, voice, requestId)` →
  `IPC_TTS_SPEAK`；主进程合成后把音频与同一个 `requestId` 经 `IPC_TTS_AUDIO` 推回。
- 渲染层**只播放 `requestId` 等于最新一次请求的音频**（旧请求晚到的结果直接丢弃）；
  关闭朗读时会作废在途请求，关掉后不会再出声。
- 文本上限：主进程 `edgeTts.MAX_TEXT_CHARS`（2000 字）；渲染层按同一上限截断后再请求，
  两边常量必须一致（`tests/assetIntegrity.test.js` 有断言）。
- 音色列表：`IPC_TTS_VOICES`（invoke）由主进程 `edgeTts.listVoices()` 联网拉取，返回
  `{ok, voices:[{shortName,locale,gender,friendlyName}]}`；设置页「↻ 拉取全部音色」按钮触发。
  内置候选在 `index.html`（>=20 个，不联网可用），拉取失败时保留内置候选。
- 合成失败不抛异常：`ttsService.speak()` 返回 `ok:false + error`，渲染层写设置页状态行。

## 行为触发（设置 → 行为触发）

- 行为键与中文名以 `contracts.ts` 的 `BEHAVIOR_KEYS` / `BEHAVIOR_LABELS` 为唯一来源：
  `user_message`、`tool_call`、`command_exec`、`ai_start`、`model_idle`、`error`、
  `click`（点击一次）、`multiClick`（连点 5 次）、`drag`（拖动结束）、`mcp`（任意 MCP 工具被调用）。
- 每个行为可绑一个动作组/表情；另可再选一个「附加目标」——动作组或表情都可
  （`AppSettings.motionTriggerExpressions[模型][行为]`，编码 `motion:`/`expr:`；旧版裸表情名按表情兼容），
  并用每行的按钮选择播放方式：`simultaneous`（同时，默认）或 `chain`（衔接，主目标之后播放，
  `motionTriggerPairModes[模型][行为]`）。
- 事件来源：聊天/工具/命令/回答/待机/出错由主进程经 `IPC_ACTION {type:'behavior'}` 下发；
  点击/连点/拖动由渲染层本地 `emitBehavior`；MCP 由 `mcpServer` 在 `tools/call` 回调
  `deps.onToolCall` → 主进程转发 `behavior: mcp`。
- 绑定按模型分桶（`motionTriggersByModel` / `motionTriggerExpressionsByModel`），
  旧版全局字段只作回退；目标在当前模型上不存在时插件只 warn 一次、绝不硬播。

## 第三方资源授权

模型、角色资料、Live2D 运行库等第三方资源的授权**不由 MIT 覆盖**；发布前须逐项核验来源、
许可与再分发条件。项目代码版权主体见根目录 `LICENSE`。
