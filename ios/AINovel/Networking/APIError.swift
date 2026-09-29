import Foundation

/// ainovel 后端错误体是顶层 `{ error: "中文文案" }`（error 为字符串，非对象），
/// 少数校验直接返回纯文本或 `{ ok:false }`。这里统一收口成一个可读 message + HTTP 状态。
struct APIErrorBody: Decodable {
    let error: String?
}

enum APIError: LocalizedError {
    case network(URLError)
    case invalidResponse
    case decoding(Error)
    case unauthorized
    case cancelled
    /// HTTP 状态码 + 后端 error 文案（若有）
    case httpStatus(Int, String?)

    var errorDescription: String? {
        switch self {
        case .network(let e):
            if e.code == .notConnectedToInternet || e.code == .networkConnectionLost {
                return "网络连接不可用，请检查服务器地址与网络。"
            }
            if e.code == .timedOut { return "请求超时，请稍后重试。" }
            if e.code == .cannotConnectToHost { return "无法连接服务器，请在「服务器设置」确认地址。" }
            return "网络错误：\(e.localizedDescription)"
        case .invalidResponse: return "服务器响应异常。"
        case .decoding(let e): return "数据解析失败：\(e.localizedDescription)"
        case .unauthorized: return "登录已过期，请重新登录。"
        case .cancelled: return "请求已取消。"
        case .httpStatus(let code, let msg):
            let base: String
            switch code {
            case 400: base = "请求有误"
            case 401: base = "未登录或登录已过期"
            case 403: base = "无权访问"
            case 404: base = "资源不存在"
            case 409: base = "操作冲突"
            case 410: base = "该功能已停用"
            case 429: base = "请求过于频繁"
            default: base = "请求失败(\(code))"
            }
            if let msg, !msg.isEmpty { return "\(base)：\(msg)" }
            return base
        }
    }
}

/// 无返回体的占位解码类型（成功即视为完成，不解析 body）
struct EmptyResponse: Decodable {}
