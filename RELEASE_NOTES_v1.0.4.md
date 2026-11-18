# Pet v1.0.4

## 更新检测

- 启动后异步检查 GitHub Release，不阻塞启动、不弹窗、不影响其它功能。
- 设置页新增「当前版本 / 启动时自动检查更新 / 立即检查 / 前往下载」。
- 支持离线、超时、限流、HTTP 错误等状态提示；只信任本仓库的 Release 页面。
- 更新提示统一收在「设置 → 更新」，不占托盘或右键菜单。

## 界面与工程

- 渲染层拆分为 `settingsPanel.ts` / `thinkingOverlay.ts` / `voiceInput.ts`，`renderer.ts` 体积明显下降。
- 升级 Electron 45 / electron-builder 26，新增 `after-pack` fuses 处理与 Electron 安装脚本。
- 新增 CI、Dependabot 和 renderer sandbox 测试辅助。
- 语音输入、设置面板、思考浮窗、VTS/TTS 相关测试同步更新。

## Live2D / VTS 兼容性

- 读取 `.vtube.json` 的 `ChangeIdleAnimation`，模型自带的多个待机动作可以作为独立 Motion 组切换。
- 支持 `StopsOnLastFrame`：动作播放结束后保持最后一帧姿势。
- 用户触发的动作使用 FORCE 优先级，正确打断待机动作。
- 修复参数映射读取：`UseBreathing` / `UseBlinking` 行交给引擎自动呼吸/眨眼；本项目不提供的输入不再误占输出，修复 Ellen 这类模型眼睛不动、参数映射不生效的问题。

## 其它修复

- 英文 TTS 音色试听按音色语言选择试听句；空音频自动回退默认中文音色。
- 窗口边缘视线抖动、拖放虚线框残留、自主任务场景提示词、MCP 上下文等此前修复一并包含。
- 本版本更新检测的目标版本为 **v1.0.4**。

## 版本

- `1.0.4`
