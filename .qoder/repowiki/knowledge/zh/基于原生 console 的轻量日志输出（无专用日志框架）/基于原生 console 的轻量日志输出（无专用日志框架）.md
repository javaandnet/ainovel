---
kind: logging_system
name: 基于原生 console 的轻量日志输出（无专用日志框架）
category: logging_system
scope:
    - '**'
source_files:
    - package.json
    - server.js
    - src/agent/llm.js
    - src/auth/session.js
    - src/auth/userStore.js
    - src/reader/explainStore.js
    - src/reader/vocabStore.js
    - src/reader/silenceProbe.js
    - src/services/bridgeStore.js
    - src/services/progressHub.js
    - src/tools/base.js
---

## 1. 使用的系统/方案

仓库**没有引入任何第三方日志框架**。`package.json` 的 dependencies 中不存在 pino、winston、bunyan、morgan、debug 等日志库；Express 也未挂载 `morgan`。所有后端日志均通过 Node.js 原生的 `console.log` / `console.warn` / `console.error` 直接输出到标准输出。

## 2. 关键文件与位置

日志调用散落在各业务模块，没有统一的 logger 初始化文件或中间件：

- `server.js`：启动阶段用 `console.log` 打印服务地址、BASE_PATH、登录入口、管理页面、阅读入口、已播种账号数、迁移小说数、LLM bridge 来源与模型。
- `src/agent/llm.js`：当没有可用 API Key 时 `console.warn('[llm] ...')`。
- `src/auth/session.js`：未设置 `SESSION_SECRET` 时 `console.warn('[session] ...')`。
- `src/auth/userStore.js`：播种跳过用户时 `console.warn('[userStore] ...')`。
- `src/reader/explainStore.js`、`src/reader/vocabStore.js`：缓存读写失败时 `console.warn('[explainStore|vocabStore] ...')`。
- `src/reader/silenceProbe.js`：ffmpeg 不可用或探测失败时 `console.warn('[silenceProbe] ...')`。
- `src/services/bridgeStore.js`：配置文件解析失败、生效项失效、当前 bridge 链路信息时 `console.log/warn`。
- `src/services/progressHub.js`：订阅方异常隔离时用 `console.error('[ProgressHub] ...')`。
- `src/tools/base.js`：注释说明原 galaclaw 版 BaseTool 深耦合 loader/logger，移植后不再依赖。

## 3. 架构与约定

- **无集中式 logger**：每个模块自行决定何时 `console.*`，没有共享的 logger 实例、log level 枚举、格式化器或 sink 配置。
- **结构化字段缺失**：日志消息是拼接后的字符串，没有统一的结构化字段（如 timestamp、level、module、requestId）。唯一可识别的“模块标签”是通过方括号前缀约定实现的，例如 `[llm]`、`[session]`、`[userStore]`、`[explainStore]`、`[vocabStore]`、`[silenceProbe]`、`[bridge]`、`[ProgressHub]`。
- **日志级别使用方式**：`console.log` 用于正常运行信息（启动提示、bridge 链路），`console.warn` 用于降级/回退场景（缺少依赖、缓存不可用、Key 缺失），`console.error` 仅用于订阅方异常隔离。没有程序化的 level 判断逻辑。
- **错误处理不经过日志层**：捕获到的异常通常直接拼入 warn/error 消息文本，而不是先记录再抛出。

## 4. 约定与约束

- **约定（描述性）**：模块级日志以 `[ModuleName]` 方括号前缀开头，便于在 stdout 中按模块过滤。
- **约定（描述性）**：非致命问题（可选依赖缺失、缓存回退、Key 不可用）一律走 `console.warn`；进程内事件总线订阅者抛错走 `console.error`；启动/状态展示走 `console.log`。
- **约束（由代码体现）**：`src/tools/base.js` 的注释明确说明原 galaclaw 版 BaseTool 对 loader/logger 存在深度耦合，本次移植刻意解耦——即工具层不再持有 logger 引用，而是通过 `this.parameters`、`this.context` 注入上下文。
- **约束（由依赖体现）**：`package.json` 未声明任何日志相关依赖，因此新增日志能力不会自动获得第三方框架支持；若未来引入日志框架，需要显式添加依赖并替换所有 `console.*` 调用点。

总结：这是一个极简的“原生 console + 方括号模块标签”日志实践，适合当前体量的小规模 Express 服务，但缺乏结构化字段、分级开关、统一输出目标等生产级日志能力。