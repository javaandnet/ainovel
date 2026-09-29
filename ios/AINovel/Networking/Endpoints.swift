import Foundation

/// ainovel API 路径（相对 AppConfig.baseURL，即带 /novel 前缀的站点根）。
/// 逐端点与 src/routes.js 对齐；带参数的用函数拼接。
enum Endpoint {
    // 认证（公开）
    static let login = "api/login"
    static let logout = "api/logout"
    static let me = "api/me"

    // 推理链路健康（登录后可用，另 /api/health 公开由桥接侧提供，这里用 llm-status）
    static let llmStatus = "api/llm-status"
    static let progress = "api/progress"

    // 小说
    static let novels = "api/novels"
    static func novel(_ id: String) -> String { "api/novels/\(id)" }
    static func chapters(_ id: String) -> String { "api/novels/\(id)/chapters" }
    static func chapter(_ id: String, _ no: Int) -> String { "api/novels/\(id)/chapter/\(no)" }
    static func outline(_ id: String, _ no: Int) -> String { "api/novels/\(id)/chapter/\(no)/outline" }
    static func outlineDraft(_ id: String, _ no: Int) -> String { "api/novels/\(id)/chapter/\(no)/outline-draft" }
    static func deleteChapter(_ id: String, _ no: Int) -> String { "api/novels/\(id)/chapter/\(no)" }
    static func renumber(_ id: String) -> String { "api/novels/\(id)/renumber" }
    static func settings(_ id: String) -> String { "api/novels/\(id)/settings" }
    static func parts(_ id: String) -> String { "api/novels/\(id)/parts" }
    static func check(_ id: String) -> String { "api/novels/\(id)/check" }
    static func publish(_ id: String) -> String { "api/novels/\(id)/publish" }
    static func share(_ id: String) -> String { "api/novels/\(id)/share" }
    static func preview(_ id: String) -> String { "api/novels/\(id)/preview" }
    static func previewReport(_ id: String) -> String { "api/novels/\(id)/preview/report" }
    static func vip(_ id: String) -> String { "api/novels/\(id)/vip" }

    // 通用动作入口（菜单/AI 共用；action 白名单见 routes.js ALLOWED_ACTIONS）
    static let run = "api/run"

    // 阅读器 AI（公开，无需登录）
    static let readerQuiz = "api/reader/quiz"
    static let readerExplain = "api/reader/explain"
    static let readerVocab = "api/reader/vocab"
    static let readerExplainWord = "api/reader/explain-word"
    static let readerWordStatus = "api/reader/word-status"
    static let readerAsk = "api/reader/ask"
    static let readerFeedback = "api/reader/feedback"

    // TTS（公开）
    static let ttsSentence = "api/tts/sentence"
}
