package jp.co.fsr.ainovel

import android.content.Context
import android.preference.PreferenceManager

/**
 * 全局运行配置。站点根地址优先取用户在「服务器设置」里配的地址（SharedPreferences），
 * 其次编译默认值（真机连开发服务需同一 Wi-Fi；生产环境请用 HTTPS 域名）。
 *
 * 与 aistudy 不同：ainovel 鉴权走 httpOnly Cookie（Path=/novel），
 * 因此 baseURL 必须是**带 /novel 前缀的站点根**，所有 API 请求拼在其后的 api/...，
 * 否则 Cookie Path 不匹配、登录态不会被携带。
 */
object AppConfig {
    private const val SERVER_OVERRIDE_KEY = "ainovelServerBase"
    private const val DEFAULT_BASE = "http://127.0.0.1:3400/novel"

    lateinit var appContext: Context

    /** 用户自设服务器地址（已规范化）；未设/非法返回 null 回落默认 */
    val customServerURL: String?
        get() {
            val s = prefs().getString(SERVER_OVERRIDE_KEY, null) ?: return null
            return normalize(s)
        }

    /** 当前生效地址：用户设置 > 默认。每次请求动态读取，改设置即时生效。 */
    val baseURL: String
        get() = customServerURL ?: DEFAULT_BASE

    /** 保存用户服务器地址；传空串恢复默认 */
    fun setCustomServer(raw: String) {
        val trimmed = raw.trim()
        if (normalize(trimmed) == null) {
            prefs().edit().remove(SERVER_OVERRIDE_KEY).apply()
        } else {
            prefs().edit().putString(SERVER_OVERRIDE_KEY, trimmed).apply()
        }
    }

    /** 展示用的当前地址 */
    val displayBaseURL: String get() = baseURL

    /** 默认地址（展示给「服务器设置」页脚注） */
    val defaultBaseURL: String get() = DEFAULT_BASE

    /**
     * 规范化：补 scheme（缺省 http）、去尾斜杠；若只填 host[:port] 则自动补 /novel 前缀。
     * 用户填了自定义路径（例如反代到别的前缀）时原样保留，不强制补 /novel。
     */
    fun normalize(raw: String): String? {
        var s = raw.trim()
        if (s.isEmpty()) return null
        if (!s.contains("://")) s = "http://$s"
        while (s.endsWith("/")) s = s.dropLast(1)
        val uri = runCatching { java.net.URI(s) }.getOrNull() ?: return null
        val host = uri.host
        if (host.isNullOrEmpty() || host.contains("your-server.example.com")) return null
        val path = uri.path
        if (path.isNullOrEmpty() || path == "/") return "$s/novel"
        return s
    }

    /** 界面语言：AI 讲解/测试文案默认中文一侧 */
    const val UI_LANG = "zh"

    const val REQUEST_TIMEOUT_SEC = 30L

    /** LLM / 生成类接口耗时较长（整章生成实测约 150 秒），单独放宽 */
    const val LLM_TIMEOUT_SEC = 600L

    private fun prefs() = PreferenceManager.getDefaultSharedPreferences(appContext)
}
