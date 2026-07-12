# 架构说明

## 当前形态

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
       ├─ js/analytics.mjs
       └─ js/utils.js
```

本地开发时，`js/server.js` 只负责静态文件服务和正确的 MIME 类型，不参与浏览器端业务逻辑。

## 数据流

```text
data/travel_data.json
  ↓ loadTravelData()
data/travel-diary/YYYY/*.md
  ↓ loadTravelRecords()
deriveTravelModel()
  ↓
renderCover() / renderLedger() / renderArchive() / renderPlace() / renderEntryRoute()
  ↓
左页与右页 DOM
```

`js/data.js` 会读取每条记录的 `desc_md`，把 Markdown 转成 HTML，并为搜索生成 `searchText`。`js/app.js` 在此基础上派生年份、月份、地点、复访、概览统计和路由状态。

## 路由

项目使用 hash 路由，不依赖服务端路由：

- `#cover`：首页。
- `#ledger`：旅行路径索引。
- `#ledger?year=2026&province=江苏省`：带筛选的旅行路径。
- `#archive`：个人档案。
- `#archive?q=云南`：个人档案搜索。
- `#place?country=中国&province=江苏省&city=苏州市`：地点详情。
- `#entry?id=2026-06-21-suzhou`：日记详情。

新增路由时优先在 `js/app.js` 中补齐四处逻辑：解析、序列化、渲染、交互入口。

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
- `js/analytics.mjs`：与 DOM 无关的统计计算，适合单元测试。
- `js/utils.js`：通用格式化与转义工具。
- `js/server.js`：开发服务器。

## 拆分原则

CSS 采用“单入口、多分片”：`index.html` 仍只引用 `journal.css`，分片文件保持在 `css/` 根目录，避免资产相对路径因目录层级变化而失效。继续拆分时遵守以下条件：

- 函数可脱离 DOM 独立测试，例如统计、排序、解析。
- 文件职责能明确命名，且导入顺序不会制造覆盖关系不清的问题。
- 拆分后调用边界更清晰，而不是把同一页面逻辑分散到多个文件。
