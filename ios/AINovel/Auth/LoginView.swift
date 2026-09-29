import SwiftUI

struct LoginView: View {
    @EnvironmentObject var auth: AuthViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var password = ""
    @State private var remember = true
    @State private var showServerSettings = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent("服务器") {
                        Button {
                            showServerSettings = true
                        } label: {
                            Text(hostDisplay)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section {
                    TextField("用户名", text: $username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("密码", text: $password)
                    Toggle("记住密码", isOn: $remember)
                }

                Section {
                    Button {
                        Task {
                            await auth.login(username: username, password: password, remember: remember)
                            if auth.isLoggedIn { dismiss() }
                        }
                    } label: {
                        if auth.isBusy {
                            HStack { ProgressView(); Text("登录中…") }
                                .frame(maxWidth: .infinity)
                        } else {
                            Text("登录").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(username.isEmpty || password.isEmpty || auth.isBusy)
                }

                if let msg = auth.errorMessage {
                    Section {
                        Text(msg).foregroundStyle(.red).font(.callout)
                    }
                }
            }
            .navigationTitle("AI小说 · 登录")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("以后再说") { dismiss() }
                }
            }
            .onAppear {
                if let cred = auth.savedCredential {
                    username = cred.username
                    password = cred.password
                }
            }
            .sheet(isPresented: $showServerSettings) {
                ServerSettingsView()
            }
        }
    }

    private var hostDisplay: String {
        AppConfig.baseURL.host ?? AppConfig.displayBaseURL
    }
}
