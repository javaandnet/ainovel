#!/usr/bin/env node
/**
 * 小说发布脚本
 * 
 * 功能：
 * 1. 读取session目录中的markdown章节文件
 * 2. 将markdown转换为HTML
 * 3. 生成索引页面（index.html）
 * 4. 通过SFTP上传到网络服务器
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
// ainovel: 本地服务直连，SSH 发布链路已停用。publishNovel 等 SSH 函数不再被调用，
// 此处以占位替代 ssh2 依赖，避免模块加载即报 ERR_MODULE_NOT_FOUND。
const Client = function () { throw new Error('SSH 发布已在 ainovel 停用，请使用 publishNovelLocal'); };
import { resolveSkillPath, checkPath } from '../../utils/skillPathResolver.js';
import { toChineseOrdinal } from '../../utils/chineseNumber.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 生成章节导航栏（上一章 / 目录 / 下一章）
 * @param {string|null} prevUrl - 上一章链接（第一章传 null 则不显示）
 * @param {string|null} nextUrl - 下一章链接（最后一章传 null 则不显示）
 * @returns {string} 导航栏HTML
 */
function buildChapterNav(prevUrl, nextUrl) {
  const links = [];
  if (prevUrl) links.push(`<a href="${prevUrl}">← 上一章</a>`);
  links.push(`<a href="index.html" class="nav-home">📖 目录</a>`);
  if (nextUrl) links.push(`<a href="${nextUrl}">下一章 →</a>`);
  return `<div class="chapter-nav">${links.join('\n            ')}</div>`;
}

/**
 * 去除标题中的"第X章"前缀，返回纯标题文本
 * @param {string} title - 原始标题（可能含"第1章：xxx"前缀）
 * @returns {string} 纯标题
 */
function stripChapterPrefix(title) {
  const stripped = String(title || '')
    .replace(/^第\s*[0-9一二三四五六七八九十百零两]+\s*章\s*[：:：]?\s*/, '')
    .trim();
  return stripped || String(title || '').trim();
}

/**
 * 去除正文开头的章节大标题（后续由发布逻辑按正确章节号重建）
 * @param {string} content - 章节正文
 * @returns {string} 去除开头标题后的正文
 */
function stripLeadingHeading(content) {
  return String(content || '').replace(/^\s*#\s+[^\n]*\n*/, '').trim();
}

/**
 * 阅读模式（TTS）以外部静态资源提供：assets/tts/
 * - reader.js      薄壳加载器（章节页唯一引用，本身长期稳定，被浏览器长期缓存无害）
 * - reader.core.js 朗读逻辑（由 reader.js 带时间戳加载，改动同步后立即全站生效）
 * - reader.css     朗读样式（同上，带时间戳加载）
 * 好处：调整阅读界面只需同步 assets，不必重新发布任何小说章节
 * 远程路径约定：<directory>/tts/*；章节页位于 <directory>/<小说名>/ 下，故引用 ../tts/
 */
const TTS_READER_REF = '    <script src="/tts/reader.js"></script>'; // ainovel: 本地绝对路径

/**
 * 站点级资源目录：<directory>/tts/ 存放阅读模式外链资源，它不是小说。
 * 首页枚举远程子目录时必须排除，否则小说列表会出现一本点开就 404 的“tts”。
 */
const RESERVED_SITE_DIRS = new Set(['tts']);

/**
 * 部的展示名：有部名时“第一部 · 启蒙篇”，无部名时仅“第一部”
 * （与 writerTool._partLabel 保持同一口径，两处各自实现会漂移）
 * @param {{no:number,name?:string}} part
 * @returns {string}
 */
function partLabel(part) {
  const ordinal = toChineseOrdinal(part.no, '部');
  const name = String(part.name || '').trim();
  return name ? `${ordinal} · ${name}` : ordinal;
}

/**
 * 把导言正文压成目录页上的一行摘要
 * 去掉 markdown 修饰符、拉平空白、按码位截断（不得切出孤立代理对）、最后转义 HTML
 * @param {string} text - 原始导言（Markdown）
 * @param {number} [limit] - 截断长度
 * @returns {string} 可直接嵌入 HTML 的摘要
 */
function inlineBrief(text, limit = 120) {
  const plain = String(text || '')
    .replace(/`{1,3}/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_]>\s?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '';
  const chars = Array.from(plain);
  const brief = chars.length > limit ? `${chars.slice(0, limit).join('')}…` : plain;
  return brief.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 将Markdown转换为HTML
 * @param {string} markdown - Markdown内容
 * @param {string} title - 页面标题
 * @param {string} navHtml - 章节导航栏HTML（内容上方和下方各显示一次）
 * @returns {string} HTML内容
 */
function markdownToHtml(markdown, title = '小说', navHtml = '') {
  // 配置marked选项
  const htmlContent = marked(markdown, {
    breaks: true,
    gfm: true
  });

  // 生成完整的HTML页面
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.8;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        h1, h2, h3 {
            color: #2c3e50;
            margin-top: 1.5em;
        }
        h1 {
            border-bottom: 2px solid #3498db;
            padding-bottom: 0.3em;
        }
        p {
            text-indent: 2em;
            margin: 1em 0;
        }
        a {
            color: #3498db;
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        .chapter-nav {
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            background: white;
            padding: 15px;
            margin: 20px 0;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .chapter-nav a {
            display: inline-block;
            margin: 5px 10px;
            padding: 8px 15px;
            background: #3498db;
            color: white;
            border-radius: 3px;
        }
        .chapter-nav a:hover {
            background: #2980b9;
            text-decoration: none;
        }
        .chapter-nav a.nav-home {
            background: #2c3e50;
        }
        .chapter-nav a.nav-home:hover {
            background: #1a252f;
        }
        /* 移动端：导航按钮强制一行显示 */
        @media (max-width: 480px) {
            .chapter-nav {
                flex-wrap: nowrap;
                padding: 10px 8px;
                gap: 6px;
            }
            .chapter-nav a {
                margin: 0;
                padding: 8px 10px;
                font-size: 0.85rem;
                flex: 1;
                text-align: center;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
        }
        .content {
            background: white;
            padding: 30px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        /* 章节页顶部“第X部 · 部名”小标：纯展示，带 .tts-skip 不参与朗读 */
        .part-kicker {
            text-indent: 0;
            margin: -0.4em 0 1.2em;
            font-size: 0.9em;
            color: #7f8c8d;
            letter-spacing: 0.02em;
        }
    </style>
</head>
<body>
    ${navHtml}
    <div class="content">
        ${htmlContent}
    </div>
    ${navHtml}
${TTS_READER_REF}</body>
</html>`;
}

/**
 * 生成索引页面（单本小说的章节目录页）
 * 无设定页且无分部时与旧版产物一致；有分部时按部一个区块，附导言链接与概要摘要
 * @param {Array} chapters - 章节列表 [{title, url, chapterNum, partNo}]
 * @param {string} novelTitle - 小说标题
 * @param {Object} [extras] - { prefaceUrl: string|null, parts: Array } 已派生起止章的部列表
 * @returns {string} HTML内容
 */
function generateIndex(chapters, novelTitle = '小说', extras = {}) {
  const prefaceUrl = extras.prefaceUrl || null;
  const parts = Array.isArray(extras.parts) ? extras.parts : [];

  const chapterLink = (ch) => `
        <a class="chapter-link" href="${ch.url}">${ch.title || `第${ch.chapterNum || ''}章`}</a>`;

  const prefaceEntry = prefaceUrl
    ? `
        <a class="preface-link" href="${prefaceUrl}">📖 本书设定</a>`
    : '';

  let bodyHtml;
  if (parts.length === 0) {
    // 单层结构（未分部）：平铺章节列表
    bodyHtml = `${prefaceEntry}${chapters.map(chapterLink).join('\n')}`;
  } else {
    // 按部成组；未归部章节（理论不应存在，setParts 要求连续覆盖）单独列尾，不静默丢弃
    const byPart = new Map(parts.map(p => [p.no, []]));
    const unassigned = [];
    chapters.forEach((ch) => {
      const bucket = byPart.get(ch.partNo || 0);
      (bucket || unassigned).push(ch);
    });

    bodyHtml = `${prefaceEntry}${parts.map((p) => {
      const titleHtml = p.introUrl
        ? `<a class="part-name" href="${p.introUrl}">${escapeHtml(p.label)}</a>`
        : `<span class="part-name">${escapeHtml(p.label)}</span>`;
      const summary = p.brief
        ? `\n        <p class="part-summary">${p.brief}${p.introUrl ? `<a class="part-more" href="${p.introUrl}">（读全文）</a>` : ''}</p>`
        : '';
      return `
    <div class="part-block">
        <div class="part-head">${titleHtml}<span class="part-range">（第${p.startNo}–${p.endNo}章 · ${p.chapters}章）</span></div>${summary}
        <div class="part-links">${(byPart.get(p.no) || []).map(chapterLink).join('\n')}
        </div>
    </div>`;
    }).join('')}${unassigned.length > 0 ? `
    <div class="part-block">
        <div class="part-head"><span class="part-name">未分部章节</span></div>
        <div class="part-links">${unassigned.map(chapterLink).join('\n')}
        </div>
    </div>` : ''}`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${novelTitle}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 0.5em;
        }
        .chapter-list {
            background: white;
            padding: 20px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .chapter-list a.chapter-link,
        .part-links a.chapter-link {
            display: block;
            padding: 12px 15px;
            margin: 8px 0;
            background: #3498db;
            color: white;
            text-decoration: none;
            border-radius: 3px;
            transition: background 0.3s;
        }
        .chapter-list a.chapter-link:hover,
        .part-links a.chapter-link:hover {
            background: #2980b9;
        }
        .preface-link {
            display: block;
            padding: 12px 15px;
            margin: 0 0 15px;
            background: #16a085;
            color: white;
            text-decoration: none;
            border-radius: 3px;
        }
        .preface-link:hover {
            background: #138d75;
        }
        .part-block {
            margin: 0 0 20px;
            border-left: 4px solid #3498db;
            padding-left: 12px;
        }
        .part-head {
            margin: 6px 0 2px;
            font-size: 1.08em;
            color: #2c3e50;
        }
        .part-name {
            font-weight: 600;
            color: #2c3e50;
            text-decoration: none;
        }
        a.part-name:hover {
            text-decoration: underline;
        }
        .part-range {
            color: #7f8c8d;
            font-size: 0.88em;
            font-weight: normal;
        }
        .part-summary {
            margin: 6px 0 10px;
            color: #555;
            font-size: 0.94em;
            line-height: 1.7;
        }
        .part-more {
            color: #3498db;
            text-decoration: none;
            white-space: nowrap;
        }
        .back-home {
            margin-bottom: 15px;
        }
        .back-home a {
            display: inline-block;
            padding: 8px 15px;
            background: #2c3e50;
            color: white;
            text-decoration: none;
            border-radius: 3px;
        }
        .back-home a:hover {
            background: #1a252f;
        }
    </style>
</head>
<body>
    <div class="back-home"><a href="../index.html">← 返回小说列表</a></div>
    <h1>${novelTitle}</h1>
    <div class="chapter-list">${bodyHtml}
    </div>
</body>
</html>`;
}

/**
 * HTML 文本转义（部名等来自库/模型的文本不得直接拼进标签）
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 将小说标题转为安全的目录名（URL路径段）
 * @param {string} name - 小说标题
 * @returns {string} 目录名
 */
export function sanitizeDirName(name) {
  const sanitized = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '')
    .trim();
  return sanitized || 'novel';
}

/**
 * 生成站点首页（小说列表页，部署在 <directory>/index.html）
 * @param {Array} novels - 小说列表 [{name, url, updatedText}]
 * @param {string} siteTitle - 页面标题
 * @returns {string} HTML内容
 */
function generateSiteIndex(novels, siteTitle = '小说列表') {
  const novelLinks = novels.length > 0
    ? novels.map(n => `
        <a href="${n.url}">📖 ${n.name}${n.updatedText ? `<span class="date">${n.updatedText}</span>` : ''}</a>`).join('\n')
    : '<p class="empty">暂无已发布的小说</p>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${siteTitle}</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
            line-height: 1.6;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background-color: #f5f5f5;
            color: #333;
        }
        h1 {
            color: #2c3e50;
            border-bottom: 3px solid #3498db;
            padding-bottom: 0.5em;
        }
        .novel-list {
            background: white;
            padding: 20px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        .novel-list a {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 14px 15px;
            margin: 8px 0;
            background: #3498db;
            color: white;
            text-decoration: none;
            border-radius: 3px;
            transition: background 0.3s;
        }
        .novel-list a:hover {
            background: #2980b9;
        }
        .novel-list a .date {
            font-size: 0.8em;
            opacity: 0.85;
        }
        .novel-list .empty {
            color: #999;
            text-align: center;
            padding: 20px 0;
        }
    </style>
</head>
<body>
    <h1>${siteTitle}</h1>
    <div class="novel-list">
        ${novelLinks}
    </div>
</body>
</html>`;
}

/**
 * 从小说数据库（SQLite）读取小说标题（no=0 的 name 字段）
 * 未传入 title 参数时作为兜底的小说标题来源
 * @param {string} dbPath - 小说数据库文件路径（已由调用方解析为绝对路径）
 * @returns {string|null} 小说标题或 null
 */
async function readNovelTitleFromDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return null;
  }
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare("SELECT name FROM content WHERE no = 0").get();
    db.close();
    return row?.name || null;
  } catch {
    return null;
  }
}

/**
 * 从小说数据库（SQLite）读取章节
 * novelWriter 现在将章节存入 SQLite 而非 markdown 文件，
 * 作为 chapter_XX.md 不存在时的回退数据源
 * @param {string} dbPath - 小说数据库文件路径（已由调用方解析为绝对路径）
 * @returns {Array} 章节列表
 */
async function readChaptersFromDb(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return [];
  }
  try {
    // 动态引入 better-sqlite3（publish.js 与项目同运行环境）
    const Database = (await import('better-sqlite3')).default;
    // 读写模式打开：旧库可能缺少稳定 id 列，需要迁移回填
    const db = new Database(dbPath);

    // 迁移：旧库补充稳定 id 列并回填（与 writer.js createSchema 逻辑保持一致）
    const cols = db.prepare('PRAGMA table_info(content)').all().map(c => c.name);
    if (!cols.includes('id')) {
      db.exec('ALTER TABLE content ADD COLUMN id TEXT');
    }
    db.exec(`UPDATE content SET id = lower(hex(randomblob(8))) WHERE id IS NULL`);

    // part_no 列只在 novelWriter 迁移过的库中存在；旧库无此列时按“未分部”发布
    const hasPartNo = cols.includes('part_no');
    const rows = db.prepare(
      `SELECT id, no, name, content${hasPartNo ? ', part_no' : ''} FROM content WHERE no >= 1 AND type = 'chapter' ORDER BY no ASC`
    ).all();
    db.close();

    const chapters = rows
      .filter(r => r.content && String(r.content).trim())
      .map(r => {
        const title = r.name || `第${r.no}章`;
        // content 列不存储章节标题，始终剥离正文开头已有的标题行
        // 标题由 HTML 生成时从 name + 序号动态拼接，避免追加/插入章节后序号错乱
        const content = stripLeadingHeading(r.content);
        return {
          file: `${path.basename(dbPath)}#${r.no}`,
          content,
          chapterNum: r.no,
          title,
          partNo: Number(r.part_no) || 0, // 归属的部序号，0 = 未分部
          id: r.id // 稳定章节ID，用作发布文件名，不随重排变化
        };
      });

    if (chapters.length > 0) {
      console.log(`✅ 从数据库读取到 ${chapters.length} 个章节: ${dbPath}`);
    }
    return chapters;
  } catch (error) {
    console.error('❌ 从数据库读取章节失败:', error.message);
    return [];
  }
}

/**
 * 读取“本书设定”与分部结构（附加页的唯一数据源）
 * 库可能尚未被 novelWriter 迁移过（无 preface 列 / 无 parts 表），
 * 此时返回空结构：发布产物与旧版一致，不报错也不替调用方改库结构
 * @param {string} dbPath - 小说库路径
 * @returns {Promise<{preface: {id: string, text: string}|null, parts: Array}>}
 */
async function readNovelStructureFromDb(dbPath) {
  const empty = { preface: null, parts: [] };
  if (!dbPath || !fs.existsSync(dbPath)) {
    return empty;
  }
  let db = null;
  try {
    const Database = (await import('better-sqlite3')).default;
    db = new Database(dbPath, { readonly: true });

    const cols = db.prepare('PRAGMA table_info(content)').all().map(c => c.name);
    if (cols.includes('preface')) {
      const row = db.prepare('SELECT id, preface FROM content WHERE no = 0').get();
      const text = row && row.preface ? String(row.preface).trim() : '';
      // 无稳定 id 时不拼文件名（避免附加页名跨次发布漂移），直接当没写过设定页
      if (text && row.id) {
        empty.preface = { id: row.id, text };
      }
    }

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(t => t.name);
    if (tables.includes('parts')) {
      empty.parts = db.prepare('SELECT no, id, name, summary FROM parts ORDER BY no ASC').all()
        .map(p => ({ no: Number(p.no), id: p.id || null, name: p.name || '', summary: p.summary || '' }));
    }
    return empty;
  } catch (error) {
    console.warn(`⚠️  读取设定页/分部结构失败（按无附加页发布）: ${error.message}`);
    return { preface: null, parts: [] };
  } finally {
    if (db) {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}

/**
 * 把部与实际参与发布的章节对齐：展示名、起止章、章数一律由章节列表派生
 * （库里不存区间，发布集与实际列表永远一致，目录页不会谎报）
 * @param {Array<{no,id,name,summary}>} parts - 库中的部
 * @param {Array<{chapterNum,partNo}>} chapters - 本次发布的章节（已按章号升序）
 * @returns {Array} 带 startNo/endNo/chapters/label/introUrl/brief 的部视图（无任何已发布章节的部被剔除）
 */
function buildPartViews(parts, chapters) {
  const views = new Map(parts.map(p => [p.no, {
    no: p.no,
    id: p.id,
    name: p.name,
    summary: p.summary,
    label: partLabel(p),
    startNo: null,
    endNo: null,
    chapters: 0
  }]));

  for (const ch of chapters) {
    const view = views.get(Number(ch.partNo) || 0);
    if (!view) continue;
    if (view.startNo === null) view.startNo = ch.chapterNum;
    view.endNo = ch.chapterNum; // chapters 已按章号升序，最后命中的即末章
    view.chapters += 1;
  }

  return [...views.values()]
    .filter(v => v.startNo !== null)
    .sort((a, b) => a.no - b.no)
    .map(v => ({
      ...v,
      // 导言页只在有稳定 id 时生成（无 id 的部不拼装随机文件名）
      introUrl: v.summary && v.id ? `page_${v.id}.html` : null,
      brief: inlineBrief(v.summary)
    }));
}

/**
 * 读取session目录中的章节文件
 * @param {string} sessionDir - session目录路径
 * @param {string} [dbPath] - 小说数据库路径（无 markdown 章节文件时的回退数据源）
 * @returns {Array} 章节文件列表
 */
async function readChapterFiles(sessionDir, dbPath) {
  const chapters = [];
  
  try {
    const files = fs.readdirSync(sessionDir);
    
    // 查找chapter_XX.md文件
    const chapterFiles = files
      .filter(f => /^chapter_\d+\.md$/.test(f))
      .sort((a, b) => {
        const numA = parseInt(a.match(/chapter_(\d+)\.md/)[1]);
        const numB = parseInt(b.match(/chapter_(\d+)\.md/)[1]);
        return numA - numB;
      });
    
    for (const file of chapterFiles) {
      const filePath = path.join(sessionDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const chapterNum = parseInt(file.match(/chapter_(\d+)\.md/)[1]);
      
      // 提取第一章标题（如果有）
      const titleMatch = content.match(/^#\s+(.+)$/m);
      const title = titleMatch ? titleMatch[1] : `第${chapterNum}章`;
      
      chapters.push({
        file,
        content,
        chapterNum,
        title
      });
    }
    
    console.log(`✅ 找到 ${chapters.length} 个章节文件`);

    // 🔧 回退：无 markdown 章节文件时，从小说数据库读取（novelWriter 现行存储方式）
    if (chapters.length === 0) {
      return await readChaptersFromDb(dbPath);
    }

    return chapters;
  } catch (error) {
    console.error('❌ 读取章节文件失败:', error.message);
    return [];
  }
}

/**
 * 构建 SSH 连接配置（密码 / 私钥文件 / 免密公钥三选一）
 * @param {Object} config - 服务器配置
 * @returns {Object} ssh2 连接配置
 */
function buildConnectConfig(config) {
  const connectConfig = {
    host: config.host,
    port: config.port || 22,
    username: config.user
  };

  // 使用密码、私钥文件或免密公钥
  if (config.keyAuth) {
    // 免密登录：仅使用 SSH agent（私钥不离开 agent，更安全）
    const agentSock = process.env.SSH_AUTH_SOCK;
    if (!agentSock) {
      throw new Error('SSH_AUTH_SOCK 未设置，无法使用 SSH agent 免密登录。请确保 ssh-agent 正在运行并已添加私钥（ssh-add）');
    }
    connectConfig.agent = agentSock;
  } else if (config.privateKey) {
    connectConfig.privateKey = fs.readFileSync(config.privateKey);
  } else if (config.password) {
    connectConfig.password = config.password;
  }

  return connectConfig;
}

/**
 * 递归创建远程目录（ssh2 的 mkdir 不支持 recursive，逐级创建并忽略"已存在"错误）
 * @param {Object} sftp - SFTP 会话
 * @param {string} dir - 远程目录绝对路径
 * @param {Function} cb - 完成回调
 */
function ensureRemoteDir(sftp, dir, cb) {
  const segments = String(dir).split('/').filter(Boolean);
  const absolute = String(dir).startsWith('/');
  let current = absolute ? '' : '.';

  const mkNext = (i) => {
    if (i >= segments.length) {
      cb();
      return;
    }
    current = absolute ? `${current}/${segments[i]}` : (current === '.' ? segments[i] : `${current}/${segments[i]}`);
    sftp.mkdir(current, () => {
      // 忽略"目录已存在"等错误，继续创建下一层
      mkNext(i + 1);
    });
  };

  mkNext(0);
}

/**
 * 上传文件到服务器指定目录
 * @param {Object} config - 服务器配置
 * @param {Array} files - 文件列表 [{filename, localPath}]
 * @param {string} remoteDir - 远程目标目录（默认为 config.directory）
 * @returns {Promise}
 */
function uploadToServer(config, files, remoteDir) {
  const targetDir = remoteDir || config.directory;
  return new Promise((resolve, reject) => {
    const conn = new Client();
    
    conn.on('ready', () => {
      console.log('✅ SSH连接成功');
      
      conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP连接失败: ${err.message}`));
          return;
        }
        
        console.log('✅ SFTP连接成功');
        
        let uploadedCount = 0;
        const totalFiles = files.length;
        // 上传失败必须影响整体结果：以前失败只记日志、最后仍报“✅ 全部完成”，
        // 造成“发布成功但文件不在”的静默丢失（实际事故：阅读模式资源消失，页面朗读栏不见）
        const failures = [];
        
        // 递归确保目标目录存在（如 <directory>/<小说名>）
        ensureRemoteDir(sftp, targetDir, () => {
          // 上传每个文件
          const uploadNext = () => {
            if (uploadedCount >= totalFiles) {
              if (failures.length > 0) {
                console.error(`\n❌ 上传失败 ${failures.length}/${totalFiles} 个文件：`);
                failures.forEach((f) => console.error(`   - ${f}`));
                conn.end();
                reject(new Error(`上传失败 ${failures.length}/${totalFiles}：${failures.join('; ')}`));
                return;
              }
              console.log(`\n✅ 所有文件上传完成 (${totalFiles}/${totalFiles})`);
              conn.end();
              resolve();
              return;
            }
            
            const file = files[uploadedCount];
            const remotePath = path.posix.join(targetDir, file.filename);
            
            console.log(`📤 上传 ${file.filename}...`);
            
            sftp.fastPut(
              file.localPath,
              remotePath,
              (err) => {
                if (err) {
                  console.error(`❌ 上传失败 ${file.filename}:`, err.message);
                  failures.push(`${file.filename}: ${err.message}`);
                } else {
                  console.log(`✅ 已上传 ${file.filename}`);
                }
                
                uploadedCount++;
                uploadNext();
              }
            );
          };
          
          uploadNext();
        });
      });
    });
    
    conn.on('error', (err) => {
      reject(new Error(`SSH连接错误: ${err.message}`));
    });
    
    console.log(`🔌 连接到 ${config.host}...`);
    conn.connect(buildConnectConfig(config));
  });
}

/**
 * 同步阅读模式（TTS）静态资源到服务器 <directory>/tts/
 * 无条件覆盖上传（仅数个 KB 级文件），保证服务器上的实现始终等于本地源码：
 * 调整阅读界面/逻辑后只需跑一次同步，全部历史章节页即时生效，无需重新发布小说
 * @param {Object} config - 服务器配置（需含 directory 与认证信息）
 * @returns {Promise<Array<string>>} 已同步的文件名列表
 */
async function syncTtsAssets(config) {
  const assetDir = path.join(__dirname, 'assets', 'tts');
  if (!fs.existsSync(assetDir)) {
    throw new Error(`阅读模式资源目录不存在: ${assetDir}`);
  }
  const files = fs.readdirSync(assetDir)
    .filter((f) => /\.(js|css)$/.test(f))
    .sort()
    .map((f) => ({ filename: f, localPath: path.join(assetDir, f) }));
  if (files.length === 0) {
    throw new Error(`阅读模式资源目录为空: ${assetDir}`);
  }
  const remoteDir = path.posix.join(config.directory, 'tts');
  console.log(`\n🔊 同步阅读模式资源到 ${remoteDir}...`);
  await uploadToServer(config, files, remoteDir);
  // 落地校验：资源缺失等于全站朗读不可用，不能只信上传日志（必须远端 stat 存在与本地同尺寸）
  await verifyRemoteAssets(config, remoteDir, files);
  return files.map((f) => f.filename);
}

/**
 * 只读校验远端阅读模式资源是否在位（不上传、不修改任何东西）。
 * 资源丢失时章节页只会“看得到正文、没有朗读栏”，很容易被误判为代码问题，
 * 所以提供一条确定性检查入口
 * @param {Object} config - 服务器配置（含 directory 与认证信息）
 * @returns {Promise<Array<string>>} 已确认在位的文件名
 */
async function checkTtsAssets(config) {
  const assetDir = path.join(__dirname, 'assets', 'tts');
  if (!fs.existsSync(assetDir)) {
    throw new Error(`阅读模式资源目录不存在: ${assetDir}`);
  }
  const files = fs.readdirSync(assetDir)
    .filter((f) => /\.(js|css)$/.test(f))
    .sort()
    .map((f) => ({ filename: f, localPath: path.join(assetDir, f) }));
  const remoteDir = path.posix.join(config.directory, 'tts');
  console.log(`\n🔎 校验阅读模式资源：${remoteDir}`);
  await verifyRemoteAssets(config, remoteDir, files);
  console.log('✅ 资源全部在位，章节页朗读模式可用');
  return files.map((f) => f.filename);
}

/**
 * 逐个校验远端文件确实存在且尺寸与本地一致，不符则抛错
 * @param {Object} config - 服务器配置
 * @param {string} remoteDir - 远端目录
 * @param {Array<{filename:string,localPath:string}>} files - 待验文件
 */
function verifyRemoteAssets(config, remoteDir, files) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP 连接失败（无法校验资源）: ${err.message}`));
          return;
        }
        const problems = [];
        let i = 0;
        const checkNext = () => {
          if (i >= files.length) {
            conn.end();
            if (problems.length > 0) {
              reject(new Error(`阅读模式资源落地校验失败：${problems.join('; ')}`));
            } else {
              resolve();
            }
            return;
          }
          const { filename, localPath } = files[i++];
          const remotePath = path.posix.join(remoteDir, filename);
          sftp.stat(remotePath, (statErr, st) => {
            const localSize = fs.statSync(localPath).size;
            if (statErr) {
              problems.push(`${filename} 远端不存在`);
            } else if (st.size !== localSize) {
              problems.push(`${filename} 远端 ${st.size}B ≠ 本地 ${localSize}B`);
            } else {
              console.log(`  ✔ 已落地 ${filename} (${st.size}B)`);
            }
            checkNext();
          });
        };
        checkNext();
      });
    });
    conn.on('error', (err) => reject(new Error(`SSH 连接错误（无法校验资源）: ${err.message}`)));
    conn.connect(buildConnectConfig(config));
  });
}

/**
 * 刷新站点首页（小说列表页）
 * 枚举 <directory> 下的所有子目录（每个子目录即一本小说），
 * 按最近更新时间倒序生成列表并上传为 <directory>/index.html
 * @param {Object} config - 服务器配置
 * @param {string} tempDir - 本地临时目录（用于写入临时HTML）
 * @returns {Promise}
 */
function refreshSiteIndex(config, tempDir) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          reject(new Error(`SFTP连接失败: ${err.message}`));
          return;
        }

        sftp.readdir(config.directory, (err, list) => {
          if (err) {
            conn.end();
            reject(new Error(`读取远程目录列表失败: ${err.message}`));
            return;
          }

          // 只保留子目录（每个子目录是一本小说），按更新时间倒序
          // RESERVED_SITE_DIRS：站点级资源目录（阅读模式外链等）不是小说，
          // 不排除会把 <directory>/tts/ 当成一本可点开的小说列进首页
          const dirs = (list || [])
            .filter(e => !e.filename.startsWith('.'))
            .filter(e => !RESERVED_SITE_DIRS.has(e.filename))
            .filter(e => e.attrs && typeof e.attrs.isDirectory === 'function' && e.attrs.isDirectory())
            .sort((a, b) => (b.attrs.mtime || 0) - (a.attrs.mtime || 0));

          const novels = dirs.map(d => ({
            name: d.filename,
            url: `${encodeURIComponent(d.filename)}/index.html`,
            updatedText: d.attrs.mtime
              ? `更新于 ${new Date(d.attrs.mtime * 1000).toISOString().slice(0, 10)}`
              : ''
          }));

          const html = generateSiteIndex(novels);
          const localPath = path.join(tempDir, '_site_index.html');
          fs.writeFileSync(localPath, html, 'utf-8');

          ensureRemoteDir(sftp, config.directory, () => {
            sftp.fastPut(localPath, path.posix.join(config.directory, 'index.html'), (err) => {
              conn.end();
              if (err) {
                reject(new Error(`上传站点首页失败: ${err.message}`));
                return;
              }
              console.log(`✅ 站点首页（小说列表）已更新，共 ${novels.length} 本小说`);
              resolve();
            });
          });
        });
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`SSH连接错误: ${err.message}`));
    });

    console.log(`\n🔌 连接到 ${config.host} 更新站点首页...`);
    conn.connect(buildConnectConfig(config));
  });
}

/**
 * 解析小说数据库路径
 * - 绝对路径 / ~ 路径：统一解析器展开
 * - 相对路径：exec 的 cwd 是 session 目录，故同时尝试「cwd 基准」与「项目根目录基准」
 *   （如 workspace/agents/writer/data/xxx.db），取实际存在的一个；都不存在时返回 cwd 基准路径
 * @param {string} input - LLM 传入的数据库路径
 * @returns {string} 绝对路径
 */
function resolveNovelDbPath(input) {
  const cwdBased = resolveSkillPath(input, {}).fullPath;
  if (path.isAbsolute(input) || input.startsWith('~')) {
    return cwdBased;
  }
  if (fs.existsSync(cwdBased)) {
    return cwdBased;
  }
  // 项目根目录基准（publish.js 位于 src/skills/novelPublisher/，向上 3 级）
  const rootBased = path.resolve(__dirname, '..', '..', '..', input);
  if (fs.existsSync(rootBased)) {
    return rootBased;
  }
  return cwdBased;
}

/**
 * 收集 agent 数据目录（workspace/agents/{agent}/data/）下所有非空小说库信息。
 * 空库（无 no=0 标题行且无正文章节，如历史遗留的 writer.db/novel.db 空文件）会被过滤，
 * 避免干扰唯一性判断。
 * @returns {Promise<Array<{dbPath: string, name: string|null, file: string, chapters: number}>>}
 */
async function collectNovelDbInfos() {
  const rootDir = path.resolve(__dirname, '..', '..', '..');
  // agents 目录：优先读 gala.json 的 folders.agents，默认 workspace/agents
  let agentsRel = 'workspace/agents';
  try {
    const galaJsonPath = path.join(rootDir, 'gala.json');
    if (fs.existsSync(galaJsonPath)) {
      const cfg = JSON.parse(fs.readFileSync(galaJsonPath, 'utf-8'));
      if (cfg?.folders?.agents) agentsRel = cfg.folders.agents;
    }
  } catch { /* 用默认值 */ }
  const agentsDir = path.isAbsolute(agentsRel) ? agentsRel : path.join(rootDir, agentsRel);
  if (!fs.existsSync(agentsDir)) return [];

  // 收集所有 agent 数据目录下的 .db 文件
  const candidates = [];
  for (const agentName of fs.readdirSync(agentsDir)) {
    const dataDir = path.join(agentsDir, agentName, 'data');
    if (!fs.existsSync(dataDir)) continue;
    for (const f of fs.readdirSync(dataDir)) {
      if (f.endsWith('.db')) candidates.push(path.join(dataDir, f));
    }
  }
  if (candidates.length === 0) return [];

  // 读取每个库的小说名（no=0 的 name 字段）与正文章节数
  const Database = (await import('better-sqlite3')).default;
  const infos = [];
  for (const dbPath of candidates) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const row = db.prepare('SELECT name FROM content WHERE no = 0').get();
      const cnt = db.prepare("SELECT COUNT(*) AS n FROM content WHERE no > 0 AND content IS NOT NULL AND TRIM(content) != ''").get();
      db.close();
      const name = row?.name || null;
      const chapters = cnt?.n || 0;
      if (!name && chapters === 0) continue; // 跳过空库
      infos.push({ dbPath, name, file: path.basename(dbPath, '.db'), chapters });
    } catch { /* 跳过无法读取的库 */ }
  }
  return infos;
}

/**
 * 在 agent 数据目录（workspace/agents/{agent}/data/）中自动发现小说数据库。
 * 用于 LLM 未显式传 dbPath 时的自愈：优先按小说标题（content 表 no=0 的 name）匹配，
 * 其次按文件名匹配；若仅有一个候选库则直接采用。
 * @param {string} [title] - 小说标题（可选，用于精确匹配）
 * @returns {Promise<string|null>} 匹配到的 db 绝对路径，或 null
 */
async function discoverAgentNovelDb(title) {
  const infos = await collectNovelDbInfos();
  if (infos.length === 0) return null;

  const wanted = String(title || '').trim();
  if (wanted) {
    // 精确匹配小说名 → 文件名 → 宽松包含匹配
    const byName = infos.find(i => i.name === wanted);
    if (byName) return byName.dbPath;
    const byFile = infos.find(i => i.file === wanted);
    if (byFile) return byFile.dbPath;
    const loose = infos.find(i => (i.name && i.name.includes(wanted)) || (i.name && wanted.includes(i.name)));
    if (loose) return loose.dbPath;
  }
  // 无标题或匹配不到：仅一个候选库时直接采用，避免歧义
  if (infos.length === 1) return infos[0].dbPath;
  return null;
}

/**
 * 计算内容哈希（增量发布的比对依据）
 * @param {string} content - 文件内容
 * @returns {string} sha256 十六进制哈希
 */
function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
}

/**
 * 从小说数据库加载上一次的发布状态（publish_state 表：filename → content_hash）
 * @param {string} dbPath - 小说数据库路径
 * @returns {Promise<Object|null>} 文件名→哈希 的映射；无数据库或首次发布时返回 null（全量上传）
 */
async function loadPublishManifest(dbPath) {
  if (!dbPath || !fs.existsSync(dbPath)) return null;
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS publish_state (
        filename TEXT PRIMARY KEY,           -- 已发布的文件名（chapter_<id>.html / page_<id>.html / index.html）
        content_hash TEXT NOT NULL,          -- 上次发布时的内容哈希
        published_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const rows = db.prepare('SELECT filename, content_hash FROM publish_state').all();
    db.close();
    const manifest = {};
    for (const r of rows) manifest[r.filename] = r.content_hash;
    return manifest;
  } catch (error) {
    console.warn(`⚠️  读取发布状态失败，将全量上传: ${error.message}`);
    return null;
  }
}

/**
 * 发布成功后保存本次发布状态（先清空再写入当前全量文件清单）
 * @param {string} dbPath - 小说数据库路径
 * @param {Array} entries - [{filename, contentHash}]
 */
async function savePublishManifest(dbPath, entries) {
  if (!dbPath || !fs.existsSync(dbPath)) return;
  try {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS publish_state (
        filename TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        published_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const tx = db.transaction(() => {
      db.exec('DELETE FROM publish_state');
      const ins = db.prepare('INSERT INTO publish_state (filename, content_hash) VALUES (?, ?)');
      for (const e of entries) ins.run(e.filename, e.contentHash);
    });
    tx();
    db.close();
  } catch (error) {
    console.warn(`⚠️  保存发布状态失败（不影响本次发布结果）: ${error.message}`);
  }
}

/**
 * 删除远程目录中的孤儿文件（章节被删除/重命名后遗留的旧 HTML）
 * @param {Object} config - 服务器配置
 * @param {string} remoteDir - 远程目录
 * @param {Array<string>} filenames - 待删除的文件名列表
 * @returns {Promise}
 */
function deleteRemoteFiles(config, remoteDir, filenames) {
  return new Promise((resolve, reject) => {
    if (filenames.length === 0) {
      resolve();
      return;
    }
    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          reject(new Error(`SFTP连接失败: ${err.message}`));
          return;
        }

        let i = 0;
        const deleteNext = () => {
          if (i >= filenames.length) {
            console.log(`🧹 已清理 ${filenames.length} 个远程遗留文件`);
            conn.end();
            resolve();
            return;
          }
          const remotePath = path.posix.join(remoteDir, filenames[i]);
          sftp.unlink(remotePath, (unlinkErr) => {
            if (unlinkErr) {
              console.warn(`⚠️  删除远程文件失败 ${filenames[i]}: ${unlinkErr.message}`);
            } else {
              console.log(`🗑️  已删除远程旧文件 ${filenames[i]}`);
            }
            i++;
            deleteNext();
          });
        };
        deleteNext();
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`SSH连接错误: ${err.message}`));
    });

    conn.connect(buildConnectConfig(config));
  });
}

/**
 * 以远程目录实际内容为准清理孤儿页面：存在于小说目录下、匹配 chapter_*.html / page_*.html、
 * 但不在本次发布清单中的文件。
 * 只靠本地 publish_state 比对发现不了旧命名方案（chapter_01.html 这类）遗留的文件，
 * 所以必须看远程实际目录。涵盖 page_*.html 是为了“删了某部 / 重设结构”后旧导言页也能被自动删除。
 * 直接删除：这些文件都是数据库内容的旧渲染产物（旧命名方案、旧正文或已删的部），
 * 任何页面都不再链接它们，内容随时可从库重新生成；留着只会让旧链接指向过时版本。
 * @param {Object} config - 服务器配置
 * @param {string} novelDir - 本篇小说的远程目录
 * @param {Array<string>} keepFilenames - 本次发布清单内的文件名
 * @returns {Promise<{pruned: Array<string>}>} pruned = 被删的孤儿文件名
 */
function pruneRemoteOrphanPages(config, novelDir, keepFilenames) {
  return new Promise((resolve, reject) => {
    const conn = new Client();
    const keep = new Set(keepFilenames);

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          reject(new Error(`SFTP连接失败（无法检查远程目录）: ${err.message}`));
          return;
        }

        sftp.readdir(novelDir, (readErr, list) => {
          if (readErr) {
            conn.end();
            reject(new Error(`读取远程章节目录失败: ${readErr.message}`));
            return;
          }

          const remoteFiles = (list || [])
            .filter((e) => e.attrs && typeof e.attrs.isFile === 'function' && e.attrs.isFile())
            .map((e) => e.filename);
          const orphans = remoteFiles
            .filter((fn) => /^(chapter|page)_.*\.html$/.test(fn) && !keep.has(fn));

          if (orphans.length === 0) {
            console.log('\n🧹 远程小说目录无孤儿页面');
            conn.end();
            resolve({ pruned: [] });
            return;
          }

          console.log(`\n🧹 发现 ${orphans.length} 个孤儿页面（旧命名/旧内容/已删的部遗留），直接删除`);
          orphans.forEach((fn) => console.log(`   - ${fn}`));

          // 逐个 unlink，失败必须收集并影响结果（不允许“报了清理但实际还在”）
          const failures = [];
          let idx = 0;
          const deleteNext = () => {
            if (idx >= orphans.length) {
              if (failures.length > 0) {
                conn.end();
                reject(new Error(`删除孤儿文件失败 ${failures.length}/${orphans.length}：${failures.join('; ')}`));
                return;
              }
              // 落地校验：删完后回读目录确认这些文件确实不存在
              sftp.readdir(novelDir, (reErr, reList) => {
                conn.end();
                if (reErr) {
                  reject(new Error(`孤儿清理校验失败: ${reErr.message}`));
                  return;
                }
                const reFiles = (reList || []).map((e) => e.filename);
                const still = reFiles.filter((fn) => orphans.includes(fn));
                if (still.length > 0) {
                  reject(new Error(`孤儿文件删除后仍存在：${still.join(', ')}`));
                  return;
                }
                console.log(`✅ 已删除 ${orphans.length} 个孤儿页面`);
                resolve({ pruned: orphans });
              });
              return;
            }
            const fn = orphans[idx];
            sftp.unlink(path.posix.join(novelDir, fn), (unlinkErr) => {
              if (unlinkErr) failures.push(`${fn}: ${unlinkErr.message}`);
              idx++;
              deleteNext();
            });
          };
          deleteNext();
        });
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`SSH连接错误（无法清理孤儿文件）: ${err.message}`));
    });

    conn.connect(buildConnectConfig(config));
  });
}

/**
 * 以远程文件实际内容为准核对本地清单：逐个读取远程页面正文算内容哈希，与本次渲染结果不一致
 * （或远程根本不存在）的即为需重传的页面。
 * 本地 publish_state 只是记账，一旦被回退（从备份还库）或与实际上传结果脱节，
 * 增量判断就会跳过本该重传的文件 —— 表现为链接指向旧版页面或直接 404。
 * 只比字节数不够：实测过一次部导言页换了 id（16 位十六进制等长），
 * 设定页里指向它的链接长度分毫未变而内容已坏。
 * @param {Object} config - 服务器配置
 * @param {string} novelDir - 本篇小说的远程目录
 * @param {Array<{filename:string,contentHash:string}>} candidates - 本次判定为“无需上传”的文件
 * @returns {Promise<Array<{filename:string,reason:string}>>} 远程缺失或与本次渲染不一致的文件
 */
function auditRemotePages(config, novelDir, candidates) {
  return new Promise((resolve, reject) => {
    const conn = new Client();

    conn.on('ready', () => {
      conn.sftp((err, sftp) => {
        if (err) {
          conn.end();
          reject(new Error(`SFTP连接失败（无法核对远程内容）: ${err.message}`));
          return;
        }
        const stale = [];
        let idx = 0;
        const checkNext = () => {
          if (idx >= candidates.length) {
            conn.end();
            resolve(stale);
            return;
          }
          const { filename, contentHash } = candidates[idx++];
          // createReadStream 而非 sftp.read：后者单次有长度上限，整页正文需自己拼包
          const stream = sftp.createReadStream(path.posix.join(novelDir, filename));
          const chunks = [];
          stream.on('data', (c) => chunks.push(c));
          stream.on('error', () => {
            stale.push({ filename, reason: '远程不存在或读取失败' });
            checkNext();
          });
          stream.on('end', () => {
            const remoteHash = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
            if (remoteHash !== contentHash) stale.push({ filename, reason: '远程内容与本次渲染不一致' });
            checkNext();
          });
        };
        checkNext();
      });
    });

    conn.on('error', (err) => {
      reject(new Error(`SSH连接错误（无法核对远程内容）: ${err.message}`));
    });

    conn.connect(buildConnectConfig(config));
  });
}

/**
 * 主函数：发布小说
 * @param {string} sessionDir - session目录路径
 * @param {Object} serverConfig - 服务器配置 {host, port, user, password/pass, directory, siteUrl}
 * @param {Object} options - 可选参数 {title, dbPath, syncAssetsOnly, checkAssetsOnly, dryRun}（dbPath: 小说数据库路径，未传时按 title 自动在 agent 数据目录定位；定位不到直接报错。syncAssetsOnly: 仅同步阅读模式资源，不发布任何章节。checkAssetsOnly: 只读校验资源是否在位。dryRun: 只生成本地 HTML，不连接服务器、不写发布状态）
 * @returns {Promise<Object>} 发布结果
 */
export async function publishNovel(sessionDir, serverConfig, options = {}) {
  // 只读校验模式：不改动远端任何文件，只确认阅读模式资源是否在位
  if (options.checkAssetsOnly) {
    const checkedFiles = await checkTtsAssets(serverConfig);
    return { success: true, checkAssets: true, checkedFiles, remoteAssetDir: `${serverConfig.directory}/tts` };
  }

  if (options.syncAssetsOnly) {
    const syncedFiles = await syncTtsAssets(serverConfig);
    console.log(`\n✅ 阅读模式资源已同步（${syncedFiles.join(', ')}），未改动任何章节文件`);
    return { success: true, syncAssets: true, syncedFiles, remoteAssetDir: `${serverConfig.directory}/tts` };
  }

  // 统一路径解析：~ 展开 + 相对路径基于 process.cwd() 解析（exec 工具的 cwd 即为 session 目录）
  sessionDir = resolveSkillPath(sessionDir, {}).fullPath;

  // 存在性预检：session 目录不存在时立即抛出明确错误（附相似条目提示）
  const dirCheck = await checkPath(sessionDir, { mustExist: true, kind: 'dir' });
  if (!dirCheck.ok) {
    throw new Error(dirCheck.error);
  }

  console.log('📚 开始发布小说...');
  console.log(`📁 Session目录: ${sessionDir}`);
  console.log(`🌐 服务器: ${serverConfig.host}`);
  console.log('');

  // 兼容 pass/password 两种字段名
  if (serverConfig.pass !== undefined && serverConfig.password === undefined) {
    serverConfig.password = serverConfig.pass;
  }

  // 步骤1: 读取章节文件（优先 chapter_XX.md，回退小说数据库）
  // 数据库路径解析优先级：
  //   1) 显式传入的 dbPath（统一管理位置 workspace/agents/{agent}/data/ 下的小说库）
  //   2) 自愈：按小说标题自动在 agent 数据目录发现对应小说库（LLM 漏传 dbPath 时兜底）
  //   定位不到时不再回退 sessionDir/writer.db（旧约定已废弃），直接报错并列出候选库
  let novelDbPath;
  if (options.dbPath) {
    novelDbPath = resolveNovelDbPath(options.dbPath);
  } else {
    const discovered = await discoverAgentNovelDb(options.title);
    if (discovered) {
      console.log(`🔍 未传 dbPath，已按标题「${options.title || '(未知)'}」自动定位小说库: ${discovered}`);
      novelDbPath = discovered;
    }
  }
  const chapters = await readChapterFiles(sessionDir, novelDbPath);

  if (chapters.length === 0) {
    // 附上 session 目录实际内容，便于定位文件命名/位置问题
    let dirListing = '';
    try {
      dirListing = fs.readdirSync(sessionDir).join(', ');
    } catch { /* ignore */ }
    // 未定位到小说库时，列出候选小说库，便于调用方带 title/dbPath 重试
    let dbHint;
    if (novelDbPath) {
      dbHint = `。提示: 小说库 ${novelDbPath} 中无正文章节`;
    } else {
      const infos = await collectNovelDbInfos();
      if (infos.length > 1) {
        dbHint = `。agent 数据目录中存在 ${infos.length} 个小说库，无法唯一确定，请在 JSON 参数中补传 title（或 dbPath）后重试：\n` +
          infos.map(i => `  - ${i.name || i.file}（${i.chapters} 章）: ${i.dbPath}`).join('\n');
      } else if (infos.length === 1) {
        dbHint = `。提示: 请通过 dbPath 参数传入小说库路径（如 ${infos[0].dbPath}）`;
      } else {
        dbHint = '。提示: agent 数据目录下未发现任何小说库，请先用 novelWriter 生成章节';
      }
    }
    throw new Error(
      `未找到章节数据（session 目录无 chapter_XX.md，且未能定位有效小说库），session 目录: ${sessionDir}` +
      (dirListing ? `，目录内容: ${dirListing}` : '（目录为空）') + dbHint
    );
  }
  
  // 步骤2: 创建临时目录
  const tempDir = path.join(__dirname, 'temp_publish');
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }
  
  // 步骤3: 转换并保存HTML文件
  console.log('\n🔄 转换Markdown为HTML...');
  const files = [];
  
  // 提取小说标题（优先使用传入的 title，其次从小说数据库读取，最后兜底"小说"）
  let novelTitle = options.title || (await readNovelTitleFromDb(novelDbPath)) || '小说';

  // 每本小说发布到独立子目录：<directory>/<小说名>/，站点首页为小说列表
  const novelDir = sanitizeDirName(novelTitle);
  const targetDir = path.posix.join(serverConfig.directory, novelDir);

  console.log(`📖 小说标题: ${novelTitle}`);
  console.log(`📁 远程小说目录: ${targetDir}`);

  // 生成章节HTML（文件名使用稳定章节ID，插入/删除/重排章节不会改变已有文件名）
  // 旧版 chapter_XX.md 来源无稳定 id，以源文件名的 md5 作保底（同一文件始终映射同一文件名）
  const stableIds = chapters.map(c =>
    c.id || crypto.createHash('md5').update(c.file).digest('hex').slice(0, 16)
  );

  // 附加页数据：“本书设定”与各部导言
  // 章节来自 session markdown（无稳定 id）时不读分部结构：库是唯一权威来源，
  // 文件集对不上库里的 part_no，此时只按单层章节发布
  const fromWriterDb = chapters.every(c => c.id);
  const structure = fromWriterDb
    ? await readNovelStructureFromDb(novelDbPath)
    : { preface: null, parts: [] };
  const partViews = buildPartViews(structure.parts, chapters);
  const partByNo = new Map(partViews.map(p => [p.no, p]));
  if (structure.preface) {
    console.log(`🧾 本书设定: 已有（${structure.preface.text.length} 字）`);
  }
  if (partViews.length > 0) {
    console.log(`📚 分部: ${partViews.map(p => `${p.label}（第${p.startNo}–${p.endNo}章）`).join('、')}`);
  }

  // 页面序列：本书设定 → 第一部导言 → 第1章… → 第二部导言 → 第N+1章…
  // 页序只决定 prev/next 导航与朗读连读顺序；章节显示序号仍按整体 i+1，
  // 不会因为前面插了附加页而改变
  const sequence = [];
  if (structure.preface) {
    sequence.push({
      kind: 'preface',
      filename: `page_${structure.preface.id}.html`,
      label: '本书设定',
      title: `${novelTitle} - 本书设定`,
      markdown: `# 本书设定\n\n${stripLeadingHeading(structure.preface.text)}`
    });
  }

  const seenParts = new Set();
  chapters.forEach((chapter, i) => {
    const part = partByNo.get(Number(chapter.partNo) || 0) || null;

    // 本部首篇已发布章节前插入导言页（本部章节全部未发布时导言页自然不产出）
    if (part && part.introUrl && !seenParts.has(part.no)) {
      seenParts.add(part.no);
      sequence.push({
        kind: 'partIntro',
        filename: part.introUrl,
        label: `${part.label} · 导言`,
        title: `${novelTitle} - ${part.label} · 导言`,
        markdown: `# ${part.label} · 导言\n\n${stripLeadingHeading(part.summary)}`
      });
    }

    // 以实际章节序号重建大标题，剥离正文中原有的（可能错误的）"第X章"标题
    let bareTitle = stripChapterPrefix(chapter.title);
    // 标题仅剩"第X章"这种保底形式时视为无标题
    if (/^第\s*[0-9一二三四五六七八九十百零两]+\s*章$/.test(bareTitle)) {
      bareTitle = '';
    }
    const displayTitle = bareTitle ? `第${i + 1}章：${bareTitle}` : `第${i + 1}章`;
    // 分部章节在标题下加一行浅色小标；.tts-skip 使其只展示、不进入朗读文本
    const kicker = part ? `<p class="part-kicker tts-skip">${escapeHtml(part.label)}</p>\n\n` : '';

    sequence.push({
      kind: 'chapter',
      filename: `chapter_${stableIds[i]}.html`,
      label: displayTitle,
      title: `${novelTitle} - ${displayTitle}`,
      chapterNum: i + 1,
      partNo: part ? part.no : 0,
      chapterText: chapter.content,
      markdown: `# ${displayTitle}\n\n${kicker}${stripLeadingHeading(chapter.content)}`
    });
  });

  // 逐页渲染：导航指向序列中的相邻页（章节页与附加页同构，同样可点开、可朗读）
  for (let s = 0; s < sequence.length; s++) {
    const page = sequence[s];
    const prevUrl = s > 0 ? sequence[s - 1].filename : null;
    const nextUrl = s < sequence.length - 1 ? sequence[s + 1].filename : null;
    const navHtml = buildChapterNav(prevUrl, nextUrl);

    const htmlContent = markdownToHtml(page.markdown, page.title, navHtml);
    const localPath = path.join(tempDir, page.filename);
    fs.writeFileSync(localPath, htmlContent, 'utf-8');

    files.push({
      filename: page.filename,
      localPath,
      url: page.filename,
      kind: page.kind,
      title: page.label,
      chapterNum: page.chapterNum,
      partNo: page.partNo,
      contentHash: hashContent(htmlContent)
    });

    console.log(`  ✅ ${page.filename} (${page.label})`);
  }

  const chapterPages = files.filter(f => f.kind === 'chapter');
  const prefacePage = files.find(f => f.kind === 'preface') || null;

  // 生成索引页面
  const indexContent = generateIndex(chapterPages, novelTitle, {
    prefaceUrl: prefacePage ? prefacePage.filename : null,
    parts: partViews
  });
  const indexLocalPath = path.join(tempDir, 'index.html');
  fs.writeFileSync(indexLocalPath, indexContent, 'utf-8');

  files.unshift({
    filename: 'index.html',
    localPath: indexLocalPath,
    url: 'index.html',
    kind: 'index',
    contentHash: hashContent(indexContent)
  });

  console.log(`  ✅ index.html`);
  const extraPageCount = files.filter(f => f.kind === 'preface' || f.kind === 'partIntro').length;
  console.log(`\n📦 共生成 ${files.length} 个HTML文件（章节 ${chapterPages.length} 篇，附加页 ${extraPageCount} 篇，目录页 1 篇）`);

  // dry-run：只生成本地 HTML，不连接服务器、不写发布状态。
  // 用于发布前核对页面序列、prev/next 链与目录分组（产物留在 tempDir，核对完删掉）
  if (options.dryRun) {
    console.log(`\n🧪 dry-run：未连接服务器、未改动远端任何文件，产物保留在 ${tempDir}`);
    return {
      success: true,
      dryRun: true,
      tempDir,
      novelDir,
      pages: files.map(f => ({ filename: f.filename, kind: f.kind, title: f.title || null, partNo: f.partNo || null })),
      chapterCount: chapters.length,
      prefacePublished: !!prefacePage,
      partCount: partViews.length,
      fileCount: files.length
    };
  }

  // 步骤4: 增量上传（对比上次发布状态 publish_state，只上传内容有变化的文件）
  const manifest = await loadPublishManifest(novelDbPath);
  const currentFilenames = new Set(files.map(f => f.filename));
  let toUpload;
  let toDelete = [];
  if (manifest) {
    toUpload = files.filter(f => manifest[f.filename] !== f.contentHash);
    // 远程遗留文件：上次发布过、本次清单中已不存在的文件（章节被删除等场景）
    toDelete = Object.keys(manifest).filter(fn => fn.endsWith('.html') && !currentFilenames.has(fn));
  } else {
    toUpload = files; // 首次发布或无发布状态记录：全量上传
  }

  if (toUpload.length > 0 || toDelete.length > 0) {
    console.log(`\n📤 开始上传到服务器...（新增/变更 ${toUpload.length} 个，未变化跳过 ${files.length - toUpload.length} 个）`);
    await uploadToServer(serverConfig, toUpload, targetDir);

    // 清理远程孤儿文件（本地发布状态里记着的：上次发布过、本次已不存在）
    if (toDelete.length > 0) {
      await deleteRemoteFiles(serverConfig, targetDir, toDelete);
    }

    // 上传成功后持久化本次发布状态，作为下次增量比对依据
    await savePublishManifest(novelDbPath, files.map(f => ({ filename: f.filename, contentHash: f.contentHash })));
  } else {
    console.log('\n✅ 内容与上次发布完全一致，无需上传');
  }

  // 步骤4.5: 以远程实际目录为准清理孤儿页面（旧命名方案、已删除的部遗留的导言页本地状态无法发现）
  const orphanPrune = await pruneRemoteOrphanPages(serverConfig, targetDir, files.map(f => f.filename));

  // 步骤4.6: 自愈补传——本次判定为“无需上传”的文件，远程可能已被删掉或仍停在旧版
  //（publish_state 与实际不一致时，不补传就是静默 404 或指向旧内容）：
  // 记账与实际不一致时一律以远程内容为准，核对后补传并重写发布状态
  const uploadedNames = new Set(toUpload.map((f) => f.filename));
  const stalePages = await auditRemotePages(serverConfig, targetDir,
    files.filter((f) => !uploadedNames.has(f.filename)));
  if (stalePages.length > 0) {
    console.log(`\n🔁 远程与本次渲染不一致 ${stalePages.length} 个（本地发布状态认为无需上传），补传:`);
    stalePages.forEach((p) => console.log(`   - ${p.filename}：${p.reason}`));
    await uploadToServer(serverConfig,
      stalePages.map((p) => files.find((f) => f.filename === p.filename)).filter(Boolean), targetDir);
    await savePublishManifest(novelDbPath, files.map((f) => ({ filename: f.filename, contentHash: f.contentHash })));
  }

  // 步骤5: 刷新站点首页（小说列表 <directory>/index.html）
  // 无条件执行：目录集合可能因清理、改名而变，首页必须反映最新状态
  await refreshSiteIndex(serverConfig, tempDir);

  // 步骤5.5: 同步阅读模式（TTS）资源到 <directory>/tts/
  // 无条件覆盖：章节内容未变时不会触发任何章节重传，因此调整阅读界面无需重发小说
  // 失败必须显式抛出：章节页引用 ../tts/reader.js，资源缺失等于阅读模式整体不可用
  const syncedFiles = await syncTtsAssets(serverConfig);

  // 步骤6: 生成访问链接
  // siteUrl 未配置时只能按 http://<host> 推测；站点若挂在子路径（如 nginx location /novel → alias 目标目录）则推测链接不准
  const siteUrlGuessed = !serverConfig.siteUrl;
  const siteUrl = (serverConfig.siteUrl || `http://${serverConfig.host}`).replace(/\/+$/, '');
  const homeUrl = `${siteUrl}/`;
  const novelUrl = `${siteUrl}/${encodeURIComponent(novelDir)}/index.html`;

  console.log('\n' + '='.repeat(60));
  console.log('✅ 发布成功！');
  console.log('='.repeat(60));
  if (siteUrlGuessed) {
    console.log('⚠️  未配置 siteUrl，以下链接按 http://<host> 推测，可能不准确：');
    console.log(`    若服务器 nginx 将站点挂在子路径（如 location /novel → alias ${serverConfig.directory}），`);
    console.log('    请在 Web 管理界面「Agent → 设定 → 发布配置 → 站点URL」补全，例如 http://<host>/novel');
  }
  console.log(`🏠 小说列表首页: ${homeUrl}`);
  console.log(`📖 本小说目录页: ${novelUrl}`);
  console.log(`📁 文件数量: ${files.length}（章节 ${chapterPages.length} / 附加页 ${extraPageCount}；本次上传 ${toUpload.length} 个，补传 ${stalePages.length} 个，清理旧文件 ${toDelete.length} 个，删除孤儿 ${orphanPrune.pruned.length} 个）`);
  console.log(`🔊 阅读模式资源: ${syncedFiles.join(', ')}（章节页外链，改界面不必重发小说）`);
  console.log(`📄 章节数量: ${chapters.length}${partViews.length > 0 ? `（分为 ${partViews.length} 部）` : ''}`);
  console.log(`🧾 本书设定页: ${prefacePage ? `已发布（${prefacePage.filename}）` : (structure.preface ? '跳过（无稳定 id）' : '无')}`);
  console.log('='.repeat(60));
  
  // 清理临时文件
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\n🧹 临时文件已清理');
  
  return {
    success: true,
    indexUrl: homeUrl,
    novelUrl,
    siteUrlGuessed,
    chapterCount: chapters.length,
    fileCount: files.length,
    // 附加页发布情况：供调用方（技能/对话）直接确认设定页与各部导言是否已上线
    prefacePublished: !!prefacePage,
    partCount: partViews.length,
    partIntroCount: files.filter(f => f.kind === 'partIntro').length,
    uploadedCount: toUpload.length,
    reUploadedCount: stalePages.length,
    removedCount: toDelete.length,
    orphanPrunedCount: orphanPrune.pruned.length,
    ttsAssetFiles: syncedFiles
  };
}

// CLI 入口：由 novelPublisher 技能通过 exec 工具调用
// 简化用法: node publish.js '{"sessionDir":"...","title":"...","directory":"..."}'
// 小说库在 agent 数据目录时追加 "dbPath":"..."（如 workspace/agents/writer/data/小说名.db）
// 服务器配置自动从 Agent 级发布配置加载（meta.json config.publish.servers，Web 管理界面「Agent → 设定」维护）
// 完整用法: node publish.js '{"sessionDir":"...","title":"...","serverName":"...","server":{"directory":"..."}}'
// 仅同步阅读模式资源（不动任何章节）: node publish.js '{"syncAssets":true,"agentName":"writer"}'
// 只读校验阅读模式资源是否在位: node publish.js '{"checkAssets":true,"agentName":"writer"}'
// 只本地渲染不发布（核对页序/导航/目录分组）: node publish.js '{"sessionDir":"...","dbPath":"...","dryRun":true}'

/** 项目根目录（publish.js 位于 src/skills/novelPublisher/，向上 3 级） */
function getProjectRoot() {
  return path.join(__dirname, '..', '..', '..');
}

/** Agent 数据目录（尊重 gala.json folders.agents 配置，默认 workspace/agents） */
function getAgentsDir() {
  try {
    const galaConfig = JSON.parse(fs.readFileSync(path.join(getProjectRoot(), 'gala.json'), 'utf-8'));
    const configured = galaConfig?.folders?.agents;
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.join(getProjectRoot(), configured);
    }
  } catch { /* gala.json 缺失时回退默认目录 */ }
  return path.join(getProjectRoot(), 'workspace', 'agents');
}

/**
 * 读取 Agent 级发布配置（meta.json 的 config.publish 节点）：{ servers, autoPublish, directory }
 * 服务器凭据由 Web 管理界面「Agent → 设定 → 发布配置」维护（全局系统配置入口已废除）
 * @param {string} agentName - Agent 名称（agents 目录下的目录名）
 * @returns {Object} 发布配置；不存在或读取失败时返回空对象
 */
export function loadPublishConfigFromAgentMeta(agentName) {
  if (!agentName) return {};
  try {
    const metaPath = path.join(getAgentsDir(), agentName, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    return meta?.config?.publish || {};
  } catch {
    return {};
  }
}

/**
 * 自动解析发布服务器配置（唯一来源：Agent 级 meta.json config.publish.servers）。
 * 候选 Agent 顺序：agentName 显式指定 → dbPath 归属推断 → 扫描全部 Agent。
 * @param {Object} [options]
 * @param {string} [options.agentName] - 显式指定的 Agent 名称
 * @param {string} [options.serverName] - 指定服务器名称（匹配 servers[].name），未匹配时取第一台
 * @param {string} [options.dbPath] - 小说数据库路径（用于推断归属 Agent）
 * @returns {{server: Object, directory: string, source: string}|null} 解析结果或 null
 */
export function resolveAutoPublishConfig({ agentName, serverName, dbPath } = {}) {
  const candidates = [];
  if (agentName) candidates.push(agentName);
  if (dbPath) {
    const m = String(dbPath).match(/agents[\/\\]([^\/\\]+)[\/\\]/);
    if (m && !candidates.includes(m[1])) candidates.push(m[1]);
  }
  // 扫描全部 Agent 目录，补充配置了发布服务器的（按目录名排序保证稳定）
  try {
    const agentsDir = getAgentsDir();
    if (fs.existsSync(agentsDir)) {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (candidates.includes(entry.name)) continue;
        const pub = loadPublishConfigFromAgentMeta(entry.name);
        if (Array.isArray(pub.servers) && pub.servers.length > 0) candidates.push(entry.name);
      }
    }
  } catch { /* 扫描失败忽略，返回 null 由调用方报错 */ }

  for (const name of candidates) {
    const pub = loadPublishConfigFromAgentMeta(name);
    const servers = Array.isArray(pub.servers) ? pub.servers : [];
    if (servers.length === 0) continue;
    const matched = serverName ? servers.find(s => s.name === serverName) : null;
    if (serverName && !matched) console.warn(`⚠️  Agent "${name}" 未找到名为 "${serverName}" 的服务器，使用第一台`);
    const chosen = matched || servers[0];
    return {
      server: { ...chosen },
      directory: pub.directory || chosen.directory || '',
      source: `Agent ${name} 发布配置`
    };
  }

  return null;
}

/**
 * 解析密码占位符（__PASSWORD_XXX → password.json 中的真实值）
 * 使 LLM 上下文中只出现占位符，不泄露真实密码
 */
export function resolveSecret(value) {
  if (typeof value !== 'string' || !value.startsWith('__')) return value;
  try {
    const pwdPath = path.join(__dirname, '..', '..', '..', 'password.json');
    const pwdConfig = JSON.parse(fs.readFileSync(pwdPath, 'utf-8'));
    const key = value.substring(2);
    const entry = pwdConfig[key];
    const resolved = entry?.value ?? entry;
    return (resolved === undefined || resolved === null) ? value : resolved;
  } catch {
    return value;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const rawArgs = process.argv[2];
    if (!rawArgs) {
      throw new Error('缺少 JSON 参数：{"sessionDir":"...","title?":"...","serverName?":"..."}');
    }

    let args;
    try {
      args = JSON.parse(rawArgs);
    } catch (parseErr) {
      // 尝试修复常见的 JSON 控制字符问题（如 title 中含未转义的换行符）
      const sanitized = rawArgs
        .replace(/[\x00-\x1f]/g, (ch) => {
          // 保留合法的 JSON 转义序列中的字符（不在字符串值内部时）
          if (ch === '\n') return '\\n';
          if (ch === '\r') return '\\r';
          if (ch === '\t') return '\\t';
          return '';
        });
      try {
        args = JSON.parse(sanitized);
        console.log('⚠️  JSON 参数含控制字符，已自动修复');
      } catch {
        throw new Error(`JSON 参数解析失败: ${parseErr.message}\n请确保参数是合法的 JSON 字符串`);
      }
    }

    if (!args.sessionDir && !args.syncAssets && !args.checkAssets) {
      throw new Error('缺少必填参数 sessionDir（章节文件所在目录的绝对路径）；若只需同步阅读模式资源，请传 {"syncAssets":true,"agentName":"writer"}，若只校验资源是否在位，请传 {"checkAssets":true,"agentName":"writer"}');
    }

    // dry-run 不需要真服务器：只本地渲染，不建立任何连接，因此用占位配置过校验
    if (args.dryRun && !args.server) {
      args.server = { host: 'dry-run.invalid', user: 'dry-run', password: 'dry-run', directory: '/dry-run' };
      console.log('🧪 dry-run：使用占位服务器配置，不会建立任何连接、不会上传任何文件');
    }

    // 服务器配置自动从 Agent 级发布配置加载（全局系统配置入口已废除）
    if (!args.server || !args.server.host) {
      const autoConfig = resolveAutoPublishConfig({ agentName: args.agentName, serverName: args.serverName, dbPath: args.dbPath });
      if (!autoConfig) {
        throw new Error('缺少服务器配置：请在 JSON 中提供 server 对象，或在 Agent 设定「发布配置」（Web 管理界面）中配置');
      }
      // 合并：自动配置为底，CLI 传入的字段覆盖
      args.server = {
        ...autoConfig.server,
        ...(args.server || {}),
      };
      // directory 可从 CLI 顶层参数或自动配置获取
      if (!args.server.directory) {
        args.server.directory = args.directory || autoConfig.directory;
      }
      if (!args.server.directory) {
        throw new Error('缺少 server.directory（目标目录）：请在 Agent 发布配置中设置目标目录，或在 JSON 参数中传 directory');
      }
      console.log(`📋 服务器配置已自动加载（${autoConfig.source}，${autoConfig.server.host}）`);
    }

    if (!args.server.host) throw new Error('缺少 server.host');
    if (!args.server.user) throw new Error('缺少 server.user');
    if (!args.server.password && !args.server.pass && !args.server.privateKey && !args.server.keyAuth) {
      throw new Error('缺少认证方式：server.password（SSH密码或其占位符）/ server.privateKey（私钥文件路径）/ server.keyAuth=true（免密公钥登录）');
    }
    if (!args.server.directory) throw new Error('缺少 server.directory（目标目录）');

    // 密码占位符自动解析为真实值
    args.server.password = resolveSecret(args.server.password);
    args.server.pass = resolveSecret(args.server.pass);

    const result = await publishNovel(args.sessionDir || '', args.server, {
      title: args.title,
      dbPath: args.dbPath,
      syncAssetsOnly: Boolean(args.syncAssets),
      checkAssetsOnly: Boolean(args.checkAssets),
      dryRun: Boolean(args.dryRun),
    });
    console.log('RESULT_JSON:' + JSON.stringify(result));
  } catch (error) {
    console.error(`❌ 发布失败: ${error.message}`);
    // 同时向 stdout 输出结构化错误 JSON，确保 LLM 能检测到失败
    const payload = 'RESULT_JSON:' + JSON.stringify({ success: false, error: error.message });
    // stdout 接管道时为异步写入，直接 process.exit(1) 会截断未刷出的 RESULT_JSON，
    // 导致上层 LLM 失去结构化失败信号（曾因此误报发布成功），必须等写入完成再退出
    if (process.stdout.write(payload + '\n')) {
      process.exit(1);
    } else {
      process.stdout.once('drain', () => process.exit(1));
    }
  }
}


// ─────────────────────────────────────────────────────────────
// ainovel 本地发布：复用上方章节页生成逻辑，直接写文件到 public/novel/
// 取代原 SSH 上传（方案 C：ainovel 本地服务直连，手机浏览器直接访问）
// ─────────────────────────────────────────────────────────────
/** 在章节页注入阅读器数据（如预生成的测试题），置于 reader.js 之前；转义 < 防止 </script> 截断 */
function injectReaderData(html, data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  const tag = `<script id="novel-reader-data" type="application/json">${json}</script>`;
  const marker = '<script src="/tts/reader.js"></script>';
  return html.includes(marker) ? html.replace(marker, tag + marker) : html.replace('</body>', tag + '</body>');
}

/**
 * 本地发布一本小说：从数据库读取章节，生成静态 HTML 写入 outRoot/<小说名>/
 * @param {string} dbPath - 小说库绝对路径
 * @param {string} outRoot - 输出根目录（ainovel/public/novel）
 * @param {Object} [options] - { title }
 * @returns {Promise<{novelDir:string, indexUrl:string, chapterCount:number, files:string[]}>}
 */
export async function publishNovelLocal(dbPath, outRoot, options = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error(`publishNovelLocal: 小说库不存在 ${dbPath}`);
  }

  const chapters = await readChaptersFromDb(dbPath);
  if (chapters.length === 0) {
    throw new Error(`publishNovelLocal: 小说库无正文章节（${dbPath}）`);
  }

  const novelTitle = options.title || (await readNovelTitleFromDb(dbPath)) || '小说';
  const novelDir = sanitizeDirName(novelTitle);
  const targetDir = path.join(outRoot, novelDir);
  fs.mkdirSync(targetDir, { recursive: true });

  // 分部结构与稳定文件名（与 publishNovel 生成段口径一致）
  const structure = await readNovelStructureFromDb(dbPath);
  const partViews = buildPartViews(structure.parts, chapters);
  const partByNo = new Map(partViews.map((p) => [p.no, p]));

  const stableIds = chapters.map((c) =>
    c.id || crypto.createHash('md5').update(c.file).digest('hex').slice(0, 16)
  );

  const sequence = [];
  if (structure.preface) {
    sequence.push({
      kind: 'preface',
      filename: `page_${structure.preface.id}.html`,
      label: '本书设定',
      title: `${novelTitle} - 本书设定`,
      markdown: `# 本书设定\n\n${stripLeadingHeading(structure.preface.text)}`
    });
  }

  const seenParts = new Set();
  chapters.forEach((chapter, i) => {
    const part = partByNo.get(Number(chapter.partNo) || 0) || null;
    if (part && part.introUrl && !seenParts.has(part.no)) {
      seenParts.add(part.no);
      sequence.push({
        kind: 'partIntro',
        filename: part.introUrl,
        label: `${part.label} · 导言`,
        title: `${novelTitle} - ${part.label} · 导言`,
        markdown: `# ${part.label} · 导言\n\n${stripLeadingHeading(part.summary)}`
      });
    }

    let bareTitle = stripChapterPrefix(chapter.title);
    if (/^第\s*[0-9一二三四五六七八九十百零两]+\s*章$/.test(bareTitle)) bareTitle = '';
    const displayTitle = bareTitle ? `第${i + 1}章：${bareTitle}` : `第${i + 1}章`;
    const kicker = part ? `<p class="part-kicker tts-skip">${escapeHtml(part.label)}</p>\n\n` : '';

    sequence.push({
      kind: 'chapter',
      filename: `chapter_${stableIds[i]}.html`,
      label: displayTitle,
      title: `${novelTitle} - ${displayTitle}`,
      chapterNum: i + 1,
      partNo: part ? part.no : 0,
      markdown: `# ${displayTitle}\n\n${kicker}${stripLeadingHeading(chapter.content)}`
    });
  });

  const written = [];
  const chapterPages = [];
  let prefacePage = null;

  for (let s = 0; s < sequence.length; s++) {
    const page = sequence[s];
    const prevUrl = s > 0 ? sequence[s - 1].filename : null;
    const nextUrl = s < sequence.length - 1 ? sequence[s + 1].filename : null;
    const navHtml = buildChapterNav(prevUrl, nextUrl);
    let htmlContent = markdownToHtml(page.markdown, page.title, navHtml);
    // 发布时预生成章节测试并内嵌：读者端打开测试零 LLM、即时呈现；失败则回退按需生成，绝不阻断发布
    if (page.kind === 'chapter' && typeof options.generateQuiz === 'function') {
      try {
        const questions = await options.generateQuiz(page.chapterText || page.markdown, options.quizAge || 9);
        if (Array.isArray(questions) && questions.length) {
          htmlContent = injectReaderData(htmlContent, { quiz: { age: options.quizAge || 9, questions } });
        }
      } catch { /* 预生成失败：跳过内嵌 */ }
    }
    const localPath = path.join(targetDir, page.filename);
    fs.writeFileSync(localPath, htmlContent, 'utf-8');
    written.push(page.filename);

    const fileInfo = {
      url: page.filename,
      title: page.label,
      filename: page.filename,
      kind: page.kind,
      chapterNum: page.chapterNum,
      partNo: page.partNo
    };
    if (page.kind === 'chapter') chapterPages.push(fileInfo);
    if (page.kind === 'preface') prefacePage = fileInfo;
  }

  // 小说目录页（章节索引）
  const indexContent = generateIndex(chapterPages, novelTitle, {
    prefaceUrl: prefacePage ? prefacePage.filename : null,
    parts: partViews
  });
  fs.writeFileSync(path.join(targetDir, 'index.html'), indexContent, 'utf-8');

  const urlBase = String(options.urlBase || '/novel').replace(/\/+$/, '');
  const indexUrl = `${urlBase}/${novelDir}/index.html`;
  console.log(`✅ 本地发布完成: ${targetDir}（${chapterPages.length} 章）→ ${indexUrl}`);
  return { novelDir, indexUrl, chapterCount: chapterPages.length, files: [...written, 'index.html'] };
}

/**
 * 本地发布站点首页（小说列表）：扫描 outRoot 下各小说目录生成 /novel/index.html
 * @param {Array<{dirName:string,title:string,chapterCount:number}>} novels
 * @param {string} outRoot
 */
export function publishSiteIndexLocal(novels, outRoot, urlBase = '/novel') {
  fs.mkdirSync(outRoot, { recursive: true });
  // generateSiteIndex 消费字段：name / url / updatedText
  const items = novels.map((n) => ({
    name: n.title || n.name,
    url: `${String(urlBase).replace(/\/+$/, '')}/${n.dirName}/index.html`,
    updatedText: (n.chapterCount != null ? `${n.chapterCount} 章` : '')
  }));
  const html = generateSiteIndex(items, '小说列表');
  fs.writeFileSync(path.join(outRoot, 'index.html'), html, 'utf-8');
  return { indexUrl: `${String(urlBase).replace(/\/+$/, '')}/index.html`, count: items.length };
}
