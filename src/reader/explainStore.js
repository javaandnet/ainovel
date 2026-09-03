/**
 * 单词讲解持久缓存（global.db 单表）
 *
 * 为什么单独建表：点词讲解此前只有 aiService 的进程内 Map，重启即清零，
 * 且键是「词语+原句」——同一个词换一句、换一章、换一个读者都得重付一次 LLM。
 * 词义本质是通用词条（非用户私有数据），所以按 (词, 年龄, 语言) 落库、全局复用：
 * 任一读者生成过一次，之后所有人在任何章节点同一个词都秒显。
 *
 * 键的口径是这里唯一不能错的点：只认 (word, age, lang)，**不含原句**。
 * 原句仅在“首次生成”时作为语境喂给模型（见 aiService.explainWord 的 context），
 * 不进键，否则同词跨句无法复用，落库就失去意义。切年龄/切语言各自成项，互不污染。
 *
 * 与 vocabStore 打开的是同一个 global.db、两个连接：保持默认 DELETE 日志模式，不开 WAL。
 * 建库失败即降级为纯进程内缓存（功能不受影响，只是重启后要重算），不反复抛异常。
 */
import Database from 'better-sqlite3';
import { GLOBAL_DB } from '../auth/userStore.js';

const MAX_ROWS = Number(process.env.READER_EXPLAIN_DB_ROWS || 5000);

let _db = null;
let _broken = false;

/** 惰性打开并建表；不可用时返回 null，调用方降级为纯进程内缓存。 */
function db() {
  if (_db) return _db;
  if (_broken) return null;
  try {
    const d = new Database(GLOBAL_DB);
    d.exec(`
      CREATE TABLE IF NOT EXISTS reader_word_explain (
        word TEXT NOT NULL,
        age INTEGER NOT NULL,
        lang TEXT NOT NULL,
        explanation TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (word, age, lang)
      )
    `);
    _db = d;
    return _db;
  } catch (err) {
    _broken = true;
    console.warn(`[explainStore] 讲解持久缓存不可用，退回纯进程内缓存（功能不受影响，只是重启后要重算）：${err.message}`);
    return null;
  }
}

/**
 * 读已缓存讲解。命中时刷新 updated_at，让淘汰按“最近是否被读到”走。
 * @returns {string|null} 命中返回讲解文本，未命中或库不可用返回 null
 */
export function getExplanation(word, age, lang) {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT explanation FROM reader_word_explain WHERE word = ? AND age = ? AND lang = ?').get(word, age, lang);
    if (!row || !row.explanation) return null;
    d.prepare('UPDATE reader_word_explain SET updated_at = ? WHERE word = ? AND age = ? AND lang = ?').run(Date.now(), word, age, lang);
    return row.explanation;
  } catch (err) {
    console.warn(`[explainStore] 读缓存失败，本次改为直接生成：${err.message}`);
    return null;
  }
}

/** 写缓存。只写非空结果；写失败不影响本次返回给读者的数据。 */
export function putExplanation(word, age, lang, explanation) {
  const d = db();
  if (!d) return;
  if (!word || !explanation) return;
  try {
    d.prepare(`
      INSERT INTO reader_word_explain (word, age, lang, explanation, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(word, age, lang) DO UPDATE SET explanation = excluded.explanation, updated_at = excluded.updated_at
    `).run(word, age, lang, explanation, Date.now());
    evict(d);
  } catch (err) {
    console.warn(`[explainStore] 写缓存失败，本次结果不持久化：${err.message}`);
  }
}

/**
 * 批量返回“已有讲解”的词，供正文着色（命中→黑体，未命中→灰体）。纯查库，绝不触发 LLM。
 * 逐词点查：词表仅 8~20 个，走主键索引，比拼 IN(...) 更省解析且天然去歧义。
 */
export function wordsWithExplanation(words, age, lang) {
  const d = db();
  if (!d) return [];
  const list = Array.isArray(words) ? words.map((x) => String(x || '').trim()).filter(Boolean) : [];
  if (!list.length) return [];
  try {
    const stmt = d.prepare('SELECT 1 FROM reader_word_explain WHERE word = ? AND age = ? AND lang = ?');
    const have = [];
    for (const w of list) { if (stmt.get(w, age, lang)) have.push(w); }
    return have;
  } catch (err) {
    console.warn(`[explainStore] 状态查询失败：${err.message}`);
    return [];
  }
}

/** 超出上限时按 updated_at 丢弃最冷的行，把表限在几千行内（匿名接口可被刷，必须有界）。 */
function evict(d) {
  const { c } = d.prepare('SELECT COUNT(*) AS c FROM reader_word_explain').get();
  if (c <= MAX_ROWS) return;
  d.prepare(`
    DELETE FROM reader_word_explain
    WHERE rowid NOT IN (SELECT rowid FROM reader_word_explain ORDER BY updated_at DESC LIMIT ?)
  `).run(MAX_ROWS);
}
