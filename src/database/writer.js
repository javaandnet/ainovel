/**
 * Writer database manager using SQLite
 * 管理小说章节内容的数据库操作
 */

import Database from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

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
        SELECT no, type, name, outline, content, preface, version, id, created_at, updated_at 
        FROM content 
        WHERE no = 0
      `);
      
      return stmt.get() || null;
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
   * @param {number} options.limit - 限制返回数量
   * @param {number} options.offset - 偏移量
   * @returns {Array} 章节列表
   */
  getAllChapters(options = {}) {
    try {
      // 确保数据库已初始化
      this.ensureInitialized();
      
      const { limit = 1000, offset = 0 } = options;
      
      const stmt = this.db.prepare(`
        SELECT no, name, outline, content, part_no, id, created_at, updated_at 
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
        SELECT no, name, outline, content, part_no, id, created_at, updated_at 
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
      const existing = this.db.prepare('SELECT no FROM content WHERE no = ?').get(no);
      
      if (!existing) {
        return { success: false, error: `Chapter ${no} does not exist` };
      }
      
      // 更新大纲（和标题，如果提供）
      if (name) {
        this.db.prepare(`
          UPDATE content 
          SET outline = ?, name = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP 
          WHERE no = ?
        `).run(outline, name, no);
      } else {
        this.db.prepare(`
          UPDATE content 
          SET outline = ?, version = version + 1, updated_at = CURRENT_TIMESTAMP 
          WHERE no = ?
        `).run(outline, no);
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
