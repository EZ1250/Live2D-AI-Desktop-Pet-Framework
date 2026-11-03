# Android MCP 客户端 + 电脑端手机桥接

手机 App 远程连接电脑端桌宠的 MCP 服务端：工具清单运行时从 `tools/list` 拉取（不硬编码），
HTTP + WebSocket 双通道，所有调用带超时；手机原生能力可反向注册成 `phone_*` 工具。

## 1. 当前状态（以代码为准）

| 部分 | 状态 |
|---|---|
| PC 端 `/mcp`（HTTP JSON-RPC） | ✅ 已完成；Bearer token + timingSafeEqual，LAN 默认关闭 |
| PC 端 `/ws`（自实现 RFC6455 子集） | ✅ 能用：握手/mask/文本帧/ping-pong/close；**不支持分片/续帧**（文本 JSON-RPC 用单帧） |
| PC 端 `phone/register|unregister|poll|result` | ✅ 已完成；30s 超时 fail-closed，超时调用会从队列摘除 |
| PC 端 `pet/confirmRequest` → 手机 `pet/confirmReply` | ✅ 已完成；socket 断开/dispose 时按 disconnect 结算 |
| Android 客户端源码 | ✅ 已实现：4 屏 Compose UI、双通道、动态工具列表、超时/错误提示、手机工具注册与执行循环、头像流、投屏 |
| Android 客户端验证 | ❌ **未接真机**；无 Gradle wrapper，需 Android Studio 生成后构建；APK 不纳入版本库 |
| 自动化测试 | PC 侧有 `tests/mcpServer*.test.js`；Android 侧无自动化测试 |

## 2. 架构

```
[Android App]                     [PC: PET MCP bridge]              [PET chat / DSH / QQ bridge]
  Compose UI  ── WS /ws (JSON-RPC) ──►  MCP bridge (127.0.0.1 | LAN opt-in)
  Transport  ── HTTP POST /mcp ─────►   ├ tools/list, tools/call（PET 内置工具）
  Tool catalog (runtime)                ├ resources/list, read（pet://…）
  Phone tools ─ phone/register ──────►  ├ phone/*：注册、长轮询、回执
  执行循环 ◄ phone/poll ────────────────┤ 待执行队列 + 超时/取消
  确认 UI ◄ phone/confirmRequest ───────┤ 写类/危险工具二次确认
```

- 工具目录连接后拉取；PC 增删工具，手机刷新即可，不需要发版。
- 通道：默认 WS（持久、可接收头像/确认推送）；WS 不可用时 HTTP POST 回退。
  后台恢复循环每 8s 尝试**升级**回 WS（新连接成功才替换，不打断在用通道）。
- 超时：每个工具 `annotations.timeoutMs` 或默认 20s；连接/初始化 8s；错误在 UI 上显示可读文案。

## 3. 协议（跨端契约）

标准 MCP：`initialize`、`ping`、`tools/list`、`tools/call`、`resources/list`、`resources/read`。

桥接扩展（PC 端实现）：

| 方法 | 载荷 / 返回 |
|---|---|
| `phone/register` | `{tools:[{name, description, inputSchema, annotations:{readOnlyHint, destructiveHint, timeoutMs}}]}` → `{ok, tools:['phone_battery', …]}`（最多 32 个；名为 `[a-z][a-z0-9_]{1,31}`） |
| `phone/unregister` | `{names:[…]}` → `{ok, tools:[…]}` |
| `phone/poll` | `{waitMs:25000}` → `{call:{id, name, arguments}}` 或 `{}`（长轮询） |
| `phone/result` | `{id, result?:{content:[…]}, error?:{code,message}}`；也兼容旧的顶层 `{content}` / `{text}`。**`error` 会作为 `isError` 回给模型** |
| `pet/confirmRequest`（PC→手机推送） | `{id, tool, detail, timeoutMs}` → 手机 `pet/confirmReply {id, choice:'allow'|'deny'}` |

注意：写类/危险工具在手机端执行前要二次确认；确认请求只推给当前 WS 连接，
无 WS 连接时工具调用按 fail-closed 返回错误。

## 4. 安全边界（已实现 / 未实现）

- 已实现：默认只听 127.0.0.1；开启 LAN 需要 token（设置页生成，≥24 位）；
  HTTP 用 `Authorization: Bearer`，WS 用 `?token=` + timingSafeEqual；请求体上限 1MB。
- **未实现**（不要按"已完成"理解）：`tools/list` 的 ETag/304、Host/Origin 校验、256KB 体积上限、
  `phone/approval` 独立审批协议、token 的 Keystore 加密存储（当前只在内存）。
- token 走 WS query 会出现在隧道/反代日志里；跨公网请用 HTTPS/WSS 隧道，并知悉该风险。

## 5. 外网连接

电脑端 MCP 服务默认只监听 `127.0.0.1`。启用局域网访问后，才可从其他设备连接：

1. 端口映射/DDNS：手机填 `http://<公网IP或域名>:37653` + token。
2. 隧道（推荐）：`cloudflared tunnel --url http://127.0.0.1:37653` 或 `ngrok http 37653`，
   手机填得到的 `https://…` 地址；客户端会自动把 `https` 换成 `wss` 走通知通道。

手机端地址可以不写协议（`192.168.1.10:37653`），客户端自动补 `http://`。

## 6. Android 工程

- Kotlin + Compose Material3，minSdk 26 / targetSdk 35；单 Activity + ViewModel。
- 模块：`data/`（McpClient、WS/HTTP transport、模型）、`ui/`（4 屏 + 状态）、
  `phone/`（手机能力注册表：电量/设备信息/网络/剪贴板读写/粗略定位）。
- 构建：JDK 17 + Android Studio 打开本目录（首次自动生成 Gradle wrapper），
  `./gradlew assembleDebug`；`local.properties` 由 IDE 生成，不要提交。
- 已知限制：定位权限需在系统设置里手动授予（App 内未做权限申请 UI）；
  结果展示未做超长截断（截图/头像等大文本会整段渲染）；确认弹窗只在对话页显示。

## 7. 手测清单（需要真机）

1. PC 设置 → MCP → 开启「反向接入」，勾选「允许局域网访问」，记端口与 token。
2. 手机填地址 + token 连接：状态行显示通道（WebSocket/HTTP）。
3. 工具页数量/名称与 PC `tools/list` 一致；PC 增删工具后手机刷新可见。
4. 执行只读工具（`pet_status`）成功；错误参数显示可读错误。
5. 执行写类工具（`pet_say` / `pet_todo_add`）应弹二次确认；取消则不发请求。
6. 设置页点「注册手机工具」后，PC `/mcp` 里工具数 +N，`tools/list` 出现 `phone_*`；
   PC 侧调用 `phone_battery` 能在手机上执行并回执。
7. 断网/关闭 PC 服务：手机显示可读错误，恢复后自动重连。
8. 头像流：点头像后画面同步；断线恢复后自动重开。
