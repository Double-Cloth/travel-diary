# 架构说明

## 运行架构

Travel Diary 采用“静态前端 + 可选数据写入服务”架构。浏览与筛选不需要构建步骤或后端；通过 `js/server.js` 运行时，Node.js 服务额外提供按策略限制的写入和数据备份接口。浏览器只加载一个样式入口 `css/journal.css` 和一个应用入口 `js/app.js`。

```text
index.html
  ├─ css/journal.css
  │    ├─ css/01-foundation.css
  │    ├─ css/02-shell.css
  │    ├─ css/03-cover-route.css
  │    ├─ css/04-ledger.css
  │    ├─ css/05-archive-place.css
  │    ├─ css/06-entry-sheet.css
  │    ├─ css/07-responsive.css
  │    └─ css/08-custom-select.css
  └─ js/app.js
       ├─ js/data.js
       │    └─ js/utils.js
       ├─ js/record-editor.js
       │    ├─ js/record-input.mjs
       │    ├─ js/record-suggestions.mjs
       │    ├─ js/markdown-editor.js
       │    ├─ js/photo-uploads.mjs
       │    ├─ js/draft-archive.mjs
       │    └─ js/custom-select.js
       ├─ js/record-password.js
       ├─ js/data-transfer.js
       ├─ js/zip-archive.mjs
       ├─ js/slug.mjs
       ├─ js/location.mjs
       ├─ js/analytics.mjs
       └─ js/utils.js
```

运行 `js/server.js` 时，服务提供静态文件和正确的 MIME 类型，并将 `/api/travel-auth`、`/api/travel-records` 与 `/api/travel-data` 交给零安装依赖的数据服务，分别用于认证、记录的新增修改删除及 `data/` + `.secrets/auth.json` 的动态 ZIP 导入导出。GitHub Pages 与普通静态托管仍不具备认证或写入端点。

监听配置与写入策略相互独立：`--local` / `--network` 决定绑定 `127.0.0.1` 还是 `0.0.0.0`，`--write-mode=local|remote` 决定哪些请求可以取得写入能力。默认 write mode 为 `local`，所以单独使用 `--network` 不会开放远程写入。只有显式使用 `--write-mode=remote`，同站点远程页面才可访问写入接口。

## 个人内容与通用资源

- `data/`：旅行索引、日记正文、照片和头像等公开内容。不同使用者复用项目时，在此替换自己的内容。
- `.secrets/`：仅供 Node 服务读取的认证配置。`auth.json` 保存 `scrypt` 哈希、随机盐和参数；静态处理器在路径解析和真实路径解析后都会拒绝该目录，防止直接路径、编码路径或目录链接泄露。
- `assets/`：通用国家目录（`catalogs/countries.json`）、中国省市区目录（`catalogs/china-locations.json`）、字体、页面背景和纹理。
- `index.html`、`js/`、`css/`：共享的页面结构与功能实现；`scripts/`、`tests/`、`doc/` 分别负责维护工具、验证和使用说明。

头像由 `index.html` 直接引用 `data/profile/profile-picture.png`。个人档案页的统计由旅行记录计算，不需要单独维护个人资料配置文件。

## 数据流

```text
assets/catalogs/countries.json ──→ configureCountryCatalog()
data/travel_data.json ─→ loadTravelData()
data/travel-diary/YYYY/*.md
  ↓ loadTravelRecords()
deriveTravelModel()
  ↓
renderCover() / renderLedger() / renderArchive() / renderPlace() / renderEntryRoute()
  ↓
左页与右页 DOM
```

新增记录编辑器另有一条按需数据流：

```text
assets/catalogs/countries.json
assets/catalogs/china-locations.json ──→ createRecordEditor()
data/travel_data.json ────────────────→ getRecordAutofill() / getRecordOptions()
```

`js/data.js` 会并行加载旅行记录和 `assets/catalogs/countries.json`，先用国家目录配置 `js/location.mjs`，再把国家、一级行政区和目的地规范化。之后读取每条记录的 `desc_md`，把 Markdown 转成 HTML，并为搜索生成 `searchText`。`js/app.js` 在此基础上派生年份、月份、地点、复访、概览统计和路由状态。

地点运行时模型使用 `countryKey → adminAreaKey → locationKey` 三层稳定键。国家优先使用 `country_code`，行政区和目的地键包含上级键，因此不同国家的同名州、省或城市不会在筛选和统计中合并。`admin_area` 可以为空，以支持城市国家及没有必要记录一级行政区的目的地。

`assets/catalogs/countries.json` 覆盖 ISO 3166-1 的 249 个当前分配代码，包含中英文名称、alpha-2/alpha-3/数字代码、别名和行政区显示规则。运行时不再维护内联国家表。该文件由 `scripts/update-countries.mjs` 从 Unicode CLDR 的固定版本生成，更新时运行 `npm run countries`。

`assets/catalogs/china-locations.json` 保存中国大陆省、市和区县层级，专供新增记录编辑器在 `country_code=CN` 时反查省份及补充下拉候选。目录匹配优先于个人历史记录；跨省重名地点不自动选择。该文件由 `scripts/update-china-locations.mjs` 从固定版本的 `cn-division` 生成，更新时运行 `npm run china-locations`。

## 路由

项目使用 hash 路由，不依赖服务端路由：

- `#cover`：首页。
- `#ledger`：旅行路径索引。
- `#ledger?year=2026&country=CN&area=CN%7C江苏省`：带国家和一级行政区筛选的旅行路径。
- `#archive`：个人档案。
- `#archive?q=云南`：个人档案搜索。
- `#place?country=CN&area=CN%7C江苏省&locality=CN%7C江苏省%7C苏州市`：地点详情。
- `#entry?id=2026-06-21-suzhou`：日记详情。

新增路由时优先在 `js/app.js` 中补齐四处逻辑：解析、序列化、渲染、交互入口。

旧版 `province`、`city` 查询参数与地点名称形式的 `country` 参数会在加载时解析并迁移到新键，避免已有书签失效。

## 文件职责

- `index.html`：应用外壳、章节导航、双页容器和弹层根节点。
- `css/journal.css`：样式入口文件，只放 `@import`。
- `css/01-foundation.css`：字体、设计变量、全局 reset、body 背景和基础可访问性样式。
- `css/02-shell.css`：应用外壳、书脊导航、双页容器、纸页和通用页头。
- `css/03-cover-route.css`：首页列表、路线插图、票据和通用按钮。
- `css/04-ledger.css`：路径索引、筛选工作台、记录卡片、概览和表单控件。
- `css/05-archive-place.css`：个人档案、地点详情、行李牌和地点关闭按钮。
- `css/06-entry-sheet.css`：日记弹层、Markdown 内容、照片袖套和翻页动画。
- `css/07-responsive.css`：断点适配和 `prefers-reduced-motion` 降级。
- `css/08-custom-select.css`：原生选择框增强后的触发器、菜单、选项及窄屏交互样式。
- `js/app.js`：页面状态、路由、渲染、事件绑定和筛选逻辑。
- `js/data.js`：数据读取、Markdown 解析和基础安全过滤。
- `js/record-editor.js`：原生 `dialog` 新增与修改表单、能力检测、全部元数据字段、正文视图、草稿导入导出与提交状态。
- `js/record-delete-dialog.js`：删除确认和结果反馈。
- `js/feedback-dialog.js`：通用提示与清空确认。
- `js/record-password.js`：新增、修改、删除及动态数据导入导出共用的原生 `dialog` 口令输入，将口令只提交给同源认证 API。
- `js/auth.js`：六位数字密码配置、`scrypt` 哈希生成与恒定时间验证。
- `js/writer-capability.js`：区分写入服务探测、未登录状态和已认证写入能力。
- `js/draft-archive.mjs`：ZIP 草稿元数据与独立图片文件的打包、读取和旧草稿衔接。
- `js/data-transfer.js`：个人主页全部数据导入导出的浏览器交互。
- `js/data-archive.js`：服务端 `data/` 归档、完整性校验、原子替换和统一数据锁。
- `js/zip-archive.mjs`：浏览器与 Node.js 共用的无依赖 ZIP 存储格式读写和 CRC32 校验。
- `js/slug.mjs`：中文地点、旅行标识和文件名的离线拼音规范化。
- `js/record-input.mjs`：浏览器与 Node.js 共用的草稿字段校验、记录与 Markdown 生成。
- `js/record-suggestions.mjs`：根据国家目录、已填地点和历史记录生成关联候选、可靠的空白字段补全值及旅行标识建议。
- `js/record-store.js`：可配置写入端点、Host / Origin 来源校验、图片文件写入、写入锁、索引替换和失败回滚。
- `js/writer-capability.js`：前端统一探测当前站点是否提供写入服务，并解析令牌和支持的方法。
- `js/markdown-editor.js`：源码拆分、预览渲染及可编辑 DOM 到 Markdown 的序列化。
- `js/photo-uploads.mjs`：浏览器与服务器共用的图片签名校验及可读文件命名规则。
- `js/location.mjs`：地点字段兼容、国家规则、层级键、显示名称和搜索字段。
- `assets/catalogs/countries.json`：完整国家/地区目录和行政区显示规则。
- `assets/catalogs/china-locations.json`：中国省市区目录，为新增记录提供省份反查和省市候选。
- `scripts/update-countries.mjs`：从固定 CLDR 版本重新生成国家目录。
- `js/analytics.mjs`：与 DOM 无关的统计计算，适合单元测试。
- `js/utils.js`：通用格式化与转义工具。
- `js/server.js`：开发服务器。

## 服务端认证与记录管理的数据流

新增、修改、删除及动态数据导入导出共用服务端认证。`record-password.js` 保留六格指示器与数字键盘，但不读取任何配置文件，也不在浏览器内比较密码；输满 6 位后只通过相对 URL 提交到 `POST /api/travel-auth`。服务端从普通文件 `.secrets/auth.json` 读取认证配置，以固定参数 `scrypt` 计算候选哈希并用 `timingSafeEqual` 比较，再执行登录失败限速。remote 模式只接受由后端工具生成并标记为可远程使用的六位数字配置。

同一来源 15 分钟内连续失败 5 次后被限速。认证成功会创建内存会话和独立 CSRF/写入 token：会话 Cookie 限制为 `/api`、`HttpOnly`、`SameSite=Strict`、最长 8 小时，经过同源校验的 HTTPS Origin 自动添加 `Secure`；token 仅在已登录的认证响应和能力响应中返回。服务重启、显式注销或完整数据导入都会使旧会话失效。所有修改请求必须同时通过 Host/Origin 写入策略、会话和 `X-Travel-Token`，任一条件不能替代其余条件。

验证通过后打开记录编辑器 `dialog`。表单复用国家目录和当前内存中的旅行记录：`record-suggestions.mjs` 先按国家与行政区收窄地点候选菜单，再通过历史精确匹配或明确名称后缀补全空白地点字段。`trip_id` 按完整日期与目的地自动生成，目的地缺失时才回退到行政区；下拉候选独立按最近日期列出 5 个不同的已有行程。自动值与用户手工值分开记录，依赖项变化时可以更新旧的自动值，但不会覆盖手工修改或导入草稿中的值。

未登录的 `GET /api/travel-records` 只返回服务标识、`AUTH_REQUIRED` 和空方法列表，不泄露 token；已登录时才返回 token 与支持的方法。`POST` 使用 JSON、会话与 `X-Travel-Token` 提交 v3 草稿，服务端校验字段、国家代码、正文路径及照片引用。`PUT` 提交原正文路径与草稿，`DELETE` 提交正文路径；两者要求索引中恰好匹配一条记录。`record-input.mjs` 兼容 v1、v2 草稿，仅为 v1 补齐后来新增的可选字段。

local write mode 保持原安全边界：只允许回环来源地址、localhost / `127.0.0.1` / `::1` Host，并在提供 Origin 时要求完全匹配本机 HTTP Origin；`--network` 的其他设备仍只能读取。remote write mode 不依赖客户端 IP，但要求合法 Host，且提供的 Origin 必须是 HTTP 或 HTTPS，并与 Host 使用相同 authority。比较时允许外部 HTTPS Origin 对应 Node 内部 HTTP 连接，因此兼容在 Nginx、Caddy、Apache 或 Cloudflare Tunnel 后终止 TLS；协议之外的 `X-Forwarded-*` 不参与授权，也不能绕过来源判断。API 不返回 `Access-Control-Allow-Origin: *`，任意跨域来源会被拒绝。

前端不根据 hostname 推断权限。`probeWriterService()` 可识别存在但尚未登录的 writer API，`detectWriterCapability()` 只有在浏览器携带有效 `HttpOnly` 会话并取得 token 后才返回动态写入能力；local 模式的远程页面、GitHub Pages、普通静态服务器或 API 不存在时自动进入只读模式。只读页面仍可编辑和导出草稿，全量导出回退到只包含公开 `data/` 的静态 `travel-diary-data.zip`。

写入和全量数据导入导出共用项目根目录的 `.travel-data.lock` 独占锁。新增记录会重新读取当前索引，独占创建 Markdown 文件，写入并同步临时索引，最后用 `rename` 替换索引。目录和文件拒绝符号链接 / junction；失败时清理本次创建的正文、照片、空照片目录和临时索引。上传图片写入以目的地拼音命名的照片目录，并在索引提交前完成文件写入和同步；重试时比对照片字节。重复提交以正文路径、元数据和 Markdown 内容比对实现去重，默认正文路径使用日期和目的地拼音。自定义正文路径仍遵守年份目录、日期前缀及 ASCII 文件名规范，照片引用仅允许项目内的普通文件。

修改正文先备份原文件，索引提交失败时回滚；删除同样先暂存正文，提交后移除备份，保留照片。只有备份重命名成功后才启用正文回滚，避免备份失败时误删原文。

Markdown 与 JSON 的写入不构成跨文件事务，进程强制终止或断电可能留下锁、孤立 Markdown 或临时索引，恢复步骤见维护指南。确认写入成功后，页面重新从磁盘读取旅行数据并派生统计；读取失败与写入失败分别提示。

上传请求继续采用 JSON，不引入 multipart 解析依赖。`photo-uploads.mjs` 按文件签名识别 JPEG、PNG、GIF 和 WebP，拒绝 SVG、HTML 等格式；持久化名称由原始文件名转换为拼音，重名时追加递增序号。拼音转换运行文件随仓库分发，运行时无需联网。

正文预览复用 `js/data.js` 导出的 `parseMarkdown()`，与日记详情使用相同的 HTML 转义和链接过滤规则。源码编辑和预览编辑由 `markdown-editor.js` 负责标题拆分、语法高亮与受限 DOM 序列化；粘贴只接受纯文本。文件写入使用 `buildMarkdown()` 生成正文。新草稿导出为 ZIP，`draft.json` 仅保存字段和照片文件引用，实际图片放在 `photos/`；导入后在内存中恢复为现有写入负载。旧版 v1 至 v3 JSON 草稿继续兼容。

动态全量导出只有在会话有效时才遍历普通文件，把 `data/` 与 `.secrets/auth.json` 写入 ZIP；认证配置不含明文密码。GitHub Pages 构建调用 `scripts/build-data-backup.js` 时沿用默认 `includeAuth: false`，因此公开静态 ZIP 只有 `data/`。导入由当前会话与 token 授权，随后校验 ZIP 路径、跨平台大小写冲突、文件目录重名、索引 JSON、记录字段和日期、正文 UTF-8、照片引用及认证配置；remote 模式拒绝未按六位数字策略生成的认证配置。旧备份缺少 `.secrets/auth.json` 时复制当前配置，旧 `data/password.json` 被过滤。全部内容先写入项目内临时目录，再分别以 `rename` 替换 `data/` 与 `.secrets/`；任一步失败都会恢复两组备份并清理暂存目录。成功后清空会话，确保恢复后的凭据立即成为唯一有效登录凭据。

应用认证、同源校验与写入 token 形成纵深防护，但不代替传输安全。remote write mode 默认关闭；公网部署必须使用 HTTPS，并建议在应用上游叠加反向代理认证、VPN 或 Zero Trust。跟踪在 Git 中的密码哈希可能被仓库读者用于离线猜测，因此仓库访问控制和高熵长口令仍是生产边界的一部分。

## 拆分原则

CSS 采用“单入口、多分片”：`index.html` 仍只引用 `journal.css`，分片文件保持在 `css/` 根目录，避免资产相对路径因目录层级变化而失效。继续拆分时遵守以下条件：

- 函数可脱离 DOM 独立测试，例如统计、排序、解析。
- 文件职责能明确命名，且导入顺序不会制造覆盖关系不清的问题。
- 拆分后调用边界更清晰，而不是把同一页面逻辑分散到多个文件。
