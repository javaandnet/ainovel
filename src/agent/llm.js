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

const AIBRIDGE_URL = process.env.AIBRIDGE_URL || readEnvFile('AIBRIDGE_URL') || 'http://localhost:3300/api/bridge/chat';
// 默认用 Local(Qwen3.8) Key：创作/生成以质量优先。密钥从环境变量或本地 .env 注入，源码不硬编码
const AIBRIDGE_API_KEY = process.env.AIBRIDGE_API_KEY || readEnvFile('AIBRIDGE_API_KEY') || '';

if (!AIBRIDGE_API_KEY) {
  console.warn('[llm] AIBRIDGE_API_KEY 未设置：请复制 .env.example 为 .env 并填入密钥（AI 生成/解析接口将不可用，菜单式读写与发布不受影响）');
}

class LLM {
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

    const res = await fetch(AIBRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': AIBRIDGE_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout || 600000),
    });

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

export const llm = new LLM();
export default llm;
