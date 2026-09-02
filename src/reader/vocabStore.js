/**
 * 生词表持久缓存（global.db 单表）
 *
 * 为什么要落库：aiService 的进程内 Map 重启即清零，每一章、每一个年龄档都要重付一次
 * LLM 调用；而 /api/reader/* 注册在 requireAuth 之前，是未登录读者也能打的公开接口，
 * 服务重启的高峰同时就是推理服务的高峰。关思考后单次约 6.5s，仍不该反复白付。
 *
 * 键的口径是这套设计里唯一不能错的点：沿用 sha1('vocab|年龄|正文')，正文一改写键立刻变，
 * 旧词表自动失效。绝不能图省事改用章节文件名或章节号做键 —— 那样改写之后仍会命中旧词表，
 * 标注和正文对不上且没有任何人会察觉（publish_state 记账与实际页面脱节表现为静默 404，
 * 是同一个坑的另一种写法）。
 *
 * 有界淘汰也是必须的：匿名接口可以被任何人刷，无上限就等于无界增长的库。
 */
import Database from 'better-sqlite3';
import { GLOBAL_DB } from '../auth/userStore.js';

const MAX_ROWS = Number(process.env.READER_VOCAB_DB_ROWS || 3000);

let _db = null;
let _broken = false;   // 建库失败过一次就不再反复尝试，避免每次请求都付一次异常开销

/** 惰性打开并建表；不可用时返回 null，调用方降级为纯进程内缓存（数据仍正确，只是慢） */
function db() {
  if (_db) return _db;
  if (_broken) return null;
  try {
    const d = new Database(GLOBAL_DB);
    // 与 userStore 打开的是同一个库、两个连接：保持默认 DELETE 日志模式，不开 WAL，
    // 免得两种日志模式互相改文件头（同进程多连接下 WAL 并无收益）
    d.exec(`
      CREATE TABLE IF NOT EXISTS reader_vocab (
        key TEXT PRIMARY KEY,
        words TEXT NOT NULL,
        char_count INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);
    _db = d;
    return _db;
  } catch (err) {
    _broken = true;
    console.warn(`[vocabStore] 生词持久缓存不可用，退回纯进程内缓存（功能不受影响，只是重启后要重算）：${err.message}`);
    return null;
  }
}

/**
 * 读已缓存词表。命中时刷新 updated_at，让淘汰按“最近是否被读到”而不是“何时写入”走。
 * @param {string} key - sha1('vocab|年龄|正文')
 * @returns {string[]|null} 命中返回词表，未命中或库不可用返回 null
 */
export function getCachedWords(key) {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT words FROM reader_vocab WHERE key = ?').get(key);
    if (!row) return null;
    const words = JSON.parse(row.words);
    // 空表不算命中：多半是那次模型没按要求输出，固化下来会让这一章永远标不出词
    if (!Array.isArray(words) || !words.length) return null;
    d.prepare('UPDATE reader_vocab SET updated_at = ? WHERE key = ?').run(Date.now(), key);
    return words;
  } catch (err) {
    console.warn(`[vocabStore] 读缓存失败，本次改为直接生成：${err.message}`);
    return null;
  }
}

/**
 * 写缓存。只写非空结果；写失败不影响本次返回给读者的数据。
 * @param {string} key - 与 getCachedWords 同一个键
 * @param {string[]} words - 已过滤、已按长词优先排序的词表
 * @param {number} charCount - 正文长度，便于人工核对两端口径是否一致
 */
export function putCachedWords(key, words, charCount) {
  const d = db();
  if (!d) return;
  if (!Array.isArray(words) || !words.length) return;
  try {
    d.prepare(`
      INSERT INTO reader_vocab (key, words, char_count, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET words = excluded.words, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(words), Number(charCount) || 0, Date.now());
    evict(d);
  } catch (err) {
    console.warn(`[vocabStore] 写缓存失败，本次结果不持久化：${err.message}`);
  }
}

/** 超出上限时按 updated_at 丢弃最冷的行。表被限在几千行内，整表计数足够便宜。 */
function evict(d) {
  const { c } = d.prepare('SELECT COUNT(*) AS c FROM reader_vocab').get();
  if (c <= MAX_ROWS) return;
  d.prepare(`
    DELETE FROM reader_vocab
    WHERE key NOT IN (SELECT key FROM reader_vocab ORDER BY updated_at DESC LIMIT ?)
  `).run(MAX_ROWS);
}
