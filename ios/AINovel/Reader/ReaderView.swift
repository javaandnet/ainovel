import SwiftUI

@MainActor
final class ReaderViewModel: ObservableObject {
    @Published var detail: ChapterDetail?
    @Published var share: ShareResponse?
    @Published var loading = false
    @Published var errorMessage: String?

    private let api = APIClient.shared

    func load(novelId: String?, no: Int?) async {
        guard let novelId, let no else { return }
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            let resp = try await api.get(ChapterResponse.self, Endpoint.chapter(novelId, no))
            detail = resp.chapter
        } catch let e as APIError {
            errorMessage = e.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// 拉发布页入口（/share），用于「直接观看」拼出真实书页 URL
    func loadShare(novelId: String?) async {
        guard let novelId, share == nil else { return }
        share = try? await api.get(ShareResponse.self, Endpoint.share(novelId))
    }

    /// 当前章的发布页地址：share.url 的 index.html 换成 chapter_<章id>.html（发布文件名吃稳定章节 id）
    func publishedChapterURL(chapterId: String?) -> URL? {
        guard let base = share?.url, let chapterId else { return nil }
        let dir = String(base.dropLast("index.html".count))
        return SiteWebView.relativeURL(dir + "chapter_\(chapterId).html")
    }
}

struct ReaderView: View {
    let novel: Novel
    let chapters: [Chapter]
    @State private var index: Int

    @StateObject private var vm = ReaderViewModel()
    @StateObject private var speech = SpeechPlayer()
    @AppStorage("readerFontSize") private var fontSize = 18.0
    @State private var showSettings = false
    @State private var showLearning = false
    @State private var showSite = false
    @State private var siteURL: URL?
    @State private var siteNotPublished = false

    init(novel: Novel, chapters: [Chapter], startIndex: Int) {
        self.novel = novel
        self.chapters = chapters
        _index = State(initialValue: startIndex)
    }

    private var currentNo: Int? { chapters.indices.contains(index) ? chapters[index].no : nil }

    private func openPublishedSite() {
        guard vm.share?.published == true else { siteNotPublished = true; return }
        let chapterId = chapters.indices.contains(index) ? chapters[index].id : nil
        if let u = vm.publishedChapterURL(chapterId: chapterId) ?? SiteWebView.relativeURL(vm.share?.url ?? "") {
            siteURL = u
            showSite = true
        } else {
            siteNotPublished = true
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let d = vm.detail {
                    if let name = d.name {
                        Text(name).font(.title2.bold())
                    }
                    Text("第 \(d.no ?? 0) 章 · \(d.wordCount ?? 0) 字")
                        .font(.caption).foregroundStyle(.secondary)
                    Divider()
                    Text(d.content ?? "")
                        .font(.system(size: fontSize))
                        .lineSpacing(fontSize * 0.6)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if vm.loading {
                    ProgressView("加载正文…").frame(maxWidth: .infinity, minHeight: 200)
                } else if let err = vm.errorMessage {
                    Text(err).foregroundStyle(.red)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
        }
        .safeAreaInset(edge: .bottom) { toolbar }
        .navigationTitle(novel.display)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .navigationBarTrailing) {
                Button { openPublishedSite() } label: { Image(systemName: "globe") }
                Button { showLearning = true } label: { Image(systemName: "graduationcap") }
                Button { showSettings = true } label: { Image(systemName: "textformat.size") }
            }
        }
        .sheet(isPresented: $showLearning) {
            LearningPanel(novelId: novel.id, content: vm.detail?.content ?? "", title: vm.detail?.name ?? novel.display)
        }
        .sheet(isPresented: $showSite) {
            if let u = siteURL {
                SiteWebView(url: u, title: vm.detail?.name ?? novel.display)
            }
        }
        .alert("本书尚未发布", isPresented: $siteNotPublished) {
            Button("好", role: .cancel) {}
        } message: {
            Text("发布后才能直接观看读者站页面。可在「管理」Tab 发布。")
        }
        .popover(isPresented: $showSettings, arrowEdge: .top) {
            VStack(alignment: .leading, spacing: 8) {
                Text("字号 \(Int(fontSize))").font(.headline)
                Stepper("字号", value: $fontSize, in: 14...28, step: 1)
            }
            .padding()
            .presentationDetents([.height(120)])
        }
        .task(id: index) { await vm.load(novelId: novel.id, no: currentNo) }
        .task { await vm.loadShare(novelId: novel.id) }
        .onDisappear { speech.stop() }
    }

    private var toolbar: some View {
        HStack(spacing: 0) {
            Button {
                speech.stop()
                if index > 0 { index -= 1 }
            } label: {
                Image(systemName: "chevron.backward.2")
            }
            .disabled(index <= 0)

            Spacer()

            Button {
                if speech.speaking { speech.stop() }
                else { speech.start(text: vm.detail?.content ?? "") }
            } label: {
                Image(systemName: speech.speaking ? "stop.circle.fill" : "play.circle.fill")
                    .font(.system(size: 26))
            }

            Spacer()

            Button {
                speech.stop()
                if index < chapters.count - 1 { index += 1 }
            } label: {
                Image(systemName: "chevron.forward.2")
            }
            .disabled(index >= chapters.count - 1)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 10)
        .background(.bar)
    }
}
