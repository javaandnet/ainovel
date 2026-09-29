import SwiftUI

/// 服务器设置：填写 ainovel 站点根地址（可指向远程/线上服务器）。
/// 只需填 host[:port]，App 自动补 http:// 与 /novel 前缀；填完整 URL（含自定义前缀路径）时原样保留。
/// 保存后即时生效（AppConfig.baseURL 每次请求动态读取），并清除当前登录态需重新登录（Cookie 属另一域）。
struct ServerSettingsView: View {
    @EnvironmentObject var auth: AuthViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var hint: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("例如 192.168.1.55:3400 或 novel.example.com", text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("服务器地址")
                } footer: {
                    Text("留空则恢复默认（\(AppConfig.defaultBaseURL.absoluteString)）。真机连本机开发服务需与 Mac 同一 Wi-Fi；生产环境请用 HTTPS 域名。")
                }

                if let hint {
                    Section { Text(hint).foregroundStyle(.orange).font(.callout) }
                }

                Section {
                    Button("保存") { save() }
                    Button("恢复默认", role: .destructive) {
                        AppConfig.setCustomServer("")
                        auth.serverChanged()
                        dismiss()
                    }
                }
            }
            .navigationTitle("服务器设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .onAppear {
                if let custom = AppConfig.customServerURL {
                    text = custom.absoluteString
                }
            }
        }
    }

    private func save() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            AppConfig.setCustomServer("")
            auth.serverChanged()
            dismiss()
            return
        }
        guard let url = AppConfig.normalize(trimmed) else {
            hint = "地址格式无法识别，请检查。"
            return
        }
        AppConfig.setCustomServer(trimmed)
        auth.serverChanged()
        hint = "已切换到：\(url.absoluteString)，请重新登录。"
        // 稍作停留让用户看到生效地址，再关闭
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { dismiss() }
    }
}
