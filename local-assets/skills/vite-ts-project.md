---
name: Vite + TypeScript 前端项目
description: 用 Vite 脚手架创建 TypeScript 前端项目，含安装、构建验证
---

## 适用场景

用户要一个正经的前端工程：TypeScript 类型检查、Vite 热更新、`npm run build` 出产物。适合需要模块化、需要 npm 包、需要 TS 的场景。

## 前置检查

1. 调用 `shell_run`，参数 `command: "node -v"`，`timeout_ms: 10000`。
   - 期望：返回类似 `v20.x.x` 的版本号。
   - 失败：明确告诉用户"本机未安装 Node.js，请先去 https://nodejs.org 安装 LTS 版本"，**停止执行，不要重试**。
2. 调用 `shell_run`，参数 `command: "npm -v"`，`timeout_ms: 10000`。
   - 期望：返回版本号如 `10.x.x`。
   - 失败：同上，明确结论并停止。
3. 调用 `workspace_glob`，参数 `pattern: "*"`，确认工作区无同名目录冲突。
4. 若用户未给项目名，先询问；得到后用 `workspace_mkdir` 参数 `path: "<项目名>"` 创建（或让 vite 自己创建，见步骤 1）。

## 步骤

> **重要**：每次调用写文件或执行命令工具时，系统都会先弹确认框让用户点允许；用户若拒绝，立即停下来询问，不要重试。

### 1. 用 Vite 脚手架初始化（非交互）

- 工具：`shell_run`
- 参数：
  - `command`: `"npm create vite@latest <项目名> -- --template vanilla-ts"`
  - `timeout_ms`: `120000`
- **关键点**：
  - 必须带 `--template vanilla-ts`，否则脚手架会进入交互询问。
  - 必须带 `--`（双横线加空格），它把后面的参数透传给 `create-vite`，而不是被 `npm create` 自己吃掉。
  - 若用户要 Vue/React，把 `vanilla-ts` 换成 `vue-ts` / `react-ts`，但**必须提前和用户确认框架**。
- 期望：命令退出码 0，输出含 `Done.` 或类似成功提示。
- 失败处理：
  - 若报 `npm ERR!` 网络错误：提示用户检查网络或换源（`npm config set registry https://registry.npmmirror.com`），**不要自动换源**，等用户指示。
  - 若报目录已存在：用 `shell_run` 执行 `Remove-Item -Recurse -Force <项目名>`（先和用户确认），再重试。

### 2. 安装依赖

- 工具：`shell_run`
- 参数：
  - `command`: `"cd <项目名>; npm install -y"`
  - `timeout_ms`: `300000`（5 分钟，首次安装可能很慢）
- 期望：退出码 0，输出含 `added xxx packages`。
- 失败处理：
  - 超时：告诉用户"安装超时，可能是网络慢，请稍后手动在项目目录执行 `npm install`"，**停止自动重试**。
  - 权限错误（Windows 下少见）：提示以管理员身份运行终端。

### 3. 构建验证

- 工具：`shell_run`
- 参数：
  - `command`: `"cd <项目名>; npm run build"`
  - `timeout_ms`: `120000`
- 期望：退出码 0，输出含 `dist/` 相关成功信息。
- 失败处理：若 TS 报错，用 `workspace_file_read` 读报错文件，把错误翻译成人话告诉用户，询问是否要修。

### 4. 检查关键文件

- 工具：`workspace_glob`，参数 `pattern: "<项目名>/**/*"`
- 期望：包含 `package.json`、`src/main.ts`、`src/vite-env.d.ts`、`index.html`、`tsconfig.json`、`vite.config.ts`。
- 工具：`workspace_file_read`，参数 `path: "<项目名>/package.json"`
  - 确认 `scripts` 含 `dev`、`build`、`preview`。
- 工具：`workspace_file_read`，参数 `path: "<项目名>/src/main.ts"`
  - 确认是 TS 文件，含 `document.querySelector` 之类示例代码。
- 工具：`workspace_file_read`，参数 `path: "<项目名>/index.html"`
  - 确认含 `<script type="module" src="/src/main.ts"></script>`。

## 验证

1. 调用 `workspace_glob`，参数 `pattern: "<项目名>/dist/*"`，确认构建产物存在（`index.html`、`assets/*.js`、`assets/*.css`）。
2. 告知用户：
   - 开发：`cd <项目名>; npm run dev`
   - 构建：`npm run build`，产物在 `dist/`
   - 预览构建产物：`npm run preview`

## 常见坑

- **交互卡死**：`npm create vite@latest` 不带 `--template` 会进交互，桌宠无法回答，必须带 `--template xxx-ts` 和 `--`。
- **npm 不存在**：前置检查失败就停止，**不要**尝试用 `npx`、`pnpm`、`yarn` 替代，除非用户明确要求。
- **超时**：`npm install` 默认 60 秒不够，必须显式传 `timeout_ms: 300000`。
- **不要自动 `npm run dev`**：dev server 会一直跑，桌宠无法优雅停止；让用户自己在终端里跑。
- **不要改 vite.config.ts**：除非用户要求，脚手架默认配置已经够用。
- **PowerShell 路径分隔**：命令里用 `cd <项目名>; npm install`（分号分隔），不要用 `&&`（PowerShell 7+ 才支持）。
