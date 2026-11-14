# Travel Diary

Travel Diary 是一本数字旅行日志。它把每一次出发整理成行程、地点和 Markdown 日记，同时用皮革封面、纸张纹理、书签与翻页动效还原翻阅实体笔记本的感觉。从封面进入后，可以在扉页整理个人资料与旅行记录，在日记目录按笔记或行程浏览，在归档页查看地点统计，也可以在行程摘要和地点档案中回顾沿途记录与照片、视频。

主要特点：

- **像手账一样浏览**：桌面双页与手机连续纸面布局，配合封面开合、纸页翻动、地点档案和行程摘要，让浏览记录更接近翻阅一本旅行笔记。
- **按行程与地点整理**：支持笔记和行程两种目录视图、搜索与多级筛选，并按国家、省市区归档日记、统计到访和汇总媒体。
- **写作与媒体一体化**：Markdown 源码与预览同步编辑，图片和视频可拖放上传、排序、预览与查看，缩略图按需生成并缓存。
- **本地优先，部署灵活**：无需安装前端依赖或连接 CDN；静态托管即可阅读，需要写入、认证、备份和媒体管理时再启动 Node.js 服务。
- **为个人内容保留边界**：访问密码保护写入操作，阅读权限由部署层控制；完整备份、部分导入和回收站为个人数据提供恢复路径。

## 项目依赖

| 依赖 | 是否必需 | 用途与说明 |
| --- | --- | --- |
| 现代浏览器 | 必需 | 浏览页面；需支持 ES modules、Canvas、Cache Storage 等前端能力。 |
| Node.js 20.11 或更新版本 | 本机服务与维护命令必需 | 启动本机服务、执行测试及全部 Node.js 脚本，只使用内置模块。静态托管阅读可直接使用浏览器。 |
| npm | 可选 | 随 Node.js 提供，用于执行下方 `npm` 命令；也可直接用 `node` 运行脚本，无需 `npm install`。 |
| 本机 Edge 或 Chrome | 可选 | 后端按需生成及 `media:previews` 批量生成图片、视频和头像缩略图；可用配置文件、`TRAVEL_BROWSER_PATH` 或批量命令的 `--browser` 指定。后端生成失败时由前端压缩并回传保存，已有缓存直接复用；静态站缺失缓存时由访客浏览器生成。 |
| 网络连接 | 可选 | 仅 `countries` 与 `china-locations` 更新地点目录时需要；其余命令可离线运行。 |

> 项目没有运行时 npm 依赖，也没有 `package-lock.json`、`node_modules` 或前端构建步骤；字体构建工具（HarfBuzz / WOFF2 WASM）、字体、拼音及地点目录随仓库分发。媒体预览不需要 FFmpeg，部署也不需要额外构建工具。

## 启动流程

1. 克隆仓库并进入项目目录。

```bash
git clone https://github.com/Double-Cloth/travel-diary.git
cd travel-diary
```

2. 可选：重新生成字体和媒体缩略图。

```bash
npm run fonts
npm run media:previews
```

3. 启动本机服务。

```bash
npm start
```

## 命令

### 本机配置

项目根目录的 `travel-diary.config.json` 由 Node 服务和批量预览命令共用。支持 JSON Schema 的编辑器会根据文件中的 `$schema` 提供字段补全、中文悬浮说明和取值校验。可以仅保留需要调整的字段，其余字段使用内置默认值。指定 `--dir` 时读取目标目录下的配置，文件缺失时使用默认值。修改后重启服务或重新运行命令。

本机浏览器路径、端口等个人设置建议写入同目录的 `travel-diary.config.local.json`，该文件已被 Git 忽略。无需复制完整配置，只填写要覆盖的字段。例如，将默认浏览器设置为 Edge 的安装目录，并将服务端口设为 8080。

```json
{
  "$schema": "./travel-diary.config.schema.json",
  "server": {
    "port": 8080
  },
  "mediaPreviews": {
    "browserPath": "C:/Program Files (x86)/Microsoft/Edge/Application"
  }
}
```

`browserPath` 也可填写完整可执行文件路径，例如 `C:/Program Files/Google/Chrome/Application/chrome.exe`。Windows 路径可以使用 `/`，使用反斜杠时须在 JSON 中写成 `\\`。配置文件中的相对路径以配置文件所在的项目目录为基准；`--browser` 和 `TRAVEL_BROWSER_PATH` 中的相对路径沿用进程工作目录。

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `server.port` | `9000` | 起始监听端口，范围为 1～65535。 |
| `server.local` | `true` | `true` 绑定 `127.0.0.1`，`false` 绑定 `0.0.0.0` 以允许局域网访问。 |
| `server.maxPortRetries` | `100` | 最多尝试的端口数量，包含起始端口；设为 `1` 时端口占用即报错。 |
| `server.writeMode` | `"local"` | 写入模式，支持 `local`、`remote`。 |
| `server.allowedOrigins` | `[]` | `remote` 模式允许的完整 HTTPS Origin 数组，沿用现有认证及来源校验。 |
| `mediaPreviews.enabled` | `true` | 缓存缺失时是否启动后端浏览器按需生成。关闭后由前端生成并回传，批量预览命令仍可手动运行。 |
| `mediaPreviews.browserPath` | `""` | Edge / Chrome 可执行文件或所在目录。空字符串启用自动查找。 |
| `mediaPreviews.progressTimeoutMs` | `70000` | 浏览器连续未报告生成进度的最长等待时间，单位为毫秒，最小为 1000。 |

服务参数按“命令行参数 → 本机覆盖配置 → 共享配置 → 内置默认值”的顺序取值。配置按字段合并，数组整体替换，`false`、空数组和空字符串都会生效。命令行 `--allowed-origin` 会替换配置文件中的整个来源数组。浏览器路径按“批量命令 `--browser` → 环境变量 `TRAVEL_BROWSER_PATH` → 本机覆盖配置 → 共享配置 → 自动查找”的顺序选择。显式路径无效时会使该次后端生成失败。

修改后可运行检查命令，查看读取的文件、最终生效配置和找到的浏览器路径。

```bash
npm run config:check
npm run config:check -- --dir "项目目录"
# 同时查看临时启动参数的覆盖结果
npm run config:check -- --port 8080 --network
```

检查命令读取配置并查找浏览器。配置错误或显式浏览器路径无效时返回退出码 `1`；自动查找未发现浏览器时给出页面回传提示，检查仍通过。服务启动时仍会检查端口是否可用及 remote 模式所需的认证配置。

自动查找依次检查 Windows 的 `PROGRAMFILES`、`PROGRAMFILES(X86)`、`LOCALAPPDATA` 下的 Edge / Chrome 常见安装位置、macOS 的 `/Applications` 安装位置，以及 `PATH` 中的 Chromium 系浏览器。后端通过独立临时用户目录启动无头浏览器，复用页面的 Canvas 压缩逻辑生成缩略图，任务结束后清理临时目录。

配置格式、字段名或类型错误会给出对应文件路径及错误原因。Node 静态服务禁止下载共享配置及本机覆盖配置，现有 GitHub Pages 发布流程也只复制站点资源。

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

不使用 npm 时，可直接执行 `node js/server.js`，启动参数相同。

### 测试与资源版本

```bash
# 使用 Node.js 内置测试运行器执行全部测试，无需安装测试依赖
npm test
# 只运行指定测试文件，便于定位问题
node --test tests/record-order.test.mjs

# 更新浏览器资源引用的版本参数，避免修改后继续使用旧缓存
npm run assets:version
# 只检查资源版本是否同步，不修改文件
npm run assets:version -- --check
# 只检查日记索引顺序及补丁中的空白错误
npm run data:sort -- --check
git diff --check
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

索引按日期从早到晚排列，同一天保留原有顺序；已排序时保留文件原格式。启动服务时也会执行相同校验与排序。无效日期或索引格式会阻止启动，修正文件后可重新运行。

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

### 发布媒体

`data/photos/` 与 `data/videos/` 默认被 Git 忽略。静态发布需要显式添加要公开的文件：

```bash
git add -f data/photos/照片文件名.jpg data/videos/视频文件名.mp4
git commit -m "发布旅行媒体"
```

### 字体与地点目录

```bash
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

字体构建使用仓库内 WASM，无需安装依赖或联网。

## 文档

全部文档索引见 [项目文档](doc/README.md)。
