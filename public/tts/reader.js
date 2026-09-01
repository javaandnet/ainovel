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

  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = base + 'reader.css' + stamp;
  document.head.appendChild(link);

  var core = document.createElement('script');
  core.src = base + 'reader.core.js' + stamp;
  (document.body || document.head).appendChild(core);
})();
