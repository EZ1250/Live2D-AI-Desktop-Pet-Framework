/**
MCP 客户端：initialize / tools.list / tools.call / 头像流订阅。
 * 说明：工具名一律来自服务端；超时与错误映射集中在这里；
 * 传输层实现见 Transport.kt（WS 主、HTTP 回退）。
 */
package com.pet.mcpclient.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 极简 MCP 客户端：只实现 initialize / tools/list / tools/call / ping。
 * 工具名与 schema 全部来自服务端返回，客户端不内置任何工具名（要求：不硬编码）。
 */
class McpClient {
    private val json = Json { ignoreUnknownKeys = true }
    private var transport: McpTransport? = null
    private var serverConfig: ServerConfig? = null
    private var nextId = 1L
    var channel: String = "—"
        private set

    val isConnected: Boolean get() = transport != null
    /** 仅 WS 能收到服务端通知（头像帧）；HTTP 回退后重发 avatarStart 也没用 */
    fun canReceiveNotifications(): Boolean {
        val t = transport
        return t is WsTransport && t.alive
    }

    suspend fun connect(server: ServerConfig, preferWebSocket: Boolean = true) {
        disconnect()
        serverConfig = server
        transport = if (preferWebSocket) {
            openTransport(server).also { channel = it.second }.first
        } else {
            HttpTransport(server).also { channel = it.label }
        }
        initialize()
    }

    /**
     * 尝试把当前通道升级为 WS：新连接成功后才替换，失败不动现有 transport。
     * 恢复循环用它，避免"每 8s connect() = 先 disconnect 现有通道"把在途请求打断。
     */
    suspend fun tryUpgradeToWs(): Boolean {
        val cfg = serverConfig ?: return false
        if (canReceiveNotifications()) return true
        val ws = WsTransport(cfg)
        return try {
            withTimeout(8_000) { ws.start() }
            val old = transport
            transport = ws
            channel = ws.label
            try { old?.close() } catch (_: Exception) { /* 旧通道已不可用 */ }
            true
        } catch (e: Exception) {
            ws.close()
            false
        }
    }

    private suspend fun initialize() {
        val params = buildJsonObject {
            put("protocolVersion", "2025-06-18")
            put("capabilities", buildJsonObject {})
            put("clientInfo", buildJsonObject {
                put("name", "pet-mcp-android")
                put("version", "0.1.0")
            })
        }
        request("initialize", params, 8_000)
        notify("notifications/initialized")
    }

    suspend fun listTools(): List<ToolInfo> {
        val result = request("tools/list", buildJsonObject {}, 15_000).jsonObject
        val list = result["tools"]?.jsonArray ?: JsonArray(emptyList())
        return list.mapNotNull { element ->
            runCatching {
                val obj = element.jsonObject
                val annotations = obj["annotations"]?.jsonObject
                ToolInfo(
                    name = obj["name"]?.jsonPrimitive?.content ?: return@runCatching null,
                    description = obj["description"]?.jsonPrimitive?.content ?: "",
                    inputSchema = obj["inputSchema"]?.jsonObject ?: JsonObject(emptyMap()),
                    annotations = ToolAnnotations(
                        readOnlyHint = annotations?.get("readOnlyHint")?.jsonPrimitive?.content?.toBoolean() ?: false,
                        destructiveHint = annotations?.get("destructiveHint")?.jsonPrimitive?.content?.toBoolean() ?: false,
                        timeoutMs = annotations?.get("timeoutMs")?.jsonPrimitive?.content?.toLongOrNull(),
                    ),
                )
            }.getOrNull()
        }
    }

    suspend fun callTool(tool: ToolInfo, args: JsonObject): JsonElement {
        val timeout = tool.annotations.timeoutMs ?: 20_000
        return request("tools/call", buildJsonObject {
            put("name", tool.name)
            put("arguments", args)
        }, timeout)
    }

    /** 手机原生工具注册（PC 端 phone/register 扩展；未实现时静默失败由调用方提示） */
    suspend fun registerPhoneTools(tools: JsonArray): JsonElement =
        request("phone/register", buildJsonObject { put("tools", tools) }, 8_000)

    /**
     * 长轮询电脑端待执行的手机工具调用；没有任务时返回 null。
     * 超时按 waitMs + 请求余量算，避免服务端刚好处在 25s 长轮询时客户端先超时。
     */
    suspend fun phonePoll(waitMs: Long = 25_000): JsonObject? {
        val result = request("phone/poll", buildJsonObject { put("waitMs", waitMs) }, waitMs + 10_000)
        val obj = result as? JsonObject ?: return null
        return obj["call"] as? JsonObject
    }

    /** 回执手机工具执行结果（失败也要回执，否则电脑端要等满 30s 超时） */
    suspend fun phoneResult(id: String, text: String? = null, errorMessage: String? = null) {
        val params = buildJsonObject {
            put("id", id)
            if (errorMessage != null) {
                put("error", buildJsonObject { put("message", errorMessage) })
            } else {
                put("text", text ?: "")
            }
        }
        runCatching { request("phone/result", params, 8_000) }
    }

    private fun mapFailure(e: Exception, timeoutMs: Long): McpException {
        if (e is kotlinx.coroutines.TimeoutCancellationException) {
            return McpException("请求超时（${timeoutMs}ms）：请确认电脑端「反向接入」已启动、手机与电脑在同一 Wi-Fi、防火墙放行端口")
        }
        val msg = e.message ?: ""
        val detail = when {
            msg.contains("CLEARTEXT", ignoreCase = true) ->
                "Android 安全策略拦截了明文 HTTP：本 App 已放行局域网 http，请确认地址以 http:// 开头"
            msg.contains("timeout", ignoreCase = true) || msg.contains("超时") ->
                "连接超时（${timeoutMs}ms）：请确认电脑端「反向接入」已启动、手机与电脑同一 Wi-Fi、防火墙放行端口"
            msg.contains("WebSocket", ignoreCase = true) ->
                "连接已断开（WebSocket 掉线且 HTTP 也失败）：请点「重连」，或检查电脑端服务是否还在运行"
            msg.contains("Failed to connect", ignoreCase = true) || msg.contains("Connection refused", ignoreCase = true) ->
                "无法连接：地址或端口不对，或电脑端服务未监听"
            msg.contains("UnknownHost", ignoreCase = true) ->
                "地址解析失败：请填电脑的局域网 IP，例如 http://192.168.1.10:37653"
            else -> "请求失败：${msg.ifBlank { "未知错误" }}"
        }
        return McpException(detail)
    }

    private suspend fun request(method: String, params: JsonObject, timeoutMs: Long): JsonElement {
        return try {
            requestInner(method, params, timeoutMs)
        } catch (e: TimeoutCancellationException) {
            // 超时是 TimeoutCancellationException（CancellationException 的子类）：必须单独映射成人话
            throw McpException(mapFailure(e, timeoutMs).message ?: "请求超时")
        } catch (e: CancellationException) {
            throw e
        } catch (e: McpException) {
            throw e // 服务器/传输层已经给了明确错误，不再按关键字二次改写
        } catch (e: Throwable) {
            throw McpException(mapFailure(e as? Exception ?: Exception(e.message), timeoutMs).message ?: "请求失败")
        }
    }

    /** WS 断开时改用 HTTP 重发一次；成功后关闭旧 transport，失败则保留错误信息 */
    private suspend fun fallbackToHttp(payload: String, timeoutMs: Long, cause: Exception?): String {
        val cfg = serverConfig ?: throw McpException("尚未连接电脑端")
        val http = HttpTransport(cfg)
        val raw = try {
            http.request(payload, timeoutMs).also {
                val old = transport
                transport = http
                channel = "HTTP（WS 已断开，自动回退）"
                try { old?.close() } catch (_: Exception) { /* 旧通道已断开 */ }
            }
        } catch (e: TimeoutCancellationException) {
            try { http.close() } catch (_: Exception) { /* ignore */ }
            throw McpException(mapFailure(e, timeoutMs).message ?: "请求超时")
        } catch (e: CancellationException) {
            try { http.close() } catch (_: Exception) { /* ignore */ }
            throw e
        } catch (e: Exception) {
            try { http.close() } catch (_: Exception) { /* ignore */ }
            val mapped = mapFailure(e, timeoutMs)
            throw if (cause != null) McpException("${mapped.message}（${cause.message ?: "WS 不可用"}）") else mapped
        }
        return raw
    }

    private suspend fun requestInner(method: String, params: JsonObject, timeoutMs: Long): JsonElement {
        val t = transport ?: throw McpException("尚未连接电脑端")
        val payload = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", nextId++)
            put("method", method)
            put("params", params)
        }.toString()
        val raw = if (t is WsTransport && !t.alive) {
            fallbackToHttp(payload, timeoutMs, null)
        } else {
            try {
                t.request(payload, timeoutMs)
            } catch (e: TimeoutCancellationException) {
                throw e // 交给 request() 统一映射，别按连接错误改写
            } catch (e: McpException) {
                if (t is WsTransport) fallbackToHttp(payload, timeoutMs, e) else throw mapFailure(e, timeoutMs)
            } catch (e: Exception) {
                throw mapFailure(e, timeoutMs)
            }
        }
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }
            .getOrElse { throw McpException("响应不是合法 JSON：${raw.take(200)}") }
        val error = obj["error"]?.jsonObject
        if (error != null) {
            val message = error["message"]?.jsonPrimitive?.content ?: "服务端返回错误"
            val code = error["code"]?.jsonPrimitive?.content?.toIntOrNull()
            throw McpException(message, code)
        }
        return obj["result"] ?: throw McpException("响应缺少 result")
    }

    private suspend fun notify(method: String) {
        val t = transport ?: return
        if (t is WsTransport) {
            // WS 通道必须用"通知帧"（无 id）；用 request 发会被当成缺 id 的请求直接失败
            t.sendNotification(method, JsonObject(emptyMap()))
            return
        }
        runCatching {
            t.request(buildJsonObject { put("jsonrpc", "2.0"); put("method", method) }.toString(), 2_000)
        }
    }

    /** 订阅 WS 通知（头像帧），重复连接会覆盖旧回调 */
    /** 回执手机端确认（仅 WS） */
    fun sendPhoneConfirmReply(id: String, choice: String): Boolean {
        val t = transport
        if (t !is WsTransport) return false
        return t.sendNotification("pet/confirmReply", buildJsonObject {
            put("id", id)
            put("choice", choice)
        })
    }

    fun setNotificationListener(listener: ((method: String, params: JsonObject) -> Unit)?) {
        val t = transport
        if (t is WsTransport) t.onNotification = listener
    }

    suspend fun avatarStart(maxWidth: Int = 300) {
        request("pet/avatarStart", buildJsonObject { put("maxWidth", maxWidth) }, 8_000)
    }

    suspend fun avatarStop() {
        runCatching { request("pet/avatarStop", buildJsonObject {}, 3_000) }
    }

    fun disconnect() {
        transport?.close()
        transport = null
        channel = "—"
    }
}
