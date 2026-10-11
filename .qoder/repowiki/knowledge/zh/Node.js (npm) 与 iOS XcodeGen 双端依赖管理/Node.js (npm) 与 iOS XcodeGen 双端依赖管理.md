---
kind: dependency_management
name: Node.js (npm) 与 iOS XcodeGen 双端依赖管理
category: dependency_management
scope:
    - '**'
source_files:
    - package.json
    - package-lock.json
    - ios/project.yml
---

## 1. 使用的系统/方法

本仓库采用两套独立的依赖管理体系：

- **后端（Express / Node.js）**：使用 npm，通过 `package.json` 声明运行时依赖，并通过 `package-lock.json` 锁定精确版本。
- **iOS 客户端（SwiftUI）**：不使用 Swift Package Manager 或 CocoaPods；所有代码均为单 Target 应用，无第三方库依赖。工程由 [XcodeGen](https://github.com/CocoaPods/XcodeGen) 通过 `ios/project.yml` 生成 `.xcodeproj`，依赖声明集中在该 YAML 中（如 `SWIFT_VERSION: "5.9"`、`deploymentTarget: iOS "17.0"`）。

## 2. 关键文件

- `package.json` — Node.js 项目元数据、脚本与依赖声明。
- `package-lock.json` — npm 锁文件，确保可重复安装。
- `ios/project.yml` — XcodeGen 工程描述，集中声明 Swift 语言版本、部署目标、Bundle ID、签名 Team 等构建期依赖配置。
- `ios/.gitignore` — 忽略 Xcode 用户态文件，仅保留工程描述。

## 3. 架构与约定

### Node.js 端

- 依赖以 caret (`^`) 语义范围声明在 `dependencies` 字段下，未使用 `devDependencies`，即开发时与运行时无区分。
- 当前依赖清单：
  - `express ^4.21.0`
  - `better-sqlite3 ^11.0.0`
  - `cors ^2.8.5`
  - `fs-extra ^11.2.0`
  - `marked ^12.0.0`
  - `msedge-tts ^2.0.7`
  - `pinyin-pro ^3.29.3`
- 项目类型为 ESM（`"type": "module"`），入口为 `server.js`。
- 提供两个脚本：`start`（`node server.js`）与 `dev`（`node --watch server.js`）。
- 不存在 vendoring、私有 registry 配置（`.npmrc`）、`pnpm-lock.yaml` 或 `yarn.lock`，完全依赖 npm 默认行为。

### iOS 端

- 应用 `AINovel` 是单一 Target，源码直接放在 `ios/AINovel/` 下，没有子模块、Framework 或 SPM package。
- 通过 `project.yml` 的 `targets.AINovel.sources` 指定源码目录，不引入任何外部 Swift Package。
- 构建期依赖通过 XcodeGen 参数声明：`SWIFT_VERSION: "5.9"`、`deploymentTarget: iOS "17.0"`、`MARKETING_VERSION: "0.1.0"`。
- Bundle ID 硬编码为 `jp.co.fsr.ainovel`，开发者 Team 固定为 `K82UDVDKF7`（注释说明为“HAI ZHAO / 免费 Personal Team”）。若切换付费账号需手动修改此处。
- App Transport Security 在 Info.plist 属性中开启 `NSAllowsArbitraryLoads: true`，注释明确标注“上架/生产构建前必须移除”。

## 4. 约定与约束

- **Node.js 依赖更新**：由于使用 `^` 语义范围且存在 `package-lock.json`，实际安装版本由 lockfile 决定；升级依赖应通过 `npm update` 或 `npm install <pkg>@latest` 后提交更新后的 `package-lock.json`。
- **iOS 构建环境**：README 与 `project.yml` 注释共同约定，生成工程需先执行 `brew install xcodegen && cd ios && xcodegen generate`。
- **Team 与证书**：`DEVELOPMENT_TEAM` 与 `CODE_SIGN_STYLE: Automatic` 绑定到个人免费团队；更换付费 Apple Developer 账号时必须同步修改 `project.yml` 中的 Team 值。
- **ATS 安全约束**：`NSAllowsArbitraryLoads: true` 被注释标记为“真机测试允许 HTTP”，并明确要求“上架/生产构建前必须移除”，这是唯一一处由文档强制约束的安全相关依赖配置。
- **无私有源/代理**：仓库内未发现 `.npmrc`、`.env` 中的 registry 配置或 GOPRIVATE 类变量，依赖全部来自公共 npm registry。
- **无 vendored 第三方库**：后端无 `vendor/`、`node_modules` 未纳入版本控制（由 lockfile 重建）；iOS 端无 Pods 或 SPM 包缓存，所有第三方能力均通过系统 API 实现。