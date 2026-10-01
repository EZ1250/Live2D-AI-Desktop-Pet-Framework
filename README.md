# Pet

基于 Electron 的 Live2D 桌面宠物，支持模型切换、对话、语音转写、待办和插件。

## 怎么启动

| 方式 | 做法 | 说明 |
| --- | --- | --- |
| **日常使用** | 双击安装后的 Pet 快捷方式 | 安装包会创建桌面和开始菜单快捷方式 |
| 从源码运行 | `npm start` | 自动编译、装配并启动开发版 |
| 重新打包 | `npm run dist` | 产出安装包和便携版到 `release/` |

> Windows 可能拦截从 `Desktop` 目录直接运行的未签名程序。遇到双击无响应时，
> 请安装到 `%LOCALAPPDATA%\Programs\`，或把 `win-unpacked` 拷到其他目录运行。

## 开发

```bash
npm install
npm start
```

常用命令：

| 命令 | 用途 |
| --- | --- |
| `npm test` | 编译并运行测试 |
| `npm run check:privacy --all` | 检查打包隐私边界 |
| `npm run dist` | 生成安装包和便携版 |

## 当前功能

- Live2D Cubism 3/4/5（随包 Core 5.0，可读 moc3 v3/v4/v5）与静态立绘；不兼容模型会显示原因。
- 右键菜单切换取景（全身/半身）、表情与动作；设置页切换模型、配置 OpenAI 兼容接口、语音转写接口、权限模式与音效。
- 气泡聊天、独立对话窗、思考过程浮窗、历史会话、待办笔记本、提醒闹钟。
- 托盘菜单（显示/隐藏、摆回屏幕内、取景、点击穿透、设置、退出）与全局快捷键 `Ctrl+Alt+P`（显隐）、`Ctrl+Alt+O`（设置）。
- 窗口位置记忆、全屏时自动收起、空闲降帧、模型文件夹拖放导入。
- 模型与插件通过设置里的资产目录导入，并显示检查结果。
- 开发辅助只在选择工作区后启用，并受路径、大小、权限和确认策略限制。

## 目录

- `src/main`：主进程、IPC、本地静态服务和 AI 工具。
- `src/preload`：`contextBridge` 窄接口。
- `src/renderer`：窗口界面与模型渲染。
- `src/shared/contracts.ts`：IPC 与 preload 契约的唯一来源。
- `local-assets`、`personas`：本地模型、技能和角色资料源。
- `public`、`dist`、`release`：导入、编译和打包产物（都已 gitignore，可由命令重建）。

文件归属与构建关系见 `docs/PROJECT_LAYOUT.md`。

## 路径与资源

开发时从 `public/assets` 和 `public/renderer` 读取资源；打包后从 `resources/assets` 和
`resources/renderer` 读取。资源由主进程的本地 HTTP 服务提供给渲染进程，渲染进程不直接访问文件系统。

## 授权

- 项目许可证：MIT，见 `package.json`。
- 模型、角色资料、Live2D 运行库等第三方资源的授权**不由 MIT 覆盖**；发布前须逐项核验来源、许可和再分发条件。
- 不要把 API Key 提交到仓库。应用设置保存在当前用户的 Electron `userData` 目录。
