# travel-diary

A simple personal travel diary static site that serves markdown entries from the `data/travel-diary/` folder.

**Features**
- Markdown-based diary entries under data/travel-diary/
- Metadata catalog in data/travel_data.json
- Lightweight Node static server (server.js)

## 先决条件
- Node.js >= 14
- npm 或 yarn

## 安装

```bash
npm install
```

## 本地运行

使用项目内的轻量服务器启动静态站点：

```bash
npm start
# 或者直接：
node js/server.js --port 9000
```

默认情况下服务器会从项目根目录提供文件，页面会通过 fetch 加载 `data/travel-diary/` 中的 markdown 文件。

可选参数说明：
- `--port <num>`: 指定监听端口
- `--dir <path>`: 指定要作为静态根的目录
- `--local`: 仅监听本机地址 `127.0.0.1`（默认）
- `--network`: 监听 `0.0.0.0`，用于局域网访问

## 目录结构（主要文件）

- data/travel_data.json — 日志条目元数据
- data/travel-diary/ — 单个日记的 Markdown 文件
- data/photos/ — 日志中引用的图片目录
- css/base.css — 设计变量、全局重置和通用工具类
- css/layout.css — 导航、页面外壳、页头和主布局
- css/components.css — 按钮、输入框、统计卡片、时间线卡片、弹窗等组件
- css/pages/ — 页面级样式，如主页、地点页和个人页
- css/responsive.css — 响应式规则
- css/styles.css — 兼容旧入口的样式索引文件
- js/app.js — 客户端入口和初始化流程
- js/data.js — 数据加载与 Markdown 解析
- js/navigation.js — 页面切换和移动端侧栏交互
- js/views.js — 首页、时间线、地点页和个人页渲染
- js/state.js / js/utils.js — 共享状态和通用工具
- js/server.js — 开发/本地静态服务器

## 添加新日记
1. 在 `data/travel-diary/` 中添加一个新的 Markdown 文件，文件名格式可采用 `YYYY-MM-DD-slug.md`。
2. 在 `data/travel_data.json` 中添加或更新对应的元数据条目（如标题、日期、slug、photo 引用等）。

## 许可证
见项目顶层 LICENSE 文件。
