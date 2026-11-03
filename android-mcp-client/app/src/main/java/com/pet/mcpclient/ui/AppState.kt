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
import android.graphics.BitmapFactory
import android.util.Base64
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
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
    var avatar by mutableStateOf<ImageBitmap?>(null)
        private set
    var pendingConfirm by mutableStateOf<PhoneConfirm?>(null)
        private set
    var avatarOn by mutableStateOf(false)
        private set
    var castImage by mutableStateOf<ImageBitmap?>(null)
        private set
    var castOn by mutableStateOf(false)
        private set
    var comboSelected by mutableStateOf(emptySet<String>())
        private set
    var comboResults by mutableStateOf(listOf<String>())
        private set
    var comboBusy by mutableStateOf(false)
        private set
    private var castJob: Job? = null
    private var castLastErrorAt = 0L
    /** 头像解码标志/时间戳在 OkHttp 回调线程与默认调度器之间共享，必须保证可见性 */
    @Volatile
    private var avatarDecoding = false
    @Volatile
    private var lastAvatarAt = 0L
    private var avatarDecodeFailures = 0
    private var lastAvatarAcceptedAt = 0L
    private var avatarRetryCount = 0
    private var avatarRetryAt = 0L
    private var avatarWatchJob: Job? = null
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
                if (avatarOn) runCatching { client.avatarStart(220) }
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
                        // 解码跟不上时直接丢帧；解码结束必须在 finally 里复位，否则一次异常后永久卡死
                        if (avatarDecoding) return@setNotificationListener
                        val data = params["data"]?.jsonPrimitive?.content ?: return@setNotificationListener
                        avatarDecoding = true
                        viewModelScope.launch(Dispatchers.Default) {
                            try {
                                val bytes = Base64.decode(data, Base64.DEFAULT)
                                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return@launch
                                lastAvatarAt = System.currentTimeMillis()
                                avatarRetryCount = 0
                                avatarRetryAt = 0L
                                avatarDecodeFailures = 0
                                val now = System.currentTimeMillis()
                                // 限制 UI 更新节奏（~20fps），避免解码/重组过快造成手机端卡顿
                                if (now - lastAvatarAcceptedAt >= 50) {
                                    lastAvatarAcceptedAt = now
                                    avatar = bmp.asImageBitmap()
                                }
                                lastAvatarAt = System.currentTimeMillis()
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                avatarDecodeFailures += 1
                                if (avatarDecodeFailures == 10) log("头像帧连续解码失败 10 次")
                            } finally {
                                avatarDecoding = false
                            }
                        }
                    }
                }
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

    fun openPage(page: AppPage) { this.page = page }

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
        if (avatarOn) stopAvatar() else startAvatar()
    }

    private fun startAvatar() {
        if (!connected) return
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
                if (avatarRetryCount >= 6) {
                    log("头像流多次无帧，停止自动重试（可手动关闭再开启）")
                    avatarOn = false
                    break
                }
                avatarRetryCount += 1
                avatarRetryAt = now + (2000L shl (avatarRetryCount - 1).coerceAtMost(4))
                runCatching { client.avatarStart(220) }
            }
        }
        viewModelScope.launch {
            try {
                client.avatarStart(220)
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
        avatarWatchJob?.cancel()
        avatarWatchJob = null
        viewModelScope.launch { runCatching { client.avatarStop() } }
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
                val out = client.callTool(tool, buildJsonObject {
                    put("action", "click")
                    put("x", nx.coerceIn(0f, 1f).toDouble())
                    put("y", ny.coerceIn(0f, 1f).toDouble())
                })
                chatLines = chatLines + ChatLine("system", resultText(out))
            }.onFailure { chatLines = chatLines + ChatLine("system", "点击失败：${it.message ?: "未知错误"}") }
        }
    }

    fun toggleCast() {
        if (castOn) stopCast() else startCast()
    }

    private fun startCast() {
        if (!connected) return
        castOn = true
        castJob = viewModelScope.launch {
            while (castOn) {
                try {
                    val tool = findTool("pet_screenshot")
                    if (tool != null) {
                        val out = client.callTool(tool, buildJsonObject {})
                        val data = runCatching { out.jsonObject["content"]?.jsonArray?.firstOrNull()?.jsonObject?.get("data")?.jsonPrimitive?.content }.getOrNull()
                        if (data != null) {
                            val bytes = Base64.decode(data, Base64.DEFAULT)
                            val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                            if (bmp != null) castImage = bmp.asImageBitmap()
                        }
                    }
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    // 投屏持续失败（多半是断线）：限频记一次，避免无声空转
                    if (System.currentTimeMillis() - castLastErrorAt > 5000) {
                        castLastErrorAt = System.currentTimeMillis()
                        log("投屏帧失败：${e.message ?: "未知错误"}")
                    }
                }
                delay(1000)
            }
        }
    }

    fun stopCast() {
        castOn = false
        castJob?.cancel()
        castJob = null
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
