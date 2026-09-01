/**
 * 阅读器 AI 服务（服务端代理 + 缓存 + 并发保护）
 *
 * 背景：已发布的静态阅读页此前直连 http://localhost:3300 且把 aibridge key 明文写进前端，
 * 既泄露凭据、又无法服务远程读者，还会把每个读者的实时请求全部打到单点推理服务。
 *
 * 本模块把三类阅读期 AI 能力收敛到服务端：
 *  - generateQuiz  : 章节测试（整章 -> 3 道选择题）——内容随章节固定，命中缓存后即时返回
 *  - explainSentence: 句子词汇讲解——按 (句子+年龄+语言) 缓存
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

const MAX_CONC = Number(process.env.READER_LLM_CONC || 2);
const MAX_QUEUE = Number(process.env.READER_LLM_QUEUE || 50);
const MAX_CACHE = Number(process.env.READER_LLM_CACHE || 3000);
const LLM_TIMEOUT = Number(process.env.READER_LLM_TIMEOUT || 60000);

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

async function callLLM(messages, temperature) {
  const r = await llm.chat({ messages, temperature, timeout: LLM_TIMEOUT });
  return (r && r.content) || '';
}

/** 带缓存 + 在途去重 + 并发上限的一次生成 */
async function cachedGenerate(key, messages, { temperature = 0.4, cacheResult = true } = {}) {
  if (cacheResult && cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);
  const p = enqueue(() => callLLM(messages, temperature)).then(
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
  return `你是一位耐心的语言老师。学生年龄：${age}岁。\n请用${lang}解释下面句子中的关键词汇，并附简单中文对照。\n解释要生动有趣，适合${age}岁孩子理解。\n句子：${sentence}`;
}

/** 章节测试：返回题目数组（可能为空数组） */
export async function generateQuiz(document, age = 9) {
  const doc = String(document || '').trim();
  if (!doc) throw new Error('缺少章节内容');
  const key = sha1('quiz|' + age + '|' + doc);
  const raw = await cachedGenerate(key, [{ role: 'user', content: quizPrompt(doc, age) }], { temperature: 0.5 });
  const arr = parseQuizArray(raw);
  return Array.isArray(arr) ? arr : [];
}

/** 句子词汇讲解：返回讲解文本 */
export async function explainSentence(sentence, age = 9, lang = '英语') {
  const s = String(sentence || '').trim();
  if (!s) throw new Error('缺少句子内容');
  const key = sha1('explain|' + age + '|' + lang + '|' + s);
  return cachedGenerate(key, [{ role: 'user', content: explainPrompt(s, age, lang) }], { temperature: 0.6 });
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
