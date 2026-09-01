/**
 * 工具清单（registry）
 *
 * 双重用途：
 *  1) 前端菜单：按 group 渲染操作按钮，每项映射到 writerTool.execute(args) 的一个 action。
 *  2) AI 窗口（单轮动态工具）：把 tools 当 function schema 注入 system，让 LLM 输出
 *     { tool, args }，用户在确认卡片核对后由后端执行。
 *
 * 约定：所有 tool 的 args 都走 writerTool 的入参形状
 *   { action, dbPath, chapter, totalChapters, force, info, parts, preface, partNo, modifyInstructions, modificationType }
 * dbPath 在 ainovel 里就是 data/ 下的文件名（如 "以笔行侠.db"），由 writerTool._resolveDbPath 落位。
 */

// 供菜单渲染的高层操作（家长移动端视角，隐藏底层别名）
export const MENU_ACTIONS = [
  { group: '小说', items: [
    { key: 'saveNovelPlan', label: '➕ 新建小说', needsNovel: true, desc: '保存小说规划（书名/简介/设定），无章节大纲时自动生成', argsHint: { info: '{ name, outline, content }' } },
    { key: 'getNovelInfo', label: 'ℹ️ 小说信息', needsNovel: true, desc: '查看小说概要、部结构、章节数' },
  ]},
  { group: '大纲', items: [
    { key: 'generateChapterOutlines', label: '🧭 生成章节大纲', needsNovel: true, desc: '按规划批量生成各章大纲', argsHint: { totalChapters: '章节总数(默认10)' } },
    { key: 'addChapterOutline', label: '➕ 添加章节大纲', needsNovel: true, desc: '在指定位置插入一章大纲', argsHint: { info: '{ no, name, outline }' } },
    { key: 'updateChapterOutline', label: '✏️ 更新章节大纲', needsNovel: true, desc: '修改某章大纲', argsHint: { info: '{ no, name, outline }' } },
  ]},
  { group: '正文', items: [
    { key: 'generate', label: '✍️ 生成正文', needsNovel: true, desc: '按大纲生成章节正文（chapter=0 批量补缺，force 覆盖）', argsHint: { chapter: '章号(0=全部)', force: '是否覆盖' } },
    { key: 'add', label: '➕ 追加章节', needsNovel: true, desc: '手动追加一章正文', argsHint: { info: '{ name, content }' } },
    { key: 'modify', label: '✏️ 修改章节', needsNovel: true, desc: '按指令修改某章正文', argsHint: { chapter: '章号', modifyInstructions: '修改要求' } },
    { key: 'delete', label: '🗑️ 删除章节', needsNovel: true, desc: '删除指定章节', argsHint: { chapter: '章号' } },
    { key: 'reNumberChapters', label: '🔢 重编号', needsNovel: true, desc: '删除后重排章节序号' },
  ]},
  { group: '设定/分部', items: [
    { key: 'generatePreface', label: '📄 生成本书设定', needsNovel: true, desc: 'AI 生成读者向设定说明页' },
    { key: 'savePreface', label: '✍️ 手写本书设定', needsNovel: true, desc: '人工写入设定说明', argsHint: { preface: 'Markdown 正文' } },
    { key: 'setParts', label: '📚 划分部', needsNovel: true, desc: '手动把章节划分为部', argsHint: { parts: '[{ name, from, to }]' } },
    { key: 'generatePartIntros', label: '🧭 生成部导言', needsNovel: true, desc: '为各部生成导言概要', argsHint: { partNo: '部序号(省略=全部)' } },
    { key: 'listParts', label: '👀 查看部结构', needsNovel: true },
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
  { name: 'generateChapter', description: '按大纲生成指定章正文；chapter=0 生成全部缺失章节。', parameters: { dbPath: 'string', chapter: 'integer 章号(0=全部)', force: 'boolean 是否覆盖已有' } },
  { name: 'modifyChapter', description: '按自然语言指令修改某章正文。', parameters: { dbPath: 'string', chapter: 'integer', modifyInstructions: 'string 修改要求' } },
  { name: 'generateOutlines', description: '为小说生成章节大纲。', parameters: { dbPath: 'string', totalChapters: 'integer 章节总数' } },
  { name: 'publishNovel', description: '把小说发布为本地可阅读页面。', parameters: { dbPath: 'string' } },
  { name: 'checkConsistency', description: '对小说做一致性检查（章节连续性/角色/时间线）。', parameters: { dbPath: 'string' } },
];
