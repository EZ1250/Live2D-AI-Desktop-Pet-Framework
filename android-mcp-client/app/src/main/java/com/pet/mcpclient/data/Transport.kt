/**
MCP 传输层：HTTP POST /mcp 与 WebSocket /ws 两种通道。
 * 说明：WS 支持服务端通知（头像帧）；baseUrl 兼容用户粘贴 .../mcp 完整地址。
 */
package com.pet.mcpclient.data

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.contentOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** 电脑端提示里常是完整 .../mcp 地址；客户端自己会拼 /mcp 或 /ws，这里去掉重复后缀 */
fun normalizeBaseUrl(raw: String): String {
    var base = raw.trim().trimEnd('/')
    // 公网域名/隧道地址常不带协议：默认 http://（https/wss 由调用方替换）
    if (base.isNotEmpty() && !base.startsWith("http://") && !base.startsWith("https://")) base = "http://$base"
    while (base.endsWith("/mcp") || base.endsWith("/ws")) {
        base = base.removeSuffix("/mcp").removeSuffix("/ws").trimEnd('/')
    }
    return base
}

/** 一条 MCP 请求通道；WS 主、HTTP 回退（VCPToolBox 双通道思路） */
interface McpTransport {
    val label: String
    suspend fun start()
    suspend fun request(payload: String, timeoutMs: Long): String
    fun close()
}

class HttpTransport(private val server: ServerConfig) : McpTransport {
    private val client = OkHttpClient.Builder()
        .callTimeout(30, TimeUnit.SECONDS)
        .build()
    private val url = normalizeBaseUrl(server.baseUrl) + "/mcp"
    override val label = "HTTP"

    override suspend fun start() = Unit

    override suspend fun request(payload: String, timeoutMs: Long): String = withContext(Dispatchers.IO) {
        withTimeout(timeoutMs) {
            val request = Request.Builder()
                .url(url)
                .post(payload.toRequestBody("application/json".toMediaType()))
                .header("Authorization", "Bearer ${server.token}")
                .build()
            client.newCall(request).execute().use { resp ->
                val body = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) throw McpException("HTTP ${resp.code}: ${body.take(300)}", resp.code)
                extract(body)
            }
        }
    }

    /** 兼容 application/json 与 text/event-stream（SSE data: 行，取最后一个有效消息） */
    private fun extract(body: String): String {
        if (body.trimStart().startsWith("{")) return body
        return body.lineSequence()
            .filter { it.startsWith("data:") }
            .map { it.removePrefix("data:").trim() }
            .lastOrNull { it.isNotBlank() && it != "[DONE]" }
            ?: body
    }

    override fun close() = client.dispatcher.executorService.shutdown()
}

class WsTransport(private val server: ServerConfig) : McpTransport {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private val pending = ConcurrentHashMap<Long, CompletableDeferred<String>>()
    private var ws: WebSocket? = null
    /** 连接是否还活着（服务端/隧道正常 close 时不会走 onFailure，必须自己维护） */
    @Volatile
    var alive: Boolean = false
    var onNotification: ((method: String, params: JsonObject) -> Unit)? = null
    /** 通过 WS 发一条客户端通知（如 pet/confirmReply）；HTTP 通道不可用 */
    override val label = "WebSocket"

    private fun failPending(sock: WebSocket?) {
        alive = false
        val err = McpException("WebSocket 已断开")
        pending.values.forEach { it.completeExceptionally(err) }
        pending.clear()
        if (sock != null && ws === sock) ws = null
    }

    override suspend fun start() = suspendCancellableCoroutine<Unit> { cont ->
        val wsUrl = normalizeBaseUrl(server.baseUrl)
            .replaceFirst("https://", "wss://")
            .replaceFirst("http://", "ws://") + "/ws?token=" + server.token
        ws = client.newWebSocket(Request.Builder().url(wsUrl).build(), object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                alive = true
                if (cont.isActive) cont.resume(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val obj = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull() ?: return
                val id = obj["id"]?.jsonPrimitive?.longOrNull
                if (id == null) {
                    val method = obj["method"]?.jsonPrimitive?.contentOrNull
                    if (method != null) onNotification?.invoke(method, obj["params"]?.jsonObject ?: JsonObject(emptyMap()))
                    return
                }
                pending.remove(id)?.complete(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val err = McpException("WebSocket 断开：${t.message ?: "未知错误"}")
                alive = false
                pending.values.forEach { it.completeExceptionally(err) }
                pending.clear()
                if (ws === webSocket) ws = null
                if (cont.isActive) cont.resumeWithException(err)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // 服务端/隧道按规范关闭：让调用方立刻失败，恢复循环据此重新升级 WS
                failPending(webSocket)
            }
        })
    }

    fun sendNotification(method: String, params: JsonObject): Boolean {
        return try {
            val sock = ws ?: return false
            sock.send(JsonObject(mapOf("jsonrpc" to JsonPrimitive("2.0"), "method" to JsonPrimitive(method), "params" to params)).toString())
            true
        } catch (_: Exception) {
            false
        }
    }

    override suspend fun request(payload: String, timeoutMs: Long): String {
        val id = json.parseToJsonElement(payload).jsonObject["id"]?.jsonPrimitive?.longOrNull
            ?: throw McpException("请求缺少 id")
        if (!alive) throw McpException("WebSocket 已断开")
        val deferred = CompletableDeferred<String>()
        pending[id] = deferred
        if (ws?.send(payload) != true) {
            pending.remove(id)
            throw McpException("WebSocket 未连接")
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    override fun close() {
        alive = false
        ws?.close(1000, "bye")
        ws = null
        pending.values.forEach { it.completeExceptionally(McpException("连接已关闭")) }
        pending.clear()
        client.dispatcher.executorService.shutdown()
    }
}

/** 连接：先尝试 WS，失败自动降级 HTTP；返回实际通道名 */
suspend fun openTransport(server: ServerConfig): Pair<McpTransport, String> {
    val ws = WsTransport(server)
    return runCatching {
        withTimeout(8_000) { ws.start() }
        ws to ws.label
    }.getOrElse {
        ws.close()
        val http = HttpTransport(server)
        http to http.label
    }
}
