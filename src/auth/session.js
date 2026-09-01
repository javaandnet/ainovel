/**
 * 登录会话（零依赖）：HMAC-SHA256 签名的 httpOnly cookie。
 * token = base64url(JSON{uid,exp}) + "." + hex(HMAC(payload, SECRET))
 * 不引入 cookie-parser / JWT 库；密钥从 .env SESSION_SECRET 读取。
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { findUserById } from './userStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** 零依赖读取工程根 .env（与 llm.js 同口径） */
function readEnvFile(key) {
  try {
    const txt = fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
    const m = txt.match(new RegExp('^' + key + '\\s*=\\s*(.*)$', 'm'));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* 无 .env */ }
  return '';
}

const COOKIE_NAME = 'ainovel_session';
const MAX_AGE = 7 * 24 * 3600; // 秒（7 天）

let SECRET = process.env.SESSION_SECRET || readEnvFile('SESSION_SECRET');
if (!SECRET) {
  SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('[session] SESSION_SECRET 未设置：已生成随机临时密钥（服务重启后既有登录态将失效，建议在 .env 配置固定值）');
}

const b64u = (s) => Buffer.from(s, 'utf8').toString('base64url');
const unb64u = (s) => Buffer.from(s, 'base64url').toString('utf8');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

function createToken(uid) {
  const payload = b64u(JSON.stringify({ uid, exp: Date.now() + MAX_AGE * 1000 }));
  return `${payload}.${sign(payload)}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const payload = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expect = sign(payload);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(unb64u(payload));
    if (!d || !d.uid || !d.exp || d.exp < Date.now()) return null;
    return d;
  } catch { return null; }
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

function setSessionCookie(res, uid) {
  const token = createToken(uid);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

/** 从请求 cookie 解析当前用户（含禁用二次校验）；未登录返回 null */
function currentUser(req) {
  const ck = parseCookies(req.headers && req.headers.cookie);
  const data = verifyToken(ck[COOKIE_NAME]);
  if (!data) return null;
  const u = findUserById(data.uid);
  if (!u || u.disabled) return null;
  return { id: u.id, username: u.username, role: u.role };
}

const SKIP_AUTH = new Set(['/login', '/logout', '/me']);

/** /api 守卫：除登录/登出/me 外都要有效会话（挂载时 req.path 已去掉 /api 前缀） */
function requireAuth(req, res, next) {
  if (SKIP_AUTH.has(req.path)) return next();
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = u;
  next();
}

/** 超管守卫（须先过 requireAuth，req.user 已就位） */
function requireSuperadmin(req, res, next) {
  if (!req.user || req.user.role !== 'superadmin') {
    return res.status(403).json({ error: '需要超级管理员权限' });
  }
  next();
}

export {
  COOKIE_NAME, MAX_AGE,
  createToken, verifyToken, parseCookies,
  setSessionCookie, clearSessionCookie, currentUser,
  requireAuth, requireSuperadmin,
};
