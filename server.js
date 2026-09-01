/**
 * ainovel - AI 小说平台服务入口
 *
 * 静态：public/（首页 / 管理页 / 阅读器资源 / 发布产物）
 * API ：/api/*（见 src/routes.js，复用移植的 WriterTool）
 */
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerRoutes } from './src/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3400;

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// API
registerRoutes(app);

// 静态资源
app.use('/tts', express.static(path.join(__dirname, 'public/tts')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use('/novel', express.static(path.join(__dirname, 'public/novel')));
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`📚 AI Novel Platform running at http://localhost:${PORT}`);
  console.log(`   管理页面: http://localhost:${PORT}/admin/`);
  console.log(`   阅读入口: http://localhost:${PORT}/novel/`);
  console.log(`   LLM: aibridge (默认 Local/Qwen3.8，可用 AIBRIDGE_API_KEY / NOVEL_LLM_MODEL 覆盖)`);
});
