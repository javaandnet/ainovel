package jp.co.fsr.ainovel.net

import jp.co.fsr.ainovel.AppConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * ainovel API 路径（相对 AppConfig.baseURL，即带 /novel 前缀的站点根）。
 * 逐端点与 src/routes.js 对齐；带参数的用函数拼接。
 */
object Endpoint {
    // 认证（公开）
    const val LOGIN = "api/login"
    const val LOGOUT = "api/logout"
    const val ME = "api/me"

    // 推理链路健康
    const val LLM_STATUS = "api/llm-status"
    const val PROGRESS = "api/progress"

    // 小说
    const val NOVELS = "api/novels"
    fun novel(id: String) = "api/novels/$id"
    fun chapters(id: String) = "api/novels/$id/chapters"
    fun chapter(id: String, no: Int) = "api/novels/$id/chapter/$no"
    fun outline(id: String, no: Int) = "api/novels/$id/chapter/$no/outline"
    fun outlineDraft(id: String, no: Int) = "api/novels/$id/chapter/$no/outline-draft"
    fun deleteChapter(id: String, no: Int) = "api/novels/$id/chapter/$no"
    fun renumber(id: String) = "api/novels/$id/renumber"
    fun settings(id: String) = "api/novels/$id/settings"
    fun parts(id: String) = "api/novels/$id/parts"
    fun check(id: String) = "api/novels/$id/check"
    fun publish(id: String) = "api/novels/$id/publish"
    fun share(id: String) = "api/novels/$id/share"
    fun preview(id: String) = "api/novels/$id/preview"
    fun previewReport(id: String) = "api/novels/$id/preview/report"
    fun vip(id: String) = "api/novels/$id/vip"

    // 通用动作入口（菜单/AI 共用；action 白名单见 routes.js ALLOWED_ACTIONS）
    const val RUN = "api/run"

    // 阅读器 AI（公开，无需登录）
    const val READER_QUIZ = "api/reader/quiz"
    const val READER_EXPLAIN = "api/reader/explain"
    const val READER_VOCAB = "api/reader/vocab"
    const val READER_EXPLAIN_WORD = "api/reader/explain-word"
    const val READER_WORD_STATUS = "api/reader/word-status"
    const val READER_ASK = "api/reader/ask"
    const val READER_FEEDBACK = "api/reader/feedback"

    // TTS（公开）
    const val TTS_SENTENCE = "api/tts/sentence"
}

/** 统一错误模型：抛出时即携带面向用户的中文文案（与 iOS APIError.errorDescription 对齐）。 */
sealed class ApiError(message: String) : Exception(message) {
    class Network(detail: String) : ApiError("网络错误：$detail")
    class TimedOut : ApiError("请求超时，请稍后重试。")
    class CannotConnect : ApiError("无法连接服务器，请在「服务器设置」确认地址。")
    class InvalidResponse : ApiError("服务器响应异常。")
    class Decoding(detail: String) : ApiError("数据解析失败：$detail")
    class Unauthorized : ApiError("登录已过期，请重新登录。")
    class Cancelled : ApiError("请求已取消。")
    class HttpStatus(val code: Int, msg: String?) : ApiError(httpBase(code) + if (!msg.isNullOrEmpty()) "：$msg" else "")

    companion object {
        private fun httpBase(code: Int): String = when (code) {
            400 -> "请求有误"
            401 -> "未登录或登录已过期"
            403 -> "无权访问"
            404 -> "资源不存在"
            409 -> "操作冲突"
            410 -> "该功能已停用"
            429 -> "请求过于频繁"
            else -> "请求失败($code)"
        }
    }
}

/**
 * Cookie 存储桥：OkHttp 与 WebView 共用 Android 系统 CookieManager——
 * 登录 Set-Cookie 会被保存并在后续同源请求回传；「直接观看」的 WebView 也自动带上会话 Cookie，
 * VIP 书页不会被拦成无权页（对应 iOS 侧 CookieSync 的职责）。
 */
object WebKitCookieJar : CookieJar {
    private val cm get() = android.webkit.CookieManager.getInstance()

    override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
        for (c in cookies) cm.setCookie(url.toString(), c.toString())
        cm.flush()
    }

    override fun loadForRequest(url: HttpUrl): List<Cookie> {
        val header = cm.getCookie(url.toString()) ?: return emptyList()
        return header.split("; ").mapNotNull { runCatching { Cookie.parse(url, it) }.getOrNull() }
    }
}

/**
 * 统一网络层。约定（与 ainovel 后端 src/auth/session.js 对齐）：
 * - 鉴权走 httpOnly Cookie（ainovel_session，Path=/novel），由 WebKitCookieJar 自动维持；
 *   所有请求必须走带 /novel 前缀的 baseURL。
 * - 成功：HTTP 2xx，body 直接是业务 JSON（后端无统一 {success,data} 信封，各端点形状各异）。
 * - 失败：顶层 { error: "中文文案" }，抛 ApiError.HttpStatus。
 * - 401：受保护端点触发全局登出回调；登录/探测类端点的 401 当作普通错误透出文案。
 */
object ApiClient {
    @PublishedApi
    internal val json = Json { ignoreUnknownKeys = true; isLenient = true }

    /** 收到受保护端点 401 时回调（用于自动登出） */
    var onUnauthorized: () -> Unit = {}

    /** 未登录态即可访问 / 或作为探测用的端点：这些路径的 401 不触发登出，直接透文案 */
    private val publicPrefixes = listOf("api/login", "api/logout", "api/me", "api/reader/", "api/tts/")

    private val baseClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .cookieJar(WebKitCookieJar)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(AppConfig.REQUEST_TIMEOUT_SEC, TimeUnit.SECONDS)
            .build()
    }

    private fun isPublic(path: String) = publicPrefixes.any { path.startsWith(it) }

    private fun buildUrl(path: String, query: Map<String, String>?): HttpUrl {
        val builder = (AppConfig.baseURL.trimEnd('/') + "/" + path).toHttpUrl().newBuilder()
        query?.forEach { (k, v) -> builder.addQueryParameter(k, v) }
        return builder.build()
    }

    /** 发起请求，返回 body 字符串；出错统一抛 ApiError（message 即用户可见文案） */
    suspend fun requestText(
        method: String,
        path: String,
        query: Map<String, String>? = null,
        body: JsonElement? = null,
        timeoutSec: Long? = null,
    ): String = suspendCancellableCoroutine { cont ->
        val req = Request.Builder().url(buildUrl(path, query)).apply {
            header("Accept", "application/json")
            val reqBody: RequestBody? = body?.toString()
                ?.toRequestBody("application/json".toMediaType())
            when (method) {
                "GET" -> get()
                "POST" -> post(reqBody ?: ByteArray(0).toRequestBody(null))
                "PUT" -> put(reqBody ?: ByteArray(0).toRequestBody(null))
                "DELETE" -> delete(reqBody)
                else -> method(method, reqBody)
            }
        }.build()

        val client = if (timeoutSec != null) {
            baseClient.newBuilder()
                .callTimeout(timeoutSec, TimeUnit.SECONDS)
                .readTimeout(timeoutSec, TimeUnit.SECONDS)
                .build()
        } else baseClient

        val call = client.newCall(req)
        cont.invokeOnCancellation { call.cancel() }

        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (call.isCanceled()) {
                    cont.resumeWithException(ApiError.Cancelled())
                    return
                }
                if (e is SocketTimeoutException) cont.resumeWithException(ApiError.TimedOut())
                else if (e is java.net.ConnectException || e is java.net.UnknownHostException)
                    cont.resumeWithException(ApiError.CannotConnect())
                else cont.resumeWithException(ApiError.Network(e.message ?: "unknown"))
            }

            override fun onResponse(call: Call, response: Response) {
                response.use { resp ->
                    val text = runCatching { resp.body?.string() }.getOrNull() ?: ""
                    if (resp.code == 401 && !isPublic(path)) {
                        val cb = onUnauthorized
                        CoroutineScope(Dispatchers.Main).launch { cb() }
                        cont.resumeWithException(ApiError.Unauthorized())
                        return
                    }
                    if (resp.isSuccessful) {
                        cont.resume(text)
                        return
                    }
                    // 失败：提取后端 error 文案（登录失败的 401 也走这里，展示"用户名或密码错误"）
                    val msg = runCatching {
                        json.parseToJsonElement(text).let { el ->
                            (el as? JsonObject)?.get("error")?.let { (it as? JsonPrimitive)?.contentOrNull }
                        }
                    }.getOrNull()
                    cont.resumeWithException(ApiError.HttpStatus(resp.code, msg))
                }
            }
        })
    }

    suspend inline fun <reified T> get(
        path: String, query: Map<String, String>? = null, timeoutSec: Long? = null
    ): T = decode(requestText("GET", path, query, null, timeoutSec))

    suspend inline fun <reified T> post(
        path: String, body: JsonObject? = null, timeoutSec: Long? = null
    ): T = decode(requestText("POST", path, null, body, timeoutSec))

    suspend inline fun <reified T> put(
        path: String, body: JsonObject? = null, timeoutSec: Long? = null
    ): T = decode(requestText("PUT", path, null, body, timeoutSec))

    suspend inline fun <reified T> delete(
        path: String, body: JsonObject? = null, timeoutSec: Long? = null
    ): T = decode(requestText("DELETE", path, null, body, timeoutSec))

    suspend fun postVoid(path: String, body: JsonObject? = null, timeoutSec: Long? = null) {
        requestText("POST", path, null, body, timeoutSec)
    }

    inline fun <reified T> decode(text: String): T = try {
        json.decodeFromString(serializer(), text)
    } catch (e: Exception) {
        throw ApiError.Decoding(e.message ?: "JSON 解析异常")
    }
}
