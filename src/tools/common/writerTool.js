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
import { wordBand, classifyLength, bandText, effectiveBand, splitTargets, overflowParts, overflowText, outlineCapFor } from '../../utils/wordTarget.js';
import { splitSentences, normKey } from '../../utils/textDiff.js';
import { extractCharacterRoster, filterCastNames, extractSettingTerms, outlineDependencyEdges, findChapterRefs } from '../../agents/writer/textUtils.js';
import { runDeterministicChecks } from '../../agents/writer/checker.js';
import { progressHub } from '../../services/progressHub.js';

// 泛化描述词黑名单：规划层偶发把策略文本中的描述性短语字面化填入参数
// （实测事故：dbPath 与 info.name 均被填成 "目标小说"——规划策略写着"定位到目标小说"，
// 模型便把描述词当成了真实库名/书名）。描述词不是值，统一拒绝并指路真实库名或向用户确认。
// 注意：这些词会与库内既有小说名做相似度匹配（共享"小说"等子串即可踩线 0.5 阈值），
// 若不在此拦截，模糊定位会把操作导向错误/随机的库并顺带污染小说名。
const GENERIC_DESCRIBING_NAME_RE = /^(目标小说|目标|目标库|目标文件|目标书|示例|示例小说|小说名|例子|某小说|待确定|待定|xxx+)$/i;

// 自由扩展模式下，模型若不用 chapters 数组、而是在一份大纲里用这个记号分段，
// 解析器也认（见 _parseOutlineParts）。两边都认是因为模型对输出格式的服从度不可靠，
// 只认一种就会在它“换了个写法”时把多章大纲当一章存下去。
export const OUTLINE_SPLIT_MARK = '<<<SPLIT>>>';

// 必须调模型的 action（含别名）：这些入口动笔前先做链路预检。
// 不包含 saveNovelPlan：它只在库里没有章节大纲时才顺手生成，而且写入设定本身不该被模型不可用阻断；
// 也不包含 updateNovelPlan：它只按 modificationType 做纯 CRUD，不碰模型（把它纳入会让服务宕机时连设定都存不了）。
const LLM_BOUND_ACTIONS = new Set([
  'generate', 'gen', 'g', 'modify', 'mod', 'm',
  'generateChapterOutlines', 'generateOutlinesForRange', 'generatePreface', 'generatePartIntros',
  'tuneWordCount',
]);
// 预检通过结果缓存（模块级：同一服务内多个工具实例共用）——「区间生成正文」是逐章 N 次请求，
// 每次都探一次健康检查没意义；60s 内的重复请求直接放行。
let llmProbeOkAt = 0;

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
          description: '仅对 generate 批量模式有效：为 true 时覆盖重写已有正文的章节。默认 false（跳过已有正文，只补生成缺失章节）。携带 force: true 的调用会触发系统硬确认（聊天窗口弹出确认卡片，用户批准后才执行）。另在 generatePreface / generatePartIntros 中也表示覆盖已生成的设定说明与部导言（不涉及删除章节，不触发硬确认）。⚠️ generateChapterOutlines 中的含义是「整本重建大纲并清空受影响章节正文」，属破坏性操作：默认会被拦下并指引改用 addChaptersBulk，只有确实要推倒重来时才传 true。'
        },
        partNo: {
          type: 'integer',
          description: '部序号（用于 generatePartIntros，只重生这一部的导言；省略则处理所有缺导言的部）'
        },
        action: {
          type: 'string',
          description: '操作类型：generate(生成), add(添加), modify(修改), delete(删除), getNovelInfo(获取小说信息), listNovels(列出所有小说数据库), getPublishConfig(查询发布配置), setPublishConfig(设置发布配置：自动发布开关/目标目录), saveNovelPlan(保存小说规划), generateChapterOutlines(生成所有章节大纲), addChapterOutline(添加章节大纲), addChaptersBulk(一次添加多章大纲：单事务、绝不动已有正文), generateOutlinesForRange(只给区间内大纲为空的章补大纲，可先按 anchor 插空章——“丢一段素材、一次追加多章”), updateChapterOutline(更新章节大纲), reNumberChapters(重编号章节), updateNovelPlan(更新小说规划), generatePreface(生成“本书设定”说明页), savePreface(人工写入设定说明), setParts(手动划分“部”), generatePartIntros(生成各部导言概要), listParts(查看部结构), setGenConfig(查看/设置全书生成设定：每章目标字数等), tuneWordCount(按目标字数逐章治理：太短扩充、超长压缩、过长拆为两章，默认 dryRun 只出报告)',
          enum: ['generate', 'gen', 'g', 'add', 'modify', 'mod', 'm', 'delete', 'del', 'd', 'getNovelInfo', 'listNovels', 'getPublishConfig', 'setPublishConfig', 'saveNovelPlan', 'generateChapterOutlines', 'addChapterOutline', 'addChaptersBulk', 'generateOutlinesForRange', 'updateChapterOutline', 'reNumberChapters', 'updateNovelPlan', 'generatePreface', 'savePreface', 'setParts', 'generatePartIntros', 'listParts', 'setGenConfig', 'tuneWordCount']
        },
        chapters: {
          type: 'array',
          description: '新增章节清单（用于 addChaptersBulk），按阅读顺序排列，每项 { name, outline }。outline 必填——没有大纲的章节不会被批量生成正文，只会留下一页空白。单次上限 50 章。整批在一个事务里落库：任一项不合法或章号撞车则全部回滚。加完之后用 generate（不带 chapter）只补写新章正文。若你只有素材、给不出逐章大纲，改用 generateOutlinesForRange + count（它会自动插占位章再回填）。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '章节标题（可省略，省略后由生成阶段补）' },
              outline: { type: 'string', description: '本章大纲（必填，写清发生了什么，批量生成正文只依据它）' },
              content: { type: 'string', description: '本章正文（可选；留空则由 generate 补写）' }
            },
            required: ['outline']
          }
        },
        anchor: {
          type: 'object',
          description: '插入位置（用于 addChaptersBulk 与 generateOutlinesForRange）。{ mode: "tail" } = 追加到末尾（默认）；{ mode: "after", no: N } = 插在第 N 章之后，第 N 章及以后的章节整体顺延（no: 0 表示插到全书最前面）。',
          properties: {
            mode: { type: 'string', enum: ['tail', 'after'], description: 'tail=末尾追加，after=以 no 为锚点插入其后' },
            no: { type: 'integer', description: '锚点章号（mode=after 时必填，0 = 插到最前面）' }
          }
        },
        from: {
          type: 'integer',
          description: '区间起始章号（含，用于 generateOutlinesForRange）。与 to 一起限定处理范围；两者都省 = 全书扫描。只处理大纲为空的章，已有大纲的一律跳过'
        },
        to: {
          type: 'integer',
          description: '区间结束章号（含，用于 generateOutlinesForRange）。超出最大章号会被收到本书末尾；不传 from 时 from 默认 1'
        },
        count: {
          type: 'integer',
          description: '本次要新增的章数（用于 generateOutlinesForRange）：先按 anchor 插 count 个占位章，再只给这段新章补大纲。上限 50。与 from/to 互斥。适合“丢一段素材、一次追加多章”'
        },
        material: {
          type: 'string',
          description: '本段剧情的素材/构思（用于 generateOutlinesForRange，可选）：发生什么、要埋什么伏笔、参考哪几行。会连同前后章大纲一起交给模型逐章展开；不传则只根据小说概要衔接上下文自动补'
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
          description: '章节总数（用于 generateChapterOutlines 操作），默认 10。⚠️ 这是「整本重建到 N 章」而不是「凑够 N 章」：已有正文的章节会被重写大纲并清空正文。想把 10 章的书加到 15 章，请改用 addChaptersBulk 追加 5 章，不要用本参数。'
        },
        targetWordCount: {
          type: 'integer',
          description: '每章目标字数（saveNovelPlan 写入全书生成设定 gen_cfg，之后生成大纲与正文都会读它）。如 3000 表示每章约 3000 字（合格带 2400–3600）。若未指定则不做长度校验。注意：设了目标不等于把已有章节改到位，存量章要跑 tuneWordCount。'
        },
        genCfg: {
          type: 'object',
          description: '全书共同生成设定（用于 setGenConfig）：{ targetWords 每章目标字数(300–20000，0=不设限), tolerancePct 允许浮动百分比(5–50，默认20), splitPct 拆章阈值(20–300，默认60) }。可只传局部字段，没传的沿用现值；传 null 清除。',
          properties: {
            targetWords: { type: 'integer', description: '每章目标字数，0 表示不做长度判定' },
            tolerancePct: { type: 'integer', description: '合格带上下浮动百分比，默认 20' },
            splitPct: { type: 'integer', description: '超过目标多少建议拆章，默认 60' },
          }
        },
        dryRun: {
          type: 'boolean',
          description: 'true（默认）只出报告不写库；tuneWordCount 靠它先看清单。'
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

      // 动笔前预检：要调模型的入口先探一次桥接服务，不通就直接返回——库里什么都不会变。
      // 不预检的代价实测发生过：aibridge 没启动时连跑 20 章全报 fetch failed，
      // 还在目录里留下 20 个占位空章（count 模式是先插章再生成，事后熔断也拦不住这一次插入）。
      if (LLM_BOUND_ACTIONS.has(action)) {
        const gate = await this._ensureLlmReachable();
        if (!gate.ok) {
          return `⛔ LLM 链路预检未通过，本次未改动任何数据。\n${gate.detail}\n（修好后重跑即可；若之前已有失败的批量尝试，用「②b 只回填已有空章」补齐留下的空位，或用「🗑️ 区间删除章节」删掉它们）`;
        }
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
        const result = db.saveNovelInfo(info);
        // 目标字数写进结构化的 gen_cfg，不再往设定正文里追加「【每章目标字数：N】」那行字：
        // 那行既会被人改设定时无心删掉（删了就是静默失效，没人知道字数约束没了），界面也没法单独把它显示出来。
        // 旧库里已有的标记仍然可读（_wordBandFor 会回落），不要求人手擦除。
        let genCfg = null;
        if (targetWordCount) {
          db.saveGenConfig({ ...(db.getGenConfig() || {}), targetWords: targetWordCount });
          genCfg = db.getGenConfig();
        }
        
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
            genCfg,
            outlines: outlineResult.outlines
          });
          // 计划阶段确认窗口：发布策略未定时，指示 LLM 先确认再开始生成
          const hint = this._planConfirmationHint();
          return hint ? `${planText}\n\n${hint}` : planText;
        }
        
        const planText = this.formatResult({ success: true, dbPath: resolvedDbPath, genCfg, ...result, action: 'saveNovelPlan' });
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

      if (action === 'addChaptersBulk') {
        // 一次加多章：走 WriterDB.addChaptersBulk——单事务、只做一次平移、只插入不覆盖。
        // 这是「再加几章」的唯一正确入口：generateChapterOutlines 按新的章节总数重建大纲会清空已有正文。
        const list = Array.isArray(args.chapters) ? args.chapters : (Array.isArray(info?.chapters) ? info.chapters : null);
        if (!list) {
          return 'Error: chapters parameter (array of { name, outline }) is required for addChaptersBulk action';
        }
        let anchor = { mode: 'tail' };
        if (args.anchor && typeof args.anchor === 'object') anchor = args.anchor;
        else if (args.after !== undefined && args.after !== null && args.after !== '') anchor = { mode: 'after', no: Number(args.after) };
        const db = createWriterDB(resolvedDbPath);
        try {
          const out = db.addChaptersBulk(list, anchor);
          // action 必须放在展开之后：数据层回的 action:'bulkInserted' 不能覆盖本层语义（否则走不到下面的格式化分支）
          return this.formatResult({ ...out, success: true, action: 'addChaptersBulk' });
        } catch (e) {
          // 参数错误或主键冲突都原样报出：事务已整体回滚，库里不会留下半插状态
          return `Error: ${e.message}`;
        }
      }

      if (action === 'reNumberChapters') {
        const db = createWriterDB(resolvedDbPath);
        const result = db.reNumberAllChapters();
        return this.formatResult({ success: true, ...result, action: 'reNumberChapters' });
      }

      // ── 区间补大纲：只填「大纲为空」的章，绝不改已有大纲与正文 ──────────
      if (action === 'generateOutlinesForRange') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;

        const novelInfo = db.getNovelInfo();
        if (!novelInfo || !String(novelInfo.outline || '').trim()) {
          return 'Error: 数据库中没有小说概要，无法按主线补大纲；请先用 saveNovelPlan 保存小说概要';
        }

        const givenFrom = this._toRangeInt(args.from, 'from');
        const givenTo = this._toRangeInt(args.to, 'to');
        const wantCount = this._toRangeInt(args.count, 'count') || 0;
        const material = String(args.material ?? info?.material ?? '').trim();

        if (wantCount > 0 && (givenFrom !== null || givenTo !== null)) {
          return 'Error: count（先插新章）与 from/to（回填已有空章）是两种用法，不要同时传：插章的位置由 anchor 决定，区间会随插入位移';
        }

        // 用法②：一次追加多章但没有逐章大纲时，先按 anchor 插占位章，再回填这段的大纲。
        // 占位章只多几行空记录，不碰任何已有章节；即便本次生成失败，重跑同一区间仍能补齐。
        let inserted = null;
        if (wantCount > 0) {
          let anchor = { mode: 'tail' };
          if (args.anchor && typeof args.anchor === 'object') anchor = args.anchor;
          else if (args.after !== undefined && args.after !== null && args.after !== '') {
            anchor = { mode: 'after', no: Number(args.after) };
          }
          const placeholders = Array.from({ length: wantCount }, () => ({ name: '', outline: '' }));
          try {
            inserted = db.addChaptersBulk(placeholders, anchor, { allowEmptyOutline: true });
          } catch (e) {
            return `Error: ${e.message}`;   // 事务已整体回滚，库里没有留下占位章
          }
        }

        // 区间解析：插了占位章就只补这一段（不多动其它章）；否则用显式 from/to；都没给则全书扫描
        const maxNo = db.getMaxChapterNo();
        let from = inserted ? inserted.from : (givenFrom ?? 1);
        let to = inserted ? inserted.to : (givenTo ?? maxNo);
        if (maxNo === 0) return 'ℹ️ 本书还没有任何章节。想从零规划整本，请用 generateChapterOutlines；想追加新章，请带上 count。';
        from = Math.max(1, from);
        to = Math.min(to, maxNo);
        if (from > to) return `Error: 区间第 ${from}–${to} 章超出本书范围（当前最大章号 ${maxNo}）`;

        const rows = db.getChaptersInRange(from, to);
        const targets = rows.filter(ch => this._isBlankOutline(ch.outline));
        const skipped = rows.length - targets.length;
        if (targets.length === 0) {
          return this.formatResult({
            success: true, action: 'generateOutlinesForRange', from, to, inserted,
            scanned: rows.length, skippedCount: rows.length, filledCount: 0, remaining: 0, snapshotCount: 0, outlines: [], errors: [],
          });
        }

        // 单次上限：一章一次 LLM 调用（要带前后章语境，不能并发也不能合并，否则互踩推理服务）
        const MAX_RANGE_FILL = 50;
        const batch = targets.slice(0, MAX_RANGE_FILL);
        const remaining = targets.length - batch.length;

        const sessionId = this.context?.sessionId || null;
        if (sessionId) {
          progressHub.publish(sessionId, `📋 正在为第 ${batch[0].no}–${batch[batch.length - 1].no} 章补写大纲（共 ${batch.length} 章，逐章进行）...`);
        }

        const filled = [];
        const errors = [];
        let snapshotCount = 0;
        let stoppedEarly = false;
        let deferred = [];
        let consecutiveFailures = 0;
        const MAX_CONSECUTIVE_FAILURES = 3;
        // 自由扩展的多章大纲先攒在这里：原章号 → 除首份之外的各份。
        // 不在循环里插章是因为本循环升序跑，插章会平移后续章号、让 batch[i].no 全部失效
        const pendingExpansions = new Map();
        for (let i = 0; i < batch.length; i++) {
          const ch = batch[i];
          try {
            // 把「本段是一次连续插入」告知模型，否则它把每章当独立短篇写，节奏与衔接会散
            const briefParts = [];
            if (inserted) {
              briefParts.push(`本次是紧接第 ${from - 1} 章新写的一段剧情，共 ${batch.length} 章（第 ${from}–${to} 章），当前是其中第 ${i + 1} 章；情节要逐级递进、首章接住上一章结尾、末章留出后续空间。`);
            }
            if (material) briefParts.push(`【用户提供的素材/构思，本段情节必须落实到具体章节里，但不要照抄原文】\n${material}`);
            const brief = briefParts.length ? briefParts.join('\n\n') : null;

            const single = await this.generateSingleChapterOutlineWithLLM(ch.no, novelInfo, brief);
            if (this._isBlankOutline(single?.outline)) {
              throw new Error('模型未给出可用大纲（返回为空或占位语）');
            }

            // 落库前留档：目标章本身大纲是空的，能被清掉的只有正文与旧标题（历史上手填过正文但没写大纲的章）
            if (Number(ch.contentLength) > 0) {
              const snap = db.saveChapterRevision(ch.no, {
                name: ch.name,
                content: db.getChapter(ch.no)?.content ?? '',
                reason: '区间补大纲前的快照（本次只写大纲，不动正文；旧正文可从这里取回）',
                source: 'outlineRebuild',
              });
              if (snap?.success) snapshotCount++;
            }

            // updateChapterOutline 只改 outline/name 与 version，不写 content 列：这是本 action 不会清稿的根据
            // 占位章的标题本来是空，模型又给了空白标题时必须兜底，否则目录上会出现无名章
            const finalName = String(single.name ?? '').trim() || String(ch.name ?? '').trim() || `第${ch.no}章`;
            const saved = db.updateChapterOutline(ch.no, single.outline, finalName);
            if (saved?.success === false) throw new Error(saved.error || '大纲写入失败');
            filled.push({ no: ch.no, name: finalName });
            // 模型把这一章的情节切成了多章（只在全书选了自由扩展时会发生），多出来的先攒着
            if (single.extra?.length) {
              pendingExpansions.set(ch.no, single.extra);
              filled[filled.length - 1].expandedTo = 1 + single.extra.length;
            }
            consecutiveFailures = 0;
            if (sessionId) {
              progressHub.publish(sessionId, `✅ 第 ${ch.no} 章大纲已补写（${filled.length}/${batch.length}）` +
                (single.extra?.length ? `；情节量够写 ${1 + single.extra.length} 章，多出的章循环结束后统一插入` : ''));
            }
          } catch (e) {
            // 单章失败不影响其它章：已写的已落库，未写的重跑本区间会接着补
            errors.push({ no: ch.no, error: e.message, connection: e.connectionError === true });
            console.error(`❌ 区间补大纲：第 ${ch.no} 章失败: ${e.message}`);
            // 熔断：连续多章同一类失败（典型是推理服务/桥接服务不可达）时不再往下试。
            // 一章一次调用最长 600s，50 章全撞超时要挂几小时；快速失败也会把库里的空位铺满。
            // 判定只看「连续」，中间只要成过一章就重置，避免把偶发抖动误判成服务宕机。
            consecutiveFailures++;
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
              stoppedEarly = true;
              deferred = batch.slice(i + 1).map((c) => c.no);
              if (sessionId) {
                progressHub.publish(sessionId, `⛔ 连续 ${MAX_CONSECUTIVE_FAILURES} 章失败，已停止本次补写（剩余 ${deferred.length} 章未尝试）：${e.message}`);
              }
              break;
            }
          }
        }

        // ── 自由扩展落库：循环里只攒不插，这里降序一次性插完 ───────────────
        // 降序的理由见 _saveExpandedOutlines：先处理高章号，待处理的扩展点不会被已处理的平移影响。
        // 每插一处都立即校正标题与引用，所以 maxOldNo 各算各的（不能用循环前缓存的那个）。
        const expansions = [];
        const expandPoints = [];
        let expandedCount = 0, expandShifted = 0, expandXrefFixed = 0;
        for (const no of [...pendingExpansions.keys()].sort((a, b) => b - a)) {
          try {
            const r = this._saveExpandedOutlines(no, pendingExpansions.get(no), { sessionId });
            if (!r.added) continue;
            expansions.push({ at: no, added: r.added, from: r.from, to: r.to, shifted: r.shifted });
            expandedCount += r.added;
            expandShifted += r.shifted;
            expandXrefFixed += r.xrefFixed;
            expandPoints.push(...r.points);
          } catch (e) {
            // 扩章失败不影响已写好的大纲：那一章照旧是一章，正文阶段还有拆章兜底
            errors.push({ no, error: `规划扩章失败（大纲已写入、仅章数未扩）：${e.message}` });
            console.error(`❌ 第 ${no} 章规划扩章失败: ${e.message}`);
          }
        }
        // 报告一律用定稿后的章号说事（那才是书现在的样子），号变过的额外留一个 origNo
        const toFinal = this._insertShiftMap(expandPoints);
        const renum = (o) => { const n = toFinal(o.no); return n === o.no ? o : { ...o, origNo: o.no, no: n }; };

        const payload = {
          action: 'generateOutlinesForRange',
          from, to, scanned: rows.length, skippedCount: skipped,
          filledCount: filled.length, remaining, snapshotCount,
          // 停了就报「连了几章」，比布尔值有用（早停时的总失败数可能大于该阈值）
          stoppedEarly: stoppedEarly ? consecutiveFailures : 0,
          deferred: deferred.map((no) => toFinal(no)),
          inserted: inserted ? { count: inserted.insertedCount, from: inserted.from, to: inserted.to, shiftedCount: inserted.shiftedCount } : null,
          // 自由扩展（超长处理方式=split）的成果：模型把哪几章的情节切成了多章、插在哪、推后了多少章。
          // at 是生成时的原章号，finalAt/finalFrom/finalTo 是全书定稿后的号（插入时的 from/to 是中间态，
          // 更低章号的扩展点还没插，直接报出去会对不上目录）
          expandedCount, expandedShifted: expandShifted, expandXrefFixed,
          expansions: expansions.map((e) => {
            const finalAt = toFinal(e.at);
            return { at: e.at, added: e.added, shifted: e.shifted, finalAt, finalFrom: finalAt + 1, finalTo: finalAt + e.added };
          }),
          outlines: filled.map(renum), errors: errors.map(renum),
        };
        // 部分失败不能整个报 success:false —— _formatResultBody 对失败短路只回一句
        // 「操作失败: undefined」，恰好把「哪些章已写、哪些章失败」这最关键的信息吞掉。
        if (errors.length > 0 && filled.length === 0) {
          // 失败的不只是大纲：count 模式下占位章已经落库、后续章号已顺延，因而写「未改动任何章节」是错的
          const insertNote = inserted
            ? `已插入的 ${inserted.insertedCount} 个空位（第 ${toFinal(inserted.from)}–${toFinal(inserted.to)} 章，原后续 ${inserted.shiftedCount} 章已顺延）仍在目录里——重跑本区间会自动只补这些空位；不想要就用「🗑️ 区间删除章节」删掉第 ${toFinal(inserted.from)}–${toFinal(inserted.to)} 章。`
            : '';
          // 自由扩展插的章也是已经落库的结构改动，不能跟着「没写入任何大纲」一起被读成什么都没发生
          const expandNote = expandedCount
            ? `另有自由扩展新增的 ${expandedCount} 章（${expansions.map((e) => `原第${e.at}章后+${e.added}`).join('、')}）已落库，后续章号已顺延。`
            : '';
          const connNote = errors[0].connection ? '推理链路连不上（见下方错误里的目标地址），先确认 aibridge / 推理服务已启动。' : '';
          // 「N 章全部失败」在熔断场景下会被读成「只失败了 N 章、其余没需求」，未尝试的章数必须分开说
          const untried = deferred.length > 0 ? `，另有 ${deferred.length} 章未尝试（不是失败）` : '';
          return this.formatResult({
            ...payload,
            success: false,
            error: `没有写入任何大纲（本次尝试的 ${errors.length} 章全部失败${untried}）。${insertNote}${expandNote}${connNote}首个错误：${errors[0].error}`,
          });
        }
        return this.formatResult({ ...payload, success: true, partial: errors.length > 0 });
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

      // ── ⚙️ 全书生成设定：读写「每章目标字数」这类共同设定（不调模型）─────
      // 为什么单独一个 action 而不是只靠 saveNovelPlan 的 targetWordCount：那个入口要求带着
      // 完整规划（书名/概要/设定）且过一堆守卫，而“把目标字数从 2000 改成 3000”不该
      // 为此重抄整本设定。不传 genCfg 就是只读，跟 getNovelInfo 一样安全。
      if (action === 'setGenConfig') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;
        const given = args.genCfg;
        if (given === undefined) {
          // 只读：同时回“存了什么”与“实际按什么判定”，两者不同只可能是旧标记在回落
          const band = this._wordBandFor(db.getNovelInfo());
          return this.formatResult({
            success: true, action: 'setGenConfig', readonly: true,
            genCfg: db.getGenConfig(), band,
          });
        }
        // 局部补丁语义：没传的字段沿用现值，而不是掉回默认值。
        // 不这么做的话，“把浮动比例改成 30”会顺带把 targetWords 清零（= 静默取消字数约束）。
        let patch = given;
        if (given !== null && given !== '') {
          if (typeof given !== 'object' || Array.isArray(given)) {
            return 'Error: genCfg 必须是对象（或传 null 清除），收到：' + JSON.stringify(given);
          }
          patch = { ...(db.getGenConfig() || {}), ...given };
        }
        const out = db.saveGenConfig(patch);
        const band = wordBand(out.cfg);
        return this.formatResult({
          success: true, action: 'setGenConfig', cleared: out.cleared,
          genCfg: db.getGenConfig(), band,
          // 自由扩展会改书结构（拆章平移章号），这一句必须在设完的当下就说清，
          // 不能等人发现章号变了才回头找原因
          note: '仅影响之后的生成；存量章节需跑 tuneWordCount' +
            (band.on && band.overflow === 'split'
              ? '。当前为自由扩展：超长时会拆成更多章、后续章号顺延，已发布页面需重新发布'
              : ''),
        });
      }

      // ── 📏 字数治理：按全书目标逐章定性（扩充 / 压缩 / 拆两章）───────
      if (action === 'tuneWordCount') {
        const db = createWriterDB(resolvedDbPath);
        this.db = db;
        const band = this._wordBandFor(db.getNovelInfo());
        if (!band.on) {
          return 'Error: 本书没有「每章目标字数」设定，无法治理。请先到「① 小说设定」填写目标字数（菜单项「🎯 每章字数设定」同理，对应 setGenConfig）';
        }
        // 默认只出报告不动库：这个动作会改正文、也会改书结构（拆章平移后续章号），
        // 让人先看一眼“哪几章会被怎么处理”再决定执行，成本只是一个开关。
        // 认不准的值直接报错而不是当 false：一个手抖的 dryRun:"yes" 静默开写正文，
        // 比报一行参数错误贵太多（界面下拉开头就是预览，正常流程遇不到这个分支）。
        const dryRaw = args.dryRun;
        let dryRun = true;
        if (dryRaw === undefined || dryRaw === null) dryRun = true;
        else if (dryRaw === true || dryRaw === 1 || dryRaw === 'true' || dryRaw === '1') dryRun = true;
        else if (dryRaw === false || dryRaw === 0 || dryRaw === 'false' || dryRaw === '0') dryRun = false;
        else return `Error: dryRun 只接受 true/false（收到 ${JSON.stringify(dryRaw)}）。true=只出预览清单，确认后才传 false 执行。`;
        const from = this._toRangeInt(args.from, 'from');
        const to = this._toRangeInt(args.to, 'to');
        const sessionId = this.context?.sessionId || null;

        const rows = db.getAllChapters({ includeContent: false })
          .filter(c => c.no > 0)
          .filter(c => from === null || c.no >= from)
          .filter(c => to === null || c.no <= to)
          // 降序处理：拆章会把命中之后的章号整体 +1，升序跑会让循环拿着旧章号读到偏移后的章。
          // 降序时受影响的高章号已经跑完了，不会再被碰到。
          .sort((a, b) => b.no - a.no);

        const items = [];
        const errors = [];
        let appliedCount = 0, splitCount = 0;
        // 拆章发生时的**原**章号，一章拆成 k 份就记 k-1 次（见 _insertShiftMap）。
        // 降序处理保证记录到的都是原号（比它大的章已跑完）。
        const splitPoints = [];
        // 原章号 → 拆成几份。阶段 3 要靠它找出所有拆出来的新章（不只是紧跟着的那一位）
        const splitParts = new Map();
        const maxOldNo = db.getMaxChapterNo?.() ?? 0;
        // 拆不拆、拆几份由全书「超长处理方式」决定：
        //   split（自由扩展）→ long 与 split 都拆，内容一个字不砍，章数增加
        //   trim（删减次要场景）→ 阶段 1 完全不拆，超长章留给阶段 3 压缩，章数不变
        const wantSplit = band.overflow === 'split';
        // 阶段 1：只动结构（拆章）。扩写/压缩必须留到编号定稿之后，见 _renumberAfterInserts 的注释。
        for (const row of rows) {
          const len = Number(row.contentLength) || 0;
          const item = { no: row.no, name: row.name || '', before: len, verdict: classifyLength(len, band) };
          items.push(item);
          if (len <= 50) { item.verdict = 'no_body'; continue; }
          if (item.verdict === 'ok') continue;
          if (dryRun) continue;
          // trim 模式不拆章：long 与 split 一律走阶段 3 的压缩
          if (!wantSplit) continue;
          if (item.verdict !== 'split' && item.verdict !== 'long') continue;

          // 现场重读：一是取全文（前面只要了长度），二是防中途某章执行失败后行数据与预期偏离
          const ch = db.getChapter(row.no);
          if (!ch || !String(ch.content || '').trim()) { item.verdict = 'skipped'; item.reason = '正文读不到'; continue; }
          // 一次拆到位：份数按 overflowParts 算，拆完的尾巴仍超合格上限就接着拆。
          // 每拆一次都在**同一个原章号**之后多出一章，所以 splitPoints 重复记原号
          const plan = overflowParts(len, band);
          const lens = [];
          const below = [];
          let cur = row.no, rest = len, partsLeft = plan.parts, shiftedTotal = 0, done = 0;
          try {
            while (partsLeft > 1) {
              const r = await this._splitChapterIntoTwo(cur, band, sessionId, { wantA: Math.round(rest / partsLeft) });
              lens.push(r.lenA);
              rest = r.lenB;
              shiftedTotal += r.shifted || 0;
              if (r.below?.length) below.push(...r.below);
              done += 1;
              splitPoints.push(row.no);
              splitParts.set(row.no, done + 1);
              cur += 1; partsLeft -= 1;
            }
            lens.push(rest);
            Object.assign(item, {
              applied: true, split: true, after: lens[0], parts: lens.length, lens, shifted: shiftedTotal,
            });
            if (below.length) {
              item.reason = `${below.join('、')}，低于下限 ${band.min}（没有都进带的段落切点）；拆完后会自动补写这几章`;
            }
            appliedCount++; splitCount += done;
          } catch (e) {
            // 单章失败不中断整批：已改完的章已落库，剩下的接着治。
            // 拆到一半失败时结构已经动了，必须把已完成的份数报出去，否则阶段 2 的编号校正会漏掉它
            item.applied = done > 0;
            if (done > 0) {
              Object.assign(item, { split: true, parts: done + 1, lens: [...lens, rest], shifted: shiftedTotal });
            }
            item.reason = `${done > 0 ? `已拆成 ${done + 1} 份后` : ''}拆章失败：${e.message}`;
            errors.push({ no: row.no, error: e.message });
          }
        }

        // 旧号 → 新号：与 _renumberAfterInserts 内部用的是同一个映射（_insertShiftMap），
        // 阶段 3 靠它把「原章号」翻成「定稿章号」去找该补写的章。
        const toNew = this._insertShiftMap(splitPoints);
        // 拆出来的各份（首份除外，它在阶段 1 的 items 里已有条目）：一章拆 k 份就多出 k-1 个新章号
        const tails = new Set(
          [...splitParts].flatMap(([no, parts]) => Array.from({ length: parts - 1 }, (_, i) => toNew(no) + 1 + i)),
        );

        // ── 阶段 2：编号定稿，把「第X章」的字样按新号重算 ─────────────────
        // 实现搬到 _renumberAfterInserts：规划扩章与生成后拆章共用同一套校正，避免三处各写一遍。
        // 时机不能变：必须排在扩写/压缩之前，否则模型在新编号下写的引用会被移两次。
        let headingFixed = 0, xrefFixed = 0;
        const xrefUnresolved = [];
        if (!dryRun && splitPoints.length) {
          const r = this._renumberAfterInserts(splitPoints, { maxOldNo });
          headingFixed = r.headingFixed;
          xrefFixed = r.xrefFixed;
          xrefUnresolved.push(...r.xrefUnresolved);
        }

        // ── 阶段 3：按定稿编号补写/压缩（含阶段 1 计划过的那几章与拆出来的各份）──
        // trim 模式下阶段 1 不拆章，所有超长章都在这一阶段处理，
        // 所以开关不能再看「有没有拆过章」（那会让一本只有超长章、没有超拆章线的书什么也不做）
        const wanted = new Set([
          ...items
            .filter((i) => i.verdict === 'short' || i.verdict === 'long' || (!wantSplit && i.verdict === 'split'))
            .map((i) => toNew(i.no)),
          ...tails,
        ]);
        if (!dryRun && wanted.size) {
          const seen = new Map(items.map((i) => [toNew(i.no), i]));
          const after = db.getAllChapters({ includeContent: false })
            .filter((c) => c.no > 0 && wanted.has(c.no))
            .sort((a, b) => b.no - a.no);
          for (const row of after) {
            const len = Number(row.contentLength) || 0;
            const verdict = classifyLength(len, band);
            let item = seen.get(row.no);
            if (!item) {
              item = { no: row.no, name: row.name || '', before: len, verdict, origin: '拆出的新章' };
              items.push(item); seen.set(row.no, item);
            }
            if (len <= 50) continue;
            if (verdict === 'ok') continue;
            if (verdict === 'split' && wantSplit) {
              // 拆出来的各份又超线：不再自动拆。递归拆章没有收敛保证，交给人判断
              item.verdict = 'split'; item.applied = false;
              item.reason = `仍超拆章线 ${band.splitAt}，未再自动拆（需要人工分章或压缩）`;
              continue;
            }
            // trim 模式下 verdict === 'split' 不再单独处理：与 'long' 同等压缩，章数不变
            const ch = db.getChapter(row.no);
            if (!ch || !String(ch.content || '').trim()) continue;
            try {
              if (verdict === 'short') {
                const out = await this._expandChapterToTarget(ch.content, row.no, band, sessionId, { strict: true });
                // 不区分原因会给调用方一个错的指向：闸门拦下与模型没写长是两回事，
                // 前者要去查判据/原文，后者要去查提示词。实测这里就差点被当成推理服务故障。
                if (out === ch.content) { item.applied = false; item.reason = '扩写未采信（无增益，或未守住「只加不改」），保留原稿'; }
                else {
                  db.saveChapterRevision(row.no, { name: ch.name, content: ch.content, reason: `字数治理：扩充前（${ch.content.length} 字）`, source: 'wordCountTune' });
                  db.upsertChapter({ no: row.no, name: ch.name, outline: ch.outline, content: out });
                  item.applied = true; item.verdict = 'short'; item.after = out.length; appliedCount++;
                  // 把“字数够不够”之外的第二个结论一并交出去：扩得是水还是情节。
                  // 不靠日志是为了让界面/接口调用方都能看到，否则一章被写水了没人会发现。
                  item.fill = this._expansionStructure(ch.content, out);
                }
              } else {
                const out = await this._compressChapterToTarget(ch.content, row.no, band, sessionId);
                if (out === ch.content) { item.applied = false; item.verdict = verdict; item.reason = '压缩无收益或压过头，保留原稿'; }
                else {
                  db.saveChapterRevision(row.no, { name: ch.name, content: ch.content, reason: `字数治理：压缩前（${ch.content.length} 字）`, source: 'wordCountTune' });
                  db.upsertChapter({ no: row.no, name: ch.name, outline: ch.outline, content: out });
                  // verdict 而不是写死的 'long'：trim 模式下超拆章线的章也走这里，报 'long' 会对不上清单
                  item.applied = true; item.verdict = verdict; item.action = 'compress'; item.after = out.length; appliedCount++;
                }
              }
            } catch (e) {
              item.applied = false; item.reason = e.message;
              errors.push({ no: row.no, error: e.message });
            }
          }
        }

        return this.formatResult({
          success: true,
          action: 'tuneWordCount',
          dbPath: resolvedDbPath,
          dryRun,
          band: { target: band.target, min: band.min, max: band.max, splitAt: band.splitAt, on: true, overflow: band.overflow },
          overflowMode: band.overflow,
          scanned: rows.length,
          items: items.sort((a, b) => a.no - b.no),   // 报告按阅读顺序回，处理顺序是内部实现细节
          appliedCount,
          splitCount,
          headingFixed,
          xrefFixed,
          xrefUnresolved,
          errors,
          note: dryRun
            ? `本次为预览（dryRun），未改动任何内容。本书超长处理方式＝${overflowText(band)}：` +
              (wantSplit
                ? '清单里 long / split 的章会被拆成多章，后续章号整体后移。'
                : '清单里 long / split 的章会在原章内删减次要场景压到合格带，章数不变。') +
              '确认后用 dryRun:false 执行。'
            : (splitCount
              ? `已拆出 ${splitCount} 章，后续章号整体后移；同步校正了 ${headingFixed} 章的标题章号与 ${xrefFixed} 处「第X章」引用（正文与大纲），需重新发布才会体现在网站上。`
              : `本书超长处理方式＝${overflowText(band)}。需重新发布才会体现在网站上。`)
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

        // 重建大纲前的硬关卡：generateAllChapterOutlines 用 upsertChapter 落库，撞到已有章号会一并
        // 重写 name/outline 并把 content 清成空串。于是「想把 10 章的书加到 15 章」而把 totalChapters
        // 改大，实际会把前 10 章正文清空——不可逆的稿子损失，必须在这里拦住并给出加章的正确入口。
        const gate = await this._confirmOutlineRebuild(db, totalChapters, {
          force: args.force === true || info?.force === true,
        });
        if (gate.mode === 'abort') return gate.message;

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
      // 判「有没有正文」改用 contentLength：这里传了 includeContent:false，正文不再返回
      // （此前该参数被完全忽略，判定一直靠全文搬进内存撑着）。纯空白正文会被算作
      // “有内容”，方向是保守的：宁可多问一次覆盖确认，也不能漏问把稿子清掉。
      withContent = chapters.filter(ch => ch.no > 0 && Number(ch.contentLength) > 0);
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
   * 生成前硬关卡：整本重建章节大纲。
   *
   * 为什么需要：generateAllChapterOutlines 逐章 upsertChapter，而 upsert 撞到已有章号时执行的是
   * 「重写 name/outline + 把 content 写成空串」。因此把「10 章的书加到 15 章」误用为把
   * totalChapters 改成 15，结果前 10 章正文全被清空——而管理页那个「章节总数」输入框看上去正好
   * 就是干这事的入口。这里默认拦住，并指引到真正安全的 addChaptersBulk。
   *
   * @param {Object} db - writer 数据库实例
   * @param {number} totalChapters - 本次要重建成的章节总数
   * @param {Object} [opts]
   * @param {boolean} [opts.force] - 调用方显式确认要覆盖（无确认卡片能力时的唯一放行方式）
   * @returns {Promise<{mode: 'allow'|'abort', message?:string}>}
   */
  async _confirmOutlineRebuild(db, totalChapters, { force = false } = {}) {
    let withContent = [];
    try {
      withContent = db.getAllChapters({ includeContent: false })
        .filter(ch => ch.no > 0 && Number(ch.contentLength) > 0);
    } catch {
      // 读不到库就当作“无正文”放行会恰好掩盖真正的损坏，交给后续流程自己报错
      return { mode: 'allow' };
    }
    if (withContent.length === 0) return { mode: 'allow' };   // 新书或从未写过正文：重建大纲无损

    const total = Number(totalChapters) || 0;
    const covered = withContent.filter(ch => ch.no <= total);
    if (covered.length === 0) return { mode: 'allow' };       // 新章数区间与已有正文不重叠，不会清稿

    const sample = covered.slice(0, 5).map(ch => `第${ch.no}章`).join('、');
    const summary = `该小说已有 ${withContent.length} 章正文；按 ${total} 章重建大纲会覆盖其中 ${covered.length} 章的大纲与标题，并把它们的正文清空（${sample}${covered.length > 5 ? '…' : ''}）。`;

    const requestConfirmation = this.context?.requestConfirmation;
    if (typeof requestConfirmation === 'function') {
      const decision = await requestConfirmation({
        title: '重建大纲会清空已有正文',
        summary,
        riskNote: '被覆盖章节的正文将被清空且不可撤销。若只是想新增章节，请中止后改用「批量加章」',
        options: [
          { value: 'abort', label: '中止（改用批量加章追加新章）', primary: true },
          { value: 'overwrite', label: '确认重建（覆盖大纲并清空正文）' }
        ],
        preApprovalKey: 'gate:writer.outlineRebuild'
      });
      const chosen = decision?.approved ? (decision.selectedOption || 'abort') : 'abort';
      if (chosen !== 'overwrite') return { mode: 'abort', message: this._outlineRebuildAbortText(summary) };
      return { mode: 'allow' };
    }

    // 没卡片能力（Web 管理页 / CLI）：只认显式 force，否则一律拒绝
    if (!force) return { mode: 'abort', message: this._outlineRebuildAbortText(summary) };
    return { mode: 'allow' };
  }

  /** 大纲重建被拦下的说明：讲清后果，并把三种真实意图各自引到安全入口 */
  _outlineRebuildAbortText(summary) {
    return `⛔ 已中止大纲重建，未改动任何章节。\n\n${summary}\n\n` +
      `如果你的目的是「再加几章」，不要用本 action：\n` +
      `  · 末尾或中间追加新章 → addChaptersBulk（单事务、一次平移、只插入，绝不动已有正文），` +
      `随后用 generate（不带 chapter）只补写新章正文\n` +
      `  · 只有素材、给不出逐章大纲 → generateOutlinesForRange 带 count + material（先插占位章再逐章补大纲）\n` +
      `  · 只重写个别章的大纲 → updateChapterOutline 逐章处理\n` +
      `  · 只改已有正文 → modify/generate 带 chapter（单章，不触发本关卡）\n\n` +
      `确实要整本重建大纲并清空正文 → 携带 force: true 重新调用（聊天会话会再次弹出确认卡片）。`;
  }

  /**
   * 动笔前的 LLM 链路预检（在插占位章、清正文之前跑，不通时不落任何写入）。
   * 只证明桥接服务可达与密钥已配，不证明上游模型可用（那要靠真正生成时报 HTTP 5xx）。
   * @returns {Promise<{ok: boolean, detail: string}>}
   */
  async _ensureLlmReachable() {
    if (Date.now() - llmProbeOkAt < 60000) return { ok: true, detail: '（60s 内已预检通过）' };
    const r = await llm.checkReachable();
    // 通过才缓存；失败不缓存，服务修好后下一次请求立即重试
    llmProbeOkAt = r.ok ? Date.now() : 0;
    return r;
  }

  /**
   * 「大纲为空」的判定。除了真空与纯空白，还要认得 LLM 兜底写进去的占位语
   * （generateChapterOutlinesWithLLM / generateSingleChapterOutlineWithLLM 都会产出它），
   * 否则那章会被当成「已有大纲」跳过，批量生成正文时又写不出东西。改占位语必须两处同步。
   */
  _isBlankOutline(value) {
    const t = String(value ?? '').trim();
    return !t || t === '（无大纲内容）';
  }

  /** 区间参数的整数归一化：非数字/非整数一律报错，不能静默当成未传（那会变成全书扫描） */
  _toRangeInt(value, label) {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`参数 ${label} 必须是整数章号（收到 ${JSON.stringify(value)}）`);
    }
    return n;
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
        // 把换算出的区间回读给人看：只说“已存 3000”不够，人要看到合格带与拆章线才知道系统会怎么判定
        if (result.genCfg?.targetWords) saveMsg.push(`每章字数: ${bandText(wordBand(result.genCfg))}`);
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

      case 'addChaptersBulk': {
        const lines = [
          `✓ 已一次新增 ${result.insertedCount} 章大纲（第 ${result.from}–${result.to} 章）`,
          `后移顺延: ${result.shiftedCount || 0} 章`,
          `已有章节正文: 未做任何修改`,
          '',
        ];
        (result.chapters || []).forEach(c => lines.push(`  第${c.no}章: ${c.name || '（无标题）'}`));
        if (result.warning) lines.push('', `⚠️ ${result.warning}`);
        lines.push('', '下一步：用 generate（不带 chapter，或 ③ 区间生成正文）只补写这些新章。');
        return lines.join('\n');
      }

      case 'setGenConfig': {
        const band = result.band || wordBand(null);
        const lines = [result.readonly ? '⚙️ 全书生成设定' : '✓ 全书生成设定已更新'];
        lines.push(bandText(band));
        if (band.on) {
          lines.push(`设定值: targetWords=${band.target}, tolerancePct=${result.genCfg?.tolerancePct}, splitPct=${result.genCfg?.splitPct}, overflow=${band.overflow}`);
        } else {
          lines.push(`未设定值（生成时不做长度判定；超长处理方式仍为 ${band.overflow}，但设了目标字数才生效）`);
        }
        // 自己没存配置却仍在按某个字数判定，只可能是设定正文里的旧标记在生效——不写出来会让人迷惑
        if (!result.genCfg?.targetWords && band.on) {
          lines.push('来源: 沿用了设定正文里的旧标记（建议改用本接口设定，并把那行字删掉）');
        }
        if (result.note) lines.push('', result.note);
        return lines.join('\n');
      }

      case 'tuneWordCount': {
        const lines = [];
        lines.push(`${result.dryRun ? '🔍 字数治理预览' : '📏 字数治理已执行'}（${bandText(result.band)}）`);
        lines.push(`扫描 ${result.scanned} 章`);
        const group = (v) => (result.items || []).filter(i => i.verdict === v);
        const brief = (i) => `  第${i.no}章 ${i.name || '（无标题）'}：${i.before} 字${i.after ? ` → ${i.after}${i.split ? ` + 新第${i.no + 1}章 ${i.lenB} 字` : ''}` : ''}${i.fill ? `（新插 ${i.fill.newParas} 段承载 ${Math.round(i.fill.fillShare * 100)}%，台词 ${Math.round(i.fill.speechShare * 100)}%${i.fill.weak ? '，⚠️ 增量偏修饰' : ''}）` : ''}${i.reason ? `（${i.reason}）` : ''}${i.applied === false && !i.reason ? '（未处理）' : ''}`;
        const g1 = group('short'), g2 = group('long'), g3 = group('split'), g4 = group('ok'), g5 = group('no_body');
        // 报告里的动作词必须跟着全书「超长处理方式」走：verdict 只是长度定性（两种模式一样），
        // 而“接下来会对它做什么”两种模式完全不同。写死“建议拆章”会让 trim 模式的人
        // 以为执行完章数会变，而它实际是就地压缩
        const willSplit = (result.band?.overflow ?? result.overflowMode) === 'split';
        if (g1.length) { lines.push('', `偏短（少于下限）${g1.length} 章：`); g1.forEach(i => lines.push(brief(i))); }
        if (g2.length) { lines.push('', `偏长（超上限但未到拆章线）${g2.length} 章：`); g2.forEach(i => lines.push(brief(i))); }
        if (g3.length) {
          lines.push('', willSplit
            ? `将拆章（超拆章线）${g3.length} 章：`
            : `严重偏长（超拆章线，本书按删减次要场景处理、章数不变）${g3.length} 章：`);
          g3.forEach(i => lines.push(brief(i)));
        }
        if (g4.length) lines.push('', `合格 ${g4.length} 章：${g4.map(i => i.no).join('、')}`);
        if (g5.length) lines.push('', `无正文 ${g5.length} 章：${g5.map(i => i.no).join('、')}`);
        if (result.errors && result.errors.length) {
          lines.push('', `失败 ${result.errors.length} 章（已改完的章不受影响，重跑同一区间只重试这些章）:`);
          result.errors.forEach(e => lines.push(`  ✗ 第${e.no}章: ${e.error}`));
        }
        if (result.dryRun && (g1.length + g2.length + g3.length) > 0) {
          const calls = g1.length + g2.length + g3.length;
          // 两种模式的代价完全不同，不能用同一句：split 会改书结构（章号平移、需重新发布），
          // trim 压根不拆章——对 trim 说“拆章会平移后续章号”既是吓人也说错了动作
          lines.push('', willSplit
            ? `执行会逐章调用模型（约 ${calls} 次，单次 1–2 分钟）；拆章会平移后续章号，执行时会自动校正标题章号与正文/大纲里的「第N章」引用，并自动补写拆出来偏短的那半（不校则页面标题虽然按位置重建，但朗读/出题用的是原正文，会念出旧章号；不补则下限以下的新章一直短着）。`
            : `执行会逐章调用模型（约 ${calls} 次，单次 1–2 分钟）；超长的章在原章内删减次要场景压到合格带（章数与章号都不变，已发布页面无需重新发布），偏短的章会自动补写。改动前的原稿会存进章节修订，可从「章节修订」取回。`);
        }
        if (result.headingFixed || result.xrefFixed) {
          lines.push('', `🔧 拆章平移后校正：${result.headingFixed || 0} 章的标题章号、${result.xrefFixed || 0} 处「第N章」引用（正文与大纲；旧号会被朗读/出题读到，也会让后续生成接着引用错章）。`);
        }
        if (result.xrefUnresolved?.length) {
          lines.push(`  ⚠️ ${result.xrefUnresolved.length} 处引用未自动改（写法超出能安全回写的范围），请人工核对：`);
          result.xrefUnresolved.slice(0, 10).forEach((u) => lines.push(`     第${u.no}章「${u.quote}」应指向第${u.to}章`));
        }
        lines.push('', result.note);
        return lines.join('\n');
      }

      case 'generateOutlinesForRange': {
        const lines = [];
        if (result.partial) lines.push('⚠️ 本次部分完成（下面列出了失败的章）：');
        if (result.inserted) {
          lines.push(`✓ 已新增 ${result.inserted.count} 章（第 ${result.inserted.from}–${result.inserted.to} 章），其中 ${result.filledCount} 章已补上大纲`);
          lines.push(`  后移顺延: ${result.inserted.shiftedCount || 0} 章`);
        } else {
          lines.push(`✓ 已补写 ${result.filledCount} 章大纲（扫描区间：第 ${result.from}–${result.to} 章，共 ${result.scanned} 章）`);
        }
        lines.push(`已有大纲的章节: 跳过 ${result.skippedCount ?? 0} 章（未被改动）`, `正文: 未做任何修改`);
        if (result.filledCount === 0 && !result.inserted) {
          lines.push('', '区间内没有缺大纲的章节，本次未改动任何内容。');
        }
        (result.outlines || []).forEach(o => lines.push(`  第${o.no}章: ${o.name || '（无标题）'}`));
        if (result.snapshotCount > 0) {
          lines.push('', `🛟 已为 ${result.snapshotCount} 章存旧稿快照（source=outlineRebuild），可从 chapter_revision 回滚。`);
        }
        if (result.remaining > 0) {
          lines.push('', `⚠️ 区间内还有 ${result.remaining} 章大纲为空，本次未处理（单次上限 50 章）。再跑一次同一区间即可接着补。`);
        }
        if (result.errors && result.errors.length > 0) {
          lines.push('', `失败 ${result.errors.length} 章（已落库的章不受影响，重跑本区间会重试这些章）:`);
          result.errors.forEach(e => lines.push(`  ✗ 第${e.no}章: ${e.error}`));
        }
        if (result.stoppedEarly) {
          // 熔断不是出错，不单独说会被当成「剩下的章都失败了」
          lines.push('', `⛔ 连续 ${result.stoppedEarly} 章失败，本次已提前停止（下面的「未尝试」是本轮没跑到的章，不是失败）。`);
        }
        if (result.deferred && result.deferred.length > 0) {
          const d = result.deferred;
          const preview = d.length > 8 ? `${d.slice(0, 8).join('、')}…共 ${d.length} 章` : d.join('、');
          lines.push(`未尝试的章号: ${preview}。修好推理服务后重跑同一区间即可，已补好的章会自动跳过。`);
        }
        if (result.filledCount > 0) {
          lines.push('', '下一步：这些章只有大纲、正文为空，用 ③ 区间生成正文（或 generate 传 chapter）补写正文。');
        }
        return lines.join('\n');
      }

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
        // 旧稿快照数量：把「被清空的正文其实还能找回」写在结果里，否则用户只能干看空白页
        if (result.snapshotCount > 0) {
          outlineSummary.push('');
          outlineSummary.push(`🛟 已为 ${result.snapshotCount} 章建立旧稿快照（reason=整本重建大纲前的自动快照），可从 chapter_revision 回滚。`);
        }
        return outlineSummary.join('\n');

      case 'generate':
        const genMsg = [`✓ 成功生成第${result.chapter}章`, `标题: ${result.name}`, `字数: ${result.wordCount} 字`, `数据库操作: ${result.dbAction}`];
        // 长度偏差仍要报：trim 模式下压缩可能因守卫而保留原稿，“已自动处理”不等于“已处理成功”。
        // 但拆过章就不再报 lengthNote：它说的是拆章前那一整章的长度，拆完已经不成立，
        // 两行一起出反而让人以为还有一章超长没管
        if (result.lengthNote && !result.overflowNote) genMsg.push(`⚠️ ${result.lengthNote}`);
        if (result.overflowNote) genMsg.push(`✂️ ${result.overflowNote}`);
        if (result.outlineExpansion?.added) {
          genMsg.push(`📋 本章情节量超出一章，已自由扩展为 ${1 + result.outlineExpansion.added} 章` +
            `（新增第 ${result.outlineExpansion.from}–${result.outlineExpansion.to} 章，后续章号已顺延，已发布页面需重新发布）`);
        }
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

        // 拆章把书结构改了：下面列的章号与字数都是拆章前的，不说清就会让人拿着旧号去发布
        if (result.overflow?.split?.length) {
          const ov = result.overflow;
          summary.push('');
          summary.push(`✂️ 自由扩展：${ov.split.length} 章超长已拆成多章（上面列的是拆章前的章号与字数）`);
          ov.split.forEach((s) => {
            summary.push(`  - 原第${s.no}章 ${s.before} 字 → ${s.parts} 份（${s.lens.join(' / ')} 字）`);
          });
          if (ov.expanded.length) {
            summary.push(`  已自动补写偏短的份: ${ov.expanded.map((e) => `第${e.no}章 ${e.before}→${e.after} 字`).join('、')}`);
          }
          if (ov.unresolved.length) {
            summary.push(`  ⚠️ 未能处理: ${ov.unresolved.map((u) => `第${u.no}章 ${u.reason || ''}`).join('；')}`);
          }
          if (ov.shifted) summary.push(`  共平移 ${ov.shifted} 处章号，已发布页面需重新发布`);
        }

        return summary.join('\n');

      case 'add':
        return `✓ 成功添加第${result.chapter}章\n标题: ${result.name}\n字数: ${result.wordCount} 字\n数据库操作: ${result.dbAction}\n注意: 后续章节已自动重排` +
          (result.overflowNote ? `\n✂️ ${result.overflowNote}` : '');

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
    let outlines = await this.generateChapterOutlinesWithLLM(novelInfo, totalChapters);

    // 删减次要场景（trim）模式下章数就是用户要的章数：模型多给的章砍掉并列出来告知。
    // 不砍的话「章数不变」这个约定会被模型的一次不听话破掉，而整本重建会清空正文，
    // 多出的章相当于未经批准就改了书结构。自由扩展（split）模式则照单全收。
    const band = this._wordBandFor(novelInfo);
    let droppedChapters = [];
    if (band.overflow !== 'split' && outlines.length > totalChapters) {
      droppedChapters = outlines.slice(totalChapters).map((o) => ({ no: o.no, name: o.name }));
      outlines = outlines.slice(0, totalChapters);
      console.warn(`⚠️ 模型给出 ${outlines.length + droppedChapters.length} 章大纲，超过计划的 ${totalChapters} 章；本书超长处理方式=trim（章数不变），已丢弃多出的 ${droppedChapters.length} 章：${droppedChapters.map((d) => d.name).join('、')}`);
      if (sessionId) {
        progressHub.publish(sessionId, `⚠️ 模型多给了 ${droppedChapters.length} 章大纲，本书未开启自由扩展（章数不变），已按计划的 ${totalChapters} 章保存`);
      }
    }

    if (sessionId) {
      progressHub.publish(sessionId, `✅ 章节大纲生成完成，共 ${outlines.length} 章`);
    }

    // 批量保存到数据库
    const savedOutlines = [];
    const errors = [];
    let snapshotted = 0;

    for (const outline of outlines) {
      try {
        // 第二层护栏：上一道关卡可能因调用方显式 force 而放行，这里把被覆盖的原文先存一份。
        // upsertChapter 对已有章号执行的是「重写 name/outline + content 置空」，没快照就真回不来。
        const before = this.db.getChapter(outline.no);
        // getChapter 不返回 type 列，故用 no > 0 判定章节（no=0 是小说概要行，不在重建范围内）
        if (before && Number(before.no) > 0 && String(before.content || '').trim()) {
          const snap = this.db.saveChapterRevision(before.no, {
            name: before.name,
            content: before.content,
            reason: '整本重建大纲前的自动快照（本次 upsert 会清空该章正文）',
            source: 'outlineRebuild',
          });
          if (snap?.success) snapshotted++;
        }
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
      // 旧稿可找回来的数量（章节修订快照，可用 listChapterRevisions / restoreChapterRevision 取回）
      snapshotCount: snapshotted,
      // trim 模式下被砍掉的超额章（只报标题，大纲正文没落库）；想要它们就把全书改成自由扩展再重建
      droppedChapters: droppedChapters.length ? droppedChapters : undefined,
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
    // 每章目标字数（全书共同设定）：在大纲阶段就要钉住。实测同一本书里大纲 ~380 字的章
    // 正文飘到 2749–5608（极差 2859），而大纲 ~2000 字的章只飘 946——篇幅实际由大纲详略决定，
    // 只在正文提示词里加一句“目标 N 字”管不住。
    const band = this._wordBandFor(novelInfo);
    const targetWC = band.on ? band.target : null;
    // 每份大纲的长度上限：口径与逐章路径完全一致（都取 wordTarget.js 的 outlineCapFor）。
    // 批量路径因为一次要写 N 章、回复长度有限，天然就被迫精简（实测 108–451 字）；
    // 但上限还是要写明，否则章数少（如 3 章）时模型会把每章写得很肥。
    const cap = outlineCapFor(band);
    const freeExpand = band.on && band.overflow === 'split';

    const prompt = `你是一位专业的小说策划师。请根据以下小说概要，生成详细的章节大纲。

## 小说名称
${novelInfo.name}

## 故事概要
${novelInfo.outline}

${novelInfo.content ? `## 角色设定与世界观\n${novelInfo.content}` : ''}

## 任务
为这部小说生成完整的章节大纲，共 ${totalChapters} 章。

要求：
${freeExpand
    ? `1. 至少 ${totalChapters} 章：本书已开启「自由扩展」，若按每章 ${targetWC || '目标'} 字的体量算下来情节写不完，可以多给几章（章号从 1 起连续），不要为了凑数把一章塞爆`
    : `1. 必须生成 exactly ${totalChapters} 个章节`}
2. 每个章节必须有：
   - 章节编号（从 1 开始${freeExpand ? '连续递增' : `，到 ${totalChapters} 结束`}）
   - 章节标题（简洁有力）
   - 详细的大纲内容（包含主要情节、关键事件、角色发展、与前后章节的衔接）
3. 大纲要足够详细，让作家可以直接根据大纲生成章节内容
4. 章节之间要有逻辑连贯性和情节递进
5. 合理分配故事节奏：开端、发展、高潮、结局
6. 🔴 角色姓名锁死：大纲中提及角色时必须使用设定里给出的名字（如主角、反派、各章导师），
   严禁改名、换昵称或新造主要角色；若设定列有章节推进表，必须逐章按表实写
${targetWC ? `7. 🔴 每章大纲必须明确标注“本章约 ${targetWC} 字”，且本章的情节体量（场景数、对话轮数）必须按 ${targetWC} 字能写完来设计：不要给出明显写不满的空框，也不要塞进 ${band.max} 字装不下的多场戏。每章大纲正文不得超过 ${cap} 字——情节点铺太满，正文必然写超${freeExpand ? '；写不下就多分一章，而不是把大纲写肥' : '；写不下就砍掉次要支线，把它留给后面的章'}` : ''}

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

请生成 ${freeExpand ? `至少 ${totalChapters} 章（情节量需要时可以更多）` : `${totalChapters} 个章节`}的大纲：`;

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
   *
   * 全书开了「自由扩展」时可能返回多份（extra 非空）：模型认为这段情节一章写不完，
   * 调用方负责把多出来的那几章插进目录（见 _saveExpandedOutlines），本方法不碰书结构。
   * @param {number} chapterNo - 章节号
   * @param {Object} novelInfo - 小说概要信息
   * @param {string|null} [extraBrief] - 额外的本段语境/用户素材（区间补大纲传入），
   *   放在「故事概要」之后、前后章之前：素材是写什么，前后章是怎么衔接
   * @returns {Promise<{name: string, outline: string, extra: Array<{name:string,outline:string}>}>}
   */
  async generateSingleChapterOutlineWithLLM(chapterNo, novelInfo, extraBrief = null) {
    const band = this._wordBandFor(novelInfo);
    // 大纲长度上限：这是每章字数的第一道闸。实测大纲 108–451 字的章正文 2400–2937 字（合格），
    // 大纲 1267–1400 字的章正文 3505–4175 字（超标）——正文提示词里写多少遍「不得超 X 字」
    // 都拗不过一份把情节点铺满的大纲，所以上限必须设在这里
    const cap = outlineCapFor(band);
    const freeExpand = band.on && band.overflow === 'split';
    // 只取紧邻的两章，不拉全量：getAllChapters 默认 LIMIT 1000，1000 章之后的邻章会被静默丢弃，
    // 模型就看不到上下文。no=0 是小说概要行，不能当成「上一章」注入
    const pick = (no) => {
      if (no < 1) return null;
      const ch = this.db.getChapter(no);
      // 邻章自己还是空大纲（逐章补写时下一章尚未填）时拿去只会噪，不如不给
      return ch && !this._isBlankOutline(ch.outline) ? ch : null;
    };
    const prev = pick(chapterNo - 1);
    const next = pick(chapterNo + 1);

    // 篇幅约束按模式分叉：trim 要求写不下就砍支线，split 要求写不下就分成多章
    const wordRules = !band.on ? '' : freeExpand
      ? `5. 🔴 每份大纲正文不得超过 ${cap} 字（情节点铺太满，正文必然写超），并在末尾注明“本章约 ${band.target} 字”
6. 🔴 情节量一章写不完时不要硬塞：本书已开启「自由扩展」，请把这段情节按每章约 ${band.target} 字切成几章，用 chapters 数组返回（只有一章也返回数组）。切分处要落在场景边界上，每章各自能写完一个完整场景`
      : `5. 🔴 大纲正文不得超过 ${cap} 字（情节点铺太满，正文必然写超），并在末尾注明“本章约 ${band.target} 字”
6. 情节写不下就砍掉次要支线，把它留给后面的章，不要在本章堆叠场景`;
    const outFormat = freeExpand
      ? `请严格按照以下 JSON 格式返回（不要包含任何其他内容），chapters 至少一项：
{"chapters": [{"name": "章节标题", "outline": "详细的大纲内容..."}]}`
      : `请严格按照以下 JSON 格式返回（不要包含任何其他内容）：
{"name": "章节标题", "outline": "详细的大纲内容..."}`;

    const prompt = (feedback) => `你是一位专业的小说策划师。请根据以下信息，为第${chapterNo}章生成章节大纲。

## 小说名称
${novelInfo.name}

## 故事概要
${novelInfo.outline}

${novelInfo.content ? `## 角色设定与世界观\n${novelInfo.content}\n\n` : ''}${extraBrief ? `## 本段写什么（用户素材与阶段要求）\n${extraBrief}\n\n` : ''}${prev ? `## 上一章（第${prev.no}章：${prev.name}）大纲\n${prev.outline}\n` : ''}${next ? `## 下一章（第${next.no}章：${next.name}）大纲\n${next.outline}\n` : ''}## 任务
为第${chapterNo}章生成详细大纲，要求：
1. 与上一章、下一章（如存在）自然衔接，情节递进合理
2. 包含主要情节、关键事件、角色发展
3. 大纲足够详细，让作家可以直接根据大纲生成章节内容
4. 🔴 角色姓名锁死：提及角色必须用上面设定与前后章已出现的名字，严禁改名、换昵称或新造主要角色
${wordRules}

## 输出格式
${outFormat}${feedback ? `\n\n## ⚠️ 上一次的问题\n${feedback}` : ''}`;

    const model = this.context?.model || null;
    const temperature = this.context?.temperature ?? 0.7;
    const maxTokens = this.context?.maxTokens || 4096;
    const reasoningEffort = this.context?.reasoningEffort || null;
    const sessionId = this.context?.sessionId || null;

    const call = async (feedback) => {
      const response = await llm.chat({
        messages: [
          {
            role: 'system',
            content: '你是一位专业的小说策划师，擅长规划故事结构和章节大纲。你必须返回有效的 JSON 格式。'
          },
          { role: 'user', content: prompt(feedback) }
        ],
        model,
        temperature,
        maxTokens,
        reasoningEffort,
        think: false
      });
      return response.content || '';
    };

    let raw = await call(null);
    let parsed = this._parseOutlineParts(raw, { chapterNo, allowSplit: freeExpand });

    // 后验守卫：提示词里的上限模型经常不听，所以拿实际长度再校一道。
    // 只回喂一次、取更短的那份（写法照 _compressChapterToTarget）；两次都超长只告警不阻断生成——
    // 大纲略长不至于让本章开天窗，而正文阶段还有压缩/拆章兜底
    if (cap) {
      const longest = (ps) => ps.reduce((m, p) => Math.max(m, p.outline.length), 0);
      if (longest(parsed.parts) > cap * 1.5) {
        const was = longest(parsed.parts);
        console.log(`⚠️ 第${chapterNo}章大纲 ${was} 字，超上限 ${cap} 字，回喂精简一次...`);
        if (sessionId) {
          progressHub.publish(sessionId, `📋 第 ${chapterNo} 章大纲 ${was} 字超出上限 ${cap} 字，正在要求精简...`);
        }
        try {
          const again = this._parseOutlineParts(
            await call(`上一次返回的大纲有 ${was} 字，超过上限 ${cap} 字。请精简到 ${cap} 字以内：只保留主线场景与关键转折，删掉次要支线与逐句剧情复述（那些留给后面的章）。${freeExpand ? `若精简后仍写不下，就按每章 ${cap} 字以内拆成多章返回。` : ''}`),
            { chapterNo, allowSplit: freeExpand },
          );
          // 比最长那一份，不比总长：拆成多章后总长本来就该变多，那正是自由扩展要的结果
          if (again.parts.length && longest(again.parts) < longest(parsed.parts)) parsed = again;
        } catch (e) {
          console.error(`第${chapterNo}章大纲精简重试失败，沿用第一份：${e.message}`);
        }
        const now = longest(parsed.parts);
        if (now > cap * 1.5) {
          console.log(`⚠️ 第${chapterNo}章大纲仍有 ${now} 字（上限 ${cap}），不阻断生成；正文会写超，由「超长处理方式=${band.overflow}」兜底`);
          if (sessionId) {
            progressHub.publish(sessionId, `⚠️ 第 ${chapterNo} 章大纲精简后仍 ${now} 字（上限 ${cap}），已按原样保留`);
          }
        }
      }
    }

    const [first, ...extra] = parsed.parts;
    return {
      name: first.name || `第${chapterNo}章`,
      outline: first.outline || '（无大纲内容）',
      extra,
    };
  }

  /**
   * 把模型返回的大纲文本解析成「一章或多章」。
   *
   * 认三种形状，宽容度递减：
   *   ① {"chapters":[{name,outline},...]} —— 自由扩展模式要求的格式，只有一章时也是一项的数组
   *   ② {"name","outline"} 且 outline 里带 <<<SPLIT>>> —— 模型没按 chapters 数组返回时的兜底
   *   ③ 完全不是 JSON —— 整段文本当一份大纲（原有的兜底行为，不变）
   *
   * allowSplit=false（删减次要场景模式）时一律只返回一份：模型就算给了多段也合并成一段。
   * 那个模式的约定就是章数不变，多出来的章没人批准过；而合并后的大纲偏长会在正文阶段被压缩。
   * 多出来的那几份可能没标题（name 为空），由调用方按插入后的实际章号补。
   * @returns {{parts: Array<{name:string, outline:string}>}} parts 至少一项
   */
  _parseOutlineParts(raw, { chapterNo = 0, allowSplit = false } = {}) {
    const text = String(raw || '');
    const dfltName = chapterNo ? `第${chapterNo}章` : '';
    const one = (name, outline) => ({
      parts: [{ name: String(name || '').trim() || dfltName, outline: String(outline || '').trim() || '（无大纲内容）' }],
    });
    const merge = (segs, name) => one(name || segs[0]?.name, segs.map((s) => String(s.outline || s).trim()).filter(Boolean).join('\n\n'));

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return one(dfltName, text.trim());
    let parsed = null;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('解析单章大纲 JSON 失败:', error.message);
      return one(dfltName, text.trim());
    }

    // ① chapters 数组
    if (Array.isArray(parsed?.chapters)) {
      const segs = parsed.chapters
        .map((c) => ({ name: String(c?.name || '').trim(), outline: String(c?.outline || '').trim() }))
        .filter((c) => c.outline && !this._isBlankOutline(c.outline));
      // JSON 合法但没给出可用大纲：回占位语而不是把 JSON 原文当大纲存下去
      //（调用方靠 _isBlankOutline 判“模型未给出可用大纲”，原文当大纲会让这道判定失效）
      if (!segs.length) return one(parsed?.name || dfltName, parsed?.outline || '');
      if (!allowSplit || segs.length < 2) return merge(segs);
      return { parts: segs.map((s, i) => ({ name: i === 0 ? (s.name || dfltName) : s.name, outline: s.outline })) };
    }

    // ② 单对象，outline 里可能带分隔符
    const outline = String(parsed?.outline || '').trim();
    const name = String(parsed?.name || '').trim();
    if (!outline) return one(name || dfltName, '');
    if (outline.includes(OUTLINE_SPLIT_MARK)) {
      const segs = outline.split(OUTLINE_SPLIT_MARK).map((s) => s.trim()).filter(Boolean);
      if (!allowSplit || segs.length < 2) return one(name || dfltName, segs.join('\n\n'));
      return { parts: segs.map((s, i) => ({ name: i === 0 ? (name || dfltName) : '', outline: s })) };
    }
    return one(name || dfltName, outline);
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
   * 按「旧章号 → 新章号」把文本里的第N章引用重算一遍（拆章平移后用）。
   *
   * 只换编号、其余一字不动：保留原写法（阿拉伯数字仍是数字、中文数字仍是中文，
   * 中文侧复用 `toChinese` 而不另写一份映射表 —— 部名的口径就是这么分叉过的）。
   * 引用识别走 `findChapterRefs`（它已排除标题行），不在这里再造一套正则。
   *
   * 两条保守规则：引用了旧书里不存在的章号（r.no > maxOldNo）不碰，那不属于本次平移；
   * 无法把新号写回原样式的（超出 toChinese 范围等）不碰，只记到 unresolved 里交给人工。
   * @param {string} text - 正文或大纲
   * @param {{toNew:(n:number)=>number, maxOldNo:number}} map
   * @returns {{text:string, changes:Array<{from:number,to:number}>, unresolved:Array}}
   */
  _remapChapterRefs(text, { toNew, maxOldNo }) {
    const src = String(text || '');
    const changes = [], unresolved = [];
    let out = '', pos = 0;
    for (const r of findChapterRefs(src, 'content')) {
      if (r.index < pos) continue;                       // 与上一处替换重叠
      if (r.no > maxOldNo) continue;                     // 旧书里没这个章号，不是平移能解释的
      const to = toNew(r.no);
      if (!Number.isInteger(to) || to === r.no) continue;
      const num = r.quote.replace(/^第\s*|\s*章$/g, '');
      let rendered = null;
      if (/^[0-9]+$/.test(num)) rendered = String(to);
      else if (/^[一二三四五六七八九十百零两]+$/.test(num)) {
        try { rendered = toChinese(to); } catch { rendered = null; }
      }
      if (!rendered) { unresolved.push({ from: r.no, to, quote: r.quote }); continue; }
      out += src.slice(pos, r.index) + r.quote.replace(/([0-9]+|[一二三四五六七八九十百零两]+)/, rendered);
      pos = r.index + r.quote.length;
      // 带上原样 quote：调用方（存量补修脚本）要拿它回指执行前快照，
      // 用 “第${from}章” 重建会把中文数字写法（第五章）搜成阿拉伯数字，判定为“找不到”
      changes.push({ from: r.no, to, quote: r.quote });
    }
    return { text: out + src.slice(pos), changes, unresolved };
  }

  /**
   * 插入点 → 「旧章号转新章号」的映射函数。
   * 一处插入让它之后的章整体后移一位，插入点自己占住原号。
   * 抽出来是因为 tuneWordCount 的阶段 3（按新号找该补写的章）与
   * _renumberAfterInserts（校正标题与引用）必须用同一个映射：
   * 两边各写一遍公式，任一边改了都会让「校正过的引用」与「按新号定位的章」对不上。
   * @param {Array<number>} insertPoints - 插入点的**原**章号
   * @returns {(n:number)=>number}
   */
  _insertShiftMap(insertPoints = []) {
    const pts = [...insertPoints].sort((a, b) => a - b);
    return (n) => n + pts.filter((s) => s < n).length;
  }

  /**
   * 插章（拆章 / 规划扩章）把后续章号整体后移之后，按定稿编号把「第X章」的字样重算一遍。
   *
   * 两处都会漏给读者：① 正文首行的标题号（页面按位置重建所以看不见，但朗读/出题/生词
   * 吃的是原始正文）；② 正文与大纲里「在第7章中，高斯证明的……」这类互相引用。
   * 引用跟着**目标章**走，所以每一章都要重算，包括排在插入点之前的章。
   *
   * ⚠️ 调用时机必须在扩写/压缩**之前**：那些动作会让模型在**新**编号下写正文，
   * 之后再统一平移就把它们移了两次（偏移量翻倍，比不改更难查）。这是踩过的坑。
   * @param {Array<number>} insertPoints - 插入点的**原**章号（降序处理后的结果，全是原号）
   * @param {Object} [opts]
   * @param {number} opts.maxOldNo - 插入前的最大章号，交给 _remapChapterRefs 判「旧书里没这个章号就不碰」
   * @param {string} [opts.reasonTag] - 留档理由的前半句（区分是字数治理拆的章还是规划扩的章）
   * @param {string} [opts.source] - chapter_revision 的来源标记
   * @returns {{headingFixed:number,xrefFixed:number,xrefUnresolved:Array,toNew:(n:number)=>number}}
   */
  _renumberAfterInserts(insertPoints, { maxOldNo = 0, reasonTag = '字数治理：拆章平移后校正章号', source = 'wordCountShift' } = {}) {
    const db = this.db;
    const points = [...(insertPoints || [])];
    const toNew = this._insertShiftMap(points);
    let headingFixed = 0, xrefFixed = 0;
    const xrefUnresolved = [];
    if (!points.length) return { headingFixed, xrefFixed, xrefUnresolved, toNew };

    const maxNo = db.getMaxChapterNo?.() ?? maxOldNo;
    for (let n = 1; n <= maxNo; n++) {
      const c = db.getChapter(n);
      if (!c || (!String(c.content || '').trim() && !String(c.outline || '').trim())) continue;
      // 标题行：只改已有「# 第X章」形态的，没标题行的不无中生有（那是另一种改动）
      const first = String(c.content).replace(/^\s+/, '').split('\n')[0];
      const headed = /^#\s*第\s*[0-9一二三四五六七八九十百零两]+\s*章/.test(first)
        ? this.normalizeChapterHeading(c.content, n) : c.content;
      if (headed !== c.content) headingFixed++;
      const body = this._remapChapterRefs(headed, { toNew, maxOldNo });
      const outline = this._remapChapterRefs(c.outline || '', { toNew, maxOldNo });
      xrefFixed += body.changes.length + outline.changes.length;
      for (const u of [...body.unresolved, ...outline.unresolved]) xrefUnresolved.push({ no: n, ...u });
      if (body.text === c.content && outline.text === (c.outline || '')) continue;
      db.saveChapterRevision(n, {
        name: c.name, content: c.content,
        reason: `${reasonTag}（标题${headed !== c.content ? '已改' : '未改'}、引用 ${body.changes.length + outline.changes.length} 处）`,
        source,
      });
      // name/outline/content 必须全量传：upsertChapter 是无条件 UPDATE，漏一个就会被写成 NULL
      db.upsertChapter({ no: n, name: c.name, outline: outline.text, content: body.text });
    }
    return { headingFixed, xrefFixed, xrefUnresolved, toNew };
  }

  /**
   * 自由扩展：模型认为一章的情节量写不完时多给的那几章，插到 baseNo 之后。
   *
   * 为何要单独一个方法：插章会平移后续章号，而逐章补大纲的循环是升序跑的，
   * 边生成边插会让循环手里的章号全部失效。所以调用方一律先在内存里攒着，
   * 循环跑完后**降序**逐个调本方法（降序保证待处理的扩展点不会被已处理的平移影响）。
   *
   * 插完立即按定稿编号校正标题与「第X章」引用；maxOldNo 必须在插入前现读，
   * 因为上一个扩展点已经把编号推高了一轮，用一开始缓存的值会把合法引用当成“旧书里没这章”而漏改。
   * @param {number} baseNo - 原章号（多出来的章插在它之后，它自己编号不变）
   * @param {Array<{name:string,outline:string}>} extraParts - 除首份之外的各份大纲
   * @returns {{added:number,shifted:number,from:number,to:number,headingFixed:number,xrefFixed:number,xrefUnresolved:Array,points:Array<number>}}
   */
  _saveExpandedOutlines(baseNo, extraParts, { sessionId = null } = {}) {
    const db = this.db;
    const empty = { added: 0, shifted: 0, from: 0, to: 0, headingFixed: 0, xrefFixed: 0, xrefUnresolved: [], points: [] };
    const list = (extraParts || [])
      .map((p, i) => ({
        // 模型漏给标题时用章号占位：addChaptersBulk 只硬卡大纲，但目录上出现无名章更难查
        name: String(p?.name || '').trim() || `第${baseNo + 1 + i}章`,
        outline: String(p?.outline || '').trim(),
      }))
      .filter((p) => p.outline && !this._isBlankOutline(p.outline));
    if (!list.length) return empty;

    const maxOldNo = db.getMaxChapterNo?.() ?? 0;
    if (sessionId) {
      progressHub.publish(sessionId, `📋 第 ${baseNo} 章的情节量超出一章，自由扩展：在其后新增 ${list.length} 章（原第 ${baseNo + 1} 章及以后顺延）...`);
    }
    const ins = db.addChaptersBulk(list, { mode: 'after', no: baseNo });
    // 插入点全是同一个原章号：多出的每一章都让它之后的章再顺延一位
    const points = list.map(() => baseNo);
    const r = this._renumberAfterInserts(points, {
      maxOldNo,
      reasonTag: '自由扩展：规划扩章平移后校正章号',
      source: 'outlineExpandShift',
    });
    return {
      added: list.length,
      shifted: ins.shiftedCount || 0,
      from: ins.from ?? baseNo + 1,
      to: ins.to ?? baseNo + list.length,
      headingFixed: r.headingFixed,
      xrefFixed: r.xrefFixed,
      xrefUnresolved: r.xrefUnresolved,
      points,
    };
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
      // 自由扩展在这条懒生成大纲的路径上也可能多给出几章，报告里要能看见
      let outlineExpansion = null;

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

        // 模型把本章的情节切成了多章（只在自由扩展模式下会发生）。
        // 批量生成循环里不能插章：插章会平移后续章号，循环手里的 pendingOutlines 全部失效，
        // 于是把多份大纲合并成本章一份，情节一字不丢，由正文写完后 _applyOverflowSplit 拆章兜底。
        // 单章生成没有循环，就地扩章是安全的。
        if (single.extra?.length) {
          if (this._deferStructureChange) {
            chapterOutline = [single.outline, ...single.extra.map((p) => p.outline)]
              .filter(Boolean)
              .join('\n\n');
            console.log(`ℹ️ 第${this.chapter}章大纲可写 ${1 + single.extra.length} 章，本次处于批量生成中，已合并为一章（正文超长时稍后拆章）`);
          } else {
            outlineExpansion = this._saveExpandedOutlines(this.chapter, single.extra, {
              sessionId: this.context?.sessionId || null,
            });
          }
        }

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
        lengthNote: this._lengthNote(normalizedContent.length),
        action: 'generate',
        dbAction: result.action,
        autoGeneratedOutline: true,
        outlineExpansion: outlineExpansion?.added ? outlineExpansion : undefined,
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
      lengthNote: this._lengthNote(normalizedContent.length),
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
   * 把一本小说的「每章目标字数」换算成判定区间。
   * 优先级：结构化的 gen_cfg > 旧的文字标记（存量书只在设定正文里留过一行）> 未设限。
   * 未设限时返回 on:false，调用方必须整段跳过长度判定——不能拿 0 去比大小，
   * 那会把每一章都判成「过短」而全部重写。
   * @param {Object|null} novelInfo - getNovelInfo() 的行（gen_cfg 已由 DB 层解成对象）
   * @returns {{target:number,min:number,max:number,splitAt:number,on:boolean}}
   */
  _wordBandFor(novelInfo) {
    return effectiveBand(novelInfo?.gen_cfg, [novelInfo?.content, novelInfo?.outline]);
  }

  /** 无 novelInfo 在手时（如只有拼好的设定文本）从库里读一次；读不到就当未设限 */
  _wordBand(fallbackText = '') {
    try {
      const band = this._wordBandFor(this.db?.getNovelInfo?.());
      if (band.on) return band;
    } catch { /* 库不可用/无概要行：回落旧标记 */ }
    return effectiveBand(null, [fallbackText]);
  }

  /**
   * 要产出一整章的调用给多长上游超时。本地模型实测 12–25 字/秒，按 100ms/字 给预算
   * 再加 60s 预置（提示词本身比产出长）。不这么做的后果是实的：aibridge 对上游默认
   * 只给 120s，目标 3000 字的整章生成实测就在 120s 被切，看起来像“设了字数就写不出来”。
   * 280s 是 aibridge 那边的封顶（再高会先被 Node 的 requestTimeout 切断），写死上限而不是
   * 按 target 线性增长，是为了不让一个填错的目标字数把一次调用挂到十分钟。
   * @param {number} target - 本次期望产出的字数
   */
  _chapterCallMs(target) {
    const t = Number(target) || 0;
    return Math.min(280000, Math.max(120000, 60000 + Math.round(t * 100)));
  }

  /**
   * 一行长度结论，只在偏出合格带时给。生成后的实际长度与目标对不上是
   * 用户唯一能发现“字数约定没生效”的机会，不能只写进日志。
   */
  _lengthNote(len) {
    const band = this._wordBand();
    if (!band.on) return null;
    const v = classifyLength(len, band);
    if (v === 'ok') return null;
    if (v === 'short') return `仅 ${len} 字，少于下限 ${band.min}（已尝试扩写，仍偏短可再用「字数治理」）`;
    // 超长的收尾动作按全书「超长处理方式」说，不能一律指路治理：
    // · split：超长是预期的，拆章在本方法返回之后才做，这里说的是拆前那一整章的长度
    // · trim：压缩已在生成当时就地做过，能走到这里说明被守卫拦下了（压后反而更短/低于下限）
    if (band.overflow === 'split') {
      return `${len} 字，超出合格上限 ${band.max}：本书为自由扩展，稍后自动拆成多章（本行是拆章前的整章长度）`;
    }
    if (v === 'split') return `${len} 字，超过拆章线 ${band.splitAt}：自动压缩未能收进合格带（本书为删减次要场景模式，章数不变），可用「📏 字数治理」再处理`;
    return `${len} 字，超出合格上限 ${band.max}：自动压缩未能收进合格带，可用「📏 字数治理」再处理`;
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
      // 调用方可按产出量报一个上游超时（不传则由 llm.js 走默认）：整章改写/扩写这类
      // 输出上千字的调用撞上 aibridge 120s 默认顶时，错的是预算不是模型
      timeout: opts.timeout || undefined,
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
    // 未显式传入时读全书生成设定（gen_cfg）；存量书回落设定正文里那行旧文字标记
    const band = targetWordCount ? wordBand({ targetWords: targetWordCount }) : this._wordBand(fullOutline);
    const isRewrite = !!modifyContext?.originalContent;
    // 自由扩展：超长时不砍内容而是拆章（章数与总字数会增加）；trim 则删减次要场景，章数不变
    const freeExpand = band.on && band.overflow === 'split';

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
        : `1. 生成完整的章节内容${band.on
        ? `：本章目标 ${band.target} 字，必须落在 ${band.min}–${band.max} 字之间——不得少于 ${band.min} 字（写不满说明场景不够，请补完而不是草草收尾），也不要超过 ${band.max} 字（宁可把次要分支留到下一章）。${freeExpand
          ? `本书已开启「自由扩展」：宁可把情节写完整，超出的部分系统会自动拆成下一章；但仍不得少于 ${band.min} 字，也不要把一件事反复铺开凑字`
          : `本书按「删减次要场景」处理超长：情节写不完就删掉次要场景与不推进情节的支线对话，不要靠加字硬写完`}`
        : '，字数符合大纲要求'}
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
    // 打字机增量，避免界面一直停留在 loading。sessionId 由调用方注入：
    // Web 走 routes.js 的 /api/run（前端的 progressId），宿主会话走 skillExecutor
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
      // 目标准则生效后的整章产出比原先长得多，上游超时必须跟着目标字数走（见 _chapterCallMs）
      timeout: band.on ? this._chapterCallMs(band.target) : undefined,
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
    if (band.on && content.length > 0) {
      const isTruncated = (finishReason === 'length') ||
        (content.length < band.target * 0.5 && !content.trimEnd().match(/[。！？"]\s*$/));
      if (isTruncated) {
        console.log(`⚠️ 第${chapterNo}章被截断（当前${content.length}字/目标${band.target}字，finishReason=${finishReason}），尝试续写...`);
        if (sessionId) {
          progressHub.publish(sessionId, `⚠️ 第 ${chapterNo} 章被截断，正在续写补全...`);
        }
        content = await this._continueChapterContent(content, chapterNo, band.target, sessionId);
      } else if (!isRewrite) {
        // 没被截断、但写完就短于下限：这是“收尾太急”，续写接不上（已到一个自然完结点），
        // 改用全文扩写。改写模式不扩：那边的基准是原文篇幅，本来就说了“与原文大致相当”。
        // 复用治理那一个入口：_expandChapterToTarget 自带「不短于下限就原样返回」的守卫，
        // 所以这里无条件调用即可（曾经误写成不存在的 _expandChapterIfShort，一设目标字数就 TypeError）。
        content = await this._expandChapterToTarget(content, chapterNo, band, sessionId);
      }
    }

    // 超长时按全书「超长处理方式」动手，而不是只报不动文：
    // · trim：就地压缩。_compressChapterToTarget 的硬约束第 2 条本就是“只能删冗余环境描写/
    //   重复心理活动/不推进情节的支线对话/同义反复的修饰”，等于用户要的“删减次要场景”，
    //   不必另写一套提示词；它自带两道守卫（压后不短于原文、压后不低于下限就保留原稿）。
    // · split：原样返回，由调用方在批量循环结束后统一调 _applyOverflowSplit 拆章。
    //   拆章会平移后续章号，在生成循环里改书结构是真实危险（循环手里的章号会全部失效）。
    // 改写模式（isRewrite）一律不压：改写的基准是原文篇幅，原文本来就超长时压它会改掉
    // 超出用户授权的内容——与上面「改写不扩写」的守卫对称。
    if (band.on && content.length > band.max) {
      if (freeExpand) {
        console.log(`ℹ️ 第${chapterNo}章 ${content.length} 字，超出合格上限 ${band.max}；本书为自由扩展模式，正文写完后统一拆章`);
      } else if (isRewrite) {
        console.log(`⚠️ 第${chapterNo}章 ${content.length} 字，超出合格上限 ${band.max}；改写模式不自动压缩（以原文篇幅为基准）`);
      } else {
        content = await this._compressChapterToTarget(content, chapterNo, band, sessionId);
        if (content.length > band.max) {
          console.log(`⚠️ 第${chapterNo}章压缩后仍为 ${content.length} 字（上限 ${band.max}）；可用「字数治理」再处理`);
        }
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
      // 续写要的也是上千字，同一个口径给预算
      timeout: this._chapterCallMs(remaining),
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
   * 在哪个段落边界把一章拆成两半（纯确定算法，不调模型）。
   * 为什么不让模型选切点：模型选完还要它把两半重抄一遍，上千字里丢情节就是这么发生的；
   * 而按空行切段、逐段累加字数已经能够到一个不切断句子的边界，两半拼回去就是原文。
   * @param {string} content - 章正文（含首行标题）
   * @param {number} firstLen - 上半的目标字数（由 splitTargets 算出，不是简单对半）
   * @param {{on:boolean,min:number,max:number}} [band] - 合格带；传了才会优先选“两半都进带”的切点
   * @returns {{bodyA:string, bodyB:string, title:string}|null}
   */
  _pickSplitPoint(content, firstLen, band) {
    const lines = String(content || '').split(/\r?\n/);
    // 首行标题单独拆出来：两半各自要拼自己章号的标题，原处那句不能跟着上半走
    let title = '';
    let start = 0;
    const hm = lines[0] && lines[0].match(/^#\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章\s*[：:]?\s*(.*)$/);
    if (hm) { title = (hm[1] || '').trim(); start = 1; }

    const paras = [];
    let buf = [];
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim() === '') { if (buf.length) { paras.push(buf.join('\n')); buf = []; } }
      else buf.push(lines[i]);
    }
    if (buf.length) paras.push(buf.join('\n'));
    if (paras.length < 2) return null;   // 一整块不分段：没地方下刀，不能硬拆

    // 候选切点 i：上半为 paras[0..i]。越靠近 firstLen 越好；
    // 下一段是场景分隔（--- / *** / ##）时加权，那本来就是作者自己留的换气口。
    // 但先得保证切完两半都在合格带内：段落是粗粒度的，只按“离目标多近”打分时，
    // 上半超到 2631 会把下半挤到 2327（低于下限）——实测就是这么翻车的。
    // 所以不可行的切点统一加一个远大于任何长度差的惩罚：有可行切点就必选可行，
    // 全不可行时才退回“离目标最近”，并由调用方把偏短的那半报出来。
    const total = paras.reduce((a, p) => a + p.length, 0);
    const PENALTY = 1e6;
    let best = null;
    let acc = 0;
    for (let i = 0; i < paras.length - 1; i++) {
      acc += paras[i].length;
      const isBreak = /^\s*(?:-{3,}|\*{3,}|#{1,4}\s)/.test(paras[i + 1]);
      const base = Math.abs(acc - firstLen) - (isBreak ? Math.max(60, firstLen * 0.06) : 0);
      const infeasible = band?.on && (acc < band.min || total - acc < band.min || acc > band.max || total - acc > band.max);
      const score = base + (infeasible ? PENALTY : 0);
      if (!best || score < best.score) best = { i, score };
    }
    if (!best) return null;
    return {
      title,
      bodyA: paras.slice(0, best.i + 1).join('\n\n'),
      bodyB: paras.slice(best.i + 1).join('\n\n'),
    };
  }

  /**
   * 为拆出的两半拟题与写大纲（一次调用）。失败就报错不退而求其次：
   * 拿「（无标题）/（待补写）」占位会交出一章目录上看着正常、点进去无名无纲的章，
   * 比拆失败更难发现。
   */
  async _nameSplitHalves(no, ch, picked, band) {
    const brief = (label, text) => `【${label}·${text.length} 字】\n开头：${text.slice(0, 260)}\n结尾：…${text.slice(-260)}`;
    const prompt = `第${no}章《${ch.name || '无标题'}》篇幅过长，要按情节自然拆成前后两章。请为两章各拟一个标题、各写一段大纲。

## 本章信息
原大纲：${String(ch.outline || '（无大纲）').slice(0, 1500)}
本书每章目标 ${band.target} 字。

## 拆出的前半
${brief('前半', picked.bodyA)}

## 拆出的后半
${brief('后半', picked.bodyB)}

## 要求
1. 大纲只写各自覆盖的那半情节，两段合起来要等价于原大纲，不得新增原大纲没有的事件
2. 后半必须另拟标题，不得与原章名相同；两个标题都不能带“第X章”前缀
3. 只返回 JSON，不要任何其他内容：
{"nameA":"前半标题","nameB":"后半标题","outlineA":"前半大纲","outlineB":"后半大纲"}`;

    const text = await this._callWriterLLM('你是小说编辑，擅长章节拆分与拟题。', prompt, { maxTokens: 2000 });
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('拆章命名未返回 JSON，本章未拆分');
    let j = null;
    try { j = JSON.parse(m[0]); } catch { throw new Error(`拆章命名 JSON 解析失败，本章未拆分：${m[0].slice(0, 80)}`); }
    const nameA = String(j.nameA || '').trim();
    const nameB = String(j.nameB || '').trim();
    const outlineA = String(j.outlineA || '').trim();
    const outlineB = String(j.outlineB || '').trim();
    if (!outlineA || !outlineB || !nameB) {
      throw new Error('拆章命名缺必要字段（nameB / outlineA / outlineB 都不能为空），本章未拆分');
    }
    return { nameA: nameA || ch.name || nameB, nameB, outlineA, outlineB };
  }

  /**
   * 把一章拆成前后两章。内容守恒：两半正文就是原文（只删原首行标题、各拼一个新标题），
   * 所以不依赖快照也能合回去。走 addChaptersBulk 而不是手写 SQL：
   * 它是单事务、一次平移，而且归部在平移之后算，新章会自动落进本章所属的部。
   * 拆多份（自由扩展）由调用方循环调本方法、每次拆尾巴实现，本方法只管一刀。
   * @param {Object} [opts]
   * @param {number} [opts.wantA] - 上半目标字数。不传则用 splitTargets（拆两半的按比例分配）；
   *   拆多份时由 overflowParts 算出每份该多少字传进来
   * @param {string} [opts.reasonTag] - 留档理由（区分是字数治理拆的还是生成时自由扩展拆的）
   * @returns {Promise<{nameA:string,nameB:string,lenA:number,lenB:number,before:number,shifted:number,below:Array<string>}>}
   */
  async _splitChapterIntoTwo(no, band, sessionId, { wantA: wantAOverride, reasonTag = '字数治理：拆章前原文' } = {}) {
    const ch = this.db.getChapter(no);
    if (!ch) throw new Error(`第 ${no} 章不存在`);
    const len = String(ch.content || '').length;
    const [wantA] = Number.isFinite(wantAOverride) && wantAOverride > 0
      ? [Math.round(wantAOverride)]
      : splitTargets(len, band);
    const picked = this._pickSplitPoint(ch.content, wantA, band);
    if (!picked) throw new Error('找不到可用拆分点（正文段落不足或未分段）');
    const meta = await this._nameSplitHalves(no, ch, picked, band);

    if (sessionId) {
      progressHub.publish(sessionId, `✂️ 第 ${no} 章 ${len} 字，拆为第 ${no}/${no + 1} 章（${picked.bodyA.length} + ${picked.bodyB.length} 字）...`);
    }
    this.db.saveChapterRevision(no, {
      name: ch.name, content: ch.content,
      reason: `${reasonTag}（${len} 字）`, source: 'wordCountSplit',
    });

    const bodyB = `# 第${no + 1}章：${meta.nameB}\n\n${picked.bodyB}`;
    const ins = this.db.addChaptersBulk(
      [{ name: meta.nameB, outline: meta.outlineB, content: bodyB }],
      { mode: 'after', no },
    );
    const bodyA = `# 第${no}章：${meta.nameA}\n\n${picked.bodyA}`;
    // name/outline/content 必须全量传：upsertChapter 是无条件 UPDATE，漏一个就会被写成 NULL
    this.db.upsertChapter({ no, name: meta.nameA, outline: meta.outlineA, content: bodyA });

    // 切点受段落边界限制，即使已优先选可行切点，仍可能没有“两半都进带”的下刀处。
    // 这种情况必须报出来而不是静默交出去：下一轮 tuneWordCount 会把它当偏短章扩写。
    const below = [];
    if (band.on) {
      if (bodyA.length < band.min) below.push(`第${no}章只有 ${bodyA.length} 字`);
      if (bodyB.length < band.min) below.push(`新第${no + 1}章只有 ${bodyB.length} 字`);
    }

    return {
      nameA: meta.nameA, nameB: meta.nameB,
      lenA: bodyA.length, lenB: bodyB.length, before: len,
      shifted: ins.shiftedCount || 0,
      below,
    };
  }

  /**
   * 自由扩展模式的生成后兜底：把超出合格带的章拆成多章，让交出去的每一章都在带内。
   *
   * 为何不在生成循环里就地拆：拆章会平移后续章号，循环手里的章号会全部失效。
   * 所以调用方一律等正文写完、循环退出后再调本方法。
   *
   * 三步固定顺序，与 tuneWordCount 一致：① 只拆章 → ② 编号定稿后统一校正标题与引用
   * → ③ 才补写偏短的各份。顺序反了会让模型在新编号下写的引用被移两次。
   * @param {string|null} sessionId
   * @param {Object} [opts]
   * @param {Array<number>} [opts.only] - 只处理这些章号（本次刚写的章）。不传则扫全书——
   *   生成时不要不传：那会把存量里早就超长的章一并拆了，超出本次生成的授权范围
   * @returns {Promise<{mode:string,split:Array,expanded:Array,unresolved:Array,shifted:number,headingFixed:number,xrefFixed:number,xrefUnresolved:Array}>}
   */
  async _applyOverflowSplit(sessionId, { only = null } = {}) {
    const db = this.db;
    const band = this._wordBandFor(db.getNovelInfo?.());
    const out = {
      mode: band.overflow, split: [], expanded: [], unresolved: [],
      shifted: 0, headingFixed: 0, xrefFixed: 0, xrefUnresolved: [],
    };
    // trim 与未设限都没东西可拆：trim 在生成当时就地压缩（见 generateChapterWithLLM），章数不变
    if (!band.on || band.overflow !== 'split') return out;

    const maxOldNo = db.getMaxChapterNo?.() ?? 0;
    const rows = db.getAllChapters({ includeContent: false })
      .filter((c) => c.no > 0)
      .filter((c) => !only || only.includes(c.no))
      .filter((c) => (Number(c.contentLength) || 0) > band.max)
      // 降序：拆章把它之后的章号整体后移，升序跑会拿着旧章号读到偏移后的章
      .sort((a, b) => b.no - a.no);
    if (!rows.length) return out;

    if (sessionId) {
      progressHub.publish(sessionId, `✂️ 自由扩展：${rows.length} 章超出合格上限 ${band.max} 字，开始拆章（后续章号会顺延）...`);
    }
    const points = [];
    for (const row of rows) {
      const ch = db.getChapter(row.no);
      if (!ch || !String(ch.content || '').trim()) continue;
      const len = String(ch.content).length;
      const plan = overflowParts(len, band);
      const item = { no: row.no, name: ch.name || '', before: len, plannedParts: plan.parts, lens: [], shifted: 0 };
      let cur = row.no, rest = len, partsLeft = plan.parts, done = 0;
      try {
        while (partsLeft > 1) {
          const r = await this._splitChapterIntoTwo(cur, band, sessionId, {
            wantA: Math.round(rest / partsLeft),
            reasonTag: '自由扩展：拆章前原文',
          });
          item.lens.push(r.lenA);
          rest = r.lenB;
          item.shifted += r.shifted || 0;
          out.shifted += r.shifted || 0;
          done += 1;
          points.push(row.no);
          cur += 1; partsLeft -= 1;
        }
        item.lens.push(rest);
        item.parts = item.lens.length;
        out.split.push(item);
      } catch (e) {
        // 拆到一半失败时结构已经动了，已完成的份数必须报出去，否则②的编号校正会漏掉它
        item.parts = done + 1;
        if (done) item.lens.push(rest);
        item.error = e.message;
        out.unresolved.push(item);
        console.error(`❌ 第 ${row.no} 章自由扩展拆章失败: ${e.message}`);
      }
    }
    if (!points.length) return out;

    // ② 编号定稿：标题行与正文/大纲里的「第X章」引用按新号重算
    const r = this._renumberAfterInserts(points, {
      maxOldNo,
      reasonTag: '自由扩展：生成后拆章平移校正章号',
      source: 'overflowSplitShift',
    });
    out.headingFixed = r.headingFixed;
    out.xrefFixed = r.xrefFixed;
    out.xrefUnresolved = r.xrefUnresolved;

    // ③ 拆出来的各份偏短就补写到合格带（“最终目的必须保证每章字数”）。
    // len 在 max 与 2×min 之间时拆两半必然有一半偏短，这是自由扩展的固有代价
    const toNew = this._insertShiftMap(points);
    const targets = new Set(
      out.split.flatMap((s) => Array.from({ length: s.parts }, (_, i) => toNew(s.no) + i)),
    );
    for (const no of [...targets].sort((a, b) => b - a)) {
      const c = db.getChapter(no);
      if (!c) continue;
      const len = String(c.content || '').length;
      if (len <= 50 || len >= band.min) continue;
      try {
        const expanded = await this._expandChapterToTarget(c.content, no, band, sessionId, { strict: true });
        if (expanded === c.content) {
          out.unresolved.push({ no, before: len, reason: `拆出的章只有 ${len} 字且补写未采信（无增益或未守住「只加不改」），保留原稿` });
          continue;
        }
        db.saveChapterRevision(no, { name: c.name, content: c.content, reason: `自由扩展：拆章后补写前（${len} 字）`, source: 'overflowSplitExpand' });
        // 全量传：upsertChapter 是无条件 UPDATE，漏传 outline 就会把它写成 NULL
        db.upsertChapter({ no, name: c.name, outline: c.outline, content: expanded });
        out.expanded.push({ no, before: len, after: expanded.length });
      } catch (e) {
        out.unresolved.push({ no, before: len, reason: `拆出的章偏短且补写失败：${e.message}` });
      }
    }
    return out;
  }

  /**
   * 本章写完但短于合格下限时做一次全文扩写。
   * 与 _continueChapterContent 的区别：那里是“被 maxTokens 切断”，接着写就行；
   * 这里是“自己收尾了”，已到一个自然完结点，接不下去，只能把已有场景写厚。
   * 安全边界：返回空（_callWriterLLM 会抛）或比原文还短（模型把任务理解成了摘要）
   * 一律保留原稿——宁可少字，也不能为了凑数把已有情节换没。
   */
  async _expandChapterToTarget(content, chapterNo, band, sessionId, { strict = false } = {}) {
    if (content.length >= band.min) return content;
    const need = Math.max(0, band.target - content.length);
    if (sessionId) {
      progressHub.publish(sessionId, `📏 第 ${chapterNo} 章 ${content.length} 字，少于下限 ${band.min}，正在扩写（约需补 ${need} 字）...`);
    }
    const opts = {
      maxTokens: Math.min(16384, Math.max(8192, Math.ceil(band.target * 2.5))),
      timeout: this._chapterCallMs(band.target),
    };
    const SYS = '你是一位专业的小说作家，擅长在不改动既有情节的前提下补出新场面。';
    const call = async (feedback) => {
      const out = await this._callWriterLLM(SYS, this._expandPrompt(chapterNo, content, band, need, feedback), opts);
      return this.normalizeChapterHeading(String(out).trim(), chapterNo);
    };

    let normalized = await call(null);
    if (normalized.length <= content.length) {
      // 「不比原文长」有两种完全不同的原因：模型老实扩写但没超原文（少见），或它压根答了另一个问题。
      // 实测过两种退化：局域网那台 llama-server 连续回一段 SD 标签 JSON（362 字），
      // 以及逐字回放上一条请求的 98 字答案。混成一行「扩写无增益」会把推理服务故障
      // 说成内容问题，让人去改提示词而不是查服务，所以短到异常量级时单独报。
      const junk = normalized.length < content.length * 0.6;
      if (junk && strict) {
        throw new Error(`模型返回异常（${content.length} 字的任务只回 ${normalized.length} 字，且对不上原章），疑为推理服务失能或上下文被其它客户端占用`);
      }
      console.log(`⚠️ 第${chapterNo}章扩写后 ${normalized.length} 字并不比原文长${junk ? '（返回量异常偏小，疑为推理服务退化）' : ''}，保留原稿`);
      if (sessionId) progressHub.publish(sessionId, junk
        ? `⚠️ 第 ${chapterNo} 章模型返回异常（仅 ${normalized.length} 字），已保留原稿，建议检查推理服务`
        : `⚠️ 第 ${chapterNo} 章扩写无增益，保留原稿`);
      return content;
    }
    let st = this._expansionStructure(content, normalized);
    if (st.broken || st.weak) {
      // 把测到的数字连原句一起回喂再要一次：光在提示词里写「只加不改」压不住省力路径
      // （实测模型把它读成「情节不用动」，于是把句子逐句拉长重写），带具体比例的反馈才有效。
      // 两次是本动作的成本上限，不做第三次。
      if (sessionId) {
        progressHub.publish(sessionId, st.broken
          ? `⚠️ 第 ${chapterNo} 章有 ${st.lostChars} 个原文字符没按原序保留、${st.fragLost} 句原话被就地改写，重试一次...`
          : `⚠️ 第 ${chapterNo} 章新增字数仅 ${Math.round(st.fillShare * 100)}% 落在新段落、台词承载 ${Math.round(st.speechShare * 100)}%，重试一次...`);
      }
      const retry = await call(st);
      if (retry.length > content.length) {
        const rs = this._expansionStructure(content, retry);
        const score = (x) => (x.broken ? -1 : 0) + x.fillShare + x.speechShare;
        if (score(rs) > score(st)) { normalized = retry; st = rs; }
      }
    }
    if (st.broken) {
      // 兜底：两次都没守住「只加不改」就整章放弃。这是本方法最要紧的分支——
      // 字数不达标只是这一章还短，作者原稿被覆盖却是不可逆的内容损失。
      console.log(`⛔ 第${chapterNo}章两次扩写均未守住「只加不改」（内容保留 ${(st.keptRatio * 100).toFixed(1)}%，丢 ${st.lostChars} 字 / ${st.fragLost} 句被改写），保留原稿`);
      if (sessionId) progressHub.publish(sessionId, `⛔ 第 ${chapterNo} 章扩写会改动原稿，已放弃并保留原文`);
      return content;
    }
    console.log(`✅ 第${chapterNo}章扩写完成：${content.length} → ${normalized.length} 字｜内容保留 ${(st.keptRatio * 100).toFixed(1)}%（原稿一字未动）· 新插 ${st.newParas} 段（承载 ${Math.round(st.fillShare * 100)}%）· 台词承载 ${Math.round(st.speechShare * 100)}%${st.weak ? ' ⚠️ 增量偏叙述、少对话' : ''}`);
    return normalized;
  }

  /**
   * 扩写指令。
   * 约束 1 的措辞是被实测纠正过的：原来写的是「所有已有情节、事件顺序…必须原样保留」，
   * 模型把它读成「情节不用动」，于是把每一句就地拉长重写（「沾满了灰尘」→「沾满了灰尘与
   * 黑色的逻辑残渣」），那已经不是灌水而是覆盖作者原稿。所以这里明说“逐句核对、改一个字就判不合格”，
   * 并把实际被改掉的句子回喂回去——只说“不许改”没有着力点，点名原句才能让它对着改。
   */
  _expandPrompt(chapterNo, content, band, need, prev) {
    const beats = Math.min(6, Math.max(2, Math.ceil(need / 400)));
    let feedback = '';
    if (prev) {
      const lines = [`上一版扩到约 ${prev.newLen} 字，但程序逐句核对后判为不合格。`];
      if (prev.broken) {
        lines.push(`· 违反约束 1：程序逐字核对后有 ${prev.lostChars} 个原文字符没能按原序出现在结果里（存活率仅 ${Math.round(prev.fidelity * 100)}%），被改掉/删掉的句子如：`);
        (prev.lost || []).forEach((t) => lines.push(`    「${t}」`));
        lines.push('  这些句子必须一字不差地出现在结果里，只能在它们前后插入新内容。');
      } else {
        lines.push(`· 违反约束 2：新增字数里只有 ${Math.round(prev.fillShare * 100)}% 落在新写的段落上，落在台词里的只有 ${Math.round(prev.speechShare * 100)}%——等于给原文每段各加一两句修饰，情节没有推进。`);
      }
      feedback = String.fromCharCode(10) + '## 上一版为什么不合格' + String.fromCharCode(10) + lines.join(String.fromCharCode(10)) + String.fromCharCode(10) + '这次请严格按下面的约束重做。' + String.fromCharCode(10);
    }
    return `下面是一章小说的完整正文，它太短了（当前 ${content.length} 字，本书每章目标 ${band.target} 字，不得少于 ${band.min} 字）。需要补约 ${need} 字。
${feedback}
## 硬约束
1. 🔴 只加不改，程序会逐句核对：原文的**每一个句子**都要一字不差、原样完整地出现在结果里。不得改写、不得加长、不得换词、不得调序、不得删掉。唯一允许的动作是在句与句、段与段之间**插入**新内容。
2. 补的字必须是新写的句子与新段落，而且要有内容：新增字数的至少六成落在新插入的段落上；至少补出 ${beats} 组新的对话往来（一个人说、另一个人回应，各成一段）。
3. ❌ 禁止的凑法：插入纯修饰性的环境或心理描写（例如「空气中弥漫着某种气息」「显得狼狈至极」「心中涌起一股说不清的感觉」）；复述刚写过的动作或心理；插入与本章无关的回忆或设定解说；新增主要角色；新增转折。
4. 结尾仍落在原结尾的位置：原结尾那几句同样一字不改，可以在它前面插入新内容，不要另起一个新结尾接着往下写。
5. 直接返回扩写后的完整章节（Markdown，首行为 # 第${chapterNo}章：标题），不要任何解释说明。

## 原章节正文
${content}

请返回扩写后的完整章节：`;
  }

  /**
   * 原稿字符保序保留数（内容级「只加不改」的唯一硬口径）。
   *
   * 为什么不用句键下结论：句键会在引号内的标点处切断（实测把「小愈摇头：“弟子以为…」切成一句），
   * 而模型几乎总会把 ‘道’ 改成 “道”、把 Markdown 星号位置动一下——那类变动不是丢内容，
   * 却会把存活率拖到 96%～99%；反过来，真被删掉整句（「面对愤怒的民众…竟显得局促不安。」）
   * 在 0.95 阈值下又能漏过去。所以先剔除标点/空白/Markdown 记号，只留汉字与字母数字，
   * 再求最长公共子序列：纯插入时结果恰等于原稿长度，删一句、改一个词、调序都会立刻掉下来。
   * 先掉公共首尾再把 DP 压到真正有差异的窗口（整章 3000 字全量 DP 要近千万格）。
   * 另有片段审查（_fragmentAudit）补住 LCS 看不到的「句内塞字」。
   * @returns {{kept:number,total:number,ratio:number,fragTotal:number,fragLost:number,lostFrags:string[]}}
   *          ratio=1 且 fragLost=0 才是原稿一字未动
   */
  _contentPreservation(oldText, newText) {
    // 标题行不参与核对：首行是 normalizeChapterHeading 按当前章号重写的，不是模型保真度的对象。
    // 漏了这一条会构成一个隐蔽的死锁：拆章把下游章号整体后移，但那些章正文里的旧章号没人负
    // 责改（发布时按位置重建），于是原稿片段“第10章”必然在新稿里消失（已被修正为第14章）——
    // 实测第 14 章因此被拦：内容保留 99.95%，丢的那 1 个字就是标题里的旧章号。
    const unh1 = (s) => String(s || '').replace(/^\s*#\s*第\s*[0-9一二三四五六七八九十百零两]*\s*章[^\n]*\n?/, '');
    const oldBody = unh1(oldText), newBody = unh1(newText);
    const strip = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
    const a = strip(oldBody), b = strip(newBody);
    if (!a.length) return { kept: 0, total: 0, ratio: 1 };
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let eA = a.length, eB = b.length;
    while (eA > s && eB > s && a[eA - 1] === b[eB - 1]) { eA--; eB--; }
    const mid = a.slice(s, eA), win = b.slice(s, eB);
    let lcs = s + (a.length - eA);          // 公共首尾已保证按序命中
    if (mid.length && win.length) {
      let prev = new Int32Array(win.length + 1);
      let cur = new Int32Array(win.length + 1);
      for (let i = 1; i <= mid.length; i++) {
        for (let j = 1; j <= win.length; j++) {
          cur[j] = mid[i - 1] === win[j - 1]
            ? prev[j - 1] + 1
            : (prev[j] >= cur[j - 1] ? prev[j] : cur[j - 1]);
        }
        const t = prev; prev = cur; cur = t;
        cur.fill(0);
      }
      lcs += prev[win.length];
    }
    return { kept: lcs, total: a.length, ratio: lcs / a.length, ...this._fragmentAudit(oldBody, b) };
  }

  /**
   * 原句连续命中审查（与字符子序列互补，两条缺一个都会漏）。
   *
   * 为什么光有 LCS 不够：自检样本「他推开门」→「他缓缓推开了那扇沉重的木门」在字符粒度上
   * 就是纯插入（18/18 全命中），但作者那一句已被就地拉长重写——那正是上次事故的主力形态。
   * 片段切分直接用「任意标点当分隔符」而不是整句：上一版按。！切，粒度是一个完整句子，
   * 于是「他推开门，【插一句】屋里没有人」这种句内逗号处的正常插入也被拦了（自检实测）。  
   * 切成标点级片段后：就地塞字仍不连续命中（拦），句内插入整句则两边片段仍连续（放行）。
   * 已知边界：片段取 ≥4 字，太短的片段在哪都能撞上，没有证据价值。
   */
  _fragmentAudit(oldText, strippedNew) {
    const runs = (s) => String(s || '').replace(/[^\u4e00-\u9fa5A-Za-z0-9]+/g, '\u0000').split('\u0000').filter((x) => x.length >= 4);
    const frags = [...new Set(runs(oldText))];
    const lost = frags.filter((f) => !strippedNew.includes(f));
    return { fragTotal: frags.length, fragLost: lost.length, lostFrags: lost.slice(0, 3) };
  }

  /**
   * 扩写结果的机械核对，三条独立指标。
   *
   * 为什么长成这样：第一版这里只有一个「新增段承载率」，拿《兔子你不行》20 章实测却把
   * 灌水的扩写判成 100% 合格。原因是模型改写了原句，原句在结果里找不到，逐句重合度归零，
   * 被改写的段反而被当成「新写的段」。所以顺序不能反：**先核原稿是否一字未动**，
   * 「只加不改」成立之后，新段与台词的占比才可信。
   * @returns {{added:number,newLen:number,fidelity:number,lostCount:number,lost:string[],
   *            newParas:number,fillShare:number,speechShare:number,keptRatio:number,broken:boolean,weak:boolean}}
   */
  _expansionStructure(oldText, newText) {
    // 段落切分只剔除章标题行与空壳行，**不能按长度阈值过滤**：小说里「“你疯了？”」这种短台词行
    // 很常见，把它们从分子里去掉而分母仍算全量新增字数，会把合格稿误判成灌水（自检样本二实测偏到 49%）。
    const cut = (s) => String(s || '').split(/\n+/).map((x) => x.trim()).filter((x) => x.length >= 2 && !x.startsWith('#'));
    const flat = (s) => String(s || '').replace(/\s+/g, '');
    // 段内去重：同一段里重复出现的句子只算一次，免得整段复读刷高各项比例
    const sentKeys = (p) => new Set(splitSentences(p).map((x) => normKey(x.text)).filter(Boolean));
    const speechChars = (s) => (String(s || '').match(/[“][^”]{2,}[”]/g) || []).reduce((n, x) => n + flat(x).length, 0);

    const oldParas = cut(oldText), newParas = cut(newText);
    const newUnion = new Set();
    const newSets = newParas.map((p) => { const s = sentKeys(p); s.forEach((k) => newUnion.add(k)); return s; });

    // ① 原句存活率：结果里还能一字不差找到的原句占多少（唯一能守住“没动原稿”的指标）
    let total = 0, kept = 0;
    const lost = [];
    for (const p of oldParas) {
      const seen = new Set();
      for (const st of splitSentences(p)) {
        const k = normKey(st.text);
        if (!k || seen.has(k)) continue;
        seen.add(k); total++;
        if (newUnion.has(k)) kept++;
        else if (lost.length < 3) lost.push(String(st.text).trim().slice(0, 40));
      }
    }
    const fidelity = total ? kept / total : 1;              // 诊断用（点名原句靠它）
    // 硬闸：原稿字符保序保留率（剔标点后求 LCS），纯插入时必等于 1
    const cp = this._contentPreservation(oldText, newText);

    // ② 新插段落承载率：覆盖不到任何原段六成句子的段，才算「新写的段」
    const oldSets = oldParas.map(sentKeys);
    let newParaChars = 0, newParaCount = 0;
    newParas.forEach((p, i) => {
      const ns = newSets[i];
      let best = 0;
      for (const os of oldSets) {
        if (!os.size) continue;
        let hit = 0;
        ns.forEach((k) => { if (os.has(k)) hit++; });
        if (hit / os.size > best) best = hit / os.size;
      }
      if (best < 0.6) { newParaChars += flat(p).length; newParaCount++; }
    });

    const added = flat(newText).length - flat(oldText).length;
    const fillShare = added > 0 ? Math.min(1, newParaChars / added) : 1;
    // ③ 台词承载率：新增字数里有多少在引号内。灌水几乎只加叙述，真加场面必然带来新的对答
    const speechShare = added > 0 ? Math.min(1, Math.max(0, speechChars(newText) - speechChars(oldText)) / added) : 1;
    const broken = cp.ratio < 1 || cp.fragLost > 0;   // 删了/改了/调序，或在原句里塞字拉长，都是硬伤，整章放弃
    return {
      added, newLen: flat(newText).length, fidelity, lostCount: total - kept, lost,
      newParas: newParaCount, fillShare, speechShare, broken,
      keptRatio: cp.ratio, keptChars: cp.kept, lostChars: cp.total - cp.kept, fragLost: cp.fragLost, lostFrags: cp.lostFrags,
      // 两条都低才判弱：新段承载率低但台词明显变多，说明是在原段里补往来回合，可接受
      weak: !broken && fillShare < 0.35 && speechShare < 0.15,
    };
  }

  /**
   * 超出合格上限时压缩到目标。两条“宁可不改”的保护：
   * 没压下来（≥ 原文）或压过头掉到下限以下（丢情节风险最高的一种）都直接保留原稿。
   */
  async _compressChapterToTarget(content, chapterNo, band, sessionId) {
    if (sessionId) {
      progressHub.publish(sessionId, `📏 第 ${chapterNo} 章 ${content.length} 字，超出上限 ${band.max}，正在压缩到 ${band.target} 字...`);
    }
    const prompt = (extra) => `下面是一章小说的完整正文，它超出了本书的篇幅约定（当前 ${content.length} 字，目标 ${band.target} 字，不得多于 ${band.max} 字）。请把它压缩到 ${band.target} 字左右。

## 硬约束
1. 🔴 情节骨架不得丢失：本章发生的事件、事件顺序、结尾落点全部保留，人物姓名与称谓一字不差
2. 只能删：冗余的环境描写、重复的心理活动、不推进情节的支线对话、同义反复的修饰
3. 不要写成剧情概要：保留场景、对话与叙述的写法，只是写得更紧
4. 直接返回压缩后的完整章节（Markdown，首行为 # 第${chapterNo}章：标题），不要任何解释${extra ? `\n${extra}` : ''}

## 原章节正文
${content}

请返回压缩后的完整章节：`;
    const call = async (extra) => {
      const out = await this._callWriterLLM('你是一位小说编辑，擅长在不丢情节的前提下压缩篇幅。', prompt(extra), {
        maxTokens: Math.min(16384, Math.max(8192, Math.ceil(band.target * 2.5))),
        timeout: this._chapterCallMs(band.target),
      });
      return this.normalizeChapterHeading(String(out).trim(), chapterNo);
    };
    let normalized = await call(null);
    // 压过头有两档：低于下限（肯定不能用）与虽在带内但明显偏离目标。两档都应当先给一句
    // 回喂再决定放弃，顺序必须在硬守卫之前：实测一章 3775 字第一次只回 2252 字，若在
    // 硬守卫处直接 return，这章就永远留在带外了。而“压到 2400 附近就算成功”也不对：
    // 3732→2402 是把活干成了砍 36%，目标 3000 只需砍 20%，多丢的内容没人授权过。
    const softFloor = Math.round(band.target * 0.85);
    const tooShort = (n) => n.length < band.min || n.length < softFloor;
    if (band.on && tooShort(normalized) && normalized.length < content.length) {
      if (sessionId) progressHub.publish(sessionId, `📏 第 ${chapterNo} 章压到 ${normalized.length} 字，低于目标 ${band.target}，正在要求少删一些重来...`);
      const again = await call(`5. ⚠️ 上一次压到了 ${normalized.length} 字，删得太狠。本次不得少于 ${softFloor} 字：把被整段删掉的场景与对话补回来，宁可保留细节也不要压到下限。`);
      // 两次都偏短就用更接近目标（也就是丢得更少）的那次，能不能用交给下面的硬守卫判
      if (again.length < content.length && Math.abs(again.length - band.target) < Math.abs(normalized.length - band.target)) {
        normalized = again;
      }
    }
    if (normalized.length >= content.length || normalized.length < band.min) {
      console.log(`⚠️ 第${chapterNo}章压缩后 ${normalized.length} 字（原文 ${content.length}，合格下限 ${band.min}），保留原稿`);
      if (sessionId) progressHub.publish(sessionId, `⚠️ 第 ${chapterNo} 章压缩结果不合适，保留原稿`);
      return content;
    }
    console.log(`✅ 第${chapterNo}章压缩完成：${content.length} → ${normalized.length} 字`);
    return normalized;
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
    // _deferStructureChange：本循环升序跑，插章/拆章都会平移后续章号，让 pendingOutlines 手里的
    // 章号全部失效。所以循环期间禁止 generateChapter 就地改书结构（多出的大纲合并写成本章），
    // 统一等循环退出后由 _applyOverflowSplit 拆章。finally 里复位：同一个工具实例还会被复用。
    const results = [];
    this._deferStructureChange = true;
    try {
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
    } finally {
      this._deferStructureChange = false;
    }

    // 自由扩展的生成后兜底：只拆本次刚写的章。
    // 不传 only 会扫全书，把存量里早就超长的章一并拆了——那超出本次生成的授权范围。
    // 必须在返回前做完：executeChapterOperation 返回后紧接着就是 _autoPublishIfNeeded，
    // 发布拿到定稿结构才不会把平移前的章号发出去。
    const writtenNos = results.filter((r) => r.success && r.chapter).map((r) => r.chapter);
    const overflow = await this._applyOverflowSplit(sessionId, { only: writtenNos });

    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;

    const doneNote = existingChapters.length > 0
      ? `\n\n🛡️ 另有 ${existingChapters.length} 章已有正文、本次已跳过未覆盖：` +
        `${existingChapters.map(c => `第${c.no}章`).join('、')}。` +
        `如需覆盖重写，需用户同意后携带 force: true 调用 generate（不带 chapter，系统会弹确认卡片二次把关）；` +
        `当前大纲已全部有正文，任务已完成，禁止再次发起批量生成。`
      : '';

    // 拆章把书结构改了，报告必须说清「章号已平移、已发布页面需重新发布」，
    // 否则调用方拿着 results 里的旧章号去发布，站点与库就对不上。
    const splitNote = overflow.split.length
      ? `\n\n✂️ 自由扩展：${overflow.split.length} 章超长已拆成多章` +
        `${overflow.shifted ? `，共平移 ${overflow.shifted} 处章号` : ''}` +
        `${overflow.expanded.length ? `，其中 ${overflow.expanded.length} 份偏短已自动补写` : ''}` +
        `${overflow.unresolved.length ? `；${overflow.unresolved.length} 处未能处理（见 unresolved）` : ''}。` +
        `results 里的章号是拆章前的，已发布页面需重新发布。`
      : '';

    return {
      success: failCount === 0,
      action: 'generateAll',
      totalChapters,
      successCount,
      failCount,
      skippedExisting: existingChapters.length > 0 ? existingChapters : undefined,
      overflowMode: overflow.mode,
      overflow: overflow.split.length || overflow.expanded.length || overflow.unresolved.length ? overflow : undefined,
      results,
      report: `批量生成完成：本次新写 ${successCount} 章，失败 ${failCount} 章。${doneNote}${splitNote}`
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
          // 单章生成没有批量循环，就地拆章是安全的；但仍必须在本方法返回前做完，
          // 因为 _autoPublishIfNeeded 就在 executeChapterOperation 返回之后调，
          // 拆章后发布才不会把平移前的章号发出去。only 只传本章：不传会连带拆
          // 存量里早就超长的章，超出本次生成的授权范围。
          if (result?.success && this.chapter) {
            const ov = await this._applyOverflowSplit(this.context?.sessionId || null, { only: [this.chapter] });
            if (ov.split.length || ov.expanded.length || ov.unresolved.length) {
              result.overflowMode = ov.mode;
              result.overflow = ov;
              // lengthNote 说的是拆章前那一整章的长度，拆完已经不成立，另给一句定稿口径
              result.overflowNote = `第 ${this.chapter} 章超出合格上限，已按「自由扩展」拆成 ${ov.split[0]?.parts || 0} 章` +
                `${ov.shifted ? `（后续章号已顺延，已发布页面需重新发布）` : ''}` +
                `${ov.unresolved.length ? `；${ov.unresolved.length} 处未能处理，见 overflow.unresolved` : ''}`;
            }
          }
          break;

        case 'add':
          result = await this.addChapter();
          // add 内部走的就是 generateChapter（先平移再写本章），同样会产出正文；
          // 不接上这一步，“新增一章”就成了绕开字数保证的后门。only 只传本章。
          if (result?.success && this.chapter) {
            const ov = await this._applyOverflowSplit(this.context?.sessionId || null, { only: [this.chapter] });
            if (ov.split.length || ov.expanded.length || ov.unresolved.length) {
              result.overflowMode = ov.mode;
              result.overflow = ov;
              result.overflowNote = `第 ${this.chapter} 章超出合格上限，已按「自由扩展」拆成 ${ov.split[0]?.parts || 0} 章` +
                `${ov.unresolved.length ? `；${ov.unresolved.length} 处未能处理，见 overflow.unresolved` : ''}`;
            }
          }
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
