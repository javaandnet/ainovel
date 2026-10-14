import SwiftUI

/// 阅读首页（App 启动默认落此，无需登录即可浏览）：拉公开书单 /api/catalog → 点开进已发布读者页（SiteWebView）。
/// 口径对齐 web 站首页：非 VIP 书公开可读；VIP 书需登录且被授权（/api/catalog 按会话 Cookie 判定，
/// 未登录时后端整条隐藏 VIP；SiteWebView 注入会话 Cookie 后 VIP 页放行）。
struct ReaderRootView: View {
    @EnvironmentObject var auth: AuthViewModel
    @StateObject private var lib = LibraryViewModel()
    @State private var search = ""
    @State private var showManage = false
    @State private var showMe = false
    @State private var selectedBook: CatalogNovel?

    private var filtered: [CatalogNovel] {
        guard !search.isEmpty else { return lib.catalog }
        return lib.catalog.filter { ($0.title ?? "").contains(search) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if lib.loading && lib.catalog.isEmpty {
                    ProgressView("加载中…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = lib.errorMessage, lib.catalog.isEmpty {
                    ContentUnavailableView {
                        Label("加载失败", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("重试") { Task { await lib.refreshCatalog() } }
                    }
                } else if filtered.isEmpty {
                    ContentUnavailableView("暂无已发布作品", systemImage: "book",
                                           description: Text("服务器还没有已发布的小说。登录后在「管理」新建并发布，即可在此出现。"))
                } else {
                    List {
                        ForEach(filtered) { book in
                            Button { selectedBook = book } label: {
                                CatalogRow(book: book)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "搜索书名")
            .navigationTitle("阅读")
            .refreshable { await lib.refreshCatalog() }
            // 登录态变化（登录/登出）会影响 VIP 条目是否出现，故按 isLoggedIn 重拉
            .task(id: auth.isLoggedIn) { await lib.refreshCatalog() }
            .toolbar { toolbarContent }
        }
        .sheet(item: $selectedBook) { book in
            if let u = SiteWebView.relativeURL(book.url ?? "") {
                SiteWebView(url: u, title: book.display)
            }
        }
        .sheet(isPresented: $showManage) { ManageRootView() }
        .sheet(isPresented: $showMe) { MeView() }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if auth.isLoggedIn {
            ToolbarItem(placement: .navigationBarLeading) {
                Button { showManage = true } label: { Image(systemName: "slider.horizontal.3") }
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showMe = true } label: { Image(systemName: "person.crop.circle") }
            }
        } else {
            // 未登录也能浏览公开书单；右上角登录用于解锁 VIP 与进入管理
            ToolbarItem(placement: .navigationBarTrailing) {
                Button("登录") { auth.requestLogin() }
            }
        }
    }
}

/// 公开书单行：书名 + VIP 角标 + 章数
struct CatalogRow: View {
    let book: CatalogNovel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(book.display).font(.headline)
                if book.vip == true {
                    Text("VIP").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.orange.opacity(0.2), in: Capsule())
                        .foregroundStyle(.orange)
                }
            }
            Text(book.chaptersDesc).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
    }
}

struct NovelRow: View {
    let novel: Novel
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(novel.display).font(.headline)
                if novel.vip == true {
                    Text("VIP").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(.orange.opacity(0.2), in: Capsule())
                        .foregroundStyle(.orange)
                }
            }
            Text(novel.chaptersDesc).font(.caption).foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}
