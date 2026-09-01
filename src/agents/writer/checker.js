/**
 * 小说章节确定性检查层
 *
 * 纯规则检查，不用 LLM。输入数据库与章节号范围，输出问题清单。
 * 每条问题必须带原文证据（行号/偏移），不做主观判断。
 *
 * 设计原则：
 * - 大纲与正文的引用分开定性（source 参数）
 * - 删除场景需要 deletedSnapshot（删前抓的章节快照）
 * - autoFixable 的问题可机械替换，其余只报告
 */

import {
  parseHeadingChapterNo,
  findChapterRefs,
  outlineDependencyEdges,
  outlineEmptyChapters,
  outlineGrainOf,
  isNormalizedHeading,
  extractCharacterRoster,
  extractSettingTerms,
  cnToNum
} from './textUtils.js';

/**
 * 运行确定性检查
 * @param {Object} opts
 * @param {Object} opts.db - WriterDB 实例
 * @param {Array<number>} [opts.chapterNos] - 要检查的章节号列表；不传则检查全部章
 * @param {Object} [opts.deletedSnapshot] - 删除场景：被删章的快照 { no, name, content, outline }
 * @param {boolean} [opts.fullBook=false] - 是否做全书级检查（名字漂移、设定缺失等）
 * @returns {Array<Object>} issues 列表
 */
export function runDeterministicChecks({ db, chapterNos, deletedSnapshot, fullBook = false }) {
  const issues = [];
  const allChapters = db.getAllChapters().filter(c => c.no > 0).sort((a, b) => a.no - b.no);
  const existingNos = new Set(allChapters.map(c => c.no));
  const maxNo = Math.max(...existingNos, 0);

  // 确定要检查的章节
  const targets = chapterNos
    ? allChapters.filter(c => chapterNos.includes(c.no))
    : allChapters;

  // ─── 全书级检查 ────────────────────────────────────────────────

  if (fullBook || !chapterNos) {
    // chapter-gap: 章号不连续
    for (let i = 1; i <= maxNo; i++) {
      if (!existingNos.has(i)) {
        issues.push({
          code: 'chapter-gap',
          chapterNo: i,
          severity: 'error',
          evidence: `章号 ${i} 缺失（现有章号：${[...existingNos].join(', ')}）`,
          autoFixable: false,
          suggestion: '检查是否有章节被误删或编号不连续'
        });
      }
    }

    // 空正文章
    for (const c of allChapters) {
      if (!c.content || !String(c.content).trim()) {
        issues.push({
          code: 'chapter-gap',
          chapterNo: c.no,
          severity: 'warn',
          evidence: `第${c.no}章无正文（name="${c.name || ''}"）`,
          autoFixable: false,
          suggestion: '该章大纲存在但正文为空，需要生成内容'
        });
      }
    }

    // outline-empty: 有正文但无大纲
    const emptyOutlineNos = outlineEmptyChapters(allChapters);
    for (const no of emptyOutlineNos) {
      issues.push({
        code: 'outline-empty',
        chapterNo: no,
        severity: 'warn',
        evidence: `第${no}章有正文但无大纲`,
        autoFixable: false,
        suggestion: '后续无法对该章做大纲层校验；建议补写大纲'
      });
    }

    // outline-grain-jump: 大纲粒度突变
    const grain = outlineGrainOf(allChapters);
    if (grain.median > 0) {
      for (const g of grain.chapters) {
        if (g.ratio < 1 / 3 || g.ratio > 3) {
          issues.push({
            code: 'outline-grain-jump',
            chapterNo: g.no,
            severity: 'info',
            evidence: `第${g.no}章大纲 ${g.length} 字（全书中位数 ${grain.median} 字，比值 ${g.ratio.toFixed(2)}）`,
            autoFixable: false,
            suggestion: '大纲粒度与其他章差异较大，可能混入了不同批次的规划；需 L1 大纲扫描定性'
          });
        }
      }
    }

    // setting-term-absent: 设定具名条目在正文从未出现
    const novelInfo = db.getNovelInfo();
    if (novelInfo) {
      const setting = [novelInfo.outline, novelInfo.content].filter(s => s && String(s).trim()).join('\n\n');
      const settingTerms = extractSettingTerms(setting);
      const bodyText = allChapters.map(c => c.content || '').join(' ');
      if (settingTerms.length > 0 && bodyText.trim()) {
        const absent = settingTerms.filter(t => !bodyText.includes(t));
        if (absent.length > 0) {
          issues.push({
            code: 'setting-term-absent',
            chapterNo: null,
            severity: 'warn',
            evidence: `设定声明名词 ${absent.length} 个在正文从未出现：${absent.join('、')}`,
            autoFixable: false,
            suggestion: '设定与正文可能是两套世界观；以已写正文为准，设定仅供参考'
          });
        }
      }
    }
  }

  // ─── 逐章检查 ──────────────────────────────────────────────────

  // 全书已出场人名累积（用于 name-drift）
  const globalCastSet = new Set();
  if (fullBook || !chapterNos) {
    const novelInfo = db.getNovelInfo();
    const setting = novelInfo ? [novelInfo.outline, novelInfo.content].filter(s => s && String(s).trim()).join('\n\n') : '';
    const settingTerms = new Set(extractSettingTerms(setting));
    for (const c of allChapters) {
      if (!c.content || !String(c.content).trim()) continue;
      const roster = extractCharacterRoster(c.content, setting);
      for (const name of roster) {
        if (settingTerms.has(name) || globalCastSet.has(name)) {
          globalCastSet.add(name);
        }
      }
      // 也加入设定具名条目
      for (const t of settingTerms) globalCastSet.add(t);
    }
  }

  for (const chapter of targets) {
    const { no, name, content, outline } = chapter;
    const text = String(content || '');
    const outlineText = String(outline || '');

    if (!text.trim()) continue; // 空正文跳过

    // ── 标题检查 ──

    const lines = text.split('\n');
    const firstLine = lines.find(l => l.trim()) || '';

    // heading-number: 正文首个章号标题的数字 ≠ 库内 no
    const headingNo = parseHeadingChapterNo(firstLine);
    if (headingNo !== null && headingNo !== no) {
      issues.push({
        code: 'heading-number',
        chapterNo: no,
        severity: 'error',
        evidence: `正文标题写着「第${headingNo}章」但库内章号为 ${no}；首行：${firstLine.slice(0, 60)}`,
        autoFixable: true,
        suggestion: `将标题中的章号替换为 ${no}`
      });
    }

    // heading-style: 首行不是 # 第N章：真标题
    if (firstLine && !isNormalizedHeading(firstLine, no)) {
      // 只有当首行看起来像标题（以 # 开头或含"第N章"）时才报
      if (/^#\s/.test(firstLine) || /第\s*[0-9一二三四五六七八九十百零两]+\s*章/.test(firstLine)) {
        issues.push({
          code: 'heading-style',
          chapterNo: no,
          severity: 'warn',
          evidence: `首行不是规范形态「# 第${no}章：标题」；实际：${firstLine.slice(0, 60)}`,
          autoFixable: true,
          suggestion: '走 normalizeChapterHeading 规范化'
        });
      }
    }

    // name-degenerated: name 形如「第N章」且正文标题里有真标题
    if (name && /^第\s*[0-9一二三四五六七八九十百零两]+\s*章$/.test(name.trim())) {
      // 尝试从正文标题提取真标题
      const titleMatch = text.match(/^#\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章[：:]\s*(.+)$/m);
      if (titleMatch && titleMatch[1].trim()) {
        issues.push({
          code: 'name-degenerated',
          chapterNo: no,
          severity: 'warn',
          evidence: `name 退化为「${name.trim()}」但正文标题有真标题「${titleMatch[1].trim()}」`,
          autoFixable: true,
          suggestion: `从正文标题重新提取 name 为「${titleMatch[1].trim()}」`
        });
      }
    }

    // multi-heading: 一章内出现 ≥2 个 # 第N章 级标题（只统计含章号的标题行）
    const headingMatches = [...text.matchAll(/^#{1,6}\s+第\s*[0-9一二三四五六七八九十百零两]+\s*章/gm)];
    if (headingMatches.length >= 2) {
      issues.push({
        code: 'multi-heading',
        chapterNo: no,
        severity: 'error',
        evidence: `正文内出现 ${headingMatches.length} 个含章号的标题行：${headingMatches.map(m => m[0]).join('；')}`,
        autoFixable: false,
        suggestion: '疑似多章合并或截断，需人工判断'
      });
    }

    // ── 引用检查 ──

    // 正文引用
    const contentRefs = findChapterRefs(text, 'content');
    for (const ref of contentRefs) {
      if (!existingNos.has(ref.no)) {
        issues.push({
          code: 'ref-dangling',
          chapterNo: no,
          severity: 'warn',
          evidence: `正文引用了不存在的「${ref.quote}」（现有章号：${[...existingNos].sort((a, b) => a - b).join(', ')}）；上下文：…${text.slice(Math.max(0, ref.index - 15), ref.index + ref.quote.length + 15).replace(/\n/g, ' ')}…`,
          autoFixable: false,
          suggestion: '删除重排后必然出现；需人工修改引用或保留现状'
        });
      }
      if (ref.no >= no) {
        issues.push({
          code: 'ref-forward',
          chapterNo: no,
          severity: 'info',
          evidence: `正文引用了后文「${ref.quote}」（本章为第${no}章）；上下文：…${text.slice(Math.max(0, ref.index - 15), ref.index + ref.quote.length + 15).replace(/\n/g, ' ')}…`,
          autoFixable: false,
          suggestion: '前瞻写法需人工确认是否合理'
        });
      }
    }

    // 大纲引用
    const outlineRefs = findChapterRefs(outlineText, 'outline');
    for (const ref of outlineRefs) {
      if (!existingNos.has(ref.no)) {
        issues.push({
          code: 'ref-dangling',
          chapterNo: no,
          severity: 'info',
          evidence: `大纲引用了不存在的「${ref.quote}」（现有章号：${[...existingNos].sort((a, b) => a - b).join(', ')}）`,
          autoFixable: false,
          suggestion: '大纲引用落空；需修改大纲'
        });
      }
    }

    // outline-dep-broken: 大纲依赖边的目标章不存在
    const edges = outlineDependencyEdges(outlineText);
    for (const edge of edges) {
      if (edge.type === 'specific' && !existingNos.has(edge.targetNo)) {
        issues.push({
          code: 'outline-dep-broken',
          chapterNo: no,
          severity: 'warn',
          evidence: `大纲依赖边「${edge.quote}」的目标章 ${edge.targetNo} 不存在`,
          autoFixable: false,
          suggestion: '需先修大纲再修正文'
        });
      }
      if (edge.type === 'range') {
        // "前N章" 依赖 1~N 章，检查是否有缺失
        for (let i = 1; i <= edge.targetNo; i++) {
          if (!existingNos.has(i)) {
            issues.push({
              code: 'outline-dep-broken',
              chapterNo: no,
              severity: 'warn',
              evidence: `大纲范围依赖「${edge.quote}」需要第 ${i} 章，但该章不存在`,
              autoFixable: false,
              suggestion: '需先修大纲再修正文'
            });
          }
        }
      }
    }

    // ── 删除场景特有检查 ──

    if (deletedSnapshot) {
      const deletedNo = deletedSnapshot.no;

      // ref-stale-by-delete: 引用了被删章号
      for (const ref of contentRefs) {
        if (ref.no === deletedNo) {
          issues.push({
            code: 'ref-stale-by-delete',
            chapterNo: no,
            severity: 'warn',
            evidence: `正文引用了已被删除的「第${deletedNo}章」；上下文：…${text.slice(Math.max(0, ref.index - 15), ref.index + ref.quote.length + 15).replace(/\n/g, ' ')}…`,
            autoFixable: false,
            suggestion: '需修改正文中的引用'
          });
        }
      }
      for (const ref of outlineRefs) {
        if (ref.no === deletedNo) {
          issues.push({
            code: 'ref-stale-by-delete',
            chapterNo: no,
            severity: 'info',
            evidence: `大纲引用了已被删除的「第${deletedNo}章」`,
            autoFixable: false,
            suggestion: '需修改大纲中的引用'
          });
        }
      }

      // residue-by-delete: 被删章独有人名仍出现在后文
      if (deletedSnapshot.content && no > deletedNo) {
        const deletedText = String(deletedSnapshot.content);
        const deletedRoster = extractCharacterRoster(deletedText, '');
        // 检查这些人名是否只出现在被删章（全书其他章都没出现过）
        const otherBody = allChapters
          .filter(c => c.no !== deletedNo && c.content)
          .map(c => String(c.content))
          .join(' ');
        const uniqueToDeleted = deletedRoster.filter(name => !otherBody.includes(name));
        if (uniqueToDeleted.length > 0 && text) {
          const foundInThis = uniqueToDeleted.filter(name => text.includes(name));
          if (foundInThis.length > 0) {
            issues.push({
              code: 'residue-by-delete',
              chapterNo: no,
              severity: 'warn',
              evidence: `被删章（第${deletedNo}章）独有人名 ${foundInThis.join('、')} 仍出现在第${no}章`,
              autoFixable: false,
              suggestion: '需人工判断是否修改后文'
            });
          }
        }
      }
    }

    // ── 名字漂移（全书级） ──

    if (fullBook || !chapterNos) {
      const novelInfo = db.getNovelInfo();
      const setting = novelInfo ? [novelInfo.outline, novelInfo.content].filter(s => s && String(s).trim()).join('\n\n') : '';
      const settingTerms = new Set(extractSettingTerms(setting));
      // 本章之前各章已出场名单
      const prevChapters = allChapters.filter(c => c.no > 0 && c.no < no);
      const prevBody = prevChapters.map(c => c.content || '').join(' ');
      const prevRoster = prevBody ? extractCharacterRoster(prevBody, setting) : [];
      const knownNames = new Set([...settingTerms, ...prevRoster]);

      const chapterRoster = extractCharacterRoster(text, setting);
      const newNames = chapterRoster.filter(n => !knownNames.has(n));
      if (newNames.length > 0) {
        // 只报频次 ≥2 的（过滤偶发噪声）
        const counter = new Map();
        for (const n of newNames) {
          const count = text.split(n).length - 1;
          if (count >= 2) counter.set(n, count);
        }
        if (counter.size > 0) {
          issues.push({
            code: 'name-drift',
            chapterNo: no,
            severity: 'warn',
            evidence: `本章出现的新人名（不在设定与前文出场名单中）：${[...counter.entries()].map(([n, c]) => `${n}(${c})`).join('、')}`,
            autoFixable: false,
            suggestion: '可能是新造人名；需人工确认是否合理'
          });
        }
      }
    }
  }

  return issues;
}
