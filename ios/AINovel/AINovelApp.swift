import SwiftUI

@main
struct AINovelApp: App {
    @StateObject private var auth = AuthViewModel.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(auth)
        }
    }
}
