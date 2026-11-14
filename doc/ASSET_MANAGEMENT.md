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
.cache/
├── fonts/                 # 自动生成的 WOFF2、字体 CSS 及校验元数据
├── media-previews/        # 自动生成的压缩图片与视频封面
├── media-index.json       # 媒体重复检测指纹
├── backup-state.json      # 最近导出的记录比较基准
└── recycle-bin/           # 可恢复的日记、媒体及整站快照，清理缓存时保留
.secrets/
└── auth.json              # 服务端认证哈希
assets/
├── catalogs/              # 国家与中国省市区目录
├── fonts/                 # TTF 源文件及字体许可证
├── wasm/                  # 字体构建工具的本地 WASM、加载器、来源与许可证
├── images/backgrounds/    # 桌面背景
├── images/pages/          # 封面、纸页及页面图像
└── textures/              # 纸纹等共用材质
```

| 资源 | 用途 |
| --- | --- |
| `body-background-travel-diary.webp` | 全局桌面背景。 |
| `leather-mountain-cover.webp` | 山景皮革封面位图；标题、封扣和交互由 HTML / CSS 实现。 |
| `left-page-ledger-travel-diary.webp` | 目录、地点、日记及附件页的纸面背景，也是基础纸页的默认背景。 |
| `left-page-profile-travel-diary.webp` | 扉页与归档的纸面背景。 |
| `paper-grain.png` | 共用纸纹。 |
| `data/profile/profile-picture.png` | 个人头像，替换同路径即可更新。 |
| `data/profile/owner-name.txt` | 扉页署名，缺失时回退默认值。 |

## 命名与引用

通用资源使用小写英文、数字和连字符，名字表达用途，同类资源放在同一子目录。日记、媒体路径由编辑器生成，规则见 [内容指南](CONTENT_GUIDE.md#文件路径与媒体)。新增纹理前先检查可否复用现有纸纹。

HTML 和数据路径相对项目根目录；`css/` 下图像与纹理引用使用 `../assets/...`，字体样式入口使用 `../.cache/fonts/diary-kai-core.css`。头像入口保留 `data-src`，相框进入可见区域后才读取预览并设置 `src`，不要随意改名；封面位图仅在显示封面时由 CSS 加载。运行字体、图片、拼音与目录均保存在本地，不添加运行时 CDN 依赖。

桌面、封面与纸页图像使用 WebP，保留原始像素尺寸与构图，以质量 85 编码并保留透明通道；四张图像合计约 1.56 MB。共用纸纹及个人头像继续使用 PNG。替换资产时同步所有 CSS 引用，不保留重复的 PNG 备用图。

`.secrets/` 属于本机运行数据，整个目录由 Git 忽略。授权的完整备份包含认证哈希，通过认证 API 下载。个人媒体默认被 Git 忽略，迁移服务时使用完整备份或复制个人数据目录。

## 字体

当前使用 LXGW WenKai Mono 常规 / Medium 和 Source Code Pro 常规 / Bold，扉页印章使用 Cormorant SC Bold。`assets/fonts/` 保留 TTF 源文件与许可证，生成的完整 WOFF2、两种字重的 `*-core.woff2`、`diary-kai-core.css` 和校验元数据统一保存在 `.cache/fonts/`，由 Git 忽略且不进入备份。

印章字体来自 Google Fonts 的 Cormorant SC，采用 SIL Open Font License 1.1，许可保存为 `assets/fonts/CormorantSC-OFL.txt`。

服务与 `fonts` 命令共用字体缓存逻辑。请求只接受预定义字体及 CSS 名称，逐级检查源文件和缓存目录，拒绝符号链接及 junction。源文件、构建逻辑和生成内容通过 SHA-256 校验，轻量字集还校验界面与个人内容。缓存缺失、损坏或输入变化时先生成再响应，有效缓存直接复用，临时文件写入后原子替换。同一字体的并发请求共享任务，服务端使用 Node.js 内置 Worker 压缩字体以保持其他请求可响应，失败后允许重新请求。

字体工具通过 Node.js 内置 API 加载 `assets/wasm/` 的 HarfBuzz 与 WOFF2 WASM，无需安装 npm 依赖、外部命令或联网。字体 CSS 优先声明完整字库，再按实际 cmap 声明轻量字集的 `unicode-range`，轻量字体 URL 带内容哈希。新增文字刷新轻量字集，轻量字集以外的字符按需请求完整字库。拼音字典、全国地点目录、缓存、回收站、日志及测试输出不纳入首屏文字收集。

缺失字体先由服务自动生成。轻量字集生成失败时 CSS 仍声明完整字体，字体请求生成失败后浏览器继续尝试完整 WOFF2、同字重 TTF 源文件，最终使用系统字体。字体 CSS 无法落盘时仍可返回本次生成的样式。源字体本身没有的字符由字体栈继续回退。

`fonts` 补齐完整字体及轻量字集，`fonts:core` 只补齐轻量字集和 CSS。`fonts:subset` 保留显式子集缓存生成能力，运行时完整字体请求会重新生成完整字库。清理缓存后下次访问自动补齐，生成产物无需提交。字体源文件更新后也会触发重建。

字体命令见 [README](../README.md#字体与地点目录)。工具来源、固定版本、许可证与更新方法见 [WASM 说明](../assets/wasm/README.md)。测试覆盖字体轮廓与排版表、字符范围、离线构建及 HTTP 缓存补全和回退。

## 地点目录

| 文件 | 来源与作用 |
| --- | --- |
| `assets/catalogs/countries.json` | ISO alpha-2 范围的 249 项，名称来自固定 Unicode CLDR 48.2.1，含中英文名称、别名和行政区标签。 |
| `assets/catalogs/china-locations.json` | 固定 `cn-division 2026.0.1`，提供大陆 31 个省级行政区及地级、区县候选，用于中国目的地省份反查。 |

生成文件保存来源信息；以各上游项目的授权说明为准。更新脚本仅在维护时联网，单次请求 30 秒超时，普通启动不会拉取上游。复用项目保留完整目录，不按个人旅行范围裁剪，也不在运行时代码另建一份国家表。

重新生成固定版本的目录并校验，命令见 [README](../README.md#字体与地点目录)。

## 清理与替换

替换图片后检查屏幕裁切、长宽比和移动端纸页叠层；修改字体后运行生成和测试；调整已带版本参数的资源时同步更新引用。删除前用 `rg` 检查 `index.html`、`css/`、`js/`、`data/` 和测试中的引用；不要仅凭某页肉眼不可见判断资源无用。删除确定未引用的文件后同步文档，不保留重复备用实现，也不增加构建依赖。

字体源文件、地点目录和个人媒体有运行或维护用途，生成字体缓存可以重建。清理代码时一并检查渲染入口、样式、测试和文档的引用关系，并验证现有日记数据与旧地点字段的读取兼容。

草稿与完整备份统一使用 `js/zip-stream.mjs` 读取旧 ZIP 和 ZIP64；旧 ZIP 生成器仅保留在 `tests/helpers/zip-archive.mjs`，用于兼容性测试，不随前端加载。
