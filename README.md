# AI Novel Platform

AI 小说平台 —— 阅读 + 管理 + 学习一体化。

## 功能

- **小说阅读**：TTS 朗读、章节导航、进度条、悬浮工具栏
- **AI 问答**：基于章节内容的智能问答，支持语音输入
- **学习模式**：词汇讲解（多语言）、章节测试（选择题）
- **小说管理**：命令式操作（列举/追加/删除章节），移动端优先 UI

## 快速开始

```bash
npm install
npm start
```

访问 http://localhost:3400

> 上服务器请看 `DEPLOY.md`（未入库）：首次部署脚本、重发必带 `--exclude .env` 的原因、验证清单与已知坑都在里面。

## 项目结构

```
ainovel/
├── server.js              # Express 服务入口
├── public/
│   ├── index.html         # 首页
│   ├── admin/
│   │   └── index.html     # 管理页面
│   └── tts/
│       ├── reader.js      # 阅读器加载器
│       ├── reader.core.js # 阅读器核心逻辑
│       └── reader.css     # 阅读器样式
├── data/                  # 数据库文件
└── package.json
```

## 技术栈

- Node.js + Express
- SQLite (better-sqlite3)
- Web Speech API (TTS + 语音识别)
- Screen Wake Lock API
- AI Bridge (OpenAI Compatible)
