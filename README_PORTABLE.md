# Pet 便携版运行说明

本文档由 `scripts/build-portable.js` 自动生成（版本 **1.0.0**）。

## 产物位置

- 安装包：`release/Pet-1.0.0-setup.exe`
- 便携单文件：`release/Pet-1.0.0-portable.exe`
- 免安装目录：`release/win-unpacked/`

## 使用建议

1. 默认优先安装包（启动更快，自动创建快捷方式）。
2. 需要单文件携带时使用 portable（每次启动会先解包到临时目录）。
3. 需要免安装且更快启动时，直接使用 `win-unpacked/Pet.exe`。

## 模型与资源

- 模型资源不打进 ASAR；构建时会将 `public/assets` 映射到 `resources/assets`。
- 用户自有模型目录：`%APPDATA%\pet-desktop-app\live2d-models\<模型名>\`。
- 可分发资源请放在 `local-assets/` 后执行 `npm run import`。

## 安全与权限提示

- 可执行文件未签名时，Windows 可能弹出 SmartScreen 提示。
- 不要把 API key 或本机配置打包进发布产物；发布前建议运行：`npm run check:privacy --all`。

## 常见问题

- 便携版首次启动较慢通常是解包行为。
- 白屏或资源缺失请先确认已执行 `npm run import` 与 `npm run build:all`。
