# Travel Diary · 旅行档案

一个精心设计的个人旅行日记网站，以 Markdown 为基础内容源，提供时间线、地点地图、个人档案等多维度浏览体验。采用纯静态前端架构，配合轻量级 Node.js 开发服务器，无需外部数据库依赖，可轻松部署到任何支持静态文件服务的平台。

## 核心特性

- **Markdown 驱动内容** — 每条日记对应一个 Markdown 文件，易于版本控制和离线编辑
- **多维浏览模式** — 支持首页概览、旅行时间线、地点档案、个人主页等视图
- **响应式设计** — 完整支持桌面和移动设备，移动端优化的侧栏导航
- **元数据管理** — 集中式 JSON 目录管理日记元信息（日期、地点、标签、封面等）
- **无依赖架构** — 纯 HTML/CSS/JavaScript，客户端渲染，无需构建工具或复杂部署
- **开发友好** — 内置静态服务器，支持自定义端口和监听地址，开箱即用

---

## 快速开始

### 环境要求

- **Node.js** ≥ 14
- **npm** 或 **yarn**（可选，仅需安装依赖时使用）

### 安装与运行

```bash
# 克隆或下载项目
git clone <repository-url>
cd travel-diary

# 安装依赖（当前项目无外部依赖，此步骤仅供参考）
npm install

# 启动开发服务器
npm start

# 或直接指定端口
node js/server.js --port 9000
```

服务器启动后，默认监听 `http://localhost:9000`（或其他指定端口），打开浏览器即可访问。

### 服务器命令行选项

```bash
node js/server.js [options]

选项:
  --port <num>      指定监听端口（默认: 9000）
  --dir <path>      指定静态文件根目录（默认: 项目根目录）
  --local           仅监听本机地址 127.0.0.1（默认行为）
  --network         监听 0.0.0.0，允许局域网访问
```

**示例：**
```bash
# 在局域网上的其他设备可访问（如 192.168.1.100:8080）
node js/server.js --port 8080 --network
```

---

## 项目结构详解

### 核心目录

```
travel-diary/
├── index.html                    # 主 HTML 页面入口
├── package.json                  # 项目配置和脚本定义
├── LICENSE                       # 开源协议
├── README.md                     # 本文件
│
├── data/                         # 数据存储目录
│   ├── travel_data.json          # 日记元数据目录（日期、标题、地点、标签等）
│   ├── travel-diary/             # Markdown 日记文件目录
│   │   ├── 2024-07-08-yuxi.md
│   │   ├── 2024-07-28-chuxiong.md
│   │   └── ...                   # 按日期命名的日记文件
│   └── photos/                   # 日记中引用的图片目录（可选）
│
├── css/                          # 样式表目录
│   ├── base.css                  # 设计变量、全局重置、通用工具类
│   ├── layout.css                # 核心布局、导航栏、页面外壳
│   ├── components.css            # UI 组件样式（按钮、卡片、弹窗、时间线等）
│   ├── journal.css               # 日记内容渲染样式
│   ├── responsive.css            # 响应式规则和断点
│   ├── styles.css                # 主样式入口（兼容旧入口）
│   └── pages/                    # 页面级样式
│       ├── home.css              # 首页特定样式
│       ├── location.css          # 地点详情页样式
│       └── profile.css           # 个人主页样式
│
├── js/                           # JavaScript 脚本目录
│   ├── app.js                    # 应用入口和主初始化流程
│   ├── data.js                   # 数据加载、JSON 解析、Markdown 转 HTML 逻辑
│   ├── navigation.js             # 路由管理、页面切换、移动端侧栏交互
│   ├── views.js                  # 各页面组件渲染函数（首页、时间线、地点、个人页）
│   ├── state.js                  # 全局应用状态管理
│   ├── utils.js                  # 通用工具函数库
│   └── server.js                 # Node.js 开发服务器（支持命令行参数）
│
├── assets/                       # 静态资源目录
│   ├── images/                   # 页面中使用的图标和美图
│   ├── fonts/                    # 自定义字体文件
│   └── textures/                 # 纹理和背景资源
│
└── tmp/                          # 临时文件目录（构建或缓存使用）
```

### 数据文件详解

#### `data/travel_data.json` 结构示例

```json
[
  {
    "id": 1,
    "date": "2024-07-08",
    "title": "玉溪初印象",
    "location": "玉溪",
    "slug": "yuxi",
    "photo": "assets/images/yuxi.jpg",
    "description": "在烟雨中漫步玉溪古城...",
    "tags": ["云南", "古城", "民族风情"]
  },
  ...
]
```

**字段说明：**
| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `id` | number | ✓ | 唯一标识符 |
| `date` | string | ✓ | 日期（YYYY-MM-DD 格式） |
| `title` | string | ✓ | 日记标题 |
| `location` | string | ✓ | 地点名称 |
| `slug` | string | ✓ | URL 友好的标识符（用于路由） |
| `photo` | string | ✓ | 封面图片相对路径 |
| `description` | string | - | 简短描述或摘要 |
| `tags` | string[] | - | 分类标签数组 |

#### Markdown 文件命名规范

推荐使用 `YYYY-MM-DD-slug.md` 格式：

```
data/travel-diary/
├── 2024-07-08-yuxi.md           # 日期-地点缩写
├── 2024-07-28-chuxiong.md
└── 2024-08-12-shanghai.md
```

日记内容采用标准 Markdown 语法，支持 Heading、列表、链接、代码块等，图片使用相对路径引用。

---

## 添加新日记

### 步骤 1：创建 Markdown 文件

在 `data/travel-diary/` 中新建文件，命名格式：`YYYY-MM-DD-location.md`

**示例：** `2024-08-12-shanghai.md`

```markdown
# 魔都三日记

## Day 1: 浦东外滩

从浦东机场出发，沿着黄浦江畔漫步外滩...

### 景点
- 东方明珠电视塔
- 环球金融中心

### 美食推荐
1. 小杨生煎包
2. 鼎泰丰

![上海外滩夜景](../assets/images/shanghai-bund.jpg)

## Day 2: 城隍庙古镇

...
```

### 步骤 2：更新元数据

编辑 `data/travel_data.json`，在数组中添加对应的元数据条目：

```json
{
  "id": 12,
  "date": "2024-08-12",
  "title": "魔都三日记",
  "location": "上海",
  "slug": "shanghai",
  "photo": "assets/images/shanghai-cover.jpg",
  "description": "浦东、外滩、城隍庙的魔都之旅",
  "tags": ["长三角", "现代城市", "美食", "建筑"]
}
```

### 步骤 3：添加封面图片（可选）

如果使用了 Markdown 中的图片引用，确保图片文件存在于 `assets/images/` 目录中。

### 步骤 4：刷新浏览器

页面会自动加载新的日记数据，无需重启服务器。

---

## 样式系统

### 设计变量（`css/base.css`）

项目使用 CSS 自定义属性（CSS Variables）管理全局设计系统：

```css
:root {
  /* 色彩系统 */
  --color-primary: #d8b467;      /* 主品牌色 */
  --color-text: #2b160f;         /* 文字色 */
  --color-bg: #faf8f3;           /* 背景色 */
  
  /* 间距系统 */
  --space-xs: 0.5rem;
  --space-sm: 1rem;
  --space-md: 1.5rem;
  --space-lg: 2rem;
  
  /* 字体系统 */
  --font-serif: 'Georgia', serif;
  --font-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
```

修改这些变量即可全局调整应用外观，无需更改具体组件代码。

### 响应式断点（`css/responsive.css`）

```css
/* 平板设备 */
@media (max-width: 768px) { ... }

/* 手机设备 */
@media (max-width: 480px) { ... }
```

---

## 开发指南

### 项目架构概览

```
用户交互
   ↓
navigation.js (路由管理)
   ↓
views.js (页面渲染)
   ↓
data.js (数据加载)
   ↓
data/travel_data.json + Markdown 文件
```

### 添加新页面

1. 在 `js/views.js` 中新增页面渲染函数
2. 在 `js/navigation.js` 中注册新路由
3. 在 `css/pages/` 中添加页面特定样式
4. 在 `index.html` 中添加导航链接（如需）

### 修改样式

- **全局样式调整** → 编辑 `css/base.css` 中的 CSS 变量
- **组件样式** → 编辑 `css/components.css`
- **页面特定样式** → 编辑 `css/pages/*.css`
- **响应式调整** → 编辑 `css/responsive.css`

**无需构建工具！** 直接修改 CSS 文件，刷新浏览器即可看到效果。

---

## 部署

### 部署为静态网站

由于项目是纯静态前端，可部署到任何静态网站托管平台：

- **GitHub Pages** — 免费，支持自定义域名
- **Netlify** — 自动构建和部署，CDN 加速
- **Vercel** — 针对前端优化，冷启动快
- **阿里云 OSS / 腾讯云 COS** — 国内加速

**部署步骤示例（GitHub Pages）：**

1. 将项目推送到 GitHub 仓库
2. 在仓库设置中启用 GitHub Pages，选择部署源
3. 等待自动部署完成，访问 `https://username.github.io/travel-diary`

### 使用服务器在生产环境部署

若需要 Node.js 服务器支持：

```bash
# 使用 pm2 进程管理
npm install -g pm2
pm2 start js/server.js --name travel-diary -- --port 3000 --network

# 配置反向代理（nginx 示例）
server {
    listen 80;
    server_name your-domain.com;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
}
```

---

## 浏览器兼容性

- Chrome/Edge ≥ 90
- Firefox ≥ 88
- Safari ≥ 14
- 移动浏览器（iOS Safari, Chrome Mobile）

---

## 许可证

本项目遵循 [LICENSE](./LICENSE) 文件中的许可条款发布。

---
