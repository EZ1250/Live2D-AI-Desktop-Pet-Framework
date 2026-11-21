# Pet v1.1.0

## 手机端 MCP（0.5.2）

- 手机投屏：`CastStreamClient` + `AvatarFrameDecoder`，支持实时画面/头像流。
- 手机触屏交互：点击、拖动发送 `pet_touch`，电脑端桌宠视线跟随。
- 对话页头像球、投屏页、连接与恢复逻辑更新。
- Android 版本：`0.5.2`（versionCode 52）。

## 桌面端 AI / DSH

- 「桥接本机 DSH」模式：`aiMode: 'api' | 'dsh'`，通过本机 `dsh --profile headless` 只转发文字对话，延续会话。
- DSH 固定运行在 `<userData>/dsh-bridge`，文件通过 `inbox` / `outbox` 传递。
- 聊天附件：图片 / 音频 / 文件选择、拖拽、粘贴，发送前做兼容性检查。
- 视觉识别支持独立配置：视觉模型、视觉路由（`auto` / `chat` / `custom`）、视觉专用地址/Key，并支持从视觉端点选择模型。
- 语音识别保留独立地址/Key/路由；AI 可通过 `send_to_user` / `[[send:...]]` 回发媒体。

## 界面与设置

- 设置页新增更新检测：启动异步检查、手动检查、前往下载。
- 视觉识别 / 语音识别统一分组；开发工作区、权限模式移入 API 配置并调整顺序。
- 模型纹理精度默认 4096，修改后自动重新加载模型。

## Live2D / 性能

- 模型纹理降采样缓存，降低大图集显存/内存占用。
- VTS 参数映射修复：`ChangeIdleAnimation` 待机组、`StopsOnLastFrame` 停帧、`UseBreathing` / `UseBlinking`、无效输入不再误占输出。

## 工程

- Electron 45 / electron-builder 26；after-pack fuses、CI、Dependabot。
- 桌面测试：297 pass / 0 fail。
- Android APK：0.5.2 debug 测试包。

## 版本

- 桌面端：`1.1.0`
- Android：`0.5.2`
