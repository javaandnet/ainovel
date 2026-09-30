package jp.co.fsr.ainovel

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import jp.co.fsr.ainovel.data.LoginResponse
import jp.co.fsr.ainovel.data.MeResponse
import jp.co.fsr.ainovel.data.UserSession
import jp.co.fsr.ainovel.net.ApiClient
import jp.co.fsr.ainovel.net.ApiError
import jp.co.fsr.ainovel.net.Endpoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * 认证与全局登录态。会话本身由 httpOnly Cookie 维持，这里负责：
 * - 冷启动：先用本地会话快照回填界面，再打 /api/me 探权威登录态；
 * - 登录：POST /api/login（成功后服务端下发 Cookie，CookieJar 自动保存）；
 * - 记住密码：勾选后凭据落应用私有存储，供服务器地址变更后 / Cookie 过期时手动重登；
 * - 登出 / 401 自动登出。
 */
object AuthState {
    var user: UserSession? by mutableStateOf(null)
        private set
    var isBusy by mutableStateOf(false)
    var errorMessage by mutableStateOf<String?>(null)

    /** 冷启动是否仍在探测登录态（探测期间显示加载页，避免闪一下登录页） */
    var bootstrapping by mutableStateOf(true)

    /** 按需登录弹层：未登录可浏览公开列表，遇到需登录的操作时置 true 拉起登录页 */
    var showLogin by mutableStateOf(false)

    val isLoggedIn: Boolean get() = user != null

    private val json = Json { ignoreUnknownKeys = true }
    private val storeName = "ainovel_auth"

    private fun store(): SharedPreferences =
        AppConfig.appContext.getSharedPreferences(storeName, Context.MODE_PRIVATE)

    init {
        // 401 全局登出回调
        ApiClient.onUnauthorized = { handleExpired() }
        // 先用快照回填，界面即时可见
        user = loadSession()
    }

    /** 主动请求登录（如「我的」页的登录按钮） */
    fun requestLogin() {
        showLogin = true
    }

    /** App 启动后调用：探 /api/me 确认 Cookie 是否仍有效 */
    fun bootstrap(onDone: (() -> Unit)? = null) {
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val resp = ApiClient.get<MeResponse>(Endpoint.ME)
                val u = resp.user
                if (u != null) {
                    user = u
                    saveSession(u)
                } else {
                    user = null
                    clearSession()
                }
            } catch (_: Exception) {
                // 未登录 / 网络失败：清快照，落到登录入口
                user = null
                clearSession()
            }
            bootstrapping = false
            onDone?.invoke()
        }
    }

    /** 登录；完成后回调 success（供弹层关闭） */
    fun login(username: String, password: String, remember: Boolean, onResult: (Boolean) -> Unit) {
        errorMessage = null
        isBusy = true
        CoroutineScope(Dispatchers.Main).launch {
            try {
                val resp = ApiClient.post<LoginResponse>(
                    Endpoint.LOGIN,
                    buildJsonObject {
                        put("username", username)
                        put("password", password)
                    })
                val u = resp.user
                if (u == null) {
                    errorMessage = "登录失败：服务端未返回用户信息"
                    onResult(false)
                } else {
                    user = u
                    saveSession(u)
                    if (remember) saveCredential(username, password) else clearCredential()
                    onResult(true)
                }
            } catch (e: ApiError) {
                errorMessage = e.message
                onResult(false)
            } catch (e: Exception) {
                errorMessage = e.message ?: "登录失败"
                onResult(false)
            }
            isBusy = false
        }
    }

    fun logout() {
        CoroutineScope(Dispatchers.Main).launch {
            runCatching { ApiClient.postVoid(Endpoint.LOGOUT) }
            user = null
            clearSession()
            // 保留记住的凭据，方便再次登录
        }
    }

    private fun handleExpired() {
        val wasLoggedIn = user != null
        user = null
        clearSession()
        // 无论匿名 401（如未登录点开章节）还是登录过期，都拉起登录页
        showLogin = true
        if (wasLoggedIn) errorMessage = "登录已过期，请重新登录"
    }

    /** 记住的凭据（供登录页预填） */
    fun savedCredential(): Pair<String, String>? {
        val raw = store().getString("credential", null) ?: return null
        val idx = raw.indexOf('\n')
        if (idx <= 0 || idx >= raw.length - 1) return null
        return raw.substring(0, idx) to raw.substring(idx + 1)
    }

    /** 换服务器地址后 Cookie 属另一域，需重新登录 */
    fun serverChanged() {
        user = null
        clearSession()
    }

    // MARK: - 本地存储（对应 iOS KeychainStore）

    private fun saveSession(s: UserSession) {
        store().edit().putString("session", json.encodeToString(UserSession.serializer(), s)).apply()
    }

    private fun loadSession(): UserSession? {
        val raw = store().getString("session", null) ?: return null
        return runCatching { json.decodeFromString(UserSession.serializer(), raw) }.getOrNull()
    }

    private fun clearSession() {
        store().edit().remove("session").apply()
    }

    private fun saveCredential(username: String, password: String) {
        store().edit().putString("credential", "$username\n$password").apply()
    }

    private fun clearCredential() {
        store().edit().remove("credential").apply()
    }
}
