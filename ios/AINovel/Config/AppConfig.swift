import Foundation

/// 全局运行配置。站点根地址优先取用户在「服务器设置」里配的地址（UserDefaults），
/// 其次 Info.plist 的 `AINovelBaseURL`（TestFlight 包必须指向可公网访问的 HTTPS）。
///
/// 与 aistudy 不同：ainovel 鉴权走 httpOnly Cookie（Path=/novel），
/// 因此 baseURL 必须是**带 /novel 前缀的站点根**，所有 API 请求拼在其后的 `api/...`，
/// 否则 Cookie Path 不匹配、登录态不会被携带。
enum AppConfig {
    /// 用户自设服务器地址的 UserDefaults 键（服务器设置页写入）
    private static let serverOverrideKey = "ainovelServerBase"

    /// 默认地址：Info.plist → DEBUG 环境变量 → 回环（ainovel 默认端口 3400、挂在 /novel）
    static let defaultBaseURL: URL = {
        if let s = Bundle.main.object(forInfoDictionaryKey: "AINovelBaseURL") as? String,
           let url = URL(string: s), !s.contains("your-server.example.com") {
            return url
        }
        #if DEBUG
        if let env = ProcessInfo.processInfo.environment["AINovel_BASE_URL"],
           let url = URL(string: env) {
            return url
        }
        #endif
        return URL(string: "http://127.0.0.1:3400/novel")!
    }()

    /// 当前生效地址：用户设置 > 默认。每次请求动态读取，改设置即时生效。
    static var baseURL: URL { customServerURL ?? defaultBaseURL }

    /// 用户自设地址（已规范化）；未设/非法返回 nil 回落默认
    static var customServerURL: URL? {
        guard let s = UserDefaults.standard.string(forKey: serverOverrideKey) else { return nil }
        return normalize(s)
    }

    /// 保存用户服务器地址；传空串恢复默认
    static func setCustomServer(_ raw: String) {
        if normalize(raw) == nil { UserDefaults.standard.removeObject(forKey: serverOverrideKey); return }
        UserDefaults.standard.set(raw.trimmingCharacters(in: .whitespacesAndNewlines), forKey: serverOverrideKey)
    }

    /// 展示用的当前地址（去掉主机无路径时的默认 /novel 也一并显示，便于核对）
    static var displayBaseURL: String { baseURL.absoluteString }

    /// 规范化：补 scheme（缺省 http）、去尾斜杠；若只填 host[:port] 则自动补 /novel 前缀。
    /// 用户填了自定义路径（例如反代到别的前缀）时原样保留，不强制补 /novel。
    static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "http://" + s }
        while s.hasSuffix("/") { s = String(s.dropLast()) }
        guard let url = URL(string: s), url.host != nil else { return nil }
        // 无路径（只有 host[:port]）时补站点前缀
        if url.path.isEmpty || url.path == "/" {
            return URL(string: s + "/novel")
        }
        return url
    }

    /// 界面语言：AI 讲解/测试文案默认中文一侧
    static let uiLang = "zh"

    static let requestTimeout: TimeInterval = 30
    /// LLM / 生成类接口耗时较长（整章生成实测约 150 秒），单独放宽
    static let llmTimeout: TimeInterval = 600
}
