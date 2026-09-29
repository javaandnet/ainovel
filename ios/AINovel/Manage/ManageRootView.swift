import SwiftUI

struct ManageRootView: View {
    @EnvironmentObject var auth: AuthViewModel
    @StateObject private var lib = LibraryViewModel()
    @State private var showCreate = false
    @State private var pendingDelete: Novel?
    @State private var deleteText = ""

    var body: some View {
        NavigationStack {
            Group {
                if lib.loading && lib.novels.isEmpty {
                    ProgressView("加载中…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let err = lib.errorMessage {
                    ContentUnavailableView {
                        Label("加载失败", systemImage: "wifi.exclamationmark")
                    } description: { Text(err) } actions: {
                        Button("重试") { Task { await lib.refresh() } }
                    }
                } else if lib.novels.isEmpty {
                    ContentUnavailableView {
                        Label("还没有作品", systemImage: "square.and.pencil")
                    } description: { Text("点右上角「＋」新建一本小说") }
                } else {
                    List {
                        ForEach(lib.novels) { novel in
                            NavigationLink {
                                NovelManageView(novel: novel)
                                    .environmentObject(lib)
                            } label: {
                                NovelRow(novel: novel)
                                    .contextMenu {
                                        Button("删除", role: .destructive) { pendingDelete = novel; deleteText = "" }
                                    }
                            }
                        }
                    }
                }
            }
            .navigationTitle("管理")
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showCreate = true } label: { Image(systemName: "plus") }
                }
            }
            .refreshable { await lib.refresh() }
            .task { if lib.novels.isEmpty { await lib.refresh() } }
            .sheet(isPresented: $showCreate) {
                NovelCreateSheet { Task { await lib.refresh() } }
            }
            .alert("删除整本小说", isPresented: Binding(
                get: { pendingDelete != nil },
                set: { if !$0 { pendingDelete = nil } }
            )) {
                TextField("输入 OK 以确认删除", text: $deleteText)
                Button("删除", role: .destructive) {
                    if deleteText.trimmingCharacters(in: .whitespaces) == "OK", let n = pendingDelete {
                        Task { await deleteNovel(n) }
                    }
                }
                Button("取消", role: .cancel) { pendingDelete = nil }
            } message: {
                Text("删除《\(pendingDelete?.display ?? "")》及其全部章节，不可撤销。请输入大写 OK 确认。")
            }
        }
    }

    private func deleteNovel(_ novel: Novel) async {
        guard let id = novel.id else { return }
        do {
            _ = try await APIClient.shared.delete(OkResponse.self, Endpoint.novel(id), json: ["confirm": "OK"])
            pendingDelete = nil
            await lib.refresh()
        } catch let e as APIError {
            lib.errorMessage = e.errorDescription
        } catch {
            lib.errorMessage = error.localizedDescription
        }
    }
}

struct NovelCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject var auth: AuthViewModel
    var onCreated: () -> Void
    @State private var title = ""
    @State private var outline = ""
    @State private var busy = false
    @State private var errText: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("书名") {
                    TextField("必填", text: $title)
                }
                Section("故事概要") {
                    TextField("全书主线，用于后续大纲/正文生成的上下文", text: $outline, axis: .vertical)
                        .lineLimit(3...8)
                }
                if let errText {
                    Section { Text(errText).foregroundStyle(.red).font(.callout) }
                }
            }
            .navigationTitle("新建小说")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(busy ? "创建中…" : "创建") { create() }
                        .disabled(title.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
        }
    }

    private func create() {
        errText = nil
        busy = true
        Task {
            do {
                _ = try await APIClient.shared.post(CreateNovelResponse.self, Endpoint.novels, json: [
                    "title": title, "outline": outline
                ])
                onCreated()
                dismiss()
            } catch let e as APIError {
                errText = e.errorDescription
            } catch {
                errText = error.localizedDescription
            }
            busy = false
        }
    }
}
