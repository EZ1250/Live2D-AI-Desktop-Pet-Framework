package com.pet.mcpclient.data

import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 投屏专用 WS 连接：
 * - 与主 MCP 连接分开，避免投屏二进制帧和头像帧混流；
 * - `pet/castStart` 后电脑端持续推 JPEG 二进制帧（renderer getDisplayMedia 抓屏）；
 * - 旧电脑端不支持 castStart 时抛错，AppState 会降级到 pet_screenshot 1fps。
 */
class CastStreamClient(private val server: ServerConfig) {
    private val json = Json { ignoreUnknownKeys = true }
    private val transport = WsTransport(server)
    private var nextId = 1L

    var onFrame: ((ByteArray) -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    @Volatile
    var alive: Boolean = false
        private set

    data class Options(
        val maxWidth: Int = 1280,
        val fps: Int = 24,
        val quality: Int = 70,
        val display: Int = 1,
    )

    suspend fun start(opts: Options = Options()) {
        transport.onBinaryFrame = { bytes -> onFrame?.invoke(bytes) }
        withTimeout(6_000) { transport.start() }
        val id = nextId++
        val payload = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", "pet/castStart")
            put("params", buildJsonObject {
                put("maxWidth", opts.maxWidth)
                put("fps", opts.fps)
                put("quality", opts.quality)
                put("display", opts.display)
                put("binary", true)
            })
        }.toString()
        val raw = transport.request(payload, 8_000)
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
        val error = obj?.get("error")?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
        if (error != null) {
            transport.close()
            throw McpException("电脑端不支持投屏流：$error")
        }
        alive = true
    }

    /** 双击投屏：把归一化坐标发给电脑端移动鼠标 */
    suspend fun moveMouse(nx: Double, ny: Double, display: Int = 1): JsonElement =
        rpc("pet/mouseMove", buildJsonObject {
            put("x", nx.coerceIn(0.0, 1.0))
            put("y", ny.coerceIn(0.0, 1.0))
            put("display", display)
        })

    /** 三击投屏：移动鼠标并左键单击 */
    suspend fun clickMouse(nx: Double, ny: Double, display: Int = 1): JsonElement =
        rpc("pet/mouseClick", buildJsonObject {
            put("x", nx.coerceIn(0.0, 1.0))
            put("y", ny.coerceIn(0.0, 1.0))
            put("display", display)
        })

    /** 长按 3s：鼠标右键 */
    suspend fun rightClickMouse(nx: Double, ny: Double, display: Int = 1): JsonElement =
        rpc("pet/mouseRightClick", buildJsonObject {
            put("x", nx.coerceIn(0.0, 1.0))
            put("y", ny.coerceIn(0.0, 1.0))
            put("display", display)
        })

    /** 当前电脑焦点是否可输入（自动弹手机输入法） */
    suspend fun isEditableFocused(): Boolean {
        val result = rpc("pet/inputFocus", buildJsonObject { })
        return result.jsonObject["editable"]?.jsonPrimitive?.content?.toBoolean() == true
    }

    /** 把手机输入法文字注入电脑当前焦点（剪贴板 + Ctrl+V） */
    suspend fun typeText(text: String): JsonElement =
        rpc("pet/typeText", buildJsonObject { put("text", text.take(4000)) })

    private suspend fun rpc(method: String, params: kotlinx.serialization.json.JsonObject): JsonElement {
        val id = nextId++
        val payload = buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("method", method)
            put("params", params)
        }.toString()
        val raw = transport.request(payload, 3_000)
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()
            ?: throw McpException("电脑端返回无法解析")
        val error = obj["error"]?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull
        if (error != null) throw McpException(error)
        return obj["result"] ?: throw McpException("电脑端未返回结果")
    }

    fun stop() {
        alive = false
        runCatching { transport.sendNotification("pet/castStop", buildJsonObject {}) }
        runCatching { transport.close() }
    }
}
