/**
 * 阅读模式（TTS）加载器 —— 章节页唯一引用的入口文件
 *
 * 设计意图：本文件刻意保持稳定（发布后长期不变，被浏览器长期缓存也无害），
 * 它再带时间戳加载真正的实现 reader.core.js 与样式 reader.css。
 * 因此改动界面/逻辑后只需把这两个文件同步到服务器（syncAssets 一条命令），
 * 全部历史章节页下次打开即生效，不需要重新发布任何小说。
 *
 * 页面引用形式：<script src="<相对路径>/tts/reader.js"></script>
 */
(function () {
  'use strict';

  var scriptEl = document.currentScript;
  /* 由自身 URL 推导资源目录，兼容站点挂在任意子路径（如 /novel/） */
  var base = scriptEl && scriptEl.src
    ? scriptEl.src.replace(/[^/]*$/, '')
    : 'tts/';
  var stamp = '?v=' + Date.now();

  /* 提前收起内联章节导航（← 上一章 / 📖 目录 / 下一章 →）。
     它最终要被 reader.core.js 收进悬浮面板并从正文里隐藏，但 core 带时间戳加载、
     永不命中缓存，必然晚于首屏绘制 —— 于是刷新时原始导航会先闪一下再消失。
     本文件长期稳定、能命中缓存且在 body 末尾同步执行，因此在自身执行时就用
     内联 style 把它收起；core 启动后会撤销这个临时收起、改由自己的内联 style
     接管隐藏（同一任务内完成，中间不绘制）。不支持语音合成、或 core 始终没跑
     起来（离线/404）时，原始导航必须回来，故留一个超时兜底还原。 */
  var root = document.documentElement;
  var DEFER_CLS = 'reader-nav-defer';
  var deferStyle = document.createElement('style');
  deferStyle.textContent = '.' + DEFER_CLS + ' .chapter-nav { display: none }';
  (document.head || root).appendChild(deferStyle);
  root.classList.add(DEFER_CLS);
  setTimeout(function () { root.classList.remove(DEFER_CLS); }, 8000);

  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = base + 'reader.css' + stamp;
  document.head.appendChild(link);

  var core = document.createElement('script');
  core.src = base + 'reader.core.js' + stamp;
  /* 加载失败立即还原原始导航，不等超时 */
  core.onerror = function () { root.classList.remove(DEFER_CLS); };
  (document.body || document.head).appendChild(core);
})();
