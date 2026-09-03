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
import { getExplanation, putExplanation, wordsWithExplanation } from './explainStore.js';
import { getQuiz, putQuiz, deleteQuiz } from './quizStore.js';

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

/* 重新出题时随机挑一个命题角度：没有角度约束的话，同一 prompt 重跑大概率得到同一套题，
   读者点了「换一组新题」却拿到换汤不换药的卷子，等于白付一次生成 */
const QUIZ_FOCI = ['故事情节与细节', '人物动机与性格', '因果推理（为什么会出现这个结果）', '关键词语在句中的含义', '这一段想说明的道理'];

function quizPrompt(document, age, focus) {
  const angle = focus ? `\n出题侧重：${focus}（请从这个角度命题，不要泛泛而谈）` : '';
  return `根据以下章节内容，为${age}岁孩子生成3道选择题。${angle}\n每题3个选项，只有1个正确答案。\n只返回JSON数组：[{"question":"","options":["","",""],"answer":""}]\n章节内容：${document}`;
}
/**
 * 讲解口径按“目标语言”自适应。本书籍正文以中文为主，被解释的词往往本身就是中文，
 * 所以不能无脑要求“附中文对照”（那会变成用中文解释中文）。
 *  - lang=中文：讲解语言与原文同语种 → 只要大白话释义，明确禁止“中文对照”这类多余段落；
 *  - lang=日语/英语/韩语：用该语言解释中文词（面向学外语的读者），并给出地道表达；
 *  - 只有当被解释的词本身是外语时，附中文对照才有意义 → 交给模型按词判断。
 */
function glossRules(lang, age) {
  if (lang === '中文') {
    return `这些词是中文词，请用适合${age}岁孩子的简短大白话说清意思（可以说近义词、打个比方）。`
      + '不要用其他语言，也不要输出「中文对照」这类多余段落。';
  }
  const tone = lang === '日语' ? `自然、口语化的日语（适合${age}岁学习者理解）` : `适合${age}岁孩子理解的${lang}`;
  return `被解释的词语出自中文小说，请用${tone}解释它的意思；解释词语而不是逐字对译。`
    + '只有当被解释的词本身是外语时，才在末尾附一句中文对照。';
}
function explainPrompt(sentence, age, lang) {
  return `你是一位耐心的语言老师。学生年龄：${age}岁。\n${glossRules(lang, age)}\n就下面这句话里 2-3 个关键词各给一句话解释（不要表格、不要复述全句）。\n句子：${sentence}`;
}
function wordPrompt(word, age, lang, context) {
  const ctx = context ? `\n这个词出现的句子（仅供理解语境，不必复述、不必逐字翻译整句）：${String(context).slice(0, 160)}` : '';
  return `你是一位耐心的语言老师。学生年龄：${age}岁。\n${glossRules(lang, age)}\n要解释的词语：「${word}」。\n只要一两句话，生动、简短（不要表格、不要长篇、不要复述整句）。${ctx}`;
}
function vocabPrompt(document, age) {
  return `你是一位语文老师。请从下面的课文中挑出值得${age}岁学生重点积累的词语。\n要求：\n1. 只能是课文里原文出现过的词，一字不差，不要改写、不要造词、不要带标点\n2. 挑成语、书面语、生僻词和对${age}岁偏难的词；常用代词、连词、语气词不要挑\n3. 去重后返回 8-20 个\n只返回 JSON 数组：["词语1","词语2"]\n课文：${document}`;
}

/** 章节测试：返回题目数组（可能为空数组） */
/**
 * 章节出题：按 (年龄档, 正文哈希) 持久缓存，命中即零 LLM。
 *
 * 只有 opts.force（读者主动点「换一组新题」）才允许绕开缓存重跑。平时绝不悄悄换题：
 * 孩子刚答完的卷子一刷新就换了内容，是体验事故，不是缓存该优化的东西。
 * force 时同时绕开进程内 Map（cacheResult:false），否则会被 Map 里的旧答案直接端回来。
 */
export async function generateQuiz(document, age = 9, opts = {}) {
  const doc = String(document || '').trim();
  if (!doc) throw new Error('缺少章节内容');
  const a = Number(age) || 9;
  const key = sha1('quiz|' + a + '|' + doc);
  const force = opts.force === true;
  if (!force) {
    const persisted = getQuiz(key);
    if (persisted) return persisted;
  } else {
    deleteQuiz(key);   // 先作废旧行：重跑万一失败，留下的是“无缓存”而不是新旧混用
  }
  const focus = force ? QUIZ_FOCI[Math.floor(Math.random() * QUIZ_FOCI.length)] : '';
  const raw = await cachedGenerate(key, [{ role: 'user', content: quizPrompt(doc, a, focus) }], { temperature: 0.5, think: false, cacheResult: !force });
  const arr = parseQuizArray(raw);
  const questions = Array.isArray(arr) ? arr : [];
  if (questions.length) putQuiz(key, a, questions, doc.length);
  return questions;
}

/** 句子词汇讲解：返回讲解文本 */
export async function explainSentence(sentence, age = 9, lang = '英语') {
  const s = String(sentence || '').trim();
  if (!s) throw new Error('缺少句子内容');
  const key = sha1('explain|' + age + '|' + lang + '|' + s);
  return cachedGenerate(key, [{ role: 'user', content: explainPrompt(s, age, lang) }], { temperature: 0.6, think: false });
}

/**
 * 单词讲解：按 (词, 年龄, 语言) 持久缓存，命中即零 LLM 秒显，且同词跨章节/跨书复用。
 * 原句只作“首次生成”时的语境（context），不进缓存键，否则同词跨句无法复用、落库失去意义。
 * 走关思考通道（think:false）：词义释义无需长推理链。
 */
export async function explainWord(word, age = 9, lang = '英语', context = '') {
  const w = String(word || '').trim();
  if (!w) throw new Error('缺少词语');
  const ctx = String(context || '').trim();
  /* 先查持久层：命中即返回，跨进程/跨读者复用 */
  const persisted = getExplanation(w, age, lang);
  if (persisted) return persisted;
  /* 键与持久层同口径（不含 ctx），再经进程内缓存 + 在途去重 + 并发上限 */
  const key = sha1('we|' + age + '|' + lang + '|' + w);
  const out = await cachedGenerate(key, [{ role: 'user', content: wordPrompt(w, age, lang, ctx) }], { temperature: 0.5, think: false });
  if (out) putExplanation(w, age, lang, out);
  return out;
}

/** 批量查“哪些词已有讲解”，供正文着色（黑/灰）；纯查库，不触发任何生成。 */
export function vocabExplainStatus(words, age = 9, lang = '英语') {
  const list = Array.isArray(words) ? words.map((x) => String(x || '').trim()).filter(Boolean) : [];
  return wordsWithExplanation(list, age, lang);
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
    { role: 'system', content: '你是一位耐心的少儿辅导老师。直接给出回应，不要复述题目、不要铺垫，不超过两三句。' },
    { role: 'user', content: t },
  ];
  /* think:false —— 鼓励式点评是短文本生成，没有推理链需求。bc95fca 关思考时漏了这条，
     留下“答完题等 30~50s 才出讲解”的体感；混合思考模型开着思考慢一个数量级。
     第 4 个参数才是 think（callLLM 形参为 messages, temperature, timeout, think） */
  return enqueue(() => callLLM(messages, 0.7, undefined, false));
}

export { BusyError };
