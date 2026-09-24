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
  │    ├─ css/08-custom-select.css
  │    ├─ css/09-book-experience.css
  │    ├─ css/10-refined-ui.css
  │    └─ css/11-skeuomorphic-book.css
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

运行 `js/server.js` 时，服务提供静态文件和正确的 MIME 类型，并将 `/api/travel-auth`、`/api/travel-auth/setup`、`/api/travel-records`、`/api/travel-profile` 与 `/api/travel-data` 交给零安装依赖的数据服务，分别用于认证与换密、首次设密、记录的新增修改删除、头像更新及 `data/` 与 `.secrets/auth.json` 的动态 ZIP 导入导出。GitHub Pages 与普通静态托管仍不具备认证或写入端点。

监听配置与写入策略相互独立：`--local` / `--network` 决定绑定 `127.0.0.1` 还是 `0.0.0.0`，`--write-mode=local|remote` 决定哪些请求可以取得写入能力。默认 write mode 为 `local`，所以单独使用 `--network` 不会开放远程写入。remote 模式还必须通过可重复的 `--allowed-origin=https://...` 声明精确的 HTTPS 来源白名单。

## 个人内容与通用资源

- `data/`：旅行索引、日记正文、照片和头像等公开内容。不同使用者复用项目时，在此替换自己的内容。
- `.secrets/`：仅供 Node 服务读取的认证配置。`auth.json` 保存 `scrypt` 哈希、随机盐和参数；服务启动时若目录缺失会自动创建，local 模式首次写入由页面两次确认密码后以排他方式创建文件。写入能力探测会区分尚未设密与配置损坏：前者进入页面设密，后者弹窗列明错误并提示运行 `npm run auth:set` 修复。完整数据备份包含该文件；静态处理器在路径解析和真实路径解析后都会拒绝该目录。
- `assets/`：通用国家目录（`catalogs/countries.json`）、中国省市区目录（`catalogs/china-locations.json`）、字体、页面背景和纹理。
- `index.html`、`js/`、`css/`：共享的页面结构与功能实现；`scripts/`、`tests/`、`doc/` 分别负责维护工具、验证和使用说明。

头像由 `index.html` 直接引用 `data/profile/profile-picture.png`；页面上传时由浏览器统一转换为 PNG，并通过认证写入接口原子替换该文件。个人档案页的统计由旅行记录计算，不需要单独维护个人资料配置文件。

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

桌面端首次进入只显示合上的旅行手记封面。`css/11-skeuomorphic-book.css` 统一皮革、黄铜、织物书签、凹陷输入框与纸芯材质，沿用本地纸纹和背景，不增加运行依赖。封面宽度始终对应展开书本的一半；开合时由同一书脊轴旋转双面硬封皮，正面是皮封、背面是当前左页衬纸，书体同步平移，投影随角度收窄。合书到落稳才渲染封面路由，避免正文提前消失；动画完成或被导航、缩放打断时统一取消动画、移除副本、恢复 inert 与 aria-hidden，并恢复可见面的键盘焦点。桌面书本外层用 overflow: clip 限制翻页纸带的绘制溢出，纸页分别滚动，章节书签位于书口。路线、个人主页、地点、日记和附件沿用同一纸张轮廓。手机端采用单列纸页、皮革粘性导航和轻量开合动画，合盖页固定在一个视口内；启用减少动态效果时直接切换。

## 千禧年拟物化控件

界面延续实体旅行手记，以约 2001—2004 年桌面软件的凸起标签和按压反馈补充控件细节。参考 [XP.css 的按钮与标签组件](https://github.com/botoxparty/XP.css/) 和 [Web Design Museum 的 2003 年网页档案](https://www.webdesignmuseum.org/gallery/year-2003)，但不直接引入整套 UI 框架。黄铜铭牌、凹陷搜索框、纸质年份标签、皮革章节书签、日期牌及按钮状态统一在 `css/11-skeuomorphic-book.css` 中实现，保留现有页面结构和键盘焦点样式。

这些效果仅使用 CSS 和仓库内已有的图片、纹理与字体。运行时不加载 CDN、远程字体或远程图标；更换设计参考时也必须保持离线可用。

章节、地点、日记和附件切换先保留不可交互且对辅助技术隐藏的旧页副本，再同步渲染新内容，按书签章节和篇章前后关系决定方向：向后阅读从右下角向左翻，返回前章或上一篇从左下角向右翻。斜向纸带数量会按页宽与硬件并发能力在 12、18、24 条之间调整，让圆柱曲面的弯曲边界从外侧下角连续向内推进，逐渐转为与书脊平行；正反纸面共享曲面端点和采样坐标，并通过 Web Animations 驱动合成变换。纸背增加纸纹与透光差异，遮光随曲率变化，带模糊的接触阴影跟随斜向弯曲边界，位于静态底页之上、翻动纸面之下。屏外记录在副本中替换为等高占位；旧对页在翻动进度 72% 后渐隐，96% 时完成与新底页的交接；动画在首帧栅格化完成后启动。同章节的筛选和搜索更新直接渲染，不复制纸页。所有动画与副本在连续导航和窗口尺寸变化时一并清理。翻页期间提升整个书页层级，使纸张遮住书签、包角、书脊和静态控件；真实底页暂时设为 inert，避免键盘和鼠标穿透纸面，清理动画时恢复。窄屏以 420ms 动效统一过渡标题与正文，系统启用减少动态效果时直接切换内容。

日记详情采用信息页与正文页分工：左页仅显示日期、标题、地点、相邻篇目和原生 details 记录管理菜单，不再自动摘录正文；右页只渲染一次 Markdown 内容，有附件时才显示媒体袖套。页眉和页尾显示当前筛选范围内的篇目位置，手机端隐藏重复篇目导航并让页尾翻篇按钮保持可触达。新增与头像工具置于桌面书本外侧，避免与阅读页眉冲突。

## 文件职责

- `index.html`：应用外壳、章节导航、双页容器和弹层根节点。
- `css/journal.css`：样式入口文件，只放 `@import`。
- `css/01-foundation.css`：字体、设计变量、全局 reset、body 背景和基础可访问性样式。
- `css/02-shell.css`：应用外壳、书脊导航、双页容器、纸页和通用页头。
- `css/03-cover-route.css`：首页列表、路线插图、票据和通用按钮。
- `css/04-ledger.css`：路径索引、筛选工作台、记录卡片、概览和表单控件。
- `css/05-archive-place.css`：个人档案、地点详情、行李牌和地点关闭按钮。
- `css/06-entry-sheet.css`：Markdown 内容、照片袖套、事务型对话框和翻页动画。
- `css/07-responsive.css`：断点适配和 `prefers-reduced-motion` 降级。
- `css/08-custom-select.css`：原生选择框增强后的触发器、菜单、选项及窄屏交互样式。
- `css/09-book-experience.css`：合盖封面、开合动画、书口侧签、书内日记详情与纸张材质增强。
- `css/10-refined-ui.css`：最终视觉系统覆盖层，统一书本比例、书签与工具定位、路线概览、开放式档案列表、控件层级和移动端阅读器布局。
- `css/11-skeuomorphic-book.css`：实体材质细节与位图封面、统一页边距、控件反馈及手机阅读排布。封扣、封皮、书体、投影和光照由 `app.js` 的同一动画队列同步启动、取消；桌面开合为 1450ms。
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
- `js/profile-picture.js`：头像选择、浏览器端缩放与 PNG 转换，以及认证后的上传请求。
- `js/location.mjs`：地点字段兼容、国家规则、层级键、显示名称和搜索字段。
- `assets/catalogs/countries.json`：完整国家/地区目录和行政区显示规则。
- `assets/catalogs/china-locations.json`：中国省市区目录，为新增记录提供省份反查和省市候选。
- `scripts/update-countries.mjs`：从固定 CLDR 版本重新生成国家目录。
- `js/analytics.mjs`：与 DOM 无关的统计计算，适合单元测试。
- `js/utils.js`：通用格式化与转义工具。
- `js/server.js`：开发服务器。

## 服务端认证与记录管理的数据流

新增、修改、删除及动态数据导入导出共用服务端认证。`record-password.js` 保留六格指示器与数字键盘，但不读取任何配置文件；缺少配置时只在浏览器内比较两次输入是否一致，再通过相对 URL 提交到 `POST /api/travel-auth/setup`，已有配置时提交到 `POST /api/travel-auth`。个人主页换密先复用登录流程验证当前密码，再收集两次新密码；确认输入满 6 位时自动向 `PUT /api/travel-auth` 提交新密码及当前写入令牌。服务端负责密码策略校验、生成随机盐与 `scrypt` 哈希；首次设置仅允许 local 写入模式的 localhost 同源页面，并以 `wx` 排他创建避免覆盖现有或损坏配置。换密在数据锁内原子替换认证配置、清空旧会话并为当前页面重新签发会话。普通验证以固定参数 `scrypt` 计算候选哈希并用 `timingSafeEqual` 比较，再执行登录失败限速。remote 模式启动前必须已有可用于远程写入的六位数字配置。

任何来源合计在 15 分钟内连续失败 5 次后全局限速，并在验证前预留并发名额，避免轮换 IP/Host 或并发绕过。认证成功会创建有上限的内存会话和独立 CSRF/写入 token：Cookie 限制为 `/api`、`HttpOnly`、`SameSite=Strict`、最长 8 小时，remote 模式始终添加 `Secure`。会话绑定签发时的认证哈希，换密后旧会话在下一次请求立即失效。所有修改请求必须同时通过 Host/Origin 写入策略、会话和 `X-Travel-Token`。

动态写入环境验证通过后打开记录编辑器 `dialog`；明确的静态页面则免密码打开显式只读编辑器，只允许整理和导入导出草稿。表单复用国家目录和当前内存中的旅行记录：`record-suggestions.mjs` 先按国家与行政区收窄地点候选菜单，再通过历史精确匹配或明确名称后缀补全空白地点字段。`trip_id` 按完整日期与目的地自动生成，目的地缺失时才回退到行政区；下拉候选独立按最近日期列出 5 个不同的已有行程。自动值与用户手工值分开记录，依赖项变化时可以更新旧的自动值，但不会覆盖手工修改或导入草稿中的值。

未设置密码的 `GET /api/travel-records` 返回服务标识、`AUTH_SETUP_REQUIRED` 和空方法列表；已配置但未登录时返回 `AUTH_REQUIRED`，两者都不泄露 token。已登录时才返回 token 与支持的方法。`POST` 使用 JSON、会话与 `X-Travel-Token` 提交 v3 草稿，服务端校验字段、国家代码、正文路径及照片引用。`PUT` 提交原正文路径与草稿，`DELETE` 提交正文路径；两者要求索引中恰好匹配一条记录。`record-input.mjs` 兼容 v1、v2 草稿，仅为 v1 补齐后来新增的可选字段。

local write mode 保持原安全边界：只允许回环来源地址、localhost / `127.0.0.1` / `::1` Host，并在提供 Origin 时要求完全匹配本机 HTTP Origin；`--network` 的其他设备仍只能读取。remote write mode 不依赖客户端 IP，但只允许白名单中的 HTTPS Origin 和对应 Host，可安全兼容在 Nginx、Caddy、Apache 或 Cloudflare Tunnel 后终止 TLS。`X-Forwarded-*` 不参与授权。API 不返回 `Access-Control-Allow-Origin: *`。

前端不根据 hostname 推断权限。新增、修改、删除和动态数据导入导出都由 `record-password.js` 先探测同源 writer API：Node 环境未设置密码时进入两次确认流程，已有配置时进入普通验证；静态发布物在同一路径提供 `travel-diary-static-v1` 只读标记。静态页面的新增与修改免密码进入显式只读编辑器，删除和全部数据导入导出直接提示不可用；404、探测超时、连接失败、403 或异常响应都中止操作，不能被当作静态环境降级。认证或首次设密成功后，本次能力直接交给后续操作；`detectWriterCapability()` 只有在浏览器携带有效 `HttpOnly` 会话并取得 token 后才返回动态写入能力。

写入和全量数据导入导出共用项目根目录的 `.travel-data.lock` 独占锁。新增记录会重新读取当前索引，独占创建 Markdown 文件，写入并同步临时索引，最后用 `rename` 替换索引。目录和文件拒绝符号链接 / junction；失败时清理本次创建的正文、照片、空照片目录和临时索引。上传图片写入以目的地拼音命名的照片目录，并在索引提交前完成文件写入和同步；重试时比对照片字节。重复提交以正文路径、元数据和 Markdown 内容比对实现去重，默认正文路径使用日期和目的地拼音。自定义正文路径仍遵守年份目录、日期前缀及 ASCII 文件名规范，照片引用仅允许项目内的普通文件。

修改正文先备份原文件，索引提交失败时回滚；删除同样先暂存正文，提交后移除备份，保留照片。只有备份重命名成功后才启用正文回滚，避免备份失败时误删原文。

Markdown 与 JSON 的写入不构成跨文件事务，进程强制终止或断电可能留下锁、孤立 Markdown 或临时索引，恢复步骤见维护指南。确认写入成功后，页面重新从磁盘读取旅行数据并派生统计；读取失败与写入失败分别提示。

上传请求继续采用 JSON，不引入 multipart 解析依赖。`photo-uploads.mjs` 按文件签名识别 JPEG、PNG、GIF 和 WebP，拒绝 SVG、HTML 等格式；持久化名称由原始文件名转换为拼音，重名时追加递增序号。拼音转换运行文件随仓库分发，运行时无需联网。

正文预览复用 `js/data.js` 导出的 `parseMarkdown()`，与日记详情使用相同的 HTML 转义和链接过滤规则。源码编辑和预览编辑由 `markdown-editor.js` 负责标题拆分、语法高亮与受限 DOM 序列化；粘贴只接受纯文本。文件写入使用 `buildMarkdown()` 生成正文。新草稿导出为 ZIP，`draft.json` 仅保存字段和照片文件引用，实际图片放在 `photos/`；导入后在内存中恢复为现有写入负载。旧版 v1 至 v3 JSON 草稿继续兼容。

动态全量导出只有在会话有效时才遍历 `data/` 普通文件，并附带经过校验的 `.secrets/auth.json`。GitHub Pages 构建也不生成或发布数据备份 ZIP。导入由当前会话与 token 授权，校验 ZIP 路径、跨平台大小写冲突、文件目录重名、索引 JSON、记录字段和日期、正文 UTF-8、照片引用及认证配置。新备份会原子替换 `data/` 与 `.secrets/`；不含认证文件的旧备份保留当前认证，`data/password.json` 始终过滤。失败时恢复备份，成功后清空会话。

应用认证、HTTPS Origin 白名单、会话与写入 token 形成纵深防护，但不代替传输安全。remote write mode 默认关闭；公网部署必须使用 HTTPS，并在应用上游叠加独立认证、VPN 或 Zero Trust。当前部署选择跟踪认证哈希，因此仓库必须保持私有并限制读取权限；若曾公开，必须清理历史并换密。

## 拆分原则

CSS 采用“单入口、多分片”：`index.html` 仍只引用 `journal.css`，分片文件保持在 `css/` 根目录，避免资产相对路径因目录层级变化而失效。继续拆分时遵守以下条件：

- 函数可脱离 DOM 独立测试，例如统计、排序、解析。
- 文件职责能明确命名，且导入顺序不会制造覆盖关系不清的问题。
- 拆分后调用边界更清晰，而不是把同一页面逻辑分散到多个文件。
