import SwiftUI

struct RootView: View {
    @EnvironmentObject var auth: AuthViewModel

    var body: some View {
        // 未登录也可进入：阅读 Tab 用公开端点 /api/novels 拉列表；
        // 登录仅在需要时（点开章节 401 / 手动登录）以 sheet 拉起。
        MainTabView()
            .sheet(isPresented: $auth.showLogin) {
                LoginView()
            }
            .task {
                if auth.bootstrapping {
                    await auth.bootstrap()
                }
            }
    }
}
