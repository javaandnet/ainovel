/**
 * ainovel API 路由
 *
 * 设计：绝大多数小说操作直接复用移植过来的 WriterTool（execute 走原有全部 action），
 * 只把 galaclaw 的多 Agent/CLI/SSH 外壳换成 HTTP。菜单按钮 → POST /api/run；
 * AI 窗口 → /api/ai/plan（单轮，LLM 选工具+参数）→ 前端确认卡 → /api/ai/execute。
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WriterTool } from './tools/common/writerTool.js';
import { createWriterDB } from './database/writer.js';
import { llm } from './agent/llm.js';
import { MENU_ACTIONS, AI_TOOLS } from './tools/registry.js';
import { publishNovelLocal, publishSiteIndexLocal } from './skills/novelPublisher/publish.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');           // ainovel 项目根
const DATA_DIR = path.join(ROOT, 'data');
const OUT_ROOT = path.join(ROOT, 'public', 'novel');  // 本地发布产物根

// writerTool 允许的 action 白名单（与 execute 分派一致）
const ALLOWED_ACTIONS = new Set([
  'generate', 'gen', 'g', 'add', 'modify', 'mod', 'm', 'delete', 'del', 'd',
  'getNovelInfo', 'listNovels', 'getPublishConfig', 'setPublishConfig',
  'saveNovelPlan', 'generateChapterOutlines', 'addChapterOutline', 'updateChapterOutline',
  'reNumberChapters', 'updateNovelPlan', 'generatePreface', 'savePreface',
  'setParts', 'generatePartIntros', 'listParts'
]);
// 需要库已存在的只读/编辑动作（其余为可创建库的动作）
const CREATE_ACTIONS = new Set(['saveNovelPlan', 'savePreface', 'add', 'setPublishConfig']);
// 泛化描述词黑名单（与 writerTool 口径一致，防 LLM 把描述词当真实库名）
const GENERIC_DESCRIBING_NAME_RE = /^(目标小说|目标|目标库|目标文件|目标书|示例|示例小说|小说名|例子|某小说|待确定|待定|xxx+)\.db$/i;

/** 构造注入了上下文的 WriterTool 实例 */
function makeTool(extraCtx = {}) {
  const tool = new WriterTool({ workspace: ROOT });
  tool.context = {
    model: process.env.NOVEL_LLM_MODEL || null,
    temperature: Number(process.env.NOVEL_LLM_TEMPERATURE ?? 0.7),
    maxTokens: Number(process.env.NOVEL_LLM_MAX_TOKENS ?? 16384),
    agentName: 'writer',
    ...extraCtx,
  };
  return tool;
}

/**
 * 校验并解析小说库文件名（来自 :file 或 dbPath）。
 * - 只接受纯 basename（无路径分隔符 / ..），拒绝穿越
 * - 必须以 .db 结尾且不在泛化词黑名单
 * - requireExisting=true 时库必须存在于 data/
 * @returns {{ok:boolean, file?:string, absPath?:string, error?:string}}
 */
function resolveNovelFile(input, { requireExisting = true } = {}) {
  let name = String(input || '').trim();
  if (!name) return { ok: false, error: '缺少小说库文件名 (dbPath)' };
  if (/[\\/]|\.\./.test(name)) return { ok: false, error: '非法文件名（禁止路径分隔符）' };
  if (!name.endsWith('.db')) name += '.db';
  if (GENERIC_DESCRIBING_NAME_RE.test(name)) {
    return { ok: false, error: `"${name}" 看起来是描述词而非真实小说库名，请从小说列表中选择一个` };
  }
  const absPath = path.join(DATA_DIR, name);
  // 边界：确保落在 DATA_DIR 内
  if (!absPath.startsWith(DATA_DIR + path.sep)) return { ok: false, error: '非法路径' };
  if (requireExisting && !fs.existsSync(absPath)) {
    return { ok: false, error: `小说库不存在：${name}（data/ 下无此文件）` };
  }
  return { ok: true, file: name, absPath };
}

/** 列出 data/ 下小说库（结构化） */
async function listNovels() {
  const tool = makeTool();
  const novels = await tool.listNovelDatabases();
  return novels;
}

/** 注册路由 */
export function registerRoutes(app) {
  // ── 元数据 ──
  app.get('/api/menu', (_req, res) => res.json({ groups: MENU_ACTIONS }));
  app.get('/api/tools', (_req, res) => res.json({ tools: AI_TOOLS }));
  app.get('/api/novels', async (_req, res) => {
    try { res.json({ novels: await listNovels() }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 章节结构化列表（供 UI 展示）──
  app.get('/api/novels/:file/chapters', (req, res) => {
    const r = resolveNovelFile(req.params.file, { requireExisting: true });
    if (!r.ok) return res.status(400).json({ error: r.error });
    let db;
    try {
      db = createWriterDB(r.absPath);
      const info = db.getNovelInfo();
      const chapters = db.getAllChapters({ includeContent: false })
        .filter(c => c.no > 0)
        .map(c => ({ no: c.no, name: c.name, outline: c.outline, hasContent: !!(c.content && String(c.content).trim()), partNo: c.part_no || 0, id: c.id }));
      res.json({ novel: info?.name || r.file, dbPath: r.file, chapters });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 单章正文（供查看/编辑）
  app.get('/api/novels/:file/chapter/:no', (req, res) => {
    const r = resolveNovelFile(req.params.file, { requireExisting: true });
    if (!r.ok) return res.status(400).json({ error: r.error });
    const no = Number(req.params.no);
    let db;
    try {
      db = createWriterDB(r.absPath);
      const ch = db.getAllChapters({ includeContent: true }).find(c => c.no === no);
      if (!ch) return res.status(404).json({ error: `第 ${no} 章不存在` });
      res.json({ dbPath: r.file, chapter: { no: ch.no, name: ch.name, outline: ch.outline, content: ch.content } });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // ── 通用动作执行（复用 WriterTool 全部 action）──
  // body: { action, dbPath?, chapter?, totalChapters?, force?, info?, parts?, preface?, partNo?, modifyInstructions?, modificationType? }
  app.post('/api/run', async (req, res) => {
    const body = req.body || {};
    const action = body.action;
    if (!ALLOWED_ACTIONS.has(action)) {
      return res.status(400).json({ error: `不支持的 action: ${action}` });
    }
    const requireExisting = !CREATE_ACTIONS.has(action);
    const r = resolveNovelFile(body.dbPath, { requireExisting });
    if (!r.ok) return res.status(400).json({ error: r.error });

    const tool = makeTool();
    try {
      const result = await tool.execute({ ...body, dbPath: r.file });
      res.json({ success: true, action, dbPath: r.file, result });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── 一致性检查（复用 writerTool._runPostWriteCheck）──
  app.post('/api/novels/:file/check', async (req, res) => {
    const r = resolveNovelFile(req.params.file, { requireExisting: true });
    if (!r.ok) return res.status(400).json({ error: r.error });
    const withBody = req.body?.withBody === true; // 是否跑 L2/L3（正文比对，较慢）
    const tool = makeTool();
    let db;
    try {
      db = createWriterDB(r.absPath);
      tool.db = db;
      const report = await tool._runPostWriteCheck({ fullBook: true, withBody });
      res.json({ success: true, dbPath: r.file, report });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // ── 本地发布（生成静态页到 public/novel/）──
  app.post('/api/novels/:file/publish', async (req, res) => {
    const r = resolveNovelFile(req.params.file, { requireExisting: true });
    if (!r.ok) return res.status(400).json({ error: r.error });
    try {
      const out = await publishNovelLocal(r.absPath, OUT_ROOT, { title: req.body?.title });
      // 顺带刷新站点首页
      try {
        const novels = await listNovels();
        // dirName 需与发布时 sanitizeDirName 一致：从 out.novelDir 取
        const items = [];
        if (fs.existsSync(OUT_ROOT)) {
          for (const d of fs.readdirSync(OUT_ROOT)) {
            const idx = path.join(OUT_ROOT, d, 'index.html');
            if (fs.existsSync(idx)) {
              const nn = novels.find(n => (n.name && sanitizeToDir(n.name)) === d);
              items.push({ dirName: d, title: nn?.name || d, chapterCount: nn?.chapterCount });
            }
          }
        }
        publishSiteIndexLocal(items, OUT_ROOT);
      } catch { /* 站点首页刷新失败不影响单本发布 */ }
      res.json({ success: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── AI 窗口：单轮意图解析（不执行，仅返回拟调用工具+参数）──
  app.post('/api/ai/plan', async (req, res) => {
    const userInput = String(req.body?.userInput || '').trim();
    const novelFile = req.body?.novelFile || null;
    if (!userInput) return res.status(400).json({ error: '缺少 userInput' });
    try {
      const novels = await listNovels().catch(() => []);
      const novelNames = novels.map(n => n.file);
      const system = [
        '你是小说平台的命令解析器。根据用户的一句话，从下面的工具清单中选出最合适的一个工具，并填好参数。',
        '只输出一个 JSON 对象，形如 {"tool":"工具名","args":{...},"reason":"一句话说明"}。不要输出多余文字、不要代码块围栏。',
        '若无法对应任何工具，输出 {"tool":null,"args":{},"reason":"无法识别的指令"}。',
        'dbPath 必须是下面"现有小说库"之一的文件名原文；用户没指明且为单本操作时，若上下文只有一个库则用它，否则在 reason 里说明需要选择。',
        `现有小说库: ${JSON.stringify(novelNames)}`,
        `当前选中的库: ${novelFile || '(未选)'}`,
        `工具清单: ${JSON.stringify(AI_TOOLS)}`,
      ].join('\n');
      const resp = await llm.chat({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: userInput },
        ],
        temperature: 0.2,
      });
      const parsed = parseJsonObject(resp.content);
      if (!parsed || typeof parsed.tool === 'undefined') {
        return res.status(502).json({ error: 'AI 未返回可解析的工具选择', raw: resp.content });
      }
      res.json({ ok: true, tool: parsed.tool, args: parsed.args || {}, reason: parsed.reason || '' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── AI 窗口：确认后执行（把 AI 工具名映射回 writerTool action / 专用端点）──
  app.post('/api/ai/execute', async (req, res) => {
    const { tool, args = {} } = req.body || {};
    if (!tool) return res.status(400).json({ error: '缺少 tool' });
    try {
      const r = await runAiTool(tool, args);
      res.json({ success: true, tool, result: r });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

/** 把 AI 工具名映射到 WriterTool action / 专用逻辑并执行 */
async function runAiTool(name, args) {
  const requireExisting = name !== 'listNovels';
  const r = resolveNovelFile(args.dbPath, { requireExisting });
  if (!r.ok) throw new Error(r.error);
  const dbFile = r.file;

  const run = async (action, extra = {}) => {
    const tool = makeTool();
    return tool.execute({ action, dbPath: dbFile, ...extra });
  };

  switch (name) {
    case 'listNovels': return { novels: await listNovels() };
    case 'getNovelInfo': return await run('getNovelInfo');
    case 'deleteChapter': {
      if (!args.chapter) throw new Error('deleteChapter 需要 chapter 章号');
      const out = await run('delete', { chapter: Number(args.chapter) });
      return out;
    }
    case 'addChapter': return await run('add', { info: { name: args.name, content: args.content } });
    case 'generateChapter': return await run('generate', { chapter: Number(args.chapter || 0), force: !!args.force });
    case 'modifyChapter': {
      if (!args.modifyInstructions) throw new Error('modifyChapter 需要 modifyInstructions');
      return await run('modify', { chapter: Number(args.chapter), modifyInstructions: args.modifyInstructions });
    }
    case 'generateOutlines': return await run('generateChapterOutlines', { totalChapters: Number(args.totalChapters || 10) });
    case 'publishNovel': return await publishNovelLocal(r.absPath, OUT_ROOT);
    case 'checkConsistency': {
      const tool = makeTool();
      const db = createWriterDB(r.absPath);
      try { tool.db = db; return await tool._runPostWriteCheck({ fullBook: true, withBody: false }); }
      finally { try { db.close?.(); } catch {} }
    }
    default: throw new Error(`未知工具: ${name}`);
  }
}

/** 与 publish.js 中 sanitizeDirName 同口径的目录名（用于站点首页匹配，简化版） */
function sanitizeToDir(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'novel';
}

/** 从 LLM 文本里容错抽取第一个 JSON 对象 */
function parseJsonObject(text) {
  if (!text) return null;
  const t = String(text).trim();
  // 去掉 ```json 围栏
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  try { return JSON.parse(body); } catch {}
  const m = body.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
