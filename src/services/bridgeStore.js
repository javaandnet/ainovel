/**
 * 桥接连接配置存储：aibridge API Key 清单 + 当前生效项 + 可选的地址覆盖
 *
 * 为什么要有它：密钥原先只活在 .env 里，换一条 Key 要改文件再重启；而「正文走哪个模型」
 * 直接决定生成快慢与质量，需要一个能随时切换、重启后仍然生效的入口。
 *
 * 落盘 data/system/bridge.json（该目录已在 .gitignore 覆盖范围内），写入权限 0600：
 * 里面有明文密钥，敏感度与 .env 同级，不给其它用户读。
 *
 * 出参一律脱敏——对外结构里只有 keyPrefix，绝不带明文。这一点必须靠自觉：
 * /api/admin/ 前缀的响应按设计不过 scrub 净化（要回显地址与用户名），
 * 所以「不把明文放进返回值」是唯一防线。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { setBridgeOverride, getBridgeConfig, probeIdentity } from '../agent/llm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', '..', 'data', 'system');
const STORE_FILE = path.join(STORE_DIR, 'bridge.json');

/** 明文密钥只在进程内与本地文件之间流动；对外一律截断成前缀（能认出是哪条即可） */
const prefixOf = (key) => (key ? `${String(key).slice(0, 13)}…` : '');

let state = { url: null, activeId: null, keys: [] };
let loaded = false;

function load() {
  if (loaded) return state;
  loaded = true;
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    state = {
      url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : null,
      activeId: raw.activeId || null,
      keys: Array.isArray(raw.keys) ? raw.keys.filter(k => k && k.id && k.key) : [],
    };
  } catch {
    // 文件不存在或损坏都按「还没配过」处理：读库失败不该让整个服务起不来，
    // 但会留下告警，避免悄悄退回 .env 却以为用的是控制台里的那条。
    if (fs.existsSync(STORE_FILE)) console.warn('[bridge] data/system/bridge.json 解析失败，本次按未配置处理（不覆盖 .env）');
    state = { url: null, activeId: null, keys: [] };
  }
  // activeId 指向已被删掉的条目时不能装作没事——那会让用户以为切换生效了
  if (state.activeId && !state.keys.find(k => k.id === state.activeId)) {
    console.warn(`[bridge] 生效项 ${state.activeId} 已不存在，本次回落 .env / 环境变量`);
    state.activeId = null;
  }
  applyToLlm();
  return state;
}

function save() {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STORE_FILE, 0o600); } catch { /* 某些文件系统不支持，写入 mode 已尽力 */ }
}

/** 把当前生效项推给 llm；activeId 为空即清除覆盖，回落到环境变量 / .env */
function applyToLlm() {
  const active = state.keys.find(k => k.id === state.activeId) || null;
  setBridgeOverride({ url: state.url, apiKey: active ? active.key : null });
}

function find(id) {
  load();
  return state.keys.find(k => k.id === id) || null;
}

/**
 * 服务启动时必须显式调一次：把 bridge.json 里选的链路推给 llm。
 *
 * 为什么不能省：load() 是惰性的，原本只有 listPublic/add/activate… 这些入口会触发，
 * 而启动路径上一个都没调 —— 结果是「控制台切换」重启后是哑的，必须有人打开一次
 * 设置页才生效，中间所有生成请求都静默用着 .env 的密钥（实测：控制台选了 Ollama
 * 远程，正文却一直在跑本地那台 Qwen3.8，排查时因为看不到链路归属绕了很大一圈）。
 * 这里除了落地覆盖，还把真实链路打出来，让「在跟哪个模型说话」开机即可见。
 *
 * 探测只读 whoami、不消耗 token，且异步不阻塞启动；失败只告警，不影响服务起来。
 * @returns {{url:string, source:string, keyPrefix:string, hasKey:boolean, activeName:string|null}}
 */
export function initBridge() {
  const cur = listPublic().current;
  const via = cur.source === 'console' ? `控制台「${cur.activeName || '?'}」` : '.env / 环境变量（控制台未选生效项）';
  console.log(`[bridge] 正文生成链路: ${cur.url} ← ${via}${cur.hasKey ? ` Key ${cur.keyPrefix}` : ' ⚠ 无可用 Key'}`);
  if (cur.identity?.model) {
    console.log(`[bridge] 上游模型: ${cur.identity.provider || '?'} / ${cur.identity.model}（缓存于 ${cur.identity.at || '?'}）`);
  }
  probeIdentity({ url: cur.url })
    .then(p => {
      if (p.ok) console.log(`[bridge] 桥接侧确认: ${p.provider} / ${p.model}（Key ${p.keyName}）`);
      else console.warn(`[bridge] 桥接侧探测失败（不影响启动，生成时会再报错）：${p.detail}`);
    })
    .catch(e => console.warn(`[bridge] 桥接侧探测异常：${e?.message || e}`));
  return cur;
}

/** 对外形态：带当前生效链路与每条 Key 的最近一次探测结果，不含任何明文密钥 */
function listPublic() {
  load();
  const current = getBridgeConfig();
  const active = state.keys.find(k => k.id === state.activeId) || null;
  return {
    // source: console = 用控制台里选的那条；env = 回落到环境变量 / .env
    current: {
      url: current.url,
      source: current.source,
      keyPrefix: current.keyPrefix,
      hasKey: current.hasKey,
      activeName: active ? active.name : null,
      // 生效项自己存过 probe 就直接复用，省一次网络往返也避免列表页每次刷新都打桥接
      identity: active?.probe || null,
    },
    urlOverride: state.url,
    activeId: state.activeId,
    keys: state.keys.map(k => ({
      id: k.id, name: k.name, prefix: prefixOf(k.key),
      addedAt: k.addedAt || null, probe: k.probe || null,
    })),
  };
}

export const bridgeStore = {
  listPublic,

  /** 新增一条 Key；url 留空表示沿用当前地址覆盖或 .env 里的地址 */
  add({ name, key, probe = null } = {}) {
    load();
    const nm = String(name || '').trim();
    const k = String(key || '').trim();
    if (!nm) return { error: '缺少名称' };
    if (!k) return { error: '缺少 API Key' };
    if (k.length < 8) return { error: 'API Key 太短，确认复制完整了再填' };
    if (state.keys.some(x => x.key === k)) {
      const dup = state.keys.find(x => x.key === k);
      return { error: `这条 Key 已存在（名称「${dup.name}」）` };
    }
    const item = { id: crypto.randomBytes(6).toString('hex'), name: nm, key: k, addedAt: new Date().toISOString(), probe };
    state.keys.push(item);
    save();
    return { item: { id: item.id, name: item.name, prefix: prefixOf(item.key), addedAt: item.addedAt, probe } };
  },

  rename({ id, name } = {}) {
    const item = find(id);
    if (!item) return { error: '找不到该条目' };
    const nm = String(name || '').trim();
    if (!nm) return { error: '缺少名称' };
    item.name = nm;
    save();
    return { ok: true };
  },

  remove(id) {
    load();
    const item = state.keys.find(k => k.id === id);
    if (!item) return { error: '找不到该条目' };
    state.keys = state.keys.filter(k => k.id !== id);
    // 删的正是当前生效项：必须同时清掉覆盖，否则 llm 里还留着已删密钥在跑生成
    const wasActive = state.activeId === id;
    if (wasActive) state.activeId = null;
    save();
    applyToLlm();
    return { ok: true, wasActive };
  },

  /** 启用某条 Key；传 null / 空表示不启用任何条目（回落 .env） */
  activate(id) {
    load();
    if (!id) {
      state.activeId = null;
      save(); applyToLlm();
      return { ok: true, active: null };
    }
    const item = find(id);
    if (!item) return { error: '找不到该条目' };
    state.activeId = id;
    save(); applyToLlm();
    return { ok: true, active: { id: item.id, name: item.name }, current: getBridgeConfig() };
  },

  /** 覆盖桥接地址；传空串清除覆盖，回落到 AIBRIDGE_URL / .env */
  setUrl(url) {
    load();
    const u = String(url || '').trim();
    if (u) {
      try {
        const parsed = new URL(u);
        if (!/^https?:$/.test(parsed.protocol)) return { error: '只支持 http/https 地址' };
      } catch {
        return { error: '地址不是合法 URL（要填完整端点，如 http://localhost:3300/api/bridge/chat）' };
      }
    }
    state.url = u || null;
    save(); applyToLlm();
    return { ok: true, url: state.url };
  },

  /** 用某条 Key 问一次 whoami，结果缓存进该条目（列表要显示「连到哪个模型」） */
  async test(id) {
    load();
    const item = find(id);
    if (!item) return { error: '找不到该条目' };
    const probe = await probeIdentity({ url: state.url, apiKey: item.key });
    item.probe = { ...probe, at: new Date().toISOString() };
    save();
    return { ok: true, prefix: prefixOf(item.key), probe: item.probe };
  },

  /** 内部用：取明文 Key 供服务端发起真实请求，绝不调用方直接 res.json 它 */
  secretOf(id) {
    const item = find(id);
    return item ? item.key : null;
  },
};

export default bridgeStore;
