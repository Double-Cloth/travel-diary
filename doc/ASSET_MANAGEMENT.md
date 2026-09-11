# 资产管理规范

## 目录分类

`data/` 保存会因使用者而变化的个人内容，`assets/` 保存可复用的通用资源。判断标准看用途而不是格式：头像属于个人内容，个人主页背景则属于页面设计资源。

```text
data/
├── profile/                 # 头像、个人资料图
├── photos/                  # 旅行照片
├── travel-diary/            # 按年份存放的 Markdown 日记
├── password.json            # 编辑与数据导出的访问密码
└── travel_data.json         # 旅行记录索引

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
| `data/password.json` | 新增记录与全部数据导出共用的访问密码配置。 |
| `assets/fonts/LXGWWenKaiMono-Regular.ttf` | 正文字体常规字重。 |
| `assets/fonts/LXGWWenKaiMono-Medium.ttf` | 正文字体加粗字重。 |
| `assets/fonts/SourceCodePro-Regular.ttf` | 代码和档案编号常规字重。 |
| `assets/fonts/SourceCodePro-Bold.ttf` | 代码和档案编号加粗字重。 |
| `assets/fonts/*.woff2` | 页面实际加载的完整压缩字体，必须随仓库分发以支持离线启动。 |
| `assets/images/backgrounds/body-background-travel-diary.png` | 全局桌面背景。 |
| `assets/images/pages/home-hero-travel-diary.png` | 首页主视觉。 |
| `assets/images/pages/left-page-cover-travel-diary.png` | 首页左页背景。 |
| `assets/images/pages/left-page-ledger-travel-diary.png` | 路径页左页背景。 |
| `assets/images/pages/left-page-profile-travel-diary.png` | 个人档案左页背景。 |
| `data/profile/profile-picture.png` | 书脊头像入口。 |
| `assets/textures/paper-grain.png` | 纸张纹理叠层。 |

## 命名规则

- 通用资产使用小写英文、数字和连字符；自动生成的日记与照片路径也遵循这一规则。
- 文件名包含用途，例如 `body-background-*`、`left-page-*`、`profile-*`。
- 同类资产放在同一子目录，不把页面主视觉直接堆在 `assets/images/` 根目录。
- 新增纹理前先确认是否能复用 `paper-grain.png`。

## 引用规则

- HTML 中从项目根目录引用，例如 `data/profile/profile-picture.png`。
- 个人头像统一使用 `data/profile/profile-picture.png`；替换该文件即可更换头像，无需修改页面代码。
- CSS 分片全部位于 `css/` 根目录，因此统一从 `css/` 目录相对引用，例如 `../assets/images/pages/home-hero-travel-diary.png`。
- 不使用远程字体或远程图片，避免离线和部署环境差异。
- `npm run fonts` 默认生成完整 WOFF2 字体；生成文件不是临时构建产物，更新后必须纳入版本控制。
- `npm run fonts:subset` 仅供明确需要缩减字体体积时使用，会按项目文本生成子集并始终保留数字 `0–9`。

## 清理规则

删除资产前必须至少检查：

```bash
rg -n "file-name.ext" .
```

如果文件只出现在说明文档中，且不再被 `index.html`、`css/`、`js/` 或 `data/` 引用，可以删除；删除后同步更新相关文档和测试。
