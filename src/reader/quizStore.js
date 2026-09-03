/**
 * 章节小测试持久缓存（global.db 单表）
 *
 * 为什么要落库：出题原先只有 aiService 的进程内 Map，服务一重启就清零，同一章
 * 要再付一次 ~6.5s 的 LLM 调用；而 /api/reader/quiz 是未登录读者也能打的公开接口，
 * 重启高峰同时就是推理服务高峰。生词表（reader_vocab）、词义（reader_word_explain）
 * 都已入库，quiz 是最后一块短板。
 *
 * age 独立成列（不只混在哈希里）：便于按年龄档核对覆盖情况、按档清理，
 * 也避免"键里到底有没有年龄"这种只能靠读代码才能确认的口径。
 *
 * 键仍沿用 sha1('quiz|年龄|正文')：正文一改写键立刻变，旧题自动失效。
 * 绝不能用章节号/文件名做键——改写后仍命中旧题，题目和正文对不上且无人察觉。
 *
 * 注意本表语义与 vocab/explain 不同：quiz 是"读者点『换一组新题』才允许重生成"的
 * 内容，删除行的权力交给上层（force 重跑前先 deleteQuiz），这里只提供原语。
 */
import Database from 'better-sqlite3';
import { GLOBAL_DB } from '../auth/userStore.js';

const MAX_ROWS = Number(process.env.READER_QUIZ_DB_ROWS || 2000);

let _db = null;
let _broken = false;   // 建库失败过一次就不再反复尝试，避免每次请求都付一次异常开销

/** 惰性打开并建表；不可用时返回 null，调用方降级为纯进程内缓存（数据仍正确，只是慢） */
function db() {
  if (_db) return _db;
  if (_broken) return null;
  try {
    const d = new Database(GLOBAL_DB);
    // 与 vocabStore/explainStore/userStore 打开的是同一个库、多个连接：保持默认 DELETE 日志模式
    d.exec(`
      CREATE TABLE IF NOT EXISTS reader_quiz (
        key TEXT PRIMARY KEY,
        age INTEGER NOT NULL,
        questions TEXT NOT NULL,
        char_count INTEGER,
        updated_at INTEGER NOT NULL
      )
    `);
    d.exec('CREATE INDEX IF NOT EXISTS idx_reader_quiz_age ON reader_quiz(age)');
    _db = d;
    return _db;
  } catch (err) {
    _broken = true;
    console.warn(`[quizStore] 出题持久缓存不可用，退回纯进程内缓存（功能不受影响，只是重启后要重算）：${err.message}`);
    return null;
  }
}

/**
 * 读已缓存题目。命中时刷新 updated_at，让淘汰按"最近是否被读到"而不是"何时写入"走。
 * @param {string} key - sha1('quiz|年龄|正文')
 * @returns {Array|null} 命中返回题目数组，未命中或库不可用返回 null
 */
export function getQuiz(key) {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT questions FROM reader_quiz WHERE key = ?').get(key);
    if (!row) return null;
    const questions = JSON.parse(row.questions);
    // 空数组不算命中：那次多半是模型没按要求输出，固化下来会让这一章永远出不了题
    if (!Array.isArray(questions) || !questions.length) return null;
    d.prepare('UPDATE reader_quiz SET updated_at = ? WHERE key = ?').run(Date.now(), key);
    return questions;
  } catch (err) {
    console.warn(`[quizStore] 读缓存失败，本次改为直接生成：${err.message}`);
    return null;
  }
}

/**
 * 写缓存。只写非空结果；写失败不影响本次返回给读者的数据。
 * @param {string} key - 与 getQuiz 同一个键
 * @param {number} age - 年龄档（独立列，便于按档核对/清理）
 * @param {Array} questions - 题目数组
 * @param {number} charCount - 正文长度，便于人工核对两端口径是否一致
 */
export function putQuiz(key, age, questions, charCount) {
  const d = db();
  if (!d) return;
  if (!Array.isArray(questions) || !questions.length) return;
  try {
    d.prepare(`
      INSERT INTO reader_quiz (key, age, questions, char_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET age = excluded.age, questions = excluded.questions, updated_at = excluded.updated_at
    `).run(key, Number(age) || 0, JSON.stringify(questions), Number(charCount) || 0, Date.now());
    evict(d);
  } catch (err) {
    console.warn(`[quizStore] 写缓存失败，本次结果不持久化：${err.message}`);
  }
}

/** 作废旧题（force 重跑前调用）：重跑失败时留下的是"无缓存"而不是"新旧混用" */
export function deleteQuiz(key) {
  const d = db();
  if (!d) return;
  try { d.prepare('DELETE FROM reader_quiz WHERE key = ?').run(key); }
  catch (err) { console.warn(`[quizStore] 作废缓存失败：${err.message}`); }
}

/** 超出上限时按 updated_at 丢弃最冷的行。表被限在几千行内，整表计数足够便宜。 */
function evict(d) {
  const { c } = d.prepare('SELECT COUNT(*) AS c FROM reader_quiz').get();
  if (c <= MAX_ROWS) return;
  d.prepare(`
    DELETE FROM reader_quiz
    WHERE key NOT IN (SELECT key FROM reader_quiz ORDER BY updated_at DESC LIMIT ?)
  `).run(MAX_ROWS);
}
