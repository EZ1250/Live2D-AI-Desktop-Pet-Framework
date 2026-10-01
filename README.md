# Pet

基于 Electron 的 Live2D 桌面宠物应用。提供模型渲染、聊天、语音转写、待办、插件与本地开发辅助。

## 运行前置

- Windows 10/11（x64）
- Node.js 20+
- npm 10+
- Live2D 模型请放在用户目录或 `local-assets/`，仓库不内置你的私有模型和密钥

## 快速开始（源码）

```bash
npm install
npm run import
npm run build:all
npm run start
```

常用命令：

- `npm test`：编译并运行测试
- `npm run check:privacy --all`：扫描打包输入/产物中的隐私与密钥风险
- `npm run dist`：构建安装包与便携版到 `release/`

## 模型与资源放置

- 内置/可分发资源来源：`local-assets/` + `personas/`，通过 `npm run import` 生成到 `public/assets/`
- 用户自有模型目录：`%APPDATA%\pet-desktop-app\live2d-models\<模型名>\`
- 资源解析优先级：用户模型优先，随后随包 `assets`
- 打包后资源路径：`resources/assets`、`resources/renderer`

## 架构边界

- `src/main`：主进程、IPC、静态资源服务、工具能力
- `src/preload`：`contextBridge` 暴露 `window.electron` 窄接口
- `src/renderer`：UI 与 Live2D 渲染
- `src/shared/contracts.ts`：IPC 常量与 preload 契约唯一来源
- `src/plugin-system`：插件注册与类型定义

详细边界见 `CONTRACT.md` 与 `docs/PROJECT_LAYOUT.md`。

## 路由与路径一致性

- 页面入口由主进程统一加载，面板通过查询参数区分（chat/think）
- IPC 通道名统一定义在 `src/shared/contracts.ts`，主进程与 preload 通过 import 复用
- 渲染层通过本地 HTTP 静态服务访问模型/渲染资源，不直接读取文件系统

## 配置、密钥与数据

- API key 与用户设置只保存在 Electron `userData` 目录，不应提交到仓库
- 聊天记录、待办、记忆文件属于本机数据，不随仓库分发
- 插件在受限上下文运行，不自动获得文件系统或命令执行权限

## 许可与合规提示

- 代码许可证：MIT（见 `LICENSE`）
- Live2D 运行库、模型、角色素材及第三方服务条款不受 MIT 自动覆盖，发布前需自行核验授权
- 仓库不声明托管第三方模型授权或任何外部服务可用性承诺
