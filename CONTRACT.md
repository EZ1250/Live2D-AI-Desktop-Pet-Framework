# Pet 跨模块契约

本文件只记录**运行时边界**与**改代码时必须同步的位置**。IPC 通道名与数据类型的完整清单以
`src/shared/contracts.ts` 为唯一来源，此处不重复维护（重复的清单必然过期）。

## 唯一真源

- `src/shared/contracts.ts` 定义全部 IPC 通道常量、`ElectronAPI` 接口与共享类型。
- `src/preload/preload.ts` 只通过 `contextBridge` 暴露 `window.electron`（`ElectronAPI`）；
  通道名一律 import 自 contracts，不写字面量。
- 渲染层只能访问 `window.electron`，拿不到 `ipcRenderer`、Node 或文件系统。
- 主窗口、对话气泡窗（`?panel=chat`）、思考浮窗（`?panel=think`）共用同一套 preload 契约。

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

`PathResolver` 按打包状态与目录存在性选择资源根，不依赖环境变量。渲染页加载失败时依次回退
`public/renderer/index.html` → `resources/renderer/index.html` → `dist/renderer/index.html`；
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

## 第三方资源授权

模型、角色资料、Live2D 运行库等第三方资源的授权**不由 MIT 覆盖**；发布前须逐项核验来源、
许可与再分发条件。仓库未声明具体开发者或第三方资源授权人。
