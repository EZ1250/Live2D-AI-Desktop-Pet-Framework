# Pet MCP — Android 客户端

远程连接电脑端桌宠的 MCP 服务端（`http://<pc-ip>:37653/mcp` + Bearer token）。
工具清单连接后从 `tools/list` 运行时拉取；HTTP + WebSocket 双通道（WS 优先，失败自动回退 HTTP）；
所有调用带超时与可读错误；手机原生能力可通过 `phone/register` 暴露给电脑端。

## 当前状态（v0.5.1，versionCode 51）

- 源码完整：`data/`（McpClient + WS/HTTP transport）、`ui/`（连接/工具/执行/设置 4 屏 + 对话/投屏/组合）、
  `phone/`（电量、设备信息、网络、剪贴板读写、粗略定位）。
- **头像流 v2（本次优化）**：WS 二进制帧（免 base64/JSON，省约 33% 带宽、免解析开销）、服务端可配置
  `maxWidth/fps/format/quality/binary/trim`、手机端按屏幕密度请求足够分辨率（不再 220px 放大发虚）、
  Bitmap 复用解码（`inBitmap`，30fps 下避免每帧 ~2MB 分配）、Compose 仅在 draw 阶段更新头像
  （不再每帧重组整个对话页）、解码慢/失败自动降清晰度、后台自动暂停。
- **对话页自动显示桌宠（默认开启）**：进入对话页自动开头像流，离开自动停（省电），可在设置页关闭/切换清晰度。
- **头像黑方框修复（v0.3.9）**：头像球的 clip(CircleShape) 必须在 ackground/border 之前，否则深色圆底不裁剪会溢出成黑色方块。
- **头像球大小（v0.4.1）**：设置页可选中/大/超大（默认 260dp，接近源窗口 711px 的 1:1 显示）。
- **电脑投屏 v2（v0.3.9）**：独立 WS 连接订阅 pet/castStart 二进制 JPEG 帧（不再走 pet_screenshot 1fps），支持横屏/双指缩放拖动；旧电脑端自动降级 1fps。
- **未接真机验证**；无自动化测试。仓库只提交源码，APK 请用 Android Studio 构建（不纳入版本库）。
- 电脑端桥接（LAN 开关、`/ws`、`phone/register|poll|result`）见 `../docs/ANDROID_MCP_CLIENT.md`。

## 构建

- JDK 17 + Android Studio（Ladybug 或更新）+ Android SDK 35。
- 用 Android Studio 打开本目录，首次会自动生成 Gradle wrapper 并下载依赖；
  `local.properties` 由 IDE 生成，不要提交。
- 命令行构建（生成 wrapper 后）：`./gradlew assembleDebug`。

## 目录

- `data/`：MCP JSON-RPC 客户端、WS/HTTP 双通道、工具模型、超时与错误映射
- `ui/`：连接页、工具列表页、执行页（schema 默认参数 + 危险确认）、设置/自检页
- `phone/`：手机原生能力注册表 + 各能力实现

## 手测清单

1. 电脑端设置 → MCP → 开启「反向接入」；需要手机直连时勾选「允许局域网访问」并放行防火墙，记下端口与 token。
2. 手机与电脑同一 Wi-Fi，填 `http://<电脑IP>:<端口>` + token，连接后状态行显示通道。
3. 工具页数量/名称与电脑端 `tools/list` 一致；电脑端增删工具后手机刷新即变。
4. 执行只读工具（如 `pet_status`）显示耗时与内容；错误参数显示可读错误。
5. 执行写类工具（如 `pet_say` / `pet_todo_add`）应弹二次确认；取消则不发请求。
6. 设置页点「注册手机工具」后，电脑端 `tools/list` 出现 `phone_*`；电脑端调用能在手机上执行并回执。
7. 关闭电脑端服务再刷新，应提示请求失败（不崩溃）；恢复后自动重连。

## 安全

- token 目前只在内存中保存（不落盘），服务器地址存普通 SharedPreferences。
- 局域网走明文 HTTP（App 已显式允许 cleartext），仅建议可信 Wi-Fi；跨公网请用 HTTPS/WSS 隧道。
- 电脑端设置里的完整 `http://ip:port/mcp` 地址可直接粘贴，客户端会自动去掉重复的 `/mcp`/`/ws` 后缀，
  不写协议时自动补 `http://`。
- 写类/危险工具执行前必须二次确认；电脑端对手机工具调用默认 30s 超时，超时视为失败。
- 定位权限需在系统设置里授予（App 内暂未做权限申请 UI）。
