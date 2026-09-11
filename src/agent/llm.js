/**
 * LLM 适配层 - 转调 aibridge（http://localhost:3300/api/bridge/chat）
 *
 * 对外保持与 galaclaw llm.js 同名接口：chat({ messages, model, temperature, maxTokens })
 * 返回 { content }（writerTool 仅读 response.content）。
 *
 * aibridge /chat 请求体：{ prompt, system, document, temperature, max_tokens, stream, provider_id, model }
 *   —— 不接受原始 messages 数组，故此处把 messages 拆平为 system + prompt。
 * writerTool 的调用均为「system + 单条 user」单轮形态，拆平无损。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 零依赖读取工程根目录 .env（.env 已被 .gitignore 排除，密钥不入库）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
function readEnvFile(key) {
  try {
    const txt = fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, '');
    }
  } catch { /* 无 .env 文件 */ }
  return null;
}

const DEFAULT_CHAT_URL = 'http://localhost:3300/api/bridge/chat';
// 默认地址兜底：连到哪个上游模型完全由密钥决定（桥接侧 key → provider → model）。
// 生效优先级：控制台覆盖（runtime）> 环境变量 > .env > 内置默认。
// 覆盖值不写回 process.env：那样就分不清「用户显式设的」与「兜底出来的」，也就无法回退到 .env。
// 注意：runtime 只有 bridgeStore.applyToLlm() 会推，所以启动必须走 initBridge()，见 server.js。
let runtime = { url: null, apiKey: null };

export function bridgeUrl() {
  return runtime.url || process.env.AIBRIDGE_URL || readEnvFile('AIBRIDGE_URL') || DEFAULT_CHAT_URL;
}
export function bridgeKey() {
  return runtime.apiKey || process.env.AIBRIDGE_API_KEY || readEnvFile('AIBRIDGE_API_KEY') || '';
}
/** 控制台切换连接：传空值即清除覆盖、回落到 .env / 环境变量 */
export function setBridgeOverride({ url, apiKey } = {}) {
  runtime = { url: String(url || '').trim() || null, apiKey: String(apiKey || '').trim() || null };
}
/** 当前生效配置（只回前缀，明文密钥不出这里） */
export function getBridgeConfig() {
  const key = bridgeKey();
  return {
    url: bridgeUrl(),
    hasKey: !!key,
    keyPrefix: key ? `${key.slice(0, 13)}…` : '',
    source: runtime.apiKey ? 'console' : 'env',
  };
}
/** 由 chat 端点地址取桥接根地址（health / whoami 都挂在同一个 host 下） */
function bridgeBase(chatUrl) {
  const u = new URL(chatUrl);
  return `${u.protocol}//${u.host}`;
}

if (!bridgeKey()) {
  console.warn('[llm] 没有可用的 API Key：请在 .env 填 AIBRIDGE_API_KEY，或在控制台「推理服务连接」里添加（AI 生成/解析接口将不可用，菜单式读写与发布不受影响）');
}

class LLM {
  /**
   * 动笔前的预检：只探测桥接服务是否可达（GET /api/health，无需鉴权、不消耗 token）。
   * 边界：它只能证明「桥接活着」，不能证明上游推理服务可用——上游故障会在真正生成时
   * 以 aibridge HTTP 5xx 的形式暴露。另外密钥缺失在本地就能判定，一并报出来。
   * @param {number} [timeoutMs] - 探测超时（不能沿用生成的 600s，预检要立刻给结论）
   * @returns {Promise<{ok: boolean, detail: string}>}
   */
  async checkReachable(timeoutMs = 3000) {
    const chatUrl = bridgeUrl();
    if (!bridgeKey()) {
      return { ok: false, detail: '没有可用的 API Key：请在控制台添加，或在 .env 填 AIBRIDGE_API_KEY' };
    }
    let url;
    try {
      url = `${bridgeBase(chatUrl)}/api/health`;
    } catch {
      return { ok: false, detail: `地址不是合法 URL：${chatUrl}` };
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return { ok: false, detail: `${url} 返回 HTTP ${res.status}` };
      const data = await res.json().catch(() => ({}));
      if (data.status && data.status !== 'ok') {
        return { ok: false, detail: `${url} 报告 status=${data.status}` };
      }
      return { ok: true, detail: `${url} 可达` };
    } catch (e) {
      const cause = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `探测超时（${timeoutMs}ms 未响应）`
        : (e?.cause?.code || e?.cause?.message || e?.message || '未知网络错误');
      return { ok: false, detail: `连不上 ${url}：${cause}。启动方式：在 aibridge 目录执行 npm start（默认监听 3300）` };
    }
  }

  async chat({ messages = [], model = null, temperature, maxTokens, timeout, think } = {}) {
    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n');
    const prompt = messages
      .filter((m) => m.role !== 'system')
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n\n');

    if (!prompt && !system) {
      throw new Error('llm.chat: messages 为空，无法构建 aibridge 请求');
    }

    const body = { prompt: prompt || system, stream: false };
    if (system && prompt) body.system = system;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (maxTokens) body.max_tokens = maxTokens;
    if (model) body.model = model;
    /* 结构化的提取/分类类小任务（如阅读模式挑生词）显式关思考：
       自托管混合思考模型在这类任务上会写上千 token 思考链，1500 字章节要 109.7s，
       关掉后 6.1s 且词表质量未降。不传则保持上游默认。 */
    if (think === false) body.think = false;
    /* 调用方传的 timeout 语义是「这次允许上游跑多久」，所以必须同时发给桥接服务：
       桥接服务对上游有个默认 120s 的硬顶，不发给它就是「客户端还在等 600s、桥接已回 502」
       这种对不上的失败（实测：每章目标 3000 字时整章生成在 120s 被切）。
       本地 signal 再宽 15s，让桥接那边的超时原因先回来，不至于变成自己的 AbortError。 */
    if (timeout) body.timeout = timeout;

    const timeoutMs = timeout ? timeout + 15000 : 600000;
    // 一次取齐快照：切换连接若发生在两次读之间，会出现「新地址配旧密钥」
    const chatUrl = bridgeUrl();
    const chatKey = bridgeKey();
    let res;
    try {
      res = await fetch(chatUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': chatKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // undici 只给一句「fetch failed」，真正原因（拒连/超时/DNS）在 e.cause 里。
      // 不补上去无法定位（实测：aibridge 未启动 → 批量补大纲 20 章全报 fetch failed，
      // 看不出是模型问题还是服务没起）。同时打 connectionError 标记供调用方熔断。
      const timeoutHit = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      const detail = timeoutHit
        ? `请求超时（${Math.round(timeoutMs / 1000)}s 未返回）`
        : (e?.cause?.code || e?.cause?.message || e?.message || '未知网络错误');
      const err = new Error(`无法调用 aibridge ${chatUrl}：${detail}`, { cause: e });
      err.connectionError = true;
      throw err;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`aibridge HTTP ${res.status}: ${text.slice(0, 300)}`);
    }

    const data = await res.json().catch(() => ({}));
    if (data.ok === false && data.error) {
      throw new Error(`aibridge error: ${data.error}`);
    }
    let content = data.content;
    if (!content && data.choices && data.choices[0]) {
      content = data.choices[0].message?.content || data.choices[0].text;
    }
    const finishReason = data.finish_reason || data.choices?.[0]?.finish_reason || null;
    return { content: content || '', finishReason };
  }
}

/**
 * 拿指定密钥去问一次 whoami：这个 key 在桥接侧对应哪个 Provider / 模型。
 * 不改变当前生效连接，因此可用于「启用前先验一看」。只读标识信息，不消耗 token。
 * @returns {Promise<{ok:boolean, keyName?:string, provider?:string, providerType?:string, model?:string, detail?:string}>}
 */
export async function probeIdentity({ url, apiKey, timeoutMs = 6000 } = {}) {
  const chatUrl = String(url || '').trim() || bridgeUrl();
  const key = String(apiKey || '').trim() || bridgeKey();
  if (!key) return { ok: false, detail: '未填 API Key' };
  let who;
  try {
    who = `${bridgeBase(chatUrl)}/api/bridge/whoami`;
  } catch {
    return { ok: false, detail: `地址不是合法 URL：${chatUrl}` };
  }
  try {
    const res = await fetch(who, { headers: { 'x-api-key': key }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401) return { ok: false, detail: '未携带有效 Key（401）' };
    if (res.status === 403) return { ok: false, detail: 'Key 无效或已被桥接侧禁用（403）' };
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}（桥接版本过旧、没有 whoami 端点时也会这样）` };
    const d = await res.json().catch(() => ({}));
    return { ok: true, keyName: d.keyName || null, provider: d.provider || null, providerType: d.providerType || null, model: d.model || null };
  } catch (e) {
    const hit = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const cause = hit ? `探测超时（${timeoutMs}ms 未响应）` : (e?.cause?.code || e?.cause?.message || e?.message || '未知网络错误');
    return { ok: false, detail: `连不上 ${who}：${cause}` };
  }
}

export const llm = new LLM();
export default llm;
