/**
 * ainovel - AI 小说平台服务入口（多用户版）
 *
 * 静态：public/（登录页 / 管理页 / 阅读器资源 / 发布产物）
 * API ：<BASE>/api/*（见 src/routes.js：登录鉴权 + 租户隔离，复用移植的 WriterTool）
 * 前缀：站点挂在 BASE_PATH（默认 /novel）之下，口径与来源见 src/base.js
 * 启动：初始化 global.db（建表 + users.json 播种超管 + 存量小说登记）
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerRoutes } from './src/routes.js';
import { bootstrap } from './src/auth/userStore.js';
import { BASE_PATH, APP_NAMESPACES } from './src/base.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3400;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ── 前缀平移：对外 <BASE>/(api|login|tts|admin)/* → 内部 /* ──
// nginx 按前缀原样转发（不剥前缀），而本进程内部路由历来写在根级；这里一次性把
// 应用命名空间剥回根级，路由与静态挂载的字面量就不必逐处加前缀。
// 书页（<BASE>/<uid>/<小说名>/...）不在此列 —— 它的内部挂载点就是 /novel，
// 与外部前缀重名，一起平移会得到 /novel/novel/... 双前缀，故原样放行。
app.use((req, _res, next) => {
  if (BASE_PATH && req.url.startsWith(BASE_PATH)) {
    const rest = req.url.slice(BASE_PATH.length);
    if (APP_NAMESPACES.test(rest)) req.url = rest;
  }
  next();
});

// 初始化多用户元数据库（幂等：建表 + 播种 + 存量迁移）
const boot = bootstrap();

// API
registerRoutes(app);

// 静态资源（登录页公开；管理页 HTML 壳公开，其数据接口受鉴权保护）
app.use('/login', express.static(path.join(__dirname, 'public/login')));
app.use('/tts', express.static(path.join(__dirname, 'public/tts')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/novel', express.static(path.join(__dirname, 'public/novel')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`📚 AI Novel Platform running at http://localhost:${PORT}`);
  console.log(`   挂载前缀: ${BASE_PATH || '(根路径)'}`);
  console.log(`   登录入口: http://localhost:${PORT}${BASE_PATH}/login/`);
  console.log(`   管理页面: http://localhost:${PORT}${BASE_PATH}/admin/`);
  console.log(`   阅读入口: http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`   账号: 播种 ${boot.seeded} 个 / 存量小说登记 ${boot.migrated} 本`);
  console.log(`   LLM: aibridge (默认 Local/Qwen3.8，可用 AIBRIDGE_API_KEY / NOVEL_LLM_MODEL 覆盖)`);
});
