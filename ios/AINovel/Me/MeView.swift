import SwiftUI

struct MeView: View {
    @EnvironmentObject var auth: AuthViewModel
    @State private var showServerSettings = false
    @State private var showLogoutConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                if auth.isLoggedIn {
                    Section("账号") {
                        LabeledContent("用户", value: auth.user?.display ?? "—")
                        LabeledContent("角色", value: auth.user?.role ?? "—")
                        if let uid = auth.user?.id {
                            LabeledContent("用户 ID", value: uid)
                        }
                    }
                } else {
                    Section {
                        LabeledContent("登录状态", value: "未登录（可浏览公开书单）")
                        Button("登录") { auth.requestLogin() }
                    } footer: {
                        Text("登录后可阅读完整章节与管理自己的作品。")
                    }
                }

                Section("连接") {
                    LabeledContent("服务器") {
                        Button { showServerSettings = true } label: {
                            Text(AppConfig.displayBaseURL).foregroundStyle(.secondary)
                        }
                    }
                }

                if auth.isLoggedIn {
                    Section {
                        Button("退出登录", role: .destructive) { showLogoutConfirm = true }
                    }
                }
            }
            .navigationTitle("我的")
            .sheet(isPresented: $showServerSettings) {
                ServerSettingsView()
            }
            .confirmationDialog("确认退出登录？", isPresented: $showLogoutConfirm, titleVisibility: .visible) {
                Button("退出", role: .destructive) { Task { await auth.logout() } }
                Button("取消", role: .cancel) {}
            }
        }
    }
}
