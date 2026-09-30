# Pet

基于 Electron 的 Live2D 桌面宠物。支持模型切换、对话、语音转写、待办、插件和本地开发辅助。

## 怎么启动

| 方式 | 做法 | 说明 |
| --- | --- | --- |
| **日常使用** | 双击桌面快捷方式「Pet 桌宠」 | 指向 `%LOCALAPPDATA%\Programs\Pet\Pet.exe`，已实测可启动 |
| 从源码跑 | `npx electron . --no-sandbox`（在项目目录） | 用 `node_modules` 里的 Electron，含最新代码 |
| 重新打包 | `npm run dist` | 产出安装包与便携版到 `release/` |

> ⚠️ **不要在项目所在的 `Desktop` 目录下运行打包产物。** 本机实测：`release/` 里生成的 exe
> 双击无反应、连进程都不出现（退出码 `0x80000003`），而**同一份文件**拷到 `%TEMP%` 或
> `%LOCALAPPDATA%\Programs\` 下就能正常启动——逐字节校验过运行时文件完全相同，
> 所以是系统安全策略拦截了 Desktop 下的新可执行文件，不是构建坏了。
> 需要免安装副本时，把 `win-unpacked` 整个目录拷到别的分区再运行。

## 开发

```bash
npm install
npm run import       # 导入模型、角色资料和技能
npm run build:all    # 编译并装配渲染资源
npm run start        # 启动开发版
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm test` | 编译并运行测试 |
| `npm run check:privacy --all` | 检查打包隐私边界 |
| `npm run dist` | 生成安装包和便携版 |

## 当前功能

- Live2D Cubism 3/4/5（随包 Core 5.0，可读 moc3 v3/v4/v5）与 PNG 立绘；超出运行库上限的模型由体检层标为不支持，渲染占位提示而不是硬加载。
- 右键菜单切换取景（全身/半身）、表情与动作；设置页切换模型、配置 OpenAI 兼容接口、语音转写接口、权限模式与音效。
- 气泡聊天、独立对话窗、思考过程浮窗、历史会话、待办笔记本、提醒闹钟。
- 托盘菜单（显示/隐藏、摆回屏幕内、取景、点击穿透、设置、退出）与全局快捷键 `Ctrl+Alt+P`（显隐）、`Ctrl+Alt+O`（设置）。
- 窗口位置记忆、全屏时自动收起、空闲降帧、模型文件夹拖放导入。
- 模型与插件通过设置里的资产目录导入，并带回问题清单。
- 开发辅助只在选择工作区后启用；文件与命令受工作区、大小、权限模式和确认策略限制。

## 目录

- `src/main`：主进程、IPC、本地静态服务和 AI 工具。
- `src/preload`：`contextBridge` 窄接口。
- `src/renderer`：窗口界面与模型渲染。
- `src/shared/contracts.ts`：IPC 与 preload 契约的唯一来源。
- `local-assets`、`personas`：本地模型、技能和角色资料源。
- `public`、`dist`、`release`：导入、编译和打包产物（都已 gitignore，可由命令重建）。

细分归属、脚本索引与"别当冗余删掉"的清单见 `docs/PROJECT_LAYOUT.md`。

## 路径与资源

开发时从 `public/assets` 和 `public/renderer` 读取资源；打包后从 `resources/assets` 和
`resources/renderer` 读取。资源由主进程的本地 HTTP 服务提供给渲染进程，渲染进程不直接访问文件系统。

## 授权

- 项目许可证：MIT，见 `package.json`。
- 模型、角色资料、Live2D 运行库等第三方资源的授权**不由 MIT 覆盖**；发布前须逐项核验来源、许可和再分发条件。
- 不要把 API Key 提交到仓库。应用设置保存在当前用户的 Electron `userData` 目录。
