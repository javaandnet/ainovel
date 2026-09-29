import Foundation
import AVFoundation

/// 本地朗读器：用系统 AVSpeechSynthesizer 朗读章节正文（零联网、零流量）。
/// ainovel 服务端另有逐句 mp3 的 TTS 接口，客户端朗读不需要它——本地合成即时、可控语速，
/// 且不受桥接服务可用性影响。
@MainActor
final class SpeechPlayer: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var speaking = false
    @Published var currentParagraph = 0

    private let synth = AVSpeechSynthesizer()
    private var paragraphs: [String] = []

    override init() {
        super.init()
        synth.delegate = self
    }

    /// 切段：按空行/换行分段，过滤纯空白
    static func split(_ text: String) -> [String] {
        text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    func start(text: String, rate: Float = 0.5) {
        stop()
        paragraphs = Self.split(text)
        guard !paragraphs.isEmpty else { return }
        for (i, p) in paragraphs.enumerated() {
            let u = AVSpeechUtterance(string: p)
            u.voice = AVSpeechSynthesisVoice(language: "zh-CN")
            u.rate = rate
            u.paragraphIndex = i
            synth.speak(u)
        }
    }

    func stop() {
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        speaking = false
        currentParagraph = 0
    }

    // MARK: - AVSpeechSynthesizerDelegate

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        let idx = utterance.paragraphIndex
        Task { @MainActor in
            self.speaking = true
            self.currentParagraph = idx
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if !synthesizer.isSpeaking { self.speaking = false }
        }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in self.speaking = false }
    }
}

private var speechTagKey: UInt8 = 0
extension AVSpeechUtterance {
    /// 记录段落序号，供 didStart 回调高亮当前段
    var paragraphIndex: Int {
        get { (objc_getAssociatedObject(self, &speechTagKey) as? Int) ?? 0 }
        set { objc_setAssociatedObject(self, &speechTagKey, newValue, .OBJC_ASSOCIATION_RETAIN) }
    }
}
