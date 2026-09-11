# 架构说明

## 运行架构

Travel Diary 是无构建步骤的静态前端项目。浏览器加载 `index.html`，再加载样式入口 `css/journal.css` 和唯一应用入口 `js/app.js`。`journal.css` 只维护 `@import` 顺序，实际样式按职责拆分到同级 CSS 分片。

```text
index.html
  ├─ css/journal.css
  │    ├─ css/01-foundation.css
  │    ├─ css/02-shell.css
  │    ├─ css/03-cover-route.css
  │    ├─ css/04-ledger.css
  │    ├─ css/05-archive-place.css
  │    ├─ css/06-entry-sheet.css
  │    └─ css/07-responsive.css
  └─ js/app.js
       ├─ js/data.js
       │    └─ js/utils.js
       ├─ js/record-editor.js
       │    ├─ js/record-input.mjs
       │    ├─ js/record-suggestions.mjs
       │    ├─ js/draft-archive.mjs
       │    └─ js/data.js
       ├─ js/data-transfer.js
       ├─ js/zip-archive.mjs
       ├─ js/slug.mjs
       ├─ js/location.mjs
       ├─ js/analytics.mjs
       └─ js/utils.js
```

本地运行时，`js/server.js` 提供静态文件服务和正确的 MIME 类型，并将 `/api/travel-records` 与 `/api/travel-data` 交给零安装依赖的本地数据服务，分别用于新增记录及整个 `data/` 的 ZIP 导入导出。GitHub Pages 仍只发布静态文件，不具备写入端点。

## 个人内容与通用资源

- `data/`：个人旅行元数据、日记正文、旅行照片及 `profile/` 中的头像。不同使用者复用项目时，在此替换自己的内容。
- `assets/`：通用国家目录（`catalogs/countries.json`）、字体、页面背景和纹理。
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

`js/data.js` 会并行加载旅行记录和 `assets/catalogs/countries.json`，先用国家目录配置 `js/location.mjs`，再把国家、一级行政区和目的地规范化。之后读取每条记录的 `desc_md`，把 Markdown 转成 HTML，并为搜索生成 `searchText`。`js/app.js` 在此基础上派生年份、月份、地点、复访、概览统计和路由状态。

地点运行时模型使用 `countryKey → adminAreaKey → locationKey` 三层稳定键。国家优先使用 `country_code`，行政区和目的地键包含上级键，因此不同国家的同名州、省或城市不会在筛选和统计中合并。`admin_area` 可以为空，以支持城市国家及没有必要记录一级行政区的目的地。

`assets/catalogs/countries.json` 覆盖 ISO 3166-1 的 249 个当前分配代码，包含中英文名称、alpha-2/alpha-3/数字代码、别名和行政区显示规则。运行时不再维护内联国家表。该文件由 `scripts/update-countries.mjs` 从 Unicode CLDR 的固定版本生成，更新时运行 `npm run countries`。

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
- `js/app.js`：页面状态、路由、渲染、事件绑定和筛选逻辑。
- `js/data.js`：数据读取、Markdown 解析和基础安全过滤。
- `js/record-editor.js`：原生 `dialog` 新增表单、能力检测、全部元数据字段、正文视图、草稿导入导出与提交状态。
- `js/draft-archive.mjs`：ZIP 草稿元数据与独立图片文件的打包、读取和旧草稿衔接。
- `js/data-transfer.js`：个人主页全部数据导入导出的浏览器交互。
- `js/data-archive.js`：服务端 `data/` 归档、完整性校验、原子替换和统一数据锁。
- `js/zip-archive.mjs`：浏览器与 Node.js 共用的无依赖 ZIP 存储格式读写和 CRC32 校验。
- `js/slug.mjs`：中文地点、旅行标识和文件名的离线拼音规范化。
- `js/record-input.mjs`：浏览器与 Node.js 共用的草稿字段校验、记录与 Markdown 生成。
- `js/record-suggestions.mjs`：根据国家目录、已填地点和历史记录生成关联候选、可靠的空白字段补全值及旅行标识建议。
- `js/record-store.js`：本机写入端点、请求来源校验、图片文件写入、写入锁、索引替换和失败回滚。
- `js/markdown-editor.js`：源码拆分、预览渲染及可编辑 DOM 到 Markdown 的序列化。
- `js/photo-uploads.mjs`：浏览器与服务器共用的图片签名校验及可读文件命名规则。
- `js/location.mjs`：地点字段兼容、国家规则、层级键、显示名称和搜索字段。
- `assets/catalogs/countries.json`：完整国家/地区目录和行政区显示规则。
- `scripts/update-countries.mjs`：从固定 CLDR 版本重新生成国家目录。
- `js/analytics.mjs`：与 DOM 无关的统计计算，适合单元测试。
- `js/utils.js`：通用格式化与转义工具。
- `js/server.js`：开发服务器。

## 新增记录的数据流

头部和旅行路径页入口打开同一个原生 `dialog`。表单复用本地国家目录和当前内存中的旅行记录：`record-suggestions.mjs` 先按已填国家与行政区过滤 `datalist` 候选，再以历史精确匹配或明确名称后缀补全空白地点字段。补全状态与用户手工编辑状态分开记录，依赖项变化时可以更新旧的自动值，但不会覆盖已手工修改的内容；`trip_id` 只展示建议，由用户确认分组语义。

`GET /api/travel-records` 返回服务标识和进程内写入令牌，前端确认后才启用保存。`POST` 使用 JSON 与 `X-Travel-Token` 提交 v3 草稿，服务端校验字段、国家代码、正文路径及照片引用。`record-input.mjs` 兼容读取 v1 和 v2 草稿，将新增可选字段补齐为空值。

服务端仅允许回环地址连接、localhost / 回环 Host 和同源 Origin（如提供）；写入接口不设置跨域许可，`--network` 的其他设备访问仍只读。表单从非本机站点打开时直接提供只读草稿流程，不向第三方站点发送写入请求。

写入和全量数据导入导出共用项目根目录的 `.travel-data.lock` 独占锁。新增记录会重新读取当前索引，独占创建 Markdown 文件，写入并同步临时索引，最后用 `rename` 替换索引。目录和文件拒绝符号链接 / junction；失败时清理本次创建的正文、照片、空照片目录和临时索引。上传图片写入以目的地拼音命名的照片目录，并在索引提交前完成文件写入和同步；重试时比对照片字节。重复提交以正文路径、元数据和 Markdown 内容比对实现去重，默认正文路径使用日期和目的地拼音。自定义正文路径仍遵守年份目录、日期前缀及 ASCII 文件名规范，照片引用仅允许项目内的普通文件。

Markdown 与 JSON 的写入不构成跨文件事务，进程强制终止或断电可能留下锁、孤立 Markdown 或临时索引，恢复步骤见维护指南。确认写入成功后，页面重新从磁盘读取旅行数据并派生统计；读取失败与写入失败分别提示。

上传请求继续采用 JSON，不引入 multipart 解析依赖。`photo-uploads.mjs` 按文件签名识别 JPEG、PNG、GIF 和 WebP，拒绝 SVG、HTML 等格式；持久化名称由原始文件名转换为拼音，重名时追加递增序号。拼音转换运行文件随仓库分发，许可见根目录 `THIRD_PARTY_NOTICES.md`。

正文预览复用 `js/data.js` 导出的 `parseMarkdown()`，与日记详情使用相同的 HTML 转义和链接过滤规则。源码编辑和预览编辑由 `markdown-editor.js` 负责标题拆分、语法高亮与受限 DOM 序列化；粘贴只接受纯文本。文件写入使用 `buildMarkdown()` 生成正文。新草稿导出为 ZIP，`draft.json` 仅保存字段和照片文件引用，实际图片放在 `photos/`；导入后在内存中恢复为现有写入负载。旧版 v1 至 v3 JSON 草稿继续兼容。

全量数据导出遍历普通文件并把 `data/` 作为 ZIP 根目录；导入拒绝目录穿越、链接语义和索引缺失引用，在项目内临时目录写完后通过 `rename` 替换。失败时保留原目录并清理临时内容。

## 拆分原则

CSS 采用“单入口、多分片”：`index.html` 仍只引用 `journal.css`，分片文件保持在 `css/` 根目录，避免资产相对路径因目录层级变化而失效。继续拆分时遵守以下条件：

- 函数可脱离 DOM 独立测试，例如统计、排序、解析。
- 文件职责能明确命名，且导入顺序不会制造覆盖关系不清的问题。
- 拆分后调用边界更清晰，而不是把同一页面逻辑分散到多个文件。
