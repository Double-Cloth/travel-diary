# Travel Diary

个人旅行笔记。使用 Node.js 20 或更新版本，无需安装 npm 依赖。运行机制、内容维护和恢复流程见 [文档索引](doc/README.md)。

## 启动与检查

```bash
# 本机启动，默认 http://localhost:9000；端口以终端输出为准
npm start
# 等价启动命令
npm run serve

# 指定端口或查看全部参数
npm start -- --port 8080
npm start -- --dir "项目目录" --port 9000
node js/server.js --help

# 运行全部测试
npm test

# 修改 package.json 版本后，同步浏览器资源版本
npm run assets:version

# 检查资源版本与补丁格式
npm run assets:version -- --check
git diff --check
```

## 部署与备份

```bash
# 允许局域网浏览，写入仍限本机
npm start -- --network

# HTTPS 反向代理写入；先在本机完成首次设密
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com
# 多个来源重复指定完整 HTTPS Origin
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com --allowed-origin=https://notes.example.com

# 导出完整数据与认证配置，默认保存到 dist/travel-diary-data.zip
npm run data:archive
npm run data:archive -- dist/travel-diary-backup.zip

# 仅在认证配置损坏或强制重置密码时使用
npm run auth:set
```

认证配置保存在本机 `.secrets/`，不纳入 Git；命令行备份必须为 `.zip`，且保存到 `data/`、`.secrets/` 和 `.cache/` 之外。网页备份导出需要动态服务和认证；静态页面禁止全部、部分记录及行程备份导出。恢复步骤见 [备份与恢复](doc/MAINTENANCE.md#备份与恢复)。

GitHub Pages 在 push 或手动触发工作流后自动构建、测试与发布。媒体默认被 Git 忽略；需要发布的文件应明确选择并与对应索引、正文一起提交：

```bash
git add -f data/photos/suzhou/canal.jpg
# 视频同样按实际文件路径选择
git add -f data/videos/suzhou/walk.mp4
```

部署范围、代理配置和发布检查见 [维护指南](doc/MAINTENANCE.md#静态发布)。

## 媒体预览与缓存

```bash
# 使用本机已有的 Edge / Chrome 批量生成预览，无需先启动服务
npm run media:previews
npm run media:previews -- --dir "项目目录" --browser "浏览器可执行文件路径"
npm run media:previews -- --help

# 清理缓存，保留 .cache/recycle-bin 回收站
npm run cache:clear
npm run cache:clear -- --dir "项目目录"
npm run cache:clear -- --help
```

也可通过环境变量 `TRAVEL_BROWSER_PATH` 指定浏览器。缓存会在浏览时自动重建，批量生成仅用于提前准备；清理前建议停止批量任务并关闭站点页面。行为与限制见 [媒体预览](doc/MAINTENANCE.md#媒体预览)。

## 字体与地点目录

只有字体维护需要 Python 和字体工具，普通启动不需要：

```bash
pip install "fonttools[woff]"
# 完整字体和轻量字集
npm run fonts
# 仅刷新界面与个人内容的轻量字集
npm run fonts:core
# 显式将完整字体替换为当前内容的子集，后续新增字符可能缺字
npm run fonts:subset

# 根据脚本中固定的上游版本重新生成地点目录（需要联网）
npm run countries
npm run china-locations
```

字体生成后同步资源版本并提交生成文件；目录更新后核对名称、代码和数量。来源、字体模式与资产规则见 [资产管理规范](doc/ASSET_MANAGEMENT.md)。
