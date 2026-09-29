import Foundation
import Combine

/// 认证与全局登录态。会话本身由 httpOnly Cookie 维持，这里负责：
/// - 冷启动：先用 Keychain 会话快照回填界面，再打 /api/me 探权威登录态；
/// - 登录：POST /api/login（成功后服务端下发 Cookie，URLSession 自动保存）；
/// - 记住密码：勾选后凭据落 Keychain，供服务器地址变更后 / Cookie 过期时手动重登；
/// - 登出 / 401 自动登出。
@MainActor
final class AuthViewModel: ObservableObject {
    static let shared = AuthViewModel()

    @Published var user: UserSession?
    @Published var isBusy = false
    @Published var errorMessage: String?
    /// 冷启动是否仍在探测登录态（探测期间 RootView 显示加载页，避免闪一下登录页）
    @Published var bootstrapping = true
    /// 按需登录弹层：未登录可浏览公开列表，遇到需登录的操作（打开章节 / 401）时置 true 拉起登录 sheet
    @Published var showLogin = false

    var isLoggedIn: Bool { user != nil }

    /// 主动请求登录（如「我的」页的登录按钮）
    func requestLogin() { showLogin = true }

    private init() {
        // 401 全局登出回调
        APIClient.shared.onUnauthorized = { [weak self] in
            Task { @MainActor in self?.handleExpired() }
        }
        // 先用快照回填，界面即时可见
        if let cached = KeychainStore.loadSession() {
            user = cached
        }
    }

    /// App 启动后调用：探 /api/me 确认 Cookie 是否仍有效
    func bootstrap() async {
        defer { bootstrapping = false }
        do {
            let resp = try await APIClient.shared.get(MeResponse.self, Endpoint.me)
            if let u = resp.user {
                user = u
                KeychainStore.saveSession(u)
            } else {
                user = nil
                KeychainStore.clearSession()
            }
        } catch {
            // 未登录 / 网络失败：清快照，落到登录页
            user = nil
            KeychainStore.clearSession()
        }
    }

    func login(username: String, password: String, remember: Bool) async {
        errorMessage = nil
        isBusy = true
        defer { isBusy = false }
        do {
            let resp = try await APIClient.shared.post(LoginResponse.self, Endpoint.login, json: [
                "username": username, "password": password
            ])
            guard let u = resp.user else {
                errorMessage = "登录失败：服务端未返回用户信息"
                return
            }
            user = u
            KeychainStore.saveSession(u)
            if remember {
                KeychainStore.saveCredential(username: username, password: password)
            } else {
                KeychainStore.clearCredential()
            }
        } catch let e as APIError {
            errorMessage = e.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func logout() async {
        try? await APIClient.shared.postVoid(Endpoint.logout)
        user = nil
        KeychainStore.clearSession()
        // 保留记住的凭据，方便再次登录
    }

    private func handleExpired() {
        let wasLoggedIn = user != nil
        user = nil
        KeychainStore.clearSession()
        // 无论匿名 401（如未登录点开章节）还是登录过期，都拉起登录 sheet
        showLogin = true
        if wasLoggedIn { errorMessage = "登录已过期，请重新登录" }
    }

    /// 记住的凭据（供登录页预填）
    var savedCredential: (username: String, password: String)? { KeychainStore.loadCredential() }

    /// 换服务器地址后 Cookie 属另一域，需重新登录
    func serverChanged() {
        user = nil
        KeychainStore.clearSession()
    }
}
