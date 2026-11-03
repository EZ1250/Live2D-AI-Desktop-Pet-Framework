package com.pet.mcpclient.phone

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * 手机原生能力工具注册表（VCPToolBox 思路：手机侧工具异步调用、PC 侧以 phone_* 暴露）。
 * 工具清单固定为手机能力；PC 端工具名一律来自运行时 tools/list，与此无关。
 */
data class PhoneToolDef(
    val name: String,
    val description: String,
    val inputSchema: JsonObject,
    val readOnly: Boolean = true,
    val destructive: Boolean = false,
    val handler: suspend (Context, JsonObject) -> String,
)

object PhoneTools {
    fun tools(context: Context): List<PhoneToolDef> = listOf(
        PhoneToolDef(
            name = "device_info",
            description = "读取本机品牌/型号/Android 版本",
            inputSchema = buildJsonObject {},
            handler = { _, _ ->
                "${Build.MANUFACTURER} ${Build.MODEL} / Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT})"
            },
        ),
        PhoneToolDef(
            name = "battery",
            description = "读取手机电量与充电状态",
            inputSchema = buildJsonObject {},
            handler = { ctx, _ -> battery(ctx) },
        ),
        PhoneToolDef(
            name = "wifi_status",
            description = "读取当前网络类型与是否联网",
            inputSchema = buildJsonObject {},
            handler = { ctx, _ -> network(ctx) },
        ),
        PhoneToolDef(
            name = "clipboard_read",
            description = "读取手机剪贴板文本",
            inputSchema = buildJsonObject {},
            handler = { ctx, _ -> clipboardRead(ctx) },
        ),
        PhoneToolDef(
            name = "clipboard_write",
            description = "写入一段文本到手机剪贴板",
            inputSchema = buildJsonObject {
                put("type", "object")
                put("properties", buildJsonObject {
                    put("text", buildJsonObject {
                        put("type", "string")
                        put("description", "要写入的文本")
                    })
                })
                put("required", buildJsonArray { add(kotlinx.serialization.json.JsonPrimitive("text")) })
            },
            readOnly = false,
            handler = { ctx, args -> clipboardWrite(ctx, args["text"]?.jsonPrimitive?.content ?: return@PhoneToolDef "缺少 text 参数") },
        ),
        PhoneToolDef(
            name = "location_coarse",
            description = "读取手机最近一次粗略定位（需要定位权限）",
            inputSchema = buildJsonObject {},
            handler = { ctx, _ -> location(ctx) },
        ),
    )

    fun descriptors(context: Context): JsonArray = buildJsonArray {
        for (tool in tools(context)) {
            add(buildJsonObject {
                put("name", tool.name)
                put("description", tool.description)
                put("inputSchema", tool.inputSchema)
                put("annotations", buildJsonObject {
                    put("readOnlyHint", tool.readOnly)
                    put("destructiveHint", tool.destructive)
                })
            })
        }
    }

    suspend fun execute(context: Context, name: String, args: JsonObject): String {
        val tool = tools(context).firstOrNull { it.name == name }
            ?: return "手机端没有名为 ${name} 的工具"
        return withContext(Dispatchers.Default) { tool.handler(context, args) }
    }

    private fun battery(ctx: Context): String {
        val intent = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
            ?: return "无法读取电池信息"
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        val pct = if (level >= 0 && scale > 0) level * 100 / scale else -1
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL
        return "电量 ${pct}%，${if (charging) "充电中" else "未充电"}"
    }

    private fun network(ctx: Context): String {
        val cm = ctx.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val type = when {
            caps == null -> "无网络"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "Wi-Fi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "移动网络"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "以太网"
            else -> "未知网络"
        }
        val online = caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
        return "$type，${if (online) "已联网" else "未联网"}"
    }

    private fun clipboardRead(ctx: Context): String {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val text = cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
        return text?.take(2000) ?: "剪贴板为空（Android 12+ 后台读取可能受限）"
    }

    private fun clipboardWrite(ctx: Context, text: String): String {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("pet-mcp", text))
        return "已写入剪贴板（${text.length} 字）"
    }

    private fun location(ctx: Context): String {
        val granted = ctx.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) return "未授权定位权限（到系统设置 → 应用 → Pet MCP → 权限 → 位置 里授予）"
        val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val loc = runCatching { lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER) }.getOrNull()
            ?: return "暂无最近定位结果"
        return "定位：lat=${"%.4f".format(loc.latitude)}, lon=${"%.4f".format(loc.longitude)}（精度 ${loc.accuracy.toInt()}m）"
    }
}
