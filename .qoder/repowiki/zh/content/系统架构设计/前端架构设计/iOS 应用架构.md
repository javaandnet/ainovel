# iOS 应用架构

<cite>
**本文引用的文件**   
- [AINovelApp.swift](file://ios/AINovel/AINovelApp.swift)
- [RootView.swift](file://ios/AINovel/App/RootView.swift)
- [MainTabView.swift](file://ios/AINovel/App/MainTabView.swift)
- [ReaderRootView.swift](file://ios/AINovel/Reader/ReaderRootView.swift)
- [ManageRootView.swift](file://ios/AINovel/Manage/ManageRootView.swift)
- [AuthViewModel.swift](file://ios/AINovel/Auth/AuthViewModel.swift)
- [LoginView.swift](file://ios/AINovel/Auth/LoginView.swift)
- [SiteWebView.swift](file://ios/AINovel/Reader/SiteWebView.swift)
- [LibraryViewModel.swift](file://ios/AINovel/Reader/LibraryViewModel.swift)
- [MeView.swift](file://ios/AINovel/Me/MeView.swift)
- [AppConfig.swift](file://ios/AINovel/Config/AppConfig.swift)
- [Models.swift](file://ios/AINovel/Models/Models.swift)
- [APIError.swift](file://ios/AINovel/Networking/APIError.swift)
- [Endpoints.swift](file://ios/AINovel/Networking/Endpoints.swift)
- [KeychainStore.swift](file://ios/AINovel/Security/KeychainStore.swift)
</cite>

## 更新摘要
**所做更改**   
- 更新了 RootView 和 ReaderRootView 的导航结构，ReaderRootView 成为新的主要入口点
- 添加了公开目录浏览功能的详细说明
- 增强了认证状态处理的描述
- 更新了架构图以反映新的 UI 结构变化
- 补充了 SiteWebView 和 Cookie 同步机制的说明

## 目录
1. [引言](#引言)
2. [项目结构](#项目结构)
3. [核心组件](#核心组件)
4. [架构总览](#架构总览)
5. [详细组件分析](#详细组件分析)
6. [依赖关系分析](#依赖关系分析)
7. [性能与可靠性考虑](#性能与可靠性考虑)
8. [故障排查指南](#故障排查指南)
9. [结论](#结论)

## 引言
本文件面向 AINovel iOS 应用的架构文档，聚焦 SwiftUI MVVM 模式在工程中的落地方式。内容覆盖：
- App 入口点配置、全局状态管理与依赖注入
- RootView 与 ReaderRootView 的新导航结构与路由逻辑
- 公开目录浏览能力与增强认证状态处理
- AppConfig 的配置管理机制与环境变量处理
- 应用启动流程、生命周期管理与错误处理策略
- View / ViewModel / Model 分层关系与数据流向

该文档既适合初次接触项目的开发者快速上手，也便于资深工程师定位问题与扩展功能。

## 项目结构
iOS 端采用 SwiftUI + Combine 的 MVVM 架构，按功能域划分目录：
- App：应用级视图（根视图、主标签页）
- Reader：阅读相关视图与模型，包含公开目录浏览功能
- Manage：作品管理相关视图与模型
- Auth：认证与登录界面
- Config：应用配置与多环境支持
- Networking：网络请求错误类型与 API 端点定义
- Security：Keychain 安全存储封装
- Models：领域模型与响应体

```mermaid
graph TB
subgraph "应用层"
AINovelApp["AINovelApp<br/>应用入口"]
RootView["RootView<br/>根视图"]
MainTabView["MainTabView<br/>主标签页传统"]
end
subgraph "功能模块"
ReaderRootView["ReaderRootView<br/>阅读首页新入口"]
ManageRootView["ManageRootView<br/>管理首页"]
LoginView["LoginView<br/>登录界面"]
SiteWebView["SiteWebView<br/>内置阅读器"]
MeView["MeView<br/>个人中心"]
end
subgraph "业务层"
AuthViewModel["AuthViewModel<br/>认证与全局状态"]
LibraryViewModel["LibraryViewModel<br/>书单/小说列表"]
end
subgraph "基础设施"
AppConfig["AppConfig<br/>配置与环境"]
Endpoints["Endpoints<br/>API 路径"]
APIError["APIError<br/>统一错误"]
KeychainStore["KeychainStore<br/>安全存储"]
Models["Models<br/>领域模型"]
end
AINovelApp --> RootView
RootView --> ReaderRootView
RootView -.-> LoginView
MainTabView --> ReaderRootView
MainTabView --> ManageRootView
MainTabView --> MeView
ReaderRootView --> SiteWebView
ReaderRootView --> AuthViewModel
ReaderRootView --> LibraryViewModel
ManageRootView --> AuthViewModel
ManageRootView --> LibraryViewModel
AuthViewModel --> Endpoints
AuthViewModel --> APIError
AuthViewModel --> KeychainStore
ReaderRootView --> Models
ManageRootView --> Models
ReaderRootView --> AppConfig
ManageRootView --> AppConfig
```

**图表来源**
- [AINovelApp.swift:3-13](file://ios/AINovel/AINovelApp.swift#L3-L13)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [MainTabView.swift:3-16](file://ios/AINovel/App/MainTabView.swift#L3-L16)
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [ManageRootView.swift:3-81](file://ios/AINovel/Manage/ManageRootView.swift#L3-L81)
- [SiteWebView.swift:7-52](file://ios/AINovel/Reader/SiteWebView.swift#L7-L52)
- [AuthViewModel.swift:9-106](file://ios/AINovel/Auth/AuthViewModel.swift#L9-L106)
- [LibraryViewModel.swift:5-52](file://ios/AINovel/Reader/LibraryViewModel.swift#L5-L52)
- [AppConfig.swift:11-110](file://ios/AINovel/Config/AppConfig.swift#L11-L110)
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [KeychainStore.swift:7-82](file://ios/AINovel/Security/KeychainStore.swift#L7-L82)
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

**章节来源**
- [AINovelApp.swift:3-13](file://ios/AINovel/AINovelApp.swift#L3-L13)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [MainTabView.swift:3-16](file://ios/AINovel/App/MainTabView.swift#L3-L16)

## 核心组件
- AINovelApp：应用入口，创建并注入全局 AuthViewModel，挂载 RootView。
- RootView：应用根视图，默认进入 ReaderRootView；按需弹出登录 Sheet；冷启动时触发认证引导。
- MainTabView：传统三栏 TabBar（阅读、管理、我的），用于旧版或特定场景下的导航。
- ReaderRootView：**新的主要入口点**，展示公开书单，未登录也可浏览；登录后显示"管理""我的"工具栏入口。
- ManageRootView：管理首页，展示已登录用户拥有的小说列表，支持新建、删除等管理操作。
- SiteWebView：内置阅读器，使用 WKWebView 打开发布后的读者站页面，自动同步 Cookie 以支持 VIP 内容访问。
- AuthViewModel：认证与全局状态中心，负责登录态探测、登录/登出、记住密码、401 自动登出、按需登录。
- LibraryViewModel：共享的书籍列表 ViewModel，同时服务于阅读和管理两个模块。
- AppConfig：配置中心，提供多环境 baseURL、超时时间、UI 语言等。
- Endpoints：集中化 API 路径枚举，与后端路由对齐。
- APIError：统一错误类型，将网络、HTTP、解码等异常转换为可读文案。
- KeychainStore：Keychain 封装，保存凭据与会话快照。
- Models：领域模型与响应体，包括用户会话、小说、章节、设置、通用 JSONValue 等。

**章节来源**
- [AINovelApp.swift:3-13](file://ios/AINovel/AINovelApp.swift#L3-L13)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [MainTabView.swift:3-16](file://ios/AINovel/App/MainTabView.swift#L3-L16)
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [ManageRootView.swift:3-81](file://ios/AINovel/Manage/ManageRootView.swift#L3-L81)
- [SiteWebView.swift:7-52](file://ios/AINovel/Reader/SiteWebView.swift#L7-L52)
- [AuthViewModel.swift:9-106](file://ios/AINovel/Auth/AuthViewModel.swift#L9-L106)
- [LibraryViewModel.swift:5-52](file://ios/AINovel/Reader/LibraryViewModel.swift#L5-L52)
- [AppConfig.swift:11-110](file://ios/AINovel/Config/AppConfig.swift#L11-L110)
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [KeychainStore.swift:7-82](file://ios/AINovel/Security/KeychainStore.swift#L7-L82)
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

## 架构总览
下图展示 SwiftUI MVVM 的分层关系与数据流向：View 层通过 EnvironmentObject 获取 AuthViewModel，调用 APIClient（由 Endpoints 提供路径）访问后端；Model 层承载领域数据；AppConfig 提供运行时配置；KeychainStore 提供安全存储。

```mermaid
classDiagram
class AINovelApp {
+body() Scene
}
class RootView {
+auth : AuthViewModel
+body() View
}
class MainTabView {
+body() View
}
class ReaderRootView {
+auth : AuthViewModel
+lib : LibraryViewModel
+body() View
}
class ManageRootView {
+auth : AuthViewModel
+lib : LibraryViewModel
+body() View
}
class SiteWebView {
+url : URL
+title : String
+relativeURL(path) URL?
+absoluteSiteURL(url) URL?
}
class AuthViewModel {
+user : UserSession?
+bootstrapping : Bool
+showLogin : Bool
+isLoggedIn : Bool
+bootstrap() async
+login(...) async
+logout() async
+requestLogin()
}
class LibraryViewModel {
+novels : [Novel]
+catalog : [CatalogNovel]
+loading : Bool
+refreshCatalog() async
+refresh() async
}
class AppConfig {
+baseURL : URL
+setEnv(...)
+normalize(...)
}
class Endpoints {
+login
+me
+novels(...)
+catalog
+chapters(...)
+chapter(...)
}
class APIError {
+errorDescription : String?
}
class KeychainStore {
+saveCredential(...)
+loadCredential()
+saveSession(...)
+loadSession()
}
class Models {
<<domain models>>
}
AINovelApp --> RootView : "注入 auth"
RootView --> ReaderRootView : "默认首页"
RootView --> LoginView : "Sheet 登录"
MainTabView --> ReaderRootView : "Tab 阅读"
MainTabView --> ManageRootView : "Tab 管理"
MainTabView --> MeView : "Tab 我的"
ReaderRootView --> SiteWebView : "打开阅读器"
ReaderRootView --> AuthViewModel : "读取登录态"
ManageRootView --> AuthViewModel : "读取登录态"
ReaderRootView --> LibraryViewModel : "加载书单"
ManageRootView --> LibraryViewModel : "加载作品"
AuthViewModel --> Endpoints : "使用 API 路径"
AuthViewModel --> APIError : "统一错误"
AuthViewModel --> KeychainStore : "凭据/会话"
ReaderRootView --> Models : "展示模型"
ManageRootView --> Models : "展示模型"
ReaderRootView --> AppConfig : "读取 baseURL"
ManageRootView --> AppConfig : "读取 baseURL"
SiteWebView --> AppConfig : "解析站点 URL"
```

**图表来源**
- [AINovelApp.swift:3-13](file://ios/AINovel/AINovelApp.swift#L3-L13)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [MainTabView.swift:3-16](file://ios/AINovel/App/MainTabView.swift#L3-L16)
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [ManageRootView.swift:3-81](file://ios/AINovel/Manage/ManageRootView.swift#L3-L81)
- [SiteWebView.swift:7-52](file://ios/AINovel/Reader/SiteWebView.swift#L7-L52)
- [AuthViewModel.swift:9-106](file://ios/AINovel/Auth/AuthViewModel.swift#L9-L106)
- [LibraryViewModel.swift:5-52](file://ios/AINovel/Reader/LibraryViewModel.swift#L5-L52)
- [AppConfig.swift:11-110](file://ios/AINovel/Config/AppConfig.swift#L11-L110)
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [KeychainStore.swift:7-82](file://ios/AINovel/Security/KeychainStore.swift#L7-L82)
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

## 详细组件分析

### App 入口与全局状态注入
- AINovelApp 使用 @StateObject 持有 AuthViewModel.shared，并通过 .environmentObject(auth) 注入到整个视图树。
- RootView 通过 @EnvironmentObject var auth: AuthViewModel 消费全局状态。
- 这种设计实现了"单一可信源"的全局登录态，避免在各 View 中重复维护状态。

```mermaid
sequenceDiagram
participant App as "AINovelApp"
participant Root as "RootView"
participant Auth as "AuthViewModel"
App->>App : 创建 @StateObject auth = AuthViewModel.shared
App->>Root : 注入 environmentObject(auth)
Root->>Root : @EnvironmentObject var auth
Root->>Auth : task { bootstrap() }
Auth-->>Root : bootstrapping=false, user 更新
```

**图表来源**
- [AINovelApp.swift:3-13](file://ios/AINovel/AINovelApp.swift#L3-L13)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [AuthViewModel.swift:37-54](file://ios/AINovel/Auth/AuthViewModel.swift#L37-L54)

**章节来源**
- [AINovelApp.swift:3-13](file://ios/AINovel/AINovelApp.swift#L3-L13)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)

### RootView 与 ReaderRootView 新导航结构
**更新** RootView 现在作为轻量级容器，直接渲染 ReaderRootView 作为主要入口点，替代了传统的 TabBar 导航。

- RootView：简化为容器视图，默认进入 ReaderRootView，仅在需要时弹出 LoginView Sheet。
- ReaderRootView：**新的主要入口点**，实现公开目录浏览功能，未登录用户可浏览公开书单。
- MainTabView：保留但降级为传统导航选项，适用于特定场景。

```mermaid
flowchart TD
Start(["应用启动"]) --> Root["RootView"]
Root --> Reader["ReaderRootView (主要入口)"]
Root --> |条件| Login["LoginView (Sheet)"]
Reader --> Catalog["公开书单浏览"]
Reader --> |点击书籍| SiteWeb["SiteWebView (内置阅读器)"]
Reader --> |工具栏| Manage["ManageRootView (Sheet)"]
Reader --> |工具栏| Me["MeView (Sheet)"]
MainTab["MainTabView (传统)"] --> Reader
MainTab --> Manage
MainTab --> Me
```

**图表来源**
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [MainTabView.swift:3-16](file://ios/AINovel/App/MainTabView.swift#L3-L16)

**章节来源**
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [MainTabView.swift:3-16](file://ios/AINovel/App/MainTabView.swift#L3-L16)

### 公开目录浏览功能
**新增** ReaderRootView 实现了完整的公开目录浏览功能，允许未登录用户浏览已发布的小说。

- 公开书单：通过 `/api/catalog` 接口获取，未登录时只显示非 VIP 书籍。
- 搜索功能：支持按书名搜索过滤。
- VIP 标识：VIP 书籍带有特殊标记，登录后可能显示更多权限内容。
- 内置阅读器：点击书籍后通过 SiteWebView 打开真实书页，自动同步 Cookie 以支持 VIP 内容。

```mermaid
sequenceDiagram
participant User as "用户"
participant Reader as "ReaderRootView"
participant Lib as "LibraryViewModel"
participant API as "APIClient"
participant Site as "SiteWebView"
User->>Reader : 打开应用
Reader->>Lib : refreshCatalog()
Lib->>API : GET /api/catalog
API-->>Lib : CatalogResponse
Lib-->>Reader : catalog 数据
Reader->>Reader : 显示公开书单
User->>Reader : 点击书籍
Reader->>Site : open SiteWebView
Site->>Site : 同步 Cookie
Site->>Site : 加载网页
```

**图表来源**
- [ReaderRootView.swift:14-78](file://ios/AINovel/Reader/ReaderRootView.swift#L14-L78)
- [LibraryViewModel.swift:17-29](file://ios/AINovel/Reader/LibraryViewModel.swift#L17-L29)
- [SiteWebView.swift:7-52](file://ios/AINovel/Reader/SiteWebView.swift#L7-L52)

**章节来源**
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [LibraryViewModel.swift:5-52](file://ios/AINovel/Reader/LibraryViewModel.swift#L5-L52)
- [SiteWebView.swift:7-111](file://ios/AINovel/Reader/SiteWebView.swift#L7-L111)

### 增强的认证状态处理
**更新** AuthViewModel 现在支持更灵活的认证状态管理，包括按需登录和更好的用户体验。

- 按需登录：未登录时可浏览公开内容，遇到需登录的操作时才拉起登录 Sheet。
- 启动优化：先使用 Keychain 快照回填界面，再异步探测权威登录态，避免闪屏。
- 401 处理：统一的过期处理逻辑，自动清理会话并提示重新登录。
- 状态同步：登录态变化会自动刷新公开书单，确保 VIP 内容的正确显示。

```mermaid
sequenceDiagram
participant Root as "RootView"
participant Auth as "AuthViewModel"
participant API as "APIClient"
participant KC as "KeychainStore"
Root->>Auth : bootstrap()
Auth->>KC : loadSession()
Auth->>API : GET /api/me
API-->>Auth : MeResponse.user
Auth->>KC : saveSession(user)
Auth-->>Root : bootstrapping=false
Note over Root,Auth : 若 401，则 showLogin=true
```

**图表来源**
- [RootView.swift:14-18](file://ios/AINovel/App/RootView.swift#L14-L18)
- [AuthViewModel.swift:26-54](file://ios/AINovel/Auth/AuthViewModel.swift#L26-L54)
- [KeychainStore.swift:31-44](file://ios/AINovel/Security/KeychainStore.swift#L31-L44)

**章节来源**
- [AuthViewModel.swift:9-106](file://ios/AINovel/Auth/AuthViewModel.swift#L9-L106)
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [KeychainStore.swift:7-82](file://ios/AINovel/Security/KeychainStore.swift#L7-L82)

### SiteWebView 与 Cookie 同步机制
**新增** SiteWebView 提供了内置阅读器功能，解决了 WKWebView 与 URLSession 之间的 Cookie 同步问题。

- 相对 URL 处理：支持将相对路径转换为完整 URL，处理中文路径编码。
- Cookie 同步：自动将 URLSession 的 httpOnly Cookie 注入 WKWebView，确保 VIP 内容访问。
- 站点 URL 解析：智能识别绝对 URL 和相对路径，自动补全协议和主机名。
- 加载状态管理：提供加载进度指示器和错误处理。

```mermaid
flowchart TD
Relative["相对 URL (/novel/uid/book/index.html)"] --> Encode["URL 编码处理"]
Encode --> Absolute["转换为绝对 URL"]
Absolute --> CookieSync["Cookie 同步"]
CookieSync --> Load["加载网页"]
Load --> VIP{"VIP 内容?"}
VIP --> |是| Allow["放行访问"]
VIP --> |否| Show["正常显示"]
```

**图表来源**
- [SiteWebView.swift:36-51](file://ios/AINovel/Reader/SiteWebView.swift#L36-L51)
- [SiteWebView.swift:94-110](file://ios/AINovel/Reader/SiteWebView.swift#L94-L110)

**章节来源**
- [SiteWebView.swift:7-111](file://ios/AINovel/Reader/SiteWebView.swift#L7-L111)

### 配置管理（AppConfig）
- 优先级：用户选择的接入环境 > 用户自设地址 > Info.plist / 编译默认。
- 环境变量：DEBUG 模式下可从进程环境变量读取 AINovel_BASE_URL。
- 规范化：自动补 scheme、去尾斜杠、无路径时补 /novel 前缀。
- 多环境：内置 builtin、公网 cloud、自定义 custom，切换时清除不兼容的自设地址。
- 超时：通用请求超时与 LLM 长耗时接口超时分别配置。

```mermaid
flowchart TD
Env["选择环境"] --> Builtin["builtin<br/>Info.plist / DEBUG 环境变量 / 回环"]
Env --> Cloud["cloud<br/>公网站点根"]
Env --> Custom["custom<br/>用户自设地址"]
Custom --> Normalize["normalize(raw)<br/>补scheme/去斜杠/补/novel"]
Builtin --> BaseURL["baseURL"]
Cloud --> BaseURL
Normalize --> BaseURL
```

**图表来源**
- [AppConfig.swift:24-40](file://ios/AINovel/Config/AppConfig.swift#L24-L40)
- [AppConfig.swift:51-67](file://ios/AINovel/Config/AppConfig.swift#L51-L67)
- [AppConfig.swift:89-102](file://ios/AINovel/Config/AppConfig.swift#L89-L102)

**章节来源**
- [AppConfig.swift:11-110](file://ios/AINovel/Config/AppConfig.swift#L11-L110)

### 数据模型与领域对象
- 认证：UserSession、MeResponse、LoginResponse。
- 小说：Novel、CatalogNovel、CreateNovelResponse。
- 章节：Chapter、ChapterDetail、ChaptersResponse、ChapterResponse。
- 设定：GenCfg、WordBand、NovelSettings、SaveSettingsResponse。
- 分部：Part、PartsResponse。
- 阅读器 AI：QuizQuestion、VocabResponse、ExplainResponse、AskResponse、FeedbackResponse、WordStatusResponse。
- 分享/发布/检查：ShareResponse、PublishResponse、CheckResponse。
- 通用动作：RunResponse、LLMStatus、RenumberResponse、OkResponse。
- 宽松 JSON：JSONValue 用于 /api/run 的 result 与体检 report 的多变形状兜底。

```mermaid
erDiagram
USERSESSION {
string id
string username
string role
}
NOVEL {
string id
string name
int chapterCount
double updatedAt
bool vip
}
CATALOGNOVEL {
string id
string uid
string title
int chapterCount
bool vip
string url
double updatedAt
}
CHAPTER {
int no
string name
string outline
int wordCount
bool hasContent
int partNo
string id
}
PART {
int no
string name
int startNo
int endNo
int chapters
bool hasIntro
}
GENCFG {
int targetWords
int tolerancePct
int splitPct
}
WORDBAND {
int min
int max
int target
int splitLine
}
NOVELSETTINGS {
string name
string outline
string content
string preface
int version
GenCfg genCfg
WordBand wordBand
int chapterCount
int outlineCount
int bodyCount
int totalWords
}
USERSESSION ||--o{ NOVEL : "拥有"
NOVEL ||--o{ CHAPTER : "包含"
NOVEL ||--o{ PART : "分部分"
NOVEL ||--|| NOVELSETTINGS : "配置"
```

**图表来源**
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

**章节来源**
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

### 网络与错误处理
- Endpoints：集中定义所有 API 路径，与后端路由对齐，参数化拼接。
- APIError：统一错误类型，涵盖网络、无效响应、解码失败、未授权、取消、HTTP 状态码等，并提供本地化描述。
- AuthViewModel：注册 401 回调，统一处理过期与匿名访问受限场景。

```mermaid
flowchart TD
Request["发起请求"] --> Endpoint["Endpoints 拼接路径"]
Endpoint --> Network["网络请求"]
Network --> Response{"响应成功?"}
Response --> |否| Error["APIError 分类与文案"]
Response --> |是| Decode["解码为 Model"]
Decode --> UI["更新 UI 状态"]
Error --> Handle["AuthViewModel.handleExpired / 显示错误"]
```

**图表来源**
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [AuthViewModel.swift:89-96](file://ios/AINovel/Auth/AuthViewModel.swift#L89-L96)

**章节来源**
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [AuthViewModel.swift:89-96](file://ios/AINovel/Auth/AuthViewModel.swift#L89-L96)

## 依赖关系分析
- View 层依赖 ViewModel 提供的状态与方法，通过 EnvironmentObject 注入。
- ViewModel 依赖 Endpoints 提供 API 路径，依赖 APIError 统一错误，依赖 KeychainStore 持久化凭据与会话快照。
- 配置层 AppConfig 被多个 View 与 ViewModel 共享，确保 baseURL 一致性。
- Model 层作为纯数据结构，被 View 与 ViewModel 共同消费。

```mermaid
graph LR
View["View 层"] --> VM["ViewModel 层"]
VM --> EP["Endpoints"]
VM --> AE["APIError"]
VM --> KS["KeychainStore"]
View --> AC["AppConfig"]
View --> MD["Models"]
```

**图表来源**
- [RootView.swift:3-20](file://ios/AINovel/App/RootView.swift#L3-L20)
- [ReaderRootView.swift:6-78](file://ios/AINovel/Reader/ReaderRootView.swift#L6-L78)
- [ManageRootView.swift:3-81](file://ios/AINovel/Manage/ManageRootView.swift#L3-L81)
- [AuthViewModel.swift:9-106](file://ios/AINovel/Auth/AuthViewModel.swift#L9-L106)
- [AppConfig.swift:11-110](file://ios/AINovel/Config/AppConfig.swift#L11-L110)
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [KeychainStore.swift:7-82](file://ios/AINovel/Security/KeychainStore.swift#L7-L82)
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

**章节来源**
- [AuthViewModel.swift:9-106](file://ios/AINovel/Auth/AuthViewModel.swift#L9-L106)
- [AppConfig.swift:11-110](file://ios/AINovel/Config/AppConfig.swift#L11-L110)
- [Endpoints.swift:5-50](file://ios/AINovel/Networking/Endpoints.swift#L5-L50)
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [KeychainStore.swift:7-82](file://ios/AINovel/Security/KeychainStore.swift#L7-L82)
- [Models.swift:6-233](file://ios/AINovel/Models/Models.swift#L6-L233)

## 性能与可靠性考虑
- 冷启动优化：先用 Keychain 快照回填界面，再异步探测 /api/me，避免闪屏与白屏。
- 公开内容优先：未登录用户可立即浏览公开书单，提升首次体验。
- 超时控制：通用请求与 LLM 长耗时接口分别配置超时，提升用户体验与稳定性。
- 错误本地化：APIError 将网络与 HTTP 状态映射为中文提示，降低用户困惑。
- 会话持久化：httpOnly Cookie 维持权威会话，Keychain 仅存快照与凭据，减少敏感信息暴露面。
- 配置即时生效：每次动态读取 baseURL，切换环境无需重启应用。
- Cookie 同步优化：WKWebView 与 URLSession 的 Cookie 同步采用批量处理，提升性能。

## 故障排查指南
- 无法连接服务器：检查 AppConfig.baseURL 是否正确，确认 Info.plist 或环境变量是否配置正确。
- 登录失败：查看 AuthViewModel.errorMessage，确认用户名/密码与服务器地址；必要时切换到 ServerSettingsView 调整 baseURL。
- 401 自动登出：确认 Cookie 是否有效；更换服务器地址后需重新登录。
- 数据解析失败：检查后端返回体是否与 Models 定义一致；必要时放宽 JSONValue 的使用。
- 网络超时：根据接口类型调整超时配置；LLM 类接口建议更长超时。
- 公开书单为空：检查网络连接和服务器状态；确认是否有已发布的小说。
- VIP 内容无法访问：确认 Cookie 同步是否正常；检查 SiteWebView 的 URL 解析逻辑。
- 内置阅读器加载失败：检查站点 URL 格式；确认网络权限和 Cookie 同步状态。

**章节来源**
- [APIError.swift:9-47](file://ios/AINovel/Networking/APIError.swift#L9-L47)
- [AuthViewModel.swift:56-80](file://ios/AINovel/Auth/AuthViewModel.swift#L56-L80)
- [AppConfig.swift:24-40](file://ios/AINovel/Config/AppConfig.swift#L24-L40)
- [AppConfig.swift:89-102](file://ios/AINovel/Config/AppConfig.swift#L89-L102)
- [SiteWebView.swift:36-51](file://ios/AINovel/Reader/SiteWebView.swift#L36-L51)

## 结论
AINovel iOS 应用采用清晰的 SwiftUI MVVM 架构，经过重大 UI 重构后具有以下特点：

- **ReaderRootView 作为主要入口点**：替代了传统的 TabBar 导航，提供更专注的阅读体验。
- **公开目录浏览能力**：未登录用户可浏览已发布的小说，提升新用户转化率。
- **增强的认证状态处理**：支持按需登录和更好的用户体验，避免不必要的登录干扰。
- **内置阅读器集成**：通过 SiteWebView 提供无缝的阅读体验，自动处理 Cookie 同步。
- **App 入口集中注入全局状态**，RootView 作为轻量级容器，ReaderRootView 承担主要阅读体验。
- **AuthViewModel 统一管理认证与全局状态**，结合 KeychainStore 实现凭据与会话快照的安全存储。
- **AppConfig 提供多环境 baseURL 与超时配置**，保证运行期灵活性与可维护性。
- **Endpoints 与 APIError 统一网络契约与错误处理**，提升健壮性与可观测性。
- **Models 作为领域层**，清晰表达业务实体与响应结构。

该架构具备良好的可扩展性与可测试性，便于后续新增功能与优化体验。新的 UI 结构更加符合现代移动应用的设计模式，为用户提供了更流畅的阅读体验。