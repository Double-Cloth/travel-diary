# Travel Diary

> 个人旅行笔记

## 开发与运维常用命令

### 启动与检查

```bash
# 本机启动，默认 http://localhost:9000，以终端实际输出为准
npm start

# 指定端口
npm start -- --port 8080

# 查看服务器参数
node js/server.js --help

# 运行全部测试
npm test

# 检查提交前的空白错误与变更
git diff --check
git status --short
```

### 监听与远程写入

```bash
# 局域网可访问，仍只允许本机写入
npm start -- --network

# HTTPS 反向代理写入；先在本机完成首次设密
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com

# 多个允许来源，逐个指定完整 HTTPS Origin
npm start -- --local --write-mode=remote --allowed-origin=https://diary.example.com --allowed-origin=https://journal.example.com
```

### 备份与密码恢复

```bash
# 导出完整数据与认证配置，默认保存为 dist/travel-diary-data.zip
npm run data:archive

# 指定备份文件
npm run data:archive -- dist/travel-diary-backup.zip

# 仅用于认证配置损坏或强制重置；在交互式终端输入
npm run auth:set
```

### 字体与地点目录维护

```bash
# 安装字体维护工具，仅字体构建需要
pip install "fonttools[woff]"

# 生成完整 WOFF2 字体
npm run fonts

# 按项目现有文字生成字体子集
npm run fonts:subset

# 从固定版本的上游数据重新生成目录，需要联网
npm run countries
npm run china-locations

# 更新后验证
npm test
```

## 项目文档

- [项目文档](doc/README.md)
