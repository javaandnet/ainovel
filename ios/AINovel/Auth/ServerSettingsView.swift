import SwiftUI

/// 后台服务器设置：预设「局域网 / 公网」两档一键切，也保留手填地址（换 Mac IP、临时指向别的机器）。
/// 地址与档位存 UserDefaults，APIClient 每次请求动态读取 —— 保存即生效，无需重启 App。
/// 换服务器后 Cookie 属另一域，需重新登录（切档/保存即调 auth.serverChanged() 清登录态）。
struct ServerSettingsView: View {
    @EnvironmentObject var auth: AuthViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var server = ""
    @State private var env: AppConfig.ServerEnv = AppConfig.env
    @State private var testResult: String?
    @State private var testing = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 10) {
                        envChip(.builtin, "局域网", icon: "house")
                        envChip(.cloud, "公网服务器", icon: "cloud")
                    }
                    LabeledContent("当前生效", value: AppConfig.displayBaseURL)
                } header: { Text("接入环境") }
                footer: {
                    Text("点一下即切换，无需重启 App。换服务器会清除当前登录态、需要重新登录（Cookie 属另一域）。")
                        .font(.footnote).foregroundStyle(.secondary)
                }

                Section {
                    TextField("服务器地址", text: $server, prompt: Text("如 192.168.1.55:3400"))
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: { Text("自定义地址（可选）") }
                footer: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("只填 host[:port] 即可，自动补 http:// 与 /novel；公网档请直接用上面的按钮（https 域名）。")
                        Text("内置默认：\(AppConfig.defaultBaseURL.absoluteString)　公网：\(AppConfig.cloudBaseURL.absoluteString)")
                    }
                    .font(.footnote).foregroundStyle(.secondary)
                }

                Section {
                    Button {
                        Task { await testConnection() }
                    } label: {
                        HStack {
                            Text("测试连接")
                            Spacer()
                            if testing { ProgressView() }
                        }
                    }
                    .disabled(testing)
                    if let r = testResult {
                        Text(r).font(.footnote)
                            .foregroundStyle(r.hasPrefix("✓") ? Color.green : Color.red)
                    }
                }

                Section {
                    Button("保存") { save() }
                    Button("恢复默认地址", role: .destructive) {
                        AppConfig.setCustomServer("")
                        env = .builtin
                        server = ""
                        testResult = nil
                        auth.serverChanged()
                    }
                }
            }
            .navigationTitle("服务器设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
            .onAppear {
                if server.isEmpty {
                    server = AppConfig.customServerURL?.absoluteString ?? ""
                }
            }
        }
    }

    private func save() {
        AppConfig.setCustomServer(server)
        env = AppConfig.env
        testResult = nil
        // 换地址后 Cookie 属另一域，清登录态以便对新地址重新登录
        auth.serverChanged()
    }

    /// 预设档按钮：选中态高亮，点一下直接生效
    private func envChip(_ e: AppConfig.ServerEnv, _ title: String, icon: String) -> some View {
        let selected = env == e
        return Button {
            AppConfig.setEnv(e)
            env = e
            server = ""
            testResult = nil
            auth.serverChanged()
        } label: {
            VStack(spacing: 3) {
                Image(systemName: icon)
                Text(title).font(.footnote)
                Text(AppConfig.url(for: e).host ?? "").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(selected ? Color.accentColor.opacity(0.15) : Color.clear)
            .overlay(RoundedRectangle(cornerRadius: 8)
                .strokeBorder(selected ? Color.accentColor : Color.gray.opacity(0.35), lineWidth: selected ? 2 : 1))
        }
        .buttonStyle(.plain)
    }

    /// 用公开的 /api/me 探活：2xx 即服务器可达（匿名也返 200），失败透出网络/状态文案。
    private func testConnection() async {
        testing = true
        defer { testing = false }
        do {
            _ = try await APIClient.shared.get(MeResponse.self, Endpoint.me)
            testResult = "✓ 连接成功（\(AppConfig.baseURL.absoluteString)）"
        } catch let e as APIError {
            testResult = "✗ \(e.errorDescription ?? "连接失败")"
        } catch {
            testResult = "✗ \(error.localizedDescription)"
        }
    }
}
