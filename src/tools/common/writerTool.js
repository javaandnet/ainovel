/**
 * Writer Tool
 * 根据大纲文件生成、添加、删除、修改小说章节
 */

import fs from 'fs-extra';
import path from 'path';
import { BaseTool } from '../base.js';
import { llm } from '../../agent/llm.js';
import { createWriterDB } from '../../database/writer.js';
import Database from 'better-sqlite3';
import { resolveSkillPath } from '../../utils/skillPathResolver.js';
import { toChinese, toChineseOrdinal } from '../../utils/chineseNumber.js';
import { extractCharacterRoster, filterCastNames, extractSettingTerms, outlineDependencyEdges } from '../../agents/writer/textUtils.js';
import { runDeterministicChecks } from '../../agents/writer/checker.js';
import { progressHub } from '../../services/progressHub.js';

// 泛化描述词黑名单：规划层偶发把策略文本中的描述性短语字面化填入参数
// （实测事故：dbPath 与 info.name 均被填成 "目标小说"——规划策略写着"定位到目标小说"，
// 模型便把描述词当成了真实库名/书名）。描述词不是值，统一拒绝并指路真实库名或向用户确认。
// 注意：这些词会与库内既有小说名做相似度匹配（共享"小说"等子串即可踩线 0.5 阈值），
// 若不在此拦截，模糊定位会把操作导向错误/随机的库并顺带污染小说名。
const GENERIC_DESCRIBING_NAME_RE = /^(目标小说|目标|目标库|目标文件|目标书|示例|示例小说|小说名|例子|某小说|待确定|待定|xxx+)$/i;

export class WriterTool extends BaseTool {
  constructor(config = {}) {
    super('writer', 'Generate, add, delete, or modify novel chapters based on outline file');

    this.workspace = config.workspace || process.cwd();
    this.globalConfig = config;

    this.parameters = {
      type: 'object',
      properties: {
        dbPath: {
          type: 'string',
          description: 'Path to the writer database file. One db file per novel is recommended (e.g. "<novel_name>.db"). Relative names are stored under the agent data dir (workspace/agents/{agent}/data/); absolute paths or "~" paths are used as-is. Defaults to writer.db'
        },
        chapter: {
          type: 'integer',
          description: 'Chapter number. Omit or set to 0 to generate all chapters (for generate action only). 批量生成时，已有正文的章节默认跳过、不会被覆盖。'
        },
        force: {
          type: 'boolean',
          description: '仅对 generate 批量模式有效：为 true 时覆盖重写已有正文的章节。默认 false（跳过已有正文，只补生成缺失章节）。携带 force: true 的调用会触发系统硬确认（聊天窗口弹出确认卡片，用户批准后才执行）。另在 generatePreface / generatePartIntros 中也表示覆盖已生成的设定说明与部导言（不涉及删除章节，不触发硬确认）。'
        },
        partNo: {
          type: 'integer',
          description: '部序号（用于 generatePartIntros，只重生这一部的导言；省略则处理所有缺导言的部）'
        },
        action: {
          type: 'string',
          description: '操作类型：generate(生成), add(添加), modify(修改), delete(删除), getNovelInfo(获取小说信息), listNovels(列出所有小说数据库), getPublishConfig(查询发布配置), setPublishConfig(设置发布配置：自动发布开关/目标目录), saveNovelPlan(保存小说规划), generateChapterOutlines(生成所有章节大纲), addChapterOutline(添加章节大纲), updateChapterOutline(更新章节大纲), reNumberChapters(重编号章节), updateNovelPlan(更新小说规划), generatePreface(生成“本书设定”说明页), savePreface(人工写入设定说明), setParts(手动划分“部”), generatePartIntros(生成各部导言概要), listParts(查看部结构)',
          enum: ['generate', 'gen', 'g', 'add', 'modify', 'mod', 'm', 'delete', 'del', 'd', 'getNovelInfo', 'listNovels', 'getPublishConfig', 'setPublishConfig', 'saveNovelPlan', 'generateChapterOutlines', 'addChapterOutline', 'updateChapterOutline', 'reNumberChapters', 'updateNovelPlan', 'generatePreface', 'savePreface', 'setParts', 'generatePartIntros', 'listParts']
        },
        parts: {
          type: 'array',
          description: '分部定义数组（用于 setParts），每项 { name?, from, to }，from/to 为章节号（含端点）。必须从第 1 章起、逐部首尾相接、覆盖到最后一章（有缺口会报错）；传空数组 [] = 清除全部分部。划分完全由调用方指定，程序不会自动切分。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '部名；可省略（省略则展示为“第一部”，事后可用 generatePartIntros 补一个贴切部名）' },
              from: { type: 'integer', description: '本部起始章号（含）' },
              to: { type: 'integer', description: '本部结束章号（含）' }
            },
            required: ['from', 'to']
          }
        },
        preface: {
          type: 'string',
          description: '“本书设定”说明正文（Markdown，用于 savePreface）。面向读者的第一印象：介绍背景世界观与主要出场人物，不剧透后续剧情。'
        },
        modifyInstructions: {
          type: 'string',
          description: 'Modification instructions for the modify action. Required when action is modify.'
        },
        info: {
          type: 'object',
          description: '小说信息（用于 saveNovelPlan、updateNovelPlan、updateChapterOutline、addChapterOutline 操作）或发布配置（用于 setPublishConfig 操作：autoPublish 布尔值是否开启逐章自动发布、directory 远程目标目录）',
          properties: {
            // 小说规划字段（用于 saveNovelPlan、updateNovelInfo）
            name: { type: 'string', description: '小说名称（saveNovelPlan）或章节标题（章节操作）' },
            outline: { type: 'string', description: '故事概要/简介（saveNovelPlan）或章节大纲内容（章节操作）' },
            content: { type: 'string', description: '角色设定、世界观等（saveNovelPlan）或章节内容（addChapterOutline，可选）' },
            // 章节大纲字段（用于 updateChapterOutline、addChapterOutline）
            no: { type: 'integer', description: '章节号（updateChapterOutline）或插入位置（addChapterOutline，该位置及之后的章节会+1）' }
          }
        },
        totalChapters: {
          type: 'integer',
          description: '章节总数（用于 generateChapterOutlines 操作），默认 10'
        },
        targetWordCount: {
          type: 'integer',
          description: '每章目标字数（用于 saveNovelPlan 存储 及 generate 时校验/续写）。如 2000 表示每章约 2000 字。若未指定则不做字数校验。'
        },
        modificationType: {
          type: 'string',
          description: '修改类型（用于 updateNovelPlan 操作）',
          enum: ['updateNovelInfo', 'updateChapterOutline', 'addChapterOutline', 'deleteChapter', 'reNumberChapters']
        }
      },
      required: ['dbPath']
    };
  }

  /**
   * 执行工具 - 根据参数执行章节操作
   * @param {Object} args - 参数对象
   * @param {string} args.outlinePath - 大纲文件路径
   * @param {number} [args.chapter] - 章节号
   * @param {string} [args.action] - 操作类型
   * @param {string} [args.modifyInstructions] - 修改说明
   * @returns {Promise<string>} 执行结果
   */
  async execute(args) {
    try {
      // 数值参数归一化为整数：LLM 可能传字符串（如 "3"），SQLite 的 INTEGER PRIMARY KEY
      // 列绑定字符串会抛 datatype mismatch
      const toIntIfPossible = (v) => {
        if (v === undefined || v === null) return v;
        const n = Number(v);
        return Number.isInteger(n) ? n : v;
      };
      args = { ...args };
      args.chapter = toIntIfPossible(args.chapter);
      args.totalChapters = toIntIfPossible(args.totalChapters);
      if (args.info && typeof args.info === 'object') {
        args.info = { ...args.info, no: toIntIfPossible(args.info.no) };
      }

      const {
        dbPath = 'writer.db',
        chapter,
        action = 'generate',
        modifyInstructions = '',
        info,
        totalChapters = 10,
        targetWordCount = null
      } = args;

      // 确定数据库路径：相对文件名统一落到 agent 数据目录（workspace/agents/{agent}/data/），
      // 绝对路径/~ 路径原样使用；目标库不存在时按现有小说库模糊定位（处理 LLM 传简称），
      // 歧义或无相似项时报错枚举候选，防止"写错库名"静默建新空库、与已写章节失去关联
      this.dbRedirectNote = null;
      const NO_DB_ACTIONS = ['listNovels', 'getPublishConfig', 'setPublishConfig'];
      const CREATE_DB_ACTIONS = ['saveNovelPlan']; // 仅小说规划入口允许创建新库
      let resolvedDbPath;
      if (!NO_DB_ACTIONS.includes(action)) {
        resolvedDbPath = this._resolveDbPath(dbPath, { requireExisting: !CREATE_DB_ACTIONS.includes(action) });
      }

      // 处理数据库操作方法（简单的 CRUD 操作）
      if (action === 'listNovels') {
        const novels = await this.listNovelDatabases();
        return this.formatResult({
          success: true,
          action: 'listNovels',
          dataDir: this._getAgentDataDir(),
          novels
        });
      }

      if (action === 'getPublishConfig') {
        const publish = this._readAgentPublishConfig();
        return this.formatResult({
          success: true,
          action: 'getPublishConfig',
          publish: this._maskPublishConfig(publish)
        });
      }

      if (action === 'setPublishConfig') {
        if (!info || (info.autoPublish === undefined && info.directory === undefined)) {
          return 'Error: info parameter with autoPublish and/or directory is required for setPublishConfig action';
        }
        const updated = this._updateAgentPublishConfig(info);
        return this.formatResult({
          success: true,
          action: 'setPublishConfig',
          publish: this._maskPublishConfig(updated)
        });
      }

      if (action === 'getNovelInfo') {
        const db = createWriterDB(resolvedDbPath);
        const novelInfo = db.getNovelInfo();
        const chapters = db.getAllChapters({ includeContent: false });
        const chapterOutlines = chapters.filter(ch => ch.no > 0);
        // 设定说明与部结构：让调用方在对话里能直接看到“有没有写过设定页、分了几部”
        const parts = db.getAllParts();
        const preface = db.getPreface();

        return this.formatResult({
          success: true,
          action: 'getNovelInfo',
          dbPath: resolvedDbPath,
          novelInfo: novelInfo,
          hasPreface: !!preface,
          prefaceLength: preface ? preface.length : 0,
          parts: parts.map(p => ({
            no: p.no,
            name: p.name || toChineseOrdinal(p.no, '部'),
            label: this._partLabel(p),
            startNo: p.startNo,
            endNo: p.endNo,
            chapters: p.chapters,
            hasIntro: !!p.summary
          })),
          partCount: parts.length,
          chapterOutlines: chapterOutlines,
          totalChapters: chapterOutlines.length
        });
      }

      if (action === 'saveNovelPlan') {
        if (!info) {
          return 'Error: info parameter is required for saveNovelPlan action';
        }

        // 占位内容守卫：规划层偶发把模板占位文本当规划提交（实测事故：outline
        // "（此处将根据用户之前的具体题材重新构思…）"、content 全是"详细设定"），
        // 若放行会基于空设定生成整套章节并落库。统一拒绝，要求先产出真实内容
        const PLACEHOLDER_RE = /（此处|\(此处|此处将|占位|TODO|待补充|待定|详细设定|详细的世界观|详细展开/;
        if (PLACEHOLDER_RE.test(String(info.outline || '')) || PLACEHOLDER_RE.test(String(info.content || ''))) {
          throw new Error('小说规划内容是占位/模板文本，不是真实设定（outline 或 content 中检出"此处将/详细设定/待补充"等占位标记）。请先构思出完整的故事概要与角色、世界观设定，再调用 saveNovelPlan 保存。');
        }

        // 主角具名守卫：设定不给出主角名字时，逐章生成会每章临场编名（实测同一部小说
        // 主角被写成"小毛/小灰/小猴子"三种称呼），因此在规划入口就拦住
        this._assertProtagonistNamed(info);

        // 库名规范化：新建库统一落成 *.db，保证 listNovels 与模糊定位可发现
        if (!resolvedDbPath.endsWith('.db')) {
          resolvedDbPath += '.db';
          this.dbRedirectNote = this.dbRedirectNote
            ? `${this.dbRedirectNote} 库名已自动补全 .db 扩展名。`
            : '⚠️ 注意：dbPath 未带 .db 扩展名，已自动补全，按标准小说库文件保存。';
        }

        // 书名与库名防分裂守卫：即将新建 db，但 info.name 与既有小说模糊撞名
        //（典型场景：LLM 操作既有小说时传错了库名）→ 自动重定向到既有库，歧义时报错枚举，
        // 避免同一部小说的规划被写进新建空库、与既有章节失去关联
        if (!fs.existsSync(resolvedDbPath) && info.name) {
          const candidates = this._collectNovelDbCandidates();
          const nameHits = this._fuzzyMatchDbName(String(info.name), candidates);
          if (nameHits.length === 1) {
            const hit = nameHits[0];
            this.dbRedirectNote = `⚠️ 注意：规划中的小说名 "${info.name}" 与既有小说库 "${path.basename(hit.path)}"（《${hit.novelName || '未命名'}》，${hit.chapterCount} 章正文）相似，已自动改写到该既有库，避免误建新库导致数据分裂。若确实要创建全新小说，请换一个与既有小说不重名的文件名并向用户说明。`;
            resolvedDbPath = hit.path;
          } else if (nameHits.length > 1) {
            throw new Error(this._dbAmbiguousError(`小说名 "${info.name}"`, nameHits));
          }
        }

        const db = createWriterDB(resolvedDbPath);
        // 将 targetWordCount 存储到 novel content 字段中（作为结构化标记）
        if (targetWordCount && info) {
          const marker = `【每章目标字数：${targetWordCount}】`;
          if (!String(info.content || '').includes('每章目标字数')) {
            info.content = (info.content || '') + '\n\n' + marker;
          }
        }
        const result = db.saveNovelInfo(info);
        
        // 自动检测：如果数据库中没有章节大纲，自动生成
        const allChapters = db.getAllChapters({ includeContent: false });
        const hasChapterOutlines = allChapters.some(ch => ch.no > 0);
        
        if (!hasChapterOutlines) {
          // 只有小说概要，没有章节大纲，自动生成
          console.log('📖 小说规划已保存，自动生成章节大纲...');
          this.db = db;
          const outlineResult = await this.generateAllChapterOutlines(totalChapters);
          const planText = this.formatResult({ 
            success: true, 
            dbPath: resolvedDbPath,
            autoGeneratedOutlines: true,
            ...result,
            // action 放在展开之后：saveNovelInfo 返回的 action:'inserted' 不能覆盖本层语义
            action: 'saveNovelPlan',
            totalChapters: outlineResult.totalChapters,
            successCount: outlineResult.successCount,
            failCount: outlineResult.failCount,
            outlines: outlineResult.outlines
          });
          // 计划阶段确认窗口：发布策略未定时，指示 LLM 先确认再开始生成
          const hint = this._planConfirmationHint();
          return hint ? `${planText}\n\n${hint}` : planText;
        }
        
        const planText = this.formatResult({ success: true, dbPath: resolvedDbPath, ...result, action: 'saveNovelPlan' });
        const hint = this._planConfirmationHint();
        return hint ? `${planText}\n\n${hint}` : planText;
      }

      if (action === 'addChapterOutline') {
        // 支持 title 和 name 两种字段名（兼容文档和代码）
        if (!info || !info.no) {
          return 'Error: info parameter with no field is required for addChapterOutline action';
        }
        if (!info.name && !info.title) {
          return 'Error: info parameter with name or title field is required for addChapterOutline action';
        }
        if (!info.outline) {
          return 'Error: info parameter with outline field is required for addChapterOutline action';
        }

        // 统一使用 name 字段（如果提供的是 title，则转换为 name）
        const normalizedData = {
          no: info.no,
          name: info.name || info.title,
          outline: info.outline,
          content: info.content || ''
        };

        const db = createWriterDB(resolvedDbPath);
        const result = db.addChapterOutline(normalizedData);
        return this.formatResult({ success: true, ...result, action: 'addChapterOutline' });
      }

      if (action === 'updateChapterOutline') {
        if (!info || !info.no) {
          return 'Error: info parameter with no field is required for updateChapterOutline action';
        }
        const db = createWriterDB(resolvedDbPath);
        const result = db.updateChapterOutline(info.no, info.outline, info.title || info.name);
        return this.formatResult({ success: true, ...result, action: 'updateChapterOutline' });
      }

      if (action === 'reNumberChapters') {
        const db = createWriterDB(resolvedDbPath);
        const result = db.reNumberAllChapters();
        return this.formatResult({ success: true, ...result, action: 'reNumberChapters' });
      }

      // ── “本书设定”说明页（全书最前面给读者的第一印象）─────────────────
      if (action === 'savePreface') {
        const text = args.preface ?? info?.preface;
        if (typeof text !== 'string' || !text.trim()) {
          return 'Error: preface parameter (non-empty markdown) is required for savePreface action';
        }
        const db = createWriterDB(resolvedDbPath);
        const result = db.savePreface(text);
        return this.formatResult({
          success: true,
          action: 'savePreface',
          dbPath: resolvedDbPath,
          ...result,
          note: '设定说明已入库；需重新发布才会出现在网站上'
        });
      }

      if (action === 'generatePreface') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;
        const novelInfo = db.getNovelInfo();
        if (!novelInfo) {
          throw new Error('小说规划（no=0）不存在，无法生成设定说明；请先用 saveNovelPlan 保存规划');
        }
        const existing = db.getPreface();
        if (existing && !args.force) {
          return this.formatResult({
            success: true,
            action: 'generatePreface',
            skipped: true,
            reason: `设定说明已存在（${existing.length} 字），传 force: true 可覆盖重写`,
            length: existing.length
          });
        }
        const prefaceText = await this.generatePrefaceWithLLM(novelInfo, db.getAllChapters());
        db.savePreface(prefaceText);
        return this.formatResult({
          success: true,
          action: 'generatePreface',
          dbPath: resolvedDbPath,
          overwritten: !!existing,
          length: prefaceText.length,
          preview: prefaceText.slice(0, 300),
          note: '需重新发布才会出现在网站上'
        });
      }

      // ── “部”（整体 → 部 → 章）：划分完全由调用方指定，程序不自动切分 ──────
      if (action === 'setParts') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;
        const input = args.parts ?? info?.parts;
        if (!Array.isArray(input)) {
          return 'Error: parts parameter (array of { name?, from, to }) is required for setParts action';
        }
        const chapters = db.getAllChapters().filter(c => c.no > 0);
        const maxNo = chapters.reduce((m, c) => Math.max(m, c.no), 0);
        const normalized = this._normalizePartsInput(input, maxNo);
        const result = db.saveParts(normalized);
        const parts = db.getAllParts();
        return this.formatResult({
          success: true,
          action: 'setParts',
          dbPath: resolvedDbPath,
          partCount: result.partCount,
          assignedChapters: result.assigned,
          parts: parts.map(p => ({
            no: p.no,
            name: p.name || toChineseOrdinal(p.no, '部'),
            startNo: p.startNo,
            endNo: p.endNo,
            chapters: p.chapters,
            hasIntro: !!p.summary
          })),
          missingIntroCount: parts.filter(p => !p.summary && p.chapters > 0).length,
          note: parts.some(p => !p.summary && p.chapters > 0)
            ? '尚有部未生成导言概要，可用 generatePartIntros 生成；需重新发布才会出现在网站上'
            : '需重新发布才会出现在网站上'
        });
      }

      if (action === 'listParts') {
        const db = createWriterDB(resolvedDbPath);
        const parts = db.getAllParts();
        const preface = db.getPreface();
        return this.formatResult({
          success: true,
          action: 'listParts',
          dbPath: resolvedDbPath,
          hasPreface: !!preface,
          partCount: parts.length,
          parts: parts.map(p => ({
            no: p.no,
            name: p.name || toChineseOrdinal(p.no, '部'),
            startNo: p.startNo,
            endNo: p.endNo,
            chapters: p.chapters,
            hasIntro: !!p.summary,
            introLength: (p.summary || '').length
          })),
          summary: parts.length === 0
            ? '未划分任何部（全书单层“章”）'
            : parts.map(p => `第${toChinese(p.no)}部《${p.name || '未命名'}》第${p.startNo}–${p.endNo}章（${p.chapters} 章${p.summary ? '，已有导言' : '，缺导言'}）`).join('；')
        });
      }

      if (action === 'generatePartIntros') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;
        const parts = db.getAllParts();
        if (parts.length === 0) {
          throw new Error('尚未划分任何“部”，无法生成部导言；请先用 setParts 指定分部（传 parts 数组，如 [{name,from,to}]）');
        }
        const novelInfo = db.getNovelInfo();
        const chapters = db.getAllChapters().filter(c => c.no > 0);
        const only = Number(args.partNo ?? info?.partNo) || null;

        let targets = parts.filter(p => p.chapters > 0);
        if (only) {
          targets = targets.filter(p => p.no === only);
          if (targets.length === 0) {
            throw new Error(`第${only}部不存在或该部已无章节（现有部：${parts.map(p => p.no).join('、')}）`);
          }
        } else if (!args.force) {
          // 默认只补缺：已有导言的部不重写（避免一次调用抹掉人工修改）
          targets = targets.filter(p => !p.summary);
        }

        if (targets.length === 0) {
          return this.formatResult({
            success: true,
            action: 'generatePartIntros',
            skipped: true,
            reason: '所有部都已有导言概要（要重写请传 force: true，或用 partNo 指定单部）',
            partCount: parts.length
          });
        }

        const done = [];
        for (const part of targets) {
          const intro = await this.generatePartIntroWithLLM(part, parts, novelInfo, chapters);
          // 部名只在原本为空时才回写，不覆盖人工定的名字
          db.updatePart(part.no, {
            summary: intro.summary,
            name: part.name ? undefined : intro.name
          });
          done.push({ no: part.no, name: (part.name || intro.name) || toChineseOrdinal(part.no, '部'), length: intro.summary.length });
        }

        return this.formatResult({
          success: true,
          action: 'generatePartIntros',
          dbPath: resolvedDbPath,
          generatedCount: done.length,
          parts: done,
          note: '需重新发布才会出现在网站上'
        });
      }

      // ── 体检与回滚 ──────────────────────────────────────────────
      if (action === 'checkChapters') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;
        const scope = args.scope || 'specific';
        const withBody = args.withBody === true;
        let chapterNos;
        if (scope === 'all') {
          chapterNos = undefined; // 全书
        } else if (args.no) {
          chapterNos = [Number(args.no)];
        } else if (args.from && args.to) {
          chapterNos = Array.from({ length: args.to - args.from + 1 }, (_, i) => args.from + i);
        } else {
          return 'Error: checkChapters requires scope ("all"), no, or from+to parameters';
        }
        const check = await this._runPostWriteCheck({ chapterNos, fullBook: scope === 'all', withBody });
        const totalIssues = check.hard.length + check.outline.length + check.bodyVsOutline.length + check.seam.length;
        return this.formatResult({
          success: true,
          action: 'checkChapters',
          dbPath: resolvedDbPath,
          scope,
          totalIssues,
          check
        });
      }

      if (action === 'listRevisions') {
        const db = createWriterDB(resolvedDbPath);
        const no = Number(args.no || args.chapter);
        if (!no) return 'Error: listRevisions requires no (chapter number) parameter';
        const revisions = db.listChapterRevisions(no);
        return this.formatResult({
          success: true,
          action: 'listRevisions',
          dbPath: resolvedDbPath,
          chapterNo: no,
          revisionCount: revisions.length,
          revisions: revisions.map(r => ({
            id: r.id,
            chapterNo: r.chapter_no,
            name: r.name,
            reason: r.reason,
            source: r.source,
            createdAt: r.created_at,
            contentPreview: String(r.content || '').slice(0, 100)
          }))
        });
      }

      if (action === 'restoreChapter') {
        const db = createWriterDB(resolvedDbPath);
        const revisionId = Number(args.revisionId || args.id);
        if (!revisionId) return 'Error: restoreChapter requires revisionId parameter';
        const result = db.restoreChapterRevision(revisionId);
        if (!result.success) return `Error: ${result.error}`;
        return this.formatResult({
          success: true,
          action: 'restoreChapter',
          dbPath: resolvedDbPath,
          chapterNo: result.chapterNo,
          restoredFrom: result.restoredFrom,
          note: '需重新发布才会出现在网站上'
        });
      }

      if (action === 'updateNovelPlan') {
        // 统一的小说规划修改入口
        const { modificationType, info, chapter } = args;

        const db = createWriterDB(resolvedDbPath);
        this.db = db;

        if (!modificationType) {
          return 'Error: modificationType is required for updateNovelPlan action';
        }

        let result;
        switch (modificationType) {
          case 'updateNovelInfo':
            if (!info) {
              return 'Error: info is required for updateNovelInfo modification';
            }
            // 泛化描述词守卫：禁止把小说名改写成描述词（实测事故：info.name="目标小说"
            // 被写入库内，既污染书名又让后续模糊匹配命中这个垃圾名反复操作同一错库）
            if (info.name && GENERIC_DESCRIBING_NAME_RE.test(String(info.name).trim())) {
              return `Error: info.name "${info.name}" 是描述性词汇，不是真实的小说名。请提供真实书名；若本次只是修改设定/简介等其他字段，请省略 name 字段。`;
            }
            // 主角具名守卫：仅在本次确实改了概要/设定时判定，以与库内现有设定合并后的文本为准
            if (info.outline || info.content) {
              const existingPlan = db.getNovelInfo() || {};
              this._assertProtagonistNamed({
                outline: info.outline ?? existingPlan.outline,
                content: info.content ?? existingPlan.content
              });
            }
            result = db.saveNovelInfo(info);
            {
              const planText = this.formatResult({ success: true, ...result, action: 'saveNovelPlan' });
              // 计划被修改后同样进入确认窗口（策略已定时 hint 为 null，不打扰）
              const hint = this._planConfirmationHint();
              return hint ? `${planText}\n\n${hint}` : planText;
            }

          case 'updateChapterOutline':
            if (!info || !info.no) {
              return 'Error: info with no field is required for updateChapterOutline modification';
            }
            result = db.updateChapterOutline(info.no, info.outline, info.title || info.name);
            return this.formatResult({ success: true, ...result, action: 'updateChapterOutline' });

          case 'addChapterOutline':
            if (!info || !info.no) {
              return 'Error: info with no field is required for addChapterOutline modification';
            }
            if (!info.name && !info.title) {
              return 'Error: info with name or title field is required for addChapterOutline modification';
            }
            if (!info.outline) {
              return 'Error: info with outline field is required for addChapterOutline modification';
            }
            const normalizedData = {
              no: info.no,
              name: info.name || info.title,
              outline: info.outline,
              content: info.content || ''
            };
            result = db.addChapterOutline(normalizedData);
            return this.formatResult({ success: true, ...result, action: 'addChapterOutline' });

          case 'deleteChapter':
            if (!chapter) {
              return 'Error: chapter number is required for deleteChapter modification';
            }
            this.chapter = chapter;
            result = await this.deleteChapter();
            return this.formatResult({ success: true, ...result, action: 'delete' });

          case 'reNumberChapters':
            result = db.reNumberAllChapters();
            return this.formatResult({ success: true, ...result, action: 'reNumberChapters' });

          default:
            return `Error: Unknown modificationType: ${modificationType}. Valid types: updateNovelInfo, updateChapterOutline, addChapterOutline, deleteChapter, reNumberChapters`;
        }
      }

      if (action === 'generateChapterOutlines') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;

        // 自动检测：如果只有 no=0 的记录（小说概要），直接生成章节大纲
        const allChapters = db.getAllChapters({ includeContent: false });
        const hasChapterOutlines = allChapters.some(ch => ch.no > 0);

        if (!hasChapterOutlines) {
          // 只有小说概要，没有章节大纲，自动生成
          console.log('📖 检测到只有小说概要，自动生成章节大纲...');
          const result = await this.generateAllChapterOutlines(totalChapters);
          return this.formatResult({
            success: true,
            action: 'generateChapterOutlines',
            autoGenerated: true,
            ...result
          });
        }

        // 已有章节大纲，正常执行
        const result = await this.generateAllChapterOutlines(totalChapters);
        return this.formatResult({ success: true, action: 'generateChapterOutlines', ...result });
      }

      // 原有的章节生成/修改/删除逻辑
      // 创建数据库实例
      this.db = createWriterDB(resolvedDbPath);

      // 生成前 HITL 硬关卡（程序强制，不依赖模型自觉询问）：
      // 仅批量生成（generate 不带 chapter）触发——指定章节的单章重写属用户明确意图，
      // 由 force 参数 + 系统硬确认卡片把关，不在此重复打扰
      const isBatchGenerate = String(action).toLowerCase() === 'generate' && (!chapter || chapter === 0);
      if (isBatchGenerate) {
        // ① 重复内容处理：库中已有正文时先让用户选择（保留补全/覆盖重写/中止）
        const dupGate = await this._confirmDuplicateHandling(this.db);
        if (dupGate.mode === 'abort') {
          return '⛔ 用户选择中止本次生成（或确认超时未处理），未改动任何已有章节。如需继续，请先与用户确认已有内容的处理方式后重新调用。';
        }
        if (dupGate.mode === 'overwrite' && args.force !== true) {
          args.force = true; // 用户已选覆盖重写：批量分支按 force 语义执行（覆盖前系统仍会弹硬确认卡片二次把关）
        }
        // ② 发布策略事前确认：用户最初要求未涉及发布方式时，动笔前先定策略（一次决定、持久化，不逐章询问）
        await this._confirmPublishStrategyIfNeeded();
      }

      const result = await this.executeChapterOperation(action, chapter, modifyInstructions, args);

      // 章节写入成功后：已开启自动发布则立即发布（写一章发一章）
      if (result?.success) {
        const publishOutcome = await this._autoPublishIfNeeded(result, resolvedDbPath);
        if (publishOutcome) {
          result.publishResult = publishOutcome;
        }
      }

      // 格式化输出结果（追加自动发布结果/确认提示）
      return this._appendPublishOutcome(this.formatResult(result), result);
    } catch (error) {
      return `Error: ${error.message}`;
    }
  }

  /**
   * 获取当前 Agent 的小说数据目录（统一管理位置）
   * 布局：{folders.agents}/{agentName}/data/（默认 workspace/agents/{agent}/data/）
   * @returns {string} 数据目录绝对路径
   */
  _getAgentDataDir() {
    // ainovel: 小说库统一放 <项目根>/data/
    return path.join(this.workspace || process.cwd(), 'data');
  }

  /**
   * 解析数据库文件路径
   * - 绝对路径 / ~ 开头路径：展开后原样使用
   * - 相对文件名：落到 agent 数据目录（每本小说一个 db，统一管理）
   * - 兼容回退：agent 数据目录中不存在、而旧 session 目录存在同名 db 时，沿用 session 内的旧库
   * - 模糊定位：目标文件不存在时，按数据目录内现有小说库做相似度匹配（LLM 常传简称/误记书名），
   *   唯一命中则自动定位并记录提示（dbRedirectNote）；多命中歧义或要求库必须存在时，
   *   报错枚举候选而非静默建新空库
   * @param {string} dbPath - LLM 传入的数据库路径
   * @param {Object} [options]
   * @param {boolean} [options.requireExisting=false] - true 时目标库不存在且无模糊命中则抛错（禁止静默建新空库）
   * @returns {string} 解析后的绝对路径
   */
  _resolveDbPath(dbPath, { requireExisting = false } = {}) {
    this.dbRedirectNote = null; // 每次解析独立计算，避免残留上一次的定位提示
    let input = String(dbPath || 'writer.db').trim() || 'writer.db';

    // 输入自愈：规划/执行链路偶发把 listNovels 的整段输出文本当作 dbPath 传入（多行粘贴）。
    // 与其带着垃圾入参走到报错，不如从文本中提取 .db 文件名：唯一既有库直接用；
    // 多个候选时取最近更新的一库——延续性请求（改编/继续写）的目标几乎总是当前在写的小说
    if (input.includes('\n') || input.length > 200) {
      const extractedNames = [...new Set(input.match(/[^\s"':|/\\]+\.db/g) || [])];
      const candidates = this._collectNovelDbCandidates();
      const hits = candidates.filter(c => extractedNames.some(n => n === `${c.base}.db`));
      if (hits.length === 1) {
        this.dbRedirectNote = `⚠️ 注意：dbPath 传入的是整段文本（疑似误粘贴了 listNovels 输出），已从中提取并定位到小说库 "${path.basename(hits[0].path)}"（《${hits[0].novelName || '未命名'}》，${hits[0].chapterCount} 章正文）。`;
        return hits[0].path;
      }
      if (hits.length > 1) {
        const latest = [...hits].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
        this.dbRedirectNote = `⚠️ 注意：dbPath 传入的是整段文本（疑似误粘贴了 listNovels 输出），其中包含 ${hits.length} 个小说库，已按最近更新选择 "${path.basename(latest.path)}"（《${latest.novelName || '未命名'}》，${latest.chapterCount} 章正文，更新于 ${latest.updatedAt || '未知'}）。若目标不是这部小说，请用精确文件名重新调用。`;
        return latest.path;
      }
      // 提取不到或提取的名字都不是既有库：归一化后走后续常规流程（报错信息也干净）
      input = extractedNames[0] || '粘贴文本中未找到.db文件名';
    }

    // 无效库名守卫：规划层偶发抓取列表标题片段（实测事故：dbPath:"小"——"小说数据库列表"
    // 首字）或占位单字当库名，不拦截会建出垃圾 DB 或报出无法定位的错。统一拒绝并指路
    const baseName = path.basename(input, '.db').trim();
    if (baseName.length < 2) {
      throw new Error(`无效的 dbPath "${input}"（库名过短，疑似列表标题片段或占位字符，不是有效的小说库文件名）。请先用 action: "listNovels" 查看现有小说库，并使用其中返回的完整文件名（如 "某某小说.db"）；若确实要新建小说，请给出完整的小说名。`);
    }

    // 泛化描述词守卫：描述词不是库名，不做模糊猜测（描述词与既有书名共享"小说"等
    // 子串即可踩中相似度阈值，猜错目标会改写错误小说的数据）。直接拒绝，
    // 要求用 listNovels 输出中的真实文件名；目标不明确时应先向用户确认。
    if (GENERIC_DESCRIBING_NAME_RE.test(baseName)) {
      throw new Error(`无效的 dbPath "${input}"（"${baseName}" 是描述性词汇，不是小说库文件名）。请先用 action: "listNovels" 查看现有小说库，并使用其中"文件: <文件名>"行的完整文件名原文；若不清楚用户要操作哪部小说，请先向用户确认目标后再执行。`);
    }

    // 占位默认值兜底：writer.db 是通用默认名，规划层漏传 dbPath 时会落到这里。
    // 需要既有库的场景（read/modify/generate…）视为"未指定目标"：自动选择最近更新的
    // 非空库（延续性操作的目标几乎总是当前在写的小说），而不是报一个莫名妙的错
    if (requireExisting && path.basename(input, '.db').toLowerCase() === 'writer') {
      const candidates = this._collectNovelDbCandidates();
      if (candidates.length === 0) {
        throw new Error('未指定 dbPath 且当前没有任何既有小说库。若要新建小说请先用 saveNovelPlan 规划；若要操作既有小说，请先 listNovels 查看库名。');
      }
      const latest = [...candidates].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
      this.dbRedirectNote = `⚠️ 注意：dbPath 未指定（回落到默认值 writer.db），已自动选择最近更新的既有小说库 "${path.basename(latest.path)}"（《${latest.novelName || '未命名'}》，${latest.chapterCount} 章正文，更新于 ${latest.updatedAt || '未知'}）。若目标不是这部小说，请传入精确文件名重试。`;
      return latest.path;
    }

    // 绝对路径或 ~ 路径：交给统一解析器（~ 展开 + 绝对化）
    if (path.isAbsolute(input) || input.startsWith('~')) {
      const fullPath = resolveSkillPath(input, {}).fullPath;
      if (requireExisting && !fs.existsSync(fullPath)) {
        throw new Error(this._dbNotFoundError(input));
      }
      return fullPath;
    }

    const dataDirPath = path.join(this._getAgentDataDir(), input);
    // 空库（0 行数据）视同不存在：历史遗留/误创建的空文件不应拦截模糊定位，
    // 否则"传错名字→建空库→下次精确命中空库"会持续循环、永远找不到真正的小说
    if (fs.existsSync(dataDirPath) && !this._isEmptyNovelDb(dataDirPath)) {
      return dataDirPath;
    }

    // 兼容旧数据：session 目录中已有同名 db（旧版存储位置）时优先沿用，避免数据分裂
    const sessionDir = this.context?.sessionWorkspace;
    if (sessionDir) {
      const legacyPath = path.join(sessionDir, input);
      if (fs.existsSync(legacyPath)) {
        return legacyPath;
      }
    }

    // 目标库不存在：模糊定位（简称/误记书名），防止静默建空库导致与已写章节失去关联
    const candidates = this._collectNovelDbCandidates();
    const fuzzyHits = this._fuzzyMatchDbName(path.basename(input, '.db'), candidates);
    if (fuzzyHits.length === 1) {
      const hit = fuzzyHits[0];
      this.dbRedirectNote = `⚠️ 注意：传入的 dbPath "${input}" 不存在，已自动定位到相似小说库 "${path.basename(hit.path)}"（《${hit.novelName || '未命名'}》，${hit.chapterCount} 章正文）。请确认这是你要操作的小说；如不是，请用 listNovels 查看正确的库名后重试。`;
      return hit.path;
    }
    if (fuzzyHits.length > 1) {
      throw new Error(this._dbAmbiguousError(input, fuzzyHits));
    }

    if (requireExisting) {
      throw new Error(this._dbNotFoundError(input, candidates));
    }
    return dataDirPath;
  }

  /**
   * 判断小说库是否为空库（无 content 表或 0 行数据）
   * 无法读取（损坏/占用）时返回 false——按非空处理，交给后续流程自行报错
   */
  _isEmptyNovelDb(filePath) {
    try {
      const db = new Database(filePath, { readonly: true });
      try {
        const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content'").get();
        if (!hasTable) return true;
        return db.prepare('SELECT COUNT(*) AS c FROM content').get().c === 0;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  /**
   * 枚举所有 agent 的数据目录（当前 agent 优先）。小说库可能散落在不同子 Agent
   * 目录下（如 planner 规划建库、writer 写章节），跨目录扫描避免"找不到→误建新库"
   * @returns {string[]} 数据目录绝对路径列表（去重，当前 agent 目录排首位）
   */
  _getAllAgentDataDirs() {
    // ainovel: 单一平铺数据目录 <项目根>/data/，无需跨 agent 扫描
    return [this._getAgentDataDir()];
  }

  /**
   * 收集 agent 数据目录下的小说库候选（过滤空库，避免历史遗留空文件污染匹配）
   * @returns {Array<{path: string, base: string, novelName: string, chapterCount: number}>}
   */
  _collectNovelDbCandidates() {
    // 扫描所有 agent 的数据目录（而非仅当前 agent）：新建小说可能由 planner 子 Agent
    // 落到自己的目录，后续 writer 子 Agent 若只看本目录会"找不到"导致数据分裂/误建新库
    const infos = [];
    for (const dataDir of this._getAllAgentDataDirs()) {
      if (!fs.existsSync(dataDir)) continue;
      for (const f of fs.readdirSync(dataDir)) {
        if (!f.endsWith('.db')) continue;
        const filePath = path.join(dataDir, f);
        try {
          const db = new Database(filePath, { readonly: true });
          try {
            const hasTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='content'").get();
            if (!hasTable) continue;
            const totalRows = db.prepare('SELECT COUNT(*) AS c FROM content').get().c;
            if (totalRows === 0) continue; // 空库：历史遗留/误创建的空文件，不参与匹配
            const novelRow = db.prepare('SELECT name, updated_at FROM content WHERE no = 0').get();
            const countRow = db.prepare("SELECT COUNT(*) AS c FROM content WHERE no >= 1 AND type = 'chapter' AND content IS NOT NULL AND content != ''").get();
            infos.push({
              path: filePath,
              base: path.basename(f, '.db'),
              novelName: novelRow?.name || '',
              chapterCount: countRow?.c || 0,
              updatedAt: novelRow?.updated_at || ''
            });
          } finally {
            db.close();
          }
        } catch { /* 无法读取的文件跳过 */ }
      }
    }
    return infos;
  }

  /**
   * 模糊匹配小说库名（LLM 传简称/误记书名场景）
   * 相似度 = 最长公共子串长度 / 较短名长度；≥0.5 视为命中。
   * 多个命中且差距 <0.1 视为歧义：全部返回，由调用方报错枚举候选让 LLM 带正确库名重试
   * @param {string} requested - 请求的库名（不含 .db 后缀）
   * @param {Array} candidates - _collectNovelDbCandidates 的结果
   * @returns {Array} 命中候选（唯一=自动定位；多个=歧义；空=无相似项）
   */
  _fuzzyMatchDbName(requested, candidates) {
    const lcsRatio = (a, b) => {
      if (!a || !b) return 0;
      const m = a.length;
      const n = b.length;
      let best = 0;
      const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (a[i - 1] === b[j - 1]) {
            dp[i][j] = dp[i - 1][j - 1] + 1;
            if (dp[i][j] > best) best = dp[i][j];
          }
        }
      }
      return best / Math.min(m, n);
    };

    const scored = [];
    for (const c of candidates) {
      const score = Math.max(lcsRatio(requested, c.base), lcsRatio(requested, c.novelName));
      if (score >= 0.5) scored.push({ ...c, score });
    }
    scored.sort((x, y) => y.score - x.score);

    if (scored.length >= 2 && scored[0].score - scored[1].score < 0.1) {
      return scored; // 歧义：返回全部命中，由调用方报错枚举
    }
    return scored.slice(0, 1);
  }

  /**
   * 构建"目标库不存在且无相似项"报错：枚举现有小说库，让 LLM 带正确 dbPath 一次重试
   */
  _dbNotFoundError(input, candidates = []) {
    const lines = [`小说数据库 "${input}" 不存在，且未找到相似的小说库。`];
    if (candidates.length > 0) {
      lines.push('现有小说数据库（请改用列表中的真实文件名重试）：');
      for (const c of candidates) {
        lines.push(`  - ${path.basename(c.path)} | 《${c.novelName || '未命名'}》 | ${c.chapterCount} 章正文`);
      }
    } else {
      lines.push('当前没有任何小说数据库。若要创建新小说，请先用 action:"saveNovelPlan" 保存小说规划。');
    }
    return lines.join('\n');
  }

  /**
   * 构建"多个相似库歧义"报错：列出候选与相似度，要求 LLM 用精确文件名重试
   */
  _dbAmbiguousError(input, hits) {
    const lines = [`小说数据库 "${input}" 不存在，且找到多个相似的小说库，无法自动定位。请用精确文件名重试：`];
    for (const c of hits) {
      lines.push(`  - ${path.basename(c.path)} | 《${c.novelName || '未命名'}》 | ${c.chapterCount} 章正文（相似度 ${(c.score * 100).toFixed(0)}%）`);
    }
    return lines.join('\n');
  }

  /**
   * Agent meta.json 路径（发布策略存放于 config.publish 节点）
   * @returns {string} meta.json 绝对路径
   */
  _getAgentMetaPath() {
    // ainovel: 发布/写作策略放 <项目根>/config/writer.json
    return path.join(this.workspace || process.cwd(), 'config', 'writer.json');
  }

  /**
   * 读取 Agent 级发布配置（meta.json 的 config.publish）：{ servers, autoPublish, directory }
   * @returns {Object} 发布配置；读取失败时返回空对象
   */
  _readAgentPublishConfig() {
    try {
      const meta = fs.readJsonSync(this._getAgentMetaPath());
      return meta?.config?.publish || {};
    } catch {
      return {};
    }
  }

  /**
   * 发布配置脱敏视图（供 LLM 输出）：servers 只保留定位信息，不透出认证字段
   * @param {Object} publish - meta.json 中的 config.publish
   * @returns {Object} 脱敏后的发布配置
   */
  _maskPublishConfig(publish) {
    const servers = Array.isArray(publish?.servers)
      ? publish.servers.map(s => ({ name: s.name, host: s.host, siteUrl: s.siteUrl || '' }))
      : [];
    return { autoPublish: publish?.autoPublish, directory: publish?.directory || '', servers };
  }

  /**
   * 更新发布策略（autoPublish / directory）并写回 meta.json config.publish。
   * 保留已有 servers（服务器凭据由 Web 管理界面维护，不允许 LLM 写入）
   * @param {Object} info - { autoPublish?: boolean|'ask', directory?: string }
   * @returns {Object} 更新后的 config.publish
   */
  _updateAgentPublishConfig(info) {
    const metaPath = this._getAgentMetaPath();
    let meta = {};
    try {
      meta = fs.readJsonSync(metaPath);
    } catch { /* meta.json 不存在或损坏时重建 */ }
    if (!meta.config) meta.config = {};
    if (!meta.config.publish) meta.config.publish = {};
    const publish = meta.config.publish;

    if (info.autoPublish !== undefined) {
      publish.autoPublish = info.autoPublish === 'ask' ? 'ask' : Boolean(info.autoPublish);
    }
    if (info.directory !== undefined) {
      publish.directory = String(info.directory || '').trim();
    }

    fs.writeJsonSync(metaPath, meta, { spaces: 2 });
    return publish;
  }

  /**
   * 读取 Agent 级写作策略（meta.json 的 config.writer）：{ duplicatePolicy }
   * duplicatePolicy: 'skip'（保留已有、只补缺失）| 'overwrite'（覆盖重写）
   * @returns {Object}
   */
  _readWriterPolicy() {
    try {
      const meta = fs.readJsonSync(this._getAgentMetaPath());
      return meta?.config?.writer || {};
    } catch {
      return {};
    }
  }

  /**
   * 更新写作策略并写回 meta.json config.writer
   * @param {Object} patch - 合并写入的字段
   * @returns {Object} 更新后的 config.writer
   */
  _updateWriterPolicy(patch) {
    const metaPath = this._getAgentMetaPath();
    let meta = {};
    try {
      meta = fs.readJsonSync(metaPath);
    } catch { /* meta.json 不存在或损坏时重建 */ }
    if (!meta.config) meta.config = {};
    if (!meta.config.writer) meta.config.writer = {};
    Object.assign(meta.config.writer, patch);
    fs.writeJsonSync(metaPath, meta, { spaces: 2 });
    return meta.config.writer;
  }

  /**
   * 生成前硬关卡①：重复内容处理确认。
   * 库中已有章节正文时，弹确认卡片让用户选择：保留已有只补缺失 / 覆盖重写 / 中止。
   * 选择持久化到 config.writer.duplicatePolicy，同一 Agent 后续不再重复询问。
   * 非前端会话（CLI/定时任务）无法弹卡片，按安全默认（保留已有、只补缺失）处理。
   * @param {Object} db - writer 数据库实例
   * @returns {Promise<{mode: 'append'|'overwrite'|'abort'}>}
   */
  async _confirmDuplicateHandling(db) {
    // 已有持久化决策：直接沿用
    const policy = this._readWriterPolicy().duplicatePolicy;
    if (policy === 'skip') return { mode: 'append' };
    if (policy === 'overwrite') return { mode: 'overwrite' };

    // 判定重复：统计已有正文的章节
    let withContent = [];
    try {
      const chapters = db.getAllChapters({ includeContent: false });
      withContent = chapters.filter(ch => ch.no > 0 && ch.content && String(ch.content).trim());
    } catch { /* 读取失败按无重复处理，交由生成逻辑自行报错 */ }
    if (withContent.length === 0) return { mode: 'append' };

    const requestConfirmation = this.context?.requestConfirmation;
    if (typeof requestConfirmation !== 'function') {
      // 非工具注入路径：安全默认（不覆盖）
      return { mode: 'append' };
    }

    const sample = withContent.slice(0, 5).map(ch => `第${ch.no}章`).join('、');
    // preApprovalKey：goal 模式下该关卡已在预批清单中被用户逐项批准时，免卡片直接应用预批决策；
    // 未预批（非 goal 模式/选了"遇到时确认"）时照常弹卡片，不影响既有行为
    const decision = await requestConfirmation({
      title: '检测到已有章节内容',
      summary: `该小说数据库已有 ${withContent.length} 章正文（${sample}${withContent.length > 5 ? '…' : ''}）。批量生成前请选择处理方式：`,
      riskNote: '「全部重写」会覆盖已有章节正文，操作不可撤销',
      options: [
        { value: 'skip', label: '保留已有，只补写缺失章节', primary: true },
        { value: 'overwrite', label: '全部重写（覆盖已有章节）' },
        { value: 'abort', label: '暂不生成' }
      ],
      preApprovalKey: 'gate:writer.duplicateContent'
    });

    // 无前端承接（理论上 requestConfirmation 存在即前端会话，此分支为容错）
    if (!decision) {
      this._updateWriterPolicy({ duplicatePolicy: 'skip' });
      return { mode: 'append' };
    }

    // 拒绝/超时/中止选项：一律不动已有内容
    const chosen = decision.approved ? (decision.selectedOption || 'skip') : 'abort';
    if (!decision.approved || decision.reason === 'timeout' || chosen === 'abort') {
      return { mode: 'abort' };
    }
    const mode = chosen === 'overwrite' ? 'overwrite' : 'append';
    this._updateWriterPolicy({ duplicatePolicy: chosen === 'overwrite' ? 'overwrite' : 'skip' });
    return { mode };
  }

  /**
   * 生成前硬关卡②：发布策略事前确认。
   * 用户最初要求未涉及发布方式（autoPublish 未配置）时，动笔前弹确认卡片一次定策略，
   * 并持久化到 config.publish.autoPublish，后续章节生成不再逐章询问
   * （历史教训：软提示让模型"自己去问"会导致模型跑偏、任务链中断）。
   * 非前端会话默认不自动发布，同样持久化避免重复判断。
   * @returns {Promise<void>}
   */
  async _confirmPublishStrategyIfNeeded() {
    const autoPublish = this._readAgentPublishConfig().autoPublish;
    if (autoPublish !== undefined) return; // 策略已决定（含显式关闭），不打扰

    const requestConfirmation = this.context?.requestConfirmation;
    if (typeof requestConfirmation !== 'function') {
      // 非工具注入路径：默认不自动发布
      this._updateAgentPublishConfig({ autoPublish: false });
      return;
    }

    const decision = await requestConfirmation({
      title: '发布方式确认',
      summary: '本 Agent 尚未设置发布策略。开始生成正文前，请选择小说完成后的发布方式：',
      options: [
        { value: 'chapter', label: '写一章发一章（自动发布）', primary: true },
        { value: 'manual', label: '先不发布，写完后由我决定' },
        { value: 'none', label: '不需要发布' }
      ],
      preApprovalKey: 'gate:writer.publishStrategy'
    });

    // 无前端承接 / 拒绝 / 超时：一律按"不自动发布"持久化（安全默认，不阻塞写作）
    const chosen = decision && decision.approved ? (decision.selectedOption || 'manual') : 'manual';
    this._updateAgentPublishConfig({ autoPublish: chosen === 'chapter' });
  }

  /**
   * 需要与发布联动的章节写入动作（自动发布触发范围 / 确认提示范围）
   * @param {string} action - 章节操作动作
   * @returns {boolean}
   */
  _needAskPublishPreference(action) {
    return ['generate', 'add', 'modify', 'delete', 'generateAll'].includes(action);
  }

  /**
   * 计划阶段确认提示：已废除（恒返回 null）。
   * 发布策略事前确认已改由生成前硬关卡（_confirmPublishStrategyIfNeeded 确认卡片）
   * 以程序强制承接；「展示计划并等待确认」由全局任务确认规范 + 计划确认卡片覆盖。
   * 保留方法签名以兼容既有调用点
   * @returns {null}
   */
  _planConfirmationHint() {
    return null;
  }

  /**
   * 自动发布 hook：章节写入成功后，若已配置 autoPublish===true 则立即发布（写一章发一章）。
   * 服务器配置唯一来源：Agent meta.json config.publish.servers（全局系统配置入口已废除）。
   * 发布失败不影响章节写入结果，返回结构化结果交由 LLM 如实反馈
   * @param {Object} result - 章节操作结果（含 action）
   * @param {string} dbPath - 小说数据库绝对路径
   * @returns {Promise<Object|null>} 发布结果/跳过说明；未开启自动发布时返回 null
   */
  async _autoPublishIfNeeded(result, dbPath) {
    if (!this._needAskPublishPreference(result?.action)) return null;

    const publishCfg = this._readAgentPublishConfig();
    if (publishCfg.autoPublish !== true) return null;

    // 动态引入发布模块：未开启自动发布时不加载 novelPublisher 的依赖链
    const { publishNovel, resolveSecret } =
      await import('../../skills/novelPublisher/publish.js');

    // 服务器配置：仅 Agent 级（meta.json config.publish.servers）
    const servers = Array.isArray(publishCfg.servers) && publishCfg.servers.length > 0
      ? publishCfg.servers
      : [];
    if (servers.length === 0) {
      return { skipped: true, reason: '已开启自动发布，但未配置发布服务器（请在 Web 管理界面「Agent → 设定 → 发布配置」中设置）' };
    }

    const directory = publishCfg.directory || servers[0].directory;
    if (!directory) {
      return { skipped: true, reason: '已开启自动发布，但未设置目标目录（directory），请向用户确认后调用 setPublishConfig 补全' };
    }

    const server = { ...servers[0] };
    // 解析密码占位符；Agent 级配置认证字段为 pass，统一为 password
    server.password = resolveSecret(server.pass ?? server.password);
    delete server.pass;
    server.directory = directory;

    // sessionDir 仅用于 chapter_XX.md 兼容回退与存在性预检；现行章节存于小说库
    const sessionDir = this.context?.sessionWorkspace && fs.existsSync(this.context.sessionWorkspace)
      ? this.context.sessionWorkspace
      : process.cwd();

    try {
      console.log('📤 章节写入完成，自动发布中...');
      const pubResult = await publishNovel(sessionDir, server, { dbPath });
      console.log(`✅ 自动发布成功: ${pubResult.novelUrl}`);
      return pubResult;
    } catch (error) {
      console.error(`❌ 自动发布失败（章节写入不受影响）: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * 为章节操作输出追加自动发布结果或发布策略确认提示
   * @param {string} text - formatResult 的基础输出
   * @param {Object} result - 章节操作结果（可能含 publishResult / askPublishPreference）
   * @returns {string} 追加后的输出文本
   */
  _appendPublishOutcome(text, result) {
    if (!result) return text;

    const pub = result.publishResult;
    if (pub) {
      if (pub.skipped) {
        return `${text}\n\n⚠️ 自动发布已跳过: ${pub.reason}`;
      }
      if (pub.success) {
        return `${text}\n\n📤 已自动发布（本次上传 ${pub.uploadedCount} 个文件，共 ${pub.chapterCount} 章）\n🏠 小说列表首页: ${pub.indexUrl}\n📖 本小说目录页: ${pub.novelUrl}`;
      }
      return `${text}\n\n⚠️ 自动发布失败（章节写入不受影响）: ${pub.error || '未知错误'}`;
    }

    // 发布策略询问已由生成前硬关卡（确认卡片）承接，结果文本不再附加软提示，
    // 避免诱导模型偏离主任务（历史事故：逐章询问提示导致模型跑偏、任务链中断）
    return text;
  }

  /**
   * 列出 agent 数据目录下的所有小说数据库（统一管理视图）
   * 只读打开每个 db，读取小说名（no=0）与章节数；损坏/空库也能列出文件名
   * @returns {Promise<Array<{file, dbPath, name, chapterCount, updatedAt}>>}
   */
  async listNovelDatabases() {
    // 跨 agent 目录枚举：小说库可能由不同子 Agent 创建（planner 建库/writer 写章节）
    const novels = [];

    for (const dataDir of this._getAllAgentDataDirs()) {
      if (!fs.existsSync(dataDir)) continue;
      const dbFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.db'));

      for (const file of dbFiles) {
        const dbPath = path.join(dataDir, file);
        const entry = { file, dbPath, name: null, chapterCount: 0, updatedAt: null };
        try {
          const Database = (await import('better-sqlite3')).default;
          const db = new Database(dbPath, { readonly: true });
          try {
            const infoRow = db.prepare("SELECT name, updated_at FROM content WHERE no = 0").get();
            entry.name = infoRow?.name || null;
            entry.updatedAt = infoRow?.updated_at || null;
            const countRow = db.prepare("SELECT COUNT(*) AS c FROM content WHERE no >= 1 AND type = 'chapter' AND content IS NOT NULL AND content != ''").get();
            entry.chapterCount = countRow?.c || 0;
          } finally {
            db.close();
          }
        } catch {
          // 损坏或表结构不符的 db 也保留条目，仅标记无法读取
        }
        novels.push(entry);
      }
    }

    return novels;
  }

  /**
   * 格式化执行结果为易读的字符串
   * 若本次调用发生了模糊定位（dbRedirectNote），将提示注入结果头部，让 LLM/用户知晓实际操作了哪个库
   */
  formatResult(result) {
    const redirectNote = this.dbRedirectNote;
    this.dbRedirectNote = null; // 消费一次，避免同一实例多次 formatResult 重复注入
    const output = this._formatResultBody(result);
    return redirectNote ? `${redirectNote}\n\n${output}` : output;
  }

  /**
   * 格式化主体
   */
  _formatResultBody(result) {
    if (!result.success) {
      return `操作失败: ${result.error}`;
    }

    switch (result.action) {
      case 'listNovels': {
        // 该输出常被规划层整段粘贴为 dbPath 参数，保持纯文本（无 emoji/装饰线），
        // 既避免截断切出孤立代理对，也让下游提取文件名更稳定
        const lines = [
          `小说数据库列表`,
          `数据目录: ${result.dataDir}`,
          `-------------------`
        ];
        if (!result.novels || result.novels.length === 0) {
          lines.push('（暂无小说数据库，请先使用 novelPlan 技能创建小说规划）');
          return lines.join('\n');
        }
        result.novels.forEach(n => {
          const title = n.name || '（未命名）';
          lines.push(`  ${title}`);
          lines.push(`     文件: ${n.file} | 已写章节: ${n.chapterCount}${n.updatedAt ? ` | 更新: ${n.updatedAt}` : ''}`);
        });
        lines.push('');
        lines.push('提示: 继续操作某本小说时，请在 dbPath 参数中传入对应的文件名');
        return lines.join('\n');
      }

      case 'getPublishConfig':
      case 'setPublishConfig': {
        const p = result.publish || {};
        const autoText = p.autoPublish === true
          ? '已开启（每章写入成功后立即发布）'
          : p.autoPublish === false
            ? '已关闭'
            : '未设置（写作前应先向用户确认发布策略）';
        const serverCount = Array.isArray(p.servers) ? p.servers.length : 0;
        const lines = [
          result.action === 'setPublishConfig' ? '✓ 发布配置已更新' : '📤 发布配置',
          '━━━━━━━━━━━━━━━',
          `自动发布: ${autoText}`,
          `目标目录: ${p.directory || '（未设置）'}`,
          `发布服务器: ${serverCount > 0 ? `${serverCount} 台（${p.servers.map(s => s.name).join(', ')}）` : '（未配置，请在 Web 管理界面「发布配置」中设置）'}`
        ];
        return lines.join('\n');
      }

      case 'getNovelInfo':
        if (!result.novelInfo) {
          return '⚠️ 数据库中没有小说信息，请先使用 novelPlan 技能创建小说概要';
        }

        const info = [
          `📖 小说信息`,
          `━━━━━━━━━━━━━━━`,
          `名称: ${result.novelInfo.name}`,
          `版本: ${result.novelInfo.version}`,
          `数据库: ${result.dbPath || ''}`,
          `设定说明页: ${result.hasPreface ? `已写（${result.prefaceLength} 字）` : '未写（可调用 generatePreface 生成）'}`,
          ``,
          `📝 故事概要:`,
          `${result.novelInfo.outline.substring(0, 200)}${result.novelInfo.outline.length > 200 ? '...' : ''}`,
          ``
        ];

        // 部结构：让"分了几部、每部管到第几章、导言是否已生成"一眼可见
        info.push(`🧭 分部结构: ${result.partCount > 0 ? `${result.partCount} 部` : '未分部（整本为单层章节）'}`);
        if (result.partCount > 0) {
          result.parts.forEach(p => {
            info.push(`  ${p.label}｜第${p.startNo}–${p.endNo}章（${p.chapters} 章）｜导言: ${p.hasIntro ? '已有' : '缺（generatePartIntros）'}`);
          });
        }
        info.push('');
        info.push(`📚 章节大纲: ${result.totalChapters} 章`);
        info.push(`━━━━━━━━━━━━━━━`);

        if (result.chapterOutlines && result.chapterOutlines.length > 0) {
          result.chapterOutlines.forEach(ch => {
            const partTag = ch.part_no > 0
              ? ` [${(result.parts.find(p => p.no === ch.part_no) || {}).label || toChineseOrdinal(ch.part_no, '部')}]`
              : '';
            info.push(`  第${ch.no}章: ${ch.name}${partTag}`);
          });
        } else {
          info.push(`  （暂无章节大纲）`);
        }

        return info.join('\n');

      case 'saveNovelPlan':
        const saveMsg = [`✓ 小说规划已保存`, `小说名称: ${result.name || '未知'}`, `版本: ${result.version}`];
        if (result.dbPath) {
          saveMsg.push(`数据库: ${result.dbPath}`);
        }
        if (result.autoGeneratedOutlines) {
          saveMsg.push('');
          saveMsg.push(`📖 已自动生成 ${result.totalChapters} 个章节大纲:`);
          if (result.outlines && result.outlines.length > 0) {
            result.outlines.forEach(o => {
              saveMsg.push(`  ✓ 第${o.no}章: ${o.name}`);
            });
          }
          if (result.failCount > 0) {
            saveMsg.push(`  ⚠️ 失败: ${result.failCount} 章`);
          }
        } else {
          saveMsg.push(`操作: ${result.action}`);
        }
        return saveMsg.join('\n');

      case 'addChapterOutline':
        return `✓ 章节大纲已添加\n章节号: ${result.no}\n操作: ${result.dbAction}\n注意: 后续章节编号已自动+1`;

      case 'updateChapterOutline':
        return `✓ 章节大纲已更新\n章节号: ${result.no}\n操作: ${result.dbAction}`;

      case 'reNumberChapters':
        return `✓ 章节编号已更新\n受影响章节数: ${result.shiftedCount || 0}`;

      case 'generateChapterOutlines':
        const outlineSummary = [
          `✓ 成功生成 ${result.totalChapters} 个章节大纲`,
          ''
        ];
        if (result.successCount > 0) {
          outlineSummary.push('已生成的章节大纲:');
          result.outlines.forEach(o => {
            outlineSummary.push(`  ✓ 第${o.no}章: ${o.name}`);
          });
        }
        if (result.failCount > 0) {
          outlineSummary.push('');
          outlineSummary.push('失败的章节:');
          result.errors.forEach(e => {
            outlineSummary.push(`  ✗ 第${e.no}章: ${e.error}`);
          });
        }
        return outlineSummary.join('\n');

      case 'generate':
        const genMsg = [`✓ 成功生成第${result.chapter}章`, `标题: ${result.name}`, `字数: ${result.wordCount} 字`, `数据库操作: ${result.dbAction}`];
        if (result.autoGeneratedOutline) {
          genMsg.splice(1, 0, `注意: 章节大纲已自动生成`);
        }
        return genMsg.join('\n');

      case 'generateAll':
        const summary = [
          `✓ 批量生成完成`,
          `总章节数: ${result.totalChapters}`,
          `成功: ${result.successCount} 章`,
          `失败: ${result.failCount} 章`,
          ''
        ];

        if (result.failCount > 0) {
          summary.push('失败的章节:');
          result.results
            .filter(r => !r.success)
            .forEach(r => {
              summary.push(`  - 第${r.chapter}章: ${r.error}`);
            });
          summary.push('');
        }

        summary.push('已成功生成的章节:');
        result.results
          .filter(r => r.success)
          .forEach(r => {
            summary.push(`  ✓ 第${r.chapter}章: ${r.name} (${r.wordCount} 字)`);
          });

        return summary.join('\n');

      case 'add':
        return `✓ 成功添加第${result.chapter}章\n标题: ${result.name}\n字数: ${result.wordCount} 字\n数据库操作: ${result.dbAction}\n注意: 后续章节已自动重排`;

      case 'modify':
        return `✓ 成功修改第${result.chapter}章\n标题: ${result.name}\n字数: ${result.wordCount} 字\n修改说明: ${result.modifications}`;

      case 'delete':
        return `✓ 成功删除第${result.chapter}章\n标题: ${result.name}\n注意: 后续章节已自动重排`;

      default:
        return JSON.stringify(result, null, 2);
    }
  }

  /**
   * 生成所有章节大纲并保存到数据库
   * @param {number} totalChapters - 章节总数（从用户输入中取得），默认 10
   */
  async generateAllChapterOutlines(totalChapters = 10) {
    // 读取小说概要
    const novelInfo = this.db.getNovelInfo();

    if (!novelInfo || !novelInfo.outline) {
      throw new Error('数据库中没有小说概要信息，请先使用 saveNovelInfo 保存小说概要');
    }

    console.log(`📋 开始生成章节大纲...`);
    console.log(`📖 小说名称: ${novelInfo.name}`);
    console.log(`📚 计划章节数: ${totalChapters} 章`);

    // 会话可见性：大纲生成为单次长调用，先给前端一条进度，避免界面卡在 loading
    const sessionId = this.context?.sessionId || null;
    if (sessionId) {
      progressHub.publish(sessionId, `📋 正在生成 ${totalChapters} 章大纲（约需 1-2 分钟）...`);
    }

    // 使用 LLM 生成所有章节大纲
    const outlines = await this.generateChapterOutlinesWithLLM(novelInfo, totalChapters);

    if (sessionId) {
      progressHub.publish(sessionId, `✅ 章节大纲生成完成，共 ${outlines.length} 章`);
    }

    // 批量保存到数据库
    const savedOutlines = [];
    const errors = [];

    for (const outline of outlines) {
      try {
        this.db.upsertChapter({
          no: outline.no,
          name: outline.name,
          outline: outline.outline,
          content: '' // 章节内容为空，等待 novelWriter 生成
        });
        savedOutlines.push(outline);
        console.log(`✅ 第${outline.no}章大纲已保存: ${outline.name}`);
      } catch (error) {
        errors.push({ no: outline.no, error: error.message });
        console.error(`❌ 第${outline.no}章大纲保存失败: ${error.message}`);
      }
    }

    return {
      success: errors.length === 0,
      totalChapters: outlines.length,
      successCount: savedOutlines.length,
      failCount: errors.length,
      outlines: savedOutlines,
      errors: errors
    };
  }

  /**
   * 使用 LLM 生成所有章节大纲
   * @param {Object} novelInfo - 小说概要信息
   * @param {number} totalChapters - 章节总数
   */
  async generateChapterOutlinesWithLLM(novelInfo, totalChapters) {
    // 从设定中提取目标字数（如有）
    const wordCountMatch = String(novelInfo.content || '').match(/【每章目标字数[：:]\s*(\d+)】/);
    const targetWC = wordCountMatch ? parseInt(wordCountMatch[1], 10) : null;

    const prompt = `你是一位专业的小说策划师。请根据以下小说概要，生成详细的章节大纲。

## 小说名称
${novelInfo.name}

## 故事概要
${novelInfo.outline}

${novelInfo.content ? `## 角色设定与世界观\n${novelInfo.content}` : ''}

## 任务
为这部小说生成完整的章节大纲，共 ${totalChapters} 章。

要求：
1. 必须生成 exactly ${totalChapters} 个章节
2. 每个章节必须有：
   - 章节编号（从 1 开始，到 ${totalChapters} 结束）
   - 章节标题（简洁有力）
   - 详细的大纲内容（包含主要情节、关键事件、角色发展、与前后章节的衔接）
3. 大纲要足够详细，让作家可以直接根据大纲生成章节内容
4. 章节之间要有逻辑连贯性和情节递进
5. 合理分配故事节奏：开端、发展、高潮、结局
6. 🔴 角色姓名锁死：大纲中提及角色时必须使用设定里给出的名字（如主角、反派、各章导师），
   严禁改名、换昵称或新造主要角色；若设定列有章节推进表，必须逐章按表实写
${targetWC ? `7. 🔴 每章大纲必须明确标注“本章约 ${targetWC} 字”，以便正文生成器严格执行` : ''}

## 输出格式
请严格按照以下 JSON 格式返回（不要包含任何其他内容）：

[
  {
    "no": 1,
    "name": "章节标题",
    "outline": "详细的大纲内容..."
  },
  {
    "no": 2,
    "name": "章节标题",
    "outline": "详细的大纲内容..."
  }
]

请生成 ${totalChapters} 个章节的大纲：`;

    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;
    const maxTokens = this.context?.maxTokens || 16384; // 需要较多 token 来生成多个大纲
    const reasoningEffort = this.context?.reasoningEffort || null;

    const response = await llm.chat({
      messages: [
        {
          role: 'system',
          content: '你是一位专业的小说策划师，擅长规划完整的故事结构和章节大纲。你必须返回有效的 JSON 格式。'
        },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      reasoningEffort,
      think: false
    });

    // 解析 JSON 响应
    try {
      const content = response.content || '[]';
      // 尝试提取 JSON 数组
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const outlines = JSON.parse(jsonMatch[0]);

        // 验证数据格式
        if (!Array.isArray(outlines)) {
          throw new Error('LLM 返回的数据不是数组格式');
        }

        // 确保每个大纲都有必要的字段，并按章节号排序保证顺序
        return outlines
          .map((o, index) => ({
            no: o.no || (index + 1),
            name: o.name || `第${o.no || (index + 1)}章`,
            outline: o.outline || '（无大纲内容）'
          }))
          .sort((a, b) => a.no - b.no);
      } else {
        throw new Error('LLM 返回的内容中未找到有效的 JSON 数组');
      }
    } catch (error) {
      console.error('解析 LLM 返回的大纲数据失败:', error.message);
      console.error('原始响应:', response.content);
      throw new Error(`生成章节大纲失败: ${error.message}`);
    }
  }

  /**
   * 使用 LLM 仅为单个章节生成大纲（用于已有大纲体系但某章缺大纲的场景，
   * 如新增章节插入后的空位），避免全量重建大纲覆盖现有章节
   * @param {number} chapterNo - 章节号
   * @param {Object} novelInfo - 小说概要信息
   * @returns {Promise<{name: string, outline: string}>}
   */
  async generateSingleChapterOutlineWithLLM(chapterNo, novelInfo) {
    const neighbors = this.db.getAllChapters({ includeContent: false }).filter(ch => ch.no > 0);
    const prev = neighbors.find(ch => ch.no === chapterNo - 1);
    const next = neighbors.find(ch => ch.no === chapterNo + 1);

    const prompt = `你是一位专业的小说策划师。请根据以下信息，为第${chapterNo}章生成章节大纲。

## 小说名称
${novelInfo.name}

## 故事概要
${novelInfo.outline}

${prev ? `## 上一章（第${prev.no}章：${prev.name}）大纲\n${prev.outline}\n` : ''}${next ? `## 下一章（第${next.no}章：${next.name}）大纲\n${next.outline}\n` : ''}## 任务
为第${chapterNo}章生成详细大纲，要求：
1. 与上一章、下一章（如存在）自然衔接，情节递进合理
2. 包含主要情节、关键事件、角色发展
3. 大纲足够详细，让作家可以直接根据大纲生成章节内容

## 输出格式
请严格按照以下 JSON 格式返回（不要包含任何其他内容）：
{"name": "章节标题", "outline": "详细的大纲内容..."}`;

    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;
    const maxTokens = this.context?.maxTokens || 4096;
    const reasoningEffort = this.context?.reasoningEffort || null;

    const response = await llm.chat({
      messages: [
        {
          role: 'system',
          content: '你是一位专业的小说策划师，擅长规划故事结构和章节大纲。你必须返回有效的 JSON 格式。'
        },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      reasoningEffort,
      think: false
    });

    const content = response.content || '';
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          name: parsed.name || `第${chapterNo}章`,
          outline: parsed.outline || '（无大纲内容）'
        };
      } catch (error) {
        console.error('解析单章大纲 JSON 失败:', error.message);
      }
    }

    // JSON 解析失败时兜底：直接使用返回文本作为大纲
    return {
      name: `第${chapterNo}章`,
      outline: content.trim() || '（无大纲内容）'
    };
  }

  /**
   * 格式化章节号（如 1 -> 0001）
   */
  formatChapterNumber(num) {
    return String(num).padStart(4, '0');
  }

  /**
   * 规范化章节正文开头的大标题，确保章节号与实际章节一致
   * - 首行是标题且含错误的"第X章"：替换为正确章节号
   * - 首行是标题但无章节号：补上章节号前缀
   * - 首行不是标题：补充完整标题行
   * @param {string} content - 章节正文
   * @param {number} chapterNo - 正确的章节号
   * @returns {string} 规范化后的正文
   */
  normalizeChapterHeading(content, chapterNo) {
    const trimmed = String(content || '').replace(/^\s+/, '');
    const lines = trimmed.split('\n');
    const first = lines[0] || '';

    if (/^#\s+/.test(first)) {
      let rest = first.replace(/^#\s+/, '').trim();
      if (/第\s*\d+\s*章/.test(rest)) {
        rest = rest.replace(/第\s*\d+\s*章/, `第${chapterNo}章`);
      } else if (/^第\s*[一二三四五六七八九十百零两]+\s*章/.test(rest)) {
        rest = rest.replace(/^第\s*[一二三四五六七八九十百零两]+\s*章/, `第${chapterNo}章`);
      } else if (rest) {
        rest = `第${chapterNo}章：${rest}`;
      } else {
        rest = `第${chapterNo}章`;
      }
      lines[0] = `# ${rest}`;
      return lines.join('\n');
    }

    return `# 第${chapterNo}章\n\n${trimmed}`;
  }

  /**
   * 获取章节文件名
   */
  getChapterFileName() {
    const chapterNum = this.formatChapterNumber(this.chapter);
    return `chapter_${chapterNum}.md`;
  }

  /**
   * 读取章节大纲（从数据库）
   * 直接读取指定章节的 outline 字段
   */
  async readOutline() {
    try {
      // 如果指定了章节号，读取该章节的大纲
      if (this.chapter) {
        const chapterData = this.db.getChapter(this.chapter);

        if (chapterData && chapterData.outline) {
          return {
            content: chapterData.outline,
            path: `database:chapter_${this.chapter}`,
            chapterData: chapterData
          };
        }

        // 如果章节存在但没有大纲
        if (chapterData) {
          return {
            success: false,
            error: `第${this.chapter}章存在但没有大纲信息`
          };
        }

        // 章节不存在，列出所有章节
        const allChapters = this.db.getAllChapters({ includeContent: false });
        const existingNos = allChapters.filter(ch => ch.no > 0).map(ch => ch.no);

        return {
          success: false,
          error: `第${this.chapter}章不存在 (现有章节: ${existingNos.join(', ') || '无'})`
        };
      }

      // 如果没有指定章节号，返回所有章节大纲
      const allChapters = this.db.getAllChapters({ includeContent: false });
      const chapterOutlines = allChapters.filter(ch => ch.no > 0 && ch.outline);

      if (chapterOutlines.length > 0) {
        // 将所有大纲合并为一个文本（用于生成所有章节）
        const combinedOutline = chapterOutlines.map(ch =>
          `第${ch.no}章：${ch.name}\n${ch.outline}`
        ).join('\n\n');

        return {
          content: combinedOutline,
          path: 'database:all_chapters',
          chapterOutlines: chapterOutlines
        };
      }

      // 如果数据库中没有章节大纲
      return {
        success: false,
        error: '数据库中没有章节大纲信息，请先使用 generateChapterOutlines 生成大纲'
      };
    } catch (error) {
      throw new Error(`读取大纲失败: ${error.message}`);
    }
  }

  /**
   * @deprecated 此方法已废弃
   * 旧的设计中用于从长文本大纲中提取章节大纲
   * 现在每个章节的 outline 字段直接存储该章节的大纲
   */
  extractChapterOutline(outlineContent) {
    console.warn('⚠️  extractChapterOutline 方法已废弃，请直接使用 readOutline()');

    // 检查输入是否有效
    if (!outlineContent || typeof outlineContent !== 'string') {
      throw new Error(`大纲内容无效: ${typeof outlineContent}`);
    }

    const chapterPatterns = [
      new RegExp(`第${this.chapter}章[\\s\\S]*?(?=第${this.chapter + 1}章|$)`, 'i'),
      new RegExp(`Chapter\\s+${this.chapter}[\\s\\S]*?(?=Chapter\\s+${this.chapter + 1}|$)`, 'i'),
      new RegExp(`第${['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][this.chapter]}章[\\s\\S]*?(?=第|$)`, 'i')
    ];

    for (const pattern of chapterPatterns) {
      const match = outlineContent.match(pattern);
      if (match) {
        return match[0].trim();
      }
    }

    // 尝试通用的章节匹配
    const genericPattern = new RegExp(`(?:第|Chapter\\s+)${this.chapter}[^\\n]*[\\s\\S]*?(?=(?:第|Chapter\\s+)${this.chapter + 1}|$)`, 'i');
    const match = outlineContent.match(genericPattern);
    if (match) {
      return match[0].trim();
    }

    throw new Error(`未在大纲中找到第${this.chapter}章的内容`);
  }

  /**
   * 读取现有章节（从数据库）
   */
  async readChapter() {
    const chapterData = this.db.getChapter(this.chapter);

    if (!chapterData) {
      const allChapters = this.db.getAllChapters({ includeContent: false });
      const existingNos = allChapters.filter(ch => ch.no > 0).map(ch => ch.no);
      const suffix = existingNos.length > 0
        ? `(现有章节: ${existingNos.join(', ')})`
        : '(该库中没有任何章节，请确认 dbPath 是否指向了正确的小说库)';
      throw new Error(`章节不存在: 第${this.chapter}章 ${suffix}`);
    }

    return {
      content: chapterData.content,
      name: chapterData.name,
      outline: chapterData.outline,
      no: chapterData.no
    };
  }

  /**
   * 生成章节内容
   */
  async generateChapter() {
    // 读取章节大纲
    const outline = await this.readOutline();

    // 如果大纲不存在，首先生成大纲
    if (!outline || !outline.content) {
      console.log(`⚠️  检测到章节大纲不存在，开始自动生成...`);

      // 检查是否有小说概要
      const novelInfo = this.db.getNovelInfo();
      if (!novelInfo || !novelInfo.outline) {
        throw new Error('数据库中没有小说概要信息，请先使用 saveNovelInfo 保存小说概要');
      }

      let chapterOutline;
      let outlineName;

      // 检查是否已有其他章节的大纲
      const existingOutlines = this.db
        .getAllChapters({ includeContent: false })
        .filter(ch => ch.no > 0 && ch.outline);

      if (existingOutlines.length > 0) {
        // 已有大纲体系（如新增章节留下的空位）：仅为本章生成大纲，
        // 避免全量重建大纲覆盖现有章节内容
        console.log(`📋 已有章节大纲体系，仅为第${this.chapter}章生成大纲...`);
        const single = await this.generateSingleChapterOutlineWithLLM(this.chapter, novelInfo);
        chapterOutline = single.outline;
        outlineName = single.name;

        // 保存本章大纲（如已有内容则保留，不清空）
        const existingRow = this.db.getChapter(this.chapter);
        this.db.upsertChapter({
          no: this.chapter,
          name: outlineName,
          outline: chapterOutline,
          content: existingRow?.content || ''
        });
      } else {
        // 完全没有大纲：全量生成 10 章大纲
        const defaultTotalChapters = 10;
        console.log(`📋 正在生成 ${defaultTotalChapters} 个章节大纲...`);

        await this.generateAllChapterOutlines(defaultTotalChapters);

        // 重新读取大纲
        const newOutline = await this.readOutline();
        if (!newOutline || !newOutline.content) {
          throw new Error('生成大纲失败，请重试');
        }
        chapterOutline = newOutline.content;
        outlineName = newOutline.chapterData?.name;
      }

      console.log(`✅ 章节大纲已就绪，继续生成章节内容`);

      // 使用 LLM 生成章节内容（喂完整设定 + 连贯上下文）
      const settingText = this._combineSetting(novelInfo);
      const chapterContent = await this.generateChapterWithLLM(
        chapterOutline, settingText, this.chapter, null,
        this._buildContinuityContext(this.chapter, settingText)
      );

      // 规范化正文标题，确保章节号正确
      const normalizedContent = this.normalizeChapterHeading(chapterContent, this.chapter);

      // 提取章节标题（从生成的内容中）
      const titleMatch = normalizedContent.match(/^#\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章[：:]\s*(.+)$/m);
      const chapterName = titleMatch ? titleMatch[1].trim() : (outlineName || outline?.chapterData?.name || `第${this.chapter}章`);

      // 保存到数据库
      const result = this.db.upsertChapter({
        no: this.chapter,
        name: chapterName,
        outline: chapterOutline,
        content: normalizedContent
      });

      // 写操作后自动体检
      const check = await this._runPostWriteCheck({ chapterNos: [this.chapter], withBody: true });

      return {
        success: true,
        chapter: this.chapter,
        name: chapterName,
        wordCount: chapterContent.length,
        action: 'generate',
        dbAction: result.action,
        autoGeneratedOutline: true,
        check
      };
    }

    // 直接使用大纲内容
    const chapterOutline = outline.content;

    // 读取小说概要（作为上下文参考）
    const novelInfo = this.db.getNovelInfo();

    // 使用 LLM 生成章节内容（喂完整设定：概要+角色/世界观，并附上已出场角色清单与上一章结尾）
    const settingText = this._combineSetting(novelInfo);
    const chapterContent = await this.generateChapterWithLLM(
      chapterOutline, settingText, this.chapter, null,
      this._buildContinuityContext(this.chapter, settingText)
    );

    // 规范化正文标题，确保章节号正确
    const normalizedContent = this.normalizeChapterHeading(chapterContent, this.chapter);

    // 提取章节标题（从生成的内容中）
    const titleMatch = normalizedContent.match(/^#\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章[：:]\s*(.+)$/m);
    const chapterName = titleMatch ? titleMatch[1].trim() : (outline?.chapterData?.name || `第${this.chapter}章`);

    // 保存到数据库
    const result = this.db.upsertChapter({
      no: this.chapter,
      name: chapterName,
      outline: chapterOutline,
      content: normalizedContent
    });

    // 写操作后自动体检
    const check = await this._runPostWriteCheck({ chapterNos: [this.chapter], withBody: true });

    return {
      success: true,
      chapter: this.chapter,
      name: chapterName,
      wordCount: chapterContent.length,
      action: 'generate',
      dbAction: result.action,
      autoGeneratedOutline: false,
      check
    };
  }

  /**
   * 合并小说整体设定（故事概要 + 角色/世界观）。
   * 缺陷背景：生成正文时只喂 novelInfo.outline，角色设定所在的 content 字段从未进入提示词，
   * 导致正文与已保存的设定完全脱节
   * @param {Object|null} novelInfo - 小说概要记录
   * @returns {string} 合并后的设定文本
   */
  _combineSetting(novelInfo) {
    if (!novelInfo) return '';
    return [novelInfo.outline, novelInfo.content]
      .filter((s) => s && String(s).trim())
      .join('\n\n');
  }

  /**
   * 规划守卫：设定中的主角必须具名。
   * 缺陷背景：规划只写"主角是一位天赋平平的魔法学徒"而不给名字，逐章生成时模型只能
   * 每章临场编一个，实测造成同一部小说主角在 10 章里有 3 个名字
   * @param {Object} info - { outline, content }
   */
  _assertProtagonistNamed(info) {
    const text = `${info?.outline || ''}\n${info?.content || ''}`;
    // 仅对“定义式描述主角”的设定强制具名（主角是/主角：/主人公为…）；
    // “无固定主角”、“主角群像”这类一带而过的写法不拦，避免误伤群像/散文题材
    if (!/主\s*角\s*[：:是为(（]|主\s*角\s*一|主\s*人\s*公\s*[：:是为(（]/.test(text)) return;

    // 定名写法一：名叫/叫做/名为 + 名字
    if (/(?:名叫|叫做|名字叫|名为|人称)[\s]*[\u4e00-\u9fa5A-Za-z·]{2,8}/.test(text)) return;
    // 定名写法二：引号括起的名字
    if (/[「『“"][^」』”"]{2,8}[」』”"]/.test(text)) return;
    // 定名写法三：角色卡列表项 - **名字**：…（排除拿"主角/设定"等元词当名字）
    const card = /(?:^|\n)\s*[-*]\s*\*\*([^*\n]{2,10})\*\*\s*[：:]/.exec(text);
    if (card && !/主角|主人公|设定|世界|核心|主题|成长/.test(card[1])) return;
    // 定名写法四：主角定义行紧跟名字（"主角：阿明"、"主角是小空"）；
    // 若捕获串含量词/助词（“一位天赋平平的…”）则视为描述而非名字，继续走拦下分支
    const protoLine = /主\s*角\s*[：:是为(（]\s*([\u4e00-\u9fa5A-Za-z·]{2,6})/.exec(text);
    if (protoLine && !/[的一这那某位只个样类]/.test(protoLine[1])) return;

    throw new Error(
      '小说规划中的主角没有名字：设定里只出现“主角/主人公”，未给出具体姓名。' +
      '主角不具名会导致逐章生成时反复改名（同一角色写成不同称呼）。' +
      '请用下列任一形式补全后重试：「一只名叫小空的猴子」／角色卡「- **小空**：主角，一只小猴子」'
    );
  }

  /**
   * 部的展示名：有部名时为“第一部 · 启蒙篇”，无部名时仅“第一部”
   * 工具输出与发布层目录页均用此形式，避免两处各写一份
   * @param {{no:number,name?:string}} part
   * @returns {string}
   */
  _partLabel(part) {
    const ordinal = toChineseOrdinal(part.no, '部');
    const name = String(part.name || '').trim();
    return name ? `${ordinal} · ${name}` : ordinal;
  }

  /**
   * 校验并归一化 setParts 的人工划分输入
   * 规则（歧义一律报错，不猜）：起止章必须是 1..最大章号内的整数、各部不得重叠、
   * 必须从第 1 章起逐部首尾相接并覆盖到最后一章 —— 不留“未归部章节”这种含混状态
   * @param {Array} input - 原始 parts 输入
   * @param {number} maxNo - 当前最大章号
   * @returns {Array<{no:number,name:string,from:number,to:number}>} 归一化后的部列表（no 按顺序重编）
   */
  _normalizePartsInput(input, maxNo) {
    if (!Array.isArray(input)) {
      throw new Error('parts 必须是数组，如 [{ name, from, to }]');
    }
    if (input.length === 0) return [];
    if (!maxNo) {
      throw new Error('当前小说库没有任何章节，无法划分分部；请先生成章节大纲/正文');
    }

    const list = input.map((p, i) => {
      const from = Number(p.from);
      const to = Number(p.to);
      if (!Number.isInteger(from) || !Number.isInteger(to)) {
        throw new Error(`第${i + 1}个部的 from/to 必须是整数，收到 from=${JSON.stringify(p.from)}、to=${JSON.stringify(p.to)}`);
      }
      if (to < from) throw new Error(`第${i + 1}个部的起止章颠倒：${from}-${to}`);
      if (from < 1 || to > maxNo) {
        throw new Error(`第${i + 1}个部的范围 ${from}-${to} 超出实际章节范围 1-${maxNo}（当前共 ${maxNo} 章）`);
      }
      return { no: 0, name: p.name ? String(p.name).trim() : '', from, to };
    });

    list.sort((a, b) => a.from - b.from);
    list.forEach((p, i) => { p.no = i + 1; });

    const missing = [];
    let cursor = 1;
    for (const p of list) {
      if (p.from < cursor) {
        throw new Error(`第${p.from}–${p.to}章的部与前一部重叠（第 ${cursor} 章已属于前一部）；各部范围不得重叠`);
      }
      for (let n = cursor; n < p.from; n++) missing.push(n);
      cursor = p.to + 1;
    }
    for (let n = cursor; n <= maxNo; n++) missing.push(n);

    if (missing.length > 0) {
      throw new Error(`分部必须连续覆盖第 1–${maxNo} 章，以下章节未归入任何部：${missing.join('、')}。请补全部划分或调整起止章。`);
    }
    return list;
  }

  /**
   * 统一调用写作 LLM（配置与章节生成保持一致：agent 的 model/temperature/maxTokens）
   * @param {string} systemPrompt - 系统角色设定
   * @param {string} prompt - 用户提示词
   * @param {Object} [opts] - 选项
   * @param {number} [opts.maxTokens] - 输出上限，默认 4096
   * @param {string} [opts.progress] - 推给前端的进度文案
   * @returns {Promise<string>} 模型返回的正文
   */
  async _callWriterLLM(systemPrompt, prompt, opts = {}) {
    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;
    const maxTokens = opts.maxTokens || 4096;
    const reasoningEffort = this.context?.reasoningEffort || null;
    const sessionId = this.context?.sessionId || null;
    if (sessionId && opts.progress) {
      progressHub.publish(sessionId, opts.progress);
    }

    const response = await llm.chat({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      reasoningEffort,
      think: false
    });

    const text = String(response?.content || '').trim();
    if (!text) {
      // 空返回必须报错而不是写入空内容（否则会把 preface/summary 洗成空）
      throw new Error('LLM 返回空内容（可能是思考段耗尽 maxTokens 或上游异常），本次未写入任何数据');
    }
    return text;
  }

  // ─── 体检：LLM 语义检查层 ─────────────────────────────────────────

  /**
   * L1 全书大纲扫描（固定 1 次调用，不读正文）
   * @param {Object} novelInfo - 小说概要
   * @param {Array} chapters - 全部章节（含大纲）
   * @param {Array} hardIssues - 确定性层已发现的问题
   * @returns {Promise<Array>} LLM 发现的问题
   */
  async _checkOutlineL1(novelInfo, chapters, hardIssues) {
    const setting = this._combineSetting(novelInfo);
    const parts = this.db.getAllParts();
    const list = chapters.filter(c => c.no > 0).sort((a, b) => a.no - b.no);

    // 构造大纲序列（只给 no/name/outline，不给正文）
    const outlineSeq = list.map(c =>
      `第${c.no}章 ${c.name || '（无标题）'}\n大纲：${String(c.outline || '（无大纲）').slice(0, 500)}`
    ).join('\n\n');

    // 构造大纲依赖边摘要
    const edgeSummary = list.map(c => {
      const edges = outlineDependencyEdges(c.outline);
      return edges.length > 0 ? `第${c.no}章依赖：${edges.map(e => e.quote).join('、')}` : null;
    }).filter(Boolean).join('\n');

    // 构造硬问题摘要
    const hardSummary = hardIssues.length > 0
      ? hardIssues.slice(0, 20).map(i => `[${i.code}] 第${i.chapterNo}章: ${i.evidence.slice(0, 80)}`).join('\n')
      : '（无硬问题）';

    const prompt = `你是一位资深小说编辑，负责检查全书的结构一致性与叙事连贯性。

## 整体故事设定
${setting}

## 分部结构
${parts.length > 0 ? parts.map(p => `第${p.no}部《${p.name || '未命名'}》第${p.startNo}–${p.endNo}章`).join('\n') : '（未分部）'}

## 全书章节大纲序列
${outlineSeq}

## 大纲依赖边
${edgeSummary || '（无显式依赖）'}

## 确定性层已发现的问题（不必重复报）
${hardSummary}

## 请检查以下问题并只返回 JSON：
1. 是否混入了两套不同的章节序列/重复桥段（如前半详纲+后半另一套开篇）
2. 伏笔是否回收（前面提到的重要线索后面是否消失）
3. 人物知识/能力状态是否单调推进（前面不会的事后面突然会了）
4. 时间线是否倒退
5. 删章后骨架是否断裂（大纲依赖边是否落空）
6. 部的划分节奏与大纲内容是否匹配

请只返回 JSON，格式：
{"issues": [{"type": "duplicated-arc|setting|continuity|character|timeline", "severity": "blocker|warn", "chapters": [3,4], "quote": "原文片段", "problem": "矛盾说明", "suggestion": "修改建议"}]}
如果没有问题返回 {"issues": []}`;

    try {
      const text = await this._callWriterLLM(
        '你是一位资深小说编辑，擅长检查全书结构一致性与叙事连贯性。请只返回 JSON。',
        prompt,
        { progress: '🔍 正在扫描全书大纲...', maxTokens: 4096 }
      );
      return this._parseCheckOutput(text, setting + outlineSeq);
    } catch (error) {
      console.warn(`⚠️  L1 大纲扫描失败（按无问题处理）: ${error.message}`);
      return [];
    }
  }

  /**
   * L2 正文↔大纲一致性（每章一次，喂料小）
   * @param {Object} chapter - 章节 { no, name, outline, content }
   * @returns {Promise<Array>}
   */
  async _checkBodyVsOutlineL2(chapter) {
    const { no, outline, content } = chapter;
    if (!outline || !content) return [];

    const prompt = `你是一位资深小说编辑，负责检查正文是否落实了大纲要点。

## 第${no}章大纲
${outline}

## 第${no}章正文（全文）
${content}

## 请检查以下问题并只返回 JSON：
1. 正文是否落实了大纲的主要情节要点
2. 有没有写着写着跑偏（与大纲方向不符）
3. 是否新造了人名（大纲没提但正文突然出现）

请只返回 JSON，格式：
{"issues": [{"type": "body-vs-outline|character", "severity": "blocker|warn", "chapters": [${no}], "quote": "原文片段", "problem": "矛盾说明", "suggestion": "修改建议"}]}
如果没有问题返回 {"issues": []}`;

    try {
      const text = await this._callWriterLLM(
        '你是一位资深小说编辑，擅长检查正文与大纲的一致性。请只返回 JSON。',
        prompt,
        { maxTokens: 2048 }
      );
      return this._parseCheckOutput(text, outline + content);
    } catch (error) {
      console.warn(`⚠️  L2 正文↔大纲检查失败（第${no}章，按无问题处理）: ${error.message}`);
      return [];
    }
  }

  /**
   * L3 正文接缝检查（三章窗口）
   * @param {number} chapterNo - 本章章号
   * @param {Array} chapters - 全部章节
   * @returns {Promise<Array>}
   */
  async _checkSeamL3(chapterNo, chapters) {
    const sorted = chapters.filter(c => c.no > 0).sort((a, b) => a.no - b.no);
    const idx = sorted.findIndex(c => c.no === chapterNo);
    if (idx < 0) return [];

    const prev = idx > 0 ? sorted[idx - 1] : null;
    const curr = sorted[idx];
    const next = idx < sorted.length - 1 ? sorted[idx + 1] : null;

    if (!curr || !curr.content) return [];

    const prevTail = prev?.content ? String(prev.content).slice(-800) : '';
    const currFull = String(curr.content);
    const nextHead = next?.content ? String(next.content).slice(0, 800) : '';

    const prompt = `你是一位资深小说编辑，负责检查章节之间的接缝是否连贯。

${prev ? `## 前一章（第${prev.no}章）结尾 800 字\n${prevTail}\n` : ''}
## 本章（第${curr.no}章）全文
${currFull}
${next ? `## \u540e一章（第${next.no}章）开头 800 字\n${nextHead}\n` : ''}
## 请检查以下问题并只返回 JSON：
1. 本章开头是否承接了前一章的结尾（场景、人物状态、情绪是否连贯）
2. 本章结尾是否为后一章做了铺垫（如果后一章存在）
3. 是否有情节断裂（前面发生的事后面突然忘了）

请只返回 JSON，格式：
{"issues": [{"type": "continuity|seam", "severity": "blocker|warn", "chapters": [${prev?.no || 'null'}, ${curr.no}${next ? `, ${next.no}` : ''}], "quote": "原文片段", "problem": "矛盾说明", "suggestion": "修改建议"}]}
如果没有问题返回 {"issues": []}`;

    try {
      const text = await this._callWriterLLM(
        '你是一位资深小说编辑，擅长检查章节接缝的连贯性。请只返回 JSON。',
        prompt,
        { maxTokens: 2048 }
      );
      return this._parseCheckOutput(text, prevTail + currFull + nextHead);
    } catch (error) {
      console.warn(`⚠️  L3 接缝检查失败（第${chapterNo}章，按无问题处理）: ${error.message}`);
      return [];
    }
  }

  /**
   * 解析 LLM 检查输出（硬校验：quote 必须在所喂文本内）
   * @param {string} text - LLM 返回的文本
   * @param {string} fedText - 所喂的全部文本（用于校验 quote）
   * @returns {Array} 解析后的 issues
   */
  _parseCheckOutput(text, fedText) {
    try {
      // 尝试提取 JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.warn('⚠️  LLM 检查输出无 JSON，按无问题处理');
        return [];
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.issues)) return [];

      // 硬校验：quote 必须在所喂文本内
      return parsed.issues.filter(issue => {
        if (!issue.quote) return true; // 无 quote 的放行
        const inText = fedText.includes(issue.quote);
        if (!inText) {
          console.warn(`⚠️  LLM 检查 quote 不在所喂文本内，丢弃：${issue.quote.slice(0, 50)}...`);
        }
        return inText;
      });
    } catch (error) {
      console.warn(`⚠️  LLM 检查输出解析失败（按无问题处理）: ${error.message}`);
      return [];
    }
  }

  /**
   * 写操作后自动体检（确定性层 + L1 大纲扫描 + 按需 L2/L3）
   * @param {Object} opts
   * @param {Array<number>} [opts.chapterNos] - 要检查的章节号
   * @param {Object} [opts.deletedSnapshot] - 删除场景的被删章快照
   * @param {boolean} [opts.fullBook=false] - 是否全书检查
   * @param {boolean} [opts.withBody=false] - 是否跑 L2/L3（默认只跑确定性+L1）
   * @returns {Promise<Object>} check 结果
   */
  async _runPostWriteCheck({ chapterNos, deletedSnapshot, fullBook = false, withBody = false } = {}) {
    const hardIssues = runDeterministicChecks({
      db: this.db,
      chapterNos: fullBook ? undefined : chapterNos,
      deletedSnapshot,
      fullBook: fullBook || !chapterNos
    });

    // L1 全书大纲扫描（固定 1 次调用）
    const novelInfo = this.db.getNovelInfo();
    const allChapters = this.db.getAllChapters();
    const outlineIssues = await this._checkOutlineL1(novelInfo, allChapters, hardIssues);

    // L2/L3 按需跑
    let bodyVsOutlineIssues = [];
    let seamIssues = [];

    if (withBody) {
      const targets = chapterNos || allChapters.filter(c => c.no > 0).map(c => c.no);
      for (const no of targets) {
        const chapter = allChapters.find(c => c.no === no);
        if (!chapter) continue;
        // L2
        const l2 = await this._checkBodyVsOutlineL2(chapter);
        bodyVsOutlineIssues.push(...l2);
      }
      // L3 只跑刚写过的章
      if (chapterNos) {
        for (const no of chapterNos) {
          const l3 = await this._checkSeamL3(no, allChapters);
          seamIssues.push(...l3);
        }
      }
    }

    return {
      hard: hardIssues,
      outline: outlineIssues,
      bodyVsOutline: bodyVsOutlineIssues,
      seam: seamIssues,
      autoFixed: [],
      pending: [],
      rounds: 0
    };
  }

  /**
   * 生成“本书设定”说明（面向读者的第一印象）
   * 设定可能极简单（实测《以笔行侠》的梗概与角色设定合计仅 68 字节）→ 必须同时喂全部章节标题与大纲，
   * 让说明能从已写内容归纳，而不是只复述那两句设定
   * @param {Object} novelInfo - no=0 概要行（outline/content/name）
   * @param {Array} chapters - 全部行（含大纲与已有正文）
   * @returns {Promise<string>} 设定说明正文
   */
  async generatePrefaceWithLLM(novelInfo, chapters) {
    const setting = this._combineSetting(novelInfo);
    const list = (chapters || []).filter(c => c.no > 0).sort((a, b) => a.no - b.no);
    const outlineList = list.length > 0
      ? list.map(c => `- 第${c.no}章 ${c.name || '（无标题）'}\n  大纲：${String(c.outline || '（无大纲）').slice(0, 300)}`).join('\n')
      : '（尚无章节）';
    const extractedRoster = extractCharacterRoster(
      list.map(c => c.content).filter((t) => t && t.trim()).join('\n'),
      setting
    );

    // 本书设定介绍的是整本，因此角色清单要覆盖全部已写正文（只看最近几章会漏掉早期人物）；
    // 更关键的是把名单按“正文里真的出现过”与“只在设定里出现过”分开：已写正文才是唯一既成事实，
    // 不分开时设定与实际写法已是两套的书会被写成混合人物（实测《魔法数学王国的奇幻冒险》：
    // 设定为小星/艾琳娜/暗影算师，正文实际为莉莉/阿尔法/算术碎片）
    const bodyText = list.map(c => c.content || '').join(' ');
    const hasBody = Boolean(bodyText.trim());
    const roster = hasBody
      ? filterCastNames(extractedRoster.filter(n => bodyText.includes(n)), bodyText)
      : extractedRoster;
    // 过时设定的名字靠正文词频抽不出来（设定是条目文体，没有对话动词），
    // 因此单独从设定条目里取“作者声明的名词”，再把正文没出现的列为禁令
    const ghostNames = hasBody
      ? [...new Set(extractSettingTerms(setting).filter((n) => !bodyText.includes(n)))].slice(0, 16)
      : [];
    // 主角判定交给正文词频，但只在“设定与正文确实对不上”时才给出：
    // 名单本身是启发式结果（有时提不出真主角），无冲突时多一句断言只会增加误报风险；
    // 另要求候选在过半已写章节里出现，单个碎片词撑不起“主角”这个结论
    const writtenBodies = list.map(c => c.content).filter((t) => t && t.trim());
    const leadNames = hasBody && ghostNames.length > 0
      ? roster
        .map((n) => ({
          name: n,
          count: bodyText.split(n).length - 1,
          chapters: writtenBodies.filter((t) => t.includes(n)).length
        }))
        .filter((r) => r.chapters >= Math.ceil(writtenBodies.length / 2))
        .sort((a, b) => b.count - a.count)
        .slice(0, 1)
        .map((r) => r.name)
      : [];

    const prompt = `你是一位小说编辑。请为下面这部小说写一篇放在全书最前面的“本书设定”说明，帮读者建立第一印象。

## 小说名称
《${novelInfo.name || '未命名'}》

## 作者给出的设定（可能很简略）
${setting || '（设定文本极少，请主要依据下面的章节标题与大纲归纳）'}

${Array.isArray(roster) && roster.length > 0 ? `## 已出场角色清单（名字必须原样使用）\n${roster.join('、')}\n\n` : ''}## 全书章节与大纲
${outlineList}

## 写作要求
1. 讲清三件事：故事背景/世界观、主要出场人物（每人一句定位）、这个故事要往哪里去（悬念式引子，不揭晓结果）
2. 🔴 名字硬约束：角色名必须与上面的清单/设定一字不差，严禁改名、换昵称或新造主要人物（清单只作候选，只写你确信是人物或地名的词）${ghostNames.length > 0 ? `；下列名字只在设定文本里出现、正文从未出场，严禁当作出场人物写进本篇：${ghostNames.join('、')}` : ''}
3. 只写到“开局”，不得剧透后续剧情走向与结局
4. 设定文本很简略时，从章节标题与大纲归纳，不得编造与章节内容冲突的设定；设定文本与实际正文写法不一致时（主角名、地名、组织名不同）一律以正文为准${leadNames.length > 0 ? `：本书正文的主角是「${leadNames.join('、')}」，不得把设定里的另一个人物改写成主角` : ''}
5. 篇幅 300～600 字，使用 Markdown，首行为 # 本书设定
6. 只返回说明正文，不要任何解释或备注`;

    return this._callWriterLLM(
      '你是一位资深小说编辑，擅长用简短文字向读者介绍一部作品的背景与人物。',
      prompt,
      { progress: '✍️ 正在生成《本书设定》说明页...' }
    );
  }

  /**
   * 解析部导言输出（【部名】/【概要】标记行）
   * @param {string} text - 模型输出
   * @returns {{name: string, summary: string}} 部名可能为空
   */
  _parsePartIntroOutput(text) {
    let name = '';
    let body = String(text || '').trim();
    const nameMatch = /【\s*部名\s*】\s*([^\n]*)/.exec(body);
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^《|》$/g, '').slice(0, 20);
      body = body.replace(nameMatch[0], '').trim();
    }
    body = body.replace(/^【\s*概要\s*】\s*/, '').trim();
    return { name, summary: body };
  }

  /**
   * 生成某一部的“主要设定与故事概要”（导言页正文）
   * @param {Object} part - 目标部（含 startNo/endNo/name/summary）
   * @param {Array} allParts - 全量部列表（供写清边界，避免概要串内容）
   * @param {Object} novelInfo - 全书概要
   * @param {Array} chapters - 全部章节
   * @returns {Promise<{name: string, summary: string}>}
   */
  async generatePartIntroWithLLM(part, allParts, novelInfo, chapters) {
    const setting = this._combineSetting(novelInfo);
    const mine = (chapters || [])
      .filter(c => c.no >= part.startNo && c.no <= part.endNo)
      .sort((a, b) => a.no - b.no);
    const lines = mine.map(c => `- 第${c.no}章 ${c.name || '（无标题）'}\n  大纲：${String(c.outline || '（无大纲）').slice(0, 300)}`).join('\n');
    const others = (allParts || [])
      .filter(p => p.no !== part.no)
      .map(p => `- 第${p.no}部《${p.name || '未命名'}》第${p.startNo}–${p.endNo}章`)
      .join('\n') || '（无其他部）';
    const needName = !part.name;

    const prompt = `你是一位小说编辑。请为下面这个“部”写一段导言，放在本部开头、第一章之前，让读者知道本部讲什么。

## 全书信息
小说：《${novelInfo?.name || '未命名'}》
${setting || '（全书设定文本极少，请以本部章节大纲为准）'}

## 本部
第${toChinese(part.no)}部${part.name ? `《${part.name}》` : '（尚无部名）'}，第${part.startNo}–${part.endNo}章

## 本部各章标题与大纲
${lines}

## 全书其他部（不要写到它们的内容）
${others}

## 写作要求
1. 内容包含两部分：本部的主要设定（舞台/规则/人物关系在本部的变化）、本部要讲的故事走向
2. 🔴 只写本部（第${part.startNo}–${part.endNo}章）：不得把其他部的情节写进来，不得逐章复述大纲
3. 🔴 人物姓名必须与上面给出的一字不差，严禁改名或新造主要人物
${needName
        ? `4. 本部尚无名字：先输出一行【部名】xxxxx（不超过 8 字），再另起一行输出一行【概要】，然后写概要正文` : '4. 直接输出概要正文，不要加【部名】/【概要】标记，也不要加 Markdown 标题'}
5. 篇幅 150～400 字，使用 Markdown 段落
6. 只返回要求的内容，不要任何解释或备注`;

    const text = await this._callWriterLLM(
      '你是一位资深小说编辑，擅长用简洁文字概括一个篇章的设定与主线。',
      prompt,
      { progress: `✍️ 正在生成第${toChinese(part.no)}部导言...` }
    );

    const parsed = this._parsePartIntroOutput(text);
    if (needName && !parsed.name) {
      // 没按格式给部名不阻断流程：展示会退化为“第X部”，但提醒是必要的
      console.warn(`⚠️  第${part.no}部的导言输出未包含【部名】行，部名保持为空（展示为“第${toChinese(part.no)}部”）`);
    }
    return parsed;
  }

  /**
   * 为新创作章节构造连贯性上下文：已出场角色清单 + 上一章结尾。
   * 缺陷背景：新创作路径此前不供前文，模型不知道上一章主角叫什么名字
   * @param {number} chapterNo - 本章章节号
   * @param {string} fullSetting - 小说整体设定（也从设定中补齐角色名）
   * @returns {Object|null} { characterRoster, prevChapterNo, prevTail }
   */
  _buildContinuityContext(chapterNo, fullSetting = '') {
    try {
      const written = this.db.getAllChapters()
        .filter((c) => c.no > 0 && c.no < chapterNo && c.content && c.content.trim())
        .sort((a, b) => a.no - b.no);
      if (written.length === 0) return null;
      const prev = written[written.length - 1];
      return {
        // 只取最近 3 章正文提取角色名，控制提示词体积；清单按频次排序，允许少量噪声
        characterRoster: extractCharacterRoster(written.slice(-3).map((c) => c.content).join('\n'), fullSetting),
        prevChapterNo: prev.no,
        prevTail: String(prev.content).slice(-500)
      };
    } catch (error) {
      console.warn(`⚠️  构造连贯上下文失败（按无前文处理）: ${error.message}`);
      return null;
    }
  }

  /**
   * 使用 LLM 生成章节内容
   * @param {string} chapterOutline - 本章大纲
   * @param {string} fullOutline - 整体故事设定（由 _combineSetting 合并：概要 + 角色/世界观）
   * @param {number} chapterNo - 本章章节号（写入提示词，避免 LLM 写错章节号）
   * @param {Object} [modifyContext] - 改写模式上下文（传入则视为改写既有章节而非新写）
   * @param {string} [modifyContext.originalContent] - 原章节全文（人物名/术语的权威基准）
   * @param {Array<string>} [modifyContext.characterRoster] - 原文出现过的角色名清单
   * @param {Object} [continuity] - 新创作模式的连贯上下文（_buildContinuityContext 产出）
   */
  async generateChapterWithLLM(chapterOutline, fullOutline, chapterNo, modifyContext = null, continuity = null, targetWordCount = null) {
    // 从 novelInfo.content 解析字数要求（如用户未显式传入）
    if (!targetWordCount) {
      const m = fullOutline?.match(/【每章目标字数[：:]\s*(\d+)】/);
      if (m) targetWordCount = parseInt(m[1], 10);
    }
    const isRewrite = !!modifyContext?.originalContent;

    // 改写模式追加区块：原文全文 + 角色清单，把人物姓名锁死为硬约束
    // （缺陷背景：此前改写只喂新大纲+概要，模型脱离原文自由发挥导致主人公改名）
    const rewriteSections = isRewrite
      ? `
## 原章节内容（改写基准）
${modifyContext.originalContent}

${Array.isArray(modifyContext.characterRoster) && modifyContext.characterRoster.length > 0
        ? `## 本故事角色清单（严格禁止改名）\n${modifyContext.characterRoster.join('、')}\n`
        : ''}`
      : '';

    // 续写区块：把已出场角色清单与上一章结尾作为硬约束喂给新创作（缺陷背景：新创作此前
    // 既不供角色设定也不供前文，导致同一角色逐章被改名为"小毛/小灰/小猴子"）
    const continuitySections = (!isRewrite && continuity)
      ? `${Array.isArray(continuity.characterRoster) && continuity.characterRoster.length > 0
        ? `## 本故事已出场角色清单（名字必须原样沿用，严禁改名）\n${continuity.characterRoster.join('、')}\n\n`
        : ''}${continuity.prevTail
        ? `## 上一章（第${continuity.prevChapterNo}章）结尾（承接用，不要复述）\n${continuity.prevTail}\n`
        : ''}`
      : '';

    const prompt = `你是一位专业的小说作家。请${isRewrite ? '改写以下既有章节' : '根据以下大纲生成一章完整的小说内容'}。

## 章节号
本章是第${chapterNo}章（请严格使用该章节号，不要使用其他章节号）

## 章节大纲
${chapterOutline}

## 整体故事设定（必须严格遵守）
${fullOutline}
${rewriteSections}${continuitySections}
## 要求
${isRewrite
        ? `1. 这是改写任务，不是新创作：必须以"原章节内容"为基础进行修改，保留原有情节骨架、叙事视角与文风
2. 🔴 人物姓名硬约束：所有角色的名字必须与原文/角色清单完全一致（一字不差），严禁改名、换称呼或新造人名；世界观专有名词同理
3. 保持与前后章节的连贯性，人物性格、能力与关系不得漂移
4. 篇幅与原文大致相当，使用生动的描写和对话`
        : `1. 生成完整的章节内容，字数符合大纲要求${targetWordCount ? `（本章目标约 ${targetWordCount} 字，必须写满不可截断）` : ''}
2. 🔴 人物姓名硬约束：已出场角色的名字必须与「角色清单/整体设定」完全一致（一字不差），严禁改名、换昵称或为同一角色另起称呼；本章若需首次命名，命名后全书必须统一
3. 保持与前后章节的连贯性：人物性格、能力、关系与世界观不得漂移
4. 使用生动的描写和对话`}
5. 只返回${isRewrite ? '改写后' : ''}的章节内容，不要包含任何解释或说明
6. 使用 Markdown 格式，以 # 第${chapterNo}章：标题 开头（章节号必须是 ${chapterNo}）

请${isRewrite ? '返回改写后的章节内容' : '生成章节内容'}：`;

    // 从 context 中获取 agent 的 LLM 配置，保持一致性
    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;
    const maxTokens = this.context?.maxTokens || 8192;
    const reasoningEffort = this.context?.reasoningEffort || null;

    // 会话可见性：工具内部生成长文时（单章约 1-2 分钟），向前端推送进度与
    // 打字机增量，避免界面一直停留在 loading。sessionId 由 skillExecutor 注入
    const sessionId = this.context?.sessionId || null;
    if (sessionId) {
      progressHub.publish(sessionId, `✍️ 正在生成第 ${chapterNo} 章正文...`);
    }
    // 打字机增量：按章节区分 step，前端在切换章节时重置缓冲
    const onDelta = sessionId
      ? (text) => progressHub.publish(sessionId, text, { type: 'delta', step: `writer-ch-${chapterNo}` })
      : null;

    const response = await llm.chat({
      messages: [
        {
          role: 'system',
          content: '你是一位专业的小说作家，擅长创作引人入胜的故事。你能根据大纲生成完整、连贯、生动的章节内容。'
        },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      reasoningEffort,
      think: false,
      onDelta
    });

    if (sessionId) {
      progressHub.publish(sessionId, `✅ 第 ${chapterNo} 章正文生成完成，正在保存...`);
    }

    let content = response.content || '';
    const finishReason = response.finishReason;

    // 截断检测 + 自动续写：如果模型输出被 maxTokens 截断，尝试续写补全
    if (targetWordCount && content.length > 0) {
      const isTruncated = (finishReason === 'length') ||
        (content.length < targetWordCount * 0.5 && !content.trimEnd().match(/[。！？"]\s*$/));
      if (isTruncated) {
        console.log(`⚠️ 第${chapterNo}章被截断（当前${content.length}字/目标${targetWordCount}字，finishReason=${finishReason}），尝试续写...`);
        if (sessionId) {
          progressHub.publish(sessionId, `⚠️ 第 ${chapterNo} 章被截断，正在续写补全...`);
        }
        content = await this._continueChapterContent(content, chapterNo, targetWordCount, sessionId);
      }
    }

    return content || 'Error: LLM returned empty response';
  }

  /**
   * 章节续写：当输出被截断时，从截断点继续生成剩余内容
   * @param {string} partialContent - 已生成的部分正文
   * @param {number} chapterNo - 章节号
   * @param {number} targetWordCount - 目标字数
   * @param {string|null} sessionId - 会话ID
   * @returns {Promise<string>} 补全后的完整正文
   */
  async _continueChapterContent(partialContent, chapterNo, targetWordCount, sessionId) {
    const remaining = targetWordCount - partialContent.length;
    const maxTokens = Math.min(8192, Math.max(4096, Math.ceil(remaining * 2.5)));
    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;

    const prompt = `以下是一章小说的已有内容（被中途截断）。请从截断处继续写下去，完成本章剩余内容。

## 要求
1. 直接续写，不要重复已有内容，不要加任何解释说明
2. 保持文风、叙事视角连贯
3. 本章还需约 ${remaining} 字，请写到一个自然的完结点（以句号/叹号/问号结尾）
4. 使用 Markdown 格式（段落用空行分隔）

## 已有内容（最后300字）
...${partialContent.slice(-300)}

请从截断处继续写：`;

    const response = await llm.chat({
      messages: [
        { role: 'system', content: '你是一位专业的小说作家，擅长无缝衔接续写。' },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      think: false
    });

    const continuation = (response.content || '').trim();
    if (!continuation) {
      console.log(`⚠️ 第${chapterNo}章续写返回空，保留原截断内容`);
      return partialContent;
    }

    // 拼接：去掉续写开头可能的重复内容
    const combined = partialContent + '\n\n' + continuation;
    console.log(`✅ 第${chapterNo}章续写完成：${partialContent.length} → ${combined.length} 字`);

    // 如果续写后仍不足 60% 目标且再次被截断，允许第二次续写
    if (response.finishReason === 'length' && combined.length < targetWordCount * 0.6) {
      if (sessionId) {
        progressHub.publish(sessionId, `⚠️ 第 ${chapterNo} 章仍需补全，第二次续写...`);
      }
      return this._continueChapterContent(combined, chapterNo, targetWordCount, sessionId);
    }

    return combined;
  }

  /**
   * 修改章节内容
   */
  async modifyChapter() {
    // 读取现有章节
    const chapter = await this.readChapter();

    // 读取小说整体设定（no=0 概要，含世界观与角色名）——改写时作为硬约束注入，
    // 避免 LLM 脱离设定"自由发挥"导致主人公等人物改名/性格漂移
    // （历史缺陷：此处曾误传本章自己的大纲当"整体设定"，等于没注入设定）
    const novelInfo = this.db.getNovelInfo();
    const fullSetting = this._combineSetting(novelInfo);

    // 如果章节内容为空，则使用生成逻辑而非修改逻辑
    if (!chapter.content || chapter.content.trim() === '') {
      console.log(`📝 第${this.chapter}章内容为空，使用生成模式`);
      return await this.generateChapter();
    }

    // 修改章节必须先更新大纲，然后重新生成内容
    // 使用 LLM 从修改指令中提取新的大纲内容
    console.log(`📋 正在从修改指令中提取新的大纲...`);

    const newOutline = await this.extractOutlineFromInstructions(
      chapter.outline,
      this.modifyInstructions
    );

    // 更新章节大纲到数据库
    if (newOutline && newOutline !== chapter.outline) {
      console.log(`✅ 提取到新大纲，正在更新数据库...`);
      this.db.upsertChapter({
        no: this.chapter,
        name: chapter.name,
        outline: newOutline,
        content: chapter.content
      });
      console.log(`✅ 章节大纲已更新`);
    }

    // 基于新大纲重写章节内容：携带整体设定与原文角色清单，锁死人物姓名
    console.log(`📝 基于新大纲重新生成章节内容...`);
    const characterRoster = extractCharacterRoster(chapter.content, fullSetting);
    const modifiedContent = await this.generateChapterWithLLM(
      newOutline,
      fullSetting,
      this.chapter,
      { originalContent: chapter.content, characterRoster }
    );

    // 规范化正文标题，确保章节号正确
    const normalizedContent = this.normalizeChapterHeading(modifiedContent, this.chapter);

    // 提取章节标题（从生成的内容中）
    const titleMatch = normalizedContent.match(/^#\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章[：:]\s*(.+)$/m);
    const chapterName = titleMatch ? titleMatch[1].trim() : chapter.name;

    // 保存修改后的内容到数据库
    this.db.upsertChapter({
      no: this.chapter,
      name: chapterName,
      outline: newOutline,
      content: normalizedContent
    });

    // 写操作后自动体检
    const check = await this._runPostWriteCheck({ chapterNos: [this.chapter], withBody: true });

    return {
      success: true,
      chapter: this.chapter,
      chapterName,
      wordCount: modifiedContent.length,
      action: 'modify',
      modifications: this.modifyInstructions,
      check
    };
  }

  /**
   * 从修改指令中提取新的大纲内容
   */
  async extractOutlineFromInstructions(currentOutline, instructions) {
    const prompt = `你是一个专业的小说编辑。请根据用户的修改指令，提取或生成新的章节大纲。

## 当前章节大纲
${currentOutline || '（无）'}

## 用户修改指令
${instructions}

## 任务
根据用户的修改指令，生成一个新的章节大纲。

要求：
1. 如果用户明确提到了大纲的修改，根据修改内容生成新大纲
2. 如果用户只是要求修改内容细节，保留当前大纲或稍作调整
3. 大纲要简洁明了，包含本章的主要情节和关键点
4. 只返回大纲内容，不要包含任何解释

请返回新的章节大纲：`;

    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.3; // 使用较低的温度以获得更稳定的输出
    const maxTokens = this.context?.maxTokens || 1024;
    const reasoningEffort = this.context?.reasoningEffort || null;

    const response = await llm.chat({
      messages: [
        {
          role: 'system',
          content: '你是一个专业的小说编辑，擅长根据反馈调整和优化章节大纲。'
        },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      reasoningEffort,
      think: false
    });

    return response.content || currentOutline;
  }

  /**
   * 使用 LLM 修改章节内容
   */
  async modifyChapterWithLLM(originalContent, outlineContent, instructions) {
    const prompt = `你是一位专业的小说编辑和作家。请根据以下修改要求对章节内容进行修改。

## 原始章节内容
${originalContent}

${outlineContent ? `## 整体故事设定（参考）\n${outlineContent}` : ''}

## 修改要求
${instructions}

## 要求
1. 根据修改要求修改内容
2. 保持故事连贯性和角色一致性
3. 只返回修改后的完整章节内容，不要包含任何解释
4. 使用 Markdown 格式

请返回修改后的章节内容：`;

    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;
    const maxTokens = this.context?.maxTokens || 8192;
    const reasoningEffort = this.context?.reasoningEffort || null;

    const response = await llm.chat({
      messages: [
        {
          role: 'system',
          content: '你是一位专业的小说编辑，擅长根据反馈改进小说内容。'
        },
        { role: 'user', content: prompt }
      ],
      model,
      temperature,
      maxTokens,
      reasoningEffort,
      think: false
    });

    return response.content || originalContent;
  }

  /**
   * 重排章节号（用于添加/删除后调整章节号）
   */
  async shiftChapters(startFrom, shift) {
    // 使用数据库的重排功能
    const result = this.db.shiftChapterNumbers(startFrom, shift);
    return result;
  }

  /**
   * 添加章节
   */
  async addChapter() {
    // 先重排后续章节（从当前章节开始，全部+1）
    await this.shiftChapters(this.chapter, 1);

    // 生成新章节
    const result = await this.generateChapter();

    return {
      ...result,
      action: 'add',
      shifted: true
    };
  }

  /**
   * 删除章节（从数据库）
   */
  async deleteChapter() {
    // 检查章节是否存在
    const chapter = this.db.getChapter(this.chapter);
    if (!chapter) {
      // 列出所有存在的章节
      const allChapters = this.db.getAllChapters({ includeContent: false });
      const existingNos = allChapters.filter(ch => ch.no > 0).map(ch => ch.no);

      throw new Error(`章节不存在，无法删除: 第${this.chapter}章 (现有章节: ${existingNos.join(', ') || '无'})`);
    }

    // 删除前抓快照（用于体检的 deletedSnapshot 与回滚）
    const deletedSnapshot = { no: chapter.no, name: chapter.name, content: chapter.content, outline: chapter.outline };

    // 删除当前章节（数据库方法已包含重排逻辑）
    const deleteResult = this.db.deleteChapter(this.chapter);
    if (!deleteResult.success) {
      throw new Error(`删除章节失败: ${deleteResult.error}`);
    }

    // 注意：不需要再调用 shiftChapters，因为 db.deleteChapter 已经处理了重排

    // 写操作后自动体检（删除场景：检查被删章号附近 + 后一章）
    const check = await this._runPostWriteCheck({
      chapterNos: [this.chapter, this.chapter + 1].filter(n => n > 0),
      deletedSnapshot
    });

    return {
      success: true,
      chapter: this.chapter,
      name: chapter.name,
      action: 'delete',
      shifted: true,
      check
    };
  }

  /**
   * 生成所有章节
   * @param {boolean} force - 为 true 时覆盖重写已有正文；默认跳过已有正文的章节
   */
  async generateAllChapters(force = false) {
    // 读取大纲
    const outline = await this.readOutline();

    // 如果大纲不存在，首先生成大纲
    if (!outline || !outline.content) {
      console.log(`⚠️  检测到章节大纲不存在，开始自动生成...`);

      // 检查是否有小说概要
      const novelInfo = this.db.getNovelInfo();
      if (!novelInfo || !novelInfo.outline) {
        throw new Error('数据库中没有小说概要信息，请先使用 saveNovelInfo 保存小说概要');
      }

      // 默认生成 10 章大纲
      const defaultTotalChapters = 10;
      console.log(`📋 正在生成 ${defaultTotalChapters} 个章节大纲...`);

      await this.generateAllChapterOutlines(defaultTotalChapters);

      console.log(`✅ 章节大纲已自动生成，继续生成所有章节内容`);
    }

    // 重新读取大纲
    const newOutline = await this.readOutline();
    if (!newOutline || !newOutline.content) {
      throw new Error('未能获取章节大纲信息');
    }

    // 获取章节大纲列表（按章节号排序，保证生成顺序正确）
    let chapterOutlines = [];

    if (newOutline.chapterOutlines && newOutline.chapterOutlines.length > 0) {
      // 直接使用章节大纲列表
      chapterOutlines = [...newOutline.chapterOutlines].sort((a, b) => a.no - b.no);
    } else {
      // 兼容旧格式：从合并文本中提取
      const totalChapters = this.extractTotalChapters(newOutline.content);
      if (totalChapters === 0) {
        throw new Error('未能从大纲中检测到章节信息');
      }
      // 生成章节列表
      chapterOutlines = Array.from({ length: totalChapters }, (_, i) => ({ no: i + 1 }));
    }

    const totalChapters = chapterOutlines.length;
    console.log(`📚 计划生成 ${totalChapters} 个章节`);

    // 防重复生成护栏：批量生成前检测已有正文的章节。
    // 已写过的章节默认不动（历史事故：模型退化重复发出批量 generate，
    // 每次 13 分钟把整本小说覆盖重写）。force 未显式开启时：
    //   - 全部章节已有正文 → 不生成，返回终态报告 + 覆盖需先向用户确认的指令
    //   - 部分已有正文 → 只补生成缺失章节，已存在的列出并提示确认
    const forceRegenerate = force === true;
    let existingChapters = [];
    let pendingOutlines = chapterOutlines;
    if (!forceRegenerate) {
      existingChapters = [];
      pendingOutlines = [];
      for (const chInfo of chapterOutlines) {
        const row = this.db.getChapter(chInfo.no);
        if (row && row.content && String(row.content).trim() !== '') {
          existingChapters.push({ no: chInfo.no, name: row.name || '' });
        } else {
          pendingOutlines.push(chInfo);
        }
      }
      if (existingChapters.length > 0) {
        console.log(`🛡️ 检测到 ${existingChapters.length} 章已有正文，默认跳过（force:true 可覆盖重写）`);
      }
      if (pendingOutlines.length === 0) {
        const list = existingChapters.map(c => `  - 第${c.no}章 ${c.name}`).join('\n');
        return {
          success: true,
          action: 'generateAll',
          allAlreadyComplete: true,
          totalChapters,
          successCount: 0,
          failCount: 0,
          skippedExisting: existingChapters,
          results: [],
          report: `全部 ${totalChapters} 章均已有正文，本次未生成、未覆盖任何内容：\n${list}\n\n` +
            `⚠️ 请先向用户确认是否需要覆盖重写已有章节：\n` +
            `  · 用户确认重写 → 携带 force: true 重新调用 generate（不带 chapter；系统会弹出确认卡片，用户批准后才会覆盖）\n` +
            `  · 用户只需重写个别章节 → 用 generate + chapter 参数逐章处理\n` +
            `  · 用户不需要 → 任务已完成，请直接汇报结果，不要再次调用批量生成`
        };
      }
    }

    // 会话可见性：批量生成耗时长（每章约 1-2 分钟），向前端同步总体进度
    const sessionId = this.context?.sessionId || null;
    if (sessionId) {
      progressHub.publish(sessionId, `📚 开始批量生成，共 ${pendingOutlines.length} 章${existingChapters.length ? `（跳过已有正文 ${existingChapters.length} 章）` : ''}，预计需要较长时间...`);
    }

    // 逐个生成章节
    const results = [];
    for (const chapterInfo of pendingOutlines) {
      this.chapter = chapterInfo.no;
      if (sessionId) {
        progressHub.publish(sessionId, `📖 批量生成进度：第 ${chapterInfo.no}/${totalChapters} 章`);
      }
      try {
        const result = await this.generateChapter();
        results.push(result);
      } catch (error) {
        results.push({
          success: false,
          chapter: this.chapter,
          error: error.message
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    const doneNote = existingChapters.length > 0
      ? `\n\n🛡️ 另有 ${existingChapters.length} 章已有正文、本次已跳过未覆盖：` +
        `${existingChapters.map(c => `第${c.no}章`).join('、')}。` +
        `如需覆盖重写，需用户同意后携带 force: true 调用 generate（不带 chapter，系统会弹确认卡片二次把关）；` +
        `当前大纲已全部有正文，任务已完成，禁止再次发起批量生成。`
      : '';

    return {
      success: failCount === 0,
      action: 'generateAll',
      totalChapters,
      successCount,
      failCount,
      skippedExisting: existingChapters.length > 0 ? existingChapters : undefined,
      results,
      report: `批量生成完成：本次新写 ${successCount} 章，失败 ${failCount} 章。${doneNote}`
    };
  }

  /**
   * 从大纲中提取总章节数
   */
  extractTotalChapters(content) {
    // 尝试匹配"第X章"模式
    const chapterMatches = content.match(/第(\d+)章/g);
    if (chapterMatches && chapterMatches.length > 0) {
      const chapters = chapterMatches.map(m => parseInt(m.match(/第(\d+)章/)[1]));
      return Math.max(...chapters);
    }

    // 尝试匹配"Chapter X"模式
    const chapterMatches2 = content.match(/Chapter\s+(\d+)/gi);
    if (chapterMatches2 && chapterMatches2.length > 0) {
      const chapters = chapterMatches2.map(m => parseInt(m.match(/Chapter\s+(\d+)/i)[1]));
      return Math.max(...chapters);
    }

    // 尝试匹配总章节数说明
    const totalMatch = content.match(/总章节数[：:]\s*(\d+)/);
    if (totalMatch) {
      return parseInt(totalMatch[1]);
    }

    return 0;
  }

  /**
   * 执行主要操作
   */
  async executeChapterOperation(action, chapter, modifyInstructions, args = {}) {
    let result;

    // 如果没有指定章节号或章节号为0，且操作是生成，则生成所有章节
    if ((!chapter || chapter === 0) && action.toLowerCase() === 'generate') {
      this.chapter = chapter;
      result = await this.generateAllChapters(args?.force === true || args?.info?.force === true);
    } else {
      this.chapter = chapter;
      this.action = action;
      this.modifyInstructions = modifyInstructions || '';

      switch (action.toLowerCase()) {
        case 'generate':
        case 'gen':
        case 'g':
          result = await this.generateChapter();
          break;

        case 'add':
          result = await this.addChapter();
          break;

        case 'modify':
        case 'mod':
        case 'm':
          result = await this.modifyChapter();
          break;

        case 'delete':
        case 'del':
        case 'd':
          result = await this.deleteChapter();
          break;

        default:
          throw new Error(`不支持的操作类型: ${action}。支持的操作: generate, add, modify, delete`);
      }
    }

    return result;
  }
}

export default WriterTool;
