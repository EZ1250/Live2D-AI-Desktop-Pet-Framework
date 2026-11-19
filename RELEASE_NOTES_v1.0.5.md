# Pet v1.0.5

## AI 接入

- 新增「桥接本机 DSH」模式：`aiMode: 'api' | 'dsh'`，通过本机 `dsh --profile headless` 只转发文字对话，不传工具/截图；同一会话延续上下文。
- DSH 运行目录固定在 `<userData>/dsh-bridge`，只允许在该目录内写入；发送/回发文件通过 `inbox` / `outbox`。
- 聊天附件支持图片 / 音频 / 文件：选择、拖拽、粘贴，发送前做兼容性检查。
- 图片支持视觉模型转述/OCR，音频支持 ASR 转写，文本内联，其它文件给路径。
- 视觉识别支持独立配置：视觉模型、视觉路由（`auto` / `chat` / `custom`）、视觉专用地址/Key；并新增「▾ 选择模型」从视觉端点索引候选。
- AI 可通过 `send_to_user`（API）或 `[[send:...]]`（DSH）把图片/音频/文件发回聊天。

## 界面与设置

- 设置页新增更新检测：启动时异步检查、设置页手动检查、前往下载；不弹窗、不占托盘。
- 设置页重新排版：视觉识别 / 语音识别统一使用分组卡片；开发工作区、权限模式移入 API 配置，位于三条勾选项之前；视觉识别在最后。
- 模型与插件资产名完整显示，长名字换行。
- 语音识别保留独立地址/Key/路由；视觉识别与语音识别版式一致。

## 性能与 Live2D

- 新增模型纹理降采样缓存：大图集按 `textureMaxSize` 缓存，默认 4096；4096 以下模型保持原图，8192 图集降采样。
- 修改纹理精度后自动重新加载当前模型，修复“调节后没反应”。
- 保留并完善 VTS 参数映射修复：`ChangeIdleAnimation` 待机组、`StopsOnLastFrame` 停帧、`UseBreathing` / `UseBlinking` 交给引擎、无效输入不再误占输出。

## 工程

- Electron 45 / electron-builder 26；新增 after-pack fuses、Electron 安装脚本、CI、Dependabot。
- 新增 DSH bridge、媒体附件、视觉路由、纹理信息等测试；当前 **295 pass / 0 fail**。
- 更新 README、README_PORTABLE、CONTRACT 与项目结构文档。

## 版本

- `1.0.5`
