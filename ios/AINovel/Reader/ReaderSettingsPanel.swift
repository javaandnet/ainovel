import SwiftUI

/// 原生阅读设置面板：与页内 reader.core.js 同一套偏好口径（localStorage + 控件事件）。
/// 面板打开时 sync() 拉取页面现值回填；每项改动立即回写页面生效（语音版合成、连读、定时等
/// 由页面自身 handler 处理，原生侧只负责「设置」这一层壳）。
struct ReaderSettingsPanel: View {
    @ObservedObject var bridge: ReaderSiteBridge
    @Environment(\.dismiss) private var dismiss

    // 朗读
    @State private var engineAudio = false
    @State private var voiceId = Voice.tingting.rawValue
    @State private var rate = "1"
    @State private var gap = "250"
    @State private var autoNext = false
    @State private var keepScreenOn = false
    @State private var sleepMins = "0"
    // 学习
    @State private var learnMode = false
    @State private var learnLang = "中文"
    @State private var learnAge = "9"
    @State private var pinyin = false
    @State private var syncing = true
    /// 转换引擎克隆音色（后端 /api/tts/voices 动态拉；桥接不可用时为空，不显示选项组）
    @State private var cloneVoices: [CloneVoice] = []

    /// 与页内音色下拉同源：服务端代理 aibridge 的克隆音色清单
    struct CloneVoice: Decodable, Identifiable, Hashable {
        let id: String
        let name: String?
        let engine: String?
        var label: String { "转换 · \(name ?? id)（\(engine ?? "clone")）" }
    }
    private struct TtsVoicesResponse: Decodable { let ok: Bool; let voices: [CloneVoice]? }

    private static let rateNames = ["0.7": "慢", "1": "中", "1.5": "快"]
    private static let gapNames = ["0": "紧贴", "250": "自然", "600": "舒缓"]
    private static let sleepNames = ["0": "不定时", "15": "15 分钟", "30": "30 分钟", "60": "1 小时", "end": "本章结束"]

    /// 音色与页面 EDGE_VOICE_IDS 白名单一致（服务端 ALLOWED_VOICES 同集合）
    enum Voice: String, CaseIterable {
        case tingting = "zh-CN-XiaoxiaoNeural"
        case yunxi = "zh-CN-YunxiNeural"
        case yunjian = "zh-CN-YunjianNeural"
        case hsiaochen = "zh-TW-HsiaoChenNeural"
        case yunjhe = "zh-TW-YunJheNeural"

        var label: String {
            switch self {
            case .tingting: return "晓晓（简中女声）"
            case .yunxi: return "云希（简中男声）"
            case .yunjian: return "云健（简中男声）"
            case .hsiaochen: return "小芸（繁中女声）"
            case .yunjhe: return "云哲（繁中男声）"
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("朗读") {
                    Toggle("语音版（服务端合成，音质好）", isOn: $engineAudio)
                        .onChange(of: engineAudio) { _, on in
                            Task { await bridge.applyEngine(isAudio: on) }
                        }
                    Picker("音色", selection: $voiceId) {
                        ForEach(Voice.allCases, id: \.rawValue) { Text($0.label).tag($0.rawValue) }
                        if !cloneVoices.isEmpty {
                            Section("音色转换（本地克隆）") {
                                ForEach(cloneVoices) { Text($0.label).tag($0.id) }
                            }
                        }
                    }
                    .onChange(of: voiceId) { _, v in
                        Task {
                            // vc_ 克隆音色只有语音版（服务端转换引擎）能合，选中时自动切过去
                            if v.hasPrefix("vc_"), !engineAudio {
                                engineAudio = true
                                await bridge.applyEngine(isAudio: true)
                            }
                            await bridge.applyVoice(v)
                        }
                    }
                    Picker("语速", selection: $rate) {
                        ForEach(Self.rateNames.keys.sorted(), id: \.self) { Text(Self.rateNames[$0] ?? "").tag($0) }
                    }
                    .onChange(of: rate) { _, v in
                        Task { await bridge.applyRate(v) }
                    }
                    Picker("句间停顿", selection: $gap) {
                        ForEach(["0", "250", "600"], id: \.self) { Text(Self.gapNames[$0] ?? "").tag($0) }
                    }
                    .onChange(of: gap) { _, v in
                        Task { await bridge.applyGap(v) }
                    }
                    Toggle("读完本章连读下一章", isOn: $autoNext)
                        .onChange(of: autoNext) { _, on in
                            Task { await bridge.applyToggle(buttonId: "ttsAuto", wantActive: on, storageKey: "ttsAutoNext") }
                        }
                    Toggle("朗读时屏幕常亮", isOn: $keepScreenOn)
                        .onChange(of: keepScreenOn) { _, on in
                            Task { await bridge.applyToggle(buttonId: "ttsScreen", wantActive: on, storageKey: "ttsKeepScreenOn") }
                        }
                    Picker("定时关闭", selection: $sleepMins) {
                        ForEach(Self.sleepNames.keys.filter { $0 != "end" } + ["end"], id: \.self) {
                            Text(Self.sleepNames[$0] ?? "").tag($0)
                        }
                    }
                    .onChange(of: sleepMins) { _, v in
                        Task { await bridge.applySleep(v) }
                    }
                }
                Section("学习") {
                    Toggle("学习模式（生词标注）", isOn: $learnMode)
                        .onChange(of: learnMode) { _, on in
                            Task { await bridge.applyToggle(buttonId: "learnModeBtn", wantActive: on, storageKey: "learnMode") }
                        }
                    Picker("讲解语言", selection: $learnLang) {
                        ForEach(["中文", "英语", "日语", "韩语"], id: \.self) { Text($0).tag($0) }
                    }
                    .onChange(of: learnLang) { _, v in
                        Task { await bridge.applyLearnSelect(buttonId: "learnLang", storageKey: "learnLang", value: v) }
                    }
                    Picker("年龄", selection: $learnAge) {
                        ForEach(["5", "7", "9", "11", "13", "15"], id: \.self) { Text("\($0) 岁").tag($0) }
                    }
                    .onChange(of: learnAge) { _, v in
                        Task { await bridge.applyLearnSelect(buttonId: "learnAge", storageKey: "learnAge", value: v) }
                    }
                    Toggle("拼音模式", isOn: $pinyin)
                        .onChange(of: pinyin) { _, on in
                            Task { await bridge.applyToggle(buttonId: "pinyinFab", wantActive: on, storageKey: "pinyinMode") }
                        }
                }
                Section {
                    Text("设置保存在站点本身，与网页版/Safari 打开同一本书时口径一致。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("阅读设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .task { await fill() }
            .overlay { if syncing { ProgressView().controlSize(.small) } }
        }
    }

    /// 先拉克隆音色清单再回填 UI（saved 是 vc_ 时选项得先在列表里）；
    /// 音色名语音版存 ttsEdgeVoice、网页版存 ttsVoiceName，按当前引擎各读各的
    private func fill() async {
        await loadCloneVoices()
        let p = await bridge.sync()
        let s: (String, String) -> String = { (p[$0] as? String) ?? $1 }
        // iOS 无浏览器 TTS，注入脚本已预置语音版；读不到时按同源缺省处理
        engineAudio = s("ttsEngine", "audio") == "audio"
        rate = Self.rateNames.keys.contains(s("ttsRate", "1")) ? s("ttsRate", "1") : "1"
        gap = Self.gapNames.keys.contains(s("ttsGap", "250")) ? s("ttsGap", "250") : "250"
        autoNext = s("ttsAutoNext", "0") == "1"
        keepScreenOn = s("ttsKeepScreenOn", "0") == "1" || s("screenBtnOn", "0") == "1"
        sleepMins = "0" // 定时为一次性档，面板打开时恒显「不定时」
        learnMode = s("learnMode", "0") == "1"
        learnLang = s("learnLang", "中文")
        learnAge = s("learnAge", "9")
        pinyin = s("pinyinMode", "0") == "1"
        let savedEdge = s("ttsEdgeVoice", "")
        let savedBrowser = s("ttsVoiceName", "")
        let saved = engineAudio ? (savedEdge.isEmpty ? savedBrowser : savedEdge) : savedBrowser
        let known = Voice.allCases.contains(where: { $0.rawValue == saved })
            || cloneVoices.contains(where: { $0.id == saved })
        if known { voiceId = saved }
        syncing = false
    }

    /// 桥接不可用/旧后端没有此端点时静默空列表：隐藏选项组，不影响其余设置
    private func loadCloneVoices() async {
        guard cloneVoices.isEmpty else { return }
        if let resp = try? await APIClient.shared.get(TtsVoicesResponse.self, Endpoint.ttsVoices, timeout: 10) {
            cloneVoices = resp.ok ? (resp.voices ?? []) : []
        }
    }
}
