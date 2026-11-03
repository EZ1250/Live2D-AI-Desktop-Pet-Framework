package com.pet.mcpclient.ui

/**
 * 界面层数据类型（从 AppState.kt 抽出，便于多处复用与单独演进）。
 * - AppPage：主页/工具/对话/投屏/自由组合的页面路由值；
 * - ChatLine：对话页一行（role: user / pet / thinking / system）；
 * - RemoteSession：电脑端 chat-log.json 的会话摘要。
 */
enum class AppPage { HOME, TOOLS, CHAT, CAST, COMBO }

data class ChatLine(val role: String, val text: String)

data class PhoneConfirm(val id: String, val tool: String, val detail: String)

data class RemoteSession(val id: String, val title: String, val count: Int, val startedAt: Long)
