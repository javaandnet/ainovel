/**
 * TTS 合成引擎抽象层
 *
 * 目标：把「具体走哪家上游合成一句/一段音频」从缓存/裁剪逻辑（ttsStore）里剥出来，
 * 让默认仍走免密的微软边缘接口（edge），同时可切换到带情感风格的 Azure（azure）。
 *
 * 统一契约（ttsStore 只认这个）：
 *   engine.name                     'edge' | 'azure'
 *   engine.supportsStyle            是否吃 style（情感风格）参数：edge=false, azure=true
 *   engine.available()              当前环境是否可用（azure 需 key/region；edge 恒 true）
 *   await engine.synthesizeToFile(text, voice, rate, ctx)
 *       ctx = { tmpDir, style, segments, breakMs }
 *       → { filePath, closer? }  filePath 为落在 tmpDir 下的 mp3；closer 用完释放上游连接（edge 需 close）
 *
 * 说明：text 是「一个朗读单元」（读者模式 = 一句；段落模式 = 一整段）。
 * 段落模式下 segments（句数组）与 breakMs（句间停顿毫秒）用于拼 <break>，避免逐句合成造成的跨句韵律断裂。
 * edge 不支持 style/break：把单元原样交给微软边缘接口，情感风格自动降级为「中性朗读」。
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import fs from 'fs-extra';
import path from 'path';

/* ── 通用小工具 ── */
const xmlEscape = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** 只允许字母数字与 -_ 的 style 名进入 SSML，防注入 */
const sanitizeStyle = (style) => {
  const v = String(style || '').trim();
  return /^[\w-]+$/.test(v) ? v : '';
};

/* ── Edge：微软边缘公开接口（免 key，中性音色） ── */
class EdgeEngine {
  constructor() {
    this.name = 'edge';
    this.supportsStyle = false;
  }
  available() { return true; }
  async synthesizeToFile(text, voice, rate, ctx) {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3, { sentenceBoundaryEnabled: false });
    const result = await tts.toFile(ctx.tmpDir, text, { rate: rate || '+0%' });
    const filePath = result && result.audioFilePath;
    return { filePath, closer: () => { try { tts.close(); } catch { /* 关闭失败不影响结果 */ } } };
  }
}

/* ── Azure：认知服务语音合成 REST（带 express-as 情感风格 + 段落级 break） ── */
class AzureEngine {
  constructor() {
    this.name = 'azure';
    this.supportsStyle = true;
    this.key = process.env.AZURE_SPEECH_KEY || '';
    this.region = process.env.AZURE_SPEECH_REGION || '';
  }
  available() { return !!(this.key && this.region); }

  /** 拼 SSML：有 style 走 mstts:express-as；有 segments 走句间 <break>，否则整段读。 */
  buildSSML(text, voice, rate, { style, segments, breakMs }) {
    const lang = String(voice).split('-')[0] || 'zh-CN';
    const prosody = `<prosody rate="${xmlEscape(rate || '+0%')}">`;
    const body = (Array.isArray(segments) && segments.length)
      ? segments.map((s) => xmlEscape(s)).join(`<break time="${Number(breakMs) || 0}ms"/>`)
      : xmlEscape(text);
    const inner = `${prosody}${body}</prosody>`;
    const styled = sanitizeStyle(style);
    const voiced = styled
      ? `<voice name="${xmlEscape(voice)}"><mstts:express-as style="${styled}" styledegree="1.0">${inner}</mstts:express-as></voice>`
      : `<voice name="${xmlEscape(voice)}">${inner}</voice>`;
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" `
      + `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${xmlEscape(lang)}">${voiced}</speak>`;
  }

  async synthesizeToFile(text, voice, rate, ctx) {
    if (!this.available()) throw new Error('Azure 语音未配置（缺 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION）');
    const ssml = this.buildSSML(text, voice, rate, ctx);
    const url = `https://${this.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': this.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'ainovel-tts',
        Accept: 'audio/mp3',
      },
      body: ssml,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Azure TTS ${res.status} ${res.statusText}${detail ? `：${detail.slice(0, 200)}` : ''}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('Azure TTS 返回空音频');
    const filePath = path.join(ctx.tmpDir, `azure-${Date.now()}-${Math.random().toString(36).slice(2)}.mp3`);
    fs.writeFileSync(filePath, buf);
    return { filePath };
  }
}

const edge = new EdgeEngine();
const azure = new AzureEngine();
const REGISTRY = { edge, azure };

/** 默认情感风格（仅 azure 生效）：narration 适合小说旁白，读起来最不像「播报」。 */
const DEFAULT_AZURE_STYLE = process.env.AZURE_TTS_STYLE || 'narration';
/** 段落模式下句间停顿（毫秒）：给读者「自然换气」的留白，可用 env 调。 */
const DEFAULT_BREAK_MS = Math.max(0, Number(process.env.TTS_BREAK_MS ?? 220));
/** 逐句自动情感：azure 且未显式指定 style 时，按句子情绪线索自动挑 style（治「整章一个调子」）。 */
const AUTO_STYLE = process.env.NOVEL_TTS_AUTO_STYLE !== '0';

/* 情绪关键词（参照 xiaozhi-server detectEmotion，但按 Azure 通用 style 细化到 5 类 + 旁白/对白）。
 * 这些 style 名（cheerful/sad/angry/fearful/confused）在 zh 多神经音色上普遍支持；
 * 兜底 base style 需与音色匹配（如 Yunxi 有 narration），换音色时用 AZURE_TTS_STYLE 指定。 */
const EMOTION_LEXICON = [
  { style: 'cheerful', words: ['哈哈', '太好了', '太棒了', '真棒', '开心', '高兴', '喜欢', '谢谢', '感谢', '厉害', '精彩', '太好了', '耶', '好啊', '太好了'] },
  { style: 'angry', words: ['可恶', '混蛋', '该死', '生气', '愤怒', '凭什么', '岂能', '滚', '蠢', '废物', '可恨', '怒', '胡说', '放肆'] },
  { style: 'sad', words: ['难过', '伤心', '哭', '眼泪', '泪', '抱歉', '对不起', '遗憾', '可怜', '哀', '痛心', '舍不得'] },
  { style: 'fearful', words: ['害怕', '恐惧', '发抖', '颤抖', '战战兢兢', '胆小', '吓', '救命', '危险', '心惊'] },
];
const CONFUSE_WORDS = ['为什么', '为何', '怎么', '难道', '究竟', '不明白', '困惑', '怎么可能', '为什么'];
const DIALOGUE_RE = /[“\u201c].+?[”\u201d]/;

/**
 * 逐句情感推断（azure 专用）：命中情绪词→对应 style；疑问+困惑词→confused；
 * 引号对白无强情绪→保留 base；纯旁白→base（默认 narration）。
 * @param {string} text 一个朗读单元（一句）
 * @returns {string} Azure express-as style 名
 */
export function detectAzureStyle(text) {
  const t = String(text || '');
  for (const e of EMOTION_LEXICON) {
    if (e.words.some((w) => t.includes(w))) return e.style;
  }
  if (/[？?]/.test(t) && CONFUSE_WORDS.some((w) => t.includes(w))) return 'confused';
  if (DIALOGUE_RE.test(t)) return process.env.AZURE_TTS_DIALOGUE_STYLE || DEFAULT_AZURE_STYLE;
  return DEFAULT_AZURE_STYLE;
}

/**
 * 解析某朗读单元最终生效的 style：
 *   edge → 空串（不吃 style，也不计入缓存键）
 *   azure + 显式 style → 用它
 *   azure + 未指定 + AUTO_STYLE → 逐句自动推断（detectAzureStyle）
 *   azure + 未指定 + 关闭自动 → base（DEFAULT_AZURE_STYLE）
 * 调用方（ttsStore）在算缓存键前调用，保证「同句同情感」命中同一份 mp3。
 */
export function resolveStyle(engine, explicitStyle, text) {
  if (!engine.supportsStyle) return '';
  const v = sanitizeStyle(explicitStyle);
  if (v) return v;
  if (engine.name === 'azure' && AUTO_STYLE) return detectAzureStyle(text);
  return DEFAULT_AZURE_STYLE;
}

/**
 * 选定引擎：显式指定优先，否则读 NOVEL_TTS_ENGINE（默认 edge）。
 * 指定/配置成 azure 但缺凭证时，自动回落 edge 并记一次告警——绝不让整章 503。
 */
export function resolveEngine(preferred) {
  const want = String(preferred || process.env.NOVEL_TTS_ENGINE || 'edge').toLowerCase();
  const e = REGISTRY[want];
  if (!e) {
    console.warn(`[tts] 未知引擎「${want}」，改用 edge`);
    return edge;
  }
  if (!e.available()) {
    console.warn(`[tts] 引擎「${want}」在当前环境不可用（缺凭证），回落 edge`);
    return edge;
  }
  return e;
}

/** 归一化情感风格：azure 才吃 style，edge 一律忽略（避免同一句因 style 记两个键）。
 *  仅用于「调用方已知最终 style」的展示/兜底；带逐句自动推断的解析请用 resolveStyle。 */
export function normalizeStyle(engine, style) {
  if (!engine.supportsStyle) return '';
  const v = sanitizeStyle(style);
  return v || (engine.name === 'azure' ? DEFAULT_AZURE_STYLE : '');
}

export { edge, azure, DEFAULT_BREAK_MS, DEFAULT_AZURE_STYLE };
