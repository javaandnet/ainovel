import Foundation

/// 小说清单共享 ViewModel：阅读 Tab 与管理 Tab 都用它拉 /api/novels。
@MainActor
final class LibraryViewModel: ObservableObject {
    @Published var novels: [Novel] = []
    @Published var loading = false
    @Published var errorMessage: String?
    /// 超管可切换"查看全部作品"
    @Published var showAll = false

    private let api = APIClient.shared

    func refresh() async {
        loading = true
        errorMessage = nil
        defer { loading = false }
        do {
            var query: [String: String]? = nil
            if showAll { query = ["all": "1"] }
            let resp = try await api.get(NovelsResponse.self, Endpoint.novels, query: query)
            novels = resp.novels ?? []
        } catch let e as APIError {
            errorMessage = e.errorDescription
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func novel(id: String?) -> Novel? {
        guard let id else { return nil }
        return novels.first { $0.id == id }
    }
}
