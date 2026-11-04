# Travel Diary

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
# 启动服务
npm start
# 等价启动命令
npm run serve

# 指定端口与项目目录
npm start -- --port 8080
npm start -- --dir "项目目录" --port 9000

# 指定监听范围
npm start -- --local
npm start -- --network

# HTTPS 反向代理写入
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com
# 配置多个 HTTPS Origin
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com --allowed-origin=https://notes.example.com

# 查看启动参数
node js/server.js --help
```

### 测试与资源版本

```bash
# 运行全部测试
npm test

# 同步浏览器资源版本
npm run assets:version
# 检查浏览器资源版本
npm run assets:version -- --check

# 检查补丁格式
git diff --check
```

### 认证与备份

```bash
# 交互式重置访问密码
npm run auth:set

# 导出完整备份
npm run data:archive
# 指定备份输出路径
npm run data:archive -- dist/travel-diary-backup.zip
```

### 媒体预览与缓存

```bash
# 批量生成媒体预览
npm run media:previews
# 指定项目目录与浏览器
npm run media:previews -- --dir "项目目录" --browser "浏览器可执行文件路径"
# 查看预览命令参数
npm run media:previews -- --help

# 清理项目缓存
npm run cache:clear
# 指定项目目录
npm run cache:clear -- --dir "项目目录"
# 查看缓存命令参数
npm run cache:clear -- --help
```

### 字体与地点目录

```bash
# 安装字体工具
pip install "fonttools[woff]"
# 生成完整字体和轻量字集
npm run fonts
# 刷新轻量字集
npm run fonts:core
# 生成字体子集
npm run fonts:subset

# 生成国家目录
npm run countries
# 生成中国省市区目录
npm run china-locations
```

### 发布媒体

```bash
# 将指定照片加入 Git 暂存区
git add -f data/photos/suzhou/canal.jpg
# 将指定视频加入 Git 暂存区
git add -f data/videos/suzhou/walk.mp4
```
