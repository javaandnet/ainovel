---
kind: build_system
name: 构建系统：Node.js 脚本 + XcodeGen iOS 工程描述
category: build_system
scope:
    - '**'
source_files:
    - package.json
    - server.js
    - ios/project.yml
    - kill-port.sh
    - scripts/fix-published-reader-ref.mjs
    - scripts/trim-backfill.mjs
---

## 1. 使用的系统与工具

- **后端（Express）**：纯 Node.js 项目，依赖管理通过 `package.json` + `package-lock.json`；无 Makefile、Dockerfile、CI 流水线或发布脚本。
- **iOS 客户端**：SwiftUI 应用，工程由 [XcodeGen](https://github.com/yonasabiy/XcodeGen) 的 `project.yml` 声明式生成 `.xcodeproj`，而非直接编辑 `project.pbxproj`。
- **辅助脚本**：根目录提供少量 shell / Node 脚本用于开发期辅助（端口清理、发布后资源引用修复、数据回填裁剪）。

## 2. 关键文件

- `package.json` — 后端入口与脚本定义。
- `server.js` — Express 服务启动入口（`main` 字段指向）。 
- `ios/project.yml` — XcodeGen 工程描述，集中声明 bundleId、部署目标、签名团队、Info.plist 属性等。
- `kill-port.sh` — 释放指定端口的本地开发辅助脚本。
- `scripts/fix-published-reader-ref.mjs`、`scripts/trim-backfill.mjs` — 发布与数据处理辅助脚本。

## 3. 架构与约定

### 后端构建
- 包名 `ainovel`，版本 `1.0.0`，`type: module`（ESM），`main: server.js`。
- 仅两个 npm scripts：
  - `npm start` → `node server.js`
  - `npm dev` → `node --watch server.js`（基于 Node 原生 watch 的文件热重载）
- 运行时依赖：`express`、`better-sqlite3`、`cors`、`fs-extra`、`marked`、`msedge-tts`、`pinyin-pro`。无构建阶段（无 TypeScript、无打包器）。

### iOS 构建
- 通过 `brew install xcodegen && cd ios && xcodegen generate` 从 `project.yml` 生成 `AINovel.xcodeproj`，再用 Xcode 编译。
- `MARKETING_VERSION: "0.1.0"`、`CURRENT_PROJECT_VERSION: "1"`，`PRODUCT_BUNDLE_IDENTIFIER: jp.co.fsr.ainovel`，`DEVELOPMENT_TEAM: K82UDVDKF7`（注释说明为开发者个人免费 Personal Team，付费账号需修改）。
- `deploymentTarget.iOS: "17.0"`，`SWIFT_VERSION: "5.9"`，支持 iPhone + iPad（`TARGETED_DEVICE_FAMILY: "1,2"`）。
- Info.plist 中 `AINovelBaseURL` 默认指向本机局域网地址 `http://192.168.1.55:3400/novel`，并开启 `NSAllowsArbitraryLoads: true` 以允许 HTTP（注释明确标注“上架/生产构建前必须移除”）。

### 辅助脚本
- `kill-port.sh <端口号> [...]`：用 `lsof -ti:"$PORT"` 查找占用进程并以 `kill -9` 终止，未传参时打印用法并退出码 1。
- `scripts/fix-published-reader-ref.mjs`：用于修复已发布资源的 reader 引用路径。
- `scripts/trim-backfill.mjs`：用于裁剪回补数据。

## 4. 约定与约束

- **无容器化与 CI**：仓库中不存在 `Dockerfile`、`docker-compose.*`、`.github/workflows/` 或其他 CI 配置文件。
- **无预构建步骤**：后端不经过任何编译器或打包器，`npm start` 直接运行源码；`npm dev` 使用 Node 内置 `--watch`。
- **iOS 工程不可手工编辑**：`project.yml` 顶部注释写明“XcodeGen 工程描述（纯文本，可审阅）”，并通过 `xcodegen generate` 生成 `.xcodeproj`，表明工程应通过该流程重建而非直接修改 pbxproj。
- **开发环境约束**：`kill-port.sh` 依赖 macOS/BSD 的 `lsof`，非跨平台脚本。
- **安全约束（文档化）**：`project.yml` 中关于 `NSAllowsArbitraryLoads` 和 `AINovelBaseURL` 的注释明确要求“上架/生产构建前必须移除任意加载配置并改为 HTTPS 域名”。
- **版本策略**：后端版本号位于 `package.json` 的 `version` 字段；iOS 应用版本位于 `project.yml` 的 `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`，两者独立维护。