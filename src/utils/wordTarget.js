/**
 * 每章字数目标（全书共同设定里唯一需要结构化的那一项）
 *
 * 为什么单独抽成公共模块：同一个「目标 3000 / 允许 2400–3600 / 超过 4800 就拆章」
 * 要同时被四处用到——正文提示词、大纲提示词、生成后的长度判定、以及管理页把区间显示给人看。
 * 各写一份必然漂移（部名的中文数字口径就是这么分叉过一次），所以口径只在这里定义。
 *
 * 度量单位与全站一致：字符串长度（正文的 Markdown 原文，含标点与空行），
 * 也就是界面「正文 X 字」和 SQL `length(content)` 报的那个数，不再另造一种统计。
 */

/** 未配置时的取值：targetWords=0 表示不设限（与引入本功能之前的行为完全一致） */
export const GEN_CFG_DEFAULTS = { targetWords: 0, tolerancePct: 20, splitPct: 60, overflow: 'trim' };

/**
 * 一章写超了怎么办：全书一个口径，界面「① 小说设定」里选。
 *   trim  = 删减次要场景，章数不变（引入本选项之前的默认行为）
 *   split = 自由扩展，把超出的内容拆成更多章，章数与总字数都会增加
 * 两者都只为同一个目的：交出去的每一章都落在合格带内。
 */
export const OVERFLOW_MODES = ['trim', 'split'];
export const OVERFLOW_DEFAULT = 'trim';

/** 取值边界：低于 MIN 的目标写不出一个完整场景，高于 MAX 多半是把手误填成万字 */
const LIMITS = {
  targetWords: { min: 300, max: 20000 },
  tolerancePct: { min: 5, max: 50 },
  splitPct: { min: 20, max: 300 },
};

/** 旧口径：目标字数曾被当作文字标记追加进「角色/世界观设定」正文里（saveNovelPlan 的 targetWordCount） */
export const LEGACY_MARKER_RE = /【每章目标字数[：:]\s*(\d+)】/;

/**
 * 从设定正文里捞旧标记。只为兼容存量数据保留：新写入一律走结构化的 gen_cfg，
 * 不再往给人读的设定文字里塞方括号标记（那种写法既没界面入口，也会随正文被误编辑）。
 */
export function parseLegacyMarker(...texts) {
  for (const t of texts) {
    const m = String(t || '').match(LEGACY_MARKER_RE);
    if (m) return Number(m[1]);
  }
  return 0;
}

function clampInt(raw, { min, max }, name) {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} 必须是数字（收到 ${JSON.stringify(raw)}）`);
  const i = Math.round(n);
  if (i < min || i > max) throw new Error(`${name} 超出可用范围（${min}–${max}，收到 ${i}）`);
  return i;
}

/**
 * 校验并补齐配置。抛错而不是静默纠正：界面上填了 999999 却悄悄存成 20000，
 * 人不会知道，下次来看数字还对不上。
 * @param {Object|null|undefined} raw
 * @returns {{targetWords:number, tolerancePct:number, splitPct:number}}
 */
export function normalizeGenConfig(raw) {
  if (raw === null || raw === undefined || raw === '') return { ...GEN_CFG_DEFAULTS };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('生成设定必须是对象');
  const out = { ...GEN_CFG_DEFAULTS };
  // 只认这几个键：多余键说明调用方形状错了，忽略会让错误一直传下去
  const extra = Object.keys(raw).filter((k) => !(k in GEN_CFG_DEFAULTS));
  if (extra.length) throw new Error(`生成设定含未知字段：${extra.join('、')}`);

  // 超长处理方式只认两个值。这里同样抛错不纠正：把 'Trim'、true、1 之类静默当默认值，
  // 界面选的和实际生效的就不是同一件事，而这件事会直接改书结构（拆章平移章号）。
  if (raw.overflow !== undefined && raw.overflow !== null && raw.overflow !== '') {
    const m = String(raw.overflow).trim();
    if (!OVERFLOW_MODES.includes(m)) {
      throw new Error(`超长处理方式只接受 ${OVERFLOW_MODES.join(' / ')}（收到 ${JSON.stringify(raw.overflow)}）`);
    }
    out.overflow = m;
  }
  // targetWords 允许 0（=不设限），所以不能拿「假值」当「未填」
  if (raw.targetWords !== undefined && raw.targetWords !== null && raw.targetWords !== '') {
    const n = Number(raw.targetWords);
    out.targetWords = n === 0 ? 0 : clampInt(n, LIMITS.targetWords, '每章目标字数');
  }
  for (const k of ['tolerancePct', 'splitPct']) {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') {
      out[k] = clampInt(raw[k], LIMITS[k], k === 'tolerancePct' ? '允许浮动比例' : '拆章阈值');
    }
  }
  return out;
}

/**
 * 把配置换算成判定区间。
 * @returns {{target:number,min:number,max:number,splitAt:number,on:boolean,overflow:string}}
 *   on=false 表示未设限（四个数字一律 0，调用方据此跳过判定，不要拿 0 去比大小）；
 *   overflow 不随 on 开关走——未设字数目标时它没意义，但带着它返回可以让界面少读一次配置。
 */
export function wordBand(cfg) {
  const c = normalizeGenConfig(cfg);
  if (!c.targetWords) return { target: 0, min: 0, max: 0, splitAt: 0, on: false, overflow: c.overflow };
  const t = c.targetWords;
  const min = Math.round(t * (1 - c.tolerancePct / 100));
  const max = Math.round(t * (1 + c.tolerancePct / 100));
  // 阈值取「超过目标多少」，所以拆章线必须不低于合格上限，否则两者互相矛盾
  const splitAt = Math.max(max, Math.round(t * (1 + c.splitPct / 100)));
  return { target: t, min, max, splitAt, on: true, overflow: c.overflow };
}

/**
 * 生效区间的唯一算法：结构化的 gen_cfg 优先，旧的文字标记只作回落。
 * 抽出来是因为管理页也得显示同一个数——界面若自己再判一次优先级，就会出现
 * 「页面说没设限、生成时却按 3000 字要求写」这种自相矛盾。
 * @param {Object|null} cfg - 已保存的生成设定
 * @param {Array<string>} legacyTexts - 设定正文/概要，用于捞旧标记
 */
export function effectiveBand(cfg, legacyTexts = []) {
  // 存过配置就只认配置，包括“显式设成 0 = 不限”：否则刚点过的「取消字数限制」
  // 会被设定正文里那句旧标记顶回去，取消成了无效操作。
  if (cfg && typeof cfg === 'object' && cfg.targetWords !== undefined && cfg.targetWords !== null) {
    return wordBand(cfg);
  }
  const legacy = parseLegacyMarker(...legacyTexts);
  // 旧标记只带得出目标字数；超长处理方式仍认已存的 cfg——
  // 它可能只存了 overflow 这一个字段（字数目标是早年用旧标记设的）。
  const base = cfg && typeof cfg === 'object' ? { overflow: cfg.overflow } : {};
  return legacy ? wordBand({ ...base, targetWords: legacy }) : wordBand(base);
}

/**
 * 按区间给一章的实际长度定性。
 * @returns {'none'|'ok'|'short'|'long'|'split'}
 */
export function classifyLength(len, band) {
  const L = Number(len) || 0;
  if (!band.on) return 'none';
  if (L < band.min) return 'short';
  if (L > band.splitAt) return 'split';
  if (L > band.max) return 'long';
  return 'ok';
}

/** 人读的一行区间说明（管理页与执行报告共用，避免两处各拼一句） */
export function bandText(band) {
  if (!band.on) return '未设每章字数目标（不做长度判定）';
  return `目标 ${band.target} 字 · 合格 ${band.min}–${band.max} 字 · 超过 ${band.splitAt} 字建议拆章 · ${overflowText(band)}`;
}

/** 超长处理方式的人读说法：界面、报告、确认弹窗共用，不各拼一句 */
export function overflowText(band) {
  return band?.overflow === 'split'
    ? '超长时自由扩展：拆成更多章（章数与总字数会增加）'
    : '超长时删减次要场景（章数不变）';
}

/**
 * 一章的大纲最长写多少字。为什么要有这条线：实测大纲长度与正文字数强相关——
 * 大纲 108–451 字的章正文 2400–2937 字（合格），大纲 1267–1400 字的章正文 3505–4175 字（超标）。
 * 正文提示词里写多少遍「不得超 X 字」都拗不过一份把情节点铺满的大纲，
 * 所以上限必须设在大纲这一层。target/6 这个比例就是拿上面两簇数据定出来的（3000 → 500）。
 * @returns {number} 未设限（on=false）时返回 0，调用方据此跳过上限判定
 */
export function outlineCapFor(band) {
  if (!band?.on) return 0;
  return Math.max(150, Math.round(band.target / 6));
}

/**
 * 自由扩展模式下一章该拆成几份、每份写多少字。
 * 除数用 max 而不是 target：份数取「刚好能让每份不超合格上限」的最小值。
 * 7000 字按 max 拆 2 份各 3500（都在带内），按 target 会拆 3 份各 2333（贴在下限下面、还得补写）。
 * 份数越少，需要补写与挪章号的机会越少。
 * 拆完仍可能低于 min（len 在 max 与 2×min 之间时必然如此），由调用方跑扩写补齐。
 * @returns {{parts:number, perPart:number}} parts=1 表示不需拆
 */
export function overflowParts(len, band) {
  const L = Number(len) || 0;
  if (!band.on || L <= band.max) return { parts: 1, perPart: L };
  const parts = Math.max(2, Math.ceil(L / band.max));
  return { parts, perPart: Math.round(L / parts) };
}

/**
 * 拆章后两半各自该写到多少字：按实际长度比例分，而不是机械对半。
 * 5600 字拆两半各 2800，正好落进 3000±20% 的合格带；但 4900 字对半是 2450，
 * 贴着下限，所以给一个「不低于 min」的兜底分配，让两半都落在带内。
 * @returns {[number, number]}
 */
export function splitTargets(len, band) {
  if (!band.on) return [Math.round(len / 2), Math.round(len / 2)];
  const ideal = Math.min(band.target, Math.round(len / 2));
  const a = Math.max(band.min, ideal);
  const b = Math.max(band.min, len - a);
  return [a, b];
}
