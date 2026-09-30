import Foundation

/// 全局运行配置。站点根地址优先级：**用户选的接入环境 > 用户自设地址 > Info.plist / 编译默认**。
/// - 局域网：Info.plist 的 `AINovelBaseURL`（连本机开发服务）；
/// - 公网：`https://ai.fsr.co.jp/novel`（nginx `/novel/` → 3400）；
/// - 自定义：服务器设置页手填地址。
/// AI（aibridge）与朗读 TTS 都由本站后端中继，App 不直连，所以切站点就是切 AI 出口。
///
/// 与 aistudy 不同：ainovel 鉴权走 httpOnly Cookie（Path=/novel），
/// 因此 baseURL 必须是**带 /novel 前缀的站点根**，所有 API 请求拼在其后的 `api/...`，
/// 否则 Cookie Path 不匹配、登录态不会被携带。
enum AppConfig {
    /// 接入环境档
    enum ServerEnv: String, CaseIterable, Identifiable {
        case builtin      // 局域网 / 内置
        case cloud        // 公网服务器
        case custom       // 手填
        var id: String { rawValue }
    }

    /// 用户自设服务器地址的 UserDefaults 键（服务器设置页写入）
    private static let serverOverrideKey = "ainovelServerBase"
    private static let envKey = "ainovelServerEnv"

    /// 公网服务器站点根（带 /novel 前缀，Cookie Path 止这里）
    static let cloudBaseURL = URL(string: "https://ai.fsr.co.jp/novel")!

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

    /// 当前生效档。旧版只存过自设地址、没有档概念 —— 那种情况按 custom 处理，避免升级后地址失效
    static var env: ServerEnv {
        get {
            if let raw = UserDefaults.standard.string(forKey: envKey), let e = ServerEnv(rawValue: raw) { return e }
            return UserDefaults.standard.string(forKey: serverOverrideKey) != nil ? .custom : .builtin
        }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: envKey) }
    }

    /// 当前生效地址：按档解析。每次请求动态读取，改设置即时生效。
    static var baseURL: URL { url(for: env) }

    /// 档对应地址；custom 档无有效自设地址时回落 builtin
    static func url(for serverEnv: ServerEnv) -> URL {
        switch serverEnv {
        case .builtin: return defaultBaseURL
        case .cloud: return cloudBaseURL
        case .custom: return customServerURL ?? defaultBaseURL
        }
    }

    /// 切档；非 custom 档顺手清掉自设地址，避免档与地址不一致
    static func setEnv(_ serverEnv: ServerEnv) {
        if serverEnv != .custom { UserDefaults.standard.removeObject(forKey: serverOverrideKey) }
        env = serverEnv
    }

    /// 用户自设地址（已规范化）；未设/非法返回 nil 回落默认
    static var customServerURL: URL? {
        guard let s = UserDefaults.standard.string(forKey: serverOverrideKey) else { return nil }
        return normalize(s)
    }

    /// 保存用户服务器地址并切到 custom 档；传空串恢复 builtin 档
    static func setCustomServer(_ raw: String) {
        guard let url = normalize(raw) else {
            UserDefaults.standard.removeObject(forKey: serverOverrideKey)
            env = .builtin
            return
        }
        UserDefaults.standard.set(url.absoluteString, forKey: serverOverrideKey)
        env = .custom
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
