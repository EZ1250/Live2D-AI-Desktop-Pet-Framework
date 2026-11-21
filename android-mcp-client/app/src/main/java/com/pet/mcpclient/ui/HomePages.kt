/**
主页与各功能页（对话/投屏/工具入口/自由组合）。
 * 说明：本文件只放 Compose 界面；业务动作全部经 AppViewModel；
 * 对话页的球心坐标映射在 ChatScreen 内，改动时注意与 pet_touch 协议保持一致。
 */
package com.pet.mcpclient.ui
import android.app.Activity
import android.content.ContextWrapper
import android.content.pm.ActivityInfo
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.drawscope.withTransform
import kotlin.math.min
import android.os.SystemClock
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.draw.shadow
import androidx.activity.compose.BackHandler
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding

import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.input.pointer.PointerEventPass
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
            HomeEntry("🖥  电脑投屏", "查看电脑屏幕（实时投屏（约 24fps+））") { vm.openPage(AppPage.CAST) }
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
                    TextButton(onClick = { menuOpen = true }) { Text("⋮") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("新对话") }, onClick = { vm.newChat(); menuOpen = false })
                        DropdownMenuItem(text = { Text("历史对话（电脑端）") }, onClick = { vm.loadRemoteHistory(); historyOpen = true; menuOpen = false })
                        DropdownMenuItem(text = { Text(if (vm.showThinking) "隐藏思考过程" else "显示思考过程") }, onClick = { vm.showThinking = !vm.showThinking; menuOpen = false })
                        DropdownMenuItem(text = { Text("对话信息") }, onClick = { infoOpen = true; menuOpen = false })
                        DropdownMenuItem(text = { Text(if (vm.avatarOn) "隐藏桌宠" else "显示桌宠") }, onClick = { vm.toggleAvatar(); menuOpen = false })
                    }
                },
            )
        },
    ) { padding ->
        BoxWithConstraints(
            Modifier
                .fillMaxSize()
                .imePadding()
                .padding(padding)
        ) {
            val density = LocalDensity.current
            val ballDp = vm.avatarBallSizeDp.dp
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
                    Modifier.weight(1f)
                        .pointerInput(ball, ballPx) {
                            detectTapGestures { tap ->
                                // v1.0.5 基线：球心 = (0.5,0.5)，球径为 1 单位
                                val nx = 0.5f + (tap.x + padLeftPx - (ball.x + ballPx / 2)) / ballPx
                                val ny = 0.5f + (tap.y + padTopPx - (ball.y + ballPx / 2)) / ballPx
                                vm.touchMove(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f))
                                // 保留“点击只在悬浮球”修复：列表区域只跟踪视线，不触发点击
                            }
                        }
                        .pointerInput(ball, ballPx) {
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
            // v0.4.7 悬浮球：透明 PNG 用白色磨砂底；JPEG 黑底用深色球
            val transparentBall = vm.avatarTransparent
            val ballBrush = if (transparentBall) {
                Brush.radialGradient(colors = listOf(Color(0xE6FFFFFF), Color(0xB8FFFFFF), Color(0x66FFFFFF)))
            } else {
                Brush.radialGradient(colors = listOf(Color(0xFF121A24), Color(0xFF05080C)))
            }
            Box(
                Modifier
                    .offset { IntOffset(ball.x.roundToInt(), ball.y.roundToInt()) }
                    .size(ballDp)
                    .shadow(10.dp, CircleShape)
                    .clip(CircleShape)
                    .background(ballBrush)
                    .border(1.5.dp, if (transparentBall) Color(0xCCFFFFFF) else Color(0x66333B45), CircleShape)
                    .pointerInput(vm.avatarOn) {
                        detectTapGestures { pos ->
                            if (vm.avatarOn) {
                                val nx = 0.5f + (pos.x - size.width / 2f) / size.width
                                val ny = 0.5f + (pos.y - size.height / 2f) / size.height
                                vm.touchClick(nx.coerceIn(0f, 1f), ny.coerceIn(0f, 1f))
                            } else vm.toggleAvatar()
                        }
                    }
                    .pointerInput(Unit) {
                        detectDragGestures { change, drag ->
                            change.consume()
                            avatarOffset = clampBall((avatarOffset ?: ball) + drag)
                        }
                    },
            ) {
                // 头像绘制：帧号在 draw 阶段读取 → 只重绘这块，不重组整个对话页
                PetAvatarCanvas(vm)
                if (!vm.avatarHasFrame) {
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
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    val configuration = LocalConfiguration.current
    val isLandscape = configuration.orientation == android.content.res.Configuration.ORIENTATION_LANDSCAPE
    var scale by remember { mutableFloatStateOf(1f) }
    var pan by remember { mutableStateOf(Offset.Zero) }
    var pointerDown by remember { mutableStateOf(false) }
    var rightClickJob by remember { mutableStateOf<Job?>(null) }
    var panUnlockAt by remember { mutableStateOf(0L) }
    var moreOpen by remember { mutableStateOf(false) }
    var fullscreen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var hint by remember { mutableStateOf("") }
    var hintJob by remember { mutableStateOf<Job?>(null) }
    fun showHint(text: String) {
        hint = text
        hintJob?.cancel()
        hintJob = scope.launch {
            delay(1500)
            if (hint == text) hint = ""
        }
    }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    var keyboardOpen by remember { mutableStateOf(false) }
    var inputText by remember { mutableStateOf("") }
    fun closeKeyboard() {
        keyboardOpen = false
        keyboardController?.hide()
        vm.consumeCastKeyboardWanted()
    }
    BackHandler(enabled = fullscreen || keyboardOpen) {
        if (keyboardOpen) closeKeyboard() else if (fullscreen) fullscreen = false
    }
    DisposableEffect(fullscreen, activity) {
        val window = activity?.window
        val controller = window?.let { WindowCompat.getInsetsController(it, it.decorView) }
        if (window != null && controller != null) {
            if (fullscreen) {
                WindowCompat.setDecorFitsSystemWindows(window, false)
                controller.hide(WindowInsetsCompat.Type.systemBars())
                controller.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            } else {
                WindowCompat.setDecorFitsSystemWindows(window, true)
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
        }
        onDispose {
            if (window != null && controller != null) {
                WindowCompat.setDecorFitsSystemWindows(window, true)
                controller.show(WindowInsetsCompat.Type.systemBars())
            }
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            rightClickJob?.cancel()
        }
    }
    // 点击输入框后电脑端通知“可输入”→ 自动弹手机输入法
    LaunchedEffect(vm.castKeyboardWanted) {
        if (vm.castKeyboardWanted) {
            vm.consumeCastKeyboardWanted()
            keyboardOpen = true
        }
    }
    LaunchedEffect(keyboardOpen) {
        if (keyboardOpen) {
            withFrameNanos { }
            runCatching { focusRequester.requestFocus() }
            keyboardController?.show()
        }
    }
    val imeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    LaunchedEffect(imeVisible) {
        // 用户用手势/系统按钮收起键盘时，同步状态；避免 BackHandler 永远认为键盘还开着
        if (!imeVisible && keyboardOpen) keyboardOpen = false
    }
    Scaffold(
        topBar = {
            if (!fullscreen) {
                TopAppBar(
                    navigationIcon = { TextButton(onClick = { vm.openPage(AppPage.HOME) }) { Text("返回") } },
                    title = { Text(if (vm.castOn) "电脑投屏 · 已连接" else "电脑投屏 · 未连接") },
                    actions = {
                        TextButton(onClick = { vm.requestCastKeyboard() }) { Text("键盘") }
                        TextButton(onClick = { vm.toggleCast() }) { Text(if (vm.castOn) "停止" else "开始") }
                        TextButton(onClick = { moreOpen = true }) { Text("更多") }
                        DropdownMenu(expanded = moreOpen, onDismissRequest = { moreOpen = false }) {
                            DropdownMenuItem(text = { Text("复位缩放") }, onClick = { scale = 1f; pan = Offset.Zero; moreOpen = false })
                            DropdownMenuItem(text = { Text("全屏") }, onClick = { fullscreen = true; moreOpen = false })
                            DropdownMenuItem(text = { Text(if (isLandscape) "竖屏" else "横屏") }, onClick = {
                                activity?.requestedOrientation = if (isLandscape) {
                                    ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                                } else {
                                    ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
                                }
                                moreOpen = false
                            })
                        }
                    },
                )
            }
        },
    ) { padding ->
        BoxWithConstraints(
            Modifier.fillMaxSize()
                .then(if (fullscreen) Modifier else Modifier.padding(padding))
                .then(if (fullscreen) Modifier else Modifier.padding(8.dp))
                .clipToBounds(),
        ) {
            val density = androidx.compose.ui.platform.LocalDensity.current
            val tapSlopPx = with(density) { 24.dp.toPx() }
            val containerW = constraints.maxWidth.toFloat()
            val containerH = constraints.maxHeight.toFloat()
            val imgW = (vm.currentCastBitmap?.width ?: 16).toFloat()
            val imgH = (vm.currentCastBitmap?.height ?: 9).toFloat()
            val fitScale = min(containerW / imgW, containerH / imgH)
            val fittedW = (imgW * fitScale).coerceAtLeast(1f)
            val fittedH = (imgH * fitScale).coerceAtLeast(1f)
            fun clampPan(value: Offset, s: Float): Offset {
                val boundX = ((fittedW * s - containerW) / 2f).coerceAtLeast(0f)
                val boundY = ((fittedH * s - containerH) / 2f).coerceAtLeast(0f)
                return Offset(value.x.coerceIn(-boundX, boundX), value.y.coerceIn(-boundY, boundY))
            }
            LaunchedEffect(containerW, containerH, scale) { pan = clampPan(pan, scale) }
            val pivot = Offset(fittedW / 2f, fittedH / 2f)
            val imageLeft = (containerW - fittedW) / 2f + pan.x
            val imageTop = (containerH - fittedH) / 2f + pan.y
            fun normalizeTap(pos: Offset): Offset? {
                val qx = pivot.x + (pos.x - imageLeft - pivot.x) / scale
                val qy = pivot.y + (pos.y - imageTop - pivot.y) / scale
                if (qx < 0f || qx > fittedW || qy < 0f || qy > fittedH) return null
                return Offset((qx / fittedW).coerceIn(0f, 1f), (qy / fittedH).coerceIn(0f, 1f))
            }
            val tapTimes = remember { mutableListOf<Long>() }
            var lastTapPos by remember { mutableStateOf(Offset.Zero) }
            var tapJob by remember { mutableStateOf<Job?>(null) }
            val handleTap = rememberUpdatedState<(Offset) -> Unit> { pos ->
                val n = normalizeTap(pos) ?: return@rememberUpdatedState
                val now = SystemClock.uptimeMillis()
                tapTimes.removeAll { now - it > 700 }
                if (tapTimes.isNotEmpty() && (pos - lastTapPos).getDistance() > tapSlopPx) tapTimes.clear()
                lastTapPos = pos
                tapTimes.add(now)
                tapJob?.cancel()
                when (tapTimes.size) {
                    2 -> tapJob = scope.launch {
                        delay(380)
                        if (tapTimes.size == 2) {
                            tapTimes.clear()
                            if (vm.castMouseMove(n.x, n.y)) showHint("鼠标移动") else showHint("投屏未连接")
                        }
                    }
                    3 -> {
                        tapTimes.clear()
                        if (vm.castMouseClick(n.x, n.y)) showHint("鼠标左键单击") else showHint("投屏未连接")
                    }
                }
            }
            val longPressHandler = rememberUpdatedState<(Offset) -> Unit> { pos ->
                val n = normalizeTap(pos) ?: return@rememberUpdatedState
                panUnlockAt = SystemClock.uptimeMillis() + 500L
                rightClickJob?.cancel()
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                showHint("移动可拖动取景；按住不动 3s 右键")
                rightClickJob = scope.launch {
                    delay(2500) // 长按约 500ms + 2500ms = 3s
                    if (pointerDown) {
                        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                        if (vm.castMouseRightClick(n.x, n.y)) showHint("鼠标右键") else showHint("投屏未连接")
                    }
                }
            }
            Canvas(
                Modifier
                    .fillMaxSize()
                    .pointerInput(containerW.toInt(), containerH.toInt(), imgW.toInt(), imgH.toInt()) {
                        detectTapGestures(
                            onTap = { pos -> handleTap.value(pos) },
                            onLongPress = { pos -> longPressHandler.value(pos) },
                        )
                    }
                    .pointerInput(containerW.toInt(), containerH.toInt(), imgW.toInt(), imgH.toInt()) {
                        detectDragGesturesAfterLongPress(
                            // 注意：onDragStart 在长按刚成立时就会触发；不能在这里取消右键计时，
                            // 否则 3s 右键永远到不了。只有真正移动手指才取消。
                            onDragStart = { },
                            onDrag = { change, drag ->
                                if (drag.getDistance() > 2f) rightClickJob?.cancel()
                                if (scale > 1.01f && SystemClock.uptimeMillis() >= panUnlockAt) {
                                    change.consume()
                                    pan = clampPan(pan + drag, scale)
                                }
                            },
                        )
                    }
                    .pointerInput(Unit) {
                        awaitEachGesture {
                            awaitFirstDown(requireUnconsumed = false)
                            pointerDown = true
                            try {
                                while (true) {
                                    val event = awaitPointerEvent()
                                    if (event.changes.all { !it.pressed }) break
                                }
                            } finally {
                                pointerDown = false
                                rightClickJob?.cancel()
                            }
                        }
                    }
                    .pointerInput(containerW.toInt(), containerH.toInt(), imgW.toInt(), imgH.toInt()) {
                        detectTransformGestures { centroid, panChange, zoom, _ ->
                            val newScale = (scale * zoom).coerceIn(0.5f, 8f)
                            val center = Offset(containerW / 2f, containerH / 2f)
                            val anchorPoint = centroid - center
                            val newPan = pan + anchorPoint * (1f - newScale / scale) + panChange
                            scale = newScale
                            pan = clampPan(newPan, newScale)
                        }
                    },
            ) {
                val frame = vm.currentCastBitmap ?: return@Canvas
                if (frame.isRecycled) return@Canvas
                vm.castSeq
                val fit = min(size.width / frame.width, size.height / frame.height)
                val dw = frame.width * fit
                val dh = frame.height * fit
                val left = (size.width - dw) / 2f + pan.x
                val top = (size.height - dh) / 2f + pan.y
                withTransform({
                    translate(left, top)
                    scale(scale, scale, pivot = Offset(dw / 2f, dh / 2f))
                }) {
                    drawImage(
                        image = frame.asImageBitmap(),
                        dstSize = IntSize(dw.roundToInt().coerceAtLeast(1), dh.roundToInt().coerceAtLeast(1)),
                        filterQuality = FilterQuality.High,
                    )
                }
            }
            if (!vm.castHasFrame) {
                Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        if (vm.castOn) "正在连接投屏（目标 24fps）…" else "点「开始」查看电脑屏幕（可双指缩放/横屏/全屏）",
                        color = MaterialTheme.colorScheme.secondary,
                        fontSize = 13.sp,
                    )
                }
            }
            if (hint.isNotEmpty()) {
                Text(hint, modifier = Modifier.align(Alignment.TopCenter).padding(8.dp), fontSize = 12.sp, color = MaterialTheme.colorScheme.primary)
            }
            if (fullscreen) {
                TextButton(
                    onClick = { fullscreen = false },
                    modifier = Modifier.align(Alignment.TopEnd).padding(12.dp)
                        .background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(20.dp)),
                ) { Text("退出全屏", color = Color.White) }
            }
            if (keyboardOpen) {
                Card(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(8.dp)) {
                    Row(
                        Modifier.fillMaxWidth().padding(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        OutlinedTextField(
                            value = inputText,
                            onValueChange = { inputText = it },
                            modifier = Modifier.weight(1f).focusRequester(focusRequester),
                            placeholder = { Text("输入文字到电脑…", fontSize = 12.sp) },
                            maxLines = 3,
                            textStyle = androidx.compose.ui.text.TextStyle(fontSize = 13.sp),
                        )
                        Column {
                            TextButton(onClick = {
                                if (vm.castTypeText(inputText)) {
                                    inputText = ""
                                    showHint("已输入到电脑")
                                } else {
                                    showHint("投屏未连接")
                                }
                            }) { Text("发送") }
                            TextButton(onClick = { closeKeyboard() }) { Text("关闭") }
                        }
                    }
                }
            }
        }
    }
}

/** 从 Compose Context 找到宿主 Activity（用于横屏/恢复方向） */
private fun android.content.Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
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


/**
 * 桌宠头像画布。
 * 关键点：bitmap/帧号都在 DrawScope 内读取——Compose 只会让绘制阶段失效，
 * 不会因为每帧新图片而重组 ChatScreen（旧实现每帧 setState(ImageBitmap) 是掉帧主因）。
 */
@Composable
private fun PetAvatarCanvas(vm: AppViewModel) {
    Canvas(Modifier.fillMaxSize()) {
        val bmp = vm.currentAvatarBitmap ?: return@Canvas
        if (bmp.isRecycled) return@Canvas
        vm.avatarSeq // 触发 draw 阶段失效
        // 等比缩放（等价原 ContentScale.Fit）：竖图在圆球里不会横向拉宽
        val scale = minOf(size.width / bmp.width, size.height / bmp.height)
        val dstW = (bmp.width * scale).roundToInt().coerceAtLeast(1)
        val dstH = (bmp.height * scale).roundToInt().coerceAtLeast(1)
        drawImage(
            image = bmp.asImageBitmap(),
            dstOffset = IntOffset(((size.width - dstW) / 2f).roundToInt(), ((size.height - dstH) / 2f).roundToInt()),
            dstSize = IntSize(dstW, dstH),
            filterQuality = FilterQuality.High,
        )
    }
}
