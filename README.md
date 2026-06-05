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
node server.js --port 9000
```

默认情况下服务器会从项目根目录提供文件，页面会通过 fetch 加载 `data/travel-diary/` 中的 markdown 文件。

可选参数说明：
- `--port <num>`: 指定监听端口
- `--dir <path>`: 指定要作为静态根的目录
- `--local`: 在某些开发环境下启用本地模式（取决于 server.js 实现）

## 目录结构（主要文件）

- data/travel_data.json — 日志条目元数据
- data/travel-diary/ — 单个日记的 Markdown 文件
- data/photos/ — 日志中引用的图片目录
- css/styles.css — 样式
- js/app.js — 客户端脚本
- server.js — 开发/本地静态服务器

## 添加新日记
1. 在 `data/travel-diary/` 中添加一个新的 Markdown 文件，文件名格式可采用 `YYYY-MM-DD-slug.md`。
2. 在 `data/travel_data.json` 中添加或更新对应的元数据条目（如标题、日期、slug、photo 引用等）。

## 提交与部署建议
- 保留 `data/` 中的 Markdown 与小图（可根据需要把大媒体文件单独托管）。
- 将 `node_modules/` 排除在版本控制之外（已在 .gitignore 中处理）。

## 许可证
见项目顶层 LICENSE 文件。
