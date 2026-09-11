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
import { llm, bridgeUrl, bridgeKey } from './agent/llm.js';
import { bridgeStore } from './services/bridgeStore.js';
import { progressHub } from './services/progressHub.js';
import { MENU_ACTIONS, AI_TOOLS } from './tools/registry.js';
import { effectiveBand, bandText, normalizeGenConfig } from './utils/wordTarget.js';
import { publishNovelLocal, publishSiteIndexLocal, sanitizeDirName } from './skills/novelPublisher/publish.js';
import * as preview from './services/preview.js';
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
  'saveNovelPlan', 'generateChapterOutlines', 'addChapterOutline', 'addChaptersBulk', 'generateOutlinesForRange', 'updateChapterOutline',
  'reNumberChapters', 'updateNovelPlan', 'generatePreface', 'savePreface',
  'setParts', 'generatePartIntros', 'listParts', 'setGenConfig', 'tuneWordCount'
]);
const CREATE_ACTIONS = new Set(['saveNovelPlan', 'savePreface', 'add', 'setPublishConfig']);
const GENERIC_DESCRIBING_NAME_RE = /^(目标小说|目标|目标库|目标文件|目标书|示例|示例小说|小说名|例子|某小说|待确定|待定|xxx+)\.db$/i;

/* 删除章节的二次确认：三个入口（直连 REST / 命令行 /api/run / AI 对话 /api/ai/execute）
 * 共用一口径，免得各写一套后语义漂移。只认字面量 'OK'（去空白），与界面输入框的要求一致。
 * 注意这是“防误删”而不是鉴权：能登录就有删的权限，这里只多拦一道人工确认。 */
function requireOkConfirm(body, what) {
  return String(body?.confirm ?? '').trim() === 'OK'
    ? null
    : `删除${what}需要二次确认：请在请求体里带 confirm:"OK"（在管理页操作会弹出输入框）`;
}
const DELETE_CHAPTER_ACTIONS = new Set(['delete', 'del', 'd']);

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

// ── VIP 闸门（读者账号授权制）──
// 不再使用共享密码：VIP 书的访问权 = global.db 的 vip_grant 名单（超管在控制台授予），
// 判定走登录会话 cookie（Path=<BASE>，书页在同一前缀下，故读者登录后能直接进 VIP 书页）。
// 不依赖前端 / sessionStorage，每个书页请求实时校验，撤销与到期当场生效。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 某用户名下 VIP 小说：sanitize 后目录名 -> novel 行 */
function vipMapForUid(uid) {
  const map = {};
  for (const n of store.listNovelsByUser(uid)) {
    if (n.vip) map[sanitizeDirName(n.title || '小说')] = n;
  }
  return map;
}

/**
 * 重建某用户的站点首页（列出其已发布作品）。
 * 发布单本与「预览后发布」都要跑，VIP 标记据 global.db 实时判定，不缓存到产物里。
 */
function refreshUserSiteIndex(user, userOut, urlBase) {
  try {
    const vipByDir = {};
    const ownerNovels = user.role === 'superadmin' ? store.listAllNovels() : store.listNovelsByUser(user.id);
    for (const n of ownerNovels) {
      if (n.vip) vipByDir[sanitizeDirName(n.title || '小说')] = n.id;
    }
    const items = [];
    if (fs.existsSync(userOut)) {
      for (const d of fs.readdirSync(userOut)) {
        const idx = path.join(userOut, d, 'index.html');
        if (fs.existsSync(idx)) items.push({ dirName: d, title: d, vip: !!vipByDir[d], novelId: vipByDir[d] || null });
      }
    }
    publishSiteIndexLocal(items, userOut, urlBase, user.id);
  } catch { /* 首页失败不影响单本发布 */ }
}

/** 发布时预生成（测试题 / 生词）的 LLM 钩子；premake=false 时整体不跑，避免发布变慢 */
function llmHooksFor(premake, quizAge) {
  if (!premake) return null;
  return {
    generateQuiz: (text, age) => generateQuiz(text, age ?? quizAge),
    pickVocab: (text, age) => pickVocab(text, age ?? quizAge),
  };
}

/**
 * VIP 授权的到期时间：优先 days（从授予日算起的天数），次选 expiresAt（时间戳或日期串）。
 * 两者都没给就是长期授权（null）。UI 用“天数”比用“日期”好填，故两条都收。
 */
function resolveGrantExpiry(body) {
  const days = body?.days;
  if (days !== undefined && days !== null && days !== '') {
    const n = Number(days);
    if (!Number.isFinite(n) || n <= 0) throw new Error('天数需为大于 0 的数字');
    return Date.now() + Math.round(n) * 86400000;
  }
  const raw = body?.expiresAt;
  if (!raw) return null;
  const t = typeof raw === 'number' ? raw : Date.parse(String(raw));
  if (!Number.isFinite(t)) throw new Error('到期时间格式不正确');
  return t;
}

/**
 * VIP 无权页：未登录给登录入口（登录后回到本页），已登录但未授权给出说明。
 * 两种情形不能混为一谈：前者是「还没告知你是谁」，后者是「知道了但没授权」。
 */
function renderVipDeniedPage({ reader, backUrl }) {
  const loginHref = `${BASE_PATH}/login/?next=` + encodeURIComponent(backUrl || `${BASE_PATH}/`);
  const home = `${BASE_PATH}/`;
  const title = reader ? '此内容仅 VIP 用户可读' : '需要登录后阅读';
  const desc = reader
    ? `当前账号「${escapeHtmlLite(reader.username)}」尚无本书的 VIP 授权，请联系管理员开通。`
    : '本小说为 VIP 专属内容，需使用获得 VIP 授权的账号登录后阅读。';
  const cta = reader
    ? `<a class="back" href="${home}">返回小说列表</a>`
    : `<a class="btn" href="${loginHref}">去登录</a><a class="back" href="${home}">返回小说列表</a>`;
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>VIP 专属内容</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e3c72,#2a5298);}
.card{background:#fff;border-radius:16px;padding:36px 30px;width:90%;max-width:380px;box-shadow:0 12px 40px rgba(0,0,0,.3);text-align:center;}
.ico{font-size:48px;line-height:1;}
h2{margin:10px 0 4px;color:#2c3e50;}
p{color:#7f8c8d;font-size:14px;margin:0 0 20px;line-height:1.7;}
.btn{display:block;margin-top:6px;padding:12px;font-size:16px;font-weight:700;color:#fff;border-radius:8px;text-decoration:none;background:linear-gradient(135deg,#f39c12,#e74c3c);}
a.back{display:inline-block;margin-top:16px;color:#3498db;text-decoration:none;font-size:13px;}
</style></head>
<body><div class="card">
<div class="ico">🔒</div><h2>${title}</h2><p>${desc}</p>
${cta}
</div></body></html>`;
}
function escapeHtmlLite(s) {
  return String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 预览暂存站的无权页：预览链接不公开，需创作者本人（或超管）登录态 */
function renderPreviewDeniedPage(backUrl) {
  const loginHref = `${BASE_PATH}/login/?next=` + encodeURIComponent(backUrl || `${BASE_PATH}/`);
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>预览链接</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#1a252f;color:#ecf0f1;}
.card{background:#1a252f;border:1px solid #2c3e50;border-radius:16px;padding:32px 28px;width:90%;max-width:400px;text-align:center;}
h2{margin:6px 0 10px;}
p{color:#95a5a6;font-size:14px;line-height:1.7;}
.btn{display:inline-block;margin-top:10px;padding:11px 22px;font-size:15px;color:#fff;border-radius:8px;text-decoration:none;background:#3498db;}
</style></head>
<body><div class="card">
<div style="font-size:40px">🔍</div><h2>这是发布前的预览页</h2>
<p>预览站只在创作者登录态下可见，且会在 24 小时后自动清理。</p>
<a class="btn" href="${loginHref}">登录创作者账号</a>
</div></body></html>`;
}

export function registerRoutes(app) {
  // 净化（对登录/会话/账号管理/预览类端点放行：这些响应按设计回显用户名与预览标识；
  // 预览接口要回 token 与正文 diff，不能被判敏字串清洗掉）
  app.use('/api', (req, res, next) => {
    if (/^\/(login|logout|me|admin\/|reader\/|novels\/[^/]+\/preview)/.test(req.path)) return next();
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

/* VIP 旧密码解锁端点：VIP 已改为读者账号授权制，密码入口整体作废。
 * 保留路由是为了让尚未重发的历史书页（旧产物里有「VIP 解锁」按钮）得到明确提示，
 * 而不是一个默默无文的 404。 */
  app.post('/api/reader/vip-unlock', (req, res) => {
    res.status(410).json({ error: 'VIP 密码解锁已停用：请改用已获得 VIP 授权的账号登录阅读（找管理员开通）' });
  });

  /* 文生图代理：转发至 aibridge /api/bridge/image，密钥留在服务端。
   * 地址与密钥必须每次请求现取：控制台随时可切换桥接连接，写成模块级常量就钉死了；
   * 之前它还是直读 process.env（项目没有 dotenv，.env 里的密钥其实根本读不到）。 */
  const bridgeImageUrl = () => {
    const chat = bridgeUrl();
    try {
      const u = new URL(chat);
      return `${u.protocol}//${u.host}/api/bridge/image`;
    } catch {
      return chat.includes('/bridge/chat') ? chat.replace('/bridge/chat', '/bridge/image') : 'http://localhost:3300/api/bridge/image';
    }
  };

  app.post('/api/reader/image', readerRateLimit, async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      if (!prompt) return res.status(400).json({ error: '缺少图片描述' });
      const bridgeRes = await fetch(bridgeImageUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': bridgeKey() },
        body: JSON.stringify({ prompt, size: req.body?.size, model: req.body?.model }),
        signal: AbortSignal.timeout(120000),
      });
      const data = await bridgeRes.json().catch(() => ({}));
      if (!bridgeRes.ok || data.ok === false) {
        return res.status(502).json({ error: data.error || `aibridge HTTP ${bridgeRes.status}` });
      }
      res.json({ ok: true, url: data.url, revisedPrompt: data.revised_prompt || null });
    } catch (e) { readerErr(res, e); }
  });

  /* ── TTS 音色白名单（正文朗读 + 讲解音频共用）── */
  const ALLOWED_VOICES = new Set([
    // 中文
    'zh-CN-YunxiNeural', 'zh-CN-XiaoxiaoNeural', 'zh-CN-YunjianNeural', 'zh-TW-YunHsiaoNeural',
    // 英文（讲解用）
    'en-US-JennyNeural', 'en-US-AriaNeural', 'en-US-AndrewNeural',
    // 日文（讲解用）
    'ja-JP-NanamiNeural', 'ja-JP-KeitaNeural',
  ]);
  const ALLOWED_RATES = new Set(['-20%', '+0%', '+30%', '+50%']);

  /* TTS 音频合成：句子级 mp3，带存在性校验防滥用 */
  app.post('/api/tts/sentence', readerRateLimit, async (req, res) => {
    try {
      const { chapterUrl, text, voice, rate } = req.body || {};
      if (!chapterUrl || !text || !voice || !rate) {
        return res.status(400).json({ error: '缺少参数：chapterUrl, text, voice, rate' });
      }
      if (!ALLOWED_VOICES.has(voice)) {
        return res.status(400).json({ error: `不支持的音色：${voice}` });
      }
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

  /* TTS 音频合成：讲解文字 / AI 问答结果（无章节存在性校验，有长度限制） */
  app.post('/api/tts/explain', readerRateLimit, async (req, res) => {
    try {
      const { text, voice, rate } = req.body || {};
      if (!text || !voice || !rate) {
        return res.status(400).json({ error: '缺少参数：text, voice, rate' });
      }
      if (!ALLOWED_VOICES.has(voice)) {
        return res.status(400).json({ error: `不支持的音色：${voice}` });
      }
      if (!ALLOWED_RATES.has(rate)) {
        return res.status(400).json({ error: `不支持的语速：${rate}` });
      }
      // 长度限制：讲解文本通常不超过 2000 字，超过则拒绝
      if (text.length > 2000) {
        return res.status(400).json({ error: `文本过长（${text.length} 字，上限 2000）` });
      }
      const result = await ttsSynthesize(text, voice, rate);
      if (!result) {
        return res.status(503).json({ error: '合成失败，请回退到浏览器 TTS', fallback: 'browser' });
      }
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

  // LLM 链路预检（登录后才能查，避开把内部服务地址/密钥暴露给读者）。
  // 只探桥接服务可达性与密钥配置，不发起生成，因此不计费、也不代表上游模型一定可用。
  app.get('/api/llm-status', async (_req, res) => {
    const r = await llm.checkReachable();
    res.json(r);
  });

  // ── 长任务进度通道（SSE）─────────────────────────────
  /* progressHub 本身是纯转发、不持状态（它的文件头就是这么定的），但「发起 /api/run」
   * 与「建立 SSE」是两个请求，存在先 publish 后 subscribe 的竞态，头几行进度会丢。
   * 所以在这层按 progressId 缓冲近期事件，连上时先补发再转实流。
   * 只认本路由发的 `run:` 前缀 id，并按时长清理，防止无限增长。 */
  const runProgressBuf = new Map(); // progressId -> { lines: [], ts }
  const RUN_PROGRESS_TTL_MS = 10 * 60 * 1000;
  const MAX_RUN_PROGRESS_LINES = 200;
  // 打字机增量（meta.type==='delta'）不进遮罩日志：它们会几百条地灌满一个小文本框。
  // 当前 llm.js 不流式、onDelta 不会被调，但一旦接上就会刷屏，这里先按类型滤掉。
  const isDeltaEvent = (ev) => ev && (ev.type === 'delta' || ev.step);
  progressHub.subscribe((ev) => {
    if (!ev.sessionId || !String(ev.sessionId).startsWith('run:') || isDeltaEvent(ev)) return;
    const cur = runProgressBuf.get(ev.sessionId) || { lines: [], ts: 0 };
    cur.lines.push({ text: ev.text, timestamp: ev.timestamp });
    if (cur.lines.length > MAX_RUN_PROGRESS_LINES) cur.lines.shift();
    cur.ts = Date.now();
    runProgressBuf.set(ev.sessionId, cur);
  });
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of runProgressBuf) {
      if (now - v.ts > RUN_PROGRESS_TTL_MS) runProgressBuf.delete(k);
    }
  }, 60000).unref?.();

  app.get('/api/progress', (req, res) => {
    const id = String(req.query.id || '');
    if (!/^run:[A-Za-z0-9_-]{6,64}$/.test(id)) {
      return res.status(400).json({ error: '进度 id 格式非法' });
    }
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // 经 nginx 时关掉响应缓冲，否则进度会被攒到结束一次性推送
    });
    res.flushHeaders?.();
    let closed = false;
    const send = (obj) => {
      if (closed) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { closed = true; }
    };
    // 先补发已错过的，再挂实流监听（不能反过来，否则会丢两条之间的增量）
    const buf = runProgressBuf.get(id);
    if (buf) buf.lines.forEach((l) => send({ type: 'line', ...l }));
    const off = progressHub.subscribe((ev) => {
      if (ev.sessionId === id && !isDeltaEvent(ev)) send({ type: 'line', text: ev.text, timestamp: ev.timestamp });
    });
    const hb = setInterval(() => {
      if (closed) return;
      try { res.write(': ping\n\n'); } catch { clearInterval(hb); }
    }, 15000);
    req.on('close', () => { closed = true; clearInterval(hb); off(); });
  });

  // 长任务互斥锁（按书）：见 /api/run 里的说明
  const runningTasks = new Map(); // novelId -> { action, startedAt }
  const LONG_ACTIONS = new Set([
    'generate', 'gen', 'g', 'modify', 'mod', 'm',
    'generateChapterOutlines', 'generateOutlinesForRange', 'generatePartIntros', 'generatePreface',
    // 字数治理是逐章调模型（一本书 20 章就是 20 次、单次 1–2 分钟），
    // 不锁书就会和并发的生成任务互相踩正文与章号
    'tuneWordCount',
  ]);

  // ── 小说列举（按登录用户，从 global.db 注册表，O(1) 不逐库扫描）──
  app.get('/api/novels', (req, res) => {
    const rows = (req.user.role === 'superadmin' && req.query.all === '1')
      ? store.listAllNovels() : store.listNovelsByUser(req.user.id);
    res.json({ novels: rows.map(n => ({ id: n.id, name: n.title, chapterCount: n.chapter_count, updatedAt: n.updated_at, vip: !!n.vip })) });
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
  // 不可撤销的破坏性操作：必须显式传入 confirm:"OK"（前端输入 OK 的二次确认），否则拒绝
  app.delete('/api/novels/:id', (req, res) => {
    if (String(req.body?.confirm || '').trim() !== 'OK') {
      return res.status(400).json({ error: '删除整本小说需二次确认：请输入 OK' });
    }
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    // 先清暂存预览目录，再删登记行（顺序反了磁盘残留就再也找不到归属）
    try { preview.purgePreviewsOfNovel(OUT_ROOT, rr.novel.id); } catch { /* 预览残留不阻断删书 */ }
    try { store.deleteNovel(rr.novel.id); } catch {}
    try { if (fs.existsSync(rr.absPath)) fs.unlinkSync(rr.absPath); } catch {}
    res.json({ ok: true, id: req.params.id });
  });

  // ── 对账（超管）：data/ 文件与 novel 表互校，补登记/清悬挂 ──
  app.post('/api/novels/reconcile', requireSuperadmin, (req, res) => {
    const added = store.migrateExistingNovels(req.user.id);
    let removed = 0;
    for (const n of store.listAllNovels()) { const p = pathFor(n.db_file); if (!p || !fs.existsSync(p)) { try { preview.purgePreviewsOfNovel(OUT_ROOT, n.id); } catch {} store.deleteNovel(n.id); removed++; } }
    res.json({ ok: true, added, removed });
  });

  // ── 章节结构化列表 ──
  app.get('/api/novels/:id/chapters', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    let db;
    try {
      db = createWriterDB(rr.absPath);
      /* 不拉正文也能给字数：writer.getAllChapters 现在真按 includeContent 走了，
       * contentLength = LENGTH(content)（中文 1 字计 1，与生成结果里的 wordCount 同口径）。
       * 以前这个参数被忽略，列表接口每刷一次都要把整本书正文读进内存。 */
      const rows = db.getAllChapters({ includeContent: false }).filter(c => c.no > 0);
      const chapters = rows.map(c => {
        const wordCount = Number(c.contentLength) || 0;
        return { no: c.no, name: c.name, outline: c.outline, wordCount, hasContent: wordCount > 0, partNo: c.part_no || 0, id: c.id };
      });
      res.json({
        novel: rr.novel.title,
        chapters,
        totalWords: chapters.reduce((s, c) => s + c.wordCount, 0),
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 单章正文
  app.get('/api/novels/:id/chapter/:no', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const no = Number(req.params.no);
    if (!Number.isInteger(no)) return res.status(400).json({ error: '章节号必须是整数' });
    let db;
    try {
      db = createWriterDB(rr.absPath);
      // 按章直查，不再为了取一章把全库读进内存（getAllChapters 还受 LIMIT 1000 限制）
      const ch = db.getChapter(no);
      if (!ch) return res.status(404).json({ error: `第 ${no} 章不存在` });
      res.json({ chapter: { no: ch.no, name: ch.name, outline: ch.outline, content: ch.content, wordCount: Number(ch.contentLength) || 0, outlineCount: String(ch.outline || '').length } });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 部结构（只读）：给「划分部」弹窗预填现状。没有这个接口的话，纯改名要人先抄下
  // 各部起止章再回填，错一个数字就把区间改了——而改区间等于换一部，原部导言会丢。
  // 不返 summary 正文（接口不拥有它，也不该把导言整段抹到管理页），只返“有没有导言”。
  app.get('/api/novels/:id/parts', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const parts = db.getAllParts();
      res.json({
        parts: parts.map(p => ({
          no: p.no, name: p.name || '', startNo: p.startNo, endNo: p.endNo,
          chapters: p.chapters, hasIntro: !!p.summary,
        })),
      });
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
      // 全书生成设定：genCfg 是人填的原始配置，wordBand 是换算后的判定区间。
      // 两个都回，是为了让页面直接显示「目标 3000 · 合格 2400–3600」而不是让人心算百分比；
      // 旧标记（设定正文里那句【每章目标字数：N】）的回落也在 effectiveBand 里算，
      // 页面说没设限而生成时其实在按某数字要字，是最难查的一种不一致。
      const band = effectiveBand(info.gen_cfg, [info.content, info.outline]);
      res.json({
        name: info.name || '', outline: info.outline || '', content: info.content || '',
        preface: db.getPreface() || '', version: info.version || 0, updatedAt: info.updated_at || null,
        genCfg: info.gen_cfg || null,
        wordBand: band,
        wordBandText: bandText(band),
        chapterCount: chapters.length,
        outlineCount: chapters.filter(c => c.outline && String(c.outline).trim()).length,
        // 同上：includeContent:false 不再返回正文，统计改看 contentLength
        bodyCount: chapters.filter(c => Number(c.contentLength) > 0).length,
        totalWords: chapters.reduce((s, c) => s + (Number(c.contentLength) || 0), 0),
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
      // 生成设定先验后写：形状/越界在 normalizeGenConfig 里抛错，这里只负责把它翻译成 400，
      // 而且必须在任何落库之前验完——否则书名已存、字数设定却静默失败，比全部不存更难发现。
      // 未传即不改；显式 null/'' 才是清除（回到不设限）。“把 undefined 当清除”会令前端
      // 少带一个字段就抹掉用户设定，这个坑在本项目已经踩过一次。
      let genCfgPatch;
      if (b.genCfg !== undefined) {
        if (b.genCfg === null || b.genCfg === '') {
          genCfgPatch = null;
        } else if (typeof b.genCfg !== 'object' || Array.isArray(b.genCfg)) {
          return res.status(400).json({ error: '生成设定必须是对象（或传 null 清除）' });
        } else {
          try {
            genCfgPatch = normalizeGenConfig({ ...(db.getGenConfig() || {}), ...b.genCfg });
          } catch (e) { return res.status(400).json({ error: `生成设定未保存：${e.message}` }); }
        }
      }
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
      // 放在 saveNovelInfo 之后：gen_cfg 写在 no=0 行上，新书第一次保存时那行还是 saveNovelInfo 建的
      let genOut = null;
      if (genCfgPatch !== undefined) {
        const r = db.saveGenConfig(genCfgPatch);
        genOut = r.cleared ? null : r.cfg;
      }
      res.json({
        ok: true, action: saved?.action || 'saved', version: saved?.version ?? null,
        ...(genCfgPatch !== undefined ? { genCfg: genOut, wordBand: effectiveBand(genCfgPatch) } : {}),
      });
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

  // 单章大纲草稿：只调模型生成、**不写库**，前端把结果填进输入框，人改完再点保存。
  // 为什么不复用 generateOutlinesForRange(from=to=N)：① 它只填「大纲为空」的章，已有大纲会被跳过，
  // 而在这里改大纲恰恰是「已有大纲想重写」的场景；② 它直接落库，等于不给人看过就覆盖。
  // 为什么走独立 REST 而不是 /api/run 的 action：那条路回的是给模型读的格式化文本，
  // 这里要的是能直接回填表单的 { name, outline } 两个字段。
  // 全程只读库（邻章大纲是给模型当上下文的），所以不参与按书加锁的生成任务队列。
  app.post('/api/novels/:id/chapter/:no/outline-draft', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const no = Number(req.params.no);
    if (!Number.isInteger(no) || no < 1) return res.status(400).json({ error: '章号必须是正整数' });
    const material = String(req.body?.material ?? '').trim();
    let db;
    try {
      db = createWriterDB(rr.absPath);
      const info = db.getNovelInfo() || {};
      // 没有故事概要时模型只能凭空编，产出看着完整实则与全书无关——直接说清楚缺什么
      if (!String(info.outline || '').trim()) {
        return res.status(400).json({ error: '本书还没有「故事概要」（① 设定里的第一项），无法据此构思本章大纲，请先补概要' });
      }
      if (!db.getChapter(no)) return res.status(404).json({ error: `第 ${no} 章不存在` });
      // 与生成类 action 同一道预检：链路不通时立刻报错，而不是等模型超时
      const tool = makeTool();
      tool.db = db;
      const gate = await tool._ensureLlmReachable();
      if (!gate.ok) return res.status(502).json({ error: `LLM 链路不通：${gate.detail}` });
      const brief = material ? `本章（第 ${no} 章）要写什么——用户的构思，请落实到具体情节，不要照抄原文：\n${material}` : null;
      const draft = await tool.generateSingleChapterOutlineWithLLM(no, info, brief);
      const outline = String(draft?.outline || '').trim();
      // 该方法在模型没给可用内容时会回占位语，填进输入框等于把一句空话当草稿
      if (!outline || outline === '（无大纲内容）') {
        return res.status(502).json({ error: '模型未给出可用大纲（返回为空或占位语）。输入框未改动，换个说法重试' });
      }
      const name = String(draft.name || '').trim();
      // 解析不出 JSON 时该方法把标题兜成「第N章」，那不算建议标题，别拿去覆盖现有书名
      res.json({ ok: true, no, outline, name: name && name !== `第${no}章` ? name : '' });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { try { db?.close?.(); } catch {} }
  });

  // 删除单章（自动重排后续章号）：不可撤销，与删整本一样要输 OK
  app.delete('/api/novels/:id/chapter/:no', (req, res) => {
    const denied = requireOkConfirm(req.body, `第 ${req.params.no} 章`);
    if (denied) return res.status(400).json({ error: denied });
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
    // 命令行/直连这条路同样拦住：放在上锁之前，避开为一个被拒的请求把书锁住
    if (DELETE_CHAPTER_ACTIONS.has(action)) {
      const denied = requireOkConfirm(body, `第 ${body.chapter} 章`);
      if (denied) return res.status(400).json({ error: denied });
    }

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

    // 长任务接线：进度的会话号由前端带上来（它是两个请求的关联钥匙），并用它做两件事：
    // ① 传给 WriterTool 当 sessionId，让已埋好的逐章 publish 有归属；② 按书上锁。
    const progressId = typeof body.progressId === 'string' ? body.progressId : '';
    if (progressId && !/^run:[A-Za-z0-9_-]{6,64}$/.test(progressId)) {
      return res.status(400).json({ error: 'progressId 格式非法' });
    }
    const absDb = pathFor(novel.db_file);
    if (!absDb) return res.status(400).json({ error: '小说库路径非法' });
    // 同一本书同时只允许一个生成任务：以前生成按钮在执行期间不锁，连点两次就是同一本并发跑两个生成，
    // 对自托管推理服务是实打实的压垮风险（遮罩只锁得住界面，锁不住第二个标签页/另外一台机器）。
    const needLock = LONG_ACTIONS.has(action);
    if (needLock) {
      const busy = runningTasks.get(novel.id);
      if (busy) {
        return res.status(409).json({
          error: `本书已有生成任务在跑（${busy.action}，已 ${Math.round((Date.now() - busy.startedAt) / 1000)}s），请等它结束。`,
        });
      }
      runningTasks.set(novel.id, { action, startedAt: Date.now() });
    }
    const tool = makeTool(progressId ? { sessionId: progressId } : {});
    try {
      const result = await tool.execute({ ...body, dbPath: absDb });
      if (allocatedNew) { const c = store.getNovel(novel.id) || store.createNovel({ id: novel.id, userId: req.user.id, title: novel.title, dbFile: novel.db_file, actor: req.user.username }); refreshStats(c); }
      else refreshStats(novel);
      res.json({ success: true, action, novelId: novel.id, result });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
    finally {
      if (needLock) runningTasks.delete(novel.id);
      /* 缓冲不能在这里删：SSE 是另一个请求，任务跑得越快它越可能才刚连上（甚至被 409 抢
       * 先、压根没连），此刻清掉等于把这次的逐章进度全丢掉。交给上面 60s 一轮的 TTL 回收
       * （窗口 10 分钟、单任务上限 200 行），增长仍然可控。 */
    }
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
  // 带 previewToken 时走「预览后确认发布」：以预览登记为基准重渲染，并回报漂移页
  app.post('/api/novels/:id/publish', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const userOut = path.join(OUT_ROOT, req.user.id);
    const urlBase = sitePath(encodeURIComponent(req.user.id)) + '/';
    // premakeQuiz 是“发布时跑不跑 LLM 预生成”的总开关，现在同时管测试题与生词表：
    // 调用方传 false 意味着不想让发布变慢，不该只跳过测试题而偷偷多跑三十次挑词
    const premake = req.body?.premakeQuiz !== false;
    const quizAge = Number(req.body?.quizAge) || 9;
    const title = req.body?.title || rr.novel.title;
    const token = String(req.body?.previewToken || '').trim();
    // 发布目录名 = 清洗后的书名。同名书共用一个目录时，「本次不产出的旧页」里混着另一本书的
    // 合法章节页，照常清理等于发布 A 删掉 B。所以这种情形一律不删，只在结果里说清原因。
    const conflict = preview.dirConflictOf({ ...rr.novel, title });
    try {
      let out;
      if (token) {
        out = await preview.publishFromPreview({
          absPath: rr.absPath, novel: rr.novel, outRoot: OUT_ROOT, userOut, user: req.user,
          token, title, urlBase, llmHooks: llmHooksFor(premake, quizAge), quizAge, premake,
          prune: !conflict,
        });
      } else {
        out = await publishNovelLocal(rr.absPath, userOut, {
          title,
          urlBase,
          generateQuiz: premake ? ((text, age) => generateQuiz(text, age)) : null,
          quizAge,
          pickVocab: premake ? ((text, age) => pickVocab(text, age)) : null,
          vocabAge: quizAge,
          prune: !conflict,
        });
      }
      if (conflict && !out.pruneSkipped) {
        out.pruneSkipped = `书名冲突：有 ${conflict.others.length + 1} 本书同名，共用目录「${conflict.dir}」，本次未清理旧页（以免误删另一本书的章节）`;
      }
      // 该用户的站点首页（列出其已发布作品）；VIP 标记据 global.db 实时判定
      refreshUserSiteIndex(req.user, userOut, urlBase);
      res.json({ success: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── 书页闸门（每个请求现算）：预览暂存站 + VIP 账号授权 ──
  //   ① 预览暂存站 <token>/…：只给创作者本人（或超管）看，预览链接不对外
  //   ② 站点首页：无授权读者看不到 VIP 小说条目（整条移除，而不是给个锁标的）
  //   ③ 小说子树（目录页 + 章节页）：VIP 未授权一律无权页
  // 注册在 express.static('/novel') 之前（server.js 先 registerRoutes 再挂静态），故能拦在文件下发前。
  app.use('/novel', (req, res, next) => {
    try {
      const raw = String(req.url).split('?')[0];
      const segs = raw.split('/').filter(Boolean);
      if (segs.length === 0) return next();                 // /novel, /novel/
      let uid; try { uid = decodeURIComponent(segs[0]); } catch { uid = segs[0]; }

      // ① 预览暂存站：目录名就是 16 位 hex token，查得到即预览（需登录态）
      if (preview.PREVIEW_TOKEN_RE.test(uid)) {
        const rec = store.getPreview(uid);
        if (!rec) return next();                            // 未登记/已过期 → 交给静态处理（典型 404）
        const reader = currentUser(req);
        if (!reader || (reader.id !== rec.user_id && reader.role !== 'superadmin')) {
          res.set('Cache-Control', 'no-store');
          return res.status(401).type('html').send(renderPreviewDeniedPage(raw));
        }
        return next();                                      // 预览站不参与 VIP 判定（给创作者看排版）
      }

      if (!UUID_RE.test(uid)) return next();                // 非用户站，放行
      const vmap = vipMapForUid(uid);
      if (Object.keys(vmap).length === 0) return next();    // 该站无 VIP，走静态
      const reader = currentUser(req);
      // 书主本人不受自己设定的 VIP 限制（否则作者开了 VIP 反而读不到自己的书）；
      // 其余人（含超管）一律看授权名单 —— 超管要读就在控制台给自己授一条，
      // 把“管理员”当成隐形权限会让名单失去意义。
      const allowed = (novel) => !!reader && (reader.id === novel.user_id || store.hasVipAccess(reader.id, novel.id));

      // ② 站点首页
      if (segs.length === 1 || (segs.length === 2 && segs[1] === 'index.html')) {
        const file = path.join(OUT_ROOT, uid, 'index.html');
        if (!fs.existsSync(file)) return next();
        let html = fs.readFileSync(file, 'utf8');
        html = html.replace(/<a\b[^>]*href="[^"]*\/([^/"]+)\/index\.html"[^>]*>[\s\S]*?<\/a>/g, (whole, dirEnc) => {
          let dir; try { dir = decodeURIComponent(dirEnc); } catch { dir = dirEnc; }
          const novel = vmap[dir];
          if (!novel) return whole;                         // 普通小说，保留
          return allowed(novel) ? whole : '';               // VIP：未授权整条移除
        });
        res.set('Cache-Control', 'no-store');
        return res.type('html').send(html);
      }

      // ③ 小说子树（目录页 + 章节页 + 该目录下任意文件）
      let dir; try { dir = decodeURIComponent(segs[1]); } catch { dir = segs[1]; }
      const novel = vmap[dir];
      if (novel) {
        res.set('Cache-Control', 'no-store');               // 授权态也禁缓存，保证每次进入重验
        if (!allowed(novel)) {
          return res.status(401).type('html').send(renderVipDeniedPage({ reader, backUrl: raw }));
        }
      }
      next();
    } catch { next(); }
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

  // ── 预览（发布前）：生成带 token 的暂存站 + 修改报告 ──
  // 不强制「未预览不能发布」（/publish 仍可直发），预览是一个独立动作：
  // 产物落 public/novel/<token>/<小说名>/，能像真实书页一样整本翻阅，确认后一键发布。
  app.post('/api/novels/:id/preview', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    try {
      preview.purgeExpiredPreviews(OUT_ROOT);          // 顺手回收过期暂存站，不引入定时器
      const out = await preview.createPreview({
        absPath: rr.absPath, novel: rr.novel, outRoot: OUT_ROOT, user: req.user,
        title: req.body?.title || rr.novel.title,
        // 预览默认不跑 LLM 预生成：预览看的是排版与改动，不是测试题；要验证就显式开
        premake: req.body?.premakeQuiz === true,
        quizAge: Number(req.body?.quizAge) || 9,
        llmHooks: llmHooksFor(true, Number(req.body?.quizAge) || 9),
      });
      res.json({ success: true, ...out });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 修改报告（与已发布版比对；传 token 则与那份暂存站比对）
  app.get('/api/novels/:id/preview/report', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const token = String(req.query.token || '').trim() || null;
    if (token && !preview.PREVIEW_TOKEN_RE.test(token)) return res.status(400).json({ error: '预览标识不合法' });
    // 报告默认以「线上正式目录」为基准 —— 用户要的是「这次发布会改到什么」；
    // 只有 ref=preview 才拿暂存站当基准（自查预览之后是不是又改过，即漂移）。
    // 两者别混：后者永远接近全静默（暂存站本就是同一批渲染结果），拿去当主视图会误报「无改动」。
    const ref = String(req.query.ref || 'live');
    try {
      const report = await preview.buildReport({
        absPath: rr.absPath, novel: rr.novel, outRoot: OUT_ROOT,
        title: req.query.title || rr.novel.title, compareToToken: ref === 'preview' ? token : null,
      });
      res.json({ success: true, report });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 单页 diff：暂存版 vs 线上版（正文句级 diff + 翻页链接/章号变化）
  app.get('/api/novels/:id/preview/:token/diff', async (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    const file = String(req.query.file || '').trim();
    if (!/^[\w.-]+\.html$/.test(file) || file.includes('..')) return res.status(400).json({ error: '缺少或非法的 file 参数' });
    try {
      const out = await preview.getPageDiff({ novel: rr.novel, outRoot: OUT_ROOT, token: req.params.token, file });
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json({ success: true, ...out });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // 作废预览（删除暂存目录与登记行）
  app.delete('/api/novels/:id/preview/:token', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    try {
      const rec = store.getPreview(req.params.token);
      if (rec && rec.novel_id !== rr.novel.id && req.user.role !== 'superadmin') {
        return res.status(403).json({ error: '该预览不属于本小说' });
      }
      if (rec) preview.removePreviewDir(OUT_ROOT, req.params.token);
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── VIP 属性（本书是否 VIP）+ 已授权读者名单；授权本身在 /api/admin/vip 管理 ──
  app.get('/api/novels/:id/vip', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    res.json({ vip: !!rr.novel.vip, grants: store.listVipGrants({ novelId: rr.novel.id }) });
  });
  app.put('/api/novels/:id/vip', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    if (req.body?.password !== undefined) {
      return res.status(410).json({ error: 'VIP 密码机制已停用：请改用 { vip: true/false } 开关，读者授权在控制台 VIP 管理区进行' });
    }
    try {
      const n = store.setNovelVip(rr.novel.id, !!req.body?.vip, req.user.username);
      res.json({ ok: true, vip: !!n.vip });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/novels/:id/vip', (req, res) => {
    const rr = resolveNovelForUser(req.params.id, req.user);
    if (!rr.ok) return res.status(rr.status).json({ error: rr.error });
    try {
      store.setNovelVip(rr.novel.id, false, req.user.username);
      res.json({ ok: true, vip: false });
    } catch (e) { res.status(400).json({ error: e.message }); }
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
    /* 删章节从 AI 这条路进来也要确认：管理页的「确认执行」卡片就是那次人工确认，
     * 由 aiExecute 随请求带上 confirm:'OK'；绕过界面直打这个端点同样会被拦下。 */
    if (tool === 'deleteChapter') {
      const denied = requireOkConfirm(req.body, `第 ${args.chapter} 章`);
      if (denied) return res.status(400).json({ error: denied });
    }
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

  // ── VIP 读者授权管理（超管）──
  // 一张名单说了算：novel.vip 决定“这本书要不要授权”，vip_grant 决定“谁能读”。
  app.get('/api/admin/vip', requireSuperadmin, (_req, res) => {
    res.json({
      grants: store.listVipGrants({ includeRevoked: true }),
      vipNovels: store.listAllNovels().filter(n => n.vip).map(n => ({ id: n.id, title: n.title, userId: n.user_id, chapterCount: n.chapter_count })),
      users: store.listUsers(),
      ttl: store.PREVIEW_TTL,
    });
  });
  app.post('/api/admin/vip/grant', requireSuperadmin, (req, res) => {
    try {
      const g = store.grantVip({
        username: req.body?.username, userId: req.body?.userId,
        novelId: req.body?.novelId || null,
        expiresAt: resolveGrantExpiry(req.body),
        note: req.body?.note, actor: req.user.username,
      });
      res.json({ ok: true, grant: g });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.delete('/api/admin/vip/:id', requireSuperadmin, (req, res) => {
    try { res.json({ ok: true, grant: store.revokeVipGrant(req.params.id, req.user.username) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/admin/vip/:id/restore', requireSuperadmin, (req, res) => {
    try { res.json({ ok: true, grant: store.restoreVipGrant(req.params.id, req.user.username) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });

  // ── 推理服务连接（超管）：管理/切换连到 aibridge 的哪条 API Key，运行时生效不用重启 ──
  /* 本前缀的响应按设计不过 scrub 净化（要回显地址），所以明文密钥绝不能出现在
   * 任何返回值里。bridgeStore 的出参已是脱敏形态（只有 prefix），不要把
   * secretOf() 的返回值往 res.json 里塞。 */
  app.get('/api/admin/bridge', requireSuperadmin, (_req, res) => {
    res.json({ ok: true, ...bridgeStore.listPublic() });
  });
  app.post('/api/admin/bridge/keys', requireSuperadmin, async (req, res) => {
    const r = bridgeStore.add({ name: req.body?.name, key: req.body?.key });
    if (r.error) return res.status(400).json({ error: r.error });
    // 存完立刻验一次：列表第一次刷新就能显示「连到哪个模型」，不用用户再手动点测试
    if (r.item?.id) await bridgeStore.test(r.item.id);
    res.json({ ok: true, item: r.item, probe: bridgeStore.listPublic().keys.find(k => k.id === r.item.id)?.probe || null });
  });
  app.put('/api/admin/bridge/keys/:id/active', requireSuperadmin, (req, res) => {
    // body.active === false 表示「不要控制台选了，回落 .env / 环境变量」
    const id = req.body?.active === false ? null : req.params.id;
    const r = bridgeStore.activate(id);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, current: bridgeStore.listPublic().current });
  });
  app.post('/api/admin/bridge/keys/:id/test', requireSuperadmin, async (req, res) => {
    const r = await bridgeStore.test(req.params.id);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json(r);
  });
  app.put('/api/admin/bridge/keys/:id/name', requireSuperadmin, (req, res) => {
    const r = bridgeStore.rename({ id: req.params.id, name: req.body?.name });
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true });
  });
  app.delete('/api/admin/bridge/keys/:id', requireSuperadmin, (req, res) => {
    const r = bridgeStore.remove(req.params.id);
    if (r.error) return res.status(404).json({ error: r.error });
    res.json({ ok: true, wasActive: r.wasActive, current: bridgeStore.listPublic().current });
  });
  app.put('/api/admin/bridge/url', requireSuperadmin, (req, res) => {
    const r = bridgeStore.setUrl(req.body?.url);
    if (r.error) return res.status(400).json({ error: r.error });
    res.json({ ok: true, current: bridgeStore.listPublic().current });
  });
  /* 桥接服务本身可达吗（GET /api/health：不带密钥、不消耗 token）*/
  app.post('/api/admin/bridge/ping', requireSuperadmin, async (_req, res) => {
    res.json(await llm.checkReachable());
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
    case 'addChaptersBulk': {
      // 一次加多章只走这一条：逐章 add 不是原子的，而且章号由调用方记，第二批会把前面的推移叠错
      if (!Array.isArray(args.chapters) || args.chapters.length === 0) {
        throw new Error('addChaptersBulk 需要 chapters 数组（每项至少含 outline）');
      }
      const out = await run('addChaptersBulk', { chapters: args.chapters, anchor: args.anchor || { mode: 'tail' } });
      refreshStats(rr.novel);
      return out;
    }
    case 'generateChapter': { const out = await run('generate', { chapter: Number(args.chapter || 0), force: !!args.force }); refreshStats(rr.novel); return out; }
    case 'generateOutlinesForRange': {
      // 只透传：count（先插占位章）与 from/to（只回填）互斥、上限、区间收敛都在工具里判，这里不重复一套规则
      const out = await run('generateOutlinesForRange', {
        from: args.from, to: args.to, count: args.count, anchor: args.anchor, material: args.material,
      });
      refreshStats(rr.novel);
      return out;
    }
    case 'modifyChapter': {
      if (!args.modifyInstructions) throw new Error('modifyChapter 需要 modifyInstructions');
      return await run('modify', { chapter: Number(args.chapter), modifyInstructions: args.modifyInstructions });
    }
    case 'setGenConfig': return await run('setGenConfig', { genCfg: args.genCfg });
    case 'tuneWordCount': {
      // 只透传：dryRun 默认 true、无目标字数时报错指路，都在工具里判；
      // 章数会因拆章而变，所以跑完要刷统计表
      const out = await run('tuneWordCount', {
        dryRun: args.dryRun, from: args.from, to: args.to,
      });
      refreshStats(rr.novel);
      return out;
    }
    // 重建大纲属破坏性操作，Web 会话无确认卡片，只认调用方显式传的 force（否则工具内关卡会直接中止）
    case 'generateOutlines': return await run('generateChapterOutlines', { totalChapters: Number(args.totalChapters || 10), force: !!args.force });
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
