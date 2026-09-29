import Foundation

// MARK: - 认证

/// 当前登录用户（/api/me、/api/login 的 user 字段；未登录时 user 为 null）
struct UserSession: Codable, Identifiable, Equatable {
    let id: String?
    let username: String?
    let role: String?

    var isSuperadmin: Bool { role == "superadmin" }
    var display: String { username ?? "已登录" }
}

struct MeResponse: Decodable { let ok: Bool?; let user: UserSession? }
struct LoginResponse: Decodable { let ok: Bool?; let user: UserSession? }

// MARK: - 小说

struct Novel: Codable, Identifiable {
    let id: String?
    let name: String?
    let chapterCount: Int?
    let updatedAt: Double?
    let vip: Bool?

    var display: String { name ?? "未命名" }
    var chaptersDesc: String { "共 \(chapterCount ?? 0) 章" }
}

struct NovelsResponse: Decodable { let novels: [Novel]? }

struct CreateNovelResponse: Codable {
    let ok: Bool?
    let novel: Novel?
}

// MARK: - 章节

struct Chapter: Codable, Identifiable {
    let no: Int?
    let name: String?
    let outline: String?
    let wordCount: Int?
    let hasContent: Bool?
    let partNo: Int?
    let id: String?

    var display: String { name ?? "第 \(no ?? 0) 章" }
    var wordsDesc: String {
        let w = wordCount ?? 0
        if w == 0 { return "—" }
        return w >= 10000 ? String(format: "%.1f万字", Double(w) / 10000.0) : "\(w)字"
    }
}

struct ChaptersResponse: Decodable {
    let novel: String?
    let chapters: [Chapter]?
    let totalWords: Int?
}

struct ChapterDetail: Codable {
    let no: Int?
    let name: String?
    let outline: String?
    let content: String?
    let wordCount: Int?
    let outlineCount: Int?
}

struct ChapterResponse: Decodable { let chapter: ChapterDetail? }

// MARK: - 设定

struct GenCfg: Codable {
    var targetWords: Int? = nil
    var tolerancePct: Int? = nil
    var splitPct: Int? = nil
}

struct WordBand: Codable {
    let min: Int?
    let max: Int?
    let target: Int?
    let splitLine: Int?
}

struct NovelSettings: Codable {
    let name: String?
    let outline: String?
    let content: String?
    let preface: String?
    let version: Int?
    let genCfg: GenCfg?
    let wordBand: WordBand?
    let wordBandText: String?
    let chapterCount: Int?
    let outlineCount: Int?
    let bodyCount: Int?
    let totalWords: Int?
}

struct SaveSettingsResponse: Decodable {
    let ok: Bool?
    let action: String?
    let version: Int?
    let genCfg: GenCfg?
    let wordBand: WordBand?
}

// MARK: - 分部

struct Part: Codable, Identifiable {
    let no: Int?
    let name: String?
    let startNo: Int?
    let endNo: Int?
    let chapters: Int?
    let hasIntro: Bool?
    var id: Int { no ?? 0 }
}

struct PartsResponse: Decodable { let parts: [Part]? }

// MARK: - 阅读器 AI（公开）

struct QuizQuestion: Codable, Identifiable, Hashable {
    let question: String?
    let options: [String]?
    let answer: String?
    var id: Int { hashValue }
}

struct QuizResponse: Decodable { let ok: Bool?; let questions: [QuizQuestion]? }
struct VocabResponse: Decodable { let ok: Bool?; let words: [String]? }
struct ExplainResponse: Decodable { let ok: Bool?; let explanation: String? }
struct AskResponse: Decodable { let ok: Bool?; let answer: String? }
struct FeedbackResponse: Decodable { let ok: Bool?; let feedback: String? }
struct WordStatusResponse: Decodable { let ok: Bool?; let have: [String]? }

// MARK: - 分享 / 发布 / 检查

struct ShareResponse: Decodable { let url: String?; let published: Bool?; let title: String? }

struct PublishResponse: Decodable {
    let success: Bool?
    let pages: Int?
    let chapters: Int?
    let pruned: Int?
    let pruneSkipped: String?
    let url: String?
}

// MARK: - 通用动作 /api/run

struct RunResponse: Decodable {
    let success: Bool?
    let action: String?
    let novelId: String?
    let result: JSONValue?
}

struct CheckResponse: Decodable {
    let success: Bool?
    let report: JSONValue?
}

struct LLMStatus: Decodable {
    let ok: Bool?
    let reachable: Bool?
    let detail: String?
    let model: String?
}

struct RenumberResponse: Decodable { let ok: Bool?; let shiftedCount: Int? }
struct OkResponse: Decodable { let ok: Bool?; let error: String? }

// MARK: - JSONValue：宽松兜底（/api/run 的 result、体检 report 形状多变，不赌字段）

indirect enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([JSONValue].self) { self = .array(a); return }
        if let o = try? c.decode([String: JSONValue].self) { self = .object(o); return }
        self = .null
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        case .null: try c.encodeNil()
        }
    }

    /// 取字符串（供界面直接展示 result 里的文本类返回）
    var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }
}
