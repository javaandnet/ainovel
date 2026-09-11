/**
 * 发布前预览（暂存站点 + 修改报告 + 连带影响分析）
 *
 * 为什么需要它：发布是「整本一次性覆盖线上静态页」，改一章可能牵连别章
 * （插章导致章号重排、相邻章上下章链接变化、目录页与分部导言重新生成）。
 * 过去只能发布后靠肉眼回看，错了再重发。这里把「将要发布成什么样」先落成一个
 * 带 token 的暂存站点（结构与线上一致，可真实翻阅/朗读），并与线上现页逐页比对，
 * 产出修改报告：哪些页改了、改了多少、是主动改还是被牵连。
 *
 * 比较口径：一律取页面正文容器去掉 <h1> 大标题与分部 kicker 后的纯文本
 * （见 contentForDiff），这样「章号顺延」不会被算成正文改动，报告里单独作为
 * 标题变化列出。内嵌的 quiz/生词 JSON 也不参与比较（它跟着正文走，不是内容）。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { renderNovelPages, extractContentHtml, sanitizeDirName, publishSiteIndexLocal, pruneLocalOrphanPages } from '../skills/novelPublisher/publish.js';
import { diffText, htmlToText } from '../utils/textDiff.js';
import { BASE_PATH } from '../base.js';
import * as store from '../auth/userStore.js';

const TOKEN_RE = /^[0-9a-f]{16}$/;

/** 暂存站目录：<OUT_ROOT>/<token>/<小说名>/…，与线上 <OUT_ROOT>/<uid>/<小说名>/… 同构 */
function stageRoot(outRoot, token) {
  return path.join(outRoot, String(token));
}
function novelRoot(root, novelDir) {
  return path.join(root, String(novelDir));
}

/** 正文比较口径：去大标题与分部 kicker，只留真正的行文 */
function contentForDiff(html) {
  const inner = String(extractContentHtml(html) || '')
    .replace(/<h1[\s\S]*?<\/h1>/i, ' ')
    .replace(/<p class="part-kicker[\s\S]*?<\/p>/i, ' ');
  return htmlToText(inner);
}

/** 从线上页 HTML 还原可比对的元信息（书名 - 第N章：章名 / 上下章指向） */
function parsePageHtml(html, filename) {
  const s = String(html || '');
  const titleTag = (s.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
  const label = titleTag.includes(' - ') ? titleTag.slice(titleTag.lastIndexOf(' - ') + 3) : titleTag;
  const navs = [...s.matchAll(/<a href="([^"]+)">(←\s*上一章|下一章\s*→)<\/a>/g)];
  const prev = navs.find(m => m[2].startsWith('←'))?.[1] || null;
  const next = navs.find(m => m[2].startsWith('下一章'))?.[1] || null;
  const mNum = label.match(/^第\s*(\d+)\s*章(?:\s*[：:]\s*(.*))?$/);
  return {
    filename,
    title: titleTag,
    label,
    chapterNum: mNum ? Number(mNum[1]) : null,
    bareTitle: mNum && mNum[2] ? mNum[2].trim() : '',
    prev, next,
    contentText: contentForDiff(s),
  };
}

/** 读线上（或暂存）目录里的全部页面元信息 */
function readPageDir(dir) {
  const out = new Map();
  if (!dir || !fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.html')) continue;
    let html = '';
    try { html = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    out.set(name, parsePageHtml(html, name));
  }
  return out;
}

/** 目录页条目：href → 「第N章：章名」，用于解释目录发生了什么变化 */
function readIndexEntries(dir) {
  const file = path.join(dir, 'index.html');
  if (!fs.existsSync(file)) return null;
  let html = '';
  try { html = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const list = [...html.matchAll(/<a class="(?:chapter-link|preface-link|part-name)" href="([^"]+)">([\s\S]*?)<\/a>/g)];
  return list.map(m => ({ href: m[1], text: htmlToText(m[2]) }));
}

function pageKindOf(filename) {
  if (filename === 'index.html') return 'index';
  if (filename.startsWith('chapter_')) return 'chapter';
  return 'page';
}

/**
 * 同名书目录冲突检测：发布目录名就是清洗后的书名，两本同名书会写进同一个目录。
 *
 * 为什么预览与发布必须知道这件事：共用目录时，本次不产出的文件里混着“另一本书的合法章节页”，
 * 若照常清理旧页，发布 A 会把 B 的章节删掉。检测到冲突一律只提示不删，
 * 把既有缺陷的破坏面锁住（目录命名规则本身属于更大的改动，不在预览这一层顺手改）。
 * @returns {null|{dir:string, others:Array<{id:string, title:string}>}}
 */
export function dirConflictOf(novel) {
  if (!novel || !novel.user_id) return null;
  const dir = sanitizeDirName(novel.title || '小说');
  if (!dir) return null;
  const others = store.listNovelsByUser(novel.user_id)
    .filter((n) => n.id !== novel.id && sanitizeDirName(n.title || '小说') === dir)
    .map((n) => ({ id: n.id, title: n.title }));
  return others.length ? { dir, others } : null;
}

/**
 * 生成修改报告：渲染本次产物（不调 LLM）与线上现页比对。
 * @param {Object} p
 * @param {string} p.absPath   - 小说库绝对路径
 * @param {Object} p.novel     - global.db 的 novel 行（含 user_id / title）
 * @param {string} p.outRoot   - public/novel
 * @param {string} [p.title]   - 覆盖书名（一般不传，取库内书名）
 * @param {string} [p.compareToToken] - 与该暂存站比对（默认与线上正式目录比）
 * @returns {Promise<Object>} 报告
 */
export async function buildReport({ absPath, novel, outRoot, title, compareToToken = null }) {
  const rendered = await renderNovelPages(absPath, { title });
  const ownerUid = novel.user_id;
  const liveDir = novelRoot(novelRoot(outRoot, ownerUid), rendered.novelDir);
  // 与暂存站比时以登记时的目录名为准：书名改过也不会把基准读到不存在的目录。
  const stageDir = compareToToken
    ? novelRoot(stageRoot(outRoot, compareToToken), store.getPreview(compareToToken)?.novel_dir || rendered.novelDir)
    : null;
  const baseDir = stageDir || liveDir;
  const oldPages = readPageDir(baseDir);
  const oldIndexEntries = readIndexEntries(baseDir);

  const newPages = new Map();
  for (const p of rendered.pages) {
    newPages.set(p.filename, {
      filename: p.filename,
      title: p.title,
      label: p.label,
      chapterNum: p.chapterNum,
      bareTitle: (() => { const m = String(p.label || '').match(/^第\s*\d+\s*章(?:\s*[：:]\s*(.*))?$/); return m && m[1] ? m[1].trim() : ''; })(),
      prev: p.prevFilename,
      next: p.nextFilename,
      contentText: contentForDiff(p.html),
      kind: p.kind,
    });
  }

  const order = rendered.pages.map(p => p.filename);
  // 书名冲突（多本同名书共用一个发布目录）先算出来：它改变「不产出的页」的含义与处置方式。
  const dirConflict = dirConflictOf(novel);
  // 只把「发布确实会删掉」的渲染产物算作下线页（与 pruneLocalOrphanPages 同一判定规则），
  // 否则目录里人工放的 html 会被报告说成“将下线”而实际依旧留着，两端口径对不上。
  const removedFiles = [...oldPages.keys()].filter(f => !newPages.has(f) && /^(chapter|page)_.*\.html$/.test(f));
  const fileNames = [...order, ...removedFiles];

  const items = [];
  const totals = { added: 0, modified: 0, unchanged: 0, removed: 0, sentencesAdded: 0, sentencesRemoved: 0, charsDelta: 0, cascadeOnly: 0 };
  const reNumbered = [];
  const renamed = [];

  for (const filename of fileNames) {
    const nw = newPages.get(filename) || null;
    const old = oldPages.get(filename) || null;
    const kind = nw ? (nw.kind || pageKindOf(filename)) : pageKindOf(filename);
    const state = !old ? 'added' : (!nw ? 'removed' : 'present');
    const reasons = [];
    let stats = null;
    let diffAvailable = false;

    if (state === 'added') {
      reasons.push({ code: 'added', text: nw && nw.contentText ? '新增页面（本次首次发布）' : '新增页面' });
      totals.added++;
    } else if (state === 'removed') {
      reasons.push({
        code: 'removed',
        text: dirConflict
          ? '线上存在但本次不再产出。因有同名书共用发布目录，本页可能属于另一本书，本次发布不会删除它（先改书名再发布才能清理）'
          : '线上存在但本次不再产出（该章已删除，或书名/分部结构调整后文件名变化）：确认发布时会从线上删掉该页',
      });
      totals.removed++;
    } else {
      const contentChanged = (old.contentText || '') !== (nw.contentText || '');
      const numChanged = old.chapterNum != null && nw.chapterNum != null && old.chapterNum !== nw.chapterNum;
      const nameChanged = String(old.bareTitle || '') !== String(nw.bareTitle || '');
      const navChanged = old.prev !== nw.prev || old.next !== nw.next;

      if (contentChanged) {
        const d = diffText(old.contentText, nw.contentText);
        stats = d.stats;
        diffAvailable = true;
        reasons.push({
          code: 'content',
          text: `正文改动：新增 ${d.stats.added} 句 / 删除 ${d.stats.removed} 句，字数 ${d.stats.charsOld} → ${d.stats.charsNew}（${d.stats.charsDelta >= 0 ? '+' : ''}${d.stats.charsDelta} 字）`,
        });
        totals.sentencesAdded += d.stats.added;
        totals.sentencesRemoved += d.stats.removed;
        totals.charsDelta += d.stats.charsDelta;
      }
      if (numChanged) {
        reasons.push({ code: 'renumber', text: `章号顺延：第${old.chapterNum}章 → 第${nw.chapterNum}章（正文未改，因前序章节增删导致重新编号）` });
        reNumbered.push({ filename, from: old.chapterNum, to: nw.chapterNum, label: nw.label });
      }
      if (nameChanged) {
        reasons.push({ code: 'rename', text: `章名变更：${old.bareTitle || '（无）'} → ${nw.bareTitle || '（无）'}` });
        renamed.push({ filename, from: old.bareTitle, to: nw.bareTitle });
      }
      if (navChanged) {
        const fmt = (x) => (!x ? '无' : (newPages.get(x)?.label || oldPages.get(x)?.label || x));
        reasons.push({
          code: 'nav',
          text: `翻页链接变化：上一章 ${fmt(old.prev)} → ${fmt(nw.prev)}；下一章 ${fmt(old.next)} → ${fmt(nw.next)}（相邻章节有增删或顺序调整）`,
        });
      }
      if (contentChanged) totals.modified++;
      else if (reasons.length) totals.cascadeOnly++;
      else totals.unchanged++;
    }

    items.push({
      filename,
      kind,
      state,
      label: (nw && nw.label) || (old && old.label) || filename,
      chapterNum: nw ? nw.chapterNum : (old ? old.chapterNum : null),
      oldLabel: old ? old.label : null,
      newLabel: nw ? nw.label : null,
      reasons,
      stats,
      diffAvailable,
      // 连带影响：本页正文一字未改，只因别处改动而变
      cascade: state === 'present' && !reasons.some(r => r.code === 'content'),
      removed: state === 'removed',
    });
  }

  // 目录页（index.html）单独判定：条目增删 / 章号变化
  const newIndexText = contentForDiffOrRaw(rendered.indexHtml);
  const oldIndexFile = baseDir ? path.join(baseDir, 'index.html') : null;
  let indexChanged = true;
  if (oldIndexFile && fs.existsSync(oldIndexFile)) {
    indexChanged = newIndexText !== contentForDiffOrRaw(fs.readFileSync(oldIndexFile, 'utf8'));
  }
  const indexDiff = compareIndexEntries(oldIndexEntries, readIndexEntriesFromHtml(rendered.indexHtml));

  const notes = buildNotes({ items, reNumbered, renamed, indexDiff, published: fs.existsSync(path.join(liveDir, 'index.html')), removedFiles, totals, dirConflict });
  if (dirConflict) {
    notes.push(`⚠️ 书名冲突：共有 ${dirConflict.others.length + 1} 本书同名，共用发布目录「${dirConflict.dir}」——它们的页面混在同一目录里，本次已跳过旧页清理以免误删另一本书的章节。建议先把书名改得不一样再发布。`);
  }

  return {
    novel: { id: novel.id, title: rendered.novelTitle, dir: rendered.novelDir, ownerUid },
    // 前端据此判断能不能真删旧页（冲突时仅提示，不拿旧页数量当“将删除”保证）
    dirConflict,
    generatedAt: Date.now(),
    baseline: compareToToken ? { mode: 'preview', ref: compareToToken } : { mode: 'published', published: fs.existsSync(path.join(liveDir, 'index.html')) },
    summary: {
      pages: items.length,
      chapters: rendered.chapterCount,
      added: totals.added,
      modified: totals.modified,
      unchanged: totals.unchanged,
      removed: totals.removed,
      cascadeOnly: totals.cascadeOnly,
      sentencesAdded: totals.sentencesAdded,
      sentencesRemoved: totals.sentencesRemoved,
      charsDelta: totals.charsDelta,
      indexChanged,
      reNumbered: reNumbered.length,
      renamed: renamed.length,
    },
    notes,
    indexDiff,
    items,
  };
}

function readIndexEntriesFromHtml(html) {
  const list = [...String(html || '').matchAll(/<a class="(?:chapter-link|preface-link|part-name)" href="([^"]+)">([\s\S]*?)<\/a>/g)];
  return list.map(m => ({ href: m[1], text: htmlToText(m[2]) }));
}
function contentForDiffOrRaw(html) {
  const inner = extractContentHtml(html);
  return htmlToText(inner || html);
}

/** 目录条目差异：按 href（稳定文件名）对齐，给出增删与标题变化 */
function compareIndexEntries(oldEntries, newEntries) {
  const a = oldEntries || [];
  const b = newEntries || [];
  const mapA = new Map(a.map(e => [e.href, e.text]));
  const mapB = new Map(b.map(e => [e.href, e.text]));
  const added = b.filter(e => !mapA.has(e.href)).map(e => e.text);
  const removed = a.filter(e => !mapB.has(e.href)).map(e => e.text);
  const changed = b.filter(e => mapA.has(e.href) && mapA.get(e.href) !== e.text).map(e => ({ from: mapA.get(e.href), to: e.text }));
  return { added, removed, changed, orderSame: a.filter(e => mapB.has(e.href)).map(e => e.href).join(',') === b.filter(e => mapA.has(e.href)).map(e => e.href).join(',') };
}

/** 报告结论段：一句话讲清「改了什么、牵连了谁」 */
function buildNotes({ items, reNumbered, renamed, indexDiff, published, removedFiles, totals, dirConflict }) {
  const notes = [];
  const direct = items.filter(i => i.reasons.some(r => r.code === 'content'));
  const addedChapters = items.filter(i => i.state === 'added' && i.kind === 'chapter');
  if (!published) notes.push('线上尚无本书的已发布页面：本次为首次发布，全部页面按新增处理。');
  if (addedChapters.length) notes.push(`新增章节 ${addedChapters.length} 章：${addedChapters.map(i => i.label).join('、')}。`);
  if (removedFiles.length && dirConflict) {
    notes.push(`线上有 ${removedFiles.length} 个页面本次不再产出，但因书名冲突共用目录，本次发布不会删除它们（其中可能有另一本同名书的正常章节）：${removedFiles.join('、')}。`);
  } else if (removedFiles.length) {
    notes.push(`将下线并在发布时删除 ${removedFiles.length} 个页面（对应章节已删除或结构调整）：${removedFiles.join('、')}。`);
  }
  if (direct.length) notes.push(`正文实际改动 ${direct.length} 页：${direct.map(i => i.label).join('、')}。`);
  if (reNumbered.length) notes.push(`章号顺延 ${reNumbered.length} 页（正文未改）：${reNumbered.slice(0, 8).map(i => `第${i.from}章→第${i.to}章`).join('，')}${reNumbered.length > 8 ? ' 等' : ''}。`);
  if (renamed.length) notes.push(`章名变更 ${renamed.length} 页：${renamed.slice(0, 8).map(i => `《${i.from || '无'}》→《${i.to || '无'}》`).join('，')}${renamed.length > 8 ? ' 等' : ''}。`);
  const navOnly = items.filter(i => i.cascade && i.reasons.some(r => r.code === 'nav'));
  if (navOnly.length) notes.push(`翻页链接受影响 ${navOnly.length} 页：${navOnly.map(i => i.label).join('、')}（自身正文未变，因相邻章节增删导致上一章/下一章指向变化）。`);
  if (indexDiff.added.length || indexDiff.removed.length || indexDiff.changed.length || !indexDiff.orderSame) {
    notes.push('目录页将重新生成：条目增删或章号/章名变化。');
  }
  if (totals.cascadeOnly) notes.push(`其中 ${totals.cascadeOnly} 页属于「连带影响」（正文一字未改，只因别处改动而变化）。`);
  if (!notes.length || (totals.added === 0 && totals.modified === 0 && totals.removed === 0 && totals.cascadeOnly === 0)) {
    if (!published) return notes;
    notes.push('与线上完全一致，本次发布不会产生任何页面变化。');
  }
  return notes;
}

/**
 * 生成暂存预览站：渲染（默认不跑 LLM 预生成）后写入 <outRoot>/<token>/<小说名>/，
 * 并生成该暂存站的首页，返回 token 与可翻阅地址。
 */
export async function createPreview({ absPath, novel, outRoot, user, title, premake = false, quizAge = 9, llmHooks = null }) {
  const token = crypto.randomBytes(8).toString('hex');
  const options = { title };
  if (premake && llmHooks) {
    options.generateQuiz = llmHooks.generateQuiz;
    options.pickVocab = llmHooks.pickVocab;
    options.quizAge = quizAge;
    options.vocabAge = quizAge;
  }
  const rendered = await renderNovelPages(absPath, options);

  const root = stageRoot(outRoot, token);
  const dir = novelRoot(root, rendered.novelDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const p of rendered.pages) fs.writeFileSync(path.join(dir, p.filename), p.html, 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.html'), rendered.indexHtml, 'utf-8');

  // 暂存站首页：与线上站点首页同一生成函数，读者端观感一致
  try {
    publishSiteIndexLocal(
      [{ dirName: rendered.novelDir, title: rendered.novelTitle, chapterCount: rendered.chapterCount, vip: false, novelId: novel.id }],
      root,
      `${BASE_PATH}/${token}`,
      ''
    );
  } catch { /* 暂存首页失败不影响单本预览 */ }

  store.registerPreview({ token, novelId: novel.id, userId: user.id, novelDir: rendered.novelDir });

  const report = await buildReport({ absPath, novel, outRoot, title });
  const previewUrl = `${BASE_PATH}/${token}/${encodeURIComponent(rendered.novelDir)}/index.html`;
  return { token, previewUrl, novelDir: rendered.novelDir, chapterCount: rendered.chapterCount, report };
}

/** 暂存目录整体删除（幂等：只认登记表里的 token，绝不盲删未知目录） */
export function removePreviewDir(outRoot, token) {
  if (!TOKEN_RE.test(String(token || ''))) throw new Error('预览标识不合法');
  const root = stageRoot(outRoot, token);
  try { if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true }); } catch { /* 已被外部清理 */ }
  store.removePreview(token);
}

/** 清过期预览（服务内按需触发，不引入定时器） */
export function purgeExpiredPreviews(outRoot) {
  let removed = 0;
  for (const p of store.listExpiredPreviews()) {
    try { removePreviewDir(outRoot, p.token); removed++; } catch { /* 跳过 */ }
  }
  return removed;
}

/**
 * 清掉某书的全部暂存预览（删除小说前调用）。
 * 必须在 store.deleteNovel 之前跑：登记行被删后就查不到这些 token，暂存目录会留在磁盘上没人认领。
 */
export function purgePreviewsOfNovel(outRoot, novelId) {
  let removed = 0;
  for (const p of store.listPreviewsByNovel(novelId)) {
    try { removePreviewDir(outRoot, p.token); removed++; } catch { /* 目录已不在，登记行仍会被清 */ }
  }
  return removed;
}

/** 单页 diff：暂存版 vs 线上版（两者都由本模块产出/解析，口径一致） */
export async function getPageDiff({ novel, outRoot, token, file }) {
  const ownerUid = novel.user_id;
  const dirName = sanitizeDirName(novel.title || '小说');
  if (!TOKEN_RE.test(String(token || ''))) throw new Error('预览标识不合法');
  const rec = store.getPreview(token);
  if (!rec || rec.novel_id !== novel.id) throw new Error('预览不存在或已过期，请重新生成预览');
  const stagedFile = path.join(novelRoot(stageRoot(outRoot, token), rec.novel_dir || dirName), String(file));
  const liveFile = path.join(outRoot, ownerUid, dirName, String(file));
  if (!fs.existsSync(stagedFile)) return { error: '暂存页不存在（可能书名已改，请重新预览）', status: 404 };
  const newHtml = fs.readFileSync(stagedFile, 'utf8');
  const newPage = parsePageHtml(newHtml, String(file));
  const oldExists = fs.existsSync(liveFile);
  const oldPage = oldExists ? parsePageHtml(fs.readFileSync(liveFile, 'utf8'), String(file)) : null;
  const d = diffText(oldPage ? oldPage.contentText : '', newPage.contentText);
  return {
    file: String(file),
    state: oldPage ? (d.stats.added + d.stats.removed ? 'modified' : 'unchanged') : 'added',
    old: oldPage ? { label: oldPage.label, prev: oldPage.prev, next: oldPage.next } : null,
    current: { label: newPage.label, prev: newPage.prev, next: newPage.next },
    stats: d.stats,
    ops: d.ops,
  };
}

/**
 * 预览后确认发布：以预览时的渲染结果为基准重新出页（补跑 quiz/生词预生成），
 * 并校验正文与预览是否仍一致 —— 不一致说明预览后又改过，返回值里列出漂移页，
 * 让调用方知道「发出去的东西与刚才看到的不完全相同」，而不是默默混在一起。
 * @param {string} p.userOut - 发布写入根目录（<public/novel>/<uid>），与 publishNovelLocal 同口径
 * @param {string} p.outRoot - 暂存站所在根目录（<public/novel>），用于回读预览产物做漂移校验
 */
export async function publishFromPreview({ absPath, novel, outRoot, userOut, user, token, title, urlBase, llmHooks = null, quizAge = 9, premake = true, prune = true }) {
  const rec = store.getPreview(String(token || ''));
  if (!rec || rec.novel_id !== novel.id) throw new Error('预览不存在或不属于本小说，请重新生成预览');
  if (rec.expires_at && rec.expires_at < Date.now()) throw new Error('预览已过期，请重新生成预览后再发布');

  const options = { title, urlBase };
  if (premake && llmHooks) {
    options.generateQuiz = llmHooks.generateQuiz;
    options.pickVocab = llmHooks.pickVocab;
    options.quizAge = quizAge;
    options.vocabAge = quizAge;
  }
  const rendered = await renderNovelPages(absPath, options);
  const stagedDir = novelRoot(stageRoot(outRoot, rec.token), rec.novel_dir || rendered.novelDir);
  const drifted = [];
  if (fs.existsSync(stagedDir)) {
    for (const p of rendered.pages) {
      const f = path.join(stagedDir, p.filename);
      if (!fs.existsSync(f)) { drifted.push(p.filename); continue; }
      if (contentForDiff(p.html) !== contentForDiff(fs.readFileSync(f, 'utf8'))) drifted.push(p.filename);
    }
  } else {
    drifted.push('(暂存目录缺失，本次为重新渲染)');
  }

  const targetDir = novelRoot(userOut, rendered.novelDir);
  fs.mkdirSync(targetDir, { recursive: true });
  for (const p of rendered.pages) fs.writeFileSync(path.join(targetDir, p.filename), p.html, 'utf-8');
  fs.writeFileSync(path.join(targetDir, 'index.html'), rendered.indexHtml, 'utf-8');
  // 与报告同口径：预览里判定为「不再产出」的旧页，确认发布时一并删掉
  // （护栏基准是发布根 userOut；本函数的 outRoot 是暂存根，不能传错）
  // prune=false：书名冲突时调用方禁用清理，否则会删掉另一本同名书的章节页
  const files = [...rendered.pages.map(p => p.filename), 'index.html'];
  const pruned = prune ? pruneLocalOrphanPages(targetDir, files, userOut) : [];

  store.updateNovelMeta(novel.id, { title: rendered.novelTitle, chapterCount: rendered.chapterCount });
  const indexUrl = `${String(urlBase ?? BASE_PATH).replace(/\/+$/, '')}/${rendered.novelDir}/index.html`;
  return {
    novelDir: rendered.novelDir,
    indexUrl,
    chapterCount: rendered.chapterCount,
    files,
    pruned,
    pruneSkipped: prune ? null : '书名冲突：多本同名书共用发布目录，本次未清理旧页（以免误删另一本书的章节）',
    fromPreview: rec.token,
    drifted,
  };
}

export { TOKEN_RE as PREVIEW_TOKEN_RE };
