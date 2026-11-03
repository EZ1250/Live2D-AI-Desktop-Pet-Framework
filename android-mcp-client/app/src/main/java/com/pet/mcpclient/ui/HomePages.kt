/**
主页与各功能页（对话/投屏/工具入口/自由组合）。
 * 说明：本文件只放 Compose 界面；业务动作全部经 AppViewModel；
 * 对话页的球心坐标映射在 ChatScreen 内，改动时注意与 pet_touch 协议保持一致。
 */
package com.pet.mcpclient.ui

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.roundToInt
import com.pet.mcpclient.data.ToolInfo

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: AppViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Pet MCP") },
                actions = {
                    TextButton(onClick = { vm.showSettings = true }) { Text("设置") }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text("已连接（${vm.channel}）· ${vm.tools.size} 个工具", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
            HomeEntry("💬  对话", "和桌宠 AI 聊天，Live2D 模式实时互动") { vm.openPage(AppPage.CHAT) }
            HomeEntry("🖥  电脑投屏", "查看电脑屏幕（低帧截图镜像）") { vm.openPage(AppPage.CAST) }
            HomeEntry("🧰  工具（${vm.tools.size}）", "运行时拉取的工具清单，点开即用") { vm.openPage(AppPage.TOOLS) }
            HomeEntry("➕  自由组合", "多选工具，依次执行") { vm.openPage(AppPage.COMBO) }
            Spacer(Modifier.height(8.dp))
            TextButton(onClick = { vm.disconnect() }) { Text("断开连接") }
        }
    }
}
@Composable
private fun HomeEntry(title: String, desc: String, onClick: () -> Unit) {
    Card(Modifier.fillMaxWidth().clickable(onClick = onClick), shape = RoundedCornerShape(14.dp)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.Medium)
            Text(desc, fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(vm: AppViewModel) {
    var input by remember { mutableStateOf("") }
    var menuOpen by remember { mutableStateOf(false) }
    var historyOpen by remember { mutableStateOf(false) }
    var infoOpen by remember { mutableStateOf(false) }
    var avatarOffset by remember { mutableStateOf<Offset?>(null) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { TextButton(onClick = { vm.openPage(AppPage.HOME) }) { Text("返回") } },
                title = { Text("对话") },
                actions = {
                    TextButton(onClick = { menuOpen = true }) { Text("＋") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("新对话") }, onClick = { vm.newChat(); menuOpen = false })
                        DropdownMenuItem(text = { Text("历史对话（电脑端）") }, onClick = { vm.loadRemoteHistory(); historyOpen = true; menuOpen = false })
                        DropdownMenuItem(text = { Text(if (vm.showThinking) "隐藏思考过程" else "显示思考过程") }, onClick = { vm.showThinking = !vm.showThinking; menuOpen = false })
                        DropdownMenuItem(text = { Text("对话信息") }, onClick = { infoOpen = true; menuOpen = false })
                        DropdownMenuItem(text = { Text("开始/停止头像") }, onClick = { vm.toggleAvatar(); menuOpen = false })
                        DropdownMenuItem(text = { Text("收起（返回主页）") }, onClick = { vm.openPage(AppPage.HOME); menuOpen = false })
                    }
                },
            )
        },
    ) { padding ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(padding)) {
            val density = LocalDensity.current
            val ballDp = 210.dp
            val ballPx = with(density) { ballDp.toPx() }
            val areaW = with(density) { maxWidth.toPx() }
            val areaH = with(density) { maxHeight.toPx() }
            fun clampBall(value: Offset): Offset = Offset(
                value.x.coerceIn(0f, (areaW - ballPx).coerceAtLeast(0f)),
                value.y.coerceIn(0f, (areaH - ballPx).coerceAtLeast(0f)),
            )
            val ball = clampBall(avatarOffset ?: Offset(areaW - ballPx, 0f))
            val padLeftPx = with(density) { 12.dp.toPx() }
            val padTopPx = with(density) { 4.dp.toPx() }
            Column(Modifier.fillMaxSize().padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 8.dp)) {
                LazyColumn(
                    Modifier.weight(1f).pointerInput(ball, ballPx) {
                        detectTapGestures { tap ->
                            // 球中心为坐标原点：球心 = (0.5,0.5)，球半径 = 0.5
                            val nx = 0.5f + (tap.x + padLeftPx - (ball.x + ballPx / 2)) / ballPx
                            val ny = 0.5f + (tap.y + padTopPx - (ball.y + ballPx / 2)) / ballPx
                            vm.touchMove(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f))
                            if (nx in 0f..1f && ny in 0f..1f) vm.touchClick(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f))
                        }
                    }
                    .pointerInput(ball, ballPx) {
                        // 页面拖动（不只点击）也触发视线跟随；不消费事件，消息仍可滚动
                        detectDragGestures { change, _ ->
                            val nx = 0.5f + (change.position.x + padLeftPx - (ball.x + ballPx / 2)) / ballPx
                            val ny = 0.5f + (change.position.y + padTopPx - (ball.y + ballPx / 2)) / ballPx
                            vm.touchMove(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f))
                        }
                    },
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(vm.chatLines) { line -> ChatBubble(line) }
                    if (vm.chatBusy) {
                        item { Text(" ${vm.chatElapsedSec}s…", fontSize = 11.sp, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(start = 8.dp)) }
                    }
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = input,
                        onValueChange = { input = it },
                        placeholder = { Text("输入消息…") },
                        modifier = Modifier.weight(1f),
                        enabled = !vm.chatBusy,
                    )
                    SendBall(enabled = !vm.chatBusy) { vm.sendChat(input); input = "" }
                }
            }
            Box(
                Modifier
                    .offset { IntOffset(ball.x.roundToInt(), ball.y.roundToInt()) }
                    .size(ballDp)
                    .border(3.dp, Color.Black, CircleShape)
                    .clip(CircleShape)
                    .pointerInput(vm.avatarOn) {
                        detectTapGestures { offset ->
                            if (vm.avatarOn) {
                                val nx = 0.5f + (offset.x - size.width / 2f) / size.width
                                val ny = 0.5f + (offset.y - size.height / 2f) / size.height
                                vm.touchClick(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f))
                            } else vm.toggleAvatar()
                        }
                    }
                    // key 不能包含 ball：拖拽中 ball 变化会重启手势导致拖不动
                    .pointerInput(vm.avatarOn) {
                        detectDragGestures { change, drag ->
                            change.consume()
                            avatarOffset = clampBall((avatarOffset ?: ball) + drag)
                        }
                    },
            ) {
                val bmp = vm.avatar
                if (bmp != null) {
                    Image(bitmap = bmp, contentDescription = "桌宠", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
                } else {
                    Text(
                    if (vm.avatarOn) "头像加载中…" else "点头像\n同步 Live2D",
                        modifier = Modifier.fillMaxSize(),
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.secondary,
                    )
                }
            }
        }
    }
    vm.pendingConfirm?.let { confirm ->
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { /* 模态：只能点允许/拒绝 */ },
            title = { Text("电脑端操作确认") },
            text = { Text("工具：${confirm.tool}\n\n${confirm.detail}") },
            confirmButton = { TextButton(onClick = { vm.respondPhoneConfirm(true) }) { Text("允许") } },
            dismissButton = { TextButton(onClick = { vm.respondPhoneConfirm(false) }) { Text("拒绝") } },
        )
    }
    if (historyOpen) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { historyOpen = false },
            title = { Text("历史对话") },
            text = {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    if (vm.historyBusy) Text("正在读取电脑端聊天记录…")
                    else if (vm.remoteHistory.isEmpty()) Text("电脑端还没有历史对话")
                    vm.remoteHistory.forEach { session ->
                        Text(
                            "${session.title}（${session.count} 条）",
                            Modifier.fillMaxWidth().clickable { vm.loadRemoteSession(session.id); historyOpen = false }.padding(8.dp),
                            fontSize = 13.sp,
                        )
                    }
                }
            },
            confirmButton = { TextButton(onClick = { historyOpen = false }) { Text("关闭") } },
        )
    }
    if (infoOpen) {
        androidx.compose.material3.AlertDialog(
            onDismissRequest = { infoOpen = false },
            title = { Text("对话信息") },
            text = {
                Column {
                    Text("通道：${vm.channel}")
                    Text("工具：${vm.tools.size} 个")
                    Text("消息：${vm.chatLines.size} 条")
                    Text("头像流：${if (vm.avatarOn) "已开启" else "未开启"}")
                    Text("思考过程：${if (vm.showThinking) "显示" else "隐藏"}")
                }
            },
            confirmButton = { TextButton(onClick = { infoOpen = false }) { Text("关闭") } },
        )
    }
}

@Composable
private fun ChatBubble(line: ChatLine) {
    when (line.role) {
        "thinking" -> Text(line.text, fontSize = 11.sp, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.fillMaxWidth().padding(start = 8.dp))
        "system" -> Text(line.text, fontSize = 11.sp, color = MaterialTheme.colorScheme.secondary, modifier = Modifier.fillMaxWidth().padding(horizontal = 8.dp))
        else -> Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = if (line.role == "user") Arrangement.End else Arrangement.Start,
        ) {
            Card(shape = RoundedCornerShape(14.dp)) {
                Text(line.text, modifier = Modifier.padding(10.dp), fontSize = 13.sp)
            }
        }
    }
}

@Composable
private fun SendBall(enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .size(56.dp)
            .border(2.dp, MaterialTheme.colorScheme.outline, CircleShape)
            .clip(CircleShape)
            .background(Color.Black)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(if (enabled) "↑" else "…", color = Color.White, fontSize = 20.sp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CastScreen(vm: AppViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { TextButton(onClick = { vm.openPage(AppPage.HOME) }) { Text("返回") } },
                title = { Text("电脑投屏") },
                actions = {
                    TextButton(onClick = { vm.toggleCast() }) { Text(if (vm.castOn) "停止" else "开始") }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding).padding(12.dp)) {
            val img = vm.castImage
            if (img != null) {
                Image(bitmap = img, contentDescription = "电脑屏幕", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
            } else {
                Text(
                    if (vm.castOn) "正在抓取电脑屏幕…" else "点右上角「开始」查看电脑屏幕（约 1 帧/秒）",
                    color = MaterialTheme.colorScheme.secondary,
                    fontSize = 13.sp,
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ComboScreen(vm: AppViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { TextButton(onClick = { vm.openPage(AppPage.HOME) }) { Text("返回") } },
                title = { Text("自由组合") },
                actions = {
                    TextButton(onClick = { vm.runCombo() }, enabled = !vm.comboBusy) { Text(if (vm.comboBusy) "执行中…" else "运行") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(12.dp)) {
            Text("勾选工具后点「运行」，将按清单顺序依次调用（无参数工具直接执行）。", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
            LazyColumn(Modifier.weight(1f).padding(vertical = 8.dp)) {
                items(vm.tools) { tool: ToolInfo ->
                    Row(Modifier.fillMaxWidth().clickable { vm.toggleComboTool(tool.name) }, verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = vm.comboSelected.contains(tool.name), onCheckedChange = { vm.toggleComboTool(tool.name) })
                        Text(tool.name, fontSize = 13.sp)
                    }
                    if (vm.comboSelected.contains(tool.name)) {
                        OutlinedTextField(
                            value = vm.comboArgs[tool.name] ?: "{}",
                            onValueChange = { vm.setComboArg(tool.name, it) },
                            textStyle = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.fillMaxWidth().padding(start = 40.dp, bottom = 4.dp),
                        )
                    }
                }
            }
            if (vm.comboResults.isNotEmpty()) {
                LazyColumn(Modifier.height(180.dp)) {
                    items(vm.comboResults) { line ->
                        Text(line, fontSize = 11.sp, modifier = Modifier.padding(vertical = 2.dp))
                    }
                }
            }
        }
    }
}
