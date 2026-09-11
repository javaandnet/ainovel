/**
 * Writer database manager using SQLite
 * 管理小说章节内容的数据库操作
 */

import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { normalizeGenConfig } from '../utils/wordTarget.js';

/**
 * Writer 数据库类
 */
export class WriterDB {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }
  
  /**
   * 初始化数据库和表
   */
  ensureInitialized() {
    // 如果已经初始化，直接返回
    if (this.db) {
      return;
    }

    try {
      // 确保数据库目录存在
      fs.ensureDirSync(path.dirname(this.dbPath));
      
      // 创建数据库连接
      this.db = new Database(this.dbPath);
      
      // 使用默认的 DELETE 日志模式（数据量小时更简单高效）
      // 不需要 WAL 模式，避免产生 -wal 和 -shm 文件
      this.db.pragma('journal_mode = DELETE');
      
      // 直接创建表结构
      this.createSchema();
      
      console.log('✅ Writer database initialized:', this.dbPath);
    } catch (error) {
      console.error('❌ Failed to initialize writer database:', error.message);
      throw error;
    }
  }

  /**
   * 创建数据库表结构
   */
  createSchema() {
    try {
      // 创建统一的 content 表
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS content (
          no INTEGER PRIMARY KEY,              -- 0=小说概要, 1,2,3...=章节
          type TEXT NOT NULL DEFAULT 'chapter', -- 'novel' 或 'chapter'
          name TEXT,                            -- 小说名称（no=0时）或章节标题（no≥1时）
          outline TEXT,                         -- 小说简介（no=0时）或章节大纲（no≥1时）
          content TEXT,                         -- 其他信息（角色等，no=0时）或章节内容（no≥1时）
          id TEXT,                              -- 稳定章节ID（发布文件名依据，不随重排变化）
          version INTEGER DEFAULT 1,            -- 版本号
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // 迁移：旧库补充稳定 id 列（SQLite ALTER TABLE 不允许 ADD COLUMN 带 UNIQUE，用唯一索引替代）
      const cols = this.db.prepare('PRAGMA table_info(content)').all().map(c => c.name);
      if (!cols.includes('id')) {
        this.db.exec('ALTER TABLE content ADD COLUMN id TEXT');
      }
      // 迁移：分部归属列（0=未分部；存量库无“部”概念时全为 0，行为与以前一致）
      if (!cols.includes('part_no')) {
        this.db.exec('ALTER TABLE content ADD COLUMN part_no INTEGER DEFAULT 0');
      }
      // 迁移：“本书设定”说明正文，只写在 no=0 概要行上；
      // 不新增 content 行，避免污染发布侧 no >= 1 AND type = 'chapter' 的章节集合
      if (!cols.includes('preface')) {
        this.db.exec('ALTER TABLE content ADD COLUMN preface TEXT');
      }
      // 迁移：全书生成设定（每章目标字数等），同样只写在 no=0 行上，理由与 preface 一致。
      // 为什么不复用 content 文字段塞标记：那是「给模型读的东西」，人改设定时会顺手删掉那行，
      // 而且界面没法只把这一个数字显示出来——字数约束失效时是静默的，没人发现。
      if (!cols.includes('gen_cfg')) {
        this.db.exec('ALTER TABLE content ADD COLUMN gen_cfg TEXT');
      }
      // 回填缺失的 id（新插入由 _genId 显式生成，此处兜底历史数据）
      this.db.exec(`UPDATE content SET id = lower(hex(randomblob(8))) WHERE id IS NULL`);

      // “部”（整体 → 部 → 章）：表内只存部名与本部概要。
      // 起止章/章数一律由 content.part_no 聚合派生（见 getAllParts）——
      // 归属关系的事实来源在章节一侧，存区间副本会在删章/重编号后谎报且无人发现
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS parts (
          no INTEGER PRIMARY KEY,             -- 部序号 1,2,3...（对应 content.part_no）
          id TEXT,                            -- 稳定部ID（导言页文件名依据，不随重排变化）
          name TEXT,                          -- 部名（可空，空则展示为“第一部”）
          summary TEXT,                       -- 本部主要设定与故事概要（导言正文）
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      this.db.exec(`UPDATE parts SET id = lower(hex(randomblob(8))) WHERE id IS NULL`);

      // 章节改写前快照表：体检自动修或人工修之前，把原文存一份，支持回滚
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS chapter_revision (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chapter_no INTEGER NOT NULL,
          name TEXT,
          content TEXT NOT NULL,
          reason TEXT,
          source TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      
      // 创建索引
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_content_no ON content(no);
        CREATE INDEX IF NOT EXISTS idx_content_type ON content(type);
        CREATE INDEX IF NOT EXISTS idx_content_name ON content(name);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_content_id ON content(id);
        CREATE INDEX IF NOT EXISTS idx_content_part_no ON content(part_no);
      `);
      
      console.log('✅ Created unified content table + parts table');
    } catch (error) {
      console.error('❌ Failed to create schema:', error.message);
      throw error;
    }
  }

  /**
   * 生成稳定章节 ID（16 位十六进制，与排序无关，重排/插入/删除后保持不变）
   * @returns {string} 稳定 ID
   */
  _genId() {
    return crypto.randomBytes(8).toString('hex');
  }

  /**
   * 强制章节号为整数
   * no 列是 INTEGER PRIMARY KEY，绑定字符串会触发 SQLite "datatype mismatch" 错误
   * @param {*} no - 章节号（可能是字符串）
   * @returns {number} 整数章节号
   */
  _normalizeNo(no) {
    const n = Number(no);
    if (!Number.isInteger(n)) {
      throw new Error(`无效的章节号: ${JSON.stringify(no)}（必须为整数）`);
    }
    return n;
  }

  /**
   * 保存小说概要信息（no=0）
   * @param {Object} novelData - 小说数据
   * @param {string} novelData.name - 小说名称
   * @param {string} novelData.outline - 小说简介/故事概要
   * @param {string} novelData.content - 其他信息（角色设定、世界观等）
   * @returns {Object} 操作结果
   */
  saveNovelInfo(novelData) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const { name, outline, content = '' } = novelData;
      
      // 检查是否已有小说概要（no=0）
      const existing = this.db.prepare('SELECT no, version FROM content WHERE no = 0').get();
      
      if (existing) {
        // 更新现有概要
        const newVersion = existing.version + 1;
        this.db.prepare(`
          UPDATE content 
          SET name = ?, outline = ?, content = ?, version = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE no = 0
        `).run(name, outline, content, newVersion);
        
        return { success: true, action: 'updated', version: newVersion };
      } else {
        // 插入新概要
        this.db.prepare(`
          INSERT INTO content (no, type, name, outline, content, version, id)
          VALUES (0, 'novel', ?, ?, ?, 1, ?)
        `).run(name, outline, content, this._genId());
        
        return { success: true, action: 'inserted', version: 1 };
      }
    } catch (error) {
      console.error('❌ Failed to save novel info:', error.message);
      throw error;
    }
  }

  /**
   * 获取小说概要信息（no=0）
   * @returns {Object|null} 小说概要数据
   */
  getNovelInfo() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const stmt = this.db.prepare(`
        SELECT no, type, name, outline, content, preface, gen_cfg, version, id, created_at, updated_at 
        FROM content 
        WHERE no = 0
      `);

      const row = stmt.get() || null;
      // gen_cfg 统一在这里解成对象：让所有读设定的人都拿到同一个形状，
      // 而不是各自记着“这一列是 JSON 字符串”、各自 try JSON.parse。
      if (row) row.gen_cfg = this._parseGenConfig(row.gen_cfg);
      return row;
    } catch (error) {
      console.error('❌ Failed to get novel info:', error.message);
      throw error;
    }
  }

  /**
   * 检查小说概要是否存在
   * @returns {boolean} 是否存在
   */
  hasNovelInfo() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const result = this.db.prepare('SELECT COUNT(*) as count FROM content WHERE no = 0').get();
      return result.count > 0;
    } catch (error) {
      console.error('❌ Failed to check novel info existence:', error.message);
      throw error;
    }
  }

  /**
   * 删除小说概要（no=0）
   * @returns {Object} 操作结果
   */
  deleteNovelInfo() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const deleteResult = this.db.prepare('DELETE FROM content WHERE no = 0').run();
      
      if (deleteResult.changes === 0) {
        return { success: false, error: 'Novel info not found' };
      }
      
      return { success: true, action: 'deleted' };
    } catch (error) {
      console.error('❌ Failed to delete novel info:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 获取大纲版本历史
   * @returns {Array} 版本历史
   */
  getOutlineVersionHistory() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const stmt = this.db.prepare(`
        SELECT 
          o.version,
          o.updated_at,
          COUNT(c.no) as chapter_count
        FROM outline o
        LEFT JOIN content c ON c.outline_id = o.id
        WHERE o.id = 1
        GROUP BY o.version
        ORDER BY o.version DESC
      `);
      
      return stmt.all();
    } catch (error) {
      console.error('❌ Failed to get outline version history:', error.message);
      throw error;
    }
  }

  /**
   * 插入或更新章节内容
   * @param {Object} chapterData - 章节数据
   * @param {number} chapterData.no - 章节号（从 1 开始）
   * @param {string} chapterData.name - 章节标题
   * @param {string} chapterData.outline - 章节大纲
   * @param {string} chapterData.content - 章节内容
   * @param {number} [chapterData.part_no] - 归属部序号；省略时自动按部区间归属
   * @returns {Object} 操作结果
   */
  upsertChapter(chapterData) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const { name, outline, content } = chapterData;
      const no = this._normalizeNo(chapterData.no);
      
      // 检查章节是否存在
      const existing = this.db.prepare('SELECT no FROM content WHERE no = ?').get(no);
      
      if (existing) {
        // 更新现有章节（不动 part_no：改写已有章节不应改变它的归属）
        this.db.prepare(`
          UPDATE content 
          SET name = ?, outline = ?, content = ?, updated_at = CURRENT_TIMESTAMP 
          WHERE no = ?
        `).run(name, outline, content, no);
        
        return { success: true, action: 'updated', no };
      } else {
        // 插入新章节：未显式指定归属时，按章号落在哪个部区间自动归部（无部则为 0）
        const partNo = chapterData.part_no !== undefined && chapterData.part_no !== null
          ? this._normalizeNo(chapterData.part_no)
          : this._resolvePartNo(no);
        this.db.prepare(`
          INSERT INTO content (no, type, name, outline, content, part_no, id) 
          VALUES (?, 'chapter', ?, ?, ?, ?, ?)
        `).run(no, name, outline, content, partNo, this._genId());
        
        return { success: true, action: 'inserted', no, part_no: partNo };
      }
    } catch (error) {
      console.error('❌ Failed to upsert chapter:', error.message);
      throw error;
    }
  }

  /**
   * 获取所有章节
   * @param {Object} options - 查询选项
   * @param {number} options.limit - 限制返回数量（默认 1000；区间/全书扫描请改用 getChaptersInRange）
   * @param {number} options.offset - 偏移量
   * @param {boolean} [options.includeContent=true] - 是否带回正文。为 false 时不取 content，
   *        只给 LENGTH(content) 作 contentLength（足够判「有没有正文」「多少字」），
   *        避免列表类调用把整本正文搬进内存。
   * @returns {Array} 章节列表（含 no=0 概要行）
   */
  getAllChapters(options = {}) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const { limit = 1000, offset = 0, includeContent = true } = options;
      // LENGTH() 对 TEXT 按字符计（中文 1 字算 1），与既有 wordCount = content.length 同口径
      const cols = `no, name, outline, part_no, id, created_at, updated_at,
        LENGTH(content) AS contentLength${includeContent ? ', content' : ''}`;
      
      const stmt = this.db.prepare(`
        SELECT ${cols}
        FROM content 
        ORDER BY no ASC 
        LIMIT ? OFFSET ?
      `);
      
      return stmt.all(limit, offset);
    } catch (error) {
      console.error('❌ Failed to get all chapters:', error.message);
      throw error;
    }
  }

  /**
   * 获取单个章节
   * @param {number} no - 章节号
   * @returns {Object|null} 章节数据
   */
  getChapter(no) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const stmt = this.db.prepare(`
        SELECT no, name, outline, content, part_no, id, created_at, updated_at,
        LENGTH(content) AS contentLength 
        FROM content 
        WHERE no = ?
      `);
      
      return stmt.get(this._normalizeNo(no)) || null;
    } catch (error) {
      console.error('❌ Failed to get chapter:', error.message);
      throw error;
    }
  }

  /**
   * 删除章节并重新编号后续章节
   * @param {number} no - 章节号
   * @returns {Object} 操作结果
   */
  deleteChapter(no) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      no = this._normalizeNo(no);
      
      const transaction = this.db.transaction(() => {
        // 删除指定章节
        const deleteResult = this.db.prepare('DELETE FROM content WHERE no = ?').run(no);
        
        if (deleteResult.changes === 0) {
          throw new Error(`Chapter ${no} not found`);
        }
        
        // 重新编号后续章节（-1）
        this.db.prepare(`
          UPDATE content 
          SET no = no - 1, updated_at = CURRENT_TIMESTAMP 
          WHERE no > ? AND type = 'chapter'
        `).run(no);
      });
      
      transaction();
      
      return { success: true, action: 'deleted', no };
    } catch (error) {
      console.error('❌ Failed to delete chapter:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 批量插入或更新章节
   * @param {Array} chapters - 章节数据数组
   * @returns {Object} 操作结果
   */
  batchUpsertChapters(chapters) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const transaction = this.db.transaction((chapterList) => {
        const results = [];
        for (const chapter of chapterList) {
          const result = this.upsertChapter(chapter);
          results.push(result);
        }
        return results;
      });
      
      const results = transaction(chapters);
      
      return {
        success: true,
        totalChapters: chapters.length,
        results
      };
    } catch (error) {
      console.error('❌ Failed to batch upsert chapters:', error.message);
      throw error;
    }
  }

  /**
   * 重排章节号（用于添加/删除章节后）
   * @param {number} startFrom - 起始章节号
   * @param {number} shiftBy - 偏移量（正数=后移，负数=前移）
   * @returns {Object} 操作结果
   */
  shiftChapterNumbers(startFrom, shiftBy) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      startFrom = this._normalizeNo(startFrom);
      
      const transaction = this.db.transaction(() => {
        if (shiftBy > 0) {
          // 向后移动：从大到小更新，避免冲突
          const chapters = this.db.prepare(`
            SELECT no FROM content 
            WHERE no >= ? AND type = 'chapter'
            ORDER BY no DESC
          `).all(startFrom);
          
          for (const chapter of chapters) {
            const newNo = chapter.no + shiftBy;
            this.db.prepare(`
              UPDATE content 
              SET no = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE no = ?
            `).run(newNo, chapter.no);
          }
        } else {
          // 向前移动：从小到大更新，避免冲突
          const chapters = this.db.prepare(`
            SELECT no FROM content 
            WHERE no >= ? AND type = 'chapter'
            ORDER BY no ASC
          `).all(startFrom);
          
          for (const chapter of chapters) {
            const newNo = chapter.no + shiftBy;
            this.db.prepare(`
              UPDATE content 
              SET no = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE no = ?
            `).run(newNo, chapter.no);
          }
        }
      });
      
      transaction();
      
      return { success: true, shiftedCount: Math.abs(shiftBy) };
    } catch (error) {
      console.error('❌ Failed to shift chapter numbers:', error.message);
      throw error;
    }
  }

  /**
   * 获取章节总数
   * @returns {number} 章节总数
   */
  getChapterCount() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const result = this.db.prepare('SELECT COUNT(*) as count FROM content').get();
      return result.count;
    } catch (error) {
      console.error('❌ Failed to get chapter count:', error.message);
      throw error;
    }
  }

  /**
   * 搜索章节（按名称或内容）
   * @param {string} keyword - 搜索关键词
   * @returns {Array} 匹配的章节列表
   */
  searchChapters(keyword) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const stmt = this.db.prepare(`
        SELECT no, name, outline, content, created_at, updated_at 
        FROM content 
        WHERE name LIKE ? OR content LIKE ? 
        ORDER BY no ASC
      `);
      
      const searchPattern = `%${keyword}%`;
      return stmt.all(searchPattern, searchPattern);
    } catch (error) {
      console.error('❌ Failed to search chapters:', error.message);
      throw error;
    }
  }

  /**
   * 添加新章节大纲（自动移动后续章节编号）
   * @param {Object} chapterData - 章节数据
   * @param {number} chapterData.no - 插入位置（该位置及之后的章节会+1）
   * @param {string} chapterData.name - 章节标题
   * @param {string} chapterData.outline - 章节大纲
   * @param {string} [chapterData.content] - 章节内容（可选，默认为空）
   * @returns {Object} 操作结果
   */
  addChapterOutline(chapterData) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const { no: rawNo, name, outline, content = '' } = chapterData;
      const no = this._normalizeNo(rawNo);
      
      const transaction = this.db.transaction(() => {
        // 1. 获取需要移动的章节数量
        const chaptersToShift = this.db.prepare(`
          SELECT COUNT(*) as count FROM content WHERE no >= ? AND type = 'chapter'
        `).get(no);
        
        if (chaptersToShift.count > 0) {
          // 2. 先将后续章节移到临时编号（+ 一个大的偏移量）
          const tempOffset = 10000;
          this.db.prepare(`
            UPDATE content 
            SET no = no + ?, updated_at = CURRENT_TIMESTAMP 
            WHERE no >= ? AND type = 'chapter'
          `).run(tempOffset, no);
          
          // 3. 再移回正确的编号（+1）
          this.db.prepare(`
            UPDATE content 
            SET no = no - ? + 1, updated_at = CURRENT_TIMESTAMP 
            WHERE no >= ? AND type = 'chapter'
          `).run(tempOffset, tempOffset + no);
        }
        
        // 4. 插入新章节
        this.db.prepare(`
          INSERT INTO content (no, type, name, outline, content, version, id) 
          VALUES (?, 'chapter', ?, ?, ?, 1, ?)
        `).run(no, name, outline, content, this._genId());
      });
      
      transaction();
      
      return { success: true, action: 'inserted', no, dbAction: 'inserted' };
    } catch (error) {
      console.error('❌ Failed to add chapter outline:', error.message);
      throw error;
    }
  }

  /**
   * 批量插入章节：单个事务内「一次平移 + 连续 INSERT」，绝不触碰已有章节的内容。
   *
   * 为什么不循环调 addChapterOutline：
   *  1) 那里每插一章就把后续全部章节平移一次，加 N 章要改 N × 总章数行；这里一次平移就够。
   *  2) 逐条调用不是原子的——中途失败就留下「已平移但未插完」的半套状态，书会跳号且没人知道停在哪。
   *
   * 为什么用裸 INSERT 而不是 upsertChapter：upsert 撞到已有章号会把该章 name/outline 重写、
   * content 清成空串。加章场景下那是毁稿而不是特性，所以这里让主键冲突直接把整个事务顶回来。
   *
   * @param {Array<{name?:string, outline:string, content?:string}>} chapters - 按阅读顺序的新章节（outline 必填）
   * @param {Object} [anchor] - 插入位置：{ mode:'tail' }（默认，末尾追加）或 { mode:'after', no:N }（插在第 N 章之后；N=0 插到最前面）
   * @param {Object} [opts] - { allowEmptyOutline }
   * @param {boolean} [opts.allowEmptyOutline] - 允许先插无大纲的占位章。仅供「插入后立即回填大纲」的链路
   *   （generateOutlinesForRange）使用，它有自己的空大纲判定与重跑补齐，不是给调用方绕开校验的口子
   * @returns {Object} { success, from, to, insertedCount, shiftedCount, chapters, warning }
   */
  addChaptersBulk(chapters, anchor = {}, opts = {}) {
    this.ensureInitialized();

    const MAX_BULK = 50;   // 一次最多加几章：防手滑也防模型幻觉传个 2000 章进来
    const allowEmptyOutline = opts?.allowEmptyOutline === true;
    const list = Array.isArray(chapters) ? chapters : [];
    if (list.length === 0) throw new Error('批量加章：章节清单为空');
    if (list.length > MAX_BULK) throw new Error(`批量加章：单次最多 ${MAX_BULK} 章（本次 ${list.length} 章）`);
    list.forEach((c, i) => {
      if (!c || typeof c !== 'object') throw new Error(`批量加章：第 ${i + 1} 项不是章节对象`);
      // 缺大纲必须硬拦：批量生成正文只照有 outline 的章节跑，否则目录上有这一章、点进去却是空白。
      // 显式 allowEmptyOutline 是唯一例外——占位章由紧随其后的区间补大纲填上，没填上也能重跑再补
      if (!String(c.outline || '').trim() && !allowEmptyOutline) {
        throw new Error(`批量加章：第 ${i + 1} 项缺少大纲（outline）。无大纲的章节不会被批量生成正文，请先补上大纲`);
      }
    });

    const mode = anchor && anchor.mode === 'after' ? 'after' : 'tail';
    const maxNo = this.db.prepare(`SELECT MAX(no) AS m FROM content WHERE type = 'chapter' AND no > 0`).get()?.m || 0;
    let from;
    if (mode === 'tail') {
      from = maxNo + 1;
    } else {
      const at = this._normalizeNo(anchor.no);
      // at = 0 是合法值（插到全书最前面）；平移范国内不含 no=0 的概要行，不会被波及
      if (at < 0 || at > maxNo) throw new Error(`批量加章：插入位置第 ${at} 章不存在（当前共 ${maxNo} 章）`);
      from = at + 1;
    }

    const count = list.length;
    const inserted = [];
    const transaction = this.db.transaction(() => {
      let shiftedCount = 0;
      if (mode === 'after' && maxNo >= from) {
        shiftedCount = this.db.prepare(`SELECT COUNT(*) AS c FROM content WHERE no >= ? AND type = 'chapter'`).get(from).c;
        // 与 addChapterOutline 同理的两步法：先整体推到临时区避开主键唯一冲突，再整体落回 +count
        const TEMP_OFFSET = 1000000;
        this.db.prepare(`UPDATE content SET no = no + ?, updated_at = CURRENT_TIMESTAMP WHERE no >= ? AND type = 'chapter'`)
          .run(TEMP_OFFSET, from);
        this.db.prepare(`UPDATE content SET no = no - ? + ?, updated_at = CURRENT_TIMESTAMP WHERE no >= ? AND type = 'chapter'`)
          .run(TEMP_OFFSET, count, TEMP_OFFSET + from);
      }

      for (let i = 0; i < count; i++) {
        const no = from + i;
        const name = String(list[i].name ?? '').trim();
        const outline = String(list[i].outline ?? '').trim();
        const content = typeof list[i].content === 'string' ? list[i].content : '';
        // 归部必须在平移之后算：部区间由 content.part_no 聚合派生，先平移后算才能把新章归到正确的部
        const partNo = this._resolvePartNo(no);
        const id = this._genId();
        this.db.prepare(`
          INSERT INTO content (no, type, name, outline, content, part_no, version, id) 
          VALUES (?, 'chapter', ?, ?, ?, ?, 1, ?)
        `).run(no, name, outline, content, partNo, id);
        inserted.push({ no, name, id, part_no: partNo });
      }
      return shiftedCount;
    });

    const shiftedCount = transaction();

    // 章号不连续只提示不阻断：本次插入本身没覆盖任何旧章，跳号多半是历史脏数据（手工删过章），
    // 拿它报错会把正常的末尾追加误伤；把收敛动作交给已有的「重排编号」入口
    const span = this.db.prepare(`SELECT COUNT(*) AS c, MIN(no) AS lo, MAX(no) AS hi FROM content WHERE type = 'chapter' AND no > 0`).get();
    const contiguous = span.c > 0 && span.lo === 1 && span.hi === span.c;
    const warning = contiguous ? null
      : `章号不连续（共 ${span.c} 章，最大章号 ${span.hi}）。本次插入未覆盖任何已有章节，但建议跑一次「重排编号」收敛。`;

    return {
      success: true,
      action: 'bulkInserted',
      from,
      to: from + count - 1,
      insertedCount: count,
      shiftedCount,
      chapters: inserted,
      warning,
    };
  }

  /**
   * 最大章号（用于未给区间时按全书扫描）。不用 getChapterCount：它 COUNT 的是 content 全表，
   * 会把 no=0 的小说概要行算进去，得到「章数 +1」。
   * @returns {number} 无章节时返回 0
   */
  getMaxChapterNo() {
    this.ensureInitialized();
    return this.db.prepare(`SELECT MAX(no) AS m FROM content WHERE type = 'chapter' AND no > 0`).get()?.m || 0;
  }

  /**
   * 区间内的章节（带大纲原文与正文长度），供「区间补大纲」定位目标与改写前留档。
   *
   * 为什么不用 getAllChapters：它默认 LIMIT 1000，1000 章之后的大纲会被静默漏掉，
   * 于是「全书找空大纲」在一本长篇上会给出假的干净结论。
   *
   * @param {number} from - 起始章号（含）
   * @param {number} to - 结束章号（含）
   * @returns {Array<{no,name,outline,part_no,id,contentLength}>}
   */
  getChaptersInRange(from, to) {
    this.ensureInitialized();
    const lo = this._normalizeNo(from);
    const hi = this._normalizeNo(to);
    if (hi < lo) throw new Error(`区间无效：起始章号 ${lo} 大于结束章号 ${hi}`);
    return this.db.prepare(`
      SELECT no, name, outline, part_no, id, LENGTH(content) AS contentLength
      FROM content
      WHERE type = 'chapter' AND no BETWEEN ? AND ?
      ORDER BY no ASC
    `).all(lo, hi);
  }

  /**
   * 更新指定章节的大纲
   * @param {number} no - 章节号
   * @param {string} outline - 新的大纲内容
   * @param {string} [name] - 可选的新标题
   * @returns {Object} 操作结果
   */
  updateChapterOutline(no, outline, name = null) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      no = this._normalizeNo(no);
      
      // 检查章节是否存在
      const existing = this.db.prepare('SELECT no, outline FROM content WHERE no = ?').get(no);
      
      if (!existing) {
        return { success: false, error: `Chapter ${no} does not exist` };
      }

      // outline 为 undefined/null 表示“本次不打算改大纲”，必须沿用原值：
      // better-sqlite3 把 undefined 绑定成 NULL 且不报错，所以上层只改标题（菜单「更新章节大纲」、
      // AI 的 updateNovelPlan）会静默把大纲清成 NULL，还返回 success:true。
      // 显式传 '' 仍是清空，不受影响。
      const nextOutline = outline === undefined || outline === null ? existing.outline : outline;
      
      // 更新大纲（和标题，如果提供）
      if (name) {
        this.db.prepare(`
          UPDATE content 
          SET outline = ?, name = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP 
          WHERE no = ?
        `).run(nextOutline, name, no);
      } else {
        this.db.prepare(`
          UPDATE content 
          SET outline = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP 
          WHERE no = ?
        `).run(nextOutline, no);
      }
      
      return { success: true, action: 'updated', no, dbAction: 'updated' };
    } catch (error) {
      console.error('❌ Failed to update chapter outline:', error.message);
      throw error;
    }
  }

  /**
   * 重新编号所有章节（从1开始连续编号）
   * @returns {Object} 操作结果
   */
  reNumberAllChapters() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const transaction = this.db.transaction(() => {
        // 获取所有章节（按当前编号排序）
        const chapters = this.db.prepare(`
          SELECT no, name, outline, content, version 
          FROM content 
          WHERE no > 0 
          ORDER BY no ASC
        `).all();
        
        if (chapters.length === 0) {
          return { success: true, action: 'renumbered', shiftedCount: 0 };
        }
        
        // 重新编号
        chapters.forEach((chapter, index) => {
          const newNo = index + 1;
          if (chapter.no !== newNo) {
            this.db.prepare(`
              UPDATE content 
              SET no = ?, updated_at = CURRENT_TIMESTAMP 
              WHERE no = ?
            `).run(newNo, chapter.no);
          }
        });
        
        return { success: true, action: 'renumbered', shiftedCount: chapters.length };
      });
      
      const result = transaction();
      return result;
    } catch (error) {
      console.error('❌ Failed to renumber chapters:', error.message);
      throw error;
    }
  }

  /**
   * 各部的章节范围（由 content.part_no 聚合派生，不入表）
   * 重编号/删章后自动与实际列表一致，所以不存在“区间谎报”
   * @returns {Object<number, {from:number,to:number,chapters:number}>} key = 部序号
   */
  getPartRanges() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();

      const rows = this.db.prepare(`
        SELECT part_no, MIN(no) AS from_no, MAX(no) AS to_no, COUNT(*) AS chapters
        FROM content
        WHERE no >= 1 AND part_no IS NOT NULL AND part_no > 0
        GROUP BY part_no
      `).all();

      const map = {};
      for (const r of rows) {
        map[r.part_no] = { from: r.from_no, to: r.to_no, chapters: r.chapters };
      }
      return map;
    } catch (error) {
      console.error('❌ Failed to get part ranges:', error.message);
      throw error;
    }
  }

  /**
   * 推断新章节应归属哪一部
   * 规则（不猜、不制造“未归部章节”）：
   * - 无任何部 → 0
   * - 章号落在某部派生区间内 → 该部
   * - 章号超过最后一部的末章（尾部追加）→ 归最后一部（续写场景最常见）
   * - 章号在第一部起始章之前（异常状态）→ 0，由上层提示重设分部
   * @param {number} no - 章节号
   * @returns {number} 部序号，0 表示不属于任何部
   */
  _resolvePartNo(no) {
    const n = this._normalizeNo(no);
    const ranges = this.getPartRanges();
    const partNos = Object.keys(ranges).map(Number).sort((a, b) => a - b);
    if (partNos.length === 0) return 0;

    for (const p of partNos) {
      if (n >= ranges[p].from && n <= ranges[p].to) return p;
    }
    if (n > ranges[partNos[partNos.length - 1]].to) return partNos[partNos.length - 1];
    return 0;
  }

  /**
   * 保存“本书设定”说明（面向读者的第一印象：背景世界观 + 主要出场人物）
   * 存在 no=0 概要行的 preface 列，不新增 content 行
   * @param {string|null} text - 设定说明正文（Markdown）；传空则清除
   * @returns {Object} 操作结果
   */
  savePreface(text) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();

      const existing = this.db.prepare('SELECT no FROM content WHERE no = 0').get();
      if (!existing) {
        throw new Error('小说概要（no=0）不存在，无法保存设定说明；请先用 saveNovelPlan 保存规划');
      }

      const value = text === undefined || text === null || String(text).trim() === '' ? null : String(text);
      this.db.prepare(`
        UPDATE content SET preface = ?, updated_at = CURRENT_TIMESTAMP WHERE no = 0
      `).run(value);

      return { success: true, cleared: value === null, length: value ? value.length : 0 };
    } catch (error) {
      console.error('❌ Failed to save preface:', error.message);
      throw error;
    }
  }

  /**
   * 读取“本书设定”说明
   * @returns {string|null} 设定说明正文，未生成时 null
   */
  getPreface() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();

      const row = this.db.prepare('SELECT preface FROM content WHERE no = 0').get();
      return row && row.preface && String(row.preface).trim() ? row.preface : null;
    } catch (error) {
      console.error('❌ Failed to get preface:', error.message);
      throw error;
    }
  }

  /**
   * 解 gen_cfg 列。坏数据当「未设置」看待但告警：
   * 抛穿会把「看小说信息」这种读操作也变成 500，静默则会让字数约束悄悄失效。
   * @param {string|null} raw
   * @returns {Object|null}
   */
  _parseGenConfig(raw) {
    if (!raw) return null;
    try {
      return normalizeGenConfig(JSON.parse(raw));
    } catch {
      console.warn('⚠️ gen_cfg 解析失败，本次按「未设置字数目标」处理');
      return null;
    }
  }

  /**
   * 保存全书生成设定（只写在 no=0 概要行的 gen_cfg 列）
   *
   * 校验放在这个唯一的落库口：REST、命令行 /api/run、AI 工具三条路都经这里，
   * 各自再校一遍只会把口径写坏（曾经 targetWordCount 只在一处校验）。
   * 传 null/'' 是清除（回到「不设限」），传形状不对的值则抛错，不静默修正。
   * @param {Object|null|undefined} cfg - { targetWords, tolerancePct, splitPct }
   * @returns {Object} { success, cleared, cfg }
   */
  saveGenConfig(cfg) {
    this.ensureInitialized();
    const existing = this.db.prepare('SELECT no FROM content WHERE no = 0').get();
    if (!existing) {
      throw new Error('小说概要（no=0）不存在，无法保存生成设定；请先保存小说基本信息');
    }
    const clear = cfg === null || cfg === undefined || cfg === '';
    const norm = clear ? null : normalizeGenConfig(cfg);
    // 只要给过配置就存，包括 targetWords=0：那一行现在是“用户显式取消了限制”的凭据。
    // 不存的话，“取消限制”与“从未设过”在库里一模一样，旧的文字标记会把取消顶回去。
    const store = clear ? null : JSON.stringify(norm);
    this.db.prepare(`
      UPDATE content SET gen_cfg = ?, updated_at = CURRENT_TIMESTAMP WHERE no = 0
    `).run(store);
    return { success: true, cleared: store === null, cfg: store ? norm : normalizeGenConfig(null) };
  }

  /**
   * 读全书生成设定
   * @returns {Object|null} 归一化后的配置；未设置时为 null（由调用方决定是否回落旧标记）
   */
  getGenConfig() {
    this.ensureInitialized();
    const row = this.db.prepare('SELECT gen_cfg FROM content WHERE no = 0').get();
    return this._parseGenConfig(row?.gen_cfg);
  }

  /**
   * 获取全部“部”及其派生的章节范围
   * @returns {Array<{no:number,id:string,name:string,summary:string,startNo:number,endNo:number,chapters:number}>}
   */
  getAllParts() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();

      const rows = this.db.prepare(`
        SELECT no, id, name, summary FROM parts ORDER BY no ASC
      `).all();
      const ranges = this.getPartRanges();

      return rows.map((r) => {
        const rg = ranges[r.no] || { from: 0, to: 0, chapters: 0 };
        return {
          no: r.no,
          id: r.id,
          name: r.name || '',
          summary: r.summary || '',
          startNo: rg.from,
          endNo: rg.to,
          chapters: rg.chapters
        };
      });
    } catch (error) {
      console.error('❌ Failed to get parts:', error.message);
      throw error;
    }
  }

  /**
   * 覆盖式保存部结构
   * @param {Array<{no?:number,name?:string,summary?:string,from:number,to:number}>} parts
   *   - no 省略时按数组顺序 1..N；from/to 为章节号（含）；传空数组 = 清除分部
   * @returns {Object} { success, partCount, assigned }
   */
  saveParts(parts) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();

      const list = Array.isArray(parts) ? parts : [];

      const transaction = this.db.transaction(() => {
        // 旧结构：按“章节集合相同”识别同一部，沿用其稳定 id 与已生成的导言
        // 只用范围作键，不把部名纳入匹配：改部名是常见操作，不应因此丢导言、不应让导言页文件名漂移
        const oldByKey = new Map();
        const ranges = this.getPartRanges();
        for (const r of this.db.prepare('SELECT no, id, name, summary FROM parts').all()) {
          const rg = ranges[r.no];
          if (rg) oldByKey.set(`${rg.from}|${rg.to}`, { id: r.id, name: r.name || '', summary: r.summary || '' });
        }

        this.db.prepare('DELETE FROM parts').run();
        // 先全部解除归属再按新区间写入，避免旧归属残留
        this.db.prepare('UPDATE content SET part_no = 0 WHERE no >= 1').run();

        let assigned = 0;
        list.forEach((p, i) => {
          const no = p.no !== undefined && p.no !== null ? this._normalizeNo(p.no) : i + 1;
          const from = this._normalizeNo(p.from);
          const to = this._normalizeNo(p.to);
          if (from < 1 || to < from) {
            throw new Error(`第${no}部的章节范围无效: ${from}-${to}（要求 1 <= 起始章 <= 结束章）`);
          }

          const reused = oldByKey.get(`${from}|${to}`);
          const givenName = p.name === undefined || p.name === null ? '' : String(p.name).trim();
          const name = givenName || (reused ? reused.name : '');
          const id = reused && reused.id ? reused.id : this._genId();
          const givenSummary = p.summary === undefined || p.summary === null ? '' : String(p.summary);
          const summary = givenSummary || (reused ? reused.summary : '');

          this.db.prepare(`
            INSERT INTO parts (no, id, name, summary, created_at, updated_at)
            VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          `).run(no, id, name, summary);

          // 只改归属，不动 updated_at：归属不是章节内容变化，不应污染“最后更新时间”
          const res = this.db.prepare(`
            UPDATE content SET part_no = ?
            WHERE no >= ? AND no <= ? AND no >= 1 AND type = 'chapter'
          `).run(no, from, to);
          assigned += res.changes;
        });

        return assigned;
      });

      const assigned = transaction();
      return { success: true, partCount: list.length, assigned };
    } catch (error) {
      console.error('❌ Failed to save parts:', error.message);
      throw error;
    }
  }

  /**
   * 更新单部的导言概要（generatePartIntros 专用，不动部结构）
   * @param {number} no - 部序号
   * @param {Object} fields - 需更新的字段
   * @param {string} [fields.summary] - 本部主要设定与故事概要
   * @param {string} [fields.name] - 部名（仅当原来为空时由生成器补上）
   * @returns {Object} 操作结果
   */
  updatePart(no, fields = {}) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();

      const n = this._normalizeNo(no);
      const existing = this.db.prepare('SELECT no, name, summary FROM parts WHERE no = ?').get(n);
      if (!existing) {
        throw new Error(`第${n}部不存在（请先用 setParts 划分分部）`);
      }

      const name = fields.name === undefined || fields.name === null || String(fields.name).trim() === ''
        ? existing.name
        : String(fields.name).trim();
      const summary = fields.summary === undefined || fields.summary === null
        ? existing.summary
        : String(fields.summary);

      this.db.prepare(`
        UPDATE parts SET name = ?, summary = ?, updated_at = CURRENT_TIMESTAMP WHERE no = ?
      `).run(name, summary, n);

      return { success: true, no: n, name, summaryLength: (summary || '').length };
    } catch (error) {
      console.error('❌ Failed to update part:', error.message);
      throw error;
    }
  }

  getInfo() {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const contentTable = this.db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name='content'
      `).get();
      
      const outlineCount = this.db.prepare('SELECT COUNT(*) as count FROM content WHERE no = 0').get();
      const chapterCount = this.db.prepare('SELECT COUNT(*) as count FROM content WHERE no > 0').get();
      const totalCount = this.db.prepare('SELECT COUNT(*) as count FROM content').get();
      const partsCount = this.db.prepare('SELECT COUNT(*) as count FROM parts').get().count;
      
      // 获取小说概要信息
      let novelInfo = null;
      if (outlineCount.count > 0) {
        const novel = this.db.prepare('SELECT name, outline, preface, version, updated_at FROM content WHERE no = 0').get();
        novelInfo = {
          exists: true,
          name: novel.name,
          outline: novel.outline?.substring(0, 50) + '...',  // 只显示前50字
          version: novel.version,
          hasPreface: !!(novel.preface && novel.preface.trim()),
          lastUpdated: novel.updated_at
        };
      } else {
        novelInfo = { exists: false };
      }
      
      return {
        databasePath: this.dbPath,
        tables: {
          content: !!contentTable,
          parts: true
        },
        novel: novelInfo,
        partCount: partsCount,
        chapterCount: chapterCount.count,
        totalCount: totalCount.count,
        version: this.db.prepare('SELECT sqlite_version() as version').get().version
      };
    } catch (error) {
      console.error('❌ Failed to get database info:', error.message);
      return null;
    }
  }

  /**
   * 保存章节改写前快照（用于回滚）
   * @param {number} chapterNo - 章节号
   * @param {Object} snapshot - { name, content, reason, source }
   * @returns {Object} 操作结果
   */
  saveChapterRevision(chapterNo, { name, content, reason, source }) {
    try {
      this.ensureInitialized();
      const result = this.db.prepare(`
        INSERT INTO chapter_revision (chapter_no, name, content, reason, source)
        VALUES (?, ?, ?, ?, ?)
      `).run(chapterNo, name || null, content, reason || null, source || 'manual');
      return { success: true, revisionId: result.lastInsertRowid };
    } catch (error) {
      console.error('❌ Failed to save chapter revision:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 列出某章的所有改写快照
   * @param {number} chapterNo - 章节号
   * @returns {Array<Object>} 快照列表（按时间倒序）
   */
  listChapterRevisions(chapterNo) {
    try {
      this.ensureInitialized();
      return this.db.prepare(`
        SELECT id, chapter_no, name, content, reason, source, created_at
        FROM chapter_revision
        WHERE chapter_no = ?
        ORDER BY created_at DESC
      `).all(chapterNo);
    } catch (error) {
      console.error('❌ Failed to list chapter revisions:', error.message);
      return [];
    }
  }

  /**
   * 恢复某章到指定快照（恢复前会把当前内容也存一份，双向不丢）
   * @param {number} revisionId - 快照 ID
   * @returns {Object} 操作结果
   */
  restoreChapterRevision(revisionId) {
    try {
      this.ensureInitialized();
      const revision = this.db.prepare('SELECT * FROM chapter_revision WHERE id = ?').get(revisionId);
      if (!revision) {
        return { success: false, error: `Revision ${revisionId} not found` };
      }

      // 恢复前先把当前内容存一份（双向不丢）
      const current = this.db.prepare('SELECT name, content FROM content WHERE no = ? AND type = ?').get(revision.chapter_no, 'chapter');
      if (current) {
        this.saveChapterRevision(revision.chapter_no, {
          name: current.name,
          content: current.content,
          reason: `恢复前备份（恢复到快照 #${revisionId}）`,
          source: 'pre-restore'
        });
      }

      // 恢复
      this.db.prepare('UPDATE content SET name = ?, content = ?, updated_at = CURRENT_TIMESTAMP WHERE no = ? AND type = ?')
        .run(revision.name, revision.content, revision.chapter_no, 'chapter');

      return { success: true, chapterNo: revision.chapter_no, restoredFrom: revisionId };
    } catch (error) {
      console.error('❌ Failed to restore chapter revision:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      console.log('🔒 Writer database connection closed');
    }
  }
}

// 导出类，不创建默认实例
// 数据库路径应该由调用方指定（通常在 session 目录下）
export const createWriterDB = (dbPath) => {
  return new WriterDB(dbPath);
};

export default WriterDB;
