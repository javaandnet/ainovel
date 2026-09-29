import Foundation

/// 单本小说的管理 ViewModel：设定读写、章节列表、大纲编辑、生成动作、发布、VIP、分享。
/// 生成类动作走通用 /api/run（长任务，超时放宽到 llmTimeout），失败透出后端 error 文案。
@MainActor
final class NovelManageViewModel: ObservableObject {
    @Published var settings: NovelSettings?
    @Published var chapters: [Chapter] = []
    @Published var parts: [Part] = []
    @Published var share: ShareResponse?
    @Published var vip = false

    @Published var loading = false
    @Published var busyAction: String?
    @Published var errorMessage: String?
    @Published var infoMessage: String?

    let novelId: String
    private let api = APIClient.shared

    init(novelId: String) { self.novelId = novelId }

    // MARK: - 加载

    func loadAll() async {
        loading = true
        defer { loading = false }
        await withTaskGroup(of: Void.self) { group in
            group.addTask { await self.loadSettings() }
            group.addTask { await self.loadChapters() }
            group.addTask { await self.loadParts() }
            group.addTask { await self.loadVip() }
            group.addTask { await self.loadShare() }
        }
    }

    func loadSettings() async {
        do { settings = try await api.get(NovelSettings.self, Endpoint.settings(novelId)) }
        catch { errorMessage = errText(error) }
    }

    func loadChapters() async {
        do {
            let resp = try await api.get(ChaptersResponse.self, Endpoint.chapters(novelId))
            chapters = resp.chapters ?? []
        } catch { errorMessage = errText(error) }
    }

    func loadParts() async {
        do { parts = (try await api.get(PartsResponse.self, Endpoint.parts(novelId)).parts) ?? [] }
        catch { /* 分部为可选，读不到不阻断 */ }
    }

    func loadVip() async {
        struct VipResp: Decodable { let vip: Bool? }
        do { vip = (try await api.get(VipResp.self, Endpoint.vip(novelId)).vip) ?? false }
        catch { /* 忽略 */ }
    }

    func loadShare() async {
        do { share = try await api.get(ShareResponse.self, Endpoint.share(novelId)) }
        catch { errorMessage = errText(error) }
    }

    // MARK: - 设定保存（未传即不改）

    func saveSettings(name: String, outline: String, content: String, genCfg: GenCfg?) async {
        await busy("保存设定") {
            var json: [String: Any] = ["name": name, "outline": outline, "content": content]
            if let cfg = genCfg {
                var c: [String: Any] = [:]
                if let t = cfg.targetWords { c["targetWords"] = t }
                if let tol = cfg.tolerancePct { c["tolerancePct"] = tol }
                if let sp = cfg.splitPct { c["splitPct"] = sp }
                json["genCfg"] = c
            }
            _ = try await self.api.put(SaveSettingsResponse.self, Endpoint.settings(self.novelId), json: json)
            await self.loadSettings()
            self.flash("设定已保存")
        }
    }

    // MARK: - 章节大纲

    func saveOutline(no: Int, name: String?, outline: String?) async {
        await busy("保存大纲") {
            var json: [String: Any] = [:]
            if let name { json["name"] = name }
            if let outline { json["outline"] = outline }
            _ = try await self.api.put(OkResponse.self, Endpoint.outline(self.novelId, no), json: json)
            await self.loadChapters()
            self.flash("第 \(no) 章大纲已保存")
        }
    }

    /// 就地生成大纲草稿（只读、不落库），返回 {name, outline}
    func outlineDraft(no: Int, material: String) async -> (name: String, outline: String)? {
        struct Draft: Decodable { let ok: Bool?; let outline: String?; let name: String? }
        busyAction = "生成大纲草稿"
        errorMessage = nil
        defer { busyAction = nil }
        do {
            let d = try await api.post(Draft.self, Endpoint.outlineDraft(novelId, no),
                                        json: ["material": material], timeout: AppConfig.llmTimeout)
            return (d.name ?? "", d.outline ?? "")
        } catch let e as APIError {
            errorMessage = e.errorDescription
            return nil
        } catch {
            errorMessage = error.localizedDescription
            return nil
        }
    }

    // MARK: - 生成动作（/api/run）

    func runAction(_ action: String, extra: [String: Any] = [:]) async {
        await busy(action) {
            var json: [String: Any] = ["action": action, "novelId": self.novelId]
            for (k, v) in extra { json[k] = v }
            let resp = try await self.api.post(RunResponse.self, Endpoint.run, json: json, timeout: AppConfig.llmTimeout)
            if resp.success == true {
                await self.loadChapters()
                self.flash("「\(action)」完成")
            } else if let r = resp.result?.stringValue {
                self.infoMessage = r
            }
        }
    }

    // MARK: - 发布 / 删除 / 重排 / VIP

    func publish(premake: Bool) async {
        await busy("发布") {
            let resp = try await self.api.post(PublishResponse.self, Endpoint.publish(self.novelId),
                                               json: ["premakeQuiz": premake], timeout: AppConfig.llmTimeout)
            await self.loadShare()
            self.flash("发布完成：\(resp.pages ?? 0) 页")
        }
    }

    func renumber() async {
        await busy("重排编号") {
            let resp = try await api.put(RenumberResponse.self, Endpoint.renumber(novelId), json: [:])
            await loadChapters()
            flash("已顺延 \(resp.shiftedCount ?? 0) 章")
        }
    }

    func deleteChapter(no: Int) async {
        await busy("删除第 \(no) 章") {
            _ = try await self.api.delete(OkResponse.self, Endpoint.deleteChapter(self.novelId, no), json: ["confirm": "OK"])
            await self.loadChapters()
            self.flash("已删除第 \(no) 章")
        }
    }

    func setVip(_ on: Bool) async {
        await busy(on ? "开启 VIP" : "关闭 VIP") {
            struct R: Decodable { let ok: Bool?; let vip: Bool? }
            let resp = try await self.api.put(R.self, Endpoint.vip(self.novelId), json: ["vip": on])
            self.vip = resp.vip ?? on
        }
    }

    // MARK: - 辅助

    private func flash(_ m: String) { infoMessage = m }

    private func busy(_ label: String, _ work: () async throws -> Void) async {
        busyAction = label
        errorMessage = nil
        defer { busyAction = nil }
        do { try await work() }
        catch let e as APIError { errorMessage = e.errorDescription }
        catch { errorMessage = error.localizedDescription }
    }

    private func errText(_ e: Error) -> String {
        if let a = e as? APIError { return a.errorDescription ?? "请求失败" }
        return e.localizedDescription
    }
}
