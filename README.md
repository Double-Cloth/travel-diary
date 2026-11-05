# Travel Diary

> 个人旅行日记

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [项目文档](doc/README.md) | 项目概览与阅读导航 |
| [内容维护指南](doc/CONTENT_GUIDE.md) | 日记、行程、媒体、草稿与数据管理 |
| [维护与发布指南](doc/MAINTENANCE.md) | 运行环境、认证、部署、备份恢复与故障处理 |
| [资产管理规范](doc/ASSET_MANAGEMENT.md) | 图片、字体、地点目录与资源维护 |
| [架构说明](doc/ARCHITECTURE.md) | 页面路由、模块职责、数据流与扩展约定 |

## 命令

### 启动服务

```bash
# 启动本机服务，默认地址为 http://localhost:9000，实际以终端输出为准
npm start
# 与 npm start 等价，使用相同的默认配置
npm run serve

# 使用 8080 端口；第二条命令同时指定站点所在的项目目录
npm start -- --port 8080
npm start -- --dir "项目目录" --port 9000

# 仅允许本机连接（默认）
npm start -- --local
# 允许局域网访问页面，远程认证和写入仍默认关闭
npm start -- --network

# 配合 HTTPS 反向代理开放白名单站点写入，需先在本机设置密码
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com
# 重复指定 --allowed-origin，允许多个完整 HTTPS 来源
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com --allowed-origin=https://notes.example.com

# 查看全部启动参数及用法示例
node js/server.js --help
```

### 测试与资源版本

```bash
# 使用 Node.js 内置测试运行器执行全部测试，无需安装测试依赖
npm test

# 更新浏览器资源引用的版本参数，避免修改后继续使用旧缓存
npm run assets:version
# 只检查资源版本是否同步，不修改文件
npm run assets:version -- --check
```

### 认证与备份

```bash
# 按终端提示重置访问密码，适用于配置损坏或需要强制恢复时
npm run auth:set

# 导出 data/ 和认证配置，默认保存到 dist/travel-diary-data.zip
npm run data:archive
# 自定义备份 ZIP 的输出路径，备份内含认证配置，请妥善保管
npm run data:archive -- dist/travel-diary-backup.zip
```

### 日记索引排序

```bash
# 每次手工修改 data/travel_data.json 后检查日期顺序，乱序时自动排序
npm run data:sort
# 提交前只检查；乱序时退出码为 1，不修改文件
npm run data:sort -- --check
```

索引按日期从早到晚排列，同一天保留原有顺序；已排序时保留文件原格式。

### 媒体预览与缓存

```bash
# 调用本机 Edge / Chrome 批量生成图片、视频和头像缩略图，跳过有效缓存
npm run media:previews
# 为指定项目生成预览，并手动指定浏览器可执行文件
npm run media:previews -- --dir "项目目录" --browser "浏览器可执行文件路径"
# 静态发布时跳过未提供的原文件，其他失败仍报错
npm run media:previews -- --skip-missing
# 查看批量预览命令的可用参数和用法
npm run media:previews -- --help

# 清理 .cache/ 中的缓存，保留回收站；缩略图可在下次浏览时自动重建
npm run cache:clear
# 清理指定项目目录下的缓存，保留规则与默认命令相同
npm run cache:clear -- --dir "项目目录"
# 查看缓存清理命令的可用参数和用法
npm run cache:clear -- --help
```

### 字体与地点目录

```bash
# 字体构建仅需 Node.js 20+，使用仓库内 WASM，无需安装依赖或联网
# 生成完整 WOFF2 字体，并按界面与个人内容生成轻量字集
npm run fonts
# 仅刷新轻量字集，适合更新文字后运行，无需重新压缩完整字体
npm run fonts:core
# 将完整字体替换为当前项目文字的子集，后续新增文字可能缺字
npm run fonts:subset

# 从脚本指定版本的数据源生成国家目录，需联网获取数据
npm run countries
# 从脚本指定版本的数据源生成中国省市区目录，需联网获取数据
npm run china-locations
```

不使用 npm 时，可直接执行 `node scripts/build-fonts.mjs`，或附加 `--core` / `--subset`。
字体工具的固定版本、来源和许可证见 [assets/wasm/README.md](assets/wasm/README.md)。
