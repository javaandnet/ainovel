import SwiftUI
import WebKit

/// 内置「直接观看」：用 WKWebView 打开发布后的读者站页面（真实书页，含内嵌测试题/生词/官方朗读）。
/// 关键点：WKWebView 有独立的 Cookie 存储，不会自动带上 URLSession 共享存储里的登录 Cookie，
/// 因此加载前先把 httpOnly 会话 Cookie 注入 WKWebsiteDataStore，VIP 书页才不会被拦成无权页。
struct SiteWebView: View {
    let url: URL
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true

    var body: some View {
        NavigationStack {
            Group {
                if let fixed = SiteWebView.absoluteSiteURL(url) {
                    WebViewRepresentable(url: fixed) { loading = $0 }
                        .overlay { if loading { ProgressView() } }
                } else {
                    ContentUnavailableView("地址无效", systemImage: "link.badge.plus")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Link(destination: SiteWebView.absoluteSiteURL(url) ?? url) {
                        Image(systemName: "safari")
                    }
                }
            }
        }
    }

    /// 相对站点路径（如 /novel/uid/书名/index.html）转 URL：中文路径先按 urlPathAllowed 百分号编码，
    /// 避免 URL(string:) 对非 ASCII 返回 nil。
    static func relativeURL(_ path: String) -> URL? {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        return URL(string: encoded)
    }

    /// share.url 可能已带 /novel 前缀（以 / 开头），转成 origin+path 的完整 URL；已是完整 URL 时原样返回
    static func absoluteSiteURL(_ url: URL) -> URL? {
        if url.scheme != nil, url.host != nil { return url }
        // 相对形式（如 /novel/uid/书名/index.html）用 baseURL 的 origin 补全
        guard let b = AppConfig.baseURL as URL?, let scheme = b.scheme, let host = b.host else { return url }
        let port = b.port.map { ":\($0)" } ?? ""
        let p = url.absoluteString.hasPrefix("/") ? url.absoluteString : "/" + url.absoluteString
        return URL(string: "\(scheme)://\(host)\(port)\(p)")
    }
}

private struct WebViewRepresentable: UIViewRepresentable {
    let url: URL
    let onLoading: (Bool) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // 复用默认数据存储，注入的 Cookie 才会作用于本页
        cfg.websiteDataStore = .default()
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.allowsBackForwardNavigationGestures = true
        web.navigationDelegate = context.coordinator
        context.coordinator.attach(web)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.owner = self
        if context.coordinator.lastLoaded != url {
            context.coordinator.lastLoaded = url
            // 先同步 Cookie 再加载
            CookieSync.sync {
                uiView.load(URLRequest(url: url))
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var owner: WebViewRepresentable
        var lastLoaded: URL?
        weak var web: WKWebView?
        init(_ owner: WebViewRepresentable) { self.owner = owner }
        func attach(_ web: WKWebView) { self.web = web; web.navigationDelegate = self }
        func webView(_ webView: WKWebView, didStart navigation: WKNavigation!) { owner.onLoading(true) }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { owner.onLoading(false) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { owner.onLoading(false) }
    }
}

/// 把 URLSession 共享 Cookie 存储里的会话 Cookie 注入 WKWebView 的默认数据存储。
enum CookieSync {
    static func sync(completion: @escaping () -> Void) {
        guard let host = AppConfig.baseURL.host else { completion(); return }
        let store = HTTPCookieStorage.shared
        let site = WKWebsiteDataStore.default().httpCookieStore
        let all = store.cookies ?? []
        let relevant = all.filter { $0.domain.contains(host) || host.contains($0.domain.replacingOccurrences(of: ".", with: "")) }
        if relevant.isEmpty { completion(); return }
        let group = DispatchGroup()
        for c in relevant {
            group.enter()
            site.setCookie(c) { group.leave() }
        }
        group.notify(queue: .main) { completion() }
    }
}
