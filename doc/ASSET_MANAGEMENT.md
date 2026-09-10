# 资产管理规范

## 目录分类

`data/` 集中保存每位使用者自己的内容，`assets/` 保存可供不同使用者复用的通用资源。头像属于个人内容；个人档案页的背景图属于页面设计素材。

```text
data/
├── profile/                # 头像、个人资料图
├── photos/                 # 旅行照片
├── travel-diary/            # 按年份存放的个人日记
└── travel_data.json         # 个人旅行记录元数据

assets/
├── catalogs/               # 通用参考目录，如 countries.json
├── fonts/                  # 本地字体文件
├── images/
│   ├── backgrounds/        # 全局背景图
│   └── pages/              # 纸页、首页和页面主视觉
└── textures/               # 可复用纹理
```

## 当前资产

| 路径 | 用途 |
| --- | --- |
| `assets/catalogs/countries.json` | 通用国家/地区目录，由 `npm run countries` 更新。 |
| `assets/fonts/LXGWWenKaiMono-Regular.ttf` | 正文字体常规字重。 |
| `assets/fonts/LXGWWenKaiMono-Medium.ttf` | 正文字体加粗字重。 |
| `assets/fonts/SourceCodePro-Regular.ttf` | 代码和档案编号常规字重。 |
| `assets/fonts/SourceCodePro-Bold.ttf` | 代码和档案编号加粗字重。 |
| `assets/fonts/*-subset.woff2` | 页面实际加载的压缩字体，必须随仓库分发以支持离线启动。 |
| `assets/images/backgrounds/body-background-travel-diary.png` | 全局桌面背景。 |
| `assets/images/pages/home-hero-travel-diary.png` | 首页主视觉。 |
| `assets/images/pages/left-page-cover-travel-diary.png` | 首页左页背景。 |
| `assets/images/pages/left-page-ledger-travel-diary.png` | 路径页左页背景。 |
| `assets/images/pages/left-page-profile-travel-diary.png` | 个人档案左页背景。 |
| `data/profile/profile-picture.png` | 书脊头像入口。 |
| `assets/textures/paper-grain.png` | 纸张纹理叠层。 |

## 命名规则

- 使用小写英文、数字和连字符。
- 文件名包含用途，例如 `body-background-*`、`left-page-*`、`profile-*`。
- 同类资产放在同一子目录，不把页面主视觉直接堆在 `assets/images/` 根目录。
- 新增纹理前先确认是否能复用 `paper-grain.png`。

## 引用规则

- HTML 中从项目根目录引用，例如 `data/profile/profile-picture.png`。
- 个人头像统一使用 `data/profile/profile-picture.png`；替换该文件即可更换头像，无需修改页面代码。
- CSS 分片全部位于 `css/` 根目录，因此统一从 `css/` 目录相对引用，例如 `../assets/images/pages/home-hero-travel-diary.png`。
- 不使用远程字体或远程图片，避免离线和部署环境差异。
- `npm run fonts` 生成的 `*-subset.woff2` 不是临时构建产物，更新后必须纳入版本控制。
- 字体子集始终保留数字 `0–9`，不依赖生成时的页面内容，保证运行时更新的日期正常显示。

## 清理规则

删除资产前必须至少检查：

```bash
rg -n "file-name.ext" .
```

如果只出现在历史计划或说明文档中，但不再被 `index.html`、`css/*.css`、`js/*.js` 或数据文件引用，可以删除或在文档中说明为历史记录。
