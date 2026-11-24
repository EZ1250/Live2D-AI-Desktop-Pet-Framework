# Pet v1.1.1

## 电脑操作能力

- 新增 `computerUseTools` 与 `tools/catalog/computer.ts`：把 PC 界面操作接入 DSH / 工具调用。
- 新增 `PetUi.exe` UI helper，用于界面元素识别与操作。
- 更新 `PetMouse.exe`：增强鼠标移动/点击/坐标换算能力。
- 新增 `dshWebManager`，完善 DSH 的网页/浏览器侧管理。
- 新增 `docs/DSH_COMPUTER_USE.md` 与 `docs/FEATURE_MATRIX.md`。

## DSH 与附件

- DSH 附件安全检查、附件处理测试补齐。
- 投屏抓帧参数与媒体处理更新。
- 更新 MCP client / server 相关调用链。

## 提示词

- 提示词分层顺序调整（第 1~4 层），并新增 `tests/promptOrder.test.js` 固定注入顺序。

## Android

- 版本：`0.5.3`（versionCode 53）。
- 投屏、传输与连接状态处理更新。

## 工程

- 桌面端测试：**302 pass / 0 fail**。
- 新增 `tests/dshAttachmentSafety.test.js`、`tests/dshAttachments.test.js`、`tests/promptOrder.test.js`。

## 版本

- 桌面端：`1.1.1`
- Android：`0.5.3`
