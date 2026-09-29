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
 * DB 是索引不是权威：路径能由 hash 推出，所以库打不开时一律退回按文件认，
 * 绝不能因为「入不了库」就把已经合成好的音频判成失败。
 *
 * 产物落盘后还要裁一道首尾静音（见 trimFile）：微软边缘接口每条音频都自带
 * 约 0.15s 头静音 + 0.67s 尾静音（按音色固定，实测 45 条），逐句朗读时每个句界
 * 白等约 0.84s，听感就是「两句之间断一下」。裁剪是无损整帧丢弃，且把实际留下的
 * 尾部留白 tailPadMs 一并记库、随接口回给前端，前端据此决定何时跨句。
 *
 * 合成引擎：msedge-tts（Node 端口，纯 JS，走微软公开边缘接口，免 key）。
 * 该接口对同一来源的并发连接很敏感（一句一发 WebSocket，整章上百句齐发容易被限流），
 * 因此进程内收一道并发闸 + 同句去重 + 失败退避重试一次；对外仍不抛异常，
 * 只回 { ok:false, error }，由调用方降级为浏览器 speechSynthesis。
 */
import Database from 'better-sqlite3';
import { GLOBAL_DB } from '../auth/userStore.js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { parse as mp3Parse, cut as mp3Cut } from './mp3Cut.js';
import { probeSilence, ffmpegAvailable } from './silenceProbe.js';
import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TTS_ROOT = path.resolve(__dirname, '../../data/tts');

/* 裁剪后刻意保留的静音余量：头部留一点，第一个字不至于被吃掉；
   尾部留多少就是句间的天然停顿下限（跨句时机 = 时长 - tailPadMs + 读者设的留白）。 */
const TRIM_ON = process.env.TTS_TRIM !== '0';
const TRIM_HEAD_KEEP = Math.max(0, Number(process.env.TTS_TRIM_HEAD_MS ?? 30));
const TRIM_TAIL_KEEP = Math.max(0, Number(process.env.TTS_TRIM_TAIL_MS ?? 120));

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
        last_accessed INTEGER,
        tail_pad_ms INTEGER
      )
    `);
    /* 老库补列：已存在会抛 duplicate column，属正常，吞掉即可 */
    try { d.exec('ALTER TABLE reader_tts_audio ADD COLUMN tail_pad_ms INTEGER'); } catch { /* 已有该列 */ }
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

/** 固定落点：data/tts/<hash[:2]>/<hash>.mp3（DB 只是索引，路径本身可由 hash 推出） */
function destOf(hash) {
  return path.join(TTS_ROOT, hash.slice(0, 2), `${hash}.mp3`);
}

/** DB 不可用时的兜底：直接按固定落点认文件。
 *  纯文件认不出 tailPadMs（它存在库里），前端拿不到就退化成「等 ended 再跨句」，
 *  照样能听，只是句间多留那 120ms 的余量 —— 宁可保守也不能猜错切点。 */
function cachedByFile(hash) {
  try {
    const abs = destOf(hash);
    if (!fs.existsSync(abs)) return null;
    return { filePath: abs, bytes: fs.statSync(abs).size, tailPadMs: null };
  } catch {
    return null;
  }
}

/**
 * 读已缓存音频。命中时刷新 last_accessed。
 * @returns {{filePath: string, bytes: number, tailPadMs: number|null}|null} 未命中（库与文件都没有）返回 null
 */
export function getCached(hash) {
  const d = db();
  if (!d) return cachedByFile(hash);
  try {
    const row = d.prepare('SELECT file_path, bytes, tail_pad_ms FROM reader_tts_audio WHERE hash = ?').get(hash);
    if (!row || !row.file_path) return cachedByFile(hash);
    const absPath = path.join(TTS_ROOT, row.file_path);
    if (!fs.existsSync(absPath)) {
      // 文件丢失，删 DB 记录
      d.prepare('DELETE FROM reader_tts_audio WHERE hash = ?').run(hash);
      return null;
    }
    d.prepare('UPDATE reader_tts_audio SET last_accessed = ? WHERE hash = ?').run(Date.now(), hash);
    return { filePath: absPath, bytes: row.bytes, tailPadMs: row.tail_pad_ms == null ? null : Number(row.tail_pad_ms) };
  } catch (err) {
    console.warn(`[ttsStore] getCached 失败（改按文件查）：${err.message}`);
    return cachedByFile(hash);
  }
}

/**
 * 把合成产物摆到固定落点，并尽量记进 DB。
 * 文件落盘是主、DB 是次：库不可用或写入出错都不算失败（下次按文件照样能命中）。
 * @returns {string|null} 成功返回绝对路径，落盘失败返回 null
 */
export function saveAudio(hash, voice, rate, absFilePath, bytes) {
  const absDest = destOf(hash);
  try {
    fs.ensureDirSync(path.dirname(absDest));
    if (path.resolve(absFilePath) !== absDest) fs.moveSync(absFilePath, absDest, { overwrite: true });
  } catch (err) {
    console.warn(`[ttsStore] 音频落盘失败：${err.message}`);
    return null;
  }
  const d = db();
  if (!d) return absDest;
  try {
    d.prepare(`
      INSERT OR REPLACE INTO reader_tts_audio (hash, voice, rate, file_path, bytes, created_at, last_accessed)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(hash, voice, rate, path.relative(TTS_ROOT, absDest), bytes, Date.now(), Date.now());
  } catch (err) {
    console.warn(`[ttsStore] saveAudio 入库失败（文件已落盘，不视为失败）：${err.message}`);
  }
  return absDest;
}

/* ── 首尾静音裁剪 ──
 * 探针负责量（起 ffmpeg 只读时间戳），mp3Cut 负责剪（整帧丢弃、原字节拼接、不重编码）。
 * 任何一步不成都原样返回：裁剪纯属听感优化，绝不能因为它把用户的音频弄坏或弄没。
 * 写回走「临时文件 + rename」，避免进程在写入中途被杀留下半截 mp3 —— 那会被后续
 * getCached 当成命中，表现为一条永远播不出来的音频。 */
async function trimFile(absPath) {
  const plan = await planTrim(absPath);
  return plan ? writeTrim(absPath, plan) : null;
}

/** 按已有方案原子写回（ffmpeg 只量一次，回填时不重复跑） */
async function writeTrim(absPath, plan) {
  const tmp = `${absPath}.trim`;
  try {
    fs.writeFileSync(tmp, plan.buf);
    fs.renameSync(tmp, absPath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* 半截文件删不掉就算了，反正不叫 .mp3 的不会被读到 */ }
    console.warn(`[ttsStore] 裁剪写回失败（保留原产物）：${err.message}`);
    return null;
  }
  return { bytes: plan.buf.length, tailPadMs: plan.tailPadMs };
}

/** 算出裁剪方案但不碰文件：合成路径与回填脚本共用，也供 --dry 先看效果。 */
async function planTrim(absPath) {
  if (!TRIM_ON) return null;
  let buf;
  try { buf = fs.readFileSync(absPath); } catch { return null; }
  const info = mp3Parse(buf);
  if (!info) return null;                                    /* 不是可解析的 CBR 流：不裁 */
  const probe = await probeSilence(absPath, { totalMs: info.totalMs });
  if (!probe) return null;
  const r = mp3Cut(buf, {
    dropHeadMs: Math.max(0, probe.headMs - TRIM_HEAD_KEEP),
    dropTailMs: Math.max(0, probe.tailMs - TRIM_TAIL_KEEP),
  });
  if (!r || !r.buf.length || r.buf.length >= buf.length) return null;
  /* 尾巴上实际还剩多少静音 = 量到的尾静音 - 真裁掉的量。
     前端据此提前跨句：播到「时长 - tailPadMs」就该接下一句，再叠加读者设的留白，
     既听得到想要的停顿，也不会把最后一个字切掉。 */
  return {
    buf: r.buf,
    bytes: r.buf.length,
    tailPadMs: Math.max(0, Math.round(probe.tailMs - r.removedTailMs)),
    headMs: probe.headMs,
    tailMs: probe.tailMs,
    totalMs: info.totalMs,
  };
}

/** 裁剪后回写库里的字节数与尾部留白。DB 只是索引，写不进就算了。 */
function recordTrim(hash, { bytes, tailPadMs }) {
  const d = db();
  if (!d) return;
  try {
    d.prepare('UPDATE reader_tts_audio SET bytes = ?, tail_pad_ms = ? WHERE hash = ?').run(bytes, tailPadMs, hash);
  } catch (err) {
    console.warn(`[ttsStore] 裁剪结果入库失败（不影响播放）：${err.message}`);
  }
}

/* ── 合成节流：进程内并发闸 + 同句去重 ── */
const MAX_CONCURRENT = Math.max(1, Number(process.env.TTS_CONCURRENCY) || 2);
let _running = 0;
const _waiters = [];
const _inflight = new Map();   /* hash -> Promise，同一句并发只合成一次 */

function acquire() {
  if (_running < MAX_CONCURRENT) { _running++; return Promise.resolve(); }
  return new Promise((resolve) => _waiters.push(() => { _running++; resolve(); }));
}
function release() {
  _running--;
  const next = _waiters.shift();
  if (next) next();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 临时目录回收 ──
 * 合成失败时绝不能顺手把临时目录删掉：msedge-tts 在音频流的 close 回调里还会
 * unlinkSync 自己的产物（node_modules/msedge-tts/dist/MsEdgeTTS.js 的 No audio 分支），
 * 目录先没它就抛 ENOENT —— 那是个没人 catch 的事件回调，整条 Node 进程直接被带走。
 * 2026-09-13 本机并发实测：13 发齐打即崩，崩后 pm2 重启，读者侧表现为整批请求失败。
 * 因此失败留下的目录改由这里按 mtime 延后回收。 */
let _lastSweep = 0;
function sweepTmp(keepMs = 60000) {
  const now = Date.now();
  if (now - _lastSweep < 30000) { return; }   /* 一次整章生成只扫几回，别为清理制造新 IO */
  _lastSweep = now;
  const base = path.join(TTS_ROOT, '_tmp');
  let names;
  try { names = fs.readdirSync(base); } catch { return; }
  for (const name of names) {
    const dir = path.join(base, name);
    try {
      if (now - fs.statSync(dir).mtimeMs < keepMs) { continue; }
      fs.removeSync(dir);
    } catch { /* 单个目录回收失败不影响其它，更不该影响合成 */ }
  }
}

/** 真正走一次微软边缘接口：合成到临时目录 → 落正式位置。失败一律抛出，由上层决定重试。 */
async function synthOnce(text, voice, rate, hash) {
  sweepTmp();
  const tmpDir = path.join(TTS_ROOT, '_tmp', `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.ensureDirSync(tmpDir);
  let tts = null;
  let moved = false;
  try {
    tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { sentenceBoundaryEnabled: false });
    const result = await tts.toFile(tmpDir, text, { rate: rate || '+0%' });
    const audioFile = result && result.audioFilePath;
    if (!audioFile || !fs.existsSync(audioFile)) throw new Error('合成无产物（多为上游限流或断流）');
    const bytes = fs.statSync(audioFile).size;
    if (!bytes) throw new Error('合成产物为空文件');
    let dest;
    try {
      dest = saveAudio(hash, voice, rate, audioFile, bytes);
    } finally {
      moved = true;   /* 产物已被移走，临时目录交给 finally 清理（失败也不能留给 sweep 删不存在的目录） */
    }
    if (!dest) throw new Error('音频落盘失败（检查 data/tts 目录权限与磁盘空间）');
    let outBytes = bytes;
    let tailPadMs = null;
    const trim = await trimFile(dest);
    if (trim) {
      outBytes = trim.bytes;
      tailPadMs = trim.tailPadMs;
      recordTrim(hash, trim);
    }
    return { ok: true, hash, filePath: dest, bytes: outBytes, tailPadMs };
  } finally {
    try { if (tts && tts.close) tts.close(); } catch { /* 关闭失败不影响结果 */ }
    /* 只有产物确实被我们移走了才清目录；失败路径交给 sweepTmp 延后回收 */
    if (moved) { Promise.resolve(fs.remove(tmpDir)).catch(() => {}); }
  }
}

/**
 * 合成一句音频。
 * @param {string} text 句子文本
 * @param {string} voice Edge 音色名（如 zh-CN-YunxiNeural）
 * @param {string} rate 语速（如 +0%、-20%、+50%）
 * @returns {Promise<{ok:boolean, hash:string, filePath?:string, bytes?:number, tailPadMs?:number|null, error?:string}>}
 */
export async function synthesize(text, voice, rate) {
  const hash = computeHash(text, voice, rate);
  const cached = getCached(hash);
  if (cached) return { ok: true, hash, ...cached };

  const pending = _inflight.get(hash);
  if (pending) return pending;          /* 同一句正在合成（章节里重复句很常见），并入 */

  const job = (async () => {
    await acquire();
    try {
      try {
        return await synthOnce(text, voice, rate, hash);
      } catch (first) {
        /* 退避一次再试：并发/瞬时网络抖动居多，重试比把失败甩给读者划算 */
        await sleep(500 + Math.floor(Math.random() * 500));
        try {
          return await synthOnce(text, voice, rate, hash);
        } catch (second) {
          return { ok: false, hash, error: `${first.message}（重试仍失败：${second.message}）` };
        }
      }
    } finally {
      release();
      _inflight.delete(hash);
    }
  })();

  _inflight.set(hash, job);
  return job;
}

/**
 * 回填裁剪：把现行规则入库前缓存的旧音频（tail_pad_ms 为空）逐条裁一遍。
 * 裁剪只发生在合成时，而整本书的句子大多早已入过库 —— 命中缓存就不再走合成，
 * 不回填的话老句子照样带着 0.67s 尾静音，读者听感不会有任何变化。
 * 幂等：tail_pad_ms 非空即视为处理过，重跑不会二次裁剪；解析不出/探针不可信的跳过
 * 并保持原样（下次重跑还会再试）。DB 不可用时什么都做不了（没地方记留白）。
 * @param {{dryRun?:boolean, limit?:number, log?:boolean}} opt
 * @returns {Promise<{scanned:number, trimmed:number, skipped:number, savedBytes:number}>}
 */
export async function backfillTrim({ dryRun = false, limit = 0, log = true } = {}) {
  const d = db();
  if (!d) throw new Error('DB 不可用，无法回填（tail_pad_ms 没地方记）');
  const n = Number(limit) > 0 ? `LIMIT ${Math.floor(Number(limit))}` : '';
  const rows = d.prepare(`
    SELECT hash, file_path FROM reader_tts_audio
    WHERE tail_pad_ms IS NULL ORDER BY hash ${n}
  `).all();
  let trimmed = 0;
  let skipped = 0;
  let savedBytes = 0;
  for (const row of rows) {
    const abs = path.join(TTS_ROOT, row.file_path);
    let before = 0;
    try { before = fs.statSync(abs).size; } catch { skipped++; continue; }
    const plan = await planTrim(abs);
    if (!plan) { skipped++; continue; }
    if (dryRun) {
      trimmed++;
      savedBytes += before - plan.bytes;
    } else {
      const done = await writeTrim(abs, plan);
      if (!done) { skipped++; continue; }
      recordTrim(row.hash, done);
      trimmed++;
      savedBytes += before - done.bytes;
    }
    if (log) {
      console.log(`${dryRun ? '[dry] ' : ''}${row.hash.slice(0, 8)} ${(plan.totalMs / 1000).toFixed(2)}s  头 ${Math.round(plan.headMs)} 尾 ${Math.round(plan.tailMs)} → 留白 ${plan.tailPadMs}ms  ${before}→${plan.bytes}B`);
    }
  }
  return { scanned: rows.length, trimmed, skipped, savedBytes };
}

/** 列出 data/tts 下的产物文件（相对路径 <xx>/<hash>.mp3）。
 *  只认两位十六进制目录里的 .mp3：_tmp 是合成中间产物，散文件则不是缓存能认的项。 */
function listAudioFiles() {
  const out = [];
  let ents;
  try { ents = fs.readdirSync(TTS_ROOT, { withFileTypes: true }); } catch { return out; }
  for (const ent of ents) {
    if (!ent.isDirectory() || !/^[0-9a-f]{2}$/.test(ent.name)) continue;
    let names;
    try { names = fs.readdirSync(path.join(TTS_ROOT, ent.name)); } catch { continue; }
    for (const f of names) if (f.endsWith('.mp3')) out.push(`${ent.name}/${f}`);
  }
  return out;
}

/**
 * A 体检：按 (voice, rate) 列出条数与占用，并对账「库 vs 磁盘」。
 * 为什么要连磁盘一起看：早先失败的合成、手工清过的目录会留下
 * “库里有行但文件没了”（表现为这一句每次重新合成）和“文件在但库里没记录”（占空间且永远不会被命中），
 * 只看库是看不出这两样的。
 * @returns {Promise<{ok:boolean, groups:Array, voices:Array, totals:object, settings:object}|{ok:false, error:string}>}
 */
export async function auditAudio() {
  const d = db();
  if (!d) return { ok: false, error: '音频缓存 DB 不可用，体检无数据可报' };
  const groups = d.prepare(`
    SELECT voice, rate, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes,
           SUM(tail_pad_ms IS NOT NULL) AS trimmed,
           COALESCE(MAX(tail_pad_ms), 0) AS tailPad,
           MIN(created_at) AS firstCreated, MAX(created_at) AS lastCreated,
           MAX(last_accessed) AS lastAccess
    FROM reader_tts_audio GROUP BY voice, rate ORDER BY voice, rate
  `).all().map((r) => ({ ...r, n: Number(r.n), bytes: Number(r.bytes), trimmed: Number(r.trimmed) }));
  const rows = d.prepare('SELECT file_path FROM reader_tts_audio').all();
  const known = new Set(rows.map((r) => r.file_path));
  let missingFile = 0;
  for (const r of rows) { try { fs.statSync(path.join(TTS_ROOT, r.file_path)); } catch { missingFile++; } }
  const files = listAudioFiles();
  const orphans = files.filter((f) => !known.has(f));
  let diskBytes = 0;
  for (const f of files) { try { diskBytes += fs.statSync(path.join(TTS_ROOT, f)).size; } catch { /* 刚被删掉，不影响总量*/ } }
  /* 按音色汇总一份：清理是按音色下手的，看数也得用同一口径，否则“哪音色最占地”得自己加 */
  const byVoice = new Map();
  for (const g of groups) {
    const v = byVoice.get(g.voice) || { voice: g.voice, n: 0, bytes: 0, trimmed: 0, rates: [], lastCreated: 0 };
    v.n += g.n;
    v.bytes += g.bytes;
    v.trimmed += g.trimmed;
    v.rates.push(g.rate);
    v.lastCreated = Math.max(v.lastCreated, g.lastCreated || 0);
    byVoice.set(g.voice, v);
  }
  return {
    ok: true,
    groups,
    voices: [...byVoice.values()].sort((a, b) => b.bytes - a.bytes),
    totals: {
      rows: rows.length,
      bytes: groups.reduce((a, g) => a + g.bytes, 0),
      trimmed: groups.reduce((a, g) => a + g.trimmed, 0),
      missingFile,
      orphans: orphans.length,
      diskBytes,
      buckets: new Set(files.map((f) => f.slice(0, 2))).size,
    },
    settings: {
      trim: TRIM_ON, headKeepMs: TRIM_HEAD_KEEP, tailKeepMs: TRIM_TAIL_KEEP,
      concurrency: MAX_CONCURRENT, ffmpeg: ffmpegAvailable(),
    },
  };
}

/**
 * B 清理：按 voice（可叠加 rate）删记录与音频文件；不传 apply 就只算不改。
 * 默认干跑两道门：删缓存不可逆，代价是“下一次朗读全部重新合成”（要跑一趟外网上游）。
 * @param {{voice?:string, rate?:string, all?:boolean, apply?:boolean}} opt
 * @returns {Promise<{ok:boolean, apply:boolean, scope:string, matched:number, bytes:number, missing:number, skippedBusy?:number, removedFiles?:number, error?:string}>}
 */
export async function pruneAudio({ voice, rate, all = false, apply = false } = {}) {
  const d = db();
  if (!d) return { ok: false, error: '音频缓存 DB 不可用，不清（删了文件删不了行，会留下孤儿）' };
  const v = String(voice ?? '').trim();
  const r = String(rate ?? '').trim();
  /* 没任何条件的一律否：手滑一个空请求就清光全站缓存，代价太大 */
  if (!all && !v && !r) return { ok: false, error: '清理必须指定音色或语速；要清空全部请显式传 all' };
  const where = [];
  const args = [];
  if (!all) { if (v) { where.push('voice = ?'); args.push(v); } if (r) { where.push('rate = ?'); args.push(r); } }
  const found = d.prepare(`SELECT hash, file_path, bytes FROM reader_tts_audio${where.length ? ' WHERE ' + where.join(' AND ') : ''}`).all(...args);
  /* 正在合成的句子先放过：产物还没落定，这时候删等于白跑一趟上游，还可能把刚写的文件拖掉 */
  const busy = new Set(_inflight.keys());
  const rows = found.filter((row) => !busy.has(row.hash));
  let bytes = 0;
  let missing = 0;
  for (const row of rows) {
    try { bytes += fs.statSync(path.join(TTS_ROOT, row.file_path)).size; } catch { bytes += Number(row.bytes) || 0; missing++; }
  }
  const base = {
    ok: true, apply: !!apply, scope: all ? '全部缓存' : `${v || '任意音色'} / ${r || '任意语速'}`,
    voice: v || null, rate: r || null, matched: rows.length, bytes, missing, skippedBusy: found.length - rows.length,
  };
  if (!apply || !rows.length) return base;
  /* 逐行「先删文件、再删行」，不包事务：事务回滚会把行留下而文件已经没了，
     反而造出“指向空路径的行”；按这个顺序中途出错只可能多留一个孤儿文件，两边都能自愈。 */
  const del = d.prepare('DELETE FROM reader_tts_audio WHERE hash = ?');
  let removedFiles = 0;
  for (const row of rows) {
    const abs = path.join(TTS_ROOT, row.file_path);
    try { if (fs.existsSync(abs)) { fs.removeSync(abs); removedFiles++; } } catch (err) {
      console.warn(`[ttsStore] 清理删文件失败（行仍删，避免下次命中坏路径）：${err.message}`);
    }
    try { del.run(row.hash); } catch (err) { console.warn(`[ttsStore] 清理删行失败：${err.message}`); }
  }
  console.log(`[ttsStore] 清理 ${base.scope}：删 ${rows.length} 条 / ${(bytes / 1048576).toFixed(1)}MB（文件 ${removedFiles} 个）`);
  return { ...base, removedFiles, freedBytes: bytes };
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
