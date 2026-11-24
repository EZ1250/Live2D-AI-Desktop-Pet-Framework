# DSH 后台自动拉起 + 内置电脑控制

## 1. 桥接 DSH 自动拉起（不依赖 computer-use 插件）

- 触发：DSH 桥接第一次处理对话时（`DshBridge.processQueue` → `ensureWebRunning`）。
- 检测：PowerShell `Get-CimInstance Win32_Process`，只匹配 `node.exe ... dsh/lib/bin.js web|desktop` 或 `dsh*.exe`；排除 PowerShell/cmd 自身。
- 启动：没有则 `Start-Process -WindowStyle Minimized` 拉起 `dsh web`；失败回退 detached spawn。
- 防重复：模块级单例 Promise + DshBridge Promise 缓存；先查再启动，启动后轮询确认。
- 失败只记日志，不阻断 DSH headless 对话。

## 2. 内置电脑控制（不依赖 dsh-computer-use-win）

- UI 助手：`local-assets/ui-helper/PetUi.exe`（C# UIAutomation，自带打包）
- 输入助手：`local-assets/mouse-helper/PetMouse.exe`（移动/点击/双击/右键/滚动/组合键/剪贴板文字）
- 不修改用户 mcp.json；不依赖 DSH 插件；打包通过 electron-builder extraResources 携带两个 helper。

### 原生 agent 工具（9 个）

| 工具 | 作用 | 只读 |
|---|---|---|
| `computer_list_windows` | 列出顶层窗口（hwnd/title/class/pid/坐标/是否前台） | 是 |
| `computer_ui_tree` | 读取指定窗口 UIA 控件树 | 是 |
| `computer_ui_find` | 按 name/type/automationId/class 查控件与可用 pattern | 是 |
| `computer_window_activate` | 恢复并切前台 | 否 |
| `computer_ui_click` | 点击控件（InvokePattern 或控件中心） | 否 |
| `computer_ui_type` | 写入输入框（ValuePattern/剪贴板输入） | 否 |
| `computer_key_press` | 组合键，如 ctrl+a / alt+tab / enter | 否 |
| `computer_mouse_scroll` | 滚轮滚动（可选 DIP 坐标） | 否 |
| `computer_screen_click` | 按 DIP 屏幕坐标点击/双击/右键 | 否 |

- 动作类工具在 `mainImpl.executeComputerTool` 中弹用户确认；只读工具直接执行。
- 截图复用现有 `screen_capture`；活动窗口复用 `active_window_get`；启动应用复用 `open_path`/`shell_run`。
- 超时：computer_* 在 ChatClient 中放宽到 120s。

## 3. 辅助程序

| 文件 | 说明 |
|---|---|
| `local-assets/ui-helper/PetUi.exe` | UIAutomation 窗口/控件树/查找/聚焦/设置值/点击/激活 |
| `local-assets/mouse-helper/PetMouse.exe` | move/click/doubleclick/rightclick/scroll/key/text；PerMonitorV2 |
| `local-assets/ui-helper/PetUi.cs` | 可重新编译源码 |
| `local-assets/mouse-helper/PetMouse.cs` | 可重新编译源码 |

重新编译（Windows .NET Framework）：
```
csc /target:exe /out:PetUi.exe /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:"%WPF%\UIAutomationClient.dll" /r:"%WPF%\UIAutomationTypes.dll" /r:"%WPF%\WindowsBase.dll" PetUi.cs
```

## 4. 验证

- `npm test` **297/297 pass**
- `computer_list_windows` 实测返回窗口；`computer_ui_tree` / `computer_ui_find` 对 Edge 窗口返回数据。
- `PetUi.exe windows` 实测返回 11 个顶层窗口。
- 插件依赖已移除，`dsh-computer-use-win` 不再出现在运行代码/docs 流程中。

## 5. 风险

- UAC/更高完整性进程无法操作；
- 自绘/游戏控件可能没有 UIA，需截图+坐标点击；
- 前台切换可能被 Windows 阻止；
- 剪贴板文字注入会短暂占用剪贴板；
- 辅助程序未签名，安全软件可能拦截；
- 动作类工具默认每次确认。
