import Foundation
import Security

/// 极简 Keychain 封装：仅存登录凭据（用户名/密码，供「记住密码」自动重登）与最近一次会话快照。
/// 会话本身靠 httpOnly Cookie（URLSession 共享 cookie 存储）维持，这里存的 session 仅用于
/// 冷启动即时回填界面显示，权威登录态仍以 `/api/me` 探测为准。
enum KeychainStore {
    private static let service = "com.ainovel.app"

    // MARK: - 记住密码（单一 "credential" 账号，值格式 username\n + password）

    static func saveCredential(username: String, password: String) {
        set(account: "credential", value: username + "\n" + password)
    }

    static func loadCredential() -> (username: String, password: String)? {
        guard let raw = get(account: "credential"),
              let idx = raw.firstIndex(of: "\n") else { return nil }
        let u = String(raw[..<idx])
        let p = String(raw[raw.index(after: idx)...])
        guard !u.isEmpty, !p.isEmpty else { return nil }
        return (u, p)
    }

    static func clearCredential() {
        delete(account: "credential")
    }

    // MARK: - 会话快照（UserSession JSON）

    static func saveSession(_ session: UserSession) {
        guard let d = try? JSONEncoder().encode(session),
              let json = String(data: d, encoding: .utf8) else { return }
        set(account: "session", value: json)
    }

    static func loadSession() -> UserSession? {
        guard let json = get(account: "session"), let d = json.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(UserSession.self, from: d)
    }

    static func clearSession() {
        delete(account: "session")
    }

    // MARK: - 通用字符串存取

    static func set(account: String, value: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        guard status == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
    }
}
