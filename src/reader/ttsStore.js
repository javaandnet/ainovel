/**
 * TTS 音频持久缓存（global.db 单表 + 文件系统）
 *
 * 与 reader_word_explain 同构：按 (text, voice, rate) 的 hash 落库、全局复用。
 * 任一句子合成过一次，之后所有人在任何章节听到同一句都秒出。
 *
 * 键的口径：sha1(text|voice|rate)。正文改一个字只有那一句重新合成，其余继续命中。
 * 同一句在多章重复出现只合成一次。
 *
 * 音频文件落 data/tts/<hash[:2]>/<hash>.mp3，路径存 DB（相对 data/tts/）。
 * DB 管理的好处：可查询库存、按 last_accessed 做 LRU 清理、hash 去重显式。
 *
 * 合成引擎：msedge-tts（Node 端口，纯 JS，走微软公开边缘接口，免 key）。
 * 合成失败不抛异常，返回 null，调用方降级为浏览器 speechSynthesis。
 */
import Database from 'better-sqlite3';
import { GLOBAL_DB } from '../auth/userStore.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_ROOT = path.resolve(__dirname, '../../data/tts');

let _db = null;
let _broken = false;

/** 惰性打开并建表；不可用时返回 null，调用方降级。 */
function db() {
  if (_db) return _db;
  if (_broken) return null;
  try {
    const d = new Database(GLOBAL_DB);
    d.exec(`
      CREATE TABLE IF NOT EXISTS reader_tts_audio (
        hash TEXT PRIMARY KEY,
        voice TEXT NOT NULL,
        rate TEXT NOT NULL,
        file_path TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_accessed INTEGER
      )
    `);
    _db = d;
    return _db;
  } catch (err) {
    _broken = true;
    console.warn(`[ttsStore] 音频缓存 DB 不可用，退回纯文件缓存：${err.message}`);
    return null;
  }
}

/** 计算缓存键：sha1(text|voice|rate) */
export function computeHash(text, voice, rate) {
  return crypto.createHash('sha1').update(`${text}|${voice}|${rate}`).digest('hex');
}

/**
 * 读已缓存音频。命中时刷新 last_accessed。
 * @returns {{filePath: string, bytes: number}|null} 命中返回 {filePath (绝对路径), bytes}，未命中或库不可用返回 null
 */
export function getCached(hash) {
  const d = db();
  if (!d) return null;
  try {
    const row = d.prepare('SELECT file_path, bytes FROM reader_tts_audio WHERE hash = ?').get(hash);
    if (!row || !row.file_path) return null;
    const absPath = path.join(TTS_ROOT, row.file_path);
    if (!fs.existsSync(absPath)) {
      // 文件丢失，删 DB 记录
      d.prepare('DELETE FROM reader_tts_audio WHERE hash = ?').run(hash);
      return null;
    }
    d.prepare('UPDATE reader_tts_audio SET last_accessed = ? WHERE hash = ?').run(Date.now(), hash);
    return { filePath: absPath, bytes: row.bytes };
  } catch (err) {
    console.warn(`[ttsStore] getCached 失败：${err.message}`);
    return null;
  }
}

/**
 * 保存合成结果到 DB + 文件。
 * @param {string} hash
 * @param {string} voice
 * @param {string} rate
 * @param {string} absFilePath 合成产物的绝对路径
 * @param {number} bytes 文件大小
 */
export function saveAudio(hash, voice, rate, absFilePath, bytes) {
  const d = db();
  if (!d) return;
  try {
    // 目标路径：data/tts/<hash[:2]>/<hash>.mp3
    const relDir = hash.slice(0, 2);
    const relPath = path.join(relDir, `${hash}.mp3`);
    const absDest = path.join(TTS_ROOT, relPath);
    fs.ensureDirSync(path.dirname(absDest));
    fs.moveSync(absFilePath, absDest, { overwrite: true });
    d.prepare(`
      INSERT OR REPLACE INTO reader_tts_audio (hash, voice, rate, file_path, bytes, created_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hash, voice, rate, relPath, bytes, Date.now(), Date.now());
  } catch (err) {
    console.warn(`[ttsStore] saveAudio 失败：${err.message}`);
  }
}

/**
 * 合成一句音频。返回 {filePath, bytes} 或 null（失败时）。
 * 合成不常驻：每次拉起 MsEdgeTTS 实例，用完 close()。
 * @param {string} text 句子文本
 * @param {string} voice Edge 音色名（如 zh-CN-YunxiNeural）
 * @param {string} rate 语速（如 +0%、-30%、+50%）
 * @returns {Promise<{filePath: string, bytes: number}|null>}
 */
export async function synthesize(text, voice, rate) {
  const hash = computeHash(text, voice, rate);
  const cached = getCached(hash);
  if (cached) return cached;

  // 合成到临时目录
  const tmpDir = path.join(TTS_ROOT, '_tmp', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.ensureDirSync(tmpDir);
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { sentenceBoundaryEnabled: false });
    const result = await tts.toFile(tmpDir, text, { rate: rate || '+0%' });
    tts.close();
    const audioFile = result.audioFilePath;
    if (!fs.existsSync(audioFile)) return null;
    const bytes = fs.statSync(audioFile).size;
    // 保存到正式位置
    saveAudio(hash, voice, rate, audioFile, bytes);
    // 清理临时目录（saveAudio 已 move，tmpDir 应为空）
    fs.removeSync(tmpDir);
    return getCached(hash);
  } catch (err) {
    console.warn(`[ttsStore] synthesize 失败：${err.message}`);
    fs.removeSync(tmpDir);
    return null;
  }
}

/**
 * 按 LRU 清理旧音频（保留最近 N 条）。供手动调用或定时任务。
 * @param {number} keep 保留条数，默认 5000
 */
export function pruneLRU(keep = 5000) {
  const d = db();
  if (!d) return;
  try {
    const toDelete = d.prepare(`
      SELECT hash, file_path FROM reader_tts_audio
      ORDER BY last_accessed DESC
      LIMIT -1 OFFSET ?
    `).all(keep);
    if (!toDelete.length) return;
    const stmt = d.prepare('DELETE FROM reader_tts_audio WHERE hash = ?');
    for (const row of toDelete) {
      const absPath = path.join(TTS_ROOT, row.file_path);
      if (fs.existsSync(absPath)) fs.removeSync(absPath);
      stmt.run(row.hash);
    }
    console.log(`[ttsStore] LRU 清理：删除 ${toDelete.length} 条旧音频`);
  } catch (err) {
    console.warn(`[ttsStore] pruneLRU 失败：${err.message}`);
  }
}
