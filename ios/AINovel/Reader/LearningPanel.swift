import SwiftUI

@MainActor
final class LearningViewModel: ObservableObject {
    enum Mode: String, CaseIterable { case quiz = "测试", vocab = "生词", ask = "提问" }

    @Published var mode: Mode = .quiz
    @Published var questions: [QuizQuestion] = []
    @Published var answers: [Int: String] = [:]      // 题号 -> 所选选项
    @Published var feedback: [Int: String] = [:]     // 题号 -> 鼓励讲解
    @Published var words: [String] = []
    @Published var explainWord: String?
    @Published var explainText: String?
    @Published var question = ""
    @Published var answer = ""
    @Published var busy = false
    @Published var errorMessage: String?

    private let api = APIClient.shared
    private let age = 9
    private let lang = "中文"

    func loadQuiz(document: String, force: Bool) async {
        await run {
            var json: [String: Any] = ["document": document, "age": self.age]
            if force { json["force"] = true }
            let resp = try await self.api.post(QuizResponse.self, Endpoint.readerQuiz, json: json, timeout: AppConfig.llmTimeout)
            await MainActor.run { self.questions = resp.questions ?? []; self.answers = [:]; self.feedback = [:] }
        }
    }

    func loadVocab(document: String) async {
        await run {
            let resp = try await self.api.post(VocabResponse.self, Endpoint.readerVocab,
                                               json: ["document": document, "age": self.age], timeout: AppConfig.llmTimeout)
            await MainActor.run { self.words = resp.words ?? [] }
        }
    }

    func explain(word: String, context: String) async {
        explainWord = word
        explainText = nil
        await run {
            let resp = try await self.api.post(ExplainResponse.self, Endpoint.readerExplainWord,
                                               json: ["word": word, "age": self.age, "lang": self.lang, "context": context],
                                               timeout: AppConfig.llmTimeout)
            await MainActor.run { self.explainText = resp.explanation }
        }
    }

    func ask(document: String) async {
        let q = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return }
        await run {
            let resp = try await self.api.post(AskResponse.self, Endpoint.readerAsk,
                                               json: ["question": q, "document": document], timeout: AppConfig.llmTimeout)
            await MainActor.run { self.answer = resp.answer ?? "" }
        }
    }

    /// 答题后鼓励式讲解
    func grade(questionIndex: Int, picked: String, correct: String) async {
        answers[questionIndex] = picked
        let right = picked == correct
        let qTitle = questions.indices.contains(questionIndex) ? (questions[questionIndex].question ?? "") : ""
        let prompt = "这是一道阅读理解题。题目：\(qTitle)；正确答案：\(correct)；学生选择：\(picked)；是否答对：\(right ? "对" : "错")。请用一两句话给出鼓励式讲解。"
        await run {
            let resp = try await self.api.post(FeedbackResponse.self, Endpoint.readerFeedback,
                                               json: ["text": prompt], timeout: AppConfig.llmTimeout)
            await MainActor.run { self.feedback[questionIndex] = resp.feedback }
        }
    }

    private func run(_ work: () async throws -> Void) async {
        busy = true
        errorMessage = nil
        defer { busy = false }
        do { try await work() }
        catch let e as APIError { errorMessage = e.errorDescription }
        catch { errorMessage = error.localizedDescription }
    }
}

struct LearningPanel: View {
    let novelId: String?
    let content: String
    let title: String
    @StateObject private var vm = LearningViewModel()
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("模式", selection: $vm.mode) {
                    ForEach(LearningViewModel.Mode.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .padding()

                if let err = vm.errorMessage {
                    Text(err).font(.footnote).foregroundStyle(.red).padding(.horizontal)
                }

                panel
                Spacer(minLength: 0)
            }
            .navigationTitle("学习 · \(title)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .task(id: vm.mode) {
                guard !content.isEmpty else { return }
                switch vm.mode {
                case .quiz where vm.questions.isEmpty: await vm.loadQuiz(document: content, force: false)
                case .vocab where vm.words.isEmpty: await vm.loadVocab(document: content)
                default: break
                }
            }
        }
    }

    @ViewBuilder private var panel: some View {
        switch vm.mode {
        case .quiz: quizList
        case .vocab: vocabList
        case .ask: askView
        }
    }

    private var quizList: some View {
        List {
            if vm.busy && vm.questions.isEmpty {
                ProgressView("出题中…")
            }
            ForEach(Array(vm.questions.enumerated()), id: \.element.id) { idx, q in
                Section {
                    Text(q.question ?? "").font(.headline)
                    ForEach(q.options ?? [], id: \.self) { opt in
                        Button {
                            Task { await vm.grade(questionIndex: idx, picked: opt, correct: q.answer ?? "") }
                        } label: {
                            HStack {
                                Text(opt)
                                Spacer()
                                if vm.answers[idx] == opt {
                                    Image(systemName: opt == q.answer ? "checkmark.circle.fill" : "xmark.circle.fill")
                                        .foregroundStyle(opt == q.answer ? .green : .red)
                                }
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                    if let fb = vm.feedback[idx] {
                        Text(fb).font(.callout).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("第 \(idx + 1) 题")
                }
            }
            if !vm.questions.isEmpty {
                Button("换一组新题") { Task { await vm.loadQuiz(document: content, force: true) } }
            }
        }
    }

    private var vocabList: some View {
        List {
            if vm.busy && vm.words.isEmpty {
                ProgressView("选词中…")
            }
            ForEach(vm.words, id: \.self) { w in
                Button {
                    Task { await vm.explain(word: w, context: content) }
                } label: {
                    HStack {
                        Text(w)
                        Spacer()
                        Image(systemName: "info.circle")
                    }
                }
                .foregroundStyle(.primary)
            }
            if let ew = vm.explainWord {
                Section("「\(ew)」讲解") {
                    if vm.busy { ProgressView() }
                    else { Text(vm.explainText ?? "（未生成）") }
                }
            }
        }
    }

    private var askView: some View {
        VStack {
            TextField("就本章内容提问…", text: $vm.question, axis: .vertical)
                .padding().overlay(RoundedRectangle(cornerRadius: 10).stroke(.quaternary))
                .padding(.horizontal)
            HStack {
                Button("提问") { Task { await vm.ask(document: content) } }
                    .disabled(vm.question.isEmpty || vm.busy)
                if vm.busy { ProgressView() }
            }
            ScrollView {
                Text(vm.answer.isEmpty ? "提问后，AI 会依据本章内容作答。" : vm.answer)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
        }
    }
}
