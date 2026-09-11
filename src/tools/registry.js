/**
 * 工具清单（registry）
 *
 * 双重用途：
 *  1) 前端菜单：按 group 渲染操作按钮，每项映射到 writerTool.execute(args) 的一个 action。
 *  2) AI 窗口（单轮动态工具）：把 tools 当 function schema 注入 system，让 LLM 输出
 *     { tool, args }，用户在确认卡片核对后由后端执行。
 *
 * 约定：所有 tool 的 args 都走 writerTool 的入参形状
 *   { action, dbPath, chapter, totalChapters, force, info, chapters, anchor, from, to, count, material, parts, preface, partNo, modifyInstructions, modificationType }
 * dbPath 在 ainovel 里就是 data/ 下的文件名（如 “以笔行侠.db”），由 writerTool._resolveDbPath 落位。
 */

// 供菜单渲染的高层操作（家长移动端视角，隐藏底层别名）
export const MENU_ACTIONS = [
  { group: '小说', items: [
    { key: 'saveNovelPlan', label: '➕ 新建小说', needsNovel: true, desc: '保存小说规划（书名/简介/设定），无章节大纲时自动生成', argsHint: { info: '{ name, outline, content }' } },
    { key: 'getNovelInfo', label: 'ℹ️ 小说信息', needsNovel: true, desc: '查看小说概要、部结构、章节数' },
  ]},
  { group: '大纲', items: [
    { key: 'generateChapterOutlines', label: '🧭 重建章节大纲', needsNovel: true, desc: '整本重写到 N 章大纲（会清空受影响章节正文，需 force）', argsHint: { totalChapters: '章节总数(默认10)', force: '确认覆盖' } },
    { key: 'addChapterOutline', label: '➕ 插入一章', needsNovel: true, desc: '在指定位置插入一章大纲，后续章顺延', argsHint: { info: '{ no, name, outline }' } },
    { key: 'addChaptersBulk', label: '📚 批量加章', needsNovel: true, desc: '一次追加多章大纲（单事务、不动已有正文），随后用「生成正文」补写', argsHint: { chapters: '[{ name, outline }]', anchor: '{ mode: tail|after, no }' } },
    { key: 'generateOutlinesForRange', label: '🧩 区间补大纲', needsNovel: true, desc: '只给大纲为空的章补大纲（可先插占位章）；已有大纲与正文一律不动', argsHint: { from: '起始章号', to: '结束章号', count: '新增章数（与 from/to 互斥）', anchor: '{ mode: tail|after, no }', material: '本段素材（可选）' } },
    { key: 'updateChapterOutline', label: '✏️ 更新章节大纲', needsNovel: true, desc: '修改某章大纲', argsHint: { info: '{ no, name, outline }' } },
  ]},
  { group: '正文', items: [
    { key: 'generate', label: '✍️ 生成正文', needsNovel: true, desc: '按大纲生成章节正文（chapter=0 批量补缺，force 覆盖）', argsHint: { chapter: '章号(0=全部)', force: '是否覆盖' } },
    { key: 'add', label: '➕ 追加章节', needsNovel: true, desc: '手动追加一章正文', argsHint: { info: '{ name, content }' } },
    { key: 'modify', label: '✏️ 修改章节', needsNovel: true, desc: '按指令修改某章正文', argsHint: { chapter: '章号', modifyInstructions: '修改要求' } },
    { key: 'delete', label: '🗑️ 删除章节', needsNovel: true, desc: '删除指定章节', argsHint: { chapter: '章号' } },
    { key: 'reNumberChapters', label: '🔢 重编号', needsNovel: true, desc: '删除后重排章节序号' },
    { key: 'tuneWordCount', label: '📏 字数治理', needsNovel: true, desc: '按「每章目标字数」逐章处理存量正文：太短则扩充；超长则按全书「超长处理方式」定动作——删减次要场景（trim，章数不变）或拆成多章（split，后续章号顺延）。默认只出预览清单，要写库得显式传 dryRun:false', argsHint: { dryRun: 'true(默认)=只看清单', from: '起始章号(可省)', to: '结束章号(可省)' } },
  ]},
  { group: '设定/分部', items: [
    { key: 'generatePreface', label: '📄 生成本书设定', needsNovel: true, desc: 'AI 生成读者向设定说明页' },
    { key: 'savePreface', label: '✍️ 手写本书设定', needsNovel: true, desc: '人工写入设定说明', argsHint: { preface: 'Markdown 正文' } },
    { key: 'setParts', label: '📚 划分部', needsNovel: true, desc: '手动把章节划分为部', argsHint: { parts: '[{ name, from, to }]' } },
    { key: 'generatePartIntros', label: '🧭 生成部导言', needsNovel: true, desc: '为各部生成导言概要', argsHint: { partNo: '部序号(省略=全部)' } },
    { key: 'listParts', label: '👀 查看部结构', needsNovel: true },
    { key: 'setGenConfig', label: '🎯 每章字数设定', needsNovel: true, desc: '查看或设置全书共同设定（每章目标字数、超长处理方式等）；不传 genCfg 为只读。设完只影响之后的生成，存量章另跑「字数治理」', argsHint: { genCfg: '{ targetWords, tolerancePct, splitPct, overflow: trim|split }（省略=只读，null=清除）' } },
  ]},
  { group: '发布', items: [
    { key: 'publish', label: '🚀 发布', needsNovel: true, desc: '生成本地静态页到 /novel/（ ainovel 自有 action，非 writerTool）' },
  ]},
];

// AI 窗口的可调用工具（function schema，供 LLM 单轮选择）
// 只暴露安全、常用的一层；执行前一律经用户确认。
export const AI_TOOLS = [
  { name: 'getNovelInfo', description: '查看某小说的信息与章节数。', parameters: { dbPath: 'string 小说库文件名(如 以笔行侠.db)' } },
  { name: 'deleteChapter', description: '删除指定章节（会自动重排编号）。', parameters: { dbPath: 'string', chapter: 'integer 章号' } },
  { name: 'addChapter', description: '追加一章正文。', parameters: { dbPath: 'string', name: 'string 章节标题', content: 'string 章节正文' } },
  { name: 'addChaptersBulk', description: '一次新增多章大纲（末尾追加或插到指定章之后）；单事务、绝不修改已有章节正文。想“再加几章”就用这个，不要用 generateOutlines。只有素材、给不出逐章大纲时改用 generateOutlinesForRange。', parameters: { dbPath: 'string', chapters: 'array 每项 { name, outline }，outline 必填', anchor: 'object { mode: "tail"|"after", no }，省略=末尾追加' } },
  { name: 'generateOutlinesForRange', description: '给“大纲为空”的章节补大纲：可只传 from/to 回填已有空位，也可传 count + anchor 先插占位章再逐章补大纲（“丢一段素材、一次追加多章”用这条）。已有大纲的章会被跳过，正文绝不被改动。逐章调用模型，耗时随章数增长；单次上限 50 章，超出部分重跑同一区间即可接着补。', parameters: { dbPath: 'string', from: 'integer 起始章号（可省）', to: 'integer 结束章号（可省）', count: 'integer 新增章数（与 from/to 互斥）', anchor: 'object { mode: "tail"|"after", no }', material: 'string 本段剧情素材/构思（可选）' } },
  { name: 'generateChapter', description: '按大纲生成指定章正文；chapter=0 生成全部缺失章节（新加的章靠它补正文）。', parameters: { dbPath: 'string', chapter: 'integer 章号(0=全部)', force: 'boolean 是否覆盖已有' } },
  { name: 'modifyChapter', description: '按自然语言指令修改某章正文。', parameters: { dbPath: 'string', chapter: 'integer', modifyInstructions: 'string 修改要求' } },
  { name: 'setGenConfig', description: '查看或设置“全书共同设定”里的每章字数目标与超长处理方式。不传 genCfg 就是只读。用户说“以后每章写 3000 字”、“浮动改成 15%”、“超长就拆章”、“超长就删减次要场景”都走这个；它只管之后的生成，已有章节要另外用 tuneWordCount。overflow=split（自由扩展）会拆章并平移后续章号，已发布页面需重新发布。', parameters: { dbPath: 'string', genCfg: 'object { targetWords: 300–20000 或 0=不设限, tolerancePct: 5–50 默认20, splitPct: 20–300 默认60, overflow: "trim"(删减次要场景，章数不变，默认) | "split"(自由扩展，拆成更多章) }，可只传局部字段；传 null 清除' } },
  { name: 'tuneWordCount', description: '按全书目标字数逐章治理存量正文：少于下限则扩充；超长则按全书 overflow 定动作——trim 压缩到合格带（章数不变），split 拆成多章（拆章会平移后续章号）。默认 dryRun=true 只出清单，给人看过后再用 dryRun:false 执行；执行前必须先确认本书已设 targetWords。', parameters: { dbPath: 'string', dryRun: 'boolean 默认 true（不写库）', from: 'integer 起始章号（可省）', to: 'integer 结束章号（可省）' } },
  { name: 'generateOutlines', description: '⚠︎ 整本重建章节大纲：会把命中章号的大纲/标题重写、正文清空。仅用于从头规划一本新书；给已有正文的书加章请用 addChaptersBulk。确实要重建必须带 force=true。', parameters: { dbPath: 'string', totalChapters: 'integer 章节总数', force: 'boolean 确认覆盖（不带则会被系统拦下）' } },
  { name: 'publishNovel', description: '把小说发布为本地可阅读页面。', parameters: { dbPath: 'string' } },
  { name: 'checkConsistency', description: '对小说做一致性检查（章节连续性/角色/时间线）。', parameters: { dbPath: 'string' } },
];
