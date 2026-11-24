# 功能效果分类与生命周期矩阵

## 1. 效果域分类

| 效果域 | 功能 | 主要代码归属 | 生命周期归属 |
|---|---|---|---|
| 陪伴表达 | 动画/气泡/视线/待机 tick/时间事件/情景记忆 | `mainImpl`、`gazeInput`、`sceneContext`、`autonomy` | `shutdown` 清 tick/气泡/时间事件/gaze；窗口销毁 |
| 对话生成 | API 对话、任务/聊天判别、四层提示词、工具循环 | `chatClient`、`promptLayers` | 每次 chat 的 generation；cancel/reset；分类请求可取消检查 |
| 工具执行 | 内置工具、外部 MCP、后台任务 | `tools/catalog`、`mainImpl.toolExecutor`、`mcpClient` | 工具超时/取消；`shutdown` dispose |
| 电脑控制 | 窗口/控件/键鼠/坐标点击 | `computerUseTools`、`tools/catalog/computer`、`PetUi/PetMouse` | 子进程超时 kill；退出时 `killActiveUiHelpers`/`killActiveMouseHelpers` |
| 媒体 | 截图、投屏采集、头像、附件/回发 | `screenTools`、`castCapture`、`mediaAttachments` | PC `shutdown`/`will-quit` stop；Android 页面/前后台 |
| DSH 桥接 | 对话转交、自动拉起 DSH、附件路径、媒体回发 | `dshBridge`、`dshWebManager` | 每次对话 headless 子进程 generation；DSH web 独立后台进程 |
| 手机连接 | MCP/WS、投屏、头像流、手机确认 | Android `AppState`/`CastStreamClient`/`Transport` | `onStop` 后台停 stream；`onCleared`/disconnect 清理 jobs |
| 系统设置 | 点击穿透/托盘/快捷键/窗口 | `mainImpl` | `shutdown` 清 timer/tray/shortcuts |

结论：功能基本都有明确效果域；本轮把 `computer_*` 独立成电脑控制类，`screen_capture`/`active_window_get`/`open_path` 仍属于更基础的媒体/系统类，避免重复。DSH 桥接与原生工具执行是两条明确分开的通道。

## 2. 生命周期规则

- PC 启动：单实例锁 → bootstrap → 窗口/托盘/服务。
- 对话：每次 chat 有 generation；cancel/reset 丢弃旧回调；任务/聊天分类后检查 cancelled/generation。
- PC 退出：`before-quit → shutdown` 清 tick/gaze/bubble/timed/autoTask、点击穿透轮询、monitor、chat、toolbox、devTools、MCP client/server、VTS、castCapture、托盘/快捷键/窗口、PetUi/PetMouse 子进程。
- 手机：`onResume → onAppForeground` 恢复页面流；`onStop → onAppBackground` 停 cast/avatar；`onCleared`/disconnect 清 jobs、stream、client。
- DSH：headless 每次对话一个子进程；DSH web 是独立后台服务，桌宠退出**不**杀它（用户要求后台 DSH 持续运行）；这是有意策略，不视为泄漏。
- helper：PetUi/PetMouse 超时/退出/应用关闭均有清理；动作类工具必须确认。

## 3. 已修问题

1. 点击穿透 `setInterval(2000)` 无句柄 → 新增 `clickThroughTimer`，`shutdown` 清除。
2. PC 退出未显式停 castCapture（只在 `will-quit`）→ `shutdown` 增加 `castCaptureInstance.stop()`。
3. PetUi/PetMouse 子进程未纳入退出清理 → 新增 active child 集合 + `killActiveUiHelpers()`/`killActiveMouseHelpers()`，`shutdown` 调用。
4. 任务/聊天分类请求后未检查取消 → 分类完成后检查 `cancelled/generation`，避免取消后继续回复。
5. DSH 附件提示不完整 → 图片/音频/文本/普通文件全部复制并带 MIME/大小/路径/读取说明；音频 ASR 失败保留文件路径，不再直接丢附件。

## 4. 残余风险（P2）

- Android `transport` 切换互斥、renderer fallback cast 并发/NaN/video-track 清理、`castOn` 先置位、decoder reset race、VTS listener 清理、ChatScreen 手势合并等历史项仍需逐项处理。
- 高 DPI/UAC/自绘控件是电脑控制固有限制。
- DSH 独立进程如用户手动结束需自行处理；桌宠不杀它。
- 分类请求增加一次模型调用（成本/延迟），失败按任务处理。
