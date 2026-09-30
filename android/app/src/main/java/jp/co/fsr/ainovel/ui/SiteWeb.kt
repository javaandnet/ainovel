package jp.co.fsr.ainovel.ui

import android.annotation.SuppressLint
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.viewinterop.AndroidView
import jp.co.fsr.ainovel.AppConfig
import java.net.URI
import java.net.URLEncoder

/**
 * 站点 URL 工具（对应 iOS SiteWebView 的 relativeURL/absoluteSiteURL）：
 * - share.url 是带 /novel 前缀的相对路径（含中文书名），需逐段百分号编码后拼 origin；
 * - 已是完整 URL 时原样返回。
 */
object SiteUrls {
    /** 相对站点路径（如 /novel/uid/书名/index.html）转完整 URL 字符串：中文路径先百分号编码。 */
    fun relativeURL(path: String?): String? {
        if (path.isNullOrEmpty()) return null
        val encodedPath = path.split("/")
            .joinToString("/") { URLEncoder.encode(it, "UTF-8").replace("+", "%20") }
        return absoluteSiteURL(encodedPath)
    }

    /** 相对形式（以 / 开头）用 baseURL 的 origin 补全；已是完整 URL 时原样返回 */
    fun absoluteSiteURL(url: String): String? {
        if (url.startsWith("http://") || url.startsWith("https://")) return url
        val base = runCatching { URI(AppConfig.baseURL) }.getOrNull() ?: return null
        val scheme = base.scheme ?: return null
        val host = base.host ?: return null
        val port = if (base.port > 0) ":${base.port}" else ""
        val p = if (url.startsWith("/")) url else "/$url"
        return "$scheme://$host$port$p"
    }
}

/**
 * 内置「直接观看」：WebView 打开发布后的读者站页面（真实书页，含内嵌测试题/生词/官方朗读）。
 * 会话 Cookie 由 WebKitCookieJar 统一落在系统 CookieManager，WebView 自动共享，
 * VIP 书页不会被拦成无权页（对应 iOS 的 CookieSync 注入逻辑）。
 */
@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun SiteWebPage(url: String, title: String, onDismiss: () -> Unit) {
    var loading by remember { mutableStateOf(true) }

    Column(Modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(title, maxLines = 1) },
            navigationIcon = { DetailNavBack(onDismiss) },
            actions = {
                TextButton(onClick = onDismiss) { Text("关闭") }
            },
        )
        Box(Modifier.fillMaxSize()) {
            val fixed = SiteUrls.absoluteSiteURL(url)
            if (fixed == null) {
                StateView("地址无效")
            } else {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = { ctx ->
                        WebView(ctx).apply {
                            webViewClient = object : WebViewClient() {
                                override fun onPageStarted(view: WebView?, u: String?, favicon: android.graphics.Bitmap?) {
                                    loading = true
                                }

                                override fun onPageFinished(view: WebView?, u: String?) {
                                    loading = false
                                }
                            }
                            settings.javaScriptEnabled = true
                            loadUrl(fixed)
                        }
                    },
                )
                if (loading) {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
            }
        }
    }
}
