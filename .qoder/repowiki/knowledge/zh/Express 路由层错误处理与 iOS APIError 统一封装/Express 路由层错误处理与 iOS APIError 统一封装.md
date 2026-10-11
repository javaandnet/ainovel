---
kind: error_handling
name: Express 路由层错误处理与 iOS APIError 统一封装
category: error_handling
scope:
    - '**'
source_files:
    - src/routes.js
    - src/base.js
    - ios/AINovel/Networking/APIError.swift
    - src/auth/userStore.js
    - src/agent/llm.js
    - src/services/preview.js
    - src/utils/chineseNumber.js
---

## 1. 总体方案

本项目采用「Node.js `Error` + Express 中间件/try-catch」的错误模型，没有引入第三方错误类库（如 `http-errors`、`zod` 等）。后端在业务函数中直接 `throw new Error('中文文案')`，由路由层的 try-catch 捕获后转为 `{ error: string }` JSON 响应；iOS 客户端通过 `APIError` 枚举将 HTTP 状态码映射为本地化文案。

## 2. 关键文件

- `src/routes.js`：Express 路由集中定义，承载所有错误收敛逻辑（限流、VIP 门禁、TTS 失败、LLM 链路、DB 访问）。
- `src/base.js`：启动期配置校验，非法 `BASE_PATH` 直接抛错阻止进程启动。
- `ios/AINovel/Networking/APIError.swift`：iOS 端统一的网络/HTTP 错误类型，实现 `LocalizedError`。
- `src/auth/userStore.js`、`src/utils/chineseNumber.js`、`src/services/preview.js`、`src/agent/llm.js`：业务层抛出 `Error` 的源头。

## 3. 架构与约定

### 3.1 业务层：直接 throw `new Error`

各模块以「可读中文消息」作为错误语义载体，不定义自定义 Error 子类或错误码枚举。典型模式：

```js
if (!name) throw new Error('用户名不能为空');
if (findUserByName(name)) throw new Error(`用户名已存在：${name}`);
```

- `src/auth/userStore.js`：用户/小说/授权记录不存在、密码长度不足、到期时间非法等全部走此路径。
- `src/utils/chineseNumber.js`：`toChinese` 对越界输入抛错。
- `src/services/preview.js`：预览 token 格式非法抛错。
- `src/agent/llm.js`：aibridge HTTP 非 2xx、JSON 解析失败、消息为空时包装 `cause` 后抛错。

### 3.2 路由层：两类错误收敛策略

**Reader 接口（公开、读者无账号）**：使用 `readerErr(res, e)` 统一捕获（见 `/api/reader/*`、`/api/reader/image`、`/api/tts/sentence`、`/api/tts/explain`），返回 500 + `{ error: e.message }`，避免把内部堆栈暴露给匿名读者。

**管理/创作接口**：每个 handler 自管 try-catch，统一回 `{ error: e.message }`，并附带语义化状态码：

| 场景 | 状态码 | 示例 |
|---|---:|---|
| 参数缺失/非法 | 400 | `res.status(400).json({ error: '缺少参数' })` |
| 资源不存在 | 404 | `resolveNovelForUser` 返回 `{ ok:false, status:404 }` |
| 无权访问 | 403 | 非 superadmin 访问他人小说 |
| 操作冲突（并发生成） | 409 | `runningTasks` 检测到同书已有任务 |
| 功能停用（VIP 旧密码） | 410 | `/api/reader/vip-unlock` |
| 上游不可用 | 502 | aibridge 非 2xx、LLM 链路不通 |
| 服务暂时不可用（TTS） | 503 | `ttsFail` 返回 `{ fallback:'browser' }` |
| 请求过于频繁 | 429 | `rateLimit` 中间件，带 `Retry-After` 头 |
| 未认证 | 401 | VIP 闸门、预览站鉴权 |

### 3.3 特殊错误处理点

- **限流**：`rateLimit(map, limit)` 中间件按真实 IP（考虑 nginx 反代）分桶，60s 窗口超限返回 429 + `Retry-After`。
- **VIP 闸门**：`app.use('/novel', ...)` 拦截器在静态文件下发前判断预览 token 与 VIP 授权，未授权返回 HTML 说明页而非 JSON。
- **输出净化**：`/api` 下除登录/会话/管理/公开书单外的响应经 `scrubValue` 过滤绝对路径、IP、密钥字段，防止错误信息泄露敏感数据。
- **长任务互斥**：`LONG_ACTIONS` 集合上的 action 按 `novelId` 加内存锁，重复提交返回 409 并附带已运行时长。
- **SSE 进度缓冲**：`runProgressBuf` 按 `progressId` 缓存最近 200 行、10 分钟 TTL，解决 SSE 订阅晚于 publish 的竞态。
- **启动期校验**：`src/base.js` 在 `BASE_PATH` 不为空且不为 `/novel` 时直接 `throw new Error(...)`，阻止进程启动。

### 3.4 iOS 客户端侧

`APIError.swift` 定义 `enum APIError: LocalizedError`，覆盖 `network`、`invalidResponse`、`decoding`、`unauthorized`、`cancelled`、`httpStatus(code, msg)` 六种情况。其中 `httpStatus` 分支对 400/401/403/404/409/410/429 给出本地化基线文案，再拼接后端 `error` 字段。注释明确后端错误体是顶层 `{ error: "中文文案" }`（字符串，非对象），少数校验直接返回纯文本或 `{ ok:false }`，客户端在此统一收口。

## 4. 观察到的约定与约束

- 业务层错误一律通过 `throw new Error('中文消息')` 表达，不使用自定义 Error 子类或错误码常量（证据：`src/auth/userStore.js`、`src/utils/chineseNumber.js`、`src/services/preview.js`、`src/agent/llm.js` 中大量同类用法）。
- 路由层 catch 块统一返回 `{ error: e.message }`，不透原始堆栈（证据：routes.js 中数十处 `catch (e) { res.status(500).json({ error: e.message }); }`）。
- Reader 接口统一走 `readerErr(res, e)` 收敛，避免向匿名读者暴露内部异常（证据：`/api/reader/*`、`/api/tts/*`、`/api/reader/image` 的 catch 分支）。
- 破坏性操作（删除整本、删除章节、清理 TTS 缓存）强制要求请求体携带 `confirm:"OK"`，否则返回 400 中文拒绝文案（证据：`requireOkConfirm` 及多处调用）。
- 外部依赖失败使用差异化状态码：aibridge 非 2xx → 502，TTS 合成失败 → 503 + `fallback:'browser'`，限流 → 429 + `Retry-After`（证据：routes.js 对应分支）。
- VIP 旧密码入口保留但返回 410（Gone），向后兼容历史书页产物（证据：`/api/reader/vip-unlock`）。
- BASE_PATH 仅允许空串或 `/novel`，其他值启动即抛错（证据：`src/base.js` 第 23–28 行的显式校验）。
- iOS 端 `APIError.httpStatus` 对 400/401/403/404/409/410/429 提供固定本地化基线，其余状态码回退为 `请求失败(code)`（证据：`ios/AINovel/Networking/APIError.swift`）。

未发现仓库级全局 Express error middleware（如 `app.use((err, req, res, next) => ...)`），错误收敛分散在各路由 handler 的 try-catch 中。也未发现 `panic/recover` 等价机制——Node.js 侧无 panic，iOS 侧未见 `do/catch` 之外的 recover 模式。