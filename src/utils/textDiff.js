/**
 * 中文正文差异计算（零依赖）
 *
 * 为什么按句而不是按行：小说正文是一段几百字的长段落，按行 diff 会把「改了一个
 * 词」显示成「整段红绿替换」，读者看不出到底改了哪里。这里先按自然段切，再按
 * 中文句末标点切句，diff 的最小粒度就是一句话，改一句只标一句。
 *
 * 算法：句子序列做 LCS（动态规划）。单章句子数在数百量级，DP 规模完全可接受；
 * 超过 SAFETY_LIMIT 时先掐掉两端相同的公共前后缀（长文重写时常见），仍超限才退化
 * 为「整段替换」——宁可粒度变粗，也不让一次预览把进程卡死。
 */

const SAFETY_LIMIT = 400000; // LCS DP 单元格上限（约 632×632 句）

/** HTML → 纯文本（去标签、压空白），用于「只看正文改了什么」的比较口径 */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 归一化比较键：去掉所有空白，标点全半角统一，避免排版噪声被当成内容改动 */
function normKey(s) {
  return String(s || '')
    .replace(/\s+/g, '')
    .replace(/[，。！？；：""'']([，。！？；：""''])/g, '$1')
    .toLowerCase();
}

/**
 * 文本 → 句子序列。段落边界保留（para 段号），渲染时可据此重排 <p>。
 * @param {string} text
 * @returns {Array<{text:string, para:number}>}
 */
function splitSentences(text) {
  const paras = String(text || '').split(/\n+/).map((p) => p.trim()).filter(Boolean);
  const out = [];
  paras.forEach((p, pi) => {
    // 引号/括号收尾的句号（如 「走吧。」）不切开：只在标点后不是收尾引号处断句
    const parts = p.match(/[^。！？；…]+[。！？；…]*[""'』」）)]*|[/。！？；…]+[""'』」）)]*/g) || [p];
    let buf = '';
    for (const piece of parts) {
      if (!piece) continue;
      if (/^[。！？；…]+[""'』」）)]*$/.test(piece)) { buf += piece; continue; }
      if (buf) { out.push({ text: buf, para: pi }); buf = ''; }
      out.push({ text: piece, para: pi });
    }
    if (buf) out.push({ text: buf, para: pi });
  });
  return out;
}

/** 掐掉两端公共前后缀，返回 { head, tail, midA, midB, midKeysA, midKeysB }（中段已按公共前缀偏移） */
function trimCommon(a, b) {
  let start = 0;
  // a / b 的元素是 {text, para} 句对象：比较键必须取 .text 再归一化，
  // 直接 map(normKey) 会把整个对象 String() 成「[object Object]」——所有句子的键变得相同，
  // 公共前缀就会一路吃掉整篇，diff 只剩“末尾追加”，改动看上去像没改。
  const ka = a.map((x) => normKey(x.text || x));
  const kb = b.map((x) => normKey(x.text || x));
  while (start < a.length && start < b.length && ka[start] === kb[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && ka[endA - 1] === kb[endB - 1]) { endA--; endB--; }
  return { head: a.slice(0, start), tail: a.slice(endA), midA: a.slice(start, endA), midB: b.slice(start, endB), midKeysA: ka.slice(start, endA), midKeysB: kb.slice(start, endB) };
}

/**
 * 句级 diff。
 * @param {string} oldText - 上一版正文（纯文本或 HTML 均可，内部统一抽文本）
 * @param {string} newText - 本次正文
 * @returns {{ops:Array<{type:'same'|'add'|'del',text:string,para:number}>, stats:Object}}
 *   ops 按阅读顺序排列（same → add/del 混排），前端直接顺序渲染即得红绿对照。
 */
function diffText(oldText, newText) {
  const a = splitSentences(htmlToText(oldText));
  const b = splitSentences(htmlToText(newText));
  const { head, tail, midA, midB, midKeysA, midKeysB } = trimCommon(a, b);

  let midOps;
  if (midA.length * Math.max(midB.length, 1) > SAFETY_LIMIT) {
    // 规模超限：中段整体标记为「替换」，仍给出准确统计，只是不给逐句对照
    midOps = [
      ...midA.map((x) => ({ type: 'del', text: x.text, para: x.para })),
      ...midB.map((x) => ({ type: 'add', text: x.text, para: x.para })),
    ];
  } else {
    midOps = lcsOps(midA, midB, midKeysA, midKeysB);
  }

  const ops = [
    ...head.map((x) => ({ type: 'same', text: x.text, para: x.para })),
    ...midOps,
    ...tail.map((x) => ({ type: 'same', text: x.text, para: x.para })),
  ];

  const added = ops.filter((o) => o.type === 'add');
  const removed = ops.filter((o) => o.type === 'del');
  const chars = (arr) => arr.reduce((n, o) => n + String(o.text || '').replace(/\s/g, '').length, 0);
  const stats = {
    sentencesOld: a.length,
    sentencesNew: b.length,
    added: added.length,
    removed: removed.length,
    unchanged: ops.length - added.length - removed.length,
    charsOld: chars(a.map((x) => ({ text: x.text }))),
    charsNew: chars(b.map((x) => ({ text: x.text }))),
    charsAdded: chars(added),
    charsRemoved: chars(removed),
    coarse: midA.length * Math.max(midB.length, 1) > SAFETY_LIMIT, // 是否为规模退化（只给替换块）
  };
  stats.charsDelta = stats.charsNew - stats.charsOld;
  return { ops, stats };
}

/** 中段 LCS：等值按 normKey 判定，输出 add/del/same 序列 */
function lcsOps(A, B, ka, kb) {
  const n = A.length, m = B.length;
  // dp[i][j] = A[i..] 与 B[j..] 的 LCS 长度；倒序填表便于从 (0,0) 顺序回溯
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = ka[i] === kb[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { ops.push({ type: 'same', text: A[i].text, para: A[i].para }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: A[i].text, para: A[i].para }); i++; }
    else { ops.push({ type: 'add', text: B[j].text, para: B[j].para }); j++; }
  }
  while (i < n) { ops.push({ type: 'del', text: A[i].text, para: A[i].para }); i++; }
  while (j < m) { ops.push({ type: 'add', text: B[j].text, para: B[j].para }); j++; }
  return ops;
}

/** 行级 diff（供 HTML/配置类文本使用，粒度比句级粗，不做中文断句） */
function diffLines(oldText, newText) {
  const split = (t) => htmlToText(t).split('\n').map((s) => s.trim()).filter(Boolean);
  const A = split(oldText), B = split(newText);
  const ops = lcsOps(A, B, A.map(normKey), B.map(normKey));
  return { ops: ops.map((o) => ({ ...o, text: o.text })), stats: { added: ops.filter((o) => o.type === 'add').length, removed: ops.filter((o) => o.type === 'del').length } };
}

export { diffText, diffLines, splitSentences, htmlToText, normKey };
