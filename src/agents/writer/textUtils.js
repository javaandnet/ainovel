/**
 * 小说文本分析工具集
 *
 * 纯文本函数，不依赖 DB。从 writerTool.js 迁出可共用的抽取能力，
 * 并新增体检所需的标题解析、引用扫描、大纲依赖边抽取等。
 *
 * 设计原则：
 * - 所有函数都是纯文本操作，无副作用
 * - 中文数字与阿拉伯数字双轨支持（cnToNum 内部辅助）
 * - 大纲与正文的引用必须分开定性（source 参数）
 */

// ─── 中文数字工具 ───────────────────────────────────────────────

const CN_DIGIT_MAP = {
  '零': 0, '一': 1, '二': 2, '三': 3, '四': 4,
  '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '两': 2
};

/**
 * 中文数字 → 阿拉伯数字（支持 1–999）
 * @param {string} str - 中文数字字符串（如"三"、"十二"、"一百零五"）或阿拉伯数字字符串
 * @returns {number|null} 解析结果，无法解析时返回 null
 */
export function cnToNum(str) {
  const s = String(str || '').replace(/\s/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  let result = 0;
  let current = 0;
  for (const ch of s) {
    if (ch === '百') {
      if (current === 0) current = 1;
      result += current * 100;
      current = 0;
    } else if (ch === '十') {
      if (current === 0) current = 1;
      result += current * 10;
      current = 0;
    } else {
      const v = CN_DIGIT_MAP[ch];
      if (v === undefined) return null; // 非法字符
      current = v;
    }
  }
  result += current;
  return result > 0 ? result : null;
}

// ─── 标题解析 ───────────────────────────────────────────────────

/**
 * 从一行标题文本中解析出章号
 * 支持形态：`# 第3章`、`# 第三章：标题`、`第 12 章`、`第三章`
 * @param {string} line - 一行文本
 * @returns {number|null} 章号（整数），无法解析时返回 null
 */
export function parseHeadingChapterNo(line) {
  const trimmed = String(line || '').replace(/^#+\s*/, '').trim();
  const m = /^第\s*([0-9一二三四五六七八九十百零两]+)\s*章/.exec(trimmed);
  if (!m) return null;
  return cnToNum(m[1]);
}

/**
 * 判断一行标题是否已是规范形态 `# 第N章：真标题`
 * @param {string} line - 一行文本
 * @param {number} no - 期望的章号
 * @returns {boolean}
 */
export function isNormalizedHeading(line, no) {
  const trimmed = String(line || '').trim();
  const expected = `# 第${no}章`;
  if (!trimmed.startsWith(expected)) return false;
  const rest = trimmed.slice(expected.length).trim();
  return rest === '' || /^[：:]/.test(rest);
}

// ─── 引用扫描 ───────────────────────────────────────────────────

/**
 * 在文本中查找"第N章"式引用，排除标题行自身
 * @param {string} text - 正文或大纲文本
 * @param {string} source - 来源标记：'outline' | 'content'
 * @returns {Array<{no:number, index:number, quote:string, source:string}>}
 */
export function findChapterRefs(text, source = 'content') {
  const refs = [];
  const lines = String(text || '').split('\n');
  let offset = 0;
  for (const line of lines) {
    // 排除标题行（# 第N章... 或 ## 小节标题含章号）
    if (/^\s*#{1,6}\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章/.test(line)) {
      offset += line.length + 1;
      continue;
    }
    // 找 "第N章" 引用
    const re = /第\s*([0-9一二三四五六七八九十百零两]+)\s*章/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const no = cnToNum(m[1]);
      if (no !== null) {
        refs.push({ no, index: offset + m.index, quote: m[0], source });
      }
    }
    offset += line.length + 1;
  }
  return refs;
}

// ─── 大纲依赖边 ──────────────────────────────────────────────────

/**
 * 从大纲文本中抽取显式依赖边
 * - 具体依赖："承接/回到/呼应/延续 第N章" → type='specific', targetNo=N
 * - 范围依赖："前N章" → type='range', targetNo=N（依赖第 1~N 章）
 * @param {string} outline - 大纲文本
 * @returns {Array<{type:string, targetNo:number, index:number, quote:string}>}
 */
export function outlineDependencyEdges(outline) {
  const edges = [];
  const text = String(outline || '');

  // 具体依赖
  const specificRe = /(?:承接|回到|呼应|延续|接上|接着|紧接)\s*第\s*([0-9一二三四五六七八九十百零两]+)\s*章/g;
  let m;
  while ((m = specificRe.exec(text)) !== null) {
    const no = cnToNum(m[1]);
    if (no !== null) {
      edges.push({ type: 'specific', targetNo: no, index: m.index, quote: m[0] });
    }
  }

  // 范围依赖："前N章"
  const rangeRe = /前\s*([0-9一二三四五六七八九十百零两]+)\s*章/g;
  while ((m = rangeRe.exec(text)) !== null) {
    const n = cnToNum(m[1]);
    if (n !== null) {
      edges.push({ type: 'range', targetNo: n, index: m.index, quote: m[0] });
    }
  }

  return edges;
}

/**
 * 找出大纲为空的章节
 * @param {Array<{no:number, outline:string, content:string}>} chapters - 章节列表
 * @returns {Array<number>} 大纲为空但有正文的章号列表
 */
export function outlineEmptyChapters(chapters) {
  return (chapters || [])
    .filter(c => c.no > 0 && (!c.outline || !String(c.outline).trim()) && c.content && String(c.content).trim())
    .map(c => c.no);
}

/**
 * 计算各章大纲字数的粒度统计
 * @param {Array<{no:number, outline:string}>} chapters - 章节列表
 * @returns {{ median:number, chapters:Array<{no:number, length:number, ratio:number}> }}
 *   ratio = length / median；ratio < 1/3 或 > 3 视为粒度突变
 */
export function outlineGrainOf(chapters) {
  const list = (chapters || []).filter(c => c.no > 0);
  const lengths = list.map(c => ({ no: c.no, length: String(c.outline || '').length }));
  if (lengths.length === 0) return { median: 0, chapters: [] };

  const sorted = lengths.map(l => l.length).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return {
    median,
    chapters: lengths.map(l => ({
      no: l.no,
      length: l.length,
      ratio: median > 0 ? l.length / median : 0
    }))
  };
}

// ─── 角色/设定抽取（从 writerTool 迁出，行为逐字不变）─────────────────

/**
 * 从原文与设定中确定性地提取角色名清单（无需额外 LLM 调用）：
 * 统计"对话/动作动词"前的候选名（取 2~4 字后缀），按频次排序。
 * 清单只作改写提示词的辅助锚点，允许少量噪声；权威基准仍是原文全文
 * @param {string} originalContent - 原章节全文
 * @param {string} fullSetting - 小说整体设定
 * @returns {Array<string>} 角色名候选（频次降序，最多 12 个）
 */
export function extractCharacterRoster(originalContent, fullSetting) {
  const text = `${originalContent || ''}\n${fullSetting || ''}`;
  if (!text.trim()) return [];

  const stopWords = new Set([
    '大家', '众人', '自己', '他们', '她们', '它们', '我们', '你们', '别人', '对方',
    '一个', '这个', '那个', '所有', '其他', '几个', '两个', '有人', '没人', '这时',
    '时候', '然后', '但是', '于是', '因为', '所以', '如果', '虽然', '忽然', '突然',
    '接着', '随后', '同时', '最后', '首先', '而且', '不过', '只是', '只见', '只听'
  ]);
  const badEdge = '的了地得着是在有和与或就都也还很太更点之过起回出来去到把被从向往对';
  const cleanName = (s) => {
    const cut = s.split(/[的了之]/)[0];
    return cut;
  };
  const verbRe = /([\u4e00-\u9fa5·]{1,10}|[A-Za-z][A-Za-z·]{0,15})(?:说道|说着|问道|问说|答道|回答|喊道|叫道|笑道|哭道|吼道|低语|喃喃|嘀咕|心想|暗想|开口|接话|咬牙|点头|摇头|叹道|冷哼|站起身|走上前|说|问|道：|说：|问：|：)/g;
  const introRe = /(?:名叫|叫做|名字叫|它的名字是|他的名字是|她的名字是|大魔王)([\u4e00-\u9fa5·]{2,6})/g;

  const counter = new Map();
  const addCandidate = (raw, weight = 1) => {
    raw = cleanName(String(raw || ''));
    let candidates;
    if (/^[A-Za-z]/.test(raw)) {
      candidates = [raw];
    } else {
      candidates = [raw.slice(-2), raw.slice(-3), raw.slice(-4)]
        .filter((s, i, arr) => arr.indexOf(s) === i)
        .map(c => {
          while (c.length > 2 && badEdge.includes(c[c.length - 1])) c = c.slice(0, -1);
          return c;
        });
    }
    for (const c of candidates) {
      if (!c || c.length < 2 || stopWords.has(c)) continue;
      if (badEdge.includes(c[0]) || badEdge.includes(c[c.length - 1])) continue;
      counter.set(c, (counter.get(c) || 0) + weight);
    }
  };

  let m;
  while ((m = verbRe.exec(text)) !== null) {
    addCandidate(m[1]);
  }
  while ((m = introRe.exec(text)) !== null) {
    const introBoundary = ['统治', '带领', '压迫', '手下', '身边', '利用', '拥有'];
    let name = cleanName(m[1]);
    for (const b of introBoundary) {
      const idx = name.indexOf(b);
      if (idx > 0) name = name.slice(0, idx);
    }
    if (name.length >= 2 && !stopWords.has(name) && !badEdge.includes(name[0])) {
      counter.set(name, (counter.get(name) || 0) + 3);
    }
  }

  return [...counter.entries()]
    .filter(([name, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([name]) => name);
}

/**
 * 过滤角色名候选：去掉碎片、子串包含、按频次排序
 * @param {Array<string>} candidates - 候选名列表
 * @param {string} bodyText - 正文全文（用于计数）
 * @returns {Array<string>} 过滤后的名单
 */
export function filterCastNames(candidates, bodyText) {
  const junkEnd = '声道说念语定头笑想看着是在和也都就续章节篇卷字';
  const count = (n) => String(bodyText || '').split(n).length - 1;
  const byLength = [...(candidates || [])]
    .filter((n) => !junkEnd.includes(Array.from(n).pop()))
    .sort((a, b) => b.length - a.length);
  const kept = byLength.filter((n) => !byLength.some((m) => m !== n && m.includes(n)));
  return kept.sort((a, b) => count(b) - count(a));
}

/**
 * 从设定文本中提取"作者定名的名词"（角色卡名、地名、组织名等）
 * @param {string} setting - 设定文本（梗概 + 角色/世界观）
 * @returns {Array<string>} 名词候选（保留原样、已去重）
 */
export function extractSettingTerms(setting) {
  const isTerm = (raw) => {
    const chars = Array.from(String(raw).trim());
    if (chars.length < 2 || chars.length > 8) return false;
    if (/^第[0-9一二三四五六七八九十百零两]{1,4}[章节部篇卷]$/.test(chars.join(''))) return false;
    return chars.every((ch) => {
      const c = ch.codePointAt(0);
      return (c >= 0x4e00 && c <= 0x9fa5) || ch === '·';
    });
  };
  const terms = [];
  for (const line of String(setting || '').split(/\r?\n/)) {
    const m = /^\s*[-*\d.、]*\s*\*\*([^*]{2,12})\*\*\s*[：:]/.exec(line);
    if (m && isTerm(m[1])) terms.push(m[1].trim());
  }
  return [...new Set(terms)];
}
