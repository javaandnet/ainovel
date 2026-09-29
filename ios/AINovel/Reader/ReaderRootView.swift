import SwiftUI

/// 阅读 Tab 根：登录用户自己的作品列表 → 章节 → 原生阅读。
struct ReaderRootView: View {
    @StateObject private var lib = LibraryViewModel()
    @State private var search = ""

    private var filtered: [Novel] {
        guard !search.isEmpty else { return lib.novels }
        return lib.novels.filter { ($0.name ?? "").contains(search) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if lib.loading && lib.novels.isEmpty {
                    ProgressView("加载中…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = lib.errorMessage {
                    ContentUnavailableView {
                        Label("加载失败", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(err)
                    } actions: {
                        Button("重试") { Task { await lib.refresh() } }
                    }
                } else if filtered.isEmpty {
                    ContentUnavailableView("暂无作品", systemImage: "book",
                                           description: Text("在「管理」Tab 新建小说并生成章节后，这里就能看到。"))
                } else {
                    List {
                        ForEach(filtered) { novel in
                            NavigationLink {
                                ChapterListView(novel: novel)
                            } label: {
                                NovelRow(novel: novel)
                            }
                        }
                    }
                }
            }
            .searchable(text: $search, prompt: "搜索书名")
            .navigationTitle("阅读")
            .refreshable { await lib.refresh() }
            .task { if lib.novels.isEmpty { await lib.refresh() } }
        }
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
