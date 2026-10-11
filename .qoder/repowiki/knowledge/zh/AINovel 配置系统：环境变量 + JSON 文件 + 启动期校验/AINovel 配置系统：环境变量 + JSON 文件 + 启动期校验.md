---
kind: configuration_system
name: AINovel 配置系统：环境变量 + JSON 文件 + 启动期校验
category: configuration_system
scope:
    - '**'
source_files:
    - .env.example
    - src/base.js
    - server.js
    - config/writer.json
    - config/users.json.example
    - src/services/bridgeStore.js
---

## 1. 使用的系统与方式

本项目没有引入第三方配置库（如 dotenv、config、conf），而是采用 **原生 Node.js `process.env` + 静态 JSON 配置文件** 的组合，并在进程入口处做集中式加载与校验。iOS 客户端侧通过 Swift 源码中的 `AppConfig.swift` 管理自身配置（不在本仓库后端范围内）。

## 2. 关键文件

- `.env.example` — 环境变量模板，列出所有受支持的运行时变量。
- `src/base.js` — BASE_PATH 的权威来源与唯一校验逻辑。
- `server.js` — Express 应用入口，负责读取 PORT、BASE_PATH，并初始化 bridgeStore。
- `config/writer.json` — Writer 工具的可调业务开关（如 `publish.autoPublish`）。
- `config/users.json.example` — 用户种子数据模板（实际由 `src/auth/userStore.js` 在启动时播种到 SQLite）。
- `src/services/bridgeStore.js` — 桥接 API Key 的配置与切换持久化。

## 3. 架构与约定

### 3.1 环境变量（`.env` / `process.env`）

| 变量 | 默认值 | 说明 | 约束 |
|---|---:|---|---|
| `PORT` | `3400` | Express 监听端口（`server.js` L20） | 无显式校验 |
| `AIBRIDGE_URL` | 无 | AI Bridge 聊天接口地址 | 必填（缺失则无法使用） |
| `AIBRIDGE_API_KEY` | 无 | AI Bridge API Key | 必填 |
| `SESSION_SECRET` | 随机生成 | 登录会话签名密钥；缺失时每次启动随机生成，重启后登录态失效（见 `.env.example` 注释） | 可选，但生产应固定 |
| `BASE_PATH` | `/novel` | 站点挂载前缀（nginx 原样转发不剥前缀） | 仅允许空串或 `/novel`，否则启动抛错 |
| `NOVEL_LLM_MODEL` | 无 | 指定 LLM 模型名（见 `server.js` 启动日志） | 可选 |

加载位置：
- `PORT`、`BASE_PATH` 在 `server.js` / `src/base.js` 中直接读 `process.env`。
- `AIBRIDGE_*`、`SESSION_SECRET` 等由被导入模块（如 `src/auth/userStore.js`、`src/services/bridgeStore.js`）自行从 `process.env` 读取。

### 3.2 JSON 配置文件

- `config/writer.json`：Writer 工具的业务配置，当前仅含 `config.publish.autoPublish` 布尔开关，供 writer tool 层读取。
- `config/users.json.example`：用户种子模板，非运行时配置，用于 `bootstrap()` 时向 SQLite 播种初始管理员账号。

JSON 文件本身不被统一的 config loader 解析——各模块按需 `fs.readFileSync` 或依赖上层 bootstrap 流程注入。

### 3.3 启动期校验

`src/base.js` 对 `BASE_PATH` 做了强校验：
```js
if (BASE_PATH !== '' && BASE_PATH !== '/novel') {
  throw new Error(`BASE_PATH 只能取 '' 或 '/novel' …`);
}
```
这是整个配置系统中唯一的 `throw` 型强制约束，确保 nginx 原样透传前缀与内部 `/novel` 静态挂载点一致，避免上线后出现「接口正常、书页 404」的半残状态。

### 3.4 运行时可切换配置（Bridge Key）

`src/services/bridgeStore.js` 暴露 `initBridge()`，提供“控制台选择的桥接密钥”覆盖 `.env` 中硬编码 key 的能力。`server.js` 在注册路由之前调用它，保证“任何生成请求都使用控制台生效项”。该能力是配置系统的扩展点：Key 清单与生效项持久化在内存 store 中，而非 JSON 文件。

## 4. 约定与约束

**观察到的约定：**
- 所有运行期字符串配置统一来自 `process.env`，并通过 `.env.example` 文档化。
- 业务开关类配置放在 `config/*.json`，以 `config.*` 命名空间组织。
- 种子数据（用户、小说登记）放在 `config/*.example`，由 bootstrap 流程幂等写入数据库。
- 对外 URL 一律通过 `sitePath(...)`（`src/base.js`）拼接，避免各处手写 BASE_PATH。

**明确执行的约束：**
1. `BASE_PATH` 只接受空串或 `/novel`，其他值在 `src/base.js` 启动时抛出错误（第 23–28 行）。
2. `.env` 文件被 `.gitignore` 排除，不得提交真实密钥（`.env.example` 首行注释明确要求复制为 `.env` 后再填写）。
3. 若未设置 `SESSION_SECRET`，服务会每次启动随机生成，导致重启后已有登录态失效（`.env.example` 注释描述的行为）。
4. Bridge Key 的生效顺序：控制台选择 > `.env`（`server.js` 注释：“必须早于任何生成请求，否则静默用 .env”）。

**未发现的机制：**
- 没有 YAML/TOML/INI 等多格式支持。
- 没有配置热重载。
- 没有分层合并（env → file → default）的统一抽象，每个模块各自从 `process.env` 取值。
- iOS 端配置独立于服务端，不在本仓库的后端配置体系内。