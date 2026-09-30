# 资产管理规范

## 目录与用途

`data/` 保存使用者的个人内容，`assets/` 保存共享资源；按用途分类，头像属于个人资料，页面背景属于设计资产。

```text
data/
├── travel_data.json       # 旅行索引
├── travel-diary/YYYY/     # Markdown 正文
├── photos/                # 原始旅行照片
├── videos/                # 原始旅行视频
└── profile/               # profile-picture.png、owner-name.txt
.secrets/
└── auth.json              # 服务端认证哈希
assets/
├── catalogs/              # 国家与中国省市区目录
├── fonts/                 # TTF 源文件及 WOFF2 运行字体
├── images/backgrounds/    # 桌面背景
├── images/pages/          # 封面、纸页及页面图像
└── textures/              # 纸纹等共用材质
```

| 资源 | 用途 |
| --- | --- |
| `body-background-travel-diary.png` | 全局桌面背景。 |
| `leather-mountain-cover.png` | 山景皮革封面位图；标题、封扣和交互由 HTML / CSS 实现。 |
| `home-hero-travel-diary.png`、`left-page-*.png` | 页面主视觉与纸页背景，保留被当前 CSS 引用的文件。 |
| `paper-grain.png` | 共用纸纹。 |
| `data/profile/profile-picture.png` | 个人头像，替换同路径即可更新。 |
| `data/profile/owner-name.txt` | 扉页署名，缺失时回退默认值。 |

## 命名与引用

通用资源使用小写英文、数字和连字符，名字表达用途，同类资源放在同一子目录。日记、媒体路径由编辑器生成，规则见 [内容指南](CONTENT_GUIDE.md#文件路径与媒体)。新增纹理前先检查可否复用现有纸纹。

HTML 和数据路径相对项目根目录；`css/` 下所有分片使用 `../assets/...`。头像入口使用 `data-src` 惰性加载，不要随意改名。运行字体、图片、拼音与目录均保存在本地，不添加运行时 CDN 依赖。

`.secrets/` 不是浏览器资产，不在 HTML、CSS 或前端模块中引用。授权的动态完整备份包含认证哈希，静态发布排除整个目录。个人媒体默认被 Git 忽略，发布前须明确选择文件或由部署流程提供，见 [发布说明](MAINTENANCE.md#静态发布)。

## 字体

当前使用 LXGW WenKai Mono 常规 / Medium 和 Source Code Pro 常规 / Bold。TTF 是生成源文件，页面加载同名 WOFF2；完整 WOFF2 必须纳入版本控制，使新检出可直接离线启动。Pages 发布仅删除 TTF，不删除 WOFF2。

`fonts` 命令默认生成完整压缩字体，需要 Python 与 `fonttools[woff]`，普通启动不需要这些工具。`fonts:subset` 只针对当前项目文字生成子集并保留数字等基础字符；之后新增日记、动态署名或地点可能缺字，采用子集时应重新生成并检查回退。一般内容持续增长的档案使用完整字体。

## 地点目录

| 文件 | 来源与作用 |
| --- | --- |
| `assets/catalogs/countries.json` | ISO alpha-2 范围的 249 项，名称来自固定 Unicode CLDR 48.2.1，含中英文名称、别名和行政区标签。 |
| `assets/catalogs/china-locations.json` | 固定 `cn-division 2026.0.1`，提供大陆 31 个省级行政区及地级、区县候选，用于中国目的地省份反查。 |

生成文件保存来源信息；以各上游项目的授权说明为准。更新脚本仅在维护时联网，单次请求 30 秒超时，普通启动不会拉取上游。复用项目保留完整目录，不按个人旅行范围裁剪，也不在运行时代码另建一份国家表。

## 清理与替换

替换图片后检查屏幕裁切、长宽比和移动端纸页叠层；修改字体后运行生成和测试；调整已带版本参数的资源时同步更新引用。删除前用 `rg` 检查 `index.html`、`css/`、`js/`、`data/` 和测试中的引用；不要仅凭某页肉眼不可见判断资源无用。删除确定未引用的文件后同步文档，不保留重复备用实现，也不增加构建依赖。
