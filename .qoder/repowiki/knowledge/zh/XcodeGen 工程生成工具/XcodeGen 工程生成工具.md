---
kind: external_dependency
name: XcodeGen 工程生成工具
slug: xcodegen
category: external_dependency
category_hints:
    - framework_behavior
scope:
    - '**'
source_files:
    - ios/project.yml
---

### iOS 工程构建
- `ios/project.yml` 是 Xcode 工程的唯一真源，`.xcodeproj` 通过 `cd ios && xcodegen generate` 生成，且被 `.gitignore` 排除（非提交产物）。
- 生成的 scheme 为 `AINovel`（Debug / Release），Swift 5.9、iOS 17.0 部署目标。
- 开发签名 Team 固定为 `K82UDVDKF7`（个人免费 Personal Team），换付费账号需改 `project.yml` 的 `DEVELOPMENT_TEAM`。
- 注意：`Info.plist` 与 `project.yml` 的 `info.properties` 存在双重管理风险，修改 bundle/版本信息时需同步两处。