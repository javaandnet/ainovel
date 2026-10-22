#!/usr/bin/env node
/**
 * 章节 TTS 预缓存：把指定章节的正文逐句（或逐段）合成好、落进全局音频缓存（data/tts + global.db）。
 *
 * 为什么要它：读者第一次点开某章才逐句现合成，前几秒会等上游；预先把整章灌进缓存，
 * 真正朗读时全部命中、秒出。缓存键与在线朗读完全一致——本脚本用 ttsText.extractReaderSentences
 * 复刻浏览器朗读器的分句（按标签切文本节点 + 实体解码 + 同款标点集），保证「脚本合成的那一句」
 * 和「读者请求的那一句」sha1(text|voice|rate) 命中同一份 mp3。
 *
 * 引擎：默认走 ttsStore 现行引擎（NOVEL_TTS_ENGINE，缺省 edge）。要预缓存成「有感情」的 Azure 版，
 * 设 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION 且 --engine azure（或 env NOVEL_TTS_ENGINE=azure），
 * 情感风格 --style 缺省 narration。Azure 传了 style 才会把 style 计入缓存键，Edge 老缓存不受影响。
 *
 * 用法：
 *   node scripts/tts-precache.mjs --novel=兔子你不行 --chapters=9-12            # 默认 uid、edge、逐句
 *   node scripts/tts-precache.mjs --uid=xxxx --novel=兔子你不行 --chapters=9,10,11,12 --voice=zh-CN-XiaoxiaoNeural --rate=+30%
 *   node scripts/tts-precache.mjs --novel=兔子你不行 --chapters=9-12 --engine=azure --style=narration
 *   加 --paragraph 走段落级（Azure <break>），--dry 只列将合成的句子不落库
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { synthesize, synthesizeParagraph } from '../src/reader/ttsStore.js';
import { extractReaderSentences } from '../src/reader/ttsText.js';
import { resolveEngine, normalizeStyle } from '../src/reader/ttsEngines.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_ROOT = path.join(ROOT, 'public', 'novel');

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const flag = (name) => argv.includes(`--${name}`);

const UID = opt('uid', process.env.NOVEL_TTS_PRECACHE_UID || '62ae0090-52a5-4510-982a-67fcc6e0b0f7');
const NOVEL = opt('novel', '兔子你不行');
const VOICE = opt('voice', 'zh-CN-YunxiNeural');
const RATE = opt('rate', '+30%');                 // 读者「中」速默认 → 服务端 +30%
const ENGINE_PREF = opt('engine', process.env.NOVEL_TTS_ENGINE || 'edge');
const STYLE = opt('style', '');                    // 空则 azure 缺省 narration、edge 忽略
const PARAGRAPH = flag('paragraph');
const DRY = flag('dry');

/** "9-12" / "9,10,11,12" / "9-12,15" → [9,10,11,12,15] */
function parseChapters(spec) {
  const out = [];
  for (const part of String(spec || '').split(',')) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) { const a = +m[1], b = +m[2]; for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(n); }
    else if (/^\d+$/.test(p)) out.push(+p);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** 从 index.html 建「章号 → 章节文件名」映射（按正文里的 第N章 链接）。 */
function chapterFileMap(dir) {
  const idx = path.join(dir, 'index.html');
  if (!fs.existsSync(idx)) throw new Error(`找不到目录索引：${idx}`);
  const html = fs.readFileSync(idx, 'utf8');
  const map = new Map();
  const re = /chapter_([0-9a-f]+)\.html[^>]*>\s*第\s*(\d+)\s*章/gi;
  let m;
  while ((m = re.exec(html))) map.set(Number(m[2]), `chapter_${m[1]}.html`);
  return map;
}

const novelDir = path.join(OUT_ROOT, UID, NOVEL);
if (!fs.existsSync(novelDir)) { console.error(`章节目录不存在：${novelDir}`); process.exit(1); }
const map = chapterFileMap(novelDir);
const nums = parseChapters(opt('chapters', ''));
if (!nums.length) { console.error('请用 --chapters=9-12 或 --chapters=9,10 指定章节号'); process.exit(1); }

const engine = resolveEngine(ENGINE_PREF);
// 传给 synthesize 的一律是原始 STYLE（空则交由 synthesize 逐句自动推断情感）；解析后的 style 仅用于日志
const logStyle = normalizeStyle(engine, STYLE);
const autoEmotion = engine.name === 'azure' && !String(STYLE).trim();
console.log(`[precache] 引擎=${engine.name} 情感=${autoEmotion ? '逐句自动推断' : (logStyle || '无（Edge 中性）')} 音色=${VOICE} 语速=${RATE} 模式=${PARAGRAPH ? '段落' : '逐句'} dry=${DRY}`);
if (ENGINE_PREF === 'azure' && engine.name !== 'azure') console.warn('[precache] 指定了 azure 但凭证不全，实际回落为 edge');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let totalSent = 0, hit = 0, made = 0, failed = 0;
const t0 = Date.now();

for (const n of nums) {
  const fname = map.get(n);
  if (!fname) { console.warn(`  第${n}章：目录里没有对应章节文件，跳过`); continue; }
  const fp = path.join(novelDir, fname);
  const html = fs.readFileSync(fp, 'utf8');
  const cm = html.match(/<div class="content">([\s\S]*?)<\/div>/);
  if (!cm) { console.warn(`  第${n}章：无 content 正文，跳过`); continue; }
  const sentences = extractReaderSentences(cm[1]);

  if (PARAGRAPH) {
    // 段落模式：按句数组整段合成（Azure 用 <break> 拼）；这里以「整章正文一句一段」的粗粒度不拆段，
    // 真正段落级由调用方决定分段口径——预缓存默认逐句更稳（与在线读者命中一致）。
    console.log(`  第${n}章：段落模式预缓存（整段合成）示例，共 ${sentences.length} 句`);
  }

  let cH = 0, cM = 0, cF = 0;
  for (const s of sentences) {
    if (DRY) { totalSent++; continue; }
    const run = PARAGRAPH ? synthesizeParagraph(s, VOICE, RATE, { engine: engine.name, style: STYLE })
      : synthesize(s, VOICE, RATE, { engine: engine.name, style: STYLE });
    const r = await run;
    totalSent++;
    if (r.ok) { if (r.tailPadMs !== undefined && r.bytes && r.filePath && fs.statSync(r.filePath).mtimeMs < t0 - 5000) cH++; else cM++; }
    else { cF++; if (cF <= 2) console.warn(`    第${n}章某句合成失败：${r.error}`); }
    await sleep(120);   // 轻微节流：Azure 免费层/边缘接口对突发并发敏感，逐句间隔比一把梭稳
  }
  if (!DRY) { hit += cH; made += cM; failed += cF; }
  console.log(`  第${n}章：${sentences.length} 句 → 新增 ${cM} / 命中 ${cH} / 失败 ${cF}`);
}

if (DRY) {
  console.log(`[precache] 干跑结束：将合成 ${totalSent} 句（未落库）。去掉 --dry 执行。`);
} else {
  console.log(`[precache] 完成：共 ${totalSent} 句，新增 ${made} / 已命中 ${hit} / 失败 ${failed}，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
