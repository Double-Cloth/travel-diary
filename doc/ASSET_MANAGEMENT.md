# 资产管理规范

## 目录分类

```text
assets/
├── fonts/                  # 本地字体文件
├── images/
│   ├── backgrounds/        # 全局背景图
│   ├── pages/              # 纸页、首页和页面主视觉
│   └── profile/            # 头像、个人资料图
└── textures/               # 可复用纹理
```

## 当前资产

| 路径 | 用途 |
| --- | --- |
| `assets/fonts/LXGWWenKaiMono-Regular.ttf` | 正文字体常规字重。 |
| `assets/fonts/LXGWWenKaiMono-Medium.ttf` | 正文字体加粗字重。 |
| `assets/fonts/SourceCodePro-Regular.ttf` | 代码和档案编号常规字重。 |
| `assets/fonts/SourceCodePro-Bold.ttf` | 代码和档案编号加粗字重。 |
| `assets/images/backgrounds/body-background-travel-diary.png` | 全局桌面背景。 |
| `assets/images/pages/home-hero-travel-diary.png` | 首页主视觉。 |
| `assets/images/pages/left-page-cover-travel-diary.png` | 首页左页背景。 |
| `assets/images/pages/left-page-ledger-travel-diary.png` | 路径页左页背景。 |
| `assets/images/pages/left-page-profile-travel-diary.png` | 个人档案左页背景。 |
| `assets/images/profile/profile-picture.png` | 书脊头像入口。 |
| `assets/textures/paper-grain.png` | 纸张纹理叠层。 |

## 命名规则

- 使用小写英文、数字和连字符。
- 文件名包含用途，例如 `body-background-*`、`left-page-*`、`profile-*`。
- 同类资产放在同一子目录，不把页面主视觉直接堆在 `assets/images/` 根目录。
- 新增纹理前先确认是否能复用 `paper-grain.png`。

## 引用规则

- HTML 中从项目根目录引用，例如 `assets/images/profile/profile-picture.png`。
- CSS 分片全部位于 `css/` 根目录，因此统一从 `css/` 目录相对引用，例如 `../assets/images/pages/home-hero-travel-diary.png`。
- 不使用远程字体或远程图片，避免离线和部署环境差异。

## 清理规则

删除资产前必须至少检查：

```bash
rg -n "file-name.ext" .
```

如果只出现在历史计划或说明文档中，但不再被 `index.html`、`css/*.css`、`js/*.js` 或数据文件引用，可以删除或在文档中说明为历史记录。
