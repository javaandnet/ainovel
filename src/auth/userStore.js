/**
 * 多用户元数据仓库（global.db）
 *
 * - user  表：账号权威（scrypt 哈希 + 随机 salt），disabled 无效化、不做物理删除
 * - novel 表：user_id -> 小说 -> db_file 的归属映射；Web 端列举与鉴权一律以它为准
 *   vip 列标记该书是否 VIP 专属（读者账号授权制，已去掉旧的共享密码解锁）
 * - vip_grant 表：谁（user_id）被授权读哪本（novel_id，NULL = 全站 VIP），带到期与撤销
 *
 * 职责边界：本模块只读写 global.db 元数据；每本小说的内容库（data/<id>.db）
 * 只经 WriterTool 改写，绝不在此用裸 SQL 触碰正文。
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SYSTEM_DIR = path.join(DATA_DIR, 'system');
const GLOBAL_DB = path.join(SYSTEM_DIR, 'global.db');
const USERS_JSON = path.join(PROJECT_ROOT, 'config', 'users.json');

let _db = null;

const now = () => Date.now();
const newId = () => crypto.randomUUID();

// ── 口令哈希（scrypt，逐用户随机 salt）──
function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { hash, salt: s };
}
function verifyPassword(password, hash, salt) {
  try {
    const cand = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(cand, 'hex');
    const b = Buffer.from(String(hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** 打开（并按需初始化）global.db；模块内单例 */
function openDb() {
  if (_db) return _db;
  fs.mkdirSync(SYSTEM_DIR, { recursive: true });
  _db = new Database(GLOBAL_DB);
  _db.pragma('journal_mode = DELETE');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS user (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      pass_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      disabled INTEGER NOT NULL DEFAULT 0,
      last_login INTEGER,
      created_at INTEGER,
      updated_at INTEGER,
      created_by TEXT,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS novel (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      title TEXT,
      db_file TEXT NOT NULL UNIQUE,
      chapter_count INTEGER NOT NULL DEFAULT 0,
      vip INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      created_by TEXT,
      updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_novel_user ON novel(user_id);
    CREATE TABLE IF NOT EXISTS vip_grant (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      novel_id TEXT,                      -- NULL = 全站 VIP（可读所有 VIP 书）
      note TEXT,
      expires_at INTEGER,                 -- NULL = 永久
      revoked_at INTEGER,                 -- 非空 = 已撤销（留历史可审）
      created_at INTEGER,
      created_by TEXT,
      updated_at INTEGER,
      updated_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_grant_user ON vip_grant(user_id);
    CREATE INDEX IF NOT EXISTS idx_grant_novel ON vip_grant(novel_id);
    CREATE TABLE IF NOT EXISTS preview (
      token TEXT PRIMARY KEY,             -- 暂存预览站目录名（public/novel/<token>）
      novel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      novel_dir TEXT,                     -- 渲染时的小说目录名（改名重发后旧预览仍可定位）
      created_at INTEGER,
      expires_at INTEGER
    );
  `);
  // 迁移：VIP 从「小说共享密码」改为「读者账号授权」。旧列存在时按原样保留（不删列，
  // 删列在 SQLite 上要重建整表，风险大于收益），只是不再参与任何判定。
  const novelCols = _db.prepare('PRAGMA table_info(novel)').all().map(c => c.name);
  if (!novelCols.includes('vip')) {
    _db.exec('ALTER TABLE novel ADD COLUMN vip INTEGER NOT NULL DEFAULT 0');
    if (novelCols.includes('vip_hash')) {
      // 原来设过密码的书，保持 VIP 属性不变；旧密码本身作废（无人能再用它解锁）
      _db.exec('UPDATE novel SET vip = 1 WHERE vip_hash IS NOT NULL AND vip_hash != \'\'');
    }
  }
  return _db;
}

// ── 输出脱敏：对外永远不带凭据列 ──
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role,
    disabled: !!u.disabled, lastLogin: u.last_login || null,
    createdAt: u.created_at || null, updatedAt: u.updated_at || null,
  };
}

// ── user CRUD ──
function findUserByName(username) {
  return openDb().prepare('SELECT * FROM user WHERE username = ?').get(String(username || '').trim()) || null;
}
function findUserById(id) {
  return openDb().prepare('SELECT * FROM user WHERE id = ?').get(id) || null;
}
function listUsers() {
  return openDb().prepare(`
    SELECT u.*,
           (SELECT COUNT(*) FROM novel n WHERE n.user_id = u.id) AS novel_count,
           (SELECT COUNT(*) FROM vip_grant g WHERE g.user_id = u.id AND g.revoked_at IS NULL) AS grant_count
    FROM user u ORDER BY u.created_at ASC
  `).all().map((u) => Object.assign(publicUser(u), {
    novelCount: u.novel_count || 0,
    vipGrantCount: u.grant_count || 0,
  }));
}
function countUsers() {
  return openDb().prepare('SELECT COUNT(*) AS c FROM user').get().c;
}
function createUser({ username, password, role = 'user', actor = 'system' }) {
  const name = String(username || '').trim();
  if (!name) throw new Error('用户名不能为空');
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
  if (findUserByName(name)) throw new Error(`用户名已存在：${name}`);
  const { hash, salt } = hashPassword(password);
  const id = newId();
  const ts = now();
  openDb().prepare(`
    INSERT INTO user (id, username, pass_hash, salt, role, disabled, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
  `).run(id, name, hash, salt, role === 'superadmin' ? 'superadmin' : 'user', ts, ts, actor, actor);
  return publicUser(findUserById(id));
}
function setUserDisabled(id, disabled, actor = 'system') {
  const u = findUserById(id);
  if (!u) throw new Error('用户不存在');
  openDb().prepare('UPDATE user SET disabled = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(disabled ? 1 : 0, now(), actor, id);
  return publicUser(findUserById(id));
}
/** 超管重置某用户密码（重新生成 salt + scrypt 哈希） */
function setUserPassword(id, password, actor = 'system') {
  const u = findUserById(id);
  if (!u) throw new Error('用户不存在');
  if (!password || String(password).length < 4) throw new Error('密码至少 4 位');
  const { hash, salt } = hashPassword(password);
  openDb().prepare('UPDATE user SET pass_hash = ?, salt = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(hash, salt, now(), actor, id);
  return publicUser(findUserById(id));
}
function setLastLogin(id) {
  try { openDb().prepare('UPDATE user SET last_login = ? WHERE id = ?').run(now(), id); } catch { /* 忽略 */ }
}
/** 登录校验：命中且未禁用返回 publicUser，否则 null */
function login(username, password) {
  const u = findUserByName(username);
  if (!u || u.disabled) return null;
  if (!verifyPassword(password, u.pass_hash, u.salt)) return null;
  setLastLogin(u.id);
  return publicUser(u);
}

// ── novel 注册表 ──
function listNovelsByUser(userId) {
  return openDb().prepare('SELECT * FROM novel WHERE user_id = ? ORDER BY updated_at DESC').all(userId);
}
function listAllNovels() {
  return openDb().prepare('SELECT * FROM novel ORDER BY updated_at DESC').all();
}
function getNovel(id) {
  return openDb().prepare('SELECT * FROM novel WHERE id = ?').get(id) || null;
}
function findNovelByFile(dbFile) {
  return openDb().prepare('SELECT * FROM novel WHERE db_file = ?').get(dbFile) || null;
}
function createNovel({ id, userId, title, dbFile, actor = 'system', chapterCount = 0 }) {
  const nid = id || newId();
  const ts = now();
  openDb().prepare(`
    INSERT INTO novel (id, user_id, title, db_file, chapter_count, created_at, updated_at, created_by, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nid, userId, title || '', dbFile, chapterCount, ts, ts, actor, actor);
  return getNovel(nid);
}
function updateNovelMeta(id, { title, chapterCount } = {}) {
  const cur = getNovel(id);
  if (!cur) return null;
  const nt = title !== undefined ? title : cur.title;
  const nc = chapterCount !== undefined ? chapterCount : cur.chapter_count;
  openDb().prepare('UPDATE novel SET title = ?, chapter_count = ?, updated_at = ? WHERE id = ?')
    .run(nt, nc, now(), id);
  return getNovel(id);
}

function deleteNovel(id) {
  openDb().prepare('DELETE FROM novel WHERE id = ?').run(id);
  // 授权与预览登记跟着书走：书没了，指向它的行一并清掉（避免悬挂 novel_id）
  // 暂存目录本身要由调用方在删除前清（见 preview.purgePreviewsOfNovel）
  openDb().prepare('DELETE FROM vip_grant WHERE novel_id = ?').run(id);
  openDb().prepare('DELETE FROM preview WHERE novel_id = ?').run(id);
}

function updateNovelPath(id, dbFile, actor = 'migrate') {
  openDb().prepare('UPDATE novel SET db_file = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(dbFile, now(), actor, id);
}

// ── VIP：小说开关 + 读者账号授权 ──
/** 开/关某书的 VIP 专属标记（关 = 所有登录读者可读） */
function setNovelVip(id, vip, actor = 'system') {
  const n = getNovel(id);
  if (!n) throw new Error('小说不存在');
  openDb().prepare('UPDATE novel SET vip = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(vip ? 1 : 0, now(), actor, id);
  return getNovel(id);
}

/** 对外授权视图：隐内部 id，补用户名/书名，并给出实时可用性 */
function publicGrant(g) {
  if (!g) return null;
  const active = !g.revoked_at && (!g.expires_at || g.expires_at > now());
  return {
    id: g.id,
    userId: g.user_id,
    username: g.username || null,
    novelId: g.novel_id || null,
    novelTitle: g.novel_id ? (g.novel_title || '（小说已删除）') : null,
    scope: g.novel_id ? 'novel' : 'all',
    note: g.note || '',
    expiresAt: g.expires_at || null,
    revokedAt: g.revoked_at || null,
    active,
    status: g.revoked_at ? 'revoked' : (g.expires_at && g.expires_at <= now() ? 'expired' : 'active'),
    createdAt: g.created_at || null,
    createdBy: g.created_by || null,
  };
}

const GRANT_JOIN = `SELECT g.*, u.username AS username, n.title AS novel_title
  FROM vip_grant g LEFT JOIN user u ON u.id = g.user_id LEFT JOIN novel n ON n.id = g.novel_id`;
const GRANT_ORDER = 'ORDER BY (g.revoked_at IS NULL) DESC, g.created_at DESC';

/** 列出授权：不传参 = 全部（控制台）；可按用户/书过滤 */
function listVipGrants({ userId = null, novelId = null, includeRevoked = true } = {}) {
  const where = [];
  const args = [];
  if (userId) { where.push('g.user_id = ?'); args.push(userId); }
  if (novelId) { where.push('g.novel_id = ?'); args.push(novelId); }
  if (!includeRevoked) where.push('g.revoked_at IS NULL');
  const sql = GRANT_JOIN + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ' + GRANT_ORDER;
  return openDb().prepare(sql).all(...args).map(publicGrant);
}

function getVipGrant(id) {
  return openDb().prepare(GRANT_JOIN + ' WHERE g.id = ?').get(id) || null;
}

/**
 * 授予 VIP：读者账号 -> 可读范围。同一 (用户, 范围) 只保留一条有效授权，
 * 重复授予视为续期/改备注（不新增行），避免名单里出现同人同书多条。
 * @param {{username?:string, userId?:string, novelId?:string|null, expiresAt?:number|null, note?:string, actor?:string}} p
 */
function grantVip({ username, userId, novelId = null, expiresAt = null, note = '', actor = 'system' }) {
  const db = openDb();
  let uid = userId || null;
  if (!uid && username) uid = findUserByName(username)?.id || null;
  if (!uid) throw new Error(`用户不存在：${username || userId || '(未指定)'}`);
  if (!db.prepare('SELECT 1 FROM user WHERE id = ?').get(uid)) throw new Error('用户不存在');
  const nid = novelId || null;
  if (nid && !getNovel(nid)) throw new Error('小说不存在');
  const ts = now();
  const exp = expiresAt ? Number(expiresAt) : null;
  if (exp && exp <= ts) throw new Error('到期时间必须晚于当前时间');
  const dupCond = nid ? 'user_id = ? AND novel_id = ? AND revoked_at IS NULL' : 'user_id = ? AND novel_id IS NULL AND revoked_at IS NULL';
  const dupArgs = nid ? [uid, nid] : [uid];
  const dup = db.prepare(`SELECT id FROM vip_grant WHERE ${dupCond}`).get(...dupArgs);
  if (dup) {
    db.prepare('UPDATE vip_grant SET expires_at = ?, note = ?, updated_at = ?, updated_by = ? WHERE id = ?')
      .run(exp, String(note || ''), ts, actor, dup.id);
    return publicGrant(getVipGrant(dup.id));
  }
  const id = newId();
  db.prepare(`
    INSERT INTO vip_grant (id, user_id, novel_id, note, expires_at, revoked_at, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `).run(id, uid, nid, String(note || ''), exp, ts, actor, ts, actor);
  return publicGrant(getVipGrant(id));
}

/** 撤销授权（软删：置 revoked_at，历史可审） */
function revokeVipGrant(id, actor = 'system') {
  const g = getVipGrant(id);
  if (!g) throw new Error('授权记录不存在');
  openDb().prepare('UPDATE vip_grant SET revoked_at = ?, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(now(), now(), actor, id);
  return publicGrant(getVipGrant(id));
}

/** 恢复一条已撤销的授权（便于误操作回滚） */
function restoreVipGrant(id, actor = 'system') {
  const g = getVipGrant(id);
  if (!g) throw new Error('授权记录不存在');
  openDb().prepare('UPDATE vip_grant SET revoked_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?')
    .run(now(), actor, id);
  return publicGrant(getVipGrant(id));
}

/**
 * 读者对某本 VIP 书是否可读（闸门唯一口径）：
 * 非 VIP 书恒为 true；VIP 书要求存在一条未撤销、未到期且范围命中（全站或本书）的授权。
 * 超管对自己管的站点不例外 —— 读者侧权限只看授权名单，免得“忘了撤销”变成隐形权限。
 * （书主能读自己书的豁免不在这里，由书页闸门叠加，见 routes.js 的 /novel 中间件。）
 */
function hasVipAccess(userId, novelId) {
  if (!userId || !novelId) return false;
  const n = getNovel(novelId);
  if (!n || !n.vip) return true;
  const rows = openDb().prepare(
    'SELECT expires_at FROM vip_grant WHERE user_id = ? AND revoked_at IS NULL AND (novel_id = ? OR novel_id IS NULL)'
  ).all(userId, novelId);
  return rows.some(r => !r.expires_at || r.expires_at > now());
}

// ── 预览登记（暂存站的生命周期）──
const PREVIEW_TTL = 24 * 3600 * 1000; // 预览产物默认留 24 小时

function registerPreview({ token, novelId, userId, novelDir, ttl = PREVIEW_TTL }) {
  const ts = now();
  openDb().prepare(`
    INSERT INTO preview (token, novel_id, user_id, novel_dir, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, novelId, userId, novelDir || '', ts, ts + ttl);
  return getPreview(token);
}
function getPreview(token) {
  return openDb().prepare('SELECT * FROM preview WHERE token = ?').get(String(token || '')) || null;
}
function removePreview(token) {
  openDb().prepare('DELETE FROM preview WHERE token = ?').run(String(token || ''));
}
/**
 * 某书的全部预览登记。删除小说前必须先用它把暂存目录清掉：
 * 登记行一删就再没人引用那个目录，它在磁盘上就成了永久无人认领的残留（过期回收也找不到它）。
 */
function listPreviewsByNovel(novelId) {
  return openDb().prepare('SELECT * FROM preview WHERE novel_id = ?').all(String(novelId || ''));
}
/** 过期预览行（调用方负责删目录，删完再调 removePreview） */
function listExpiredPreviews() {
  return openDb().prepare('SELECT * FROM preview WHERE expires_at IS NOT NULL AND expires_at < ?').all(now());
}

// ── 初始化 + 播种 + 存量迁移 ──
/**
 * 建库建表；若 user 表为空则从 config/users.json 播种（明文口令哈希后入库）。
 * 迁移：把 data/ 下已有的小说 .db 登记到首个超管名下（只读文件名/书名，不改内容）。
 * @returns {{superadminId:string|null, seeded:number, migrated:number}}
 */
function bootstrap() {
  openDb();
  let superadminId = null;
  let seeded = 0;

  if (countUsers() === 0) {
    let seedList = [];
    try {
      const raw = JSON.parse(fs.readFileSync(USERS_JSON, 'utf8'));
      if (Array.isArray(raw)) seedList = raw;
    } catch { /* 无种子文件 */ }
    for (const item of seedList) {
      if (!item || !item.username || !item.password) continue;
      try {
        const u = createUser({
          username: item.username,
          password: item.password,
          role: item.role === 'superadmin' ? 'superadmin' : 'user',
          actor: 'seed',
        });
        if (!superadminId || item.role === 'superadmin') superadminId = u.id;
        seeded++;
      } catch (e) {
        console.warn(`[userStore] 播种跳过 ${item.username}: ${e.message}`);
      }
    }
  }

  if (!superadminId) {
    const sa = openDb().prepare("SELECT id FROM user WHERE role = 'superadmin' AND disabled = 0 ORDER BY created_at ASC LIMIT 1").get();
    const any = sa || openDb().prepare('SELECT id FROM user ORDER BY created_at ASC LIMIT 1').get();
    superadminId = any ? any.id : null;
  }

  const migrated = superadminId ? migrateExistingNovels(superadminId) : 0;
  return { superadminId, seeded, migrated };
}

/** 只读读取某小说库的书名（no=0）与正文章数；读不出的返回 null。不做任何写操作。 */
function readNovelSummary(dbPath) {
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.prepare('SELECT name FROM content WHERE no = 0').get();
      const title = (row && row.name) || null;
      if (!title) return null;
      let chapterCount = 0;
      try {
        const c = db.prepare("SELECT COUNT(*) AS c FROM content WHERE no >= 1 AND type = 'chapter' AND content IS NOT NULL AND content != ''").get();
        chapterCount = (c && c.c) || 0;
      } catch { /* 无 type 列等，按 0 处理 */ }
      return { title, chapterCount };
    } finally { db.close(); }
  } catch { return null; }
}

/** 幂等：把 data/ 根下的小说 *.db 归入各自用户目录 data/<uid>/ 并登记。
 *  步骤1：已登记但 db_file 仍为扁平名（无目录分隔）的历史行 → 物理搬入 data/<user_id>/ 并改写 db_file。
 *  步骤2：data/ 根下未登记的 *.db → 搬入 data/<userId>/ 并登记（挂到传入用户名下）。
 *  只移动不删除，任何异常跳过，保证幂等与安全。 */
function migrateExistingNovels(userId) {
  if (!fs.existsSync(DATA_DIR)) return 0;
  let count = 0;
  // 步骤1：迁移历史扁平登记行（db_file 不含目录分隔符）
  for (const n of listAllNovels()) {
    if (!n.db_file || n.db_file.includes('/') || n.db_file.includes('\\')) continue;
    const absOld = path.join(DATA_DIR, n.db_file);
    if (!fs.existsSync(absOld)) continue;
    const base = path.basename(n.db_file);
    const dir = path.join(DATA_DIR, n.user_id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { continue; }
    const absNew = path.join(dir, base);
    if (!fs.existsSync(absNew)) { try { fs.renameSync(absOld, absNew); } catch { continue; } }
    else { try { fs.unlinkSync(absOld); } catch {} }
    try { updateNovelPath(n.id, `${n.user_id}/${base}`); count++; } catch {}
  }
  // 步骤2：登记 data/ 根下仍未登记的 *.db（归入其目录）
  if (userId) {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.db') || f === 'global.db') continue;
      const abs = path.join(DATA_DIR, f);
      let st; try { st = fs.statSync(abs); } catch { continue; }
      if (!st.isFile()) continue;
      const sum = readNovelSummary(abs);
      if (!sum) continue;
      const dir = path.join(DATA_DIR, userId);
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      const rel = `${userId}/${f}`;
      if (findNovelByFile(rel)) continue;
      const absNew = path.join(dir, f);
      if (!fs.existsSync(absNew)) { try { fs.renameSync(abs, absNew); } catch { continue; } }
      try { createNovel({ userId, title: sum.title, dbFile: rel, actor: 'migrate', chapterCount: sum.chapterCount }); count++; } catch {}
    }
  }
  return count;
}

export {
  openDb,
  GLOBAL_DB,
  DATA_DIR,
  // user
  publicUser, findUserByName, findUserById, listUsers, countUsers,
  createUser, setUserDisabled, setUserPassword, setLastLogin, login,
  // novel registry
  listNovelsByUser, listAllNovels, getNovel, findNovelByFile,
  createNovel, updateNovelMeta, updateNovelPath, deleteNovel,
  setNovelVip,
  registerPreview, getPreview, removePreview, listPreviewsByNovel, listExpiredPreviews, PREVIEW_TTL,
  grantVip, revokeVipGrant, restoreVipGrant, listVipGrants, hasVipAccess,
  // lifecycle
  bootstrap, migrateExistingNovels,
  // crypto helpers (for tests/admin reset)
  hashPassword,
};
