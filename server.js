import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3400;

app.use(cors());
app.use(express.json());

// 静态文件服务
app.use('/tts', express.static(path.join(__dirname, 'public/tts')));
app.use('/admin', express.static(path.join(__dirname, 'public/admin')));
app.use(express.static(path.join(__dirname, 'public')));

// API 路由（后续对接）
app.get('/api/novels', (req, res) => {
  res.json({ novels: [], message: 'TODO: 对接数据库' });
});

app.get('/api/novels/:id/chapters', (req, res) => {
  res.json({ chapters: [], message: 'TODO: 对接数据库' });
});

app.listen(PORT, () => {
  console.log(`📚 AI Novel Platform running at http://localhost:${PORT}`);
  console.log(`   管理页面: http://localhost:${PORT}/admin/`);
  console.log(`   阅读页面: http://localhost:${PORT}/`);
});
