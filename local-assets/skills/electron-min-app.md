---
name: 最小 Electron 应用
description: 创建一个最小可运行的 Electron 桌面应用（主进程+渲染页）
---

## 适用场景

用户想要一个真正的桌面应用窗口（不是浏览器标签），需要 Node.js 能力、系统 API、本地文件访问等 Electron 特性。

## 前置检查

1. 调用 `shell_run`，参数 `command: "node -v"`，`timeout_ms: 10000`。
   - 期望：返回版本号。
   - 失败：明确告诉用户"未安装 Node.js，请先安装"，**停止**。
2. 调用 `shell_run`，参数 `command: "npm -v"`，`timeout_ms: 10000`。
   - 期望：返回版本号。
   - 失败：同上，停止。
3. 调用 `workspace_glob`，参数 `pattern: "*"`，确认无同名目录。
4. 若用户未给项目名，先询问；用 `workspace_mkdir` 参数 `path: "<项目名>"` 创建。

## 步骤

> **重要**：每次调用写文件或执行命令工具时，系统都会先弹确认框让用户点允许；用户若拒绝，立即停下来询问，不要重试。

### 1. 写 package.json

- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/package.json"`
  - `content`:
    ```json
    {
      "name": "<项目名>",
      "version": "1.0.0",
      "main": "main.js",
      "scripts": {
        "start": "electron ."
      },
      "devDependencies": {
        "electron": "^33.0.0"
      }
    }
    ```
  - **关键点**：
    - `main` 必须是 `"main.js"`（与步骤 2 的文件名对应）。
    - `electron` 放 `devDependencies` 而非 `dependencies`（它是开发期工具，打包时不进产物）。
    - `scripts.start` 必须是 `"electron ."`。
- 期望：写入成功。

### 2. 写 main.js（主进程）

- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/main.js"`
  - `content`: 必须包含：
    - `const { app, BrowserWindow } = require('electron')`
    - `const path = require('path')`
    - `function createWindow() { ... }` 内：
      - `const win = new BrowserWindow({ width: 800, height: 600, webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') } })`
      - `win.loadFile('index.html')`
    - `app.whenReady().then(createWindow)`
    - `app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })`
    - **安全关键**：`contextIsolation: true`、`nodeIntegration: false` 必须显式写，不能省略。
- 期望：写入成功。

### 3. 写 index.html（渲染页）

- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/index.html"`
  - `content`: 标准 HTML，`<head>` 含 `<meta charset="utf-8">`，`<body>` 含示例内容（如 `<h1>Hello Electron</h1>`），**不要**在渲染页里用 `require`（因为 `nodeIntegration: false`）。
- 期望：写入成功。

### 4. 安装 Electron

- 工具：`shell_run`
- 参数：
  - `command`: `"cd <项目名>; npm install -y"`
  - `timeout_ms`: `300000`（Electron 包体 ~200MB，首次安装很慢）
- 期望：退出码 0，输出含 `added xxx packages`。
- **失败处理（重要）**：
  - 若超时或网络错误：明确告诉用户"Electron 安装失败（包体大，可能网络慢），已交付全部源码文件，请你在项目目录手动执行 `npm install`"。**不要重试**，不要换源，不要改用 pnpm/yarn。
  - 若报权限错误：提示以管理员身份运行。
  - 安装成功后，用 `workspace_glob` 参数 `pattern: "<项目名>/node_modules/electron/dist/*"` 确认 electron 二进制存在。

### 5. （可选）写 preload.js

- 仅当用户明确需要"渲染页调用 Node API"时才写。
- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/preload.js"`
  - `content`: `const { contextBridge } = require('electron'); contextBridge.exposeInMainWorld('myAPI', { ... })`
- 若用户没提，**跳过此步**，不要自作主张加。

## 验证

1. 调用 `workspace_glob`，参数 `pattern: "<项目名>/*"`，确认存在 `package.json`、`main.js`、`index.html`。
2. 调用 `workspace_file_read`，参数 `path: "<项目名>/main.js"`，确认含 `contextIsolation: true` 和 `nodeIntegration: false`。
3. 调用 `workspace_file_read`，参数 `path: "<项目名>/package.json"`，确认 `main` 字段是 `"main.js"`。
4. 告知用户：
   - 启动：`cd <项目名>; npm start`
   - **不要**由桌宠自动执行 `npm start`——Electron 会在用户屏幕上弹出一个 GUI 窗口，需要用户自己决定何时启动、在哪个终端里启动。

## 常见坑

- **不要自动 `npm start`**：Electron 启动后会弹出 GUI 窗口，桌宠无法控制焦点，且进程会一直占着 shell；让用户自己在终端里跑。
- **安装超时**：Electron 包体大，必须给 `timeout_ms: 300000`；失败时**只交付文件**，让用户手动装，不要反复重试。
- **安全配置**：`contextIsolation: true` 和 `nodeIntegration: false` 是 Electron 官方推荐的安全默认值，**不要**为了"方便"把它们改成 false/true。
- **渲染页不能用 require**：因为 `nodeIntegration: false`，渲染页（index.html 里的 `<script>`）不能直接 `require('fs')`；要调用 Node API 必须走 preload + contextBridge。
- **main 字段**：`package.json` 的 `main` 必须指向主进程文件（这里是 `main.js`），写错会导致 `npm start` 报 `Cannot find module`。
- **不要用 TypeScript**：除非用户明确要求；最小 Electron 应用用 JS 即可，避免额外配置 tsconfig。
- **PowerShell 命令分隔**：用 `cd <项目名>; npm install`（分号），不要用 `&&`。
