---
kind: external_dependency
name: aibridge 推理服务桥接
slug: aibridge
category: external_dependency
category_hints:
    - vendor_identity
    - auth_protocol
scope:
    - '**'
source_files:
    - src/services/bridgeStore.js
    - README.md
---

### 上游模型接入层
- 本项目不直接调 OpenAI 等上游模型，而是通过 aibridge（OpenAI Compatible 协议）中转；控制台可登记多条 API Key 并运行时切换生效，无需重启。
- 鉴权方式：每条 Key 保存时调用 `/api/bridge/whoami` 用 Key 自身鉴权探测身份，返回 `providerType`（如 `Local`、`Ollama (远程)`、`ollama_remote` 等）用于区分自建与公网服务。
- 密钥存储于 `data/system/bridge.json`（写入即 `0600`），接口仅回前缀不回明文；生效优先级：控制台启用项 > `process.env` > `.env`。
- 验证 exact API/params 以 aibridge 官方文档为准。