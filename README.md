[English](README.en.md) | **简体中文**

# Pet

基于 Electron 的 Live2D 桌面宠物，支持模型切换、对话、语音转写、待办和插件。

## 下载安装（普通用户）

| 平台 | 文件 | 说明 |
| --- | --- | --- |
| Windows（推荐） | `Pet-*-setup.exe` | 安装版，启动快；会创建桌面/开始菜单快捷方式 |
| Windows（免安装） | `Pet-*-portable.exe` | 便携单文件，启动约 9 秒（每次解包到临时目录） |
| Android（测试） | `PetMcpClient-*-test-debug.apk` | debug 签名测试版，仅用于手机 MCP 联调 |

👉 **[下载最新版本](https://github.com/EZ1250/Live2D-AI-Desktop-Pet-Framework/releases/latest)**

> 安装包未做代码签名，首次运行若提示"未知发布者"：更多信息 → 仍要运行。
> 校验和见 Release 页面的 `SHA256SUMS.txt`。

## 怎么启动

| 方式 | 做法 | 说明 |
| --- | --- | --- |
| **日常使用** | 双击安装后的 Pet 快捷方式 | 安装包会创建桌面和开始菜单快捷方式 |
| 从源码运行 | `npm start` | 自动编译、装配并启动开发版 |
| 重新打包 | `npm run dist` | 产出安装包和便携版到 `release/` |

> Windows 可能拦截从 `Desktop` 目录直接运行的未签名程序。遇到双击无响应时，
> 请安装到 `%LOCALAPPDATA%\Programs\`，或把 `win-unpacked` 拷到其他目录运行。

## 开发（进阶命令）

> 日常安装/启动/打包见上面的「怎么启动」，这里只列排查和本桌宠专属模块的验证命令。

### 打开渲染层 Console（排查 UI / 视线 / 点击 / 头像流）

```powershell
# 方式一：自动弹出 DevTools
$env:DEVTOOLS=1
& "$env:LOCALAPPDATA\Programs\Pet\Pet.exe"

# 方式二：远程调试（浏览器打开 http://127.0.0.1:9222）
& "$env:LOCALAPPDATA\Programs\Pet\Pet.exe" --remote-debugging-port=9222
```

### 本桌宠专属模块的功能测试

```bash
# 全部测试（tsc + 装配 + node:test）
npm test

# CI 同款（tsc + assemble + node --test）
npm run check

# 单模块测试（按需）
node --test tests/mcpServerPhone.test.js          # 手机桥接/轮询/超时
node --test tests/mcpServerPhoneContracts.test.js # 手机接口 JSON 契约
node --test tests/mcpServerRemote.test.js         # MCP 远程访问/WS
node --test tests/live2dPlacement.test.js         # 半身/全身取景、头部锚点
node --test tests/behaviorTriggers.test.js        # 视线跟随、点击/拖拽互动
node --test tests/autonomy.test.js                # 自主任务规则
node --test tests/promptLayers.test.js            # 四层提示词
node --test tests/toolLoopGuard.test.js           # 工具循环守卫
node --test tests/mcpClient.test.js               # MCP 客户端
node --test tests/voiceInput.test.js              # 语音输入
node --test tests/contracts.test.js               # 跨进程契约
node --test tests/routes.test.js                  # IPC 路由（契约↔preload↔主进程）
node --test tests/staticServer.test.js            # 本地静态资源路由（renderer/assets/挂载点/越界）
node --test tests/assetIntegrity.test.js          # 渲染资源/运行库/仓库完整性
```

### 打包与验收

```bash
npm start                     # 开发运行（prestart 会自动 import 资源 + 增量编译）
npm run check:privacy --all   # 打包隐私边界（模型/密钥不进包）
npm run dist                  # 安装包 + 便携版
npm run build:all             # 只编译装配，不打包
```

> `public/assets` 是 `npm run import` 的生成物（被 .gitignore 忽略）。如果开发版出现
> “托盘无图标 / 提示词走内置兜底 / 启动偏慢”，先跑一次 `npm run import`（`npm start` 已自动包含）。
> 便携版单 exe 每次启动都要解包到 %TEMP%（约 9~10s），日常使用请用安装版或 win-unpacked。

## 当前功能

- Live2D Cubism 3/4/5（随包 Core 5.1，可读 moc3 v3/v4/v5）与静态立绘；不兼容模型会显示原因。
- 右键菜单切换取景（全身/半身）、表情与动作；设置页切换模型、配置 OpenAI 兼容接口、语音转写接口、权限模式与音效。
- 气泡聊天、独立对话窗、思考过程浮窗、历史会话、待办笔记本、提醒闹钟。
- 对话可自动朗读（Edge TTS；内置 20+ 音色，设置里可一键联网拉取全部音色；VTS 开启时同步口型）。
- 行为触发：发言 / 工具 / 命令 / 回答 / 待机 / 出错 / 点击 / 连点 / 拖动 / MCP 调用可各绑动作或表情，
  单个行为还支持再叠一个"同时表情"（动作与表情同时生效）。
- 托盘菜单（显示/隐藏、摆回屏幕内、取景、点击穿透、设置、退出）与全局快捷键 `Ctrl+Alt+P`（显隐）、`Ctrl+Alt+O`（设置）。
- 窗口位置记忆、全屏时置顶显示（默认；可在设置里改为自动收起）、空闲降帧、模型文件夹拖放导入。
- 模型与插件通过设置里的资产目录导入，并显示检查结果。
- 开发辅助只在选择工作区后启用，并受路径、大小、权限和确认策略限制。

## 目录

- `src/main`：主进程、IPC、本地静态服务和 AI 工具。
- `src/preload`：`contextBridge` 窄接口。
- `src/renderer`：窗口界面与模型渲染。
- `src/shared/contracts.ts`：IPC 与 preload 契约的唯一来源。
- `local-assets`、`personas`：本地模型、技能和角色资料源。
- `android-mcp-client`：手机端 MCP 客户端（Kotlin + Compose；源码随仓库提供，APK 用 Android Studio 本地构建，不纳入版本库）。
- `public`、`dist`、`release`：导入、编译和打包产物（都已 gitignore，可由命令重建）。

文件归属与构建关系见 `docs/PROJECT_LAYOUT.md`。

## 路径与资源

开发时从 `public/assets` 和 `public/renderer` 读取资源；打包后从 `resources/assets` 和
`resources/renderer` 读取。资源由主进程的本地 HTTP 服务提供给渲染进程，渲染进程不直接访问文件系统。

## 授权

- 项目许可证：MIT，见 `package.json`。
- 模型、角色资料、Live2D 运行库等第三方资源的授权**不由 MIT 覆盖**；发布前须逐项核验来源、许可和再分发条件。
- 不要把 API Key 提交到仓库。应用设置保存在当前用户的 Electron `userData` 目录。
