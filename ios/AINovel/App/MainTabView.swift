import SwiftUI

struct MainTabView: View {
    var body: some View {
        TabView {
            ReaderRootView()
                .tabItem { Label("阅读", systemImage: "book.pages") }

            ManageRootView()
                .tabItem { Label("管理", systemImage: "slider.horizontal.3") }

            MeView()
                .tabItem { Label("我的", systemImage: "person.crop.circle") }
        }
    }
}
