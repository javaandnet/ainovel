import SwiftUI

struct RootView: View {
    @EnvironmentObject var auth: AuthViewModel

    var body: some View {
        // 阅读为独立首页（不再用底部三 Tab）。管理 / 我的 收纳进首页工具栏入口。
        // 口径对齐 web 端 /novel/ 首页：未登录时不强制弹登录模态，而是显示书单页 + 右上角登录按钮，
        // 由用户主动登录（点开需鉴权的内容时才拉起登录 sheet）。
        ReaderRootView()
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
