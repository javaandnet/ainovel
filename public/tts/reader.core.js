/**
 * 阅读模式（TTS）核心逻辑 —— 外部资源，不内联进章节页
 *
 * 由同目录 reader.js 带时间戳动态加载，因此修改本文件（或 reader.css）后立即对所有
 * 历史已发布页面生效：只需同步这一个文件到服务器，不需要重新发布任何小说章节。
 *
 * 能力：正文逐句切分 → 双引擎朗读（网页版：speechSynthesis；语音版：服务端 mp3 合成）
 *      → 当前句高亮 + 自动滚动跟随 → 读完本章自动跳下一章（?autoplay=1 自动开播）
 *      → 语速/音色/连读/引擎偏好持久化 → Media Session 锁屏控件
 *      → 屏幕常亮 / 息屏省电切换（默认息屏省电，靠静音保活维持出声）
 *      → 定时关闭朗读（15/30/60 分钟到点停，或本章读完停；跨章连读不丢）
 *      → 左右滑动（触屏）/ 方向键（桌面）翻阅上一章下一章
 *      → 学习模式下按年龄挑生词并加粗标注，点词可直接查该词
 */
(function () {
  'use strict';

  /* 站点前缀：本文件由 reader.js 以 <BASE>/tts/reader.core.js?v=… 加载，
     所以用自身 URL 反推前缀，AI 接口一律按该前缀发出。站点挂在 /novel 还是根路径、
     以后改成什么别的前缀，都不必重新发布任何章节页（与 reader.js 同一套自定位思路）。
     判不出前缀时记为 null：宁可让 AI 调用当场报错，也不要用错路径默默 404。 */
  var APP_BASE = (function () {
    var src = document.currentScript && document.currentScript.src;
    if (!src) {
      var all = document.scripts;
      for (var i = all.length - 1; i >= 0; i--) {
        if (/\/tts\/reader\.core\.js/.test(all[i].src)) { src = all[i].src; break; }
      }
    }
    return src ? src.replace(/\/tts\/reader\.core\.js.*$/, '') : null;
  })();

  function boot() {
    /* 加载器为避免原始导航闪烁，已用 html.reader-nav-defer 提前把它收起（见 reader.js）。
       本文件已经跑起来了，接手方就在下面 1b（直接给 .chapter-nav 挂内联 display:none），
       所以此处先撤掉临时收起：与 1b 处于同一同步任务，中间不会绘制，不会因此再闪一次；
       而提前 return 的路径（不支持语音合成 / 无正文容器）本就不建面板，撤掉收起正好让
       原始导航回来，不至于把翻章入口弄丢。 */
    document.documentElement.classList.remove('reader-nav-defer');

    var content = document.querySelector('.content');

    /* ===== 0. 环境检测（不可用时明确告知，不静默隐藏按钮） ===== */
    if (!('speechSynthesis' in window)) {
      var tip = document.createElement('div');
      tip.textContent = '当前浏览器不支持语音合成（Web Speech API），阅读模式不可用，建议改用 Chrome / Edge / Safari。';
      tip.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:1002;'
        + 'background:#2c3e50;color:#f39c12;padding:10px 16px;border-radius:8px;font-size:14px;max-width:90%;'
        'box-shadow:0 4px 12px rgba(0,0,0,0.3);';
      document.body.appendChild(tip);
      setTimeout(function () { tip.remove(); }, 8000);
      return;
    }
    if (!content) { return; }

    /* ===== 1. 动态构建悬浮工具栏与控制面板 ===== */
    var holder = document.createElement('div');
    holder.innerHTML = [
      '<div class="reader-toolbar" id="readerToolbar">',
      '  <div class="toolbar-actions" id="toolbarActions">',
      '    <button class="toolbar-btn" id="settingsFab" title="设置"><span class="tb-ico">⚙</span><span class="tb-txt">设置</span></button>',
      '    <button class="toolbar-btn" id="quizFab" title="本章测试"><span class="tb-ico">📝</span><span class="tb-txt">测试</span></button>',
      '    <button class="toolbar-btn" id="aiFab" title="AI 问答"><span class="tb-ico">🤖</span><span class="tb-txt">问答</span></button>',
      '    <button class="toolbar-btn" id="chapterBtn" title="章节目录"><span class="tb-ico">📑</span><span class="tb-txt">目录</span></button>',
      '    <button class="toolbar-btn" id="ttsFab" title="朗读"><span class="tb-ico">🎧</span><span class="tb-txt">朗读</span></button>',
      '  </div>',
      '  <button class="toolbar-btn toolbar-menu" id="toolbarMenu" title="工具" aria-expanded="false" aria-label="展开工具栏">☰</button>',
      '</div>',
      '<div class="tts-panel" id="ttsPanel">',
      '  <div class="tts-row">',
      '    <button class="tts-btn primary" id="ttsPlay">▶ 播放</button>',
      '    <button class="tts-btn" id="ttsRestart" title="从头开始">⏮ 从头</button>',
      '    <input type="range" class="tts-progress-bar" id="ttsProgressBar" min="0" max="100" value="0" title="拖动调整朗读位置">',
      '    <span class="tts-progress-text" id="ttsProgressText">0/0</span>',
      '  </div>',
      '  <div class="tts-row tts-settings-row">',
      '    <select id="ttsVoice" class="tts-voice-select"></select>',
      '    <select id="ttsRate" class="tts-rate-select" title="语速">',
      '      <option value="0.7">🐢 慢</option>',
      '      <option value="1" selected> 中</option>',
      '      <option value="1.5">🐇 快</option>',
      '    </select>',
      '    <button class="tts-icon-btn" id="ttsAuto" title="连续朗读下一章">🔁</button>',
      '    <button class="tts-icon-btn" id="ttsCloseIcon" title="关闭">✕</button>',
      '  </div>',
      '  <div class="tts-row tts-power-row">',
      '    <button class="tts-btn power-btn" id="ttsScreen" title="朗读时是否保持屏幕常亮；默认不锁屏，屏幕会熄灭、只保留声音（省电）">🌙 息屏省电</button>',
      '    <select id="ttsSleep" class="tts-rate-select" title="定时关闭朗读">',
      '      <option value="0">⏱ 不定时</option>',
      '      <option value="15">⏱ 15 分钟</option>',
      '      <option value="30">⏱ 30 分钟</option>',
      '      <option value="60">⏱ 1 小时</option>',
      '      <option value="end">⏱ 本章结束</option>',
      '    </select>',
      '    <span class="tts-sleep-left" id="ttsSleepLeft"></span>',
      '  </div>',
      '  <div class="tts-row tts-engine-row">',
      '    <button class="tts-btn engine-btn" id="ttsEngine" title="切换朗读引擎：网页版（浏览器 TTS）或语音版（服务端合成 mp3）">🌐 网页版</button>',
      '    <button class="tts-btn gen-btn" id="ttsGenChapter" title="预生成全章音频（语音版专用，生成后可离线播放）">📥 生成全章</button>',
      '    <span class="tts-engine-hint" id="ttsEngineHint">浏览器 TTS，息屏可能无声</span>',
      '  </div>',
      '  <div class="tts-row"><span class="tts-hint" id="ttsHint" style="display:none"></span></div>',
      '</div>',
      '<div class="chapter-panel" id="chapterPanel">',
      '  <div class="chapter-panel-row" id="chapterNavLinks"></div>',
      '  <button class="tts-icon-btn chapter-panel-close" id="chapterPanelClose" title="关闭">✕</button>',
      '</div>',
      '<div class="ai-panel" id="aiPanel">',
      '  <div class="ai-panel-header">',
      '    <span class="ai-panel-title">AI 问答</span>',
      '    <button class="tts-icon-btn" id="aiPanelClose" title="关闭">✕</button>',
      '  </div>',
      '  <div class="ai-messages" id="aiMessages"></div>',
      '  <div class="ai-input-row">',
      '    <input type="text" class="ai-input" id="aiInput" placeholder="输入问题...">',
      '    <button class="ai-mic-btn" id="aiMicBtn" title="语音输入">🎤</button>',
      '    <button class="ai-send-btn" id="aiSendBtn">发送</button>',
      '  </div>',
      '</div>',
      '<div class="settings-panel" id="settingsPanel">',
      '  <div class="ai-panel-header">',
      '    <span class="ai-panel-title">学习设置</span>',
      '    <button class="tts-icon-btn" id="settingsPanelClose" title="关闭">✕</button>',
      '  </div>',
      '  <div class="settings-body">',
      '    <div class="settings-row">',
      '      <label>学习模式</label>',
      '      <button class="tts-icon-btn" id="learnModeBtn" title="学习模式开关"></button>',
      '    </div>',
      '    <div class="settings-row">',
      '      <label>自动生成词义</label>',
      '      <button class="tts-icon-btn" id="autoExplainBtn" title="开页后自动依次生成生词讲解（首次较慢，之后全站秒显）"></button>',
      '    </div>',
      '    <div class="settings-row">',
      '      <label>学习语言</label>',
      '      <select id="learnLang" class="tts-rate-select">',
      '        <option value="英语">英语</option>',
      '        <option value="日语" selected>日语</option>',
      '        <option value="韩语">韩语</option>',
      '        <option value="中文">中文</option>',
      '      </select>',
      '    </div>',
      '    <div class="settings-row">',
      '      <label>年龄</label>',
      '      <select id="learnAge" class="tts-rate-select">',
      '        <option value="5">5 岁</option>',
      '        <option value="7">7 岁</option>',
      '        <option value="9" selected>9 岁</option>',
      '        <option value="11">11 岁</option>',
      '        <option value="13">13 岁</option>',
      '        <option value="15">15 岁</option>',
      '      </select>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="explain-panel" id="explainPanel">',
      '  <div class="ai-panel-header">',
      '    <span class="ai-panel-title">词汇讲解</span>',
      '    <button class="tts-icon-btn" id="explainPanelClose" title="关闭">✕</button>',
      '  </div>',
      '  <div class="explain-body" id="explainBody">加载中...</div>',
      '</div>',
      '<div class="quiz-panel" id="quizPanel">',
      '  <div class="ai-panel-header">',
      '    <span class="ai-panel-title" id="quizTitle">本章小测试</span>',
      '    <span class="quiz-head-actions">',
      '      <button class="tts-icon-btn quiz-regen" id="quizRegenerate" title="换一组新题（重新调用 AI 出题，平时不自动换题）">↻</button>',
      '      <button class="tts-icon-btn" id="quizPanelClose" title="关闭">✕</button>',
      '    </span>',
      '  </div>',
      '  <div class="quiz-body" id="quizBody">加载中...</div>',
      '</div>'
    ].join('\n');
    var pick = function (id) { return holder.querySelector('#' + id); };
    var fab = pick('ttsFab');
    var chapterBtn = pick('chapterBtn');
    var toolbar = pick('readerToolbar');
    var toolbarMenu = pick('toolbarMenu');
    var panel = pick('ttsPanel');
    var playBtn = pick('ttsPlay');
    var restartBtn = pick('ttsRestart');
    var closeIconBtn = pick('ttsCloseIcon');
    var progressBar = pick('ttsProgressBar');
    var progressText = pick('ttsProgressText');
    var rateEl = pick('ttsRate');
    var voiceSel = pick('ttsVoice');
    var autoEl = pick('ttsAuto');
    var screenBtn = pick('ttsScreen');
    var sleepSel = pick('ttsSleep');
    var sleepLeftEl = pick('ttsSleepLeft');
    var hintEl = pick('ttsHint');
    var chapterPanel = pick('chapterPanel');
    var chapterNavLinks = pick('chapterNavLinks');
    var chapterPanelClose = pick('chapterPanelClose');
    var aiFab = pick('aiFab');
    var aiPanel = pick('aiPanel');
    var aiPanelClose = pick('aiPanelClose');
    var aiMessages = pick('aiMessages');
    var aiInput = pick('aiInput');
    var aiSendBtn = pick('aiSendBtn');
    var aiMicBtn = pick('aiMicBtn');
    var settingsFab = pick('settingsFab');
    var settingsPanel = pick('settingsPanel');
    var settingsPanelClose = pick('settingsPanelClose');
    var learnModeBtn = pick('learnModeBtn');
    var learnLangSel = pick('learnLang');
    var learnAgeSel = pick('learnAge');
    var autoExplainBtn = pick('autoExplainBtn');
    var explainPanel = pick('explainPanel');
    var explainPanelClose = pick('explainPanelClose');
    var explainBody = pick('explainBody');
    var quizFab = pick('quizFab');
    var quizPanel = pick('quizPanel');
    var quizPanelClose = pick('quizPanelClose');
    var quizTitle = pick('quizTitle');
    var quizBody = pick('quizBody');
    var quizRegenerate = pick('quizRegenerate');
    document.body.appendChild(holder);

    /* ===== 1b. 提取内联章节导航 → 悬浮面板，隐藏原始导航 ===== */
    var inlineNavs = document.querySelectorAll('.chapter-nav');
    for (var n = 0; n < inlineNavs.length; n++) { inlineNavs[n].style.display = 'none'; }
    if (inlineNavs.length > 0) {
      chapterNavLinks.innerHTML = inlineNavs[0].innerHTML;
    }

    /* ===== 1c. 工具栏二级展开：收起态只留一个入口，点开才向上弹出动作项 ===== */
    /* 五个按钮常驻会竖排占掉近 300px，正好压住正文；而一次阅读里真正会用到的
       往往只有一两项，多按一次入口换回正文空间是划算的。
       朗读为最高频动作，排在与入口相邻的一格（拇指行程最短）。
       本段紧接面板构建就做，不放至后面的开合逻辑里：正文无可读句子时后面会提前
       return，那样会让 ☰ 绑不上点击，工具栏就彻底点不开了。 */
    function collapseToolbar() {
      toolbar.classList.remove('expanded');
      toolbarMenu.textContent = '☰';
      toolbarMenu.setAttribute('aria-expanded', 'false');
    }
    function expandToolbar() {
      toolbar.classList.add('expanded');
      toolbarMenu.textContent = '✕';
      toolbarMenu.setAttribute('aria-expanded', 'true');
    }
    toolbarMenu.addEventListener('click', function () {
      if (toolbar.classList.contains('expanded')) { collapseToolbar(); }
      else { expandToolbar(); }
    });
    /* 入口以外任意位置点击即收起。必须是冒泡阶段的 click，不能是按下（pointerdown/mousedown）：
       按下时就收起会让动作按钮 display:none，松开时该元素已不在渲染树里，
       浏览器改按「按下目标与松开目标的最近共同祖先」派发 click，落在 html 上 ——
       按钮自己的 click 根本不会执行，点一下只剩收起，什么面板也不弹。 */
    document.addEventListener('click', function (e) {
      if (!toolbar.classList.contains('expanded')) { return; }
      if (e.target === toolbarMenu || toolbarMenu.contains(e.target)) { return; } /* 入口的开合由它自己的 click 管 */
      collapseToolbar();
    });

    /* ===== 2. 正文逐句切分（按中文标点，pre/code 内跳过） ===== */
    var endPuncts = '。！？…；';
    var tailPuncts = '…！？”\'’」）！？。';
    function splitSentences(text) {
      var out = [];
      var buf = '';
      for (var i = 0; i < text.length; i++) {
        var ch = text.charAt(i);
        buf += ch;
        if (endPuncts.indexOf(ch) >= 0) {
          while (i + 1 < text.length && tailPuncts.indexOf(text.charAt(i + 1)) >= 0) {
            buf += text.charAt(i + 1);
            i++;
          }
          out.push(buf);
          buf = '';
        }
      }
      if (buf) { out.push(buf); }
      return out;
    }
    var walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) { return NodeFilter.FILTER_REJECT; }
        var p = node.parentNode;
        while (p && p !== content) {
          if (p.nodeName === 'PRE' || p.nodeName === 'CODE') { return NodeFilter.FILTER_REJECT; }
          /* 发布端标 .tts-skip 的元素（如章节页顶部“第X部 · 部名”小标）只作展示，
             不进入朗读句子序列，否则朗读会多读一句与正文无关的短标 */
          if (p.classList && p.classList.contains('tts-skip')) { return NodeFilter.FILTER_REJECT; }
          p = p.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var textNodes = [];
    while (walker.nextNode()) { textNodes.push(walker.currentNode); }
    textNodes.forEach(function (tn) {
      var frag = document.createDocumentFragment();
      splitSentences(tn.nodeValue).forEach(function (s) {
        if (!s.trim()) { frag.appendChild(document.createTextNode(s)); return; }
        var span = document.createElement('span');
        span.className = 'tts-sentence';
        span.textContent = s;
        frag.appendChild(span);
      });
      tn.parentNode.replaceChild(frag, tn);
    });
    var sentences = Array.prototype.slice.call(content.querySelectorAll('.tts-sentence'));
    if (!sentences.length) {
      fab.remove();
      panel.remove();
      return;
    }

    /* ===== 3. TTS 引擎 ===== */
    var synth = window.speechSynthesis;
    var currentIndex = -1;
    var playing = false;
    var paused = false; /* 本地暂停状态，不依赖 synth.paused（部分浏览器不可靠） */
    var seq = 0;
    var spokenOnce = false;
    var voicesReady = false;
    var wakeLock = null; /* 屏幕唤醒锁，防止朗读时息屏 */
    var keepScreenOn = false; /* 默认息屏省电：只留声音；打开才在朗读时锁屏（偏好读取见第 5 节） */
    var silentAudio = null;  /* 静音循环，见 syncKeepAlive */
    var ttsEngine = 'browser'; /* 'browser' | 'audio' */
    var audioEl = null;        /* 语音版 <audio> 元素 */
    var currentAudioUrl = null; /* 当前播放的音频 URL（用于 Media Session） */

    /* 0.05s 静音 WAV：单独看不发声，但足以让系统认为「本页正在放音频」。
       Web Speech 不像 <audio> 那样会占住音频会话，iOS/Android 一息屏就把合成挂起，
       靠这个静音循环把会话顶住，息屏朗读才可能真的持续出声。 */
    var SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

    /* 请求屏幕唤醒锁（仅在开了「屏幕常亮」时；息屏省电模式下反过来要主动放锁） */
    function requestWakeLock() {
      if (!keepScreenOn) { releaseWakeLock(); return; }
      if (!navigator.wakeLock) { syncKeepAlive(); return; }
      if (wakeLock) { return; }
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () { wakeLock = null; syncKeepAlive(); });
        syncKeepAlive();
      }).catch(function () { /* 息屏请求可能被拒绝，静默忽略 */ syncKeepAlive(); });
    }
    /* 释放屏幕唤醒锁 */
    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release().catch(function () {});
        wakeLock = null;
      }
      syncKeepAlive();
    }
    /* 只要屏幕实际会息（关了常亮，或本机没拿到锁——iOS Safari 整个不支持 wakeLock，
       选了常亮也照样息屏），就需要静音保活；屏幕真亮着时不必多占这份功耗。 */
    function syncKeepAlive() {
      if (!playing || (keepScreenOn && wakeLock)) {
        if (silentAudio && !silentAudio.paused) { silentAudio.pause(); }
        return;
      }
      if (!silentAudio) {
        silentAudio = new Audio(SILENT_WAV);
        silentAudio.loop = true;
        silentAudio.volume = 0;
      }
      if (silentAudio.paused) { silentAudio.play().catch(function () {}); }
    }

    /* ===== 3b. 定时关闭：15 / 30 / 60 分钟到点停，或「本章结束」读完即停 ===== */
    var sleepDeadline = 0; /* 绝对毫秒时间戳，0 = 未定时 */
    var sleepAlarm = null;
    var sleepTick = null;
    var sleepAtChapterEnd = false; /* 「本章结束」档：不倒数，读完本章即停，与分钟档互斥 */

    function fmtLeft(ms) {
      var s = Math.max(0, Math.round(ms / 1000));
      var m = Math.floor(s / 60);
      var r = s % 60;
      return (m < 10 ? '0' : '') + m + ':' + (r < 10 ? '0' : '') + r;
    }
    function sleepExpired() { return sleepDeadline > 0 && Date.now() >= sleepDeadline; }
    function clearSleep() {
      clearTimeout(sleepAlarm);
      clearInterval(sleepTick);
      sleepAlarm = null;
      sleepTick = null;
      sleepDeadline = 0;
      sleepAtChapterEnd = false;
      sleepLeftEl.textContent = '';
      try { sessionStorage.removeItem('ttsSleepDeadline'); } catch (e) {}
    }
    function armSleep(minutes) {
      clearTimeout(sleepAlarm);
      clearInterval(sleepTick);
      if (!minutes) { clearSleep(); return; }
      sleepAtChapterEnd = false;
      /* 存绝对时间戳而不是剩余秒数：连读跳章会重载页面，重新计时等于把定时拉长 */
      sleepDeadline = Date.now() + minutes * 60000;
      try { sessionStorage.setItem('ttsSleepDeadline', minutes + '|' + sleepDeadline); } catch (e) {}
      scheduleSleep();
      flashTip('⏱ ' + (minutes >= 60 ? (minutes / 60) + ' 小时' : minutes + ' 分钟') + '后自动停止朗读');
    }
    /* 「本章结束」档：没有倒数，因此只挂标志，到点动作由 onChapterEnd 就地执行 */
    function armChapterEndSleep() {
      clearTimeout(sleepAlarm);
      clearInterval(sleepTick);
      sleepAlarm = null;
      sleepTick = null;
      sleepDeadline = 0;
      sleepAtChapterEnd = true;
      try { sessionStorage.setItem('ttsSleepDeadline', 'end|0'); } catch (e) {}
      sleepLeftEl.textContent = '⏱ 本章末';
      flashTip('⏱ 本章读完即停止（连读也会在此停下，不跳下一章）');
    }
    /* 撤档：连同把下拉还原成「不定时」，否则下一次开播仍被旧设定卡住 */
    function disarmChapterEndSleep() {
      sleepAtChapterEnd = false;
      sleepSel.value = '0';
      sleepLeftEl.textContent = '';
      try { sessionStorage.removeItem('ttsSleepDeadline'); } catch (e) {}
    }
    function scheduleSleep() {
      if (sleepDeadline <= 0) { return; }
      var left = sleepDeadline - Date.now();
      if (left <= 0) { fireSleep(); return; }
      clearTimeout(sleepAlarm);
      clearInterval(sleepTick);
      sleepLeftEl.textContent = '⏱ ' + fmtLeft(left);
      /* 后台标签页的 setTimeout 会被节流到分钟级，到点不一定准；因此真正停声还由
         句子边界兜底（见 speakSentence 开头的 sleepExpired 判定）。 */
      sleepAlarm = setTimeout(fireSleep, left);
      sleepTick = setInterval(function () {
        if (sleepDeadline <= 0) { clearInterval(sleepTick); return; }
        var l = sleepDeadline - Date.now();
        if (l <= 0) { fireSleep(); return; }
        sleepLeftEl.textContent = '⏱ ' + fmtLeft(l);
      }, 1000);
    }
    function fireSleep() {
      if (sleepDeadline <= 0) { return; } /* 句子边界与计时器都会到点，先到先得 */
      clearSleep();
      sleepSel.value = '0';
      if (!playing) { return; }
      synth.cancel();
      seq++; /* 作废旧 utterance 的回调，否则 cancel 触发的 onend 会又跳下一句 */
      playing = false;
      paused = false;
      releaseWakeLock();
      updatePlayBtn();
      updateProgress('定时关闭：已停止朗读');
    }
    /* 回前台立刻校准倒计时：后台节流期间可能已经过期，靠节流后的回调会晚很久；
       顺带补一次锁——息屏时系统会自行 release，不补的话回前台就不常亮了。 */
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') { return; }
      scheduleSleep();
      if (playing && !paused) { requestWakeLock(); }
    });

    /* 预加载语音，确保首次点击即可朗读 */
    function ensureVoicesReady() {
      if (voicesReady) { return; }
      var voices = synth.getVoices();
      if (voices.length > 0) {
        voicesReady = true;
      } else {
        /* 强制触发语音加载 */
        synth.onvoiceschanged = function () {
          voicesReady = true;
          loadVoices();
        };
        /* 部分浏览器需要空 utterance 触发加载 */
        synth.speak(new SpeechSynthesisUtterance(''));
      }
    }

    function showHint(msg) { hintEl.textContent = msg; hintEl.style.display = ''; }
    function selectedVoice() {
      var voices = synth.getVoices();
      for (var i = 0; i < voices.length; i++) {
        if (voices[i].name === voiceSel.value) { return voices[i]; }
      }
      return null;
    }
    function markReading(idx) {
      for (var i = 0; i < sentences.length; i++) {
        sentences[i].classList.toggle('reading', i === idx);
        sentences[i].classList.toggle('read', i < idx);
      }
      if (idx >= 0) {
        try { sentences[idx].scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        catch (e) { sentences[idx].scrollIntoView(); }
      }
    }
        function updateProgress(extraText) {
      if (extraText) { progressText.textContent = extraText; return; }
      if (sentences.length === 0) {
        progressBar.value = 0;
        progressText.textContent = '0/0';
        return;
      }
      if (currentIndex < 0) {
        progressBar.value = 0;
        progressText.textContent = '0/' + sentences.length;
        return;
      }
      var pct = Math.round((currentIndex / (sentences.length - 1)) * 100);
      progressBar.value = pct;
      progressText.textContent = (currentIndex + 1) + '/' + sentences.length;
    }
    function updatePlayBtn() {
      /* 三态：朗读中→可暂停；已暂停→可继续；未开始/已停止→可播放 */
      if (playing) { playBtn.textContent = paused ? '▶ 继续' : '⏸ 暂停'; }
      else { playBtn.textContent = '▶ 播放'; }
    }
    /* 按导航文案定位章节链接（发布端 buildChapterNav 产出「← 上一章 / 📖 目录 / 下一章 →」） */
    function findNavLink(word) {
      var links = document.querySelectorAll('.chapter-nav a');
      for (var i = 0; i < links.length; i++) {
        if (links[i].textContent.indexOf(word) >= 0) { return links[i].href; }
      }
      return null;
    }
    function findNextUrl() { return findNavLink('下一章'); }
    function onChapterEnd() {
      playing = false;
      paused = false;
      releaseWakeLock();
      updatePlayBtn();
      if (!spokenOnce) {
        /* 自动开播被浏览器手势策略拦截（语音被静默丢弃）：不跳章，提示手动点击 */
        currentIndex = -1;
        markReading(-1);
        showHint('浏览器要求手势触发：请点击 ▶ 播放开始朗读');
        updateProgress();
        return;
      }
      /* 「本章结束」档在此消耗：必须抢在连读跳章之前，否则连读会把本次定时带进下一章。
         位置放在 spokenOnce 判定之后——自动开播被手势策略拦下时本章一个字没读，不该把档耗掉。 */
      if (sleepAtChapterEnd) {
        disarmChapterEndSleep();
        updateProgress('定时关闭：本章读完，已停止朗读');
        if (isLearnMode()) { setTimeout(startQuiz, 500); }
        return;
      }
      if (autoEl.classList.contains('active')) {
        var url = findNextUrl();
        if (url) { location.href = url + (url.indexOf('?') >= 0 ? '&' : '?') + 'autoplay=1'; return; }
        updateProgress('已是最后一章，朗读完成');
        if (isLearnMode()) { setTimeout(startQuiz, 500); }
        return;
      }
      updateProgress('本章朗读完成');
      if (isLearnMode()) { setTimeout(startQuiz, 500); }
    }
    function speakSentence(idx) {
      /* 到点后每句入口都不再出声：比只靠 setTimeout 可靠（后台节流下定时器会迟到） */
      if (sleepExpired()) { fireSleep(); return; }
      if (idx < 0) { idx = 0; }
      if (idx >= sentences.length) { onChapterEnd(); return; }
      /* 引擎分发：语音版走音频合成，网页版走浏览器 TTS */
      if (ttsEngine === 'audio') { speakSentenceAudio(idx); return; }
      ensureVoicesReady();
      currentIndex = idx;
      playing = true;
      paused = false;
      requestWakeLock();
      seq++;
      synth.cancel();
      markReading(idx);
      updateProgress();
      updatePlayBtn();
      var u = new SpeechSynthesisUtterance(sentences[idx].textContent);
      var v = selectedVoice();
      if (v) { u.voice = v; u.lang = v.lang; } else { u.lang = 'zh-CN'; }
      u.rate = parseFloat(rateEl.value) || 1;
      var mySeq = seq;
      u.onstart = function () { spokenOnce = true; };
      u.onend = function () {
        /* paused 守卫：部分浏览器 pause 后会提前抛 end，不守卫会静默跳到下一句 */
        if (playing && !paused && mySeq === seq) { speakSentence(currentIndex + 1); }
      };
      u.onerror = function () {
        if (playing && mySeq === seq) {
          playing = false;
          paused = false;
          releaseWakeLock();
          updatePlayBtn();
          showHint('朗读中断：语音服务不可用，可尝试切换音色');
        }
      };
      synth.speak(u);
    }

    /* 语音版：从服务端合成 mp3 并播放 */
    function speakSentenceAudio(idx) {
      if (idx < 0) { idx = 0; }
      if (idx >= sentences.length) { onChapterEnd(); return; }
      currentIndex = idx;
      playing = true;
      paused = false;
      requestWakeLock();
      seq++;
      markReading(idx);
      updateProgress();
      updatePlayBtn();
      var mySeq = seq;
      var text = sentences[idx].textContent;
      /* 音色映射：浏览器 voiceName -> Edge voice */
      var voiceMap = {
        'zh-CN-YunxiNeural': 'zh-CN-YunxiNeural',
        'zh-CN-XiaoxiaoNeural': 'zh-CN-XiaoxiaoNeural',
        'zh-CN-YunjianNeural': 'zh-CN-YunjianNeural',
        'zh-TW-YunHsiaoNeural': 'zh-TW-YunHsiaoNeural'
      };
      var voiceName = voiceMap[voiceSel.value] || 'zh-CN-YunxiNeural';
      var rateMap = { '0.7': '-20%', '1': '+30%', '1.5': '+50%' };
      var rateStr = rateMap[rateEl.value] || '+30%';
      var chapterUrl = window.location.pathname;
      fetch('/novel/api/tts/sentence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chapterUrl: chapterUrl, text: text, voice: voiceName, rate: rateStr })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (mySeq !== seq) { return; } /* 已切走，作废 */
        if (!data.ok || !data.audioPath) {
          /* 合成失败，自动回落到浏览器 TTS */
          showHint('语音版合成失败，回落到网页版');
          switchEngine('browser');
          speakSentence(idx);
          return;
        }
        spokenOnce = true;
        if (!audioEl) {
          audioEl = new Audio();
          audioEl.addEventListener('ended', function () {
            if (playing && !paused && mySeq === seq) { speakSentence(currentIndex + 1); }
          });
          audioEl.addEventListener('error', function () {
            if (playing && mySeq === seq) {
              playing = false;
              paused = false;
              releaseWakeLock();
              updatePlayBtn();
              showHint('音频播放中断');
            }
          });
        }
        currentAudioUrl = data.audioPath;
        audioEl.src = currentAudioUrl;
        audioEl.play().catch(function () {
          if (mySeq === seq) { showHint('音频播放被浏览器拦截（需手势触发）'); }
        });
        setupMediaSession();
      }).catch(function (err) {
        if (mySeq === seq) {
          showHint('语音版请求失败：' + err.message);
          switchEngine('browser');
          speakSentence(idx);
        }
      });
    }

    /* Media Session：锁屏/蓝牙耳机控件 */
    function setupMediaSession() {
      if (!('mediaSession' in navigator)) { return; }
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: document.title || '小说朗读',
          artist: 'ainovel',
          album: '阅读模式'
        });
        navigator.mediaSession.setActionHandler('play', function () {
          if (ttsEngine === 'audio' && audioEl) { audioEl.play(); }
          else if (!paused) { synth.resume(); }
        });
        navigator.mediaSession.setActionHandler('pause', function () {
          if (ttsEngine === 'audio' && audioEl) { audioEl.pause(); }
          else { synth.pause(); }
          paused = true;
          updatePlayBtn();
        });
        navigator.mediaSession.setActionHandler('previoustrack', function () {
          if (currentIndex > 0) { speakSentence(currentIndex - 1); }
        });
        navigator.mediaSession.setActionHandler('nexttrack', function () {
          speakSentence(currentIndex + 1);
        });
        navigator.mediaSession.setActionHandler('seekto', function (details) {
          if (ttsEngine === 'audio' && audioEl && details.seekTime != null) {
            audioEl.currentTime = details.seekTime;
          }
        });
      } catch (e) { /* 部分浏览器不支持 Media Session，静默忽略 */ }
    }

    /* 切换引擎 */
    function switchEngine(engine) {
      if (engine === ttsEngine) { return; }
      /* 停止当前播放 */
      if (playing) {
        if (ttsEngine === 'audio' && audioEl) { audioEl.pause(); audioEl.src = ''; }
        else { synth.cancel(); }
        playing = false;
        paused = false;
        releaseWakeLock();
        updatePlayBtn();
      }
      ttsEngine = engine;
      localStorage.setItem('ttsEngine', engine);
      var btn = document.getElementById('ttsEngine');
      var hint = document.getElementById('ttsEngineHint');
      if (engine === 'audio') {
        btn.textContent = '🎵 语音版';
        hint.textContent = '服务端 mp3，息屏有声（需网络）';
      } else {
        btn.textContent = '🌐 网页版';
        hint.textContent = '浏览器 TTS，息屏可能无声';
      }
    }

    /* ===== 4. 控件绑定 ===== */
    playBtn.addEventListener('click', function () {
      if (playing) {
        if (paused) {
          synth.resume();
          paused = false;
          /* 少数浏览器 pause 后 utterance 已被丢弃，resume 无效 → 重读当前句，不丢进度 */
          if (!synth.speaking && !synth.pending) { speakSentence(currentIndex); }
        } else {
          synth.pause();
          paused = true;
        }
        updatePlayBtn();
      } else {
        speakSentence(currentIndex < 0 ? 0 : currentIndex + 1);
      }
    });
    /* 从头开始：确认后重置到第 0 句 */
    restartBtn.addEventListener('click', function () {
      if (sentences.length === 0) { return; }
      if (!confirm('确定要从头开始朗读吗？')) { return; }
      synth.cancel();
      playing = false;
      paused = false;
      releaseWakeLock();
      seq++;
      currentIndex = -1;
      for (var i = 0; i < sentences.length; i++) {
        sentences[i].classList.remove('reading');
        sentences[i].classList.remove('read');
      }
      updateProgress();
      updatePlayBtn();
      speakSentence(0);
    });
    /* 进度条拖动：跳转到对应句子 */
    progressBar.addEventListener('input', function () {
      if (sentences.length === 0) { return; }
      var pct = parseInt(progressBar.value, 10);
      var idx = Math.round((pct / 100) * (sentences.length - 1));
      if (idx < 0) { idx = 0; }
      if (idx >= sentences.length) { idx = sentences.length - 1; }
      /* 拖动时暂停朗读，避免冲突 */
      synth.cancel();
      playing = false;
      paused = false;
      releaseWakeLock();
      updatePlayBtn();
      /* 清除旧高亮 */
      for (var i = 0; i < sentences.length; i++) {
        sentences[i].classList.remove('reading');
        sentences[i].classList.remove('read');
      }
      /* 标记已读句子 */
      for (var j = 0; j < idx; j++) {
        sentences[j].classList.add('read');
      }
      currentIndex = idx;
      sentences[idx].classList.add('reading');
      progressText.textContent = (idx + 1) + '/' + sentences.length;
      try { sentences[idx].scrollIntoView({ block: 'center' }); } catch (e) {}
    });

    /* 双击（桌面）/ 长按500ms（移动端）从该句开始朗读 */
    function findSentence(el) {
      var t = el;
      while (t && t !== content && !(t.classList && t.classList.contains('tts-sentence'))) { t = t.parentNode; }
      if (!t || t === content || !t.classList || !t.classList.contains('tts-sentence')) { return null; }
      if (t.parentNode && t.parentNode.tagName === 'A') { return null; }
      return t;
    }
    content.addEventListener('dblclick', function (e) {
      /* 加粗词已由单击负责讲解，不再叠加一次整句讲解 */
      if (e.target && e.target.closest && e.target.closest('.tts-word')) { return; }
      var t = findSentence(e.target);
      if (t) { triggerSentence(t); }
    });
    var longPressTimer = null;
    /* 长按已按整句讲解，随后浏览器补发的 click 不该再走一次点词查询 */
    var longPressFired = false;
    content.addEventListener('touchstart', function (e) {
      longPressFired = false;
      var t = findSentence(e.target);
      if (!t) { return; }
      longPressTimer = setTimeout(function () {
        longPressFired = true;
        triggerSentence(t);
      }, 500);
    }, { passive: true });
    content.addEventListener('touchend', function () { clearTimeout(longPressTimer); });
    content.addEventListener('touchmove', function () { clearTimeout(longPressTimer); });

    /* 学习模式开→词汇讲解；关→从该句朗读 */
    function triggerSentence(t) {
      if (isLearnMode()) { explainSentence(t.textContent); }
      else { speakSentence(sentences.indexOf(t)); }
    }

    /* ===== 4b. 翻阅手势：左右滑动切章（触屏）+ 方向键切章（桌面） ===== */
    /* 语义与纸书一致：手指向左移 → 下一章，向右移 → 上一章。同一手势在桌面端
       由 ← / → 承担。
       为避免和正文纵向滚动、长按朗读、系统边缘返回手势抢焦点，判定刻意保守：
       起手先比位移方向，水平主导（|dx| ≥ |dy|×1.6）才认领该手势，之后一路只做
       提示不做拦截（监听全程 passive，滚动不被打断）；松手时还要位移达标
       （≥56px）且是一次快划（≤900ms）才真的翻页，慢拖/短划一律取消。
       无上一章/下一章链接的页面（如目录页）整段不启用。 */
    var SWIPE_MIN_X = 56;
    var SWIPE_RATIO = 1.6;
    var SWIPE_MAX_MS = 900;
    var navTargets = { prev: findNavLink('上一章'), next: findNavLink('下一章') };
    var swipeHint = document.createElement('div');
    swipeHint.className = 'swipe-hint';
    swipeHint.style.display = 'none';
    document.body.appendChild(swipeHint);
    var hintTimer = null;

    /* dir 为 'next'/'prev' 时显示方向提示；不可翻的方向不提示（松手会给出到位反馈） */
    function setSwipeHint(dir) {
      clearTimeout(hintTimer);
      if (!dir || !navTargets[dir]) { swipeHint.style.display = 'none'; return; }
      swipeHint.className = 'swipe-hint ' + (dir === 'next' ? 'hint-right' : 'hint-left');
      swipeHint.textContent = dir === 'next' ? '下一章 →' : '← 上一章';
      swipeHint.style.display = '';
    }
    /* 已达首/末章、标注进展这类瞬时说明：复用提示元素，ms 过后自动收起；ms=0 则常驻至下次调用 */
    function flashTip(msg, ms) {
      clearTimeout(hintTimer);
      swipeHint.className = 'swipe-hint tip';
      swipeHint.textContent = msg;
      swipeHint.style.display = '';
      var hold = ms === undefined ? 1200 : ms;
      if (hold > 0) { hintTimer = setTimeout(function () { swipeHint.style.display = 'none'; }, hold); }
    }
    function goChapter(url) {
      if (!url) { return; }
      /* 「本章结束」只对设定时所处的那一章有效：手动翻章说明读者还在听，
         不该被上一章的设定卡在新章末尾，故此处撤档（分钟档跨章继续，由 sessionStorage 接上） */
      if (sleepAtChapterEnd) { disarmChapterEndSleep(); }
      /* 翻章前收尾朗读：离开本页后语音合成与屏幕常亮都不该继续占用 */
      synth.cancel();
      playing = false;
      paused = false;
      releaseWakeLock();
      updatePlayBtn();
      location.href = url;
    }
    /* 控件区与可点元素内的触摸交给原交互，不起算翻页手势 */
    function gestureBlocked(target) {
      return !!(target && target.closest && target.closest(
        '.reader-toolbar, .tts-panel, .chapter-panel, .ai-panel, .settings-panel, .explain-panel, .quiz-panel, a, button, input, select, textarea'
      ));
    }

    if (navTargets.prev || navTargets.next) {
      /* axis: '' 未判定 / 'h' 水平翻页 / 'v' 判定为滚动，本手势作废 */
      var touch0 = null;

      document.addEventListener('touchstart', function (e) {
        setSwipeHint('');
        var t = e.touches[0];
        /* 左缘 24px 内起手属于系统返回手势区，不接管 */
        if (e.touches.length !== 1 || gestureBlocked(e.target) || t.clientX <= 24) { touch0 = null; return; }
        touch0 = { x: t.clientX, y: t.clientY, t: Date.now(), axis: '' };
      }, { passive: true });

      document.addEventListener('touchmove', function (e) {
        if (!touch0) { return; }
        var t = e.touches[0];
        var dx = t.clientX - touch0.x;
        var dy = t.clientY - touch0.y;
        if (!touch0.axis) {
          if (Math.abs(dx) < 12 && Math.abs(dy) < 12) { return; } /* 位移太小还判不出方向 */
          touch0.axis = Math.abs(dx) >= Math.abs(dy) * SWIPE_RATIO ? 'h' : 'v';
        }
        if (touch0.axis !== 'h') { touch0 = null; return; }
        setSwipeHint(dx < 0 ? 'next' : 'prev');
      }, { passive: true });

      document.addEventListener('touchend', function (e) {
        if (!touch0) { return; }
        var t = e.changedTouches[0];
        var dx = t ? t.clientX - touch0.x : 0;
        var swiped = touch0.axis === 'h' && Date.now() - touch0.t <= SWIPE_MAX_MS && Math.abs(dx) >= SWIPE_MIN_X;
        var dir = dx < 0 ? 'next' : 'prev';
        touch0 = null;
        setSwipeHint('');
        if (!swiped) { return; }
        if (navTargets[dir]) { goChapter(navTargets[dir]); }
        else { flashTip(dir === 'next' ? '已是最后一章' : '已是第一章'); }
      }, { passive: true });

      document.addEventListener('touchcancel', function () { touch0 = null; setSwipeHint(''); }, { passive: true });

      document.addEventListener('keydown', function (e) {
        if (e.metaKey || e.ctrlKey || e.altKey) { return; }
        var tag = e.target && e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { return; } /* 输入时方向键归光标 */
        if (e.key === 'ArrowLeft') { goChapter(navTargets.prev); }
        else if (e.key === 'ArrowRight') { goChapter(navTargets.next); }
      });
    }

    /* ===== 5. 音色与偏好（localStorage 持久化） ===== */
    function loadVoices() {
      var voices = synth.getVoices();
      if (!voices.length) { return; }
      /* 只保留指定的四种语音：MeiJia、TingTing、Google 普通话、Google 台湾 */
      var wanted = [
        { key: 'meijia', match: function (v) { return /meijia/i.test(v.name); } },
        { key: 'tingting', match: function (v) { return /tingting/i.test(v.name); } },
        { key: 'google_zh_CN', match: function (v) { return /google/i.test(v.name) && /zh[-_]?CN/i.test(v.lang); } },
        { key: 'google_zh_TW', match: function (v) { return /google/i.test(v.name) && /zh[-_]?TW/i.test(v.lang); } }
      ];
      var list = [];
      for (var w = 0; w < wanted.length; w++) {
        for (var i = 0; i < voices.length; i++) {
          if (wanted[w].match(voices[i])) {
            list.push(voices[i]);
            break;
          }
        }
      }
      if (!list.length) { list = voices; } /* 都没匹配到则回退到全部 */
      var saved = '';
      try { saved = localStorage.getItem('ttsVoiceName') || ''; } catch (e2) {}
      voiceSel.innerHTML = '';
      for (var i = 0; i < list.length; i++) {
        var o = document.createElement('option');
        o.value = list[i].name;
        o.textContent = list[i].name + ' (' + list[i].lang + ')';
        voiceSel.appendChild(o);
      }
      var match = false;
      for (var j = 0; j < list.length; j++) { if (list[j].name === saved) { match = true; } }
      voiceSel.value = match ? saved : list[0].name;
    }
    loadVoices();
    ensureVoicesReady();
    synth.onvoiceschanged = function () { voicesReady = true; loadVoices(); };
    try {
      var savedRate = localStorage.getItem('ttsRate');
      if (savedRate) { rateEl.value = savedRate; }
      if (localStorage.getItem('ttsAutoNext') === '1') { autoEl.classList.add('active'); }
    } catch (e3) {}
    rateEl.addEventListener('change', function () { try { localStorage.setItem('ttsRate', rateEl.value); } catch (e4) {} });
    voiceSel.addEventListener('change', function () { try { localStorage.setItem('ttsVoiceName', voiceSel.value); } catch (e5) {} });
    autoEl.addEventListener('click', function () {
      autoEl.classList.toggle('active');
      try { localStorage.setItem('ttsAutoNext', autoEl.classList.contains('active') ? '1' : '0'); } catch (e6) {}
    });

    /* 屏幕常亮偏好：默认息屏省电（省电优先，出声由静音保活顶住），
       要锁屏得主动开成常亮；一次选定长期生效，连读跳章换页也不会变。
       只认 '1'：无记录与历史上存下的 '0' 同义（都回到省电默认）。 */
    function updateScreenBtn() {
      screenBtn.textContent = keepScreenOn ? '☀ 屏幕常亮' : '🌙 息屏省电';
      screenBtn.classList.toggle('active', keepScreenOn);
    }
    try {
      if (localStorage.getItem('ttsKeepScreenOn') === '1') { keepScreenOn = true; }
    } catch (eScr) {}
    updateScreenBtn();
    screenBtn.addEventListener('click', function () {
      keepScreenOn = !keepScreenOn;
      try { localStorage.setItem('ttsKeepScreenOn', keepScreenOn ? '1' : '0'); } catch (eScr2) {}
      updateScreenBtn();
      /* 两个方向都得当场见效：关常亮要立刻放锁（否则屏幕一直被上一句钉住），
         开常亮要在朗读中立刻补锁。 */
      if (keepScreenOn) { if (playing) { requestWakeLock(); } }
      else { releaseWakeLock(); }
      flashTip(keepScreenOn ? '☀ 朗读时屏幕保持常亮' : '🌙 息屏省电：屏幕会熄灭，只保留声音');
    });

    /* 引擎偏好 */
    var engineBtn = document.getElementById('ttsEngine');
    var engineHint = document.getElementById('ttsEngineHint');
    try {
      var savedEngine = localStorage.getItem('ttsEngine');
      if (savedEngine === 'audio' || savedEngine === 'browser') { ttsEngine = savedEngine; }
    } catch (eEng) {}
    if (ttsEngine === 'audio') {
      engineBtn.textContent = '🎵 语音版';
      engineHint.textContent = '服务端 mp3，息屏有声（需网络）';
    }
    engineBtn.addEventListener('click', function () {
      switchEngine(ttsEngine === 'browser' ? 'audio' : 'browser');
    });

    /* 生成全章音频（语音版专用） */
    var genBtn = document.getElementById('ttsGenChapter');
    genBtn.addEventListener('click', function () {
      if (ttsEngine !== 'audio') {
        showHint('请先切换到语音版再生成全章音频');
        return;
      }
      var voiceMap = { 'zh-CN-YunxiNeural': 'zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural': 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural': 'zh-CN-YunjianNeural', 'zh-TW-YunHsiaoNeural': 'zh-TW-YunHsiaoNeural' };
      var voiceName = voiceMap[voiceSel.value] || 'zh-CN-YunxiNeural';
      var rateMap = { '0.7': '-20%', '1': '+30%', '1.5': '+50%' };
      var rateStr = rateMap[rateEl.value] || '+30%';
      var chapterUrl = window.location.pathname;
      var total = sentences.length;
      var done = 0;
      var failed = 0;
      genBtn.disabled = true;
      genBtn.textContent = '⏳ 生成中...';
      showHint('开始生成全章音频（0/' + total + '）');
      function genNext(idx) {
        if (idx >= total) {
          genBtn.disabled = false;
          genBtn.textContent = '📥 生成全章';
          showHint('全章音频生成完成：' + done + ' 成功，' + failed + ' 失败');
          return;
        }
        var text = sentences[idx].textContent;
        fetch('/novel/api/tts/sentence', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chapterUrl: chapterUrl, text: text, voice: voiceName, rate: rateStr })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (data.ok) { done++; } else { failed++; }
          showHint('生成中（' + (done + failed) + '/' + total + '）');
          setTimeout(function () { genNext(idx + 1); }, 100); /* 间隔 100ms 避免压垮服务端 */
        }).catch(function () {
          failed++;
          showHint('生成中（' + (done + failed) + '/' + total + '）');
          setTimeout(function () { genNext(idx + 1); }, 100);
        });
      }
      genNext(0);
    });

    /* 定时关闭：分钟档选中即重新计时，「本章结束」挂章节档，选「不定时」即取消 */
    sleepSel.addEventListener('change', function () {
      var v = sleepSel.value;
      if (v === 'end') { armChapterEndSleep(); return; }
      armSleep(parseInt(v, 10) || 0);
    });
    /* 连读跳章会重载页面，未走完的定时必须接上（存的是绝对时间戳，不会因此续命） */
    try {
      var savedSleep = (sessionStorage.getItem('ttsSleepDeadline') || '').split('|');
      var savedMins = parseInt(savedSleep[0], 10) || 0;
      var savedDeadline = parseInt(savedSleep[1], 10) || 0;
      if (savedSleep[0] === 'end') {
        /* 刷新本页时接上章节档；手动翻章已在 goChapter 撤档，不会带到新章 */
        sleepAtChapterEnd = true;
        sleepSel.value = 'end';
        sleepLeftEl.textContent = '⏱ 本章末';
      } else if (savedDeadline > Date.now() && sleepSel.querySelector('option[value="' + savedMins + '"]')) {
        sleepDeadline = savedDeadline;
        sleepSel.value = String(savedMins);
        scheduleSleep();
      } else if (savedDeadline) {
        clearSleep(); /* 定时已在换页间走完 */
      }
    } catch (eSl) {}

    /* ===== 6. 面板开合与连读自动开播 ===== */
    /* 面板弹起时整个工具栏隐藏（底部面板本就占住右下角），由各面板的 ✕ 负责还原 */
    function openPanel() { panel.classList.add('open'); toolbar.style.display = 'none'; }
    function closePanel() { panel.classList.remove('open'); toolbar.style.display = ''; collapseToolbar(); }
    fab.addEventListener('click', openPanel);
    chapterBtn.addEventListener('click', function () {
      var isOpen = chapterPanel.classList.toggle('open');
      toolbar.style.display = isOpen ? 'none' : '';
    });
    chapterPanelClose.addEventListener('click', function () {
      chapterPanel.classList.remove('open');
      toolbar.style.display = '';
    });
    closeIconBtn.addEventListener('click', closePanel);

    /* ===== 7. AI 问答面板 ===== */
    aiFab.addEventListener('click', function () {
      aiPanel.classList.add('open');
      toolbar.style.display = 'none';
    });
    aiPanelClose.addEventListener('click', function () {
      aiPanel.classList.remove('open');
      toolbar.style.display = '';
    });

    /* 获取当前章节内容作为上下文 */
    function getChapterContent() {
      var article = document.querySelector('article');
      if (article) { return article.innerText; }
      var content = document.querySelector('.content');
      if (content) { return content.innerText; }
      return document.body.innerText;
    }

    /* 阅读器 AI：统一走服务端代理（密钥不外泄、同源可达、服务端缓存 + 限并发 + 限流） */
    function apiPost(path, body) {
      if (APP_BASE === null) { throw new Error('无法判定站点前缀（reader.core.js 未经 reader.js 加载）'); }
      return fetch(APP_BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {})
      }).then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          if (!res.ok) { throw new Error((j && j.error) || ('HTTP ' + res.status)); }
          return j;
        });
      });
    }
    /* 读取发布时内嵌的预生成数据（章节测试等） */
    function preloadReaderData() {
      var el = document.getElementById('novel-reader-data');
      if (!el) return null;
      try { return JSON.parse(el.textContent); } catch (e) { return null; }
    }

    /* 添加消息到聊天窗口 */
    function addMessage(role, text) {
      var msg = document.createElement('div');
      msg.className = 'ai-message ai-message-' + role;
      msg.textContent = text;
      aiMessages.appendChild(msg);
      aiMessages.scrollTop = aiMessages.scrollHeight;
    }

    /* 发送问题 */
    function sendQuestion() {
      var question = aiInput.value.trim();
      if (!question) { return; }
      addMessage('user', question);
      aiInput.value = '';
      aiSendBtn.disabled = true;
      aiSendBtn.textContent = '...';

      var chapterContent = getChapterContent();
      apiPost('/api/reader/ask', { question: question, document: chapterContent })
      .then(function (data) {
        addMessage('ai', data.answer || '（无回答）');
      })
      .catch(function (err) {
        addMessage('ai', '错误：' + err.message);
      })
      .finally(function () {
        aiSendBtn.disabled = false;
        aiSendBtn.textContent = '发送';
      });
    }

    aiSendBtn.addEventListener('click', sendQuestion);
    aiInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter') { sendQuestion(); }
    });

    /* ===== 语音输入 ===== */
    var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    var recognition = null;
    var isListening = false;
    /* 语音识别需要安全上下文（HTTPS 或 localhost） */
    var isSecureContext = window.isSecureContext || location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (SpeechRecognition && isSecureContext) {
      recognition = new SpeechRecognition();
      recognition.lang = 'zh-CN';
      recognition.continuous = false;
      recognition.interimResults = true;

      recognition.onstart = function () {
        isListening = true;
        aiMicBtn.classList.add('listening');
        aiMicBtn.textContent = '🔴';
      };
      recognition.onresult = function (e) {
        var transcript = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          transcript += e.results[i][0].transcript;
        }
        aiInput.value = transcript;
      };
      recognition.onend = function () {
        isListening = false;
        aiMicBtn.classList.remove('listening');
        aiMicBtn.textContent = '🎤';
      };
      recognition.onerror = function (e) {
        isListening = false;
        aiMicBtn.classList.remove('listening');
        aiMicBtn.textContent = '🎤';
        if (e.error !== 'no-speech') {
          console.warn('语音识别错误:', e.error);
        }
      };
    } else {
      aiMicBtn.style.display = 'none';
    }

    aiMicBtn.addEventListener('click', function () {
      if (!recognition) { return; }
      if (isListening) {
        recognition.stop();
      } else {
        try { recognition.start(); } catch (e) {}
      }
    });

    /* ===== 8. 学习模式：设置 / 词汇讲解 / 章节测试 ===== */
    function getLearnSetting(key, def) {
      try { return localStorage.getItem(key) || def; } catch (e) { return def; }
    }
    function setLearnSetting(key, val) {
      try { localStorage.setItem(key, val); } catch (e) {}
    }
    function isLearnMode() { return getLearnSetting('learnMode', '0') === '1'; }
    function learnLang() { return getLearnSetting('learnLang', '日语'); }
    function learnAge() { return getLearnSetting('learnAge', '9'); }

    function refreshLearnModeBtn() {
      if (isLearnMode()) { learnModeBtn.classList.add('active'); learnModeBtn.textContent = '🟢'; }
      else { learnModeBtn.classList.remove('active'); learnModeBtn.textContent = '⚪'; }
    }
    function refreshAutoBtn() {
      var on = isAutoExplain();
      autoExplainBtn.classList.toggle('active', on);
      autoExplainBtn.textContent = on ? '🟢' : '⚪';
    }

    /* 设置面板开合 */
    settingsFab.addEventListener('click', function () {
      settingsPanel.classList.add('open');
      toolbar.style.display = 'none';
      refreshLearnModeBtn();
      refreshAutoBtn();
      learnLangSel.value = learnLang();
      learnAgeSel.value = learnAge();
    });
    settingsPanelClose.addEventListener('click', function () {
      settingsPanel.classList.remove('open');
      toolbar.style.display = '';
    });
    learnModeBtn.addEventListener('click', function () {
      setLearnSetting('learnMode', isLearnMode() ? '0' : '1');
      refreshLearnModeBtn();
      /* 标注跟着模式走：开列拉词表上粗体，关则恢复纯文本，不留无意义的标记 */
      if (isLearnMode()) { applyVocab(); } else { clearWordMarks(); }
    });
    /* 自动生成词义开关：开启即对当前章缺失词补生成并落库；关闭则后台批次自行停止 */
    autoExplainBtn.addEventListener('click', function () {
      setLearnSetting('autoExplain', isAutoExplain() ? '0' : '1');
      refreshAutoBtn();
      if (isAutoExplain() && isLearnMode()) { var ws = vocabCache[learnAge()]; if (ws) { autoGenerate(ws); } }
    });
    /* 讲解语言只影响讲解文本的语种，词表只跟年龄有关，切语言不必重标 */
    learnLangSel.addEventListener('change', function () {
      setLearnSetting('learnLang', learnLangSel.value);
      /* 词义按 (词,年龄,语言) 分档：切语言后重查状态，让黑/灰跟着新语言走 */
      if (isLearnMode() && vocabCache[learnAge()]) { refreshWordStatus(vocabCache[learnAge()]); }
    });
    learnAgeSel.addEventListener('change', function () {
      setLearnSetting('learnAge', learnAgeSel.value);
      if (isLearnMode()) { applyVocab(); }
    });

    /* 词汇讲解 */
    explainPanelClose.addEventListener('click', function () {
      explainPanel.classList.remove('open');
      toolbar.style.display = '';
    });
    function explainSentence(sentenceText) {
      explainBody.textContent = '加载中...';
      explainPanel.classList.add('open');
      toolbar.style.display = 'none';
      apiPost('/api/reader/explain', { sentence: sentenceText, age: learnAge(), lang: learnLang() })
        .then(function (data) { explainBody.textContent = data.explanation || '（无讲解）'; })
        .catch(function (err) { explainBody.textContent = '讲解失败：' + err.message; });
    }

    /* ===== 8a-bis. 单词讲解（按词持久缓存）：点词秒显、状态着色、可选自动生成 ===== */
    var explainDone = {};        /* word -> true，当前(年龄,语言)下已有讲解的词，用于黑/灰着色 */
    var autoRunning = false;     /* 自动生成互斥锁：服务端已有并发上限，这里再防同章重复触发 */

    function isAutoExplain() { return getLearnSetting('autoExplain', '0') === '1'; }
    function setWordDone(el, done) { if (!el) { return; } el.classList.toggle('done', !!done); el.classList.toggle('pending', !done); }
    function applyWordColors() {
      var els = content.querySelectorAll('.tts-word');
      for (var i = 0; i < els.length; i++) { setWordDone(els[i], !!explainDone[els[i].textContent]); }
    }
    function recordWordDone(w) { if (w) { explainDone[w] = true; applyWordColors(); } }

    /* 点词：走 (词+年龄+语言) 口径端点，命中库即秒显；原句只作语境。成功后把该词转黑并记账 */
    function explainWord(word, context, doneEl) {
      var w = String(word || '').trim();
      if (!w) { return; }
      explainBody.textContent = '加载中...';
      explainPanel.classList.add('open');
      toolbar.style.display = 'none';
      apiPost('/api/reader/explain-word', { word: w, age: learnAge(), lang: learnLang(), context: context || '' })
        .then(function (data) {
          explainBody.textContent = data.explanation || '（无讲解）';
          recordWordDone(w);
          if (doneEl) { setWordDone(doneEl, true); }
        })
        .catch(function (err) { explainBody.textContent = '讲解失败：' + err.message; });
    }

    /* 标注后拉一次状态：已有讲解的词点亮成黑体；开了自动生成则接着把灰体补齐 */
    function refreshWordStatus(words) {
      explainDone = {};                       /* 换章/换年龄/换语言都要按新口径重算，先清空 */
      if (!words || !words.length) { return; }
      apiPost('/api/reader/word-status', { words: words, age: learnAge(), lang: learnLang() })
        .then(function (data) {
          (data.have || []).forEach(function (w) { explainDone[w] = true; });
          applyWordColors();
          if (isAutoExplain()) { autoGenerate(words); }
        })
        .catch(function () { if (isAutoExplain()) { autoGenerate(words); } });
    }

    /* 自动生成：单并发依次补齐缺失词义（温和对待单点推理服务），边生成边转黑，落库后全站复用 */
    function autoGenerate(words) {
      if (autoRunning || !isLearnMode() || !isAutoExplain()) { return; }
      autoRunning = true;
      var pending = (words || []).filter(function (w) { return !explainDone[w]; });
      if (!pending.length) { autoRunning = false; flashTip('本章词义已全部生成（' + words.length + '/' + words.length + ' 命中缓存）', 2500); return; }
      var ctx = String(getChapterContent() || '').slice(0, 200);
      var i = 0;
      /* 先说清判断结果：已生成多少（跳过）、还差多少（要补），避免看着像从头跑 */
      flashTip('已生成 ' + (words.length - pending.length) + '/' + words.length + '，补齐剩余 ' + pending.length + ' 个… 0/' + pending.length, 0);
      (function next() {
        if (!isLearnMode() || !isAutoExplain()) { autoRunning = false; setSwipeHint(''); return; }
        if (i >= pending.length) { autoRunning = false; flashTip('本章词义已生成完成 ✓', 2500); return; }
        var w = pending[i++];
        apiPost('/api/reader/explain-word', { word: w, age: learnAge(), lang: learnLang(), context: ctx })
          .then(function (data) { if (data && data.explanation) { explainDone[w] = true; applyWordColors(); } })
          .catch(function () { /* 单词失败不阻断整批 */ })
          .then(function () { flashTip('正在生成词义… ' + i + '/' + pending.length, 0); setTimeout(next, 250); });
      })();
    }

    /* ===== 8b. 生词标注：学习模式下把值得积累的词语加粗，读者一眼能认出可学的词 ===== */
    /* 哪些词“可学”取决于读者年龄，本地判不出来，只能由服务端按 (章节, 年龄) 挑取并缓存。
       标注只在 .tts-sentence 内部插 <b>，句子的 textContent 一字不变，
       因此逐句切分、进度跳转、朗读高亮均不受影响。 */
    var vocabCache = {};      /* age -> words，同一章内切年龄不重复回源 */
    var vocabApplied = null;  /* 当前涂到正文上的口径，用于丢弃迟到的旧响应 */

    /* 长词先占位：同一句里「红宝石」占了位，「宝石」就不能再切进去；返回实际标了多少处 */
    function markWords(words) {
      var marked = 0;
      var list = (words || []).slice().sort(function (a, b) { return b.length - a.length; });
      sentences.forEach(function (span) {
        var text = span.textContent;
        var taken = [];
        var hits = [];
        for (var w = 0; w < list.length; w++) {
          var word = list[w];
          if (!word) { continue; }
          var idx = text.indexOf(word);
          while (idx >= 0) {
            var clash = false;
            for (var p = idx; p < idx + word.length; p++) { if (taken[p]) { clash = true; break; } }
            if (!clash) {
              for (var q = idx; q < idx + word.length; q++) { taken[q] = true; }
              hits.push({ start: idx, end: idx + word.length });
            }
            idx = text.indexOf(word, idx + 1);
          }
        }
        /* 本句无命中：若上一轮词表在这里标过，也要收拢回纯文本，不能残留旧粗体 */
        if (!hits.length) {
          if (span.querySelector('.tts-word')) { span.textContent = text; }
          return;
        }
        hits.sort(function (a, b) { return a.start - b.start; });
        marked += hits.length;
        var frag = document.createDocumentFragment();
        var cursor = 0;
        for (var i = 0; i < hits.length; i++) {
          if (hits[i].start > cursor) { frag.appendChild(document.createTextNode(text.slice(cursor, hits[i].start))); }
          var b = document.createElement('b');
          b.className = 'tts-word ' + (explainDone[text.slice(hits[i].start, hits[i].end)] ? 'done' : 'pending');
          b.textContent = text.slice(hits[i].start, hits[i].end);
          frag.appendChild(b);
          cursor = hits[i].end;
        }
        if (cursor < text.length) { frag.appendChild(document.createTextNode(text.slice(cursor))); }
        span.textContent = '';
        span.appendChild(frag);
      });
      return marked;
    }
    function clearWordMarks() {
      vocabApplied = null;
      sentences.forEach(function (span) {
        if (span.querySelector('.tts-word')) { span.textContent = span.textContent; }
      });
    }
    /* 标注结果必须说得清：空词表、取到词但没匹配上、请求失败，四件事不能糊成“没反应”。
       instant=true 时粗体本身就是反馈，不再占居中气泡（开页就弹一条反而看着像出错） */
    function reportVocab(words, marked, instant) {
      if (marked > 0) { if (!instant) { flashTip('已标注 ' + marked + ' 处生词', 1800); } return; }
      if (!words.length) { flashTip('本章未挑出可标注的生词（候选均不在原文）', 5000); return; }
      flashTip('生词表已取到，但正文未匹配到', 5000);
    }
    /* 统一出口：把词标到正文 → 汇报进展 → 拉词义状态（黑/灰）+（若开启）自动生成 */
    function presentVocab(words, instant) {
      reportVocab(words, markWords(words), instant);
      refreshWordStatus(words);
    }
    function applyVocab() {
      var age = learnAge();
      vocabApplied = age;
      explainDone = {};
      /* 发布时已按默认年龄预生成并内嵌：直接用，零请求、开页即已标好 */
      var pre = preloadReaderData();
      if (pre && pre.vocab && String(pre.vocab.age) === String(age) && Array.isArray(pre.vocab.words)) {
        vocabCache[age] = pre.vocab.words;
        presentVocab(pre.vocab.words, true);
        return;
      }
      /* 本次会话里已经回源过同一年龄（切走又切回）：也不必再请求 */
      if (vocabCache[age]) { presentVocab(vocabCache[age], true); return; }
      /* 回源要几秒到几十秒（看服务端缓存命不命中、推理服务器忙不忙），进展提示得常驻到请求回来，
         不然提示 1.2s 就消失，读者只会觉得“点了没反应” */
      flashTip('正在标注生词…', 0);
      apiPost('/api/reader/vocab', { document: getChapterContent(), age: age })
        .then(function (data) {
          var words = Array.isArray(data.words) ? data.words : [];
          vocabCache[age] = words;
          /* 迟到响应守卫：口径已变（切了年龄）或已退出学习模式，就不往正文上涂了 */
          if (vocabApplied !== age || !isLearnMode()) { setSwipeHint(''); return; }
          presentVocab(words);
        })
        .catch(function (err) { flashTip('生词标注失败：' + err.message, 6000); });
    }

    /* 点加粗词即查该词（带原句上下文），比整句讲解更聚焦 */
    content.addEventListener('click', function (e) {
      if (!isLearnMode() || longPressFired) { return; }
      var w = e.target && e.target.closest ? e.target.closest('.tts-word') : null;
      if (!w || !content.contains(w)) { return; }
      var owner = w.closest('.tts-sentence');
      explainWord(w.textContent, owner ? owner.textContent : '', w);
    });

    /* 章节测试 */
    quizPanelClose.addEventListener('click', function () {
      quizPanel.classList.remove('open');
      toolbar.style.display = '';
    });
    var quizQuestions = [];
    var quizIndex = 0;
    var quizScore = 0;

    function parseQuizJSON(text) {
      /* 容错：提取第一个 [ ... ] 片段 */
      var start = text.indexOf('[');
      var end = text.lastIndexOf(']');
      if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch (e) {}
      }
      try { return JSON.parse(text); } catch (e) {}
      return null;
    }

    /* 本章此年龄档被读者主动换过题：记在本地，否则刷新后页面内嵌的旧题会盖掉他选的这套 */
    function quizRegenFlag(age) { return location.pathname + '|' + age; }
    function readRegenMap() {
      try { var m = JSON.parse(getLearnSetting('quizRegenPages', '{}')); return (m && typeof m === 'object') ? m : {}; } catch (e) { return {}; }
    }
    function isQuizRegenerated(age) { return !!readRegenMap()[quizRegenFlag(age)]; }
    function markQuizRegenerated(age) {
      var m = readRegenMap();
      if (Object.keys(m).length > 60) { m = {}; }   /* 只是“最近换过题”的便签，过大就重开，不和本地存储较真 */
      m[quizRegenFlag(age)] = 1;
      setLearnSetting('quizRegenPages', JSON.stringify(m));
    }

    /**
     * 打开本章小测试。
     * @param {boolean} [force] - 仅「换一组新题」按钮传 true：绕开缓存重新出题。
     *   调用方必须显式传值，别把 click 事件对象直接交进来（事件对象是 truthy，
     *   会变成“每次点开始答题都重新出题”，正是要避免的行为）。
     */
    function startQuiz(force) {
      force = force === true;
      quizPanel.classList.add('open');
      toolbar.style.display = 'none';
      var age = learnAge();
      var pre = preloadReaderData();
      /* 平时一律复用已生成的题：页面内嵌优先（零请求）；换过题的章节改走服务端持久缓存 */
      if (!force && !isQuizRegenerated(age) && pre && pre.quiz && String(pre.quiz.age) === String(age) && Array.isArray(pre.quiz.questions) && pre.quiz.questions.length) {
        quizQuestions = pre.quiz.questions; quizIndex = 0; quizScore = 0; renderQuizQuestion(); return;
      }
      quizBody.textContent = force ? '正在换一组新题…' : '正在出题...';
      apiPost('/api/reader/quiz', { document: getChapterContent(), age: age, force: force })
        .then(function (data) {
          var arr = data.questions;
          if (!arr || !arr.length) { quizBody.textContent = '出题失败：未返回题目'; return; }
          if (force) { markQuizRegenerated(age); }
          quizQuestions = arr; quizIndex = 0; quizScore = 0; renderQuizQuestion();
        })
        .catch(function (err) { quizBody.textContent = '出题失败：' + err.message; });
    }

    function renderQuizQuestion() {
      if (quizIndex >= quizQuestions.length) { renderQuizResult(); return; }
      var q = quizQuestions[quizIndex];
      quizTitle.textContent = '本章小测试 (' + (quizIndex + 1) + '/' + quizQuestions.length + ')';
      quizBody.innerHTML = '';
      var qEl = document.createElement('div');
      qEl.className = 'quiz-question';
      qEl.textContent = q.question;
      quizBody.appendChild(qEl);
      var letters = ['A', 'B', 'C'];
      for (var i = 0; i < (q.options || []).length; i++) {
        (function (idx) {
          var btn = document.createElement('button');
          btn.className = 'quiz-option';
          btn.textContent = letters[idx] + '. ' + q.options[idx];
          btn.addEventListener('click', function () { answerQuiz(idx, btn); });
          quizBody.appendChild(btn);
        })(i);
      }
    }

    function answerQuiz(idx, btn) {
      var q = quizQuestions[quizIndex];
      var letters = ['A', 'B', 'C'];
      var correctLetter = String(q.answer).trim().charAt(0).toUpperCase();
      var selectedLetter = letters[idx];
      var correctIdx = letters.indexOf(correctLetter);
      /* 如果 answer 不是字母，则按内容匹配 */
      if (correctIdx < 0) {
        for (var k = 0; k < (q.options || []).length; k++) {
          if (q.options[k] === q.answer) { correctIdx = k; break; }
        }
      }
      var isCorrect = idx === correctIdx;
      if (isCorrect) { quizScore++; btn.classList.add('correct'); }
      else {
        btn.classList.add('wrong');
        var opts = quizBody.querySelectorAll('.quiz-option');
        if (opts[correctIdx]) { opts[correctIdx].classList.add('correct'); }
      }
      /* 禁用所有选项 */
      var all = quizBody.querySelectorAll('.quiz-option');
      for (var m = 0; m < all.length; m++) { all[m].disabled = true; }
      /* 讲解 */
      var fb = document.createElement('div');
      fb.className = 'quiz-feedback';
      /* 判定结果先立刻落地：AI 讲解是锦上添花，不该让孩子对着一块“思考中”空等 */
      fb.textContent = isCorrect ? '回答正确 ✓' : ('答错了，正确答案是 ' + letters[correctIdx]);
      quizBody.appendChild(fb);
      var fbText = '题目：' + q.question + '\n孩子选了' + selectedLetter + '，正确答案是' + letters[correctIdx] + '。请用鼓励语气简短讲解。';
      apiPost('/api/reader/feedback', { text: fbText })
        .then(function (data) { if (data && data.feedback) { fb.textContent = data.feedback; } })
        .catch(function () { fb.textContent = isCorrect ? '回答正确！' : '正确答案是 ' + letters[correctIdx] + '。'; });
      /* 下一题按钮 */
      var next = document.createElement('button');
      next.className = 'ai-send-btn quiz-next';
      next.textContent = (quizIndex + 1 < quizQuestions.length) ? '下一题' : '查看结果';
      next.addEventListener('click', function () { quizIndex++; renderQuizQuestion(); });
      quizBody.appendChild(next);
    }

    function renderQuizResult() {
      quizTitle.textContent = '测试完成';
      quizBody.innerHTML = '';
      var total = quizQuestions.length;
      var res = document.createElement('div');
      res.className = 'quiz-result';
      var emoji = quizScore === total ? '🏆' : (quizScore >= total / 2 ? '🎉' : '💪');
      res.textContent = '得分：' + quizScore + '/' + total + ' ' + emoji;
      quizBody.appendChild(res);
      var msg = document.createElement('div');
      msg.className = 'quiz-feedback';
      msg.textContent = quizScore === total ? '太棒了！全对！' : (quizScore >= total / 2 ? '不错！继续加油！' : '没关系，再听一遍会更棒！');
      quizBody.appendChild(msg);
      var again = document.createElement('button');
      again.className = 'ai-send-btn quiz-next';
      again.textContent = '再测一次';
      again.addEventListener('click', function () { startQuiz(false); });   /* 同一套题重做，不再花一次生成 */
      quizBody.appendChild(again);
      var swap = document.createElement('button');
      swap.className = 'ai-send-btn quiz-next';
      swap.textContent = '换一组新题';
      swap.addEventListener('click', function () { startQuiz(true); });     /* 只有这里才强制重新出题 */
      quizBody.appendChild(swap);
    }

    quizFab.addEventListener('click', function () { startQuiz(false); });
    quizRegenerate.addEventListener('click', function () { startQuiz(true); });
    refreshLearnModeBtn();
    /* 学习模式本就是开启状态（偏好持久化）：进页即标注，不必等读者去设置里重开一次 */
    if (isLearnMode()) { applyVocab(); }

    updateProgress();
    var autoplay = '';
    try { autoplay = new URLSearchParams(location.search).get('autoplay') || ''; } catch (e7) {}
    if (autoplay === '1') {
      openPanel();
      /* 连读跳章时偏好已持久化，自动开播；无手势被拦截时降级为提示 */
      var blocked = navigator.userActivation && navigator.userActivation.hasBeenActive === false;
      if (blocked) {
        showHint('浏览器要求手势触发：请点击 ▶ 播放开始朗读');
      } else {
        setTimeout(function () { speakSentence(0); }, 300);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
