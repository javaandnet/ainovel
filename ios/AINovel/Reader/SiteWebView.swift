import SwiftUI
import WebKit
import AVFoundation

/// 内置「直接观看」：用 WKWebView 打开发布后的读者站页面（真实书页，含内嵌测试题/生词/官方朗读）。
/// 关键点：WKWebView 有独立的 Cookie 存储，不会自动带上 URLSession 共享存储里的登录 Cookie，
/// 因此加载前先把 httpOnly 会话 Cookie 注入 WKWebsiteDataStore，VIP 书页才不会被拦成无权页。
/// 原生侧三件事：①解除 WebKit 自动播放拦截 + 挂 .playback 音频会话（不受静音键控制、可后台出声）；
/// ②注入 CSS 隐藏页内与原生面板重复的设置类控件（播放/目录/测试等保留 web 呈现）；
/// ③原生「阅读设置」面板经 ReaderSiteBridge 与页面 localStorage/控件事件双向同步。
struct SiteWebView: View {
    let url: URL
    let title: String
    @Environment(\.dismiss) private var dismiss
    @State private var loading = true
    @StateObject private var bridge = ReaderSiteBridge()
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            Group {
                if let fixed = SiteWebView.absoluteSiteURL(url) {
                    WebViewRepresentable(url: fixed, bridge: bridge) { loading = $0 }
                        .overlay { if loading { ProgressView() } }
                } else {
                    ContentUnavailableView("地址无效", systemImage: "link.badge.plus")
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "gearshape") }
                        .disabled(!bridge.ready)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Link(destination: SiteWebView.absoluteSiteURL(url) ?? url) {
                        Image(systemName: "safari")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                ReaderSettingsPanel(bridge: bridge)
            }
        }
        .task { ReaderAudioSession.shared.enablePlayback() }
        .onDisappear { ReaderAudioSession.shared.releaseToAmbient() }
    }

    /// 相对站点路径（如 /novel/uid/书名/index.html）转 URL：中文路径先按 urlPathAllowed 百分号编码，
    /// 避免 URL(string:) 对非 ASCII 返回 nil。
    static func relativeURL(_ path: String) -> URL? {
        let encoded = path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? path
        return URL(string: encoded)
    }

    /// share.url 可能已带 /novel 前缀（以 / 开头），转成 origin+path 的完整 URL；已是完整 URL 时原样返回
    static func absoluteSiteURL(_ url: URL) -> URL? {
        if url.scheme != nil, url.host != nil { return url }
        // 相对形式（如 /novel/uid/书名/index.html）用 baseURL 的 origin 补全
        guard let b = AppConfig.baseURL as URL?, let scheme = b.scheme, let host = b.host else { return url }
        let port = b.port.map { ":\($0)" } ?? ""
        let p = url.absoluteString.hasPrefix("/") ? url.absoluteString : "/" + url.absoluteString
        return URL(string: "\(scheme)://\(host)\(port)\(p)")
    }
}

private struct WebViewRepresentable: UIViewRepresentable {
    let url: URL
    let bridge: ReaderSiteBridge
    let onLoading: (Bool) -> Void

    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // 复用默认数据存储，注入的 Cookie 才会作用于本页
        cfg.websiteDataStore = .default()
        // 朗读引擎在页内用 <audio> 播服务端 mp3：默认要求用户手势，autoplay=1/连读换章会被静默拦截
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsInlineMediaPlayback = true
        // Web Speech shim 的原生后端：句级 utterance → AVSpeechSynthesizer
        cfg.userContentController.add(context.coordinator.ttsHandler, name: GalaWebSpeech.handlerName)
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.allowsBackForwardNavigationGestures = true
        // reader.core.js 是 DOM ready 后动态构建工具栏的，UserScript 早于它，用 CSS 屏蔽重复的设置类控件
        web.configuration.userContentController.addUserScript(
            WKUserScript(source: ReaderSiteBridge.hideCss, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        // WKWebView 没有 Web Speech API（仅 Safari 有），reader.core.js 环境检测会直接掐死阅读模式；
        // 注入 shim 桥接到原生 AVSpeechSynthesizer，并预置 iOS 默认引擎为语音版（服务端 mp3）
        web.configuration.userContentController.addUserScript(
            WKUserScript(source: GalaWebSpeech.shimJs, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        web.configuration.userContentController.addUserScript(
            WKUserScript(source: GalaWebSpeech.engineDefaultJs, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        )
        web.navigationDelegate = context.coordinator
        context.coordinator.attach(web)
        return web
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        context.coordinator.owner = self
        if context.coordinator.lastLoaded != url {
            context.coordinator.lastLoaded = url
            // 先同步 Cookie 再加载
            CookieSync.sync {
                uiView.load(URLRequest(url: url))
            }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var owner: WebViewRepresentable
        var lastLoaded: URL?
        weak var web: WKWebView?
        let ttsHandler = GalaWebSpeechHandler()
        init(_ owner: WebViewRepresentable) { self.owner = owner }
        func attach(_ web: WKWebView) {
            self.web = web
            web.navigationDelegate = self
            ttsHandler.webView = web
        }
        func webView(_ webView: WKWebView, didStart navigation: WKNavigation!) {
            owner.onLoading(true)
            ttsHandler.reset()
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            owner.onLoading(false)
            owner.bridge.attach(webView)
        }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            owner.onLoading(false)
            ttsHandler.reset()
        }
    }
}

/// 原生音频会话：.playback 类别绕过侧边静音键并允许后台出声；离页降回 .ambient 不干扰其它 App。
final class ReaderAudioSession {
    static let shared = ReaderAudioSession()
    private let session = AVAudioSession.sharedInstance()

    func enablePlayback() {
        do {
            // mixWithOthers：不抢占其它正在播放的音频（默认 .playback 会打断别人）
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            NSLog("[SiteWebView] AVAudioSession .playback failed: \(error.localizedDescription)")
        }
    }

    func releaseToAmbient() {
        do {
            try session.setCategory(.ambient, mode: .default, options: [])
        } catch {
            NSLog("[SiteWebView] AVAudioSession back to .ambient failed: \(error.localizedDescription)")
        }
    }
}

/// 原生设置面板与页内 reader.core.js 的桥：偏好统一走页面 localStorage + 控件事件，
/// 保证网页版/ Safari 打开同一站点时口径一致，不存在两套设置。
@MainActor
final class ReaderSiteBridge: ObservableObject {
    @Published var ready = false

    /// 与页面偏好同名的可编辑值（面板打开时 sync() 拉取回填）
    @Published var prefs: [String: Any] = [:]

    weak var web: WKWebView?

    /// 隐藏页内设置类控件（原生面板取代）；播放/从头/进度/目录/测试/拼音/问答 FAB 保留
    static let hideCss = """
    #settingsFab,#ttsEngine,#ttsSleep,#ttsRate,#ttsGap,#ttsScreen,#ttsAuto,.tts-engine-row,.tts-power-row{display:none!important;}
    """

    func attach(_ web: WKWebView) {
        self.web = web
        ready = true
    }

    // MARK: - 读取

    /// 拉取当前页偏好快照：localStorage 直读 + 开关类按钮的 active 态
    func sync() async -> [String: Any] {
        let js = """
        (function () {
          var g = function (k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } };
          var act = function (id) { var el = document.getElementById(id); return el && el.classList.contains('active') ? '1' : '0'; };
          return {
            ttsEngine: g('ttsEngine', 'browser'),
            ttsRate: g('ttsRate', '1'),
            ttsGap: g('ttsGap', '250'),
            ttsVoiceName: g('ttsVoiceName', ''),
            ttsAutoNext: g('ttsAutoNext', '0'),
            ttsKeepScreenOn: g('ttsKeepScreenOn', '0'),
            pinyinMode: g('pinyinMode', '0'),
            learnMode: g('learnMode', '0'),
            learnLang: g('learnLang', '中文'),
            learnAge: g('learnAge', '9'),
            screenBtnOn: act('ttsScreen'),
            autoBtnOn: act('ttsAuto')
          };
        })();
        """
        guard let result = try? await web?.evaluateJavaScript(js), let dict = result as? [String: Any] else {
            return [:]
        }
        prefs = dict
        return dict
    }

    // MARK: - 写入

    /// 在页内执行 JS（丢弃返回值），供各 apply* 复用
    private func run(_ js: String) async {
        _ = try? await web?.evaluateJavaScript(js)
    }

    /// 引擎切换：点页内按钮走 switchEngine 原生路径（含停旧引擎/更新提示）
    func applyEngine(isAudio: Bool) async {
        let want = isAudio ? "audio" : "browser"
        await run("""
        (function () {
          var btn = document.getElementById('ttsEngine');
          var cur = (function () { try { return localStorage.getItem('ttsEngine') || 'browser'; } catch (e) { return 'browser'; } })();
          if (cur === '\(want)') { return 'ok'; }
          if (btn) { btn.click(); return 'ok'; }
          try { localStorage.setItem('ttsEngine', '\(want)'); } catch (e) {}
          return 'ok';
        })();
        """)
    }

    /// 语速/停顿：设值 + 派发 change（页面 change handler 负责持久化与即时生效）
    func applyRate(_ value: String) async {
        await run("""
        (function () {
          var el = document.getElementById('ttsRate');
          if (!el) { try { localStorage.setItem('ttsRate', '\(value)'); } catch (e) {} return 'ok'; }
          el.value = '\(value)';
          if (el.selectedIndex < 0) { el.value = '1'; }
          el.dispatchEvent(new Event('change'));
          return 'ok';
        })();
        """)
    }

    func applyGap(_ value: String) async {
        await run("""
        (function () {
          var el = document.getElementById('ttsGap');
          if (!el) { try { localStorage.setItem('ttsGap', '\(value)'); } catch (e) {} return 'ok'; }
          el.value = '\(value)';
          el.dispatchEvent(new Event('change'));
          return 'ok';
        })();
        """)
    }

    /// 音色：语音版直选 edge ID；网页版按名字匹配 iOS 系统语音，匹配不到保持原选择
    func applyVoice(_ name: String) async {
        await run("""
        (function () {
          var want = '\(name)';
          var sel = document.getElementById('ttsVoice');
          var engine = (function () { try { return localStorage.getItem('ttsEngine') || 'browser'; } catch (e) { return 'browser'; } })();
          if (!sel || !sel.options.length) {
            try { localStorage.setItem('ttsVoiceName', want); } catch (e) {}
            return 'ok';
          }
          var i, ok = false;
          for (i = 0; i < sel.options.length; i++) { if (sel.options[i].value === want) { ok = true; break; } }
          if (!ok && engine === 'audio') { try { localStorage.setItem('ttsVoiceName', want); } catch (e) {} return 'ok'; }
          if (!ok) {
            /* 网页版：模糊匹配 iOS 系统语音（名字或中文显示名） */
            var hints = { 'zh-CN-XiaoxiaoNeural': ['ting', '晓晓', 'Xiaoxiao'],
                          'zh-CN-YunxiNeural': ['yun', '云希', 'Yunxi'],
                          'zh-CN-YunjianNeural': ['yunjian', '云健'],
                          'zh-TW-HsiaoChenNeural': ['mei', '小芸', 'Hsiao'],
                          'zh-TW-YunJheNeural': ['yunjhe', '云哲'] };
            var h = hints[want] || [];
            for (i = 0; i < sel.options.length && !ok; i++) {
              var n = (sel.options[i].value + sel.options[i].textContent).toLowerCase();
              for (var j = 0; j < h.length; j++) { if (n.indexOf(h[j].toLowerCase()) >= 0) { ok = true; sel.selectedIndex = i; break; } }
            }
          }
          if (ok) { sel.dispatchEvent(new Event('change')); }
          return ok ? 'matched' : 'keep';
        })();
        """)
    }

    /// 连读/常亮/拼音/学习模式：状态不符才 click（页面 handler 自会翻转并持久化）
    func applyToggle(buttonId: String, wantActive: Bool, storageKey: String) async {
        let flag = wantActive ? "1" : "0"
        await run("""
        (function () {
          var el = document.getElementById('\(buttonId)');
          if (!el) { try { localStorage.setItem('\(storageKey)', '\(flag)'); } catch (e) {} return 'ok'; }
          var on = el.classList.contains('active') ? '1' : '0';
          if (on !== '\(flag)') { el.click(); }
          return 'ok';
        })();
        """)
    }

    /// 定时关闭：设值 + change（0/15/30/60/end；不落 localStorage，页面用 sessionStorage 记截止）
    func applySleep(_ value: String) async {
        await run("""
        (function () {
          var el = document.getElementById('ttsSleep');
          if (!el) { return 'ok'; }
          el.value = '\(value)';
          el.dispatchEvent(new Event('change'));
          return 'ok';
        })();
        """)
    }

    /// 学习语言/年龄：先写 localStorage 再 click 页内 select——其 change handler
    /// 会把「控件当前值」写回存储，先改值后派发会把新设置覆盖回旧值
    func applyLearnSelect(buttonId: String, storageKey: String, value: String) async {
        let escaped = value.replacingOccurrences(of: "'", with: "\\'")
        await run("""
        (function () {
          try { localStorage.setItem('\(storageKey)', '\(escaped)'); } catch (e) {}
          var el = document.getElementById('\(buttonId)');
          if (!el) { return 'ok'; }
          el.value = '\(escaped)';
          el.dispatchEvent(new Event('change'));
          return 'ok';
        })();
        """)
    }
}

/// WKWebView 缺 Web Speech API 的兼容层：JS 侧 shim（window.speechSynthesis / SpeechSynthesisUtterance）
/// + 原生侧 AVSpeechSynthesizer 后端。页面按「一句一 utterance、onend 跨句」的口径驱动。
enum GalaWebSpeech {
    static let handlerName = "galaTts"

    /// iOS 无浏览器 TTS，语音版（服务端 mp3）作缺省引擎；只在从未存过偏好时写入，不覆盖用户选择
    static let engineDefaultJs = """
    (function () {
      try { if (localStorage.getItem('ttsEngine') === null) { localStorage.setItem('ttsEngine', 'audio'); } } catch (e) {}
    })();
    """

    static let shimJs = """
    (function () {
      if (window.speechSynthesis && window.SpeechSynthesisUtterance) { return; }
      var HANDLER = 'galaTts';
      var registry = {}, seq = 0, current = null, queue = [];
      function send(m) { try { window.webkit.messageHandlers[HANDLER].postMessage(m); } catch (e) {} }
      function fire(u, type) {
        /* u[type] 内部已级联 on* 属性回调与 addEventListener 监听，只走这一条路径防双发 */
        if (typeof u[type] === 'function') { u[type]({ type: type }); }
      }
      function speakNext() {
        if (current || !queue.length) { return; }
        var item = queue.shift(); current = item;
        send({ action: 'speak', id: item.id, text: item.u.text, voice: item.u.voice ? item.u.voice.name : '', rate: item.u.rate });
      }
      function SpeechSynthesisUtterance(text) {
        var self = this;
        this.text = text == null ? '' : String(text);
        this.voice = null; this.lang = ''; this.rate = 1; this.pitch = 1; this.volume = 1;
        var ls = {};
        ['start', 'end', 'error', 'boundary'].forEach(function (t) {
          self['on' + t] = null; ls[t] = [];
          self[t] = function (ev) { if (typeof self['on' + t] === 'function') { self['on' + t](ev); } ls[t].forEach(function (cb) { cb(ev); }); };
        });
        this.addEventListener = function (n, cb) { if (ls[n]) { ls[n].push(cb); } };
        this.removeEventListener = function (n, cb) { if (ls[n]) { ls[n] = ls[n].filter(function (f) { return f !== cb; }); } };
      }
      /* 别名与页面 VOICE_MATCHERS 正则对齐；Google 两条仅占位（edgeVoice() 按名字映射服务端音色），
         真用网页版朗读时原生端按名字解析不到会退到 zh 系统音 */
      var VOICES = [
        { name: 'Tingting', lang: 'zh-CN' },
        { name: 'Mei Jia', lang: 'zh-TW' },
        { name: 'Google 普通话（中国大陆）', lang: 'zh-CN' },
        { name: 'Google 粤語（香港）', lang: 'zh-HK' }
      ];
      VOICES.forEach(function (v) { v.default = false; v.localService = true; });
      var synth = {
        speak: function (u) {
          var id = ++seq; registry[id] = u; queue.push({ id: id, u: u });
          setTimeout(speakNext, 0);
        },
        /* 原生朗读完成回调：end 驱动页面 speakSentence(idx+1) 跨句 */
        __finish: function (id) {
          var u = registry[id]; delete registry[id];
          if (current && current.id === id) { current = null; }
          if (u) { fire(u, 'end'); }
          speakNext();
        },
        __error: function (id) {
          var u = registry[id]; delete registry[id];
          if (current && current.id === id) { current = null; }
          if (u) { fire(u, 'error'); }
        },
        cancel: function () { queue = []; current = null; registry = {}; send({ action: 'cancel' }); },
        pause: function () { send({ action: 'pause' }); },
        resume: function () { send({ action: 'resume' }); },
        getVoices: function () { return VOICES.slice(); },
        paused: false,
        speaking: false,
        pending: false,
        onvoiceschanged: null
      };
      Object.defineProperty(synth, 'speaking', { get: function () { return !!current; } });
      Object.defineProperty(synth, 'pending', { get: function () { return queue.length > 0; } });
      Object.defineProperty(synth, 'paused', {
        get: function () { return !!(current && current.u.__paused); }
      });
      setTimeout(function () { if (synth.onvoiceschanged) { synth.onvoiceschanged(); } }, 0);
      window.speechSynthesis = synth;
      window.SpeechSynthesisUtterance = SpeechSynthesisUtterance;
      /* 原生回调入口：started/speak 与 finish/error 分别对应 utterance 的 start/end/error 事件 */
      window.GalaTTS = {
        started: function (id) { var u = registry[id]; if (u) { fire(u, 'start'); } },
        finish: function (id) { synth.__finish(id); },
        error: function (id) { synth.__error(id); }
      };
    })();
    """
}

/// Web Speech shim 的原生后端：句级 utterance → AVSpeechSynthesizer，完成后回页内抛 end 事件。
final class GalaWebSpeechHandler: NSObject, WKScriptMessageHandler, AVSpeechSynthesizerDelegate {
    private let synth = AVSpeechSynthesizer()
    private var currentId: Int = -1
    /// 持有当前 utterance：iOS 的 AVSpeechSynthesizer 无 resume 方法，对暂停中的同一 utterance 再 speak 即续播
    private var currentUtterance: AVSpeechUtterance?
    weak var webView: WKWebView?

    override init() {
        super.init()
        synth.delegate = self
    }

    /// 导航级清场：连读跳章/返回时旧页的在途句子直接停掉，新页 shim 会重新建会话
    func reset() {
        currentId = -1
        currentUtterance = nil
        if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        switch action {
        case "speak":
            let id = (body["id"] as? NSNumber)?.intValue ?? -1
            let text = (body["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let rate = (body["rate"] as? NSNumber)?.doubleValue ?? 1.0
            let name = body["voice"] as? String ?? ""
            speak(id: id, text: text, name: name, rate: rate)
        case "cancel":
            currentId = -1
            currentUtterance = nil
            if synth.isSpeaking { synth.stopSpeaking(at: .immediate) }
        case "pause":
            if synth.isSpeaking { synth.pauseSpeaking(at: .word) }
        case "resume":
            if let u = currentUtterance, synth.isPaused { synth.speak(u) }
        default:
            break
        }
    }

    private func speak(id: Int, text: String, name: String, rate: Double) {
        /* 空 utterance（页面触发 voices 加载用的哨兵）直接回 end，不然悬挂 */
        if text.isEmpty { finish(id); return }
        let u = AVSpeechUtterance(string: text)
        u.voice = voice(for: name)
        /* Web 语速 1.0 ≈ 系统舒适档 0.5；页面档位 0.7/1/1.5 → 0.35/0.5/0.75（限幅在系统可用区间内） */
        u.rate = Float(min(max(0.5 * rate, 0.3), 0.7))
        currentId = id
        currentUtterance = u
        synth.speak(u)
        DispatchQueue.main.async { [weak self] in
            self?.fire("window.GalaTTS && GalaTTS.started(\(id))")
        }
    }

    private func finish(_ id: Int) {
        fire("window.GalaTTS && GalaTTS.finish(\(id))")
    }

    private func fire(_ js: String) {
        webView?.evaluateJavaScript(js)
    }

    /// 页面音色名 → 系统语音：Tingting/普通话→zh-CN，Mei Jia/粵→zh-TW/zh-HK，其余退中文默认
    private func voice(for name: String) -> AVSpeechSynthesisVoice? {
        let lower = name.lowercased()
        let zhVoices = AVSpeechSynthesisVoice.speechVoices().filter { $0.language.hasPrefix("zh") }
        func pick(_ matcher: (AVSpeechSynthesisVoice) -> Bool) -> AVSpeechSynthesisVoice? {
            if let v = zhVoices.first(where: matcher) { return v }
            return nil
        }
        if lower.contains("mei") || lower.contains("粵") || lower.contains("hk") || lower.contains("hsiao") {
            return pick { $0.language.hasPrefix("zh-TW") || $0.language.hasPrefix("zh-HK") }
                ?? pick { $0.language.hasPrefix("zh") }
        }
        if lower.contains("ting") || lower.contains("普通") || lower.contains("cn") || lower.contains("yun") {
            return pick { $0.language.hasPrefix("zh-CN") || $0.language == "zh_CN" }
                ?? pick { $0.language.hasPrefix("zh") }
        }
        let def = AVSpeechSynthesisVoice(language: "zh-CN")
        return def ?? zhVoices.first
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let id = currentId
        currentId = -1
        currentUtterance = nil
        finish(id)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        /* cancel 路径不回 end：页面 speak 前必 cancel，回 end 会误导它跨到下一句 */
        currentId = -1
        currentUtterance = nil
    }
}

/// 把 URLSession 共享 Cookie 存储里的会话 Cookie 注入 WKWebView 的默认数据存储。
enum CookieSync {
    static func sync(completion: @escaping () -> Void) {
        guard let host = AppConfig.baseURL.host else { completion(); return }
        let store = HTTPCookieStorage.shared
        let site = WKWebsiteDataStore.default().httpCookieStore
        let all = store.cookies ?? []
        let relevant = all.filter { $0.domain.contains(host) || host.contains($0.domain.replacingOccurrences(of: ".", with: "")) }
        if relevant.isEmpty { completion(); return }
        let group = DispatchGroup()
        for c in relevant {
            group.enter()
            site.setCookie(c) { group.leave() }
        }
        group.notify(queue: .main) { completion() }
    }
}
