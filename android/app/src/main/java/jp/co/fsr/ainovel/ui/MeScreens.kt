package jp.co.fsr.ainovel.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import jp.co.fsr.ainovel.AppConfig
import jp.co.fsr.ainovel.AuthState

/** 「我的」Tab：账号信息 / 服务器设置 / 退出登录。 */
@Composable
fun MeScreen() {
    var showLogoutConfirm by remember { mutableStateOf(false) }

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState()),
    ) {
        DetailTopBarStatic("我的")

        if (AuthState.isLoggedIn) {
            SectionTitle("账号")
            LabelRow("用户", AuthState.user?.display ?: "—")
            LabelRow("角色", AuthState.user?.role ?: "—")
            AuthState.user?.id?.let { LabelRow("用户 ID", it) }
        } else {
            LabelRow("登录状态", "未登录（可浏览公开书单）")
            Text(
                "登录后可阅读完整章节与管理自己的作品。",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp),
            )
            TextButton(onClick = { AuthState.requestLogin() }, modifier = Modifier.padding(horizontal = 16.dp)) {
                Text("登录")
            }
        }

        SectionTitle("连接")
        ServerSettingsCard()

        if (AuthState.isLoggedIn) {
            TextButton(
                onClick = { showLogoutConfirm = true },
                modifier = Modifier.padding(16.dp),
            ) { Text("退出登录", color = MaterialTheme.colorScheme.error) }
        }
    }

    if (showLogoutConfirm) {
        AlertDialog(
            onDismissRequest = { showLogoutConfirm = false },
            title = { Text("确认退出登录？") },
            confirmButton = {
                TextButton(onClick = {
                    showLogoutConfirm = false
                    AuthState.logout()
                }) { Text("退出", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { showLogoutConfirm = false }) { Text("取消") } },
        )
    }
}

@Composable
private fun LabelRow(label: String, value: String) {
    Row(Modifier
        .fillMaxWidth()
        .padding(horizontal = 16.dp, vertical = 4.dp)) {
        Text(label, fontSize = 14.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, fontSize = 14.sp, modifier = Modifier.weight(2f))
    }
}

/**
 * 服务器设置：填写 ainovel 站点根地址（可指向远程/线上服务器）。
 * 只需填 host[:port]，App 自动补 http:// 与 /novel 前缀；填完整 URL（含自定义前缀路径）时原样保留。
 * 保存后即时生效（AppConfig.baseURL 每次请求动态读取），并清除当前登录态需重新登录（Cookie 属另一域）。
 */
@Composable
fun ServerSettingsCard() {
    var text by remember { mutableStateOf(AppConfig.customServerURL ?: "") }
    var hint by remember { mutableStateOf<String?>(null) }

    Column(Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it; hint = null },
            label = { Text("服务器地址") },
            placeholder = { Text("例如 192.168.1.55:3400 或 novel.example.com") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )
        Text(
            "留空则恢复默认（${AppConfig.defaultBaseURL}）。真机连本机开发服务需与 Mac 同一 Wi-Fi；生产环境请用 HTTPS 域名。当前：${AppConfig.displayBaseURL}",
            fontSize = 11.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = 4.dp),
        )
        hint?.let {
            Text(it, color = Color(0xFFE65100), fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
        }
        Row(Modifier.padding(top = 6.dp)) {
            TextButton(onClick = {
                val trimmed = text.trim()
                if (trimmed.isEmpty()) {
                    AppConfig.setCustomServer("")
                    AuthState.serverChanged()
                    hint = "已恢复默认地址，请重新登录。"
                    return@TextButton
                }
                val url = AppConfig.normalize(trimmed)
                if (url == null) {
                    hint = "地址格式无法识别，请检查。"
                    return@TextButton
                }
                AppConfig.setCustomServer(trimmed)
                AuthState.serverChanged()
                hint = "已切换到：$url，请重新登录。"
            }) { Text("保存") }
            TextButton(onClick = {
                AppConfig.setCustomServer("")
                AuthState.serverChanged()
                text = ""
                hint = "已恢复默认地址，请重新登录。"
            }) { Text("恢复默认", color = MaterialTheme.colorScheme.error) }
        }
    }
}

/** 登录页内容（登录对话框与「我的」页共用）。 */
@Composable
fun LoginContent(onLoggedIn: () -> Unit) {
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var rememberPwd by remember { mutableStateOf(true) }

    // 记住的凭据预填
    androidx.compose.runtime.LaunchedEffect(Unit) {
        AuthState.savedCredential()?.let { (u, p) ->
            if (username.isEmpty()) username = u
            if (password.isEmpty()) password = p
        }
    }

    Column(Modifier.padding(20.dp)) {
        Text("服务器：${AppConfig.displayBaseURL}", fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
        OutlinedTextField(
            value = username,
            onValueChange = { username = it },
            label = { Text("用户名") },
            singleLine = true,
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
        )
        OutlinedTextField(
            value = password,
            onValueChange = { password = it },
            label = { Text("密码") },
            singleLine = true,
            visualTransformation = androidx.compose.ui.text.input.PasswordVisualTransformation(),
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                imeAction = androidx.compose.ui.text.input.ImeAction.Done,
                keyboardType = androidx.compose.ui.text.input.KeyboardType.Password,
            ),
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
        )
        Row(Modifier.padding(top = 8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            androidx.compose.material3.Checkbox(checked = rememberPwd, onCheckedChange = { rememberPwd = it })
            Text("记住密码")
        }
        AuthState.errorMessage?.let {
            Text(it, color = Color.Red, fontSize = 13.sp, modifier = Modifier.padding(top = 8.dp))
        }
        TextButton(
            enabled = username.isNotEmpty() && password.isNotEmpty() && !AuthState.isBusy,
            onClick = {
                AuthState.login(username, password, rememberPwd) { ok ->
                    if (ok) onLoggedIn()
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
        ) {
            Text(if (AuthState.isBusy) "登录中…" else "登录")
        }
    }
}
