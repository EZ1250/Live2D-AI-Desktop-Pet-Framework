---
name: 纯静态网页
description: 创建零依赖、无构建的纯静态网页项目（HTML+CSS+JS），双击即可在浏览器打开
---

## 适用场景

用户想要一个最简单的网页：不需要 Node.js、不需要构建工具、不需要任何依赖。产物只有 `index.html` + `styles.css` + `app.js`，双击 `index.html` 就能在浏览器里看效果。

## 前置检查

1. 调用 `workspace_glob`，参数 `pattern: "*"`，查看工作区根目录，确认没有同名目录冲突。
2. 若用户未指定项目目录名，先询问；得到名字后用 `workspace_mkdir`，参数 `path: "<项目名>"`，创建项目目录。若已存在则跳过。

## 步骤

> **重要**：每次调用写文件或执行命令工具时，系统都会先弹确认框让用户点允许；用户若拒绝，立即停下来询问原因，不要重试或绕过。

### 1. 写 index.html

- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/index.html"`
  - `content`: 完整 HTML 文档，必须包含：
    - `<!DOCTYPE html>`
    - `<html lang="zh-CN">`
    - `<head>` 内**第一行** `<meta charset="utf-8">`
    - `<meta name="viewport" content="width=device-width, initial-scale=1.0">`
    - `<title>` 用用户给的标题或项目名
    - `<link rel="stylesheet" href="styles.css">`（相对路径，不带 `/` 开头）
    - `<body>` 内放基础结构（如 `<h1>`、`<main>`、`<p>`）
    - `</body>` 前 `<script src="app.js"></script>`（相对路径）
- 期望：返回写入成功。

### 2. 写 styles.css

- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/styles.css"`
  - `content`: 基础样式，至少包含：
    - `* { box-sizing: border-box; margin: 0; padding: 0; }`
    - `body { font-family: system-ui, sans-serif; line-height: 1.6; padding: 2rem; }`
    - 一两个示例 class（如 `.card`）
- 期望：返回写入成功。

### 3. 写 app.js

- 工具：`workspace_write`
- 参数：
  - `path`: `"<项目名>/app.js"`
  - `content`: 浏览器端 JS，必须：
    - 用 `document.addEventListener('DOMContentLoaded', () => { ... })` 包裹
    - 至少一个示例 DOM 操作（如 `document.querySelector('h1').textContent = '...'`）
    - **禁止**使用 `require`、`process`、`fs`、`child_process` 等 Node API
    - **禁止**使用 `fetch` 加载本地文件（`file://` 协议下会被拦截）
- 期望：返回写入成功。

### 4. 列产物确认

- 工具：`workspace_glob`
- 参数：`pattern: "<项目名>/*"`
- 期望：返回结果包含 `index.html`、`styles.css`、`app.js` 三个文件。
- 失败处理：缺哪个文件就回到对应步骤重写；三个都在则进入验证。

## 验证

1. 调用 `workspace_file_read`，参数 `path: "<项目名>/index.html"`，确认：
   - 第 5 行内出现 `<meta charset="utf-8">`
   - `<link>` 的 `href` 是 `"styles.css"` 而非 `"/styles.css"`
   - `<script>` 的 `src` 是 `"app.js"` 而非 `"/app.js"`
2. 告知用户：**直接双击 `<项目名>/index.html` 即可在默认浏览器中查看效果**，无需启动任何服务器。

## 常见坑

- **中文乱码**：HTML 必须在 `<head>` 内最前面写 `<meta charset="utf-8">`；`workspace_write` 默认 UTF-8，不要改编码。
- **相对路径**：CSS/JS 引用一律用 `href="styles.css"`、`src="app.js"`，**不要**写 `/styles.css`（在 `file://` 下会被解析到盘符根目录，导致 404）。
- **不要引入构建工具**：这是零依赖项目，不要自作主张加 webpack/vite/parcel。
- **不要用 shell_run**：纯静态项目不需要执行任何命令；若用户要求"起个服务器"，提示 `file://` 双击即可，或询问是否改用 vite-ts-project 技能。
- **不要引入 CDN 脚本**：除非用户明确要求；零依赖意味着连 CDN 都不该加。
- **图片等静态资源**：若用户要加图片，让用户自己放到项目目录并用相对路径引用，不要替用户下载。
