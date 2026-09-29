import SwiftUI

@MainActor
final class ChapterListViewModel: ObservableObject {
    @Published var chapters: [Chapter] = []
    @Published var totalWords = 0
    @Published var loading = false
    @Published var errorMessage: String?

    private let api = APIClient.shared

    func load(novelId: String?) async {
        guard let novelId else { return }
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            let resp = try await api.get(ChaptersResponse.self, Endpoint.chapters(novelId))
            // 只显示有正文的章（无正文的章读者看不到）
            chapters = (resp.chapters ?? []).filter { $0.hasContent == true }
            totalWords = resp.totalWords ?? 0
        } catch let e as APIError {
            errorMessage = e.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

struct ChapterListView: View {
    let novel: Novel
    @StateObject private var vm = ChapterListViewModel()

    var body: some View {
        Group {
            if vm.loading && vm.chapters.isEmpty {
                ProgressView("加载目录…")
            } else if let err = vm.errorMessage {
                ContentUnavailableView("加载失败", systemImage: "wifi.exclamationmark", description: Text(err))
            } else if vm.chapters.isEmpty {
                ContentUnavailableView("暂无已发布正文", systemImage: "text.book.closed",
                                       description: Text("这本书还没有生成章节正文。"))
            } else {
                List {
                    Section {
                        Text("\(novel.display) · 共 \(vm.chapters.count) 章 · 正文 \(vm.totalWords) 字")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(Array(vm.chapters.enumerated()), id: \.element.no) { idx, ch in
                        NavigationLink {
                            ReaderView(novel: novel, chapters: vm.chapters, startIndex: idx)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(ch.display).font(.body)
                                Text(ch.wordsDesc).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle(novel.display)
        .navigationBarTitleDisplayMode(.inline)
        .task { await vm.load(novelId: novel.id) }
        .refreshable { await vm.load(novelId: novel.id) }
    }
}
