import SwiftUI

struct NovelManageView: View {
    let novel: Novel
    @StateObject private var vm: NovelManageViewModel
    @State private var showSettings = false
    @State private var editChapter: Chapter?
    @State private var premakeQuiz = true
    @State private var showSite = false

    init(novel: Novel) {
        self.novel = novel
        _vm = StateObject(wrappedValue: NovelManageViewModel(novelId: novel.id ?? ""))
    }

    var body: some View {
        List {
            statusSection
            actionSection
            chapterSection
            publishSection
        }
        .navigationTitle(novel.display)
        .navigationBarTitleDisplayMode(.inline)
        .overlay { busyOverlay }
        .task { await vm.loadAll() }
        .refreshable { await vm.loadAll() }
        .sheet(isPresented: $showSettings) {
            NovelSettingsSheet(vm: vm)
        }
        .sheet(item: $editChapter) { ch in
            ChapterOutlineSheet(vm: vm, chapter: ch)
        }
        .sheet(isPresented: $showSite) {
            if let url = vm.share?.url, let u = SiteWebView.relativeURL(url) {
                SiteWebView(url: u, title: novel.display)
            }
        }
        .safeAreaInset(edge: .bottom) { banner }
    }

    // MARK: - 概览

    private var statusSection: some View {
        Section("状态") {
            if let s = vm.settings {
                LabeledContent("章节", value: "\(s.chapterCount ?? 0) 章")
                LabeledContent("已生成正文", value: "\(s.bodyCount ?? 0) 章")
                LabeledContent("全书字数", value: "\(s.totalWords ?? 0) 字")
                LabeledContent("字数区间", value: s.wordBandText ?? "未设定")
                Button("编辑设定（书名/概要/字数）") { showSettings = true }
            } else {
                Text("载入中…").foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - 生成动作

    private var actionSection: some View {
        Section {
            Button("🧭 生成/重建全部大纲") {
                Task { await vm.runAction("generateChapterOutlines") }
            }
            Button("✍️ 补写缺失正文") {
                Task { await vm.runAction("generate") }
            }
            Button("🔢 重排章节编号") {
                Task { await vm.renumber() }
            }
        } header: {
            Text("生成（需推理链路绿灯，耗时较长）")
        } footer: {
            Text("大纲重建会清空命中章的正文；正文补写只处理大纲非空、正文为空的章。")
        }
    }

    // MARK: - 章节

    private var chapterSection: some View {
        Section("章节（\(vm.chapters.count)）") {
            ForEach(vm.chapters) { ch in
                Button {
                    editChapter = ch
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(ch.display).foregroundStyle(.primary)
                        HStack(spacing: 8) {
                            Text("大纲 \(String(describing: ch.outline?.count ?? 0)) 字")
                            Text("正文 \(ch.wordsDesc)")
                            if ch.hasContent == true { Image(systemName: "checkmark.seal.fill").foregroundStyle(.green) }
                        }
                        .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        if let no = ch.no { Task { await vm.deleteChapter(no: no) } }
                    } label: { Label("删除", systemImage: "trash") }
                }
            }
        }
    }

    // MARK: - 发布 / VIP

    private var publishSection: some View {
        Section("发布") {
            Toggle("发布时预生成测试题与生词表", isOn: $premakeQuiz)
            Button("🚀 发布到读者站") {
                Task { await vm.publish(premake: premakeQuiz) }
            }
            if let sh = vm.share {
                LabeledContent("线上", value: sh.published == true ? "已发布" : "未发布")
                if sh.published == true, sh.url != nil {
                    Button("📖 直接观看") { showSite = true }
                } else {
                    Text("尚未发布，无法直接观看").font(.caption).foregroundStyle(.secondary)
                }
            }
            Toggle("本书为 VIP 专属", isOn: Binding(
                get: { vm.vip },
                set: { newVal in Task { await vm.setVip(newVal) } }
            ))
        }
    }

    // MARK: - 遮罩 / 提示

    @ViewBuilder private var busyOverlay: some View {
        if let label = vm.busyAction {
            VStack(spacing: 12) {
                ProgressView()
                Text(label).font(.headline)
                Text("长任务进行中，请勿关闭…").font(.caption).foregroundStyle(.secondary)
            }
            .padding(24)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }

    @ViewBuilder private var banner: some View {
        if let msg = vm.errorMessage {
            Text(msg).font(.footnote).foregroundStyle(.white)
                .padding(10).frame(maxWidth: .infinity).background(.red)
        } else if let info = vm.infoMessage {
            Text(info).font(.footnote).foregroundStyle(.white)
                .padding(10).frame(maxWidth: .infinity).background(.green)
                .onAppear {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { vm.infoMessage = nil }
                }
        }
    }
}
