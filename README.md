# Travel Diary · 旅行档案

一个纯静态个人旅行日记网站。内容来自 `data/travel_data.json` 和 Markdown 日记文件，前端用原生 HTML/CSS/JavaScript 渲染成带纸质档案感的旅行首页、路径索引、地点详情和个人档案页。

## 快速开始

环境要求：

- Node.js 14 或更高版本
- npm

常用命令：

```bash
npm install
npm start
npm test
```

开发服务器默认运行在 [http://localhost:9000](http://localhost:9000)。如需指定端口：

```bash
node js/server.js --port 8080
```

允许局域网设备访问：

```bash
node js/server.js --port 8080 --network
```

## 项目结构

```text
travel-diary/
├── index.html                  # 页面入口，只加载 journal.css 和 app.js
├── css/
│   ├── journal.css             # 样式入口，维护 @import 顺序
│   ├── 01-foundation.css       # 字体、变量、全局 reset 与 body 背景
│   ├── 02-shell.css            # 书脊导航、双页外壳和通用纸页
│   ├── 03-cover-route.css      # 首页、路线插图和通用按钮
│   ├── 04-ledger.css           # 路径索引、筛选、记录卡片和概览模块
│   ├── 05-archive-place.css    # 个人档案、地点详情和行李牌
│   ├── 06-entry-sheet.css      # 日记弹层、Markdown 正文和翻页动画
│   └── 07-responsive.css       # 响应式与动效降级规则
├── js/
│   ├── app.js                  # 路由、页面渲染和交互入口
│   ├── data.js                 # JSON 与 Markdown 数据加载
│   ├── analytics.mjs           # 可测试的旅行统计函数
│   ├── utils.js                # HTML 转义、标题和日期格式工具
│   └── server.js               # 本地静态服务器
├── data/
│   ├── travel_data.json        # 日记索引与元数据
│   └── travel-diary/           # Markdown 日记正文
├── assets/
│   ├── fonts/                  # 本地字体
│   ├── images/
│   │   ├── backgrounds/        # 全局背景图
│   │   ├── pages/              # 纸页和首页视觉图
│   │   └── profile/            # 头像等个人资料图
│   └── textures/               # 纸张纹理
├── tests/                      # Node 内置测试
└── docs/                       # 项目维护文档
```

## 核心能力

- `#cover` 首页：展示最近旅行、路径票据和旅行档案入口。
- `#ledger` 旅行路径：按年份、月份、省份、城市、照片、笔记和关键字筛选。
- `#archive` 个人档案：聚合国家、省份、城市、复访地点和活跃周期统计。
- `#place?...` 地点页：按国家、省份和城市查看关联日记。
- `#entry?...` 日记页：打开指定 Markdown 日记内容。

## 内容维护

添加一篇日记通常需要两步：

1. 在 `data/travel-diary/` 新建 Markdown 文件，推荐命名为 `YYYY-MM-DD-slug.md`。
2. 在 `data/travel_data.json` 增加对应记录。

最小记录示例：

```json
{
  "date": "2026-07-11",
  "country": "中国",
  "province": "江苏省",
  "city": "苏州市",
  "desc_md": "data/travel-diary/2026-07-11-suzhou.md",
  "photo_folder": "data/photos/suzhou",
  "photos": []
}
```

更完整的字段说明、图片规则和 Markdown 写法见 [内容维护指南](docs/CONTENT_GUIDE.md)。

## 开发约定

- 当前运行时入口保持简单：`index.html` -> `css/journal.css` + `js/app.js`，其中 `journal.css` 只负责导入分层样式。
- 不需要构建步骤，修改后刷新浏览器即可。
- 与 DOM 无关的统计逻辑放在 `js/analytics.mjs`，并用 `tests/analytics.test.mjs` 覆盖。
- 页面结构、路由和交互集中在 `js/app.js`；只有确实降低复杂度时才拆分新模块。
- 资产必须按用途放入 `assets/` 的现有分类目录。

更多说明：

- [文档索引](docs/README.md)
- [架构说明](docs/ARCHITECTURE.md)
- [资产管理规范](docs/ASSET_MANAGEMENT.md)
- [维护与发布指南](docs/MAINTENANCE.md)

## 测试

```bash
npm test
```

测试覆盖两类内容：

- `tests/analytics.test.mjs`：验证旅行统计函数。
- `tests/shell.test.mjs`：验证关键页面结构、样式约束和服务器 MIME 类型。

## 部署

项目是静态站点，可直接部署到 GitHub Pages、Netlify、Vercel、对象存储或任意静态文件服务。生产环境如需使用内置服务器：

```bash
node js/server.js --port 3000 --network
```

## 许可证

本项目遵循 [LICENSE](LICENSE) 中的许可条款。
