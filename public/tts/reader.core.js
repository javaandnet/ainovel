/**
 * 阅读模式（TTS）核心逻辑 —— 外部资源，不内联进章节页
 *
 * 由同目录 reader.js 带时间戳动态加载，因此修改本文件（或 reader.css）后立即对所有
 * 历史已发布页面生效：只需同步这一个文件到服务器，不需要重新发布任何小说章节。
 *
 * 能力：正文逐句切分 → speechSynthesis 逐句朗读 → 当前句高亮 + 自动滚动跟随
 *      → 读完本章自动跳下一章（?autoplay=1 自动开播）→ 语速/音色/连读偏好持久化
 */
(function () {
  'use strict';

  function boot() {
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
      '  <button class="toolbar-btn" id="chapterBtn" title="章节目录">📑</button>',
      '  <button class="toolbar-btn" id="ttsFab" title="朗读">🎧</button>',
      '  <button class="toolbar-btn" id="aiFab" title="AI 问答">🤖</button>',
      '  <button class="toolbar-btn" id="quizFab" title="本章测试">📝</button>',
      '  <button class="toolbar-btn" id="settingsFab" title="设置">⚙</button>',
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
      '      <label>学习语言</label>',
      '      <select id="learnLang" class="tts-rate-select">',
      '        <option value="英语" selected>英语</option>',
      '        <option value="日语">日语</option>',
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
      '    <button class="tts-icon-btn" id="quizPanelClose" title="关闭">✕</button>',
      '  </div>',
      '  <div class="quiz-body" id="quizBody">加载中...</div>',
      '</div>'
    ].join('\n');
    var pick = function (id) { return holder.querySelector('#' + id); };
    var fab = pick('ttsFab');
    var chapterBtn = pick('chapterBtn');
    var panel = pick('ttsPanel');
    var playBtn = pick('ttsPlay');
    var restartBtn = pick('ttsRestart');
    var closeIconBtn = pick('ttsCloseIcon');
    var progressBar = pick('ttsProgressBar');
    var progressText = pick('ttsProgressText');
    var rateEl = pick('ttsRate');
    var voiceSel = pick('ttsVoice');
    var autoEl = pick('ttsAuto');
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
    var explainPanel = pick('explainPanel');
    var explainPanelClose = pick('explainPanelClose');
    var explainBody = pick('explainBody');
    var quizFab = pick('quizFab');
    var quizPanel = pick('quizPanel');
    var quizPanelClose = pick('quizPanelClose');
    var quizTitle = pick('quizTitle');
    var quizBody = pick('quizBody');
    document.body.appendChild(holder);

    /* ===== 1b. 提取内联章节导航 → 悬浮面板，隐藏原始导航 ===== */
    var inlineNavs = document.querySelectorAll('.chapter-nav');
    for (var n = 0; n < inlineNavs.length; n++) { inlineNavs[n].style.display = 'none'; }
    if (inlineNavs.length > 0) {
      chapterNavLinks.innerHTML = inlineNavs[0].innerHTML;
    }

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

    /* 请求屏幕唤醒锁 */
    function requestWakeLock() {
      if (!navigator.wakeLock) { return; }
      if (wakeLock) { return; }
      navigator.wakeLock.request('screen').then(function (lock) {
        wakeLock = lock;
        lock.addEventListener('release', function () { wakeLock = null; });
      }).catch(function () { /* 息屏请求可能被拒绝，静默忽略 */ });
    }
    /* 释放屏幕唤醒锁 */
    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release().catch(function () {});
        wakeLock = null;
      }
    }

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
    function findNextUrl() {
      var links = document.querySelectorAll('.chapter-nav a');
      for (var i = 0; i < links.length; i++) {
        if (links[i].textContent.indexOf('下一章') >= 0) { return links[i].href; }
      }
      return null;
    }
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
      if (idx < 0) { idx = 0; }
      if (idx >= sentences.length) { onChapterEnd(); return; }
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
      var t = findSentence(e.target);
      if (t) { triggerSentence(t); }
    });
    var longPressTimer = null;
    content.addEventListener('touchstart', function (e) {
      var t = findSentence(e.target);
      if (!t) { return; }
      longPressTimer = setTimeout(function () {
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

    /* ===== 6. 面板开合与连读自动开播 ===== */
        function openPanel() { panel.classList.add('open'); fab.style.display = 'none'; }
    function closePanel() { fab.style.display = ''; panel.classList.remove('open'); }
    fab.addEventListener('click', openPanel);
    var toolbar = document.getElementById('readerToolbar');
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
      return fetch(path, {
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
    function learnLang() { return getLearnSetting('learnLang', '英语'); }
    function learnAge() { return getLearnSetting('learnAge', '9'); }

    function refreshLearnModeBtn() {
      if (isLearnMode()) { learnModeBtn.classList.add('active'); learnModeBtn.textContent = '🟢'; }
      else { learnModeBtn.classList.remove('active'); learnModeBtn.textContent = '⚪'; }
    }

    /* 设置面板开合 */
    settingsFab.addEventListener('click', function () {
      settingsPanel.classList.add('open');
      toolbar.style.display = 'none';
      refreshLearnModeBtn();
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
    });
    learnLangSel.addEventListener('change', function () { setLearnSetting('learnLang', learnLangSel.value); });
    learnAgeSel.addEventListener('change', function () { setLearnSetting('learnAge', learnAgeSel.value); });

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

    function startQuiz() {
      quizPanel.classList.add('open');
      toolbar.style.display = 'none';
      var age = learnAge();
      var pre = preloadReaderData();
      /* 发布时已按默认年龄预生成：命中即用，零 LLM、即时呈现 */
      if (pre && pre.quiz && String(pre.quiz.age) === String(age) && Array.isArray(pre.quiz.questions) && pre.quiz.questions.length) {
        quizQuestions = pre.quiz.questions; quizIndex = 0; quizScore = 0; renderQuizQuestion(); return;
      }
      /* 年龄不匹配或旧页面：走服务端（带缓存 + 在途去重），命中后同样即时 */
      quizBody.textContent = '正在出题...';
      apiPost('/api/reader/quiz', { document: getChapterContent(), age: age })
        .then(function (data) {
          var arr = data.questions;
          if (!arr || !arr.length) { quizBody.textContent = '出题失败：未返回题目'; return; }
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
      fb.textContent = '思考中...';
      quizBody.appendChild(fb);
      var fbText = '题目：' + q.question + '\n孩子选了' + selectedLetter + '，正确答案是' + letters[correctIdx] + '。请用鼓励语气简短讲解。';
      apiPost('/api/reader/feedback', { text: fbText })
        .then(function (data) { fb.textContent = data.feedback || (isCorrect ? '回答正确！' : '正确答案是 ' + letters[correctIdx] + '。'); })
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
      again.addEventListener('click', startQuiz);
      quizBody.appendChild(again);
    }

    quizFab.addEventListener('click', startQuiz);
    refreshLearnModeBtn();

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
