import SwiftUI

/// 服务器设置：预设「局域网 / 公网」两档一键切，也保留手填站点根地址。
/// 只需填 host[:port]，App 自动补 http:// 与 /novel 前缀；填完整 URL（含自定义前缀路径）时原样保留。
/// 保存后即时生效（AppConfig.baseURL 每次请求动态读取），并清除当前登录态需重新登录（Cookie 属另一域）。
/// AI 生成与朗读都经由本站后端转发，所以切站点就是切 AI 出口。
struct ServerSettingsView: View {
    @EnvironmentObject var auth: AuthViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var env: AppConfig.ServerEnv = AppConfig.env
    @State private var hint: String?

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
                    Text("点一下即切换，无需重启。Cookie 属于各自站点，切换后需重新登录。")
                }

                Section {
                    TextField("例如 192.168.1.55:3400 或 novel.example.com", text: $text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                } header: {
                    Text("自定义地址（可选）")
                } footer: {
                    Text("留空则恢复默认（\(AppConfig.defaultBaseURL.absoluteString)）。真机连本机开发服务需与 Mac 同一 Wi-Fi；公网请直接用上面的按钮（\(AppConfig.cloudBaseURL.absoluteString)）。")
                }

                if let hint {
                    Section { Text(hint).foregroundStyle(.orange).font(.callout) }
                }

                Section {
                    Button("保存") { save() }
                    Button("恢复默认", role: .destructive) {
                        AppConfig.setCustomServer("")
                        env = .builtin
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
            env = .builtin
            auth.serverChanged()
            dismiss()
            return
        }
        guard let url = AppConfig.normalize(trimmed) else {
            hint = "地址格式无法识别，请检查。"
            return
        }
        AppConfig.setCustomServer(trimmed)
        env = AppConfig.env
        auth.serverChanged()
        hint = "已切换到：\(url.absoluteString)，请重新登录。"
        // 稍作停留让用户看到生效地址，再关闭
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { dismiss() }
    }

    /// 预设档按钮：选中态高亮，点一下直接生效
    private func envChip(_ e: AppConfig.ServerEnv, _ title: String, icon: String) -> some View {
        let selected = env == e
        return Button {
            AppConfig.setEnv(e)
            env = e
            text = ""
            hint = "已切换到：\(AppConfig.url(for: e).absoluteString)，请重新登录。"
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
}
