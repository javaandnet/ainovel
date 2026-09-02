/**
 * 阅读器 AI 服务（服务端代理 + 缓存 + 并发保护）
 *
 * 背景：已发布的静态阅读页此前直连 http://localhost:3300 且把 aibridge key 明文写进前端，
 * 既泄露凭据、又无法服务远程读者，还会把每个读者的实时请求全部打到单点推理服务。
 *
 * 本模块把阅读期 AI 能力收敛到服务端：
 *  - generateQuiz  : 章节测试（整章 -> 3 道选择题）——内容随章节固定，命中缓存后即时返回
 *  - explainSentence: 句子词汇讲解——按 (句子+年龄+语言) 缓存
 *  - pickVocab     : 生词挑选（整章 -> 值得积累的词语）——按 (章节, 年龄) 缓存，供正文加粗标注
 *                    走关思考通道（思考链在此任务上耗时百倍无收益），超时见 VOCAB_TIMEOUT
 *                    额外一层 global.db 持久缓存，重启后不必重算，见 vocabStore.js
 *  - askQuestion   : 自由问答——开放式，不缓存，仅做并发/超时保护
 *
 * 保护策略（针对单点自托管推理）：
 *  - 全局并发上限 MAX_CONC（默认 2），超出进入有界队列；
 *  - 队列长度上限 MAX_QUEUE，超出直接 503 fail-fast（不静默堆积、不压垮推理服务）；
 *  - 相同 key 的在途请求去重合并（首个计算，其余等待同一结果）；
 *  - 内容哈希缓存（不可变，进程内，带上限淘汰）。
 */
import crypto from 'crypto';
import { llm } from '../agent/llm.js';
import { getCachedWords, putCachedWords } from './vocabStore.js';

const MAX_CONC = Number(process.env.READER_LLM_CONC || 2);
const MAX_QUEUE = Number(process.env.READER_LLM_QUEUE || 50);
const MAX_CACHE = Number(process.env.READER_LLM_CACHE || 3000);
const LLM_TIMEOUT = Number(process.env.READER_LLM_TIMEOUT || 60000);
/* 挑词要逐词评估难度，混合思考模型会为“该不该选这个词”想很久：实测 1500 字章节 109.7s、
   输出 2798 token（而 aibridge 上游 120s 就掐了），关掉思考后同任务只花 6.1s。
   关思考已是主链路，本项长超时只是队列排队与推理服务器繁忙时的兜底。 */
const VOCAB_TIMEOUT = Number(process.env.READER_VOCAB_TIMEOUT || 240000);

const cache = new Map();      // key -> result(string)
const inflight = new Map();   // key -> Promise<string>
const queue = [];
let running = 0;

class BusyError extends Error { constructor() { super('服务繁忙，请稍后重试'); this.status = 503; } }

const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

function pump() {
  while (running < MAX_CONC && queue.length) {
    const job = queue.shift();
    running++;
    Promise.resolve()
      .then(job.fn)
      .then((v) => job.resolve(v), (e) => job.reject(e))
      .finally(() => { running--; pump(); });
  }
}

/** 有界并发的排队执行；队列满则 fail-fast */
function enqueue(fn) {
  if (queue.length >= MAX_QUEUE) return Promise.reject(new BusyError());
  return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); });
}

async function callLLM(messages, temperature, timeout, think) {
  const r = await llm.chat({ messages, temperature, timeout: timeout || LLM_TIMEOUT, think });
  return (r && r.content) || '';
}

/** 带缓存 + 在途去重 + 并发上限的一次生成 */
async function cachedGenerate(key, messages, { temperature = 0.4, cacheResult = true, timeout = LLM_TIMEOUT, think } = {}) {
  if (cacheResult && cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = enqueue(() => callLLM(messages, temperature, timeout, think)).then(
    (out) => { if (cacheResult && out) { if (cache.size >= MAX_CACHE) { const k0 = cache.keys().next().value; cache.delete(k0); } cache.set(key, out); } inflight.delete(key); return out; },
    (err) => { inflight.delete(key); throw err; }
  );
  inflight.set(key, p);
  return p;
}

/** 容错解析：从模型文本里提取第一个 JSON 数组 */
export function parseQuizArray(text) {
  if (!text) return null;
  const t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start >= 0 && end > start) { try { return JSON.parse(body.slice(start, end + 1)); } catch { /* fallthrough */ } }
  try { return JSON.parse(body); } catch { return null; }
}

function quizPrompt(document, age) {
  return `根据以下章节内容，为${age}岁孩子生成3道选择题。\n每题3个选项，只有1个正确答案。\n只返回JSON数组：[{"question":"","options":["","",""],"answer":""}]\n章节内容：${document}`;
}
function explainPrompt(sentence, age, lang) {
  return `你是一位耐心的语言老师。学生年龄：${age}岁。\n请用${lang}解释下面句子中的关键词汇，并附简单中文对照。\n解释要生动有趣、简短（挑 2-3 个关键词，每个一句话，不要表格、不要复述全句），适合${age}岁孩子理解。\n句子：${sentence}`;
}
function vocabPrompt(document, age) {
  return `你是一位语文老师。请从下面的课文中挑出值得${age}岁学生重点积累的词语。\n要求：\n1. 只能是课文里原文出现过的词，一字不差，不要改写、不要造词、不要带标点\n2. 挑成语、书面语、生僻词和对${age}岁偏难的词；常用代词、连词、语气词不要挑\n3. 去重后返回 8-20 个\n只返回 JSON 数组：["词语1","词语2"]\n课文：${document}`;
}

/** 章节测试：返回题目数组（可能为空数组） */
export async function generateQuiz(document, age = 9) {
  const doc = String(document || '').trim();
  if (!doc) throw new Error('缺少章节内容');
  const key = sha1('quiz|' + age + '|' + doc);
  const raw = await cachedGenerate(key, [{ role: 'user', content: quizPrompt(doc, age) }], { temperature: 0.5, think: false });
  const arr = parseQuizArray(raw);
  return Array.isArray(arr) ? arr : [];
}

/** 句子词汇讲解：返回讲解文本 */
export async function explainSentence(sentence, age = 9, lang = '英语') {
  const s = String(sentence || '').trim();
  if (!s) throw new Error('缺少句子内容');
  const key = sha1('explain|' + age + '|' + lang + '|' + s);
  return cachedGenerate(key, [{ role: 'user', content: explainPrompt(s, age, lang) }], { temperature: 0.6, think: false });
}

/* 词语形态守卫：带标点或空白的“词”不可能在正文里被完整匹配（多半是模型把整句抄回来了） */
const WORD_SHAPE = /^[^\s。！？；，、：”“"’‘《》（）…—-]{2,12}$/u;

/**
 * 生词挑选：返回可直接用于正文标注的词语数组（长词在前）
 * 口径只跟 (章节, 年龄) 有关，与讲解语言无关，故 key 不含 lang，切语言不必重算。
 * 模型偶发改写/造词，这里一律以「课文原文确实出现」为准过滤：宁可不标，不能标错。
 * 走关思考通道（think:false）：逐词判断不需要长推理链，开了要多花百倍时间。
 * 键里的“正文”就是调用方传进来的那段文本，所以发布侧（库里的章节原文）与
 * 读者侧（浏览器 innerText）各自成一个缓存项，不交叉命中：前者让同一本书重复
 * 发布时直接复用（未改动的章节不必再跑一轮 LLM），后者让读者不重复等待。
 */
export async function pickVocab(document, age = 9) {
  const doc = String(document || '').trim();
  if (!doc) throw new Error('缺少章节内容');
  const key = sha1('vocab|' + age + '|' + doc);
  /* 先查持久层：命中即零 LLM。正文哈希做键意味着改写后必然 miss，不可能拿到过期词表 */
  const persisted = getCachedWords(key);
  if (persisted) return persisted;
  const raw = await cachedGenerate(key, [{ role: 'user', content: vocabPrompt(doc, age) }], { temperature: 0.2, timeout: VOCAB_TIMEOUT, think: false });
  const arr = parseQuizArray(raw); // 复用“提取第一个 JSON 数组”的容错解析
  /* 解析不出数组等于模型没按要求输出，必须报错让读者看得到原因，不能当成“本章无生词”静默跳过 */
  if (!Array.isArray(arr)) throw new Error('生词挑选失败：模型未返回可解析的 JSON 数组');
  const seen = new Set();
  const words = [];
  for (const item of arr) {
    const w = typeof item === 'string' ? item.trim() : '';
    if (!WORD_SHAPE.test(w) || !doc.includes(w) || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
  }
  /* 长词优先：客户端按此顺序做非重叠占位，避免「红宝石」被「宝石」抢走半截 */
  words.sort((a, b) => b.length - a.length);
  // 空词表不入库（见 vocabStore）：一次模型抽风不该把这一章永远锁定成“无生词”
  putCachedWords(key, words, doc.length);
  return words;
}

/** 自由问答：开放式，不缓存；返回回答文本 */
export async function askQuestion(question, document = '') {
  const q = String(question || '').trim();
  if (!q) throw new Error('缺少问题');
  const doc = String(document || '').trim();
  const messages = [
    { role: 'system', content: '你是小说阅读助手。请依据给出的章节内容，用友好、简洁、适合学生理解的语言回答问题；章节中没有的信息请如实说明。' },
    { role: 'user', content: doc ? `章节内容：\n${doc}\n\n问题：${q}` : `问题：${q}` },
  ];
  // 不缓存（问题高度分散），但仍经并发上限保护，避免压垮推理服务
  return enqueue(() => callLLM(messages, 0.5));
}

/** 答题后鼓励式讲解（随选择动态生成，不缓存，仅经并发/超时保护） */
export async function answerFeedback(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('缺少内容');
  const messages = [
    { role: 'system', content: '你是一位耐心的少儿辅导老师。请用简短、鼓励、适合孩子理解的中文回应，不超过两三句。' },
    { role: 'user', content: t },
  ];
  return enqueue(() => callLLM(messages, 0.7));
}

export { BusyError };
