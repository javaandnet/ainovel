/**
 * ainovel - AI 小说平台服务入口（多用户版）
 *
 * 静态：public/（登录页 / 管理页 / 阅读器资源 / 发布产物）
 * API ：/api/*（见 src/routes.js：登录鉴权 + 租户隔离，复用移植的 WriterTool）
 * 启动：初始化 global.db（建表 + users.json 播种超管 + 存量小说登记）
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerRoutes } from './src/routes.js';
import { bootstrap } from './src/auth/userStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3400;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

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
  console.log(`   登录入口: http://localhost:${PORT}/login/`);
  console.log(`   管理页面: http://localhost:${PORT}/admin/`);
  console.log(`   阅读入口: http://localhost:${PORT}/novel/`);
  console.log(`   账号: 播种 ${boot.seeded} 个 / 存量小说登记 ${boot.migrated} 本`);
  console.log(`   LLM: aibridge (默认 Local/Qwen3.8，可用 AIBRIDGE_API_KEY / NOVEL_LLM_MODEL 覆盖)`);
});
