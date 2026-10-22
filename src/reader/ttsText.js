/**
 * 朗读文本切分（与浏览器朗读器 reader.core.js 逐字节对齐）
 *
 * 为什么单列一份：预缓存脚本、段落级合成走的是服务端，而读者在线朗读的分句发生在浏览器 DOM 里。
 * 两边的「一句」必须完全一致，否则算出的缓存键（sha1(text|voice|rate)）对不上，预缓存就白做。
 * 因此这里的标点、切分规则、以及「按标签切文本节点 + HTML 实体解码 + 跳过 tts-skip/PRE/CODE」
 * 严格照搬 reader.core.js，改朗读器时这里要同步改。
 */

/* reader.core.js:273-274 同款标点集 */
export const END_PUNCTS = '。！？…；';
export const TAIL_PUNCTS = '…！？”\'’」）！？。';

/** 句末标点切句：遇到 END_PUNCTS 收尾，再吞掉连续的 TAIL_PUNCTS（如 」。 ！？）。 */
export function splitSentences(text) {
  const out = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    buf += ch;
    if (END_PUNCTS.indexOf(ch) >= 0) {
      while (i + 1 < text.length && TAIL_PUNCTS.indexOf(text.charAt(i + 1)) >= 0) {
        buf += text.charAt(i + 1);
        i++;
      }
      out.push(buf);
      buf = '';
    }
  }
  if (buf) out.push(buf);
  return out;
}

/** HTML 实体解码：够覆盖书页里出现的 &amp; &lt; &gt; &quot; &#39; 及数字实体。 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * 从「<div class="content">」内层 HTML 里，按朗读器的口径取出朗读句子序列。
 * 复刻浏览器 TreeWalker(SHOW_TEXT)：
 *   1) 丢弃 .tts-skip / PRE / CODE 子树（其文本不进入朗读）；
 *   2) 以「标签」为边界切成文本节点片段（<br>/<strong> 等会切断一句，与浏览器一致）；
 *   3) 每个片段解码实体，空（trim 后）则跳过（对应 acceptNode 的 FILTER_REJECT）；
 *   4) 片段内再 splitSentences，非空 trim 的即一句。
 * @param {string} innerHtml content div 的内层 HTML
 * @returns {string[]} 句子数组（与 sentences[idx].textContent 逐字节相同）
 */
export function extractReaderSentences(innerHtml) {
  let html = String(innerHtml || '');
  // 丢弃整棵被朗读跳过的子树：.tts-skip（如部标 kicker）、pre、code。书页里均为扁平叶子元素。
  html = html.replace(/<(p|div|span|small)\b[^>]*\btts-skip\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  html = html.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // 以标签为界切文本节点（每个标签都是一次节点边界），保留标签之间的原始片段顺序
  const fragments = html.split(/<[^>]+>/);
  const sentences = [];
  for (const raw of fragments) {
    const node = decodeEntities(raw);
    if (!node.trim()) continue;                      // 纯空白文本节点：朗读器直接 reject
    for (const s of splitSentences(node)) {
      if (s.trim()) sentences.push(s);               // span.textContent = s（不 trim），原样入句
    }
  }
  return sentences;
}

/**
 * 段落级切分：把一整段朗读文本按句拆开，供 Azure <break> 拼接（segments + breakMs）。
 * 与逐句朗读同一标点口径，保证「段落里的句」和「逐句模式的句」语义一致。
 * @param {string} paragraphText
 * @returns {string[]} 段内句子（已去空白片段）
 */
export function splitParagraphSentences(paragraphText) {
  return splitSentences(String(paragraphText || '')).filter((s) => s.trim());
}
