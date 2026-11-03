package com.pet.mcpclient.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.pet.mcpclient.data.ToolInfo
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive

private val RiskWrite = Color(0xFFB26A00)
private val RiskDanger = Color(0xFFB3261E)
private val RiskRead = Color(0xFF1E6B3A)

@Composable
fun PetMcpApp(vm: AppViewModel) {
    when {
        vm.showSettings -> SettingsScreen(vm)
        !vm.connected -> ConnectScreen(vm)
        vm.page == AppPage.HOME -> HomeScreen(vm)
        vm.page == AppPage.CHAT -> ChatScreen(vm)
        vm.page == AppPage.CAST -> CastScreen(vm)
        vm.page == AppPage.COMBO -> ComboScreen(vm)
        vm.selected != null -> ToolRunScreen(vm)
        else -> ToolsScreen(vm)
    }
}

@Composable
private fun RiskBadge(tool: ToolInfo) {
    val (label, color) = when {
        tool.annotations.destructiveHint -> "危险" to RiskDanger
        tool.annotations.readOnlyHint -> "只读" to RiskRead
        else -> "写入" to RiskWrite
    }
    Text(
        text = label,
        color = color,
        fontSize = 11.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier
            .background(color.copy(alpha = 0.10f), RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 2.dp),
    )
}

@Composable
private fun ErrorCard(message: String, onDismiss: (() -> Unit)? = null) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)) {
        Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(message, color = MaterialTheme.colorScheme.onErrorContainer, fontSize = 13.sp, modifier = Modifier.weight(1f))
            if (onDismiss != null) TextButton(onClick = onDismiss) { Text("知道了") }
        }
    }
}

@Composable
private fun ConnectScreen(vm: AppViewModel) {
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text("Pet MCP", fontSize = 26.sp, fontWeight = FontWeight.Bold)
        Text(
            "远程连接电脑端桌宠的 MCP 服务端。工具清单在连接后从电脑端实时拉取，不内置任何工具名。",
            fontSize = 13.sp,
            color = MaterialTheme.colorScheme.secondary,
        )
        OutlinedTextField(
            value = vm.host,
            onValueChange = { vm.host = it },
            label = { Text("电脑端地址") },
            placeholder = { Text("http://电脑局域网IP:37653（可粘贴电脑端提示的完整地址）") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
            enabled = !vm.busy,
        )
        OutlinedTextField(
            value = vm.token,
            onValueChange = { vm.token = it },
            label = { Text("访问 token") },
            placeholder = { Text("电脑端设置 → 反向接入 → token") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth(),
            enabled = !vm.busy,
        )
        Button(onClick = { vm.connect() }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth()) {
            if (vm.busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
            Spacer(Modifier.size(8.dp))
            Text(if (vm.busy) "连接中…" else "连接")
        }
        vm.error?.let { ErrorCard(it) { vm.error = null } }
        Card {
            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("连接前检查", fontWeight = FontWeight.Medium, fontSize = 13.sp)
                Text("1. 电脑端设置 → MCP → 开启「反向接入」，端口与 token 抄到上面", fontSize = 12.sp)
                Text("2. 手机与电脑在同一 Wi-Fi；电脑端允许局域网（防火墙放行）。", fontSize = 12.sp)
                Text("   局域网走明文 http + token，仅建议可信网络；地址可直接粘贴电脑端提示的完整 .../mcp 地址", fontSize = 12.sp)
                Text("3. 通道自动选择：WebSocket 优先，不可用回退 HTTP", fontSize = 12.sp)
                Text("4. 每次调用都有超时（默认 20s），失败会在执行页给出错误", fontSize = 12.sp)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ToolsScreen(vm: AppViewModel) {
    val filtered = vm.filtered()
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = { TextButton(onClick = { vm.openPage(AppPage.HOME) }) { Text("返回") } },
                title = { Text("工具 · ${vm.tools.size}") },
                actions = {
                    TextButton(onClick = { vm.refresh() }, enabled = !vm.busy) { Text("刷新") }
                    TextButton(onClick = { vm.reconnect() }, enabled = !vm.busy) { Text("重连") }
                    TextButton(onClick = { vm.showSettings = true }) { Text("设置") }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).padding(horizontal = 12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("通道 ${vm.channel}", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
                Text("·", color = MaterialTheme.colorScheme.secondary)
                Text("手机工具 ${vm.phoneToolCount} 个", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
            }
            Spacer(Modifier.height(8.dp))
            OutlinedTextField(
                value = vm.filter,
                onValueChange = { vm.filter = it },
                placeholder = { Text("搜索工具…") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(8.dp))
            vm.error?.let { ErrorCard(it) { vm.error = null } }
            if (filtered.isEmpty()) {
                Spacer(Modifier.height(40.dp))
                Text(
                    if (vm.tools.isEmpty()) "电脑端没有返回工具，点右上角刷新" else "没有匹配的工具",
                    Modifier.fillMaxWidth(),
                    color = MaterialTheme.colorScheme.secondary,
                    fontSize = 13.sp,
                )
            } else {
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(filtered, key = { it.name }) { tool ->
                        Card(Modifier.fillMaxWidth().clickable { vm.open(tool) }) {
                            Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                    Text(tool.name, fontWeight = FontWeight.Medium, fontSize = 14.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                                    RiskBadge(tool)
                                }
                                if (tool.description.isNotBlank()) {
                                    Text(tool.description, fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                }
                            }
                        }
                    }
                    item { Spacer(Modifier.height(12.dp)) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ToolRunScreen(vm: AppViewModel) {
    val tool = vm.selected ?: return
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(tool.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { TextButton(onClick = { vm.closeTool() }) { Text("返回") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                RiskBadge(tool)
                Text("超时 ${tool.annotations.timeoutMs ?: 20000}ms", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
            }
            if (tool.description.isNotBlank()) Text(tool.description, fontSize = 13.sp)
            Text("参数（JSON，按电脑端 schema 填写）", fontSize = 12.sp, color = MaterialTheme.colorScheme.secondary)
            OutlinedTextField(
                value = vm.argsText,
                onValueChange = { vm.setArgs(it) },
                textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace),
                modifier = Modifier.fillMaxWidth().height(160.dp),
                enabled = !vm.busy,
            )
            Button(onClick = { vm.requestRun() }, enabled = !vm.busy, modifier = Modifier.fillMaxWidth()) {
                if (vm.busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = Color.White)
                Spacer(Modifier.size(8.dp))
                Text(if (vm.busy) "执行中…" else "执行")
            }
            vm.error?.let { ErrorCard(it) { vm.error = null } }
            vm.result?.let {
                Card {
                    Column(Modifier.padding(12.dp)) {
                        Text("结果", fontWeight = FontWeight.Medium, fontSize = 13.sp)
                        Spacer(Modifier.height(6.dp))
                        Text(it, fontSize = 12.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace)
                    }
                }
            }
        }
    }
    if (vm.showConfirm) {
        AlertDialog(
            onDismissRequest = { vm.showConfirm = false },
            title = { Text("确认调用「${tool.name}」") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("该工具会修改状态${if (tool.annotations.destructiveHint) "，且标记为危险操作" else ""}。", fontSize = 13.sp)
                    Text(vm.argsText, fontSize = 11.sp, fontFamily = androidx.compose.ui.text.font.FontFamily.Monospace, maxLines = 6, overflow = TextOverflow.Ellipsis)
                }
            },
            confirmButton = { TextButton(onClick = { vm.runTool() }) { Text("确认执行") } },
            dismissButton = { TextButton(onClick = { vm.showConfirm = false }) { Text("取消") } },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(vm: AppViewModel) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置 / 自检") },
                navigationIcon = { TextButton(onClick = { vm.showSettings = false }) { Text("返回") } },
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            val context = LocalContext.current
            val version = remember { runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "-" }.getOrDefault("-") }
            InfoRow("版本", "v$version")
            InfoRow("连接状态", if (vm.connected) "已连接（${vm.channel}）" else "未连接")
            InfoRow("工具目录", "${vm.tools.size} 个（运行时拉取）")
            InfoRow("手机原生工具", "${vm.phoneToolCount} 个")
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { vm.registerPhoneTools() }, enabled = vm.connected) { Text("注册手机工具") }
                Button(onClick = { vm.refresh() }, enabled = vm.connected && !vm.busy) { Text("重新拉取工具") }
            }
            if (vm.connected) {
                TextButton(onClick = { vm.disconnect() }) { Text("断开连接") }
            }
            HorizontalDivider()
            Text("最近日志（脱敏）", fontWeight = FontWeight.Medium, fontSize = 13.sp)
            vm.logs.take(12).forEach {
                Text(it, fontSize = 11.sp, color = MaterialTheme.colorScheme.secondary)
            }
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(label, fontSize = 13.sp)
        Text(value, fontSize = 13.sp, color = MaterialTheme.colorScheme.secondary)
    }
}
