package com.pet.mcpclient.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** MCP 工具注解：只读/危险/超时（来自电脑端 tools/list，客户端只消费不硬编码工具名） */
@Serializable
data class ToolAnnotations(
    val readOnlyHint: Boolean = false,
    val destructiveHint: Boolean = false,
    val timeoutMs: Long? = null,
)

@Serializable
data class ToolInfo(
    val name: String,
    val description: String = "",
    val inputSchema: JsonObject = JsonObject(emptyMap()),
    val annotations: ToolAnnotations = ToolAnnotations(),
) {
    val riskLabel: String
        get() = when {
            annotations.destructiveHint -> "危险"
            annotations.readOnlyHint -> "只读"
            else -> "写入"
        }
}

class McpException(message: String, val code: Int? = null) : Exception(message)

/** 连接配置（token 仅内存/本地加密存储，不写日志） */
data class ServerConfig(val baseUrl: String, val token: String)
