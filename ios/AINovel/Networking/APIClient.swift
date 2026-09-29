import Foundation

/// 统一网络层。约定（与 ainovel 后端 src/auth/session.js 对齐）：
/// - 鉴权走 httpOnly Cookie（`ainovel_session`，Path=/novel）：URLSession 用共享 cookie 存储
///   自动保存并在后续同源请求回传，无需手动管理 token；因此所有请求必须走带 /novel 前缀的 baseURL。
/// - 成功：HTTP 2xx，body 直接是业务 JSON（后端无统一 {success,data} 信封，各端点形状各异）。
/// - 失败：顶层 `{ error: "中文文案" }`，抛 APIError.httpStatus。
/// - 401：受保护端点触发全局登出回调；登录/探测类端点的 401 当作普通错误透出文案。
final class APIClient {
    static let shared = APIClient()

    /// 收到受保护端点 401 时回调（用于自动登出）
    var onUnauthorized: () -> Void = {}

    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    /// 未登录态即可访问 / 或作为探测用的端点：这些路径的 401 不触发登出，直接透文案
    private static let publicPrefixes: [String] = [
        "api/login", "api/logout", "api/me", "api/reader/", "api/tts/"
    ]

    private init() {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = AppConfig.requestTimeout
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        // 共享 cookie 存储：登录 Set-Cookie 会被保存，之后同源请求自动带上
        cfg.httpShouldSetCookies = true
        cfg.httpCookieAcceptPolicy = .always
        cfg.httpCookieStorage = .shared
        session = URLSession(configuration: cfg)
    }

    private func isPublic(_ path: String) -> Bool {
        Self.publicPrefixes.contains { path.hasPrefix($0) }
    }

    private func makeRequest(_ method: String, _ path: String, query: [String: String]?,
                             body: Data?, timeout: TimeInterval?) -> URLRequest {
        var url = AppConfig.baseURL.appendingPathComponent(path)
        if let query, !query.isEmpty {
            var comps = URLComponents(url: url, resolvingAgainstBaseURL: false)!
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
            url = comps.url!
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if body != nil {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        req.httpBody = body
        if let timeout { req.timeoutInterval = timeout }
        return req
    }

    /// 发起请求并解码为 T。T == EmptyResponse 时不解析 body。
    func send<T: Decodable>(_ type: T.Type, method: String, path: String,
                            query: [String: String]? = nil,
                            json: [String: Any]? = nil,
                            timeout: TimeInterval? = nil) async throws -> T {
        var payload: Data? = nil
        if let json {
            payload = try? JSONSerialization.data(withJSONObject: json)
        }
        let req = makeRequest(method, path, query: query, body: payload, timeout: timeout)
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let urlErr as URLError {
            if urlErr.code == .cancelled { throw APIError.cancelled }
            throw APIError.network(urlErr)
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError.invalidResponse }
        if http.statusCode == 401 && !isPublic(path) {
            let cb = onUnauthorized
            Task { @MainActor in cb() }
            throw APIError.unauthorized
        }
        if (200..<300).contains(http.statusCode) {
            if type == EmptyResponse.self { return EmptyResponse() as! T }
            do {
                return try decoder.decode(T.self, from: data)
            } catch {
                throw APIError.decoding(error)
            }
        }
        // 失败：提取后端 error 文案（登录失败的 401 也走这里，展示"用户名或密码错误"）
        let body = try? decoder.decode(APIErrorBody.self, from: data)
        throw APIError.httpStatus(http.statusCode, body?.error)
    }

    // MARK: - 便捷方法

    func get<T: Decodable>(_ type: T.Type, _ path: String, query: [String: String]? = nil,
                           timeout: TimeInterval? = nil) async throws -> T {
        try await send(type, method: "GET", path: path, query: query, timeout: timeout)
    }

    func post<T: Decodable>(_ type: T.Type, _ path: String, json: [String: Any]? = nil,
                             timeout: TimeInterval? = nil) async throws -> T {
        try await send(type, method: "POST", path: path, json: json, timeout: timeout)
    }

    func put<T: Decodable>(_ type: T.Type, _ path: String, json: [String: Any]? = nil,
                           timeout: TimeInterval? = nil) async throws -> T {
        try await send(type, method: "PUT", path: path, json: json, timeout: timeout)
    }

    func delete<T: Decodable>(_ type: T.Type, _ path: String, json: [String: Any]? = nil,
                              timeout: TimeInterval? = nil) async throws -> T {
        try await send(type, method: "DELETE", path: path, json: json, timeout: timeout)
    }

    func postVoid(_ path: String, json: [String: Any]? = nil, timeout: TimeInterval? = nil) async throws {
        let _: EmptyResponse = try await post(EmptyResponse.self, path, json: json, timeout: timeout)
    }
}
