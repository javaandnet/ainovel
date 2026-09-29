import SwiftUI

/// 小说设定弹层：书名 / 故事概要 / 正文设定 + 每章字数（genCfg）。
struct NovelSettingsSheet: View {
    @ObservedObject var vm: NovelManageViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var outline = ""
    @State private var content = ""
    @State private var targetWords = ""
    @State private var tolerancePct = ""
    @State private var splitPct = ""
    @State private var initialized = false

    var body: some View {
        NavigationStack {
            Form {
                Section("书名") { TextField("书名", text: $name) }
                Section("故事概要") {
                    TextField("全书主线", text: $outline, axis: .vertical).lineLimit(3...10)
                }
                Section("设定正文（角色 / 世界观）") {
                    TextField("世界观、角色设定等", text: $content, axis: .vertical).lineLimit(4...16)
                }
                Section {
                    TextField("目标字数（0=不限）", text: $targetWords).keyboardType(.numberPad)
                    TextField("浮动比例 %（5-50）", text: $tolerancePct).keyboardType(.numberPad)
                    TextField("拆章线 %（20-300）", text: $splitPct).keyboardType(.numberPad)
                } header: {
                    Text("每章字数设定")
                } footer: {
                    Text("留空即不改动该项。合格带 = 目标 ×(1±浮动%)。")
                }
            }
            .navigationTitle("小说设定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || vm.busyAction != nil)
                }
            }
            .onAppear(perform: preload)
        }
    }

    private func preload() {
        guard !initialized, let s = vm.settings else { return }
        initialized = true
        name = s.name ?? ""
        outline = s.outline ?? ""
        content = s.content ?? ""
        if let c = s.genCfg {
            if let t = c.targetWords { targetWords = "\(t)" }
            if let tol = c.tolerancePct { tolerancePct = "\(tol)" }
            if let sp = c.splitPct { splitPct = "\(sp)" }
        }
    }

    private func save() {
        var cfg = GenCfg()
        if let t = Int(targetWords) { cfg.targetWords = t }
        if let tol = Int(tolerancePct) { cfg.tolerancePct = tol }
        if let sp = Int(splitPct) { cfg.splitPct = sp }
        let anyCfg = cfg.targetWords != nil || cfg.tolerancePct != nil || cfg.splitPct != nil
        Task {
            await vm.saveSettings(name: name, outline: outline, content: content, genCfg: anyCfg ? cfg : nil)
            dismiss()
        }
    }
}

/// 单章标题 / 大纲编辑弹层：手改或"填构思 → 就地生成草稿 → 改完保存"。
struct ChapterOutlineSheet: View {
    @ObservedObject var vm: NovelManageViewModel
    let chapter: Chapter
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var outline = ""
    @State private var material = ""
    @State private var status: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("章节标题") { TextField("标题", text: $title) }
                Section("本章构思（可留空，留空则据全书概要与前后章衔接）") {
                    TextField("这章要写什么", text: $material, axis: .vertical).lineLimit(2...5)
                }
                Section {
                    Button {
                        genDraft()
                    } label: {
                        if vm.busyAction != nil { HStack { ProgressView(); Text("生成中（一次模型调用，可能一分多钟）") } }
                        else { Text("🧭 生成大纲草稿") }
                    }
                    .disabled(material.isEmpty && (vm.settings?.outline?.isEmpty ?? true))
                }
                Section("章节大纲") {
                    TextEditor(text: $outline).frame(minHeight: 160)
                }
                if let status {
                    Section { Text(status).font(.footnote).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("第 \(chapter.no ?? 0) 章")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        Task {
                            await vm.saveOutline(no: chapter.no ?? 0, name: title, outline: outline)
                            dismiss()
                        }
                    }
                    .disabled(vm.busyAction != nil)
                }
            }
            .onAppear {
                title = chapter.name ?? ""
                outline = chapter.outline ?? ""
            }
        }
    }

    private func genDraft() {
        status = "生成中…"
        Task {
            if let d = await vm.outlineDraft(no: chapter.no ?? 0, material: material) {
                if !d.outline.isEmpty { outline = d.outline }
                if !d.name.isEmpty && title.isEmpty { title = d.name }
                status = d.outline.isEmpty ? "模型未返回可用大纲" : "草稿已填入，可修改后保存"
            } else {
                status = "生成失败：\(vm.errorMessage ?? "未知错误")"
            }
        }
    }
}
