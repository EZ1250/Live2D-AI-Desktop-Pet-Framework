/**
AppViewModel：页面路由 + 连接/工具/对话/头像流/投屏/自由组合的状态与动作。
 * 说明：UI 数据模型见 UiModels.kt；MCP 协议与超时在 data/McpClient.kt；
 * 新增功能优先加"动作函数"而不是把协议细节塞进来。
 */
package com.pet.mcpclient.ui

import android.app.Application
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.min
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.pet.mcpclient.data.AvatarOptions
import com.pet.mcpclient.data.CastStreamClient
import com.pet.mcpclient.data.McpClient
import com.pet.mcpclient.data.McpException
import com.pet.mcpclient.data.ServerConfig
import com.pet.mcpclient.data.ToolInfo
import com.pet.mcpclient.phone.PhoneTools
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive

class AppViewModel(app: Application) : AndroidViewModel(app) {
    private val prefs = app.getSharedPreferences("pet_mcp", Context.MODE_PRIVATE)
    private val client = McpClient()
    private val pretty = Json { prettyPrint = true }

    var page by mutableStateOf(AppPage.HOME)
    var chatLines by mutableStateOf(listOf(ChatLine("system", "连接成功，可以开始聊天了。")))
    var remoteHistory by mutableStateOf(listOf<RemoteSession>())
        private set
    var historyBusy by mutableStateOf(false)
        private set
    var showThinking by mutableStateOf(true)
    var comboArgs by mutableStateOf(mapOf<String, String>())
        private set
    var chatBusy by mutableStateOf(false)
        private set
    var chatElapsedSec by mutableStateOf(0)
        private set
    /**
     * 头像当前帧：普通引用 + 帧号。Compose 在 **draw 阶段**读这两者，只重绘头像区域，
     * 不再每帧重组整个对话页（旧实现每帧 `avatar = ImageBitmap` 会触发整页重组，是卡顿主因之一）。
     */
    @Volatile
    var currentAvatarBitmap: Bitmap? = null
        private set
    var avatarSeq by mutableStateOf(0)
        private set
    var avatarHasFrame by mutableStateOf(false)
        private set
    /** 头像清晰度预设：sharp(清晰) / balanced(均衡) / smooth(流畅) / data(省流) */
    var avatarQuality by mutableStateOf(prefs.getString("avatarQualityV4", "transparent") ?: "transparent")
        private set
    /** 打开对话页时自动显示桌宠（默认开启） */
    var autoAvatarOnChat by mutableStateOf(prefs.getBoolean("autoAvatarOnChat", true))
        private set
    /** 对话页头像球大小（dp）：源窗口约 711px，大球 260dp≈715px 可接近 1:1 显示 */
    var avatarBallSizeDp by mutableStateOf(prefs.getInt("avatarBallSizeDpV2", 210))
        private set

    /** 投屏点击后若电脑焦点是输入框，自动弹手机输入法 */
    var castKeyboardWanted by mutableStateOf(false)
        private set
    /** 当前头像是否透明 PNG（决定磨砂球背景；JPEG 黑底时用深色球） */
    val avatarTransparent: Boolean get() = avatarQuality == "transparent"

    var pendingConfirm by mutableStateOf<PhoneConfirm?>(null)
        private set
    var avatarOn by mutableStateOf(false)
        private set
    /** 投屏当前帧：draw 阶段读取 + 帧号，避免每帧重组整个页面 */
    @Volatile
    var currentCastBitmap: Bitmap? = null
        private set
    var castSeq by mutableStateOf(0)
        private set
    var castHasFrame by mutableStateOf(false)
        private set
    var castOn by mutableStateOf(false)
        private set
    var comboSelected by mutableStateOf(emptySet<String>())
        private set
    var comboResults by mutableStateOf(listOf<String>())
        private set
    var comboBusy by mutableStateOf(false)
        private set
    private var castLastErrorAt = 0L
    private var castMouseErrorAt = 0L
    private val castDecoder = AvatarFrameDecoder()
    private val castDecoding = AtomicBoolean(false)
    private val castPendingBytes = AtomicReference<ByteArray?>(null)
    private var castClient: CastStreamClient? = null
    private var castStreamJob: Job? = null
    private var castFrameIdleAt = 0L
    /** 解码只允许一个协程：CAS 原子标志 + “只保留最新一帧”的待解码队列（避免解码期间帧全丢） */
    private val avatarDecoding = AtomicBoolean(false)
    private val avatarPendingBytes = AtomicReference<ByteArray?>(null)
    @Volatile
    private var lastAvatarAt = 0L
    private var avatarDecodeFailures = 0
    private var lastAvatarAcceptedAt = 0L
    private var avatarRetryCount = 0
    private var avatarRetryAt = 0L
    private var avatarWatchJob: Job? = null
    private var avatarAutoStarted = false
    private var appForeground = true
    private val avatarDecoder = AvatarFrameDecoder()
    /** 旧版电脑端没有 binary/trim 能力：自动退回 320px/PNG/20fps 兼容模式 */
    private var legacyAvatarServer = false
    private var decodeEmaMs = 0.0
    private var decodeSlowStreak = 0
    private var lastQualityDownAt = 0L
    private var wsRecoveryJob: Job? = null
    private var phonePollJob: Job? = null
    var host by mutableStateOf(prefs.getString("host", "") ?: "")
    var token by mutableStateOf("")
    var connected by mutableStateOf(false)
        private set
    var channel by mutableStateOf("—")
        private set
    var tools by mutableStateOf<List<ToolInfo>>(emptyList())
        private set
    var filter by mutableStateOf("")
    var selected by mutableStateOf<ToolInfo?>(null)
        private set
    var argsText by mutableStateOf("{}")
    var result by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
        private set
    var showConfirm by mutableStateOf(false)
    var showSettings by mutableStateOf(false)
    var logs by mutableStateOf<List<String>>(emptyList())
        private set
    var phoneToolCount by mutableStateOf(0)
        private set

    init {
        phoneToolCount = PhoneTools.tools(app).size
    }

    private fun log(line: String) {
        logs = (listOf(line) + logs).take(30)
    }

    fun connect() {
        if (busy) return
        val url = host.trim()
        val tok = token.trim()
        if (url.isBlank()) { error = "请填写电脑端地址"; return }
        if (tok.isBlank()) { error = "请填写 token（电脑端 MCP 设置里生成）"; return }
        busy = true; error = null; result = null
        viewModelScope.launch {
            try {
                prefs.edit().putString("host", url).apply()
                client.connect(ServerConfig(url.trimEnd('/'), tok))
                channel = client.channel
                connected = true
                tools = client.listTools()
                installPhoneNotifications()
                page = AppPage.HOME
                log("已连接（${client.channel}），发现 ${tools.size} 个工具")
                registerPhoneTools()
                startPhonePolling()
                startWsRecovery()
                // 若在对话页里点「重连/连接」，连上后立即补显示桌宠
                if (page == AppPage.CHAT && autoAvatarOnChat && appForeground && !avatarOn) startAvatar(auto = true)
                if (page == AppPage.CAST && appForeground && !castOn) startCast()
            } catch (e: Exception) {
                error = (e as? McpException)?.message ?: "连接失败：${e.message ?: "未知错误"}"
                log("连接失败：${e.message}")
                client.disconnect()
                connected = false
            } finally {
                busy = false
            }
        }
    }

    /** WS 掉线自动恢复：只在"当前没有 WS 通知能力"时尝试升级，且不打断在用通道 */
    private fun startWsRecovery() {
        wsRecoveryJob?.cancel()
        wsRecoveryJob = viewModelScope.launch {
            while (connected) {
                delay(8000)
                if (!connected) break
                if (client.canReceiveNotifications()) continue
                val upgraded = runCatching { client.tryUpgradeToWs() }.getOrElse { err ->
                    log("WS 通道恢复失败：${err.message ?: "未知错误"}")
                    false
                }
                if (!upgraded) continue
                channel = client.channel
                installPhoneNotifications()
                if (avatarOn) runCatching { requestAvatarStart() }
                else if (page == AppPage.CHAT && autoAvatarOnChat && appForeground) startAvatar(auto = true)
                log("WS 通知通道已恢复（${client.channel}）")
            }
        }
    }

    private fun installPhoneNotifications() {
        client.setNotificationListener { method, params ->
                    if (method == "pet/confirmRequest") {
                        val p = params
                        pendingConfirm = PhoneConfirm(
                            id = p["id"]?.jsonPrimitive?.content ?: "",
                            tool = p["tool"]?.jsonPrimitive?.content ?: "工具",
                            detail = p["detail"]?.jsonPrimitive?.content ?: "",
                        )
                        return@setNotificationListener
                    }
                    if (method == "pet/avatarFrame") {
                        // 旧服务端兼容：JSON + base64（新服务端 binary=true 时不会走这里）
                        val bytes = params["data"]?.jsonPrimitive?.content
                            ?.let { runCatching { Base64.decode(it, Base64.DEFAULT) }.getOrNull() }
                            ?: return@setNotificationListener
                        decodeAvatarBytes(bytes)
                    }
                }
        // WS 二进制帧（新协议）：图片原始字节，直接解码
        client.setBinaryFrameListener { bytes -> decodeAvatarBytes(bytes) }
    }

    /**
     * 接收一帧头像：只保留最新一帧待解码（解码慢时丢旧帧，不积压延迟）。
     * 解码在 Default 单协程串行执行；bitmap 只在 Main 线程发布。
     */
    private fun decodeAvatarBytes(bytes: ByteArray) {
        if (!avatarOn || bytes.isEmpty()) return
        avatarPendingBytes.set(bytes)
        if (!avatarDecoding.compareAndSet(false, true)) return
        viewModelScope.launch(Dispatchers.Default) {
            try {
                while (avatarOn) {
                    val data = avatarPendingBytes.getAndSet(null) ?: break
                    decodeAndPublish(data)
                }
            } finally {
                avatarDecoding.set(false)
            }
        }
    }

    private suspend fun decodeAndPublish(bytes: ByteArray) {
        val t0 = System.nanoTime()
        try {
            val bmp = avatarDecoder.decode(bytes)
            if (bmp == null) {
                avatarDecodeFailures += 1
                if (avatarDecodeFailures == 10) log("头像帧连续解码失败 10 次")
                return
            }
            val decodeMs = (System.nanoTime() - t0) / 1_000_000.0
            lastAvatarAt = System.currentTimeMillis()
            avatarRetryCount = 0
            avatarRetryAt = 0L
            avatarDecodeFailures = 0
            withContext(Dispatchers.Main) {
                if (!avatarOn) return@withContext
                currentAvatarBitmap = bmp
                avatarHasFrame = true
                avatarSeq += 1
                lastAvatarAcceptedAt = System.currentTimeMillis()
                decodeEmaMs = if (decodeEmaMs <= 0.0) decodeMs else decodeEmaMs * 0.8 + decodeMs * 0.2
                if (decodeEmaMs > 35.0) decodeSlowStreak += 1 else decodeSlowStreak = 0
                if (decodeSlowStreak >= 12) {
                    decodeSlowStreak = 0
                    stepDownAvatarQuality()
                }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: OutOfMemoryError) {
            withContext(Dispatchers.Main) {
                log("头像解码内存不足，自动降低清晰度")
                stepDownAvatarQuality(force = true)
            }
        } catch (e: Exception) {
            avatarDecodeFailures += 1
            if (avatarDecodeFailures == 10) log("头像帧连续解码失败：${e.message ?: "未知错误"}")
        }
    }

    private fun avatarLabel(q: String): String = when (q) {
        "sharp" -> "清晰"
        "smooth" -> "流畅"
        "data" -> "省流"
        else -> "均衡"
    }

    /** 按清晰度预设生成请求：目标分辨率 ≥ 头像球在屏幕上的物理像素，避免“小图放大发虚”。 */
    private fun avatarOptions(): AvatarOptions {
        if (legacyAvatarServer) {
            return AvatarOptions(maxWidth = 320, fps = 20, format = "png", quality = 88, binary = false, trim = false)
        }
        val density = getApplication<Application>().resources.displayMetrics.density
        val ballPx = (avatarBallSizeDp.toFloat() * density).toInt().coerceAtLeast(320)
        return when (avatarQuality) {
            // 默认：PNG 透明（磨砂球背景可见），约 15fps；源窗口约 720px，请求不超过 540 避免放大
            // 默认：720 JPEG 30fps，帧率稳 24+；球内用 Screen 混合去掉黑底
            "balanced" -> AvatarOptions(maxWidth = 640, fps = 30, format = "jpeg", quality = 90, binary = true, trim = true)
            // 可选透明 PNG（约 15fps）
            "transparent" -> AvatarOptions(maxWidth = 540, fps = 15, format = "png", quality = 92, binary = true, trim = true)
            "smooth" -> AvatarOptions(maxWidth = 540, fps = 30, format = "jpeg", quality = 86, binary = true, trim = true)
            "data" -> AvatarOptions(maxWidth = 360, fps = 24, format = "jpeg", quality = 82, binary = true, trim = true)
            else -> AvatarOptions(maxWidth = 540, fps = 15, format = "png", quality = 92, binary = true, trim = true)
        }
    }

    /** 投屏双击：移动鼠标；返回 false 表示当前不可用 */
    fun castMouseMove(nx: Float, ny: Float): Boolean {
        if (!castOn) return false
        val c = castClient ?: return false
        viewModelScope.launch {
            runCatching { c.moveMouse(nx.toDouble(), ny.toDouble(), 1) }
                .onFailure { e ->
                    if (System.currentTimeMillis() - castMouseErrorAt > 3000) {
                        castMouseErrorAt = System.currentTimeMillis()
                        log("鼠标移动失败：${e.message ?: "未知错误"}")
                    }
                }
        }
        return true
    }

    /** 投屏三击：左键单击；成功则查询电脑焦点，输入框自动弹手机键盘 */
    fun castMouseClick(nx: Float, ny: Float): Boolean {
        if (!castOn) return false
        val c = castClient ?: return false
        viewModelScope.launch {
            runCatching { c.clickMouse(nx.toDouble(), ny.toDouble(), 1) }
                .onSuccess {
                    kotlinx.coroutines.delay(150) // 等目标应用完成焦点切换
                    runCatching { c.isEditableFocused() }
                        .onSuccess { editable -> if (editable) castKeyboardWanted = true }
                }
                .onFailure { e ->
                    if (System.currentTimeMillis() - castMouseErrorAt > 3000) {
                        castMouseErrorAt = System.currentTimeMillis()
                        log("鼠标左键失败：${e.message ?: "未知错误"}")
                    }
                }
        }
        return true
    }

    /** 长按 3s：鼠标右键 */
    fun castMouseRightClick(nx: Float, ny: Float): Boolean {
        if (!castOn) return false
        val c = castClient ?: return false
        viewModelScope.launch {
            runCatching { c.rightClickMouse(nx.toDouble(), ny.toDouble(), 1) }
                .onFailure { e ->
                    if (System.currentTimeMillis() - castMouseErrorAt > 3000) {
                        castMouseErrorAt = System.currentTimeMillis()
                        log("鼠标右键失败：${e.message ?: "未知错误"}")
                    }
                }
        }
        return true
    }

    fun consumeCastKeyboardWanted() { castKeyboardWanted = false }
    fun requestCastKeyboard() { castKeyboardWanted = true }

    fun castTypeText(text: String): Boolean {
        if (!castOn) return false
        val value = text
        if (value.isBlank()) return false
        val c = castClient ?: return false
        viewModelScope.launch {
            runCatching { c.typeText(value) }
                .onFailure { e ->
                    if (System.currentTimeMillis() - castMouseErrorAt > 3000) {
                        castMouseErrorAt = System.currentTimeMillis()
                        log("电脑输入失败：${e.message ?: "未知错误"}")
                    }
                }
        }
        return true
    }

    override fun onCleared() {
        stopCast()
        stopAvatar()
        super.onCleared()
    }

    fun setAvatarBallSize(dp: Int) {
        val value = dp.coerceIn(160, 260)
        avatarBallSizeDp = value
        prefs.edit().putInt("avatarBallSizeDpV2", value).apply()
        log("头像球大小：${value}dp")
    }

    fun selectAvatarQuality(quality: String) {
        val allowed = setOf("transparent", "balanced", "smooth", "data")
        val next = if (quality in allowed) quality else "balanced"
        if (next == avatarQuality) return
        avatarQuality = next
        prefs.edit().putString("avatarQualityV4", next).apply()
        log("头像清晰度：${avatarLabel(next)}")
        if (avatarOn) {
            avatarPendingBytes.set(null)
            if (!avatarDecoding.get()) avatarDecoder.reset()
            viewModelScope.launch { runCatching { requestAvatarStart() } }
        }
    }

    fun setAutoAvatarOnChatEnabled(enabled: Boolean) {
        autoAvatarOnChat = enabled
        prefs.edit().putBoolean("autoAvatarOnChat", enabled).apply()
        if (enabled && page == AppPage.CHAT && connected && appForeground && !avatarOn) startAvatar(auto = true)
        if (!enabled && avatarAutoStarted) stopAvatar()
    }

    /** 启动头像流并按回执判断电脑端新旧协议；旧端自动切兼容参数 */
    private suspend fun requestAvatarStart() {
        val ack = client.avatarStart(avatarOptions())
        val supportsBinary = (ack as? JsonObject)?.get("binary")?.jsonPrimitive?.content?.toBoolean() == true
        if (!supportsBinary && !legacyAvatarServer) {
            legacyAvatarServer = true
            log("电脑端版本较旧：头像流使用兼容模式（320px/20fps）；升级电脑端可解锁 720p/30fps 与透明边裁剪")
            client.avatarStart(avatarOptions())
        }
    }

    private fun stepDownAvatarQuality(force: Boolean = false) {
        val order = listOf("transparent", "balanced", "smooth", "data")
        val idx = order.indexOf(avatarQuality).coerceAtLeast(0)
        if (idx >= order.lastIndex) return
        val now = System.currentTimeMillis()
        if (!force && now - lastQualityDownAt < 15_000) return
        lastQualityDownAt = now
        avatarQuality = order[idx + 1]
        prefs.edit().putString("avatarQualityV4", avatarQuality).apply()
        log("头像清晰度自动降为「${avatarLabel(avatarQuality)}」（解码/网络跟不上）")
        viewModelScope.launch { runCatching { requestAvatarStart() } }
    }

    fun disconnect() {
        wsRecoveryJob?.cancel()
        wsRecoveryJob = null
        phonePollJob?.cancel()
        phonePollJob = null
        stopAvatar()
        stopCast()
        client.disconnect()
        connected = false
        tools = emptyList()
        channel = "—"
        selected = null
        page = AppPage.HOME
        log("已断开连接")
    }

    fun reconnect() {
        if (busy) return
        if (!connected) {
            connect()
            return
        }
        busy = true; error = null
        viewModelScope.launch {
            try {
                client.disconnect()
                client.connect(ServerConfig(host.trimEnd('/'), token.trim()))
                channel = client.channel
                tools = client.listTools()
                installPhoneNotifications()
                startPhonePolling()
                log("已重连（${client.channel}），工具 ${tools.size} 个")
            } catch (e: Exception) {
                connected = false
                stopAvatar()
                stopCast()
                error = "重连失败：${e.message ?: "未知错误"}"
                log("重连失败：${e.message}")
            } finally {
                busy = false
            }
        }
    }

    fun refresh() {
        if (!connected || busy) return
        busy = true; error = null
        viewModelScope.launch {
            try {
                tools = client.listTools()
                log("工具目录已刷新：${tools.size} 个（运行时拉取）")
            } catch (e: Exception) {
                error = "刷新失败：${e.message}"
            } finally {
                busy = false
            }
        }
    }

    fun registerPhoneTools() {
        if (!connected) return
        viewModelScope.launch {
            try {
                client.registerPhoneTools(PhoneTools.descriptors(getApplication()))
                log("已向电脑端注册 ${phoneToolCount} 个手机工具")
            } catch (e: Exception) {
                log("手机工具注册未完成（电脑端可能未开启桥接）：${e.message}")
            }
        }
    }

    /**
     * 手机工具执行循环：长轮询 phone/poll 领任务 → 本地执行 → phone/result 回执。
     * 断线/重连由 phonePollJob 的取消与 while(connected) 共同收口，不会残留多个循环。
     */
    private fun startPhonePolling() {
        phonePollJob?.cancel()
        phonePollJob = viewModelScope.launch(Dispatchers.IO) {
            while (connected) {
                try {
                    val call = client.phonePoll(25_000) ?: continue
                    val id = call["id"]?.jsonPrimitive?.content ?: continue
                    val name = call["name"]?.jsonPrimitive?.content ?: continue
                    val args = call["arguments"]?.jsonObject ?: JsonObject(emptyMap())
                    val result = runCatching { PhoneTools.execute(getApplication(), name, args) }
                    val error = result.exceptionOrNull()
                    if (error == null) client.phoneResult(id, text = result.getOrNull() ?: "")
                    else client.phoneResult(id, errorMessage = error.message ?: "手机端执行失败")
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (!connected) break
                    delay(1000) // 断线/超时：稍等再轮询，避免刷屏
                }
            }
        }
    }

    fun open(tool: ToolInfo) {
        selected = tool
        argsText = defaultArgs(tool.inputSchema)
        result = null
        error = null
    }

    fun closeTool() {
        selected = null
        showConfirm = false
    }

    fun requestRun() {
        val tool = selected ?: return
        if (!tool.annotations.readOnlyHint || tool.annotations.destructiveHint) {
            showConfirm = true
        } else {
            runTool()
        }
    }

    fun runTool() {
        val tool = selected ?: return
        showConfirm = false
        if (busy) return
        val args: JsonObject = try {
            Json.parseToJsonElement(argsText.ifBlank { "{}" }).jsonObject
        } catch (e: Exception) {
            error = "参数不是合法 JSON：${e.message}"
            return
        }
        busy = true; error = null; result = null
        val started = System.currentTimeMillis()
        viewModelScope.launch {
            try {
                val out = client.callTool(tool, args)
                val elapsed = System.currentTimeMillis() - started
                result = "耗时 ${elapsed}ms\n" + out.toString()
                log("调用 ${tool.name} 成功（${elapsed}ms）")
            } catch (e: Exception) {
                error = "调用 ${tool.name} 失败：${(e as? McpException)?.message ?: e.message ?: "未知错误"}"
                log("调用 ${tool.name} 失败：${e.message}")
            } finally {
                busy = false
            }
        }
    }

    private fun findTool(name: String): ToolInfo? = tools.firstOrNull { it.name == name }

    private fun resultText(out: kotlinx.serialization.json.JsonElement): String {
        return runCatching {
            val arr = out.jsonObject["content"]?.jsonArray
            val texts = arr?.mapNotNull { it.jsonObject["text"]?.jsonPrimitive?.content } ?: emptyList()
            texts.joinToString("\n")
        }.getOrDefault(out.toString())
    }

    private var lastTouchMoveAt = 0L

    fun touchMove(nx: Float, ny: Float) {
        if (!connected) return
        val now = System.currentTimeMillis()
        if (now - lastTouchMoveAt < 70) return
        lastTouchMoveAt = now
        viewModelScope.launch {
            runCatching {
                val tool = findTool("pet_touch") ?: return@runCatching
                client.callTool(tool, buildJsonObject {
                    put("action", "move")
                    put("x", nx.coerceIn(0f, 1f).toDouble())
                    put("y", ny.coerceIn(0f, 1f).toDouble())
                })
            }
        }
    }

    fun touchClick(nx: Float, ny: Float) {
        if (!connected) return
        viewModelScope.launch {
            runCatching {
                val tool = findTool("pet_touch") ?: return@runCatching
                client.callTool(tool, buildJsonObject {
                    put("action", "click")
                    put("x", nx.coerceIn(0f, 1f).toDouble())
                    put("y", ny.coerceIn(0f, 1f).toDouble())
                })
            }
        }
    }

    fun toggleCast() {
        if (castOn) stopCast() else startCast()
    }

    /** 新版投屏：独立 WS 接收 CastCap 推送的二进制 JPEG 帧（不再走手机鼠标/输入法） */
    private fun startCast() {
        if (castOn) return
        castOn = true
        castHasFrame = false
        currentCastBitmap = null
        castSeq = 0
        castLastErrorAt = 0L
        castPendingBytes.set(null)
        castDecoding.set(false)
        castDecoder.reset()
        val config = ServerConfig(host.trimEnd('/'), token.trim())
        val client = CastStreamClient(config)
        castClient = client
        castStreamJob = viewModelScope.launch {
            client.onFrame = { bytes -> enqueueCastFrame(bytes) }
            client.onError = { message ->
                val now = System.currentTimeMillis()
                if (now - castLastErrorAt > 3000) {
                    castLastErrorAt = now
                    log("投屏：$message")
                }
            }
            try {
                client.start(CastStreamClient.Options(maxWidth = 1280, fps = 24, quality = 70, display = 1))
                castFrameIdleAt = System.currentTimeMillis()
                while (castOn && client.alive) {
                    delay(2000)
                    if (System.currentTimeMillis() - castFrameIdleAt > 8000) {
                        log("投屏超过 8 秒无帧，自动重连")
                        client.stop()
                        throw McpException("投屏无帧")
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (castOn) log("投屏连接失败：${e.message ?: "未知错误"}")
            } finally {
                // 协程取消/异常都释放投屏 WS/解码缓冲，避免幽灵连接
                if (castOn) castOn = false
                runCatching { castClient?.stop() }
                castClient = null
                castPendingBytes.set(null)
                castDecoding.set(false)
                castHasFrame = false
            }
        }
    }

    private fun enqueueCastFrame(bytes: ByteArray) {
        if (!castOn || bytes.isEmpty()) return
        castFrameIdleAt = System.currentTimeMillis()
        castPendingBytes.set(bytes)
        if (!castDecoding.compareAndSet(false, true)) return
        viewModelScope.launch(Dispatchers.Default) {
            try {
                while (castOn) {
                    val data = castPendingBytes.getAndSet(null) ?: break
                    val bmp = try { castDecoder.decode(data) } catch (e: OutOfMemoryError) { null } catch (e: Exception) { null }
                    if (bmp != null) {
                        withContext(Dispatchers.Main) {
                            if (castOn) {
                                currentCastBitmap = bmp
                                castHasFrame = true
                                castSeq += 1
                            }
                        }
                    }
                }
            } finally {
                castDecoding.set(false)
            }
        }
    }

    fun stopCast() {
        castOn = false
        castKeyboardWanted = false
        castStreamJob?.cancel()
        castStreamJob = null
        runCatching { castClient?.stop() }
        castClient = null
        castPendingBytes.set(null)
        castDecoding.set(false)
        castHasFrame = false
        currentCastBitmap = null
        castSeq = 0
        castDecoder.reset()
    }

    fun openPage(page: AppPage) {
        val wasChat = this.page == AppPage.CHAT
        val wasCast = this.page == AppPage.CAST
        this.page = page
        if (page == AppPage.CHAT) {
            // 打开对话页时把鼠标移到桌宠视线原点（只触发一次）
            if (connected) viewModelScope.launch { runCatching { client.cursorToGazeOrigin() } }
            // 进入对话页自动显示桌宠（开关可关；连接/WS 就绪后由 startAvatar 自行重试）
            if (autoAvatarOnChat && connected && appForeground && !avatarOn) startAvatar(auto = true)
        } else if (wasChat && avatarAutoStarted) {
            // 离开对话页自动停止，省电省流量；手动开的头像保持手动语义
            stopAvatar()
        }
        // 投屏页自动启停（24fps 流比较吃带宽，离开即停）
        if (page == AppPage.CAST && connected && !castOn && appForeground) startCast()
        if (wasCast && page != AppPage.CAST) {
            stopCast()
        }
    }

    /** Activity onResume/onStop 调用：后台暂停头像流，回前台且停在对话页时自动恢复 */
    fun onAppForeground() {
        appForeground = true
        if (page == AppPage.CHAT && autoAvatarOnChat && connected && !avatarOn) startAvatar(auto = true)
        if (page == AppPage.CAST && connected && !castOn) startCast()
    }

    fun onAppBackground() {
        appForeground = false
        if (avatarAutoStarted) stopAvatar()
        // 投屏 24fps 很耗流量/电量：后台立即停，回前台若仍在投屏页再恢复
        if (castOn) stopCast()
    }

    fun sendChat(text: String) {
        val msg = text.trim()
        if (msg.isEmpty() || chatBusy) return
        chatLines = chatLines + ChatLine("user", msg)
        chatBusy = true
        chatElapsedSec = 0
        val tick = viewModelScope.launch {
            while (chatBusy) {
                delay(1000)
                chatElapsedSec += 1
            }
        }
        viewModelScope.launch {
            try {
                val tool = findTool("pet_chat_detail") ?: findTool("pet_chat")
                if (tool == null) {
                    chatLines = chatLines + ChatLine("system", "电脑端没有 pet_chat 工具")
                } else {
                    val out = client.callTool(tool, buildJsonObject { put("text", msg) })
                    val raw = resultText(out)
                    val obj = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(raw).jsonObject }.getOrNull()
                    val replyPart = obj?.get("reply")?.jsonPrimitive?.content ?: raw
                    val thinkingPart = obj?.get("thinking")?.jsonPrimitive?.content ?: ""
                    chatLines = chatLines + ChatLine("pet", replyPart)
                    if (showThinking && thinkingPart.isNotBlank()) {
                        chatLines = chatLines + ChatLine("thinking", "思考：${thinkingPart.take(1200)}")
                    }
                }
            } catch (e: Exception) {
                chatLines = chatLines + ChatLine("system", "发送失败：${e.message ?: "未知错误"}")
            } finally {
                chatBusy = false
            }
        }
    }

    fun clearChat() { chatLines = listOf(ChatLine("system", "已开始新对话。")) }

    fun newChat() { chatLines = listOf(ChatLine("system", "已开始新对话。")) }

    fun loadRemoteHistory() {
        if (!connected || historyBusy) return
        historyBusy = true
        viewModelScope.launch {
            try {
                val tool = findTool("pet_chat_history")
                if (tool == null) {
                    remoteHistory = emptyList()
                } else {
                    val out = client.callTool(tool, buildJsonObject {})
                    val text = resultText(out)
                    val arr = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(text) as kotlinx.serialization.json.JsonArray }.getOrNull() ?: kotlinx.serialization.json.JsonArray(emptyList())
                    remoteHistory = arr.mapNotNull { el ->
                        runCatching {
                            val obj = el.jsonObject
                            RemoteSession(
                                id = obj["id"]?.jsonPrimitive?.content ?: "",
                                title = obj["title"]?.jsonPrimitive?.content ?: "未命名对话",
                                count = obj["count"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0,
                                startedAt = obj["startedAt"]?.jsonPrimitive?.content?.toLongOrNull() ?: 0L,
                            )
                        }.getOrNull()
                    }.filter { it.id.isNotBlank() }
                }
            } catch (e: Exception) {
                chatLines = chatLines + ChatLine("system", "读取电脑端历史失败：${e.message ?: "未知错误"}")
            } finally {
                historyBusy = false
            }
        }
    }

    fun loadRemoteSession(id: String) {
        if (!connected) return
        viewModelScope.launch {
            try {
                val tool = findTool("pet_chat_history") ?: return@launch
                val out = client.callTool(tool, buildJsonObject {
                    put("sessionId", id)
                    put("limit", 60)
                })
                val text = resultText(out)
                val arr = runCatching { kotlinx.serialization.json.Json.parseToJsonElement(text) as kotlinx.serialization.json.JsonArray }.getOrNull() ?: kotlinx.serialization.json.JsonArray(emptyList())
                val lines = arr.mapNotNull { el ->
                    runCatching {
                        val obj = el.jsonObject
                        val role = obj["role"]?.jsonPrimitive?.content ?: "tool"
                        val txt = obj["text"]?.jsonPrimitive?.content ?: ""
                        if (txt.isBlank()) null else ChatLine(if (role == "user") "user" else if (role == "pet") "pet" else "system", txt)
                    }.getOrNull()
                }
                chatLines = listOf(ChatLine("system", "已载入电脑端历史会话。")) + lines
            } catch (e: Exception) {
                chatLines = chatLines + ChatLine("system", "载入历史失败：${e.message ?: "未知错误"}")
            }
        }
    }

    fun setComboArg(name: String, text: String) {
        comboArgs = comboArgs + (name to text)
    }

    fun toggleAvatar() {
        if (avatarOn) {
            stopAvatar()
        } else {
            avatarAutoStarted = false
            startAvatar(auto = false)
        }
    }

    private fun startAvatar(auto: Boolean = false) {
        if (!connected || avatarOn) return
        avatarAutoStarted = auto
        avatarHasFrame = false
        currentAvatarBitmap = null
        avatarSeq += 1
        if (!avatarDecoding.get()) avatarDecoder.reset()
        avatarPendingBytes.set(null)
        avatarDecodeFailures = 0
        decodeEmaMs = 0.0
        decodeSlowStreak = 0
        lastAvatarAt = System.currentTimeMillis()
        avatarOn = true
        avatarWatchJob?.cancel()
        avatarWatchJob = viewModelScope.launch {
            while (avatarOn) {
                delay(1000)
                if (!avatarOn || !connected) break
                val now = System.currentTimeMillis()
                if (now - lastAvatarAt <= 4000 || now < avatarRetryAt) continue
                // HTTP 回退时收不到通知，重发 start 无意义；等 WS 重连
                if (!client.canReceiveNotifications()) {
                    avatarRetryAt = now + 5000
                    continue
                }
                if (avatarRetryCount >= 8) {
                    log("头像流多次无帧，停止自动重试（可手动关闭再开启）")
                    avatarOn = false
                    break
                }
                avatarRetryCount += 1
                avatarRetryAt = now + (2000L shl (avatarRetryCount - 1).coerceAtMost(4))
                runCatching { requestAvatarStart() }
            }
        }
        viewModelScope.launch {
            try {
                requestAvatarStart()
            } catch (e: Exception) {
                avatarOn = false
                log("头像流启动失败：${e.message}")
            }
        }
    }

    fun respondPhoneConfirm(allow: Boolean) {
        val p = pendingConfirm ?: return
        pendingConfirm = null
        runCatching { client.sendPhoneConfirmReply(p.id, if (allow) "allow" else "deny") }
    }

    fun stopAvatar() {
        if (!avatarOn) return
        avatarOn = false
        avatarAutoStarted = false
        avatarWatchJob?.cancel()
        avatarWatchJob = null
        currentAvatarBitmap = null
        avatarHasFrame = false
        avatarSeq += 1
        // 解码协程可能还在用旧 buffer：进行中先不 recycle，等下次启动再复位
        avatarPendingBytes.set(null)
        if (!avatarDecoding.get()) avatarDecoder.reset()
        viewModelScope.launch { runCatching { client.avatarStop() } }
    }

    fun toggleComboTool(name: String) {
        comboSelected = if (comboSelected.contains(name)) comboSelected - name else comboSelected + name
        if (!comboArgs.containsKey(name)) comboArgs = comboArgs + (name to "{}")
    }

    fun runCombo() {
        if (comboBusy || comboSelected.isEmpty()) return
        comboBusy = true
        comboResults = emptyList()
        viewModelScope.launch {
            try {
                for (name in tools.map { it.name }.filter { comboSelected.contains(it) }) {
                    val tool = findTool(name) ?: continue
                    try {
                        val raw = comboArgs[name]?.ifBlank { "{}" } ?: "{}"
                        val args = runCatching { Json.parseToJsonElement(raw).jsonObject }.getOrNull()
                        if (args == null) {
                            comboResults = comboResults + "${name}：参数不是合法 JSON"
                            continue
                        }
                        val out = client.callTool(tool, args)
                        comboResults = comboResults + "${name}：${resultText(out).take(300)}"
                    } catch (e: Exception) {
                        comboResults = comboResults + "${name}：失败（${e.message ?: "未知错误"}）"
                    }
                }
            } finally {
                comboBusy = false
            }
        }
    }

    fun setArgs(v: String) { argsText = v }

    fun filtered(): List<ToolInfo> {
        val q = filter.trim().lowercase()
        if (q.isEmpty()) return tools
        return tools.filter {
            it.name.lowercase().contains(q) || it.description.lowercase().contains(q)
        }
    }

    private fun defaultArgs(inputSchema: JsonObject): String {
        val props = inputSchema["properties"] as? JsonObject ?: return "{}"
        return try {
            buildJsonObject {
                for ((key, value) in props) {
                    val type = (value as? JsonObject)?.get("type")?.jsonPrimitive?.content
                    when (type) {
                        "number", "integer" -> put(key, 0)
                        "boolean" -> put(key, false)
                        "array" -> put(key, kotlinx.serialization.json.JsonArray(emptyList()))
                        "object" -> put(key, buildJsonObject {})
                        else -> put(key, "")
                    }
                }
            }.let { it.toString() }
        } catch (_: Exception) {
            "{}"
        }
    }
}
