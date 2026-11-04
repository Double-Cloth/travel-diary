# Travel Diary

个人旅行笔记。运行环境与维护说明见 [运维文档](doc/MAINTENANCE.md)，其他说明见 [文档索引](doc/README.md)。

## 启动与检查

使用 Node.js 20 或更新版本，无需安装 npm 依赖。

```bash
# 本机启动，默认 http://localhost:9000；端口以终端输出为准
npm start

# 指定端口或查看全部参数
npm start -- --port 8080
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

# 导出完整数据与认证配置，默认保存到 dist/travel-diary-data.zip
npm run data:archive
npm run data:archive -- dist/travel-diary-backup.zip

# 仅在认证配置损坏或强制重置密码时使用
npm run auth:set

# 生成媒体预览，或清缓存（保留回收站）
npm run media:previews
npm run cache:clear
```

认证配置保存在本机 `.secrets/`，不纳入 Git；备份应保存到 `data/`、`.secrets/` 和 `.cache/` 之外。详细的 [部署与恢复流程](doc/MAINTENANCE.md)、[字体与地点目录维护命令](doc/ASSET_MANAGEMENT.md) 均放在 `doc/`。
