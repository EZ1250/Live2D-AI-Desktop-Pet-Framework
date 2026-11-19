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
  内置候选在 `index.html`，**只列 Edge 实际支持的音色**（Azure 专属音色会让 Edge 直接关流，
  报 `Stream closed before the synthesis completed`），拉取失败时保留内置候选。
- 音色兼容回退：合成时若报「音色不被 Edge 支持」类错误，主进程自动改用默认音色
  （`zh-CN-XiaoxiaoNeural`）重试一次；成功时结果带 `fallbackFrom`，设置页提示「该音色不可用，
  已自动改用默认音色」。非音色类错误（网络等）不回退，直接按失败返回。
- 合成失败不抛异常：`ttsService.speak()` 返回 `ok:false + error`，渲染层写设置页状态行。

## 行为触发（设置 → 行为触发）

- 行为键与中文名以 `contracts.ts` 的 `BEHAVIOR_KEYS` / `BEHAVIOR_LABELS` 为唯一来源：
  `startup`、`user_message`、`tool_call`、`command_exec`、`ai_start`、`model_idle`、`error`、
  `click`（点击一次）、`multiClick`（连点 5 次）、`drag`（拖动结束）、`mcp`（任意 MCP 工具被调用）。
- 每个行为可绑一个动作组/表情；另可再选一个「附加目标」——动作组或表情都可
  （`AppSettings.motionTriggerExpressions[模型][行为]`，编码 `motion:`/`expr:`；旧版裸表情名按表情兼容），
  并用每行的按钮选择播放方式：`simultaneous`（同时，默认）或 `chain`（衔接，主目标之后播放，
  `motionTriggerPairModes[模型][行为]`）。
- 事件来源：聊天/工具/命令/回答/待机/出错由主进程经 `IPC_ACTION {type:'behavior'}` 下发；
  点击/连点/拖动由渲染层本地 `emitBehavior`；启动由渲染层在模型挂载完成后
  `fireStartupBehavior` 触发一次（重启才会再触发）；MCP 由 `mcpServer` 在 `tools/call` 回调
  `deps.onToolCall` → 主进程转发 `behavior: mcp`。
- 绑定按模型分桶（`motionTriggersByModel` / `motionTriggerExpressionsByModel`），
  旧版全局字段只作回退；目标在当前模型上不存在时插件只 warn 一次、绝不硬播。

## 更新检测（GitHub Release）

- 启动后**异步检查一次** GitHub 最新 Release（`src/main/updateCheck.ts`）：先请求
  `api.github.com/repos/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/latest`（带 `User-Agent`、
  8s 超时；API 不可用时兜底 `github.com/.../releases/latest` 的 302 地址解析 tag），
  与 `app.getVersion()` 做 semver 比较（去 `v` 前缀、预发布视为小于正式版、忽略 `+build`）。
- 三种通道（契约常量在 `contracts.ts`）：
  - `IPC_UPDATE_STATUS_GET`（`update:status:get`，invoke）→ `UpdateSnapshot`：**不联网**，
    返回主进程缓存的最近一次检查结果（启动检查可能先于渲染层订阅完成，渲染层启动时靠它补拉）。
  - `IPC_UPDATE_CHECK`（`update:check`，invoke）→ `UpdateSnapshot`：手动检查，**会联网**，
    忽略"启动时自动检查"开关。
  - `IPC_UPDATE_STATUS`（`update:status`，main→renderer 推送）→ `UpdateSnapshot`：每次检查完成后推送。
- `UpdateState` 是判别联合：`idle` / `checking` / `no-update`（带 `checkedAt`、`source`）/
  `update-available`（带 `ReleaseInfo`：`version`、`tagName`、`name`、`htmlUrl`、`publishedAt`、`body`）/
  `error`（`reason`：`offline`/`timeout`/`rate-limited`/`http-error`/`parse-error`/`unknown`）/
  `disabled`（设置里关掉了启动检查）。
- 关闭/失败策略：离线、超时、GitHub 限流、HTTP 错误、解析失败、版本号非法 → **静默**，不弹窗、
  不重试风暴，只在设置页「🔄 更新」区显示原因；用户点「立即检查」才再次联网。
- 跳转：只信任 `https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/` 前缀的链接
  （主进程 `isTrustedReleaseUrl` + 渲染层 `isTrustedGithubReleaseUrl` 双重校验），
  通过 `IPC_OPEN_EXTERNAL` 用系统浏览器打开（该通道只放行 http/https）。**不下载、不安装**。
- 入口：**只有设置页一个入口**——「设置 → ⭐ 您的 Star 就是我更新的动力（展开）」里的更新区
  （当前版本、检查状态、上次检查时间、「启动时自动检查更新」开关、立即检查、发现新版本时的「前往下载」）。
  不弹窗、不占托盘菜单、不加右键菜单项；原「📦 拿最新版」按钮由更新区替代。
- 设置项：`AppSettings.checkForUpdates`（默认 `true`；`false` 时启动不自动检查，手动检查仍可用）。
- 调试：`PET_UPDATE_FAKE_LATEST=<版本>` 可伪造远端版本（仅开发态肉眼验证"有更新"UI，不参与打包逻辑）。

## AI 接入方式（API / 桥接 DSH）

- `AppSettings.aiMode`（`'api' | 'dsh'`，默认 `api`）二选一，设置页单选切换；选中一种时另一种配置区自动收起。
  - `api`：直连 OpenAI 兼容 API（原有行为；支持工具/截图/思考等完整能力）。
  - `dsh`：**桥接本机 DSH**（`dsh --profile headless --json [--session-id <id>] -`）。
    按用户要求**只转对话**：只把用户文字经 stdin 发给 DSH、只取 `final`/`text` 事件的文本作为回复；
    不向 DSH 传宠物工具、不传截图、不解析其工具事件。实现见 `src/main/ai/dshBridge.ts`。
- DSH 桥接细节：
  - 工作目录固定为 `<userData>/dsh-bridge`（**不放 AGENTS.md**；避免 headless 把桌宠项目当工作区去读规则/动文件），
    并设 `DSH_PERMISSION_MODE=workspace-write`（只允许写 bridge 目录内，AI 才能生成文件回发给用户；
    其它副作用仍受 DSH 自身审批策略限制）；每次对话一个子进程，串行排队，超时 120s，
    取消/退出/新对话会杀进程树（Windows `taskkill /T /F`）。
  - 会话续接：首次从 `session` 事件拿 `sessionId` 存到 `<userData>/dsh-bridge/session.json`，后续消息带
    `--session-id`；「新对话/重置上下文」或设置页「重置 DSH 会话」会清空它。
  - 失败可读：未安装（找不到 dsh）→「未检测到 dsh 命令」；超时 →「DSH 超时（Ns）」；非零退出 → 带 stderr 尾部；
    cmd.exe 的 GBK 系统错误会按 GBK 解码显示；会话失效（unknown session 等）自动清会话并重试一次。
  - 状态探测：`dsh -V` 缓存版本；设置页「刷新 DSH 状态」重新探测。
  - 安全边界（评审后加固）：
    - 会话 id 白名单 `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`：`session.json` 里的非法 id 直接忽略，
      DSH 返回的非法 id 不落盘；避免把任意字符串拼进 Windows shell 命令行。
    - dsh 命令路径含引号 / `%` / 控制字符 / cmd·PowerShell 元字符（& | < > ^ ' $ `）时拒绝执行
      （状态报「路径包含不安全字符」）；
      Windows 下 `.cmd/.bat` 用一条带引号的命令行交给 `shell:true`，`.ps1` 用 `powershell -File`，其它直接 spawn。
    - 子进程环境会去掉密钥类变量：宠物/其它厂商前缀（`AI_*` / `OPENAI_*` / `DEEPSEEK_*` / `AZURE_*` /
      `VOICE_*` / `MAIL_*` / `ANTHROPIC_*` / `GEMINI_*` / `GOOGLE_*` / `GROQ_*` / `COHERE_*` /
      `HUGGINGFACE_*` / `HF_*`）以及含 `API_KEY`/`SECRET`/`TOKEN`/`PASSWORD`/`CREDENTIAL`/`AUTH` 的变量；
      `DSH_*` 与系统变量保留。并设 `DSH_PERMISSION_MODE=workspace-write`——写入范围仅 bridge 目录
      （实测 read-only 下写文件会被 DSH 沙箱拒绝；改成 workspace-write 后 DSH 只能写 bridge 目录，AI 回发文件靠它）。
    - 取消/重置会递增"代际号"：旧子进程的回调（text/close/error）按代际丢弃，不会把旧回复覆盖到新状态；
      队列串行、`final`/`text` 都为空时报「DSH 未返回内容」。
    - NDJSON 解析容错：BOM、CRLF、跨 chunk 半行、非法行都跳过不炸流。
- IPC 通道（契约常量见 `contracts.ts`）：
  - `IPC_DSH_STATUS`（`dsh:status`，invoke）→ `DshStatus { available, commandPath, version, bridgeDir, busy, lastError }`
  - `IPC_DSH_RESET_SESSION`（`dsh:reset-session`，invoke）→ `void`（清本地会话）
- 调试钩子：`PET_DSH_CMD` 覆盖 dsh 路径、`PET_DSH_TIMEOUT_MS` 覆盖超时、`PET_DSH_BRIDGE_DIR` 覆盖桥接目录、
  `PET_USER_DATA_DIR` 指到独立 userData（自动化测试用；单实例锁也会隔离）。
  **打包版默认忽略这些钩子**（避免本机环境变量改命令/目录），自动化需显式 `PET_ALLOW_DEBUG_HOOKS=1`。
- 设置页「模型 / 插件」资产列表：模型名**完整显示**（允许换行，不再省略号截断），徽章/按钮自动换行。


## 聊天附件（图片 / 音频 / 文件）与 AI 回发媒体

- 用户→AI（两种接入方式都支持）：聊天输入支持 **📎 选择文件 / 拖拽 / 粘贴图片**；发送前显示附件 chips，
  并先做**兼容性检查**（`IPC_MEDIA_CHECK`）：兼容 → 放行；需要转换 → 自动转换并提示；不支持 → 红框 + 可读提示。
  - API 模式：图片 → 若聊天模型本身是视觉模型则直接发；否则先用「视觉模型」（`AppSettings.visionModel`）
    描述/OCR，把结果作为文字注入对话。视觉模型怎么定：有 /models 列表时**自动从端点模型列表里挑**视觉模型
    （优先名字带 vl/vision，排除 realtime/audio/tts/asr/embedding 等；缓存 10 分钟）；列表里没有视觉模型时直接判
    「不支持」并提示替代方案（换支持图片的模型 / 手填视觉模型 / 改用桥接 DSH）；/models 拉不到时才乐观兜底
    `qwen3-vl-plus`（发送失败给可读错误）。音频 → ASR 转写（`voiceModel`，voice* 留空复用聊天 API）。
    - 视觉识别也支持独立配置：`visionModel` / `visionRoute`（`auto` / `chat` / `custom`）/
      `visionBaseUrl` / `visionApiKey`；地址/Key 留空复用聊天 API。`auto` 优先聊天模型直读、否则用显式视觉模型或
      从 `/models` 自动挑；`chat` 强制聊天模型；`custom` 只用显式视觉模型。
    文本文件 → 内联（≤2 万字符）。其它文件 → 本地路径 + 提示模型用工具读取。
  - DSH 模式：图片复制到 `<userData>/dsh-bridge/inbox/`，任务里给路径并让 DSH 用 `read_image` 查看
    （实测 DSH headless 支持）；音频 → ASR；文本 → 内联+路径；其它文件 → 路径。
  - 限制：单条消息最多 6 个附件；图片 ≤12MB、音频 ≤20MB、其它 ≤25MB。
- AI→用户（两种接入方式都支持）：
  - API 模式：新增工具 `send_to_user`（`path`/`caption`）→ 主进程校验收窄白名单（chat-media / uploads /
    dsh-bridge/outbox / 开发工作区，realpath 校验、拒绝配置密钥与可执行文件）与 ≤15MB → 推 `IPC_CHAT_MEDIA`，
    聊天里显示图片缩略图 / 音频播放器 / 文件卡（可点「打开」）。
  - DSH 模式：任务文本约定「需要发给用户的文件写到当前目录并用 `[[send:相对路径]]` 标注」；
    final 文本解析标记、校验在 bridge 目录内、复制到 `<userData>/chat-media/` 后推送卡片；回复文本去掉标记。
  - 聊天记录持久化 `ChatLogEntry.media`（只存元数据，不存 base64）；历史对话里媒体显示为文件卡（点开用系统程序）。
- 安全：附件路径只来自用户显式选择；AI 回发路径必须落在白名单目录；大小/数量受限；不执行任何命令；
  渲染层拿不到文件内容（图片/音频 base64 只在主进程→渲染层单向推送、仅当次显示）。
  - 回发白名单（`allowedSendRoots`）：`<userData>/chat-media`、`<userData>/uploads`、
    `<userData>/dsh-bridge/outbox`、用户设置的开发工作区；**不含 userData 根**（避免 AI 读 settings.json 等密钥文件），
    且拒绝 `settings*/chat-log/mcp/session/token/credentials` 等配置/密钥文件名与 `.exe/.bat/.cmd/.ps1/.msi/.dll/...` 可执行扩展名。
  - 路径校验用 `fs.realpathSync` 之后再比较目录（防符号链接/junction 指向白名单外）；
    只接受普通文件；单文件 ≤15MB；附件合计 ≤40MB。
  - DSH 输出目录收敛为 `<userData>/dsh-bridge/outbox/`，`[[send:…]]` 只解析 outbox 内文件
    （兼容 `[[send:x]]` 与 `[[send:outbox/x]]` 两种写法）；DSH 会话 id 文件移到 `<userData>/dsh-session.json`
    （bridge 目录可写也不会被 DSH 篡改会话）。
  - API 模式附件转述/转写拼进 prompt 的总长度上限 12000 字符（超出截断并标注），避免上下文/费用失控。
- 调试：`PET_USER_DATA_DIR` 隔离 userData 便于自动化（打包版需 `PET_ALLOW_DEBUG_HOOKS=1`）。


## 性能与内存（纹理降采样缓存 / idle 抑制 / 流式合并）

- **Live2D 纹理降采样缓存**（`src/main/modelTextureCache.ts`）：
  - 用户模型贴图常为 4096/8192 图集（实测 DeepSeek 6 张共 148.7M 像素 → 解压约 595MB，GPU 进程工作集 1.5GB）；
    桌宠窗口仅 ~600px 宽，4096 贴图仍远高于显示分辨率，后台把超大图集等比缩到 `textureMaxSize`（默认 4096）并缓存到
    `<userData>/live2d-cache/<maxSize>/<模型>/…`；静态服务对 `/user-models/<模型>/…` 优先返回缓存文件（原文件不动）。
  - 设置项 `AppSettings.textureMaxSize`：`0`=原始、`1024`/`2048`/`4096`(默认)；改设置自动换缓存目录重建。
  - 防抖：模型加载后**停留 20s 才构建**且只构建最后一个模型，避免快速切模型/刚启动时后台解码拖慢切换；
    `meta.json` 记录源文件 mtime/size，源文件或设置变化才重建；WebP/GIF 不降采样（避免扩展名/MIME 不符）。
  - 实测（DeepSeek 模型，笔记本）：GPU 进程工作集 **1529MB → 365MB**、renderer **575MB → 223MB**、
    总工作集合 **2289MB → 792MB（约 -65%）**；切模型 DeepSeek **2436ms → 751ms**、神宫白子 **2436ms → 346ms**。
- **流式增量合并**：`chatClient.onChunk` 在 main 侧缓冲，每 **16ms（≈一帧）** 合并成一次 `IPC_AI_CHUNK` 再推给渲染层；
  `onDone/onError` 前强制 flush 保证顺序。逐字显示效果不变，IPC/DOM 更新次数显著减少。
- **VTS 空闲抑制**：VTS 启用但未连接/未授权时不再每 33ms 发追踪帧（原来主进程只会丢弃）；每 5s 探测一次连接状态，
  连上后自动恢复 30fps 推送。
- 已有优化继续保留：RAF 主循环 60fps 上限 + 空闲 24fps + 页面隐藏暂停；窗口不可见暂停；媒体 base64 限制；
  聊天记录 DOM 行数上限；模型切换时销毁旧 PIXI 上下文（实测切换不泄漏）。

## 第三方资源授权

模型、角色资料、Live2D 运行库等第三方资源的授权**不由 MIT 覆盖**；发布前须逐项核验来源、
许可与再分发条件。项目代码版权主体见根目录 `LICENSE`。
