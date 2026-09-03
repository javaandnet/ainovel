/**
 * ainovel API 路由（多用户版）
 *
 * 鉴权与租户隔离：
 *  - global.db 的 user 表为账号权威；novel 表映射 user_id -> 小说 -> db_file。
 *  - 除 /api/login|logout|me 外全部 /api 需有效会话（requireAuth）。
 *  - 小说一律以 global.db 的 novel.id 定位，真实文件名仅服务端可见（消除路径穿越）。
 *  - 内容库仍只经 WriterTool 改写；本文件只负责“登录态 -> 拥有权 -> 内部路径”的映射。
 */
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { WriterTool } from './tools/common/writerTool.js';
import { createWriterDB } from './database/writer.js';
import { llm } from './agent/llm.js';
import { MENU_ACTIONS, AI_TOOLS } from './tools/registry.js';
import { publishNovelLocal, publishSiteIndexLocal, sanitizeDirName } from './skills/novelPublisher/publish.js';
import * as store from './auth/userStore.js';
import { requireAuth, requireSuperadmin, currentUser, setSessionCookie, clearSessionCookie } from './auth/session.js';
import { BASE_PATH, sitePath } from './base.js';
import { generateQuiz, explainSentence, explainWord, vocabExplainStatus, askQuestion, answerFeedback, pickVocab } from './reader/aiService.js';
import { synthesize as ttsSynthesize, computeHash as ttsComputeHash } from './reader/ttsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const OUT_ROOT = path.join(ROOT, 'public', 'novel');

const ALLOWED_ACTIONS = new Set([
  'generate', 'gen', 'g', 'add', 'modify', 'mod', 'm', 'delete', 'del', 'd',
  'getNovelInfo', 'getPublishConfig', 'setPublishConfig',
  'saveNovelPlan', 'generateChapterOutlines', 'addChapterOutline', 'updateChapterOutline',
  'reNumberChapters', 'updateNovelPlan', 'generatePreface', 'savePreface',
  'setParts', 'generatePartIntros', 'listParts'
]);
const CREATE_ACTIONS = new Set(['saveNovelPlan', 'savePreface', 'add', 'setPublishConfig']);
const GENERIC_DESCRIBING_NAME_RE = /^(目标小说|目标|目标库|目标文件|目标书|示例|示例小说|小说名|例子|某小说|待确定|待定|xxx+)\.db$/i;

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

// ── 输出净化：/api 回答不显示数据目录绝对路径与服务器信息（登录/账号类除外）──
const DROP_KEYS = new Set([
  'novelDir', 'absolutePath',
  'servers', 'server', 'host', 'hostname', 'siteUrl', 'port',
  'password', 'passwd', 'pass', 'keyAuth',
  'privateKey', 'apiKey', 'apikey', 'api_key', 'token',
  'passHash', 'pass_hash', 'salt', 'dbFile', 'db_file', 'dbPath',
]);
const ABS_ROOTS = [OUT_ROOT, DATA_DIR, ROOT].filter(Boolean).sort((a, b) => b.length - a.length);

function scrubString(str) {
  let out = String(str);
  for (const root of ABS_ROOTS) { if (root) out = out.split(root).join(''); }
  out = out.replace(/\/(?:[\w.\-]+\/)*?(?:ainovel|workspace|agents)[\/\w.\-]*/g, '');
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '\u2022');
  out = out.replace(/\bhttps?:\/\/(?!localhost\b|127\.0\.0\.1)[^\s"'`)\]]+/gi, '\u2022');
  out = out.replace(/\b(host|siteUrl|ssh|password|passwd|\u5bc6\u94a5|\u670d\u52a1\u5668|\u7aef\u53e3|\u8d26\u53f7|\u7528\u6237)\b(\s*[:=]\s*)[^\n,;]*/gi, '$1$2\u2022');
  return out;
}
function scrubValue(v) {
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(scrubValue);
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) { if (DROP_KEYS.has(k)) continue; o[k] = scrubValue(val); }
    return o;
  }
  return v;
}

// ── 小说归属解析（核心租户逻辑）──
function pathFor(dbFile) {
  const p = path.join(DATA_DIR, String(dbFile));
  return p.startsWith(DATA_DIR + path.sep) ? p : null;
}
/** 以 novel.id 或 db_file 定位，并校验当前用户拥有权 */
function resolveNovelForUser(idOrFile, user) {
  const raw = String(idOrFile || '').trim();
  if (!raw) return { ok: false, status: 400, error: '缺少小说标识' };
  let novel = store.getNovel(raw);
  if (!novel) {
    const asFile = raw.endsWith('.db') ? raw : `${raw}.db`;
    novel = store.findNovelByFile(asFile);
  }
  if (!novel) return { ok: false, status: 404, error: '小说不存在或未登记' };
  if (user.role !== 'superadmin' && novel.user_id !== user.id) return { ok: false, status: 403, error: '无权访问该小说' };
  const absPath = pathFor(novel.db_file);
  if (!absPath || !fs.existsSync(absPath)) return { ok: false, status: 404, error: '小说库文件缺失' };
  return { ok: true, novel, absPath };
}
/** 只读统计某小说库：书名 + 正文章数（不改内容） */
function computeStats(absPath) {
  let db;
  try {
    db = new Database(absPath, { readonly: true });
    const t = db.prepare('SELECT name FROM content WHERE no = 0').get();
    const c = db.prepare("SELECT COUNT(*) AS c FROM content WHERE no >= 1 AND type = 'chapter' AND content IS NOT NULL AND content != ''").get();
    return { title: (t && t.name) || null, chapterCount: (c && c.c) || 0 };
  } catch { return {}; }
  finally { try { db?.close?.(); } catch {} }
}
function refreshStats(novel) {
  const absPath = pathFor(novel.db_file);
  if (!absPath) return;
  const s = computeStats(absPath);
  store.updateNovelMeta(novel.id, {
    title: s.title || novel.title,
    chapterCount: s.chapterCount != null ? s.chapterCount : novel.chapter_count,
  });
}
/** writerTool 侧的全量枚举（仅供 AI 兜底/对账，不用于 Web 列表） */
async function listNovelFiles() {
  const tool = makeTool();
  const novels = await tool.listNovelDatabases();
  return novels.map(({ file, name, chapterCount, updatedAt }) => ({ file, name, chapterCount, updatedAt }));
}

export function registerRoutes(app) {
  // 净化（对登录/会话/账号管理端点放行：这些响应按设计回显用户名）
  app.use('/api', (req, res, next) => {
    if (/^\/(login|logout|me|admin\/|reader\/)/.test(req.path)) return next();
    const orig = res.json.bind(res);
    res.json = (body) => orig(scrubValue(body));
    next();
  });

  // ── 认证（公开）──
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    const user = store.login(username, password);
    if (!user) return res.status(401).json({ error: '用户名或密码错误' });
    setSessionCookie(res, user.id);
    res.json({ ok: true, user });
  });
  app.post('/api/logout', (_req, res) => { clearSessionCookie(res); res.json({ ok: true }); });
  app.get('/api/me', (req, res) => { res.json({ ok: true, user: currentUser(req) }); });

  // ── 阅读器 AI（公开：读者无账号；服务端持 key + 缓存 + 限并发 + 限流）──
  const readerRL = new Map(); // ip -> [count, windowStartMs]
  function readerRateLimit(req, res, next) {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
    const t = Date.now();
    let e = readerRL.get(ip);
    if (!e || t - e[1] > 60000) { e = [0, t]; readerRL.set(ip, e); }
    e[0]++;
    if (e[0] > 60) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    next();
  }
  const readerErr = (res, e) => res.status(e && e.status === 503 ? 503 : 500).json({ error: (e && e.message) || 'AI 服务异常' });
  app.post('/api/reader/quiz', readerRateLimit, async (req, res) => {
    /* force 显式白名单取值（不摊平 req.body）：只有读者点「换一组新题」才为 true */
    try { res.json({ ok: true, questions: await generateQuiz(req.body?.document, Number(req.body?.age) || 9, { force: req.body?.force === true }) }); }
    catch (e) { readerErr(res, e); }
  });
  app.post('/api/reader/explain', readerRateLimit, async (req, res) => {
    try { res.json({ ok: true, explanation: await explainSentence(req.body?.sentence, Number(req.body?.age) || 9, String(req.body?.lang || '英语')) }); }
    catch (e) { readerErr(res, e); }
  });
  /* 生词标注：按 (章节+年龄) 缓存，学习模式开启时拉一次，命中后即时返回 */
  app.post('/api/reader/vocab', readerRateLimit, async (req, res) => {
    try { res.json({ ok: true, words: await pickVocab(req.body?.document, Number(req.body?.age) || 9) }); }
    catch (e) { readerErr(res, e); }
  });
  /* 单词讲解：按 (词+年龄+语言) 持久缓存，命中即秒显；context（原句/章节）仅首次生成时作语境，不进键 */
  app.post('/api/reader/explain-word', readerRateLimit, async (req, res) => {
    try { res.json({ ok: true, explanation: await explainWord(req.body?.word, Number(req.body?.age) || 9, String(req.body?.lang || '英语'), req.body?.context) }); }
    catch (e) { readerErr(res, e); }
  });
  /* 词义状态：告诉前端这批词哪些已生成（黑体）、哪些未生成（灰体）；纯查库、零 LLM */
  app.post('/api/reader/word-status', readerRateLimit, async (req, res) => {
    try { res.json({ ok: true, have: vocabExplainStatus(req.body?.words, Number(req.body?.age) || 9, String(req.body?.lang || '英语')) }); }
    catch (e) { readerErr(res, e); }
  });
  app.post('/api/reader/ask', readerRateLimit, async (req, res) => {
    try { res.json({ ok: true, answer: await askQuestion(req.body?.question, req.body?.document) }); }
    catch (e) { readerErr(res, e); }
  });
  app.post('/api/reader/feedback', readerRateLimit, async (req, res) => {
    try { res.json({ ok: true, feedback: await answerFeedback(req.body?.text) }); }
    catch (e) { readerErr(res, e); }
  });

  /* TTS 音频合成：句子级 mp3，带存在性校验防滥用 */
  app.post('/api/tts/sentence', readerRateLimit, async (req, res) => {
    try {
      const { chapterUrl, text, voice, rate } = req.body || {};
      if (!chapterUrl || !text || !voice || !rate) {
        return res.status(400).json({ error: '缺少参数：chapterUrl, text, voice, rate' });
      }
      // 音色白名单
      const ALLOWED_VOICES = new Set(['zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural', 'zh-TW-YunHsiaoNeural']);
      if (!ALLOWED_VOICES.has(voice)) {
        return res.status(400).json({ error: `不支持的音色：${voice}` });
      }
      // 语速白名单
      const ALLOWED_RATES = new Set(['-30%', '+0%', '+50%']);
      if (!ALLOWED_RATES.has(rate)) {
        return res.status(400).json({ error: `不支持的语速：${rate}` });
      }
      // 存在性校验：从章节 URL 提取文件路径，读取正文，确认句子存在
      // chapterUrl 形如 "/novel/<uid>/<novelDir>/<chapterFile>.html" 或 "/novel/<novelDir>/<chapterFile>.html"
      const urlMatch = chapterUrl.match(/^\/novel\/(?:([^/]+)\/)?([^/]+)\/([^/]+\.html)$/);
      if (!urlMatch) {
        return res.status(400).json({ error: '无效的 chapterUrl 格式' });
      }
      const [, uid, novelDir, chapterFile] = urlMatch;
      const chapterPath = path.join(OUT_ROOT, uid || '', novelDir, chapterFile);
      // 防路径穿越
      if (!chapterPath.startsWith(OUT_ROOT)) {
        return res.status(400).json({ error: '非法的章节路径' });
      }
      if (!fs.existsSync(chapterPath)) {
        return res.status(404).json({ error: '章节文件不存在' });
      }
      const html = fs.readFileSync(chapterPath, 'utf8');
      // 提取 <div class="content">...</div> 内的文本
      const contentMatch = html.match(/<div class="content">([\s\S]*?)<\/div>/);
      if (!contentMatch) {
        return res.status(400).json({ error: '章节无正文内容' });
      }
      const chapterText = contentMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, '');
      if (!chapterText.includes(text.replace(/\s+/g, ''))) {
        return res.status(400).json({ error: '句子不在章节正文中（存在性校验失败）' });
      }
      // 合成
      const result = await ttsSynthesize(text, voice, rate);
      if (!result) {
        return res.status(503).json({ error: '合成失败，请回退到浏览器 TTS', fallback: 'browser' });
      }
      // 返回音频文件的相对路径（相对于 data/tts/）和 hash
      const hash = ttsComputeHash(text, voice, rate);
      const relPath = path.relative(path.join(ROOT, 'data', 'tts'), result.filePath);
      res.json({ ok: true, hash, audioPath: `/tts-audio/${relPath}`, bytes: result.bytes });
    } catch (e) {
      readerErr(res, e);
    }
  });

  // ── 以下 /api 全部需登录 ──
  app.use('/api', requireAuth);

  // ── 元数据 ──
  app.get('/api/menu', (_req, res) => res.json({ groups: MENU_ACTIONS }));
  app.get('/api/tools', (_req, res) => res.json({ tools: AI_TOOLS }));

  // ── 小说列举（按登录用户，从 global.db 注册表，O(1) 不逐库扫描）──
  app.get('/api/novels', (req, res) => {
    const rows = (req.user.role === 'superadmin' && req.query.all === '1')
      ? store.listAllNovels() : store.listNovelsByUser(req.user.id);
    res.json({ novels: rows.map(n => ({ id: n.id, name: n.title, chapterCount: n.chapter_count, updatedAt: n.updated_at })) });
  });

  // ── 新建小说（分配不透明文件名 <uuid>.db 并登记归属）──
  app.post('/api/novels', async (req, res) => {
    const title = String(req.body?.title || '').trim();
    if (!title) return res.status(400).json({ error: '书名不能为空' });
    if (GENERIC_DESCRIBING_NAME_RE.test(`${title}.db`)) return res.status(400).json({ error: '请提供真实书名' });
    const id = crypto.randomUUID();
    const dbFile = `${req.user.id}/${id}.db`;
    try { fs.mkdirSync(path.join(DATA_DIR, req.user.id), { recursive: true }); } catch {}
    const tool = makeTool();
    try {
      await tool.execute({ action: 'saveNovelPlan', dbPath: path.join(DATA_DIR, dbFile), info: { name: title, outline: String(req.body?.outline || ''), content: String(req.body?.content || '') } });
      const novel = store.createNovel({ id, userId: req.user.id, title, dbFile, actor: req.user.username });
      refreshStats(novel);
      res.json({ ok: true, novel: { id: novel.id, name: novel.title, chapterCount: novel.chapter_count, updatedAt: novel.updated_at } });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 删除整本小说（删注册行 + 删文件；属元/文件操作，非正文裸改）──
  app.delete('/api/novels/:id', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    try { store.deleteNovel(rr.novel.id); } catch {}
    try { if (fs.existsSync(rr.absPath)) fs.unlinkSync(rr.absPath); } catch {}
    res.json({ ok: true, id: req.params.id });
  });

  // ── 对账（超管）：data/ 文件与 novel 表互校，补登记/清悬挂 ──
  app.post('/api/novels/reconcile', requireSuperadmin, (req, res) => {
    const added = store.migrateExistingNovels(req.user.id);
    let removed = 0;
    for (const n of store.listAllNovels()) { const p = pathFor(n.db_file); if (!p || !fs.existsSync(p)) { store.deleteNovel(n.id); removed++; } }
    res.json({ ok: true, added, removed });
  });

  // ── 章节结构化列表 ──
  app.get('/api/novels/:id/chapters', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const chapters = db.getAllChapters({ includeContent: false }).filter(c => c.no > 0)
        .map(c => ({ no: c.no, name: c.name, outline: c.outline, hasContent: !!(c.content && String(c.content).trim()), partNo: c.part_no || 0, id: c.id }));
      res.json({ novel: rr.novel.title, chapters });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 单章正文
  app.get('/api/novels/:id/chapter/:no', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const no = Number(req.params.no);
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const ch = db.getAllChapters({ includeContent: true }).find(c => c.no === no);
      if (!ch) return res.status(404).json({ error: `第 ${no} 章不存在` });
      res.json({ chapter: { no: ch.no, name: ch.name, outline: ch.outline, content: ch.content } });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // ── 设定读写（直连 DB，快速、不触发 LLM/体检）──
  app.get('/api/novels/:id/settings', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const info = db.getNovelInfo() || {};
      const chapters = db.getAllChapters({ includeContent: false }).filter(c => c.no > 0);
      res.json({
        name: info.name || '', outline: info.outline || '', content: info.content || '',
        preface: db.getPreface() || '', version: info.version || 0, updatedAt: info.updated_at || null,
        chapterCount: chapters.length,
        outlineCount: chapters.filter(c => c.outline && String(c.outline).trim()).length,
        bodyCount: chapters.filter(c => c.content && String(c.content).trim()).length,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  app.put('/api/novels/:id/settings', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const b = req.body || {};
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const cur = db.getNovelInfo() || {};
      let saved = null;
      if (b.name !== undefined || b.outline !== undefined || b.content !== undefined) {
        const name = (b.name !== undefined ? String(b.name) : (cur.name || '')).trim();
        if (!name) return res.status(400).json({ error: '书名不能为空' });
        saved = db.saveNovelInfo({ name, outline: b.outline !== undefined ? b.outline : (cur.outline || ''), content: b.content !== undefined ? b.content : (cur.content || '') });
        store.updateNovelMeta(rr.novel.id, { title: name });
      } else if (b.preface !== undefined && !db.hasNovelInfo()) {
        return res.status(400).json({ error: '请先保存小说基本信息（书名）' });
      }
      if (b.preface !== undefined) db.savePreface(b.preface);
      res.json({ ok: true, action: saved?.action || 'saved', version: saved?.version ?? null });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 保存单章标题/大纲
  app.put('/api/novels/:id/chapter/:no/outline', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const no = Number(req.params.no);
    const b = req.body || {};
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const cur = db.getChapter(no);
      if (!cur) return res.status(404).json({ error: `第 ${no} 章不存在` });
      const out = db.updateChapterOutline(no, b.outline !== undefined ? b.outline : cur.outline, b.name !== undefined ? b.name : null);
      if (!out?.success) return res.status(400).json({ error: out?.error || '更新失败' });
      res.json({ ok: true, no });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 删除单章（自动重排后续章号）
  app.delete('/api/novels/:id/chapter/:no', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const no = Number(req.params.no);
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const out = db.deleteChapter(no);
      if (!out?.success) return res.status(400).json({ error: out?.error || '删除失败' });
      refreshStats(rr.novel);
      res.json({ ok: true, no });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 重排全部章节号
  app.post('/api/novels/:id/renumber', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const out = db.reNumberAllChapters();
      res.json({ ok: true, shiftedCount: out?.shiftedCount ?? 0 });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // ── 通用动作执行（复用 WriterTool 全部 action）──
  app.post('/api/run', async (req, res) => {
    const body = req.body || {};
    const action = body.action;
    if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: `不支持的 action: ${action}` });

    let novel = null;
    let allocatedNew = false;
    if (body.novelId) {
      const rr = resolveNovelForUser(body.novelId, req.user);
      if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
      novel = rr.novel;
    } else if (CREATE_ACTIONS.has(action)) {
      novel = { id: crypto.randomUUID(), db_file: '', user_id: req.user.id, title: body.info?.name || '' };
      novel.db_file = `${req.user.id}/${novel.id}.db`;
      try { fs.mkdirSync(path.join(DATA_DIR, req.user.id), { recursive: true }); } catch {}
      allocatedNew = true;
    } else {
      return res.status(400).json({ error: '缺少 novelId（请从小说列表选择一本）' });
    }

    const tool = makeTool();
    const absDb = pathFor(novel.db_file);
    if (!absDb) return res.status(400).json({ error: '小说库路径非法' });
    try {
      const result = await tool.execute({ ...body, dbPath: absDb });
      if (allocatedNew) { const c = store.getNovel(novel.id) || store.createNovel({ id: novel.id, userId: req.user.id, title: novel.title, dbFile: novel.db_file, actor: req.user.username }); refreshStats(c); }
      else refreshStats(novel);
      res.json({ success: true, action, novelId: novel.id, result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ── 一致性检查 ──
  app.post('/api/novels/:id/check', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const withBody = req.body?.withBody === true;
    const tool = makeTool();
    let db;
    try {
      db = createWriterDB(rr.absPath);
      tool.db = db;
      const report = await tool._runPostWriteCheck({ fullBook: true, withBody });
      res.json({ success: true, report });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // ── 本地发布（按用户命名空间 public/novel/<user>/<title>/）──
  app.post('/api/novels/:id/publish', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const userOut = path.join(OUT_ROOT, req.user.id);
    const urlBase = sitePath(encodeURIComponent(req.user.id)) + '/';
    try {
      // premakeQuiz 是“发布时跑不跑 LLM 预生成”的总开关，现在同时管测试题与生词表：
      // 调用方传 false 意味着不想让发布变慢，不该只跳过测试题而偷偷多跑三十次挑词
      const premake = req.body?.premakeQuiz !== false;
      const quizAge = Number(req.body?.quizAge) || 9;
      const out = await publishNovelLocal(rr.absPath, userOut, {
        title: req.body?.title || rr.novel.title,
        urlBase,
        generateQuiz: premake ? ((text, age) => generateQuiz(text, age)) : null,
        quizAge,
        pickVocab: premake ? ((text, age) => pickVocab(text, age)) : null,
        vocabAge: quizAge,
      });
      // 该用户的站点首页（列出其已发布作品）
      try {
        const items = [];
        if (fs.existsSync(userOut)) {
          for (const d of fs.readdirSync(userOut)) {
            const idx = path.join(userOut, d, 'index.html');
            if (fs.existsSync(idx)) items.push({ dirName: d, title: d });
          }
        }
        publishSiteIndexLocal(items, userOut, urlBase);
      } catch { /* 首页失败不影响单本发布 */ }
      res.json({ success: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 阅读入口：<BASE>/ 必须落到「当前登录用户的作品站」──
  // 不能靠静态目录的默认 index：public/novel/index.html 是多用户改造前的遗留物，
  // 它只链向顶层旧版书页（无内嵌 quiz/vocab），会让每个人从首页进来都踩在旧页面上。
  // 路由注册在 express.static 之前（server.js 先 registerRoutes 再挂静态），故能截下 /novel/。
  app.get(['/novel', '/novel/'], (req, res) => {
    const user = currentUser(req);
    if (!user) return res.redirect(`${BASE_PATH}/login/?next=` + encodeURIComponent(`${BASE_PATH}/`));
    const site = path.join(OUT_ROOT, user.id, 'index.html');
    // 该用户还没发布过作品：送去管理页，而不是给一个 404
    if (!fs.existsSync(site)) return res.redirect(`${BASE_PATH}/admin/`);
    res.redirect(sitePath(encodeURIComponent(user.id), 'index.html'));
  });

  // ── 分享：实时计算已发布阅读地址（不存库，避免改名后 404 陈旧链接）──
  app.get('/api/novels/:id/share', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const novelDir = sanitizeDirName(rr.novel.title || '小说');
    const uid = encodeURIComponent(rr.novel.user_id);
    const url = sitePath(uid, novelDir, 'index.html');
    const published = fs.existsSync(path.join(OUT_ROOT, rr.novel.user_id, novelDir, 'index.html'));
    res.json({ url, published, title: rr.novel.title });
  });

  // ── AI 窗口：单轮意图解析 ──
  app.post('/api/ai/plan', async (req, res) => {
    const userInput = String(req.body?.userInput || '').trim();
    const novelId = req.body?.novelId || null;
    if (!userInput) return res.status(400).json({ error: '缺少 userInput' });
    try {
      const rows = store.listNovelsByUser(req.user.id);
      const system = [
        '你是小说平台的命令解析器。根据用户的一句话，从下面的工具清单中选出最合适的一个工具，并填好参数。',
        '只输出一个 JSON 对象，形如 {"tool":"工具名","args":{...},"reason":"一句话说明"}。不要输出多余文字、不要代码块围栏。',
        '若无法对应任何工具，输出 {"tool":null,"args":{},"reason":"无法识别的指令"}。',
        'dbPath 必须是下面"现有小说库"之一的文件名原文；用户没指明且为单本操作时，若上下文只有一个库则用它，否则在 reason 里说明需要选择。',
        `现有小说库: ${JSON.stringify(rows.map(r => r.db_file))}`,
        `当前选中的库: ${novelId ? (store.getNovel(novelId)?.db_file || '(未选)') : '(未选)'}`,
        `工具清单: ${JSON.stringify(AI_TOOLS)}`,
      ].join('\n');
      const resp = await llm.chat({ messages: [{ role: 'system', content: system }, { role: 'user', content: userInput }], temperature: 0.2 });
      const parsed = parseJsonObject(resp.content);
      if (!parsed || typeof parsed.tool === 'undefined') return res.status(502).json({ error: 'AI 未返回可解析的工具选择', raw: resp.content });
      res.json({ ok: true, tool: parsed.tool, args: parsed.args || {}, reason: parsed.reason || '' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/ai/execute', async (req, res) => {
    const { tool, args = {} } = req.body || {};
    if (!tool) return res.status(400).json({ error: '缺少 tool' });
    try {
      const r = await runAiTool(req.user, tool, args);
      res.json({ success: true, tool, result: r });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
  });

  // ── 用户管理（超管）──
  app.get('/api/admin/users', requireSuperadmin, (_req, res) => { res.json({ users: store.listUsers() }); });
  app.post('/api/admin/users', requireSuperadmin, (req, res) => {
    try { const u = store.createUser({ username: req.body?.username, password: req.body?.password, role: req.body?.role, actor: req.user.username }); res.json({ ok: true, user: u }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/users/:id/disable', requireSuperadmin, (req, res) => {
    if (req.params.id === req.user.id) return res.status(400).json({ error: '不能禁用当前登录账号' });
    try { const u = store.setUserDisabled(req.params.id, !!req.body?.disabled, req.user.username); res.json({ ok: true, user: u }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.put('/api/admin/users/:id/password', requireSuperadmin, (req, res) => {
    try { const u = store.setUserPassword(req.params.id, req.body?.password, req.user.username); res.json({ ok: true, user: u }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
}

/** AI 工具执行：dbPath(文件名) -> 拥有权校验 -> 内部路径 */
async function runAiTool(user, name, args) {
  const rr = resolveNovelForUser(args.dbPath, user);
  if (!rr.ok) throw new Error(rr.error);
  const run = async (action, extra = {}) => makeTool().execute({ action, dbPath: rr.absPath, ...extra });

  switch (name) {
    case 'getNovelInfo': return await run('getNovelInfo');
    case 'deleteChapter': {
      if (!args.chapter) throw new Error('deleteChapter 需要 chapter 章号');
      const out = await run('delete', { chapter: Number(args.chapter) });
      refreshStats(rr.novel);
      return out;
    }
    case 'addChapter': { const out = await run('add', { info: { name: args.name, content: args.content } }); refreshStats(rr.novel); return out; }
    case 'generateChapter': { const out = await run('generate', { chapter: Number(args.chapter || 0), force: !!args.force }); refreshStats(rr.novel); return out; }
    case 'modifyChapter': {
      if (!args.modifyInstructions) throw new Error('modifyChapter 需要 modifyInstructions');
      return await run('modify', { chapter: Number(args.chapter), modifyInstructions: args.modifyInstructions });
    }
    case 'generateOutlines': return await run('generateChapterOutlines', { totalChapters: Number(args.totalChapters || 10) });
    case 'publishNovel': {
      const userOut = path.join(OUT_ROOT, user.id);
      return await publishNovelLocal(rr.absPath, userOut, { urlBase: sitePath(encodeURIComponent(user.id)) + '/', generateQuiz: (text, age) => generateQuiz(text, age), pickVocab: (text, age) => pickVocab(text, age) });
    }
    case 'checkConsistency': {
      const tool = makeTool();
      const db = createWriterDB(rr.absPath);
      try { tool.db = db; return await tool._runPostWriteCheck({ fullBook: true, withBody: false }); }
      finally { try { db.close?.(); } catch {} }
    }
    default: throw new Error(`未知工具: ${name}`);
  }
}

/** 从 LLM 文本里容错抽取第一个 JSON 对象 */
function parseJsonObject(text) {
  if (!text) return null;
  const t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  try { return JSON.parse(body); } catch {}
  const m = body.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}
