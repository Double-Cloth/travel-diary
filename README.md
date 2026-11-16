# Travel Diary

Travel Diary 是一本数字旅行日志。它把每一次出发整理成行程、地点和 Markdown 日记，同时用皮革封面、纸张纹理、书签与翻页动效还原翻阅实体笔记本的感觉。从封面进入后，可以在扉页整理个人资料与旅行记录，在日记目录按笔记或行程浏览，在归档页查看地点统计，也可以在行程摘要和地点档案中回顾沿途记录与照片、视频。

主要特点：

- **像手账一样浏览**：桌面双页与手机连续纸面布局，配合封面开合、纸页翻动、地点档案和行程摘要，让浏览记录更接近翻阅一本旅行笔记。
- **按行程与地点整理**：支持笔记和行程两种目录视图、搜索与多级筛选，并按国家、省市区归档日记、统计到访和汇总媒体。
- **写作与媒体一体化**：Markdown 源码与预览同步编辑，图片和视频可拖放上传、排序、预览与查看，缩略图按需生成并缓存。
- **本地优先**：通过 Node.js 服务浏览和管理手账，无需安装前端依赖或连接 CDN；字体和缩略图按需生成并缓存。
- **为个人内容保留边界**：访问密码保护写入操作，阅读权限由部署层控制；完整备份、部分导入和回收站为个人数据提供恢复路径。

## 目录

- [项目依赖](#项目依赖)
- [Linux 服务器部署](#linux-服务器部署)
  - [在线首次部署](#在线首次部署)
  - [离线首次部署](#离线首次部署)
- [部署脚本使用](#部署脚本使用)
  - [命令速查](#命令速查)
  - [备份与恢复](#备份与恢复)
  - [升级与回滚](#升级与回滚)
- [Docker 中执行 npm 命令](#docker-中执行-npm-命令)
- [Node.js 本机运行与命令](#nodejs-本机运行与命令)
  - [npm 脚本速查](#npm-脚本速查)
- [发布与部署工具](#发布与部署工具)
- [项目目录结构](#项目目录结构)
- [文档](#文档)

## 项目依赖

| 依赖 | 是否必需 | 用途与说明 |
| --- | --- | --- |
| 现代浏览器 | 必需 | 浏览页面；需支持 ES modules、Canvas、Cache Storage 等前端能力。 |
| Node.js（受支持的 LTS 版本） | 本机运行必需 | 启动本机服务、执行测试及全部 Node.js 脚本，只使用内置模块。Docker 部署由镜像提供 Node.js。 |
| Docker Engine 与 Docker Compose 插件 | 服务器部署必需 | 支持 AMD64 / ARM64，可在线拉取镜像或使用完整离线部署包。所需 Compose 能力见部署指南。 |
| npm | 可选 | 随 Node.js 提供，用于执行下方 `npm` 命令；也可直接用 `node` 运行脚本，无需 `npm install`。 |
| Edge、Chrome 或 Chromium | 本机生成缩略图时需要 | 后端按需生成及 `media:previews` 批量生成图片、视频和头像缩略图。可用配置文件、`TRAVEL_BROWSER_PATH` 或批量命令的 `--browser` 指定。Docker 镜像内置 Chromium。后端生成失败时由前端压缩并回传保存，已有缓存直接复用。 |
| 网络连接 | 按部署方式 | 在线部署需要下载镜像并申请证书；离线部署提前取得安装包即可。运行时无需外部服务，更新地点目录时需要联网。 |

> 项目没有运行时 npm 依赖，也没有 `package-lock.json`、`node_modules` 或前端构建步骤；字体构建工具（HarfBuzz / WOFF2 WASM）、字体、拼音及地点目录随仓库分发。媒体预览不需要 FFmpeg，部署也不需要额外构建工具。

## Linux 服务器部署

服务器部署使用 Docker Compose 与 Caddy，支持 AMD64 / ARM64。应用以非 root 用户运行，数据、认证和回收站保存在持久卷中。在线部署包提供配置和管理脚本，完整离线包额外包含应用与 Caddy 镜像。

Docker 默认开启**后端自动生成缩略图**，字体也在首次请求时通过内置 WASM 自动生成。两类缓存分别保存在运行卷的 `.cache/media-previews/` 和 `.cache/fonts/`，重启后继续复用。需要提前生成时，按下方 [Docker 中执行 npm 命令](#docker-中执行-npm-命令) 操作。

共享门户可通过 `TRAVEL_DEPLOYMENT_MODE=portal`、`TRAVEL_BASE_PATH=/diary` 和 `TRAVEL_PUBLIC_ORIGIN=https://example.com:63445` 启用。管理脚本自动叠加 `compose.portal.yaml`，应用加入外部网络，自带 Caddy 保持停用。默认仍为原有 Standalone 根路径部署。首次安装、旧卷迁移、共享 Caddy 示例和回滚命令见 [门户部署指南](doc/PORTAL_DEPLOYMENT.md)。

### 在线首次部署

1. 准备 Docker Engine、Docker Compose 插件、Bash、`flock`、`awk`、`sed`、`grep`、`curl`、`tar` 和 `sha256sum`。Compose 需支持 `--wait`、`--pull never`、`config --format json` 和 `pull_policy`。部署账户应有 Docker 使用权限及部署目录写入权限。
2. 将域名的 A/AAAA 记录指向服务器，开放 TCP 80/443，并确认服务器能够访问 GitHub、GHCR 和证书机构。
3. 从项目 Releases 选择目标 Tag，替换下方的版本占位符，下载、校验并解压部署包。

```bash
version='目标 Release Tag'
mkdir -p /srv/travel-diary
cd /srv/travel-diary
curl -fLO "https://github.com/double-cloth-studio/travel-diary/releases/download/$version/travel-diary-deploy-$version.tar.gz"
curl -fLO "https://github.com/double-cloth-studio/travel-diary/releases/download/$version/travel-diary-deploy-$version.tar.gz.sha256"
sha256sum -c "travel-diary-deploy-$version.tar.gz.sha256"
tar -xzf "travel-diary-deploy-$version.tar.gz"
```

4. 将示例域名替换为自己的域名并初始化，在终端按提示设置六位数字访问密码。

```bash
bash scripts/deploy.sh init diary.example.com
```

`init` 创建 `.env`、准备镜像、初始化空数据并设密。默认 `TRAVEL_WRITE_MODE=local`，远程可只读浏览。需要远程编辑时，在设密后将 `.env` 中该值改为 `remote`。

5. 启动服务并检查状态。

```bash
bash scripts/deploy.sh up
bash scripts/deploy.sh status
bash scripts/deploy.sh doctor
```

浏览 `https://你的域名/`，核对页面、字体和附件，开启 `remote` 后再验证登录与编辑。Caddy 自动申请和续期 HTTPS 证书。已有日记可通过备份迁入，配置、迁移和故障排查见 [服务器部署指南](doc/DEPLOYMENT.md)。

### 离线首次部署

1. 在目标服务器查看 Docker Engine 架构，提前准备 Docker、Compose 及上述 Linux 工具。

```bash
docker version --format '{{.Server.Os}}/{{.Server.Arch}}'
```

2. 在联网机器下载 `travel-diary-offline-linux-<架构>-<Tag>.tar.gz` 和对应的 `.sha256` 文件，架构选择 `amd64` 或 `arm64`。将两个文件传到服务器，在文件所在目录校验并解压。

```bash
archive='下载的离线包文件名.tar.gz'
sha256sum -c "$archive.sha256"
mkdir -p /srv/travel-diary
tar -xzf "$archive" -C /srv/travel-diary
cd /srv/travel-diary
```

3. 准备内网 DNS 或 hosts 映射，放行入口端口，按需要选择一种安装方式。安装器会导入镜像、初始化数据、交互设密并启动服务。

| 入口方式 | 安装命令 | 准备事项 |
| --- | --- | --- |
| 内部 CA 的 HTTPS | `bash install.sh diary.example.com internal` | 放行 TCP 443，安装后导出根证书并加入客户端信任库。 |
| 已有证书的 HTTPS | `bash install.sh diary.example.com certificate` | 放行 TCP 443，预先放入 `deploy/certs/site.crt` 和 `site.key`，客户端需信任签发 CA。 |
| HTTP 浏览 | `bash install.sh 192.168.1.10 http` | 放行 TCP 80，通过该地址只读浏览。 |

内部 CA 模式安装后导出根证书，通过可信渠道分发并导入访问设备的系统或浏览器信任库。

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./travel-diary-root.crt
```

4. 验证 HTTPS 入口与证书信任后，需要远程编辑时将 `.env` 中的 `TRAVEL_WRITE_MODE` 改为 `remote`，再执行以下命令。

```bash
bash scripts/deploy.sh up
bash scripts/deploy.sh doctor
```

安装器将 `TRAVEL_OFFLINE=1` 写入 `.env`，后续部署命令自动使用本地镜像。离线 `doctor` 检查配置、权限、就绪状态与内部代理，客户端需另外验证域名解析、入口访问与证书信任。证书配置和断网演练详见 [离线部署指南](doc/OFFLINE_DEPLOYMENT.md)。

## 部署脚本使用

以下命令在已解压的部署目录执行。`scripts/deploy.sh` 统一管理在线与离线部署，读取 `.env`。修改配置后执行 `up` 使其生效。`install.sh` 用于完整离线包的首次安装，已有部署通过 `up` 启动、`update` 升级。

### 命令速查

| 操作 | 具体命令 | 行为 |
| --- | --- | --- |
| 初始化在线站点 | `bash scripts/deploy.sh init diary.example.com` | 创建配置、准备镜像、初始化空数据并交互设密，再次执行复用已有配置和密码。 |
| 首次安装离线包 | `bash install.sh diary.example.com internal` | 校验及导入镜像后执行离线 `init` 和 `up`，模式还可选 `certificate`、`http`。 |
| 启动或应用配置 | `bash scripts/deploy.sh up` | 检查配置、创建服务并等待就绪。 |
| 停止服务 | `bash scripts/deploy.sh down` | 停止并移除容器，保留数据卷与证书卷。 |
| 查看状态 | `bash scripts/deploy.sh status` | 查看 Compose 服务状态。 |
| 跟踪日志 | `bash scripts/deploy.sh logs` | 显示最近 100 行并持续跟踪，按 Ctrl+C 结束查看。 |
| 部署诊断 | `bash scripts/deploy.sh doctor` | 检查配置、卷权限及就绪状态，在线模式还检查 DNS 与外部 HTTPS。 |
| 创建备份 | `bash scripts/deploy.sh backup` | 停止应用，备份数据、认证与回收站并校验，成功后恢复原先运行状态。 |
| 校验备份 | `bash scripts/deploy.sh verify <备份名称>` | 校验归档长度、SHA-256 和 ZIP CRC。 |
| 恢复备份 | `bash scripts/deploy.sh restore <备份名称>` | 两次交互确认，备份当前状态后恢复日记、密码与回收站。 |
| 在线升级 | `bash scripts/deploy.sh update <Tag或镜像引用>` | 获取目标镜像、备份并更新，成功后保存镜像配置和回滚记录。 |
| 离线升级 | `bash scripts/deploy.sh --offline update --bundle /path/to/new-bundle` | 校验并导入已解压的新离线包，再备份并升级应用。 |
| 镜像回滚 | `bash scripts/deploy.sh rollback` | 备份当前状态并切换到上次更新前保留的本地镜像。 |
| 查看帮助 | `bash scripts/deploy.sh --help`、`bash install.sh --help` | 查看命令和参数。 |

表中的 `<备份名称>`、`<Tag或镜像引用>` 均需替换为实际值。离线模式也可显式写为 `bash scripts/deploy.sh --offline <命令>`，其 `init` 支持在入口地址后指定 `internal`、`certificate` 或 `http` 模式。

### 备份与恢复

```bash
bash scripts/deploy.sh backup
# 填写 backup 输出的 travel-diary-* 目录名，位于 .env 的 BACKUP_DIR 下
backup_name='实际备份目录名'
bash scripts/deploy.sh verify "$backup_name"
# 恢复时先输入完整备份名称，再输入 RESTORE
bash scripts/deploy.sh restore "$backup_name"
```

`BACKUP_DIR` 默认为 `./backups`，备份包含 `data.zip`、`recycle-bin.zip` 和 `manifest.json`，应一起保管。恢复会采用备份中的访问密码，完成后重新登录。备份失败时应用保持停机，修复错误后执行 `up`。备份目录权限、定时备份及恢复失败处理见 [备份与校验](doc/DEPLOYMENT.md#备份与校验) 和 [恢复与回退](doc/DEPLOYMENT.md#恢复与回退)。

### 升级与回滚

在线升级在原部署目录执行，目标 Tag 以项目 Releases 实际发布的版本为准。

```bash
version='目标 Release Tag'
bash scripts/deploy.sh update "$version"
bash scripts/deploy.sh doctor
```

`update` 也接受完整镜像引用或摘要，省略参数时使用当前 `.env` 的 `TRAVEL_IMAGE`。离线升级先将同架构的新包及校验文件传入服务器，解压到独立目录，再回到原部署目录执行升级。

```bash
# 在新包所在目录校验并解压
archive='新下载的离线包文件名.tar.gz'
sha256sum -c "$archive.sha256"
mkdir -p /srv/travel-diary-next
tar -xzf "$archive" -C /srv/travel-diary-next

cd /srv/travel-diary
bash scripts/deploy.sh --offline update --bundle /srv/travel-diary-next
bash scripts/deploy.sh doctor
```

两种升级都会在切换前备份，配置检查或启动失败时自动尝试恢复原镜像。需要主动回滚时执行以下命令。

```bash
bash scripts/deploy.sh rollback
bash scripts/deploy.sh doctor
```

镜像回滚保留当前数据。涉及数据格式变化时，按 Release 兼容性说明选择配套旧镜像并恢复升级前备份。管理脚本与配置文件的更新步骤见 [在线升级](doc/DEPLOYMENT.md#升级) 和 [离线升级和回滚](doc/OFFLINE_DEPLOYMENT.md#离线升级和回滚)。

## Docker 中执行 npm 命令

在部署目录执行以下命令，`app` 服务需已启动。使用 `-w /var/lib/travel-diary` 进入持久卷中的运行目录，脚本会读取实际日记并将生成缓存写入同一运行卷。`exec` 的工作目录选项见 [Docker Compose 文档](https://docs.docker.com/reference/cli/docker/compose/exec/)。

```bash
# 批量生成图片、视频和头像缩略图，有效缓存自动跳过
docker compose exec -w /var/lib/travel-diary app npm run media:previews
# 提前生成完整 WOFF2、轻量字集与字体 CSS
docker compose exec -w /var/lib/travel-diary app npm run fonts
# 仅生成轻量字集，或生成项目文字的完整字体子集
docker compose exec -w /var/lib/travel-diary app npm run fonts:core
docker compose exec -w /var/lib/travel-diary app npm run fonts:subset
# 向 npm 脚本传入参数
docker compose exec -w /var/lib/travel-diary app npm run media:previews -- --help
```

镜像默认工作目录为 `/opt/travel-diary`，启动时将程序与脚本同步到 `/var/lib/travel-diary`。容器内运维命令统一使用上面的 `-w`，以便操作持久化数据和缓存。缩略图与字体默认按需自动生成，批量生成可用于导入后的缓存预热。服务器 `.env` 中的 `TRAVEL_MEDIA_PREVIEWS_ENABLED=false` 可关闭后端自动缩略图生成，修改后执行 `bash scripts/deploy.sh up`。

部署配置与健康状态通过 `bash scripts/deploy.sh doctor` 检查，该入口会补齐容器启动时根据域名计算的远程写入来源。

在非交互脚本中添加 `-T`，交互设密则保留默认终端。

```bash
docker compose exec -T -w /var/lib/travel-diary app npm run media:previews
docker compose exec -w /var/lib/travel-diary app npm run auth:set
```

离线部署在 `docker compose` 后加 `-f compose.yaml -f compose.offline.yaml`，例如以下命令。

```bash
docker compose -f compose.yaml -f compose.offline.yaml exec -w /var/lib/travel-diary app npm run media:previews
```

镜像提供服务运行、认证、数据归档与排序、配置检查、缓存清理、字体和媒体预览脚本。地点目录更新、资源版本同步、测试及发布打包命令在源码仓库执行。部署数据的完整备份与恢复使用 [部署脚本](#备份与恢复)。

## Node.js 本机运行与命令

### 本机启动

克隆仓库后直接启动，无需安装 npm 依赖。

```bash
git clone https://github.com/double-cloth-studio/travel-diary.git
cd travel-diary
npm start
```

打开终端输出的地址，默认 `http://localhost:9000`。端口占用时会尝试后续端口。字体和媒体缩略图在首次访问时按需生成，也可提前执行 `npm run fonts` 和 `npm run media:previews`。

### npm 脚本速查

下表覆盖 `package.json` 中的全部脚本。命令在源码项目根目录执行，`npm run <脚本名> -- <参数>` 将额外参数传入对应的 Node.js 脚本。直接执行右侧命令时将参数追加到命令末尾。

| npm 命令 | 对应 Node.js 命令 | 用途 |
| --- | --- | --- |
| `npm start` / `npm run serve` | `node js/server.js` | 启动服务，两者使用相同默认配置。 |
| `npm run config:check` | `node scripts/check-runtime-config.js` | 校验并显示最终配置，查找可用浏览器。 |
| `npm run auth:set` | `node scripts/set-auth-password.js` | 交互设置或强制重置访问密码。 |
| `npm run data:archive` | `node scripts/build-data-backup.js` | 导出数据与认证配置 ZIP。 |
| `npm run data:sort` | `node scripts/sort-travel-data.js` | 检查并按日期升序整理日记索引。 |
| `npm run media:previews` | `node scripts/build-media-previews.js` | 批量生成图片、视频和头像缩略图。 |
| `npm run cache:clear` | `node scripts/clear-cache.js` | 清理缓存，保留回收站。 |
| `npm run fonts` | `node scripts/build-fonts.mjs` | 补齐完整 WOFF2、轻量字集和字体 CSS。 |
| `npm run fonts:core` | `node scripts/build-fonts.mjs --core` | 仅补齐轻量字集和字体 CSS。 |
| `npm run fonts:subset` | `node scripts/build-fonts.mjs --subset` | 生成项目文字的完整子集缓存。 |
| `npm run countries` | `node scripts/update-countries.mjs` | 联网更新国家目录。 |
| `npm run china-locations` | `node scripts/update-china-locations.mjs` | 联网更新中国省市区目录。 |
| `npm run assets:version` | `node scripts/sync-asset-versions.js` | 同步浏览器资源引用的版本参数。 |
| `npm test` | `node --test tests/*.test.mjs` | 执行全部 Node.js 测试。 |
| `npm run test:deployment` | `node scripts/test-deployment.mjs` | 使用虚拟数据执行 Docker 部署演练，需先准备验证镜像。 |

### 本机配置

编辑根目录的 `travel-diary.config.json` 调整服务和媒体预览配置。个人设置写入同目录的 `travel-diary.config.local.json`（已被 Git 忽略），只填写需要覆盖的字段。例如，将端口改为 8080，并指定本机浏览器。

```json
{
  "$schema": "./travel-diary.config.schema.json",
  "server": {
    "port": 8080
  },
  "mediaPreviews": {
    "browserPath": "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
  }
}
```

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `$schema` | `"./travel-diary.config.schema.json"` | 为编辑器提供配置补全与校验。 |
| `server.port` | `9000` | 起始监听端口，范围为 1～65535。 |
| `server.local` | `true` | `true` 绑定 `127.0.0.1`，`false` 绑定 `0.0.0.0` 以允许局域网访问。 |
| `server.maxPortRetries` | `100` | 最多尝试的端口数量，范围为 1～65535，包含起始端口。设为 `1` 时端口占用即报错。 |
| `server.writeMode` | `"local"` | `local` 仅允许本机认证与写入。`remote` 允许白名单 HTTPS 来源认证与写入，需配置 `allowedOrigins` 并预先在本机设置密码。 |
| `server.allowedOrigins` | `[]` | `remote` 模式必填的完整 HTTPS Origin 数组，例如 `["https://diary.example.com"]`。`local` 模式保持空数组。 |
| `mediaPreviews.enabled` | `true` | 缓存缺失时是否启动后端浏览器按需生成。关闭后由前端生成并回传，批量预览命令仍可手动运行。 |
| `mediaPreviews.browserPath` | `""` | Edge / Chrome 可执行文件或所在目录。空字符串启用自动查找。 |
| `mediaPreviews.progressTimeoutMs` | `70000` | 浏览器连续未报告生成进度的最长等待时间，单位为毫秒，范围为 1000～2147483647。默认 70 秒。 |

保存后检查生效配置，再重启服务或重新运行批量预览命令。使用 `--dir` 时，编辑对应项目目录下的配置文件。

```bash
npm run config:check
# 检查指定项目的配置
npm run config:check -- --dir "项目目录"
# 查看临时启动参数的覆盖结果
npm run config:check -- --port 8080 --network
```

配置覆盖顺序及路径规则见 [维护指南的本机配置](doc/MAINTENANCE.md#本机配置)。

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
# 检查补丁中的空白错误
git diff --check
```

### 认证与备份

```bash
# 按终端提示重置访问密码，适用于配置损坏或需要强制恢复时
npm run auth:set
# 为指定项目目录设置密码
npm run auth:set -- --dir "项目目录"

# 导出 data/ 和认证配置，默认保存到 dist/travel-diary-data.zip
npm run data:archive
# 自定义备份 ZIP 的输出路径，备份内含认证配置，请妥善保管
npm run data:archive -- dist/travel-diary-backup.zip
```

`data:archive` 导出源码项目目录下的 `data/` 和认证配置，输出路径须以 `.zip` 结尾，并位于 `data/`、`.secrets/` 和 `.cache/` 之外。服务器容器中的运行数据使用上方 `deploy.sh backup` 备份，该命令还保存回收站。迁移和停机恢复可使用下方的 `deployment-backup.js`。

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
# 批量处理时跳过缺失的原文件，其他失败仍报错
npm run media:previews -- --skip-missing
# 查看批量预览命令的可用参数和用法
npm run media:previews -- --help

# 清理 .cache/ 中的缓存，保留回收站；字体和缩略图在下次访问时自动重建
npm run cache:clear
# 清理指定项目目录下的缓存，保留规则与默认命令相同
npm run cache:clear -- --dir "项目目录"
# 查看缓存清理命令的可用参数和用法
npm run cache:clear -- --help
```

### 字体与地点目录

```bash
# 在 .cache/fonts/ 中补齐完整 WOFF2、轻量字集与字体 CSS，有效缓存直接复用
npm run fonts
# 仅补齐轻量字集与字体 CSS，界面或个人文字变化后自动刷新
npm run fonts:core
# 生成项目文字的完整子集缓存；运行时会恢复完整字库以覆盖新增字符
npm run fonts:subset

# 从脚本指定版本的数据源生成国家目录，需联网获取数据
npm run countries
# 从脚本指定版本的数据源生成中国省市区目录，需联网获取数据
npm run china-locations
```

字体命令启动时显示任务总数，每完成一个字体或 CSS 文件便输出当前进度、文件路径及「已生成」或「缓存有效」状态。

字体构建、缓存与文件存放约定见 [资产管理规范](doc/ASSET_MANAGEMENT.md#字体)。

## 发布与部署工具

### Release 与镜像发布

维护者先提交并推送全部修改，确认 `package.json` 版本，再通过 GitHub 页面或 `gh release create` 发布同名 Release，Tag 可带 `v` 前缀。以下命令在 Bash 中执行，发布说明保存到 `release-notes.md`。

```bash
version="v$(node -p "require('./package.json').version")"
gh release create "$version" --target main --title "$version" --notes-file release-notes.md
gh run list --workflow release.yml
# 将占位符替换为实际运行编号
gh run watch <运行编号> --exit-status
```

Actions 在 AMD64 / ARM64 上执行测试，发布 GHCR 多架构镜像、在线部署包及带 SHA-256 校验的离线包；离线包上传前还会执行断网安装与升级演练。稳定版本同时更新 `latest`，预发布只发布自身标签。首次包设置和失败重试见 [Release 与 GHCR 发布](doc/DEPLOYMENT.md#release-与-ghcr-发布)。

### 部署包生成与验证

以下工具通过 `node` 直接运行。打包命令在源码根目录执行，默认将压缩包及 `.sha256` 文件写入 `dist/`。

```bash
# 生成在线部署包，--tag 与 --image 必填
version='目标 Release Tag'
node scripts/package-deployment.mjs --tag "$version" --image "ghcr.io/double-cloth-studio/travel-diary:$version"

# 生成当前 Docker Engine 架构对应的完整离线包，自动拉取镜像
node scripts/package-deployment.mjs --offline --tag "$version" --image "ghcr.io/double-cloth-studio/travel-diary:$version"
```

`--source <镜像引用或摘要>` 可指定实际导出的镜像来源并写入 `IMAGE.txt`，`--caddy <镜像引用>` 指定 Caddy，默认 `caddy:2-alpine`，`--output <目录>` 修改输出位置。离线打包加 `--local` 时复用已存在的本地镜像，镜像架构须与 Docker Engine 一致。打包需要 `tar`，离线打包还需 Docker。

```bash
# 构建验证镜像，再运行在线部署演练
docker build -t travel-diary:verification .
npm run test:deployment
# 等价入口
# node scripts/test-deployment.mjs

# 准备 Caddy 和隔离测试工具镜像，打包本地镜像
docker pull caddy:2-alpine
docker build -f tests/fixtures/Dockerfile.offline -t travel-diary:offline-test-tools .
node scripts/package-deployment.mjs --offline --local --tag verification --image travel-diary:verification
# 替换为实际生成的 amd64 或 arm64 包名，旁边需有同名 .sha256 文件
node scripts/test-offline-deployment.mjs dist/实际生成的离线包文件名.tar.gz
```

容器演练使用虚拟数据和独立测试项目，验证持久化、认证、编辑、备份恢复、升级及失败回退。离线演练需要 Docker privileged 容器支持。覆盖范围和环境要求见 [本地验证](doc/DEPLOYMENT.md#本地验证) 与 [断网演练](doc/OFFLINE_DEPLOYMENT.md#断网演练)。

### 原生运行目录的运维备份

`scripts/deployment-backup.js` 可在原机器生成包含数据、认证和回收站的迁移包，也供部署脚本在维护容器中调用。执行 `backup` 或 `restore` 前停止目标运行目录的全部服务，输出目录使用运行目录之外的新目录。

```bash
node scripts/deployment-backup.js backup "/path/to/travel-diary" "/secure/travel-diary-migration"
node scripts/deployment-backup.js verify "/secure/travel-diary-migration"
# 恢复会替换数据、密码和回收站，最后一个目录保存恢复前备份
node scripts/deployment-backup.js restore "/path/to/travel-diary" "/secure/travel-diary-migration" "/secure/travel-diary-before-restore" --confirm
```

备份要求运行目录中已有有效密码。恢复后启动服务并核对内容、附件和登录。迁入 Docker 部署的步骤见 [迁移已有日记](doc/DEPLOYMENT.md#迁移已有日记)。

### 内部辅助脚本

| 文件 | 调用入口与职责 |
| --- | --- |
| `scripts/offline-images.sh` | 由 `scripts/deploy.sh` 加载，校验离线包、架构和镜像 ID，并导入镜像。 |
| `scripts/font-tools.mjs` | 由字体构建逻辑导入，封装 HarfBuzz / WOFF2 WASM。 |
| `scripts/media-preview-batch.mjs` | 由 `npm run media:previews` 启动的浏览器页面加载，执行媒体压缩及进度回传。 |
| `deploy/entrypoint.sh` | 由 Docker 容器启动时自动执行，同步运行目录、设置服务参数并启动 Node.js。 |

## 项目目录结构

```text
travel-diary/
├── index.html                 # 页面入口
├── js/                        # 前端、Node.js 服务与共用模块
├── css/                       # 页面样式
├── assets/                    # 公共图片、字体源文件、地点目录与 WASM
├── data/                      # 个人资料、Markdown 日记、图片与视频
├── scripts/                   # npm 脚本、部署管理、发布打包与验证工具
├── deploy/                    # 容器入口、Caddy 模板与证书目录
├── doc/                       # 架构、维护、部署与资源管理文档
├── tests/                     # 测试、辅助工具与虚拟数据
├── .github/workflows/         # 持续集成与 Release 工作流
├── .cache/                    # 自动生成的字体、媒体缓存与回收站
├── .secrets/                  # 本机访问密码配置
├── dist/                      # 部署包输出
├── Dockerfile                 # 应用镜像，包含 Node.js 与 Chromium
├── compose*.yaml              # 在线、源码构建与离线部署配置
├── install.sh                 # 完整离线包安装入口
├── package.json               # npm 命令入口
└── travel-diary.config*.json   # 共享配置、配置结构与本机覆盖配置
```

`.cache/`、`.secrets/` 和 `dist/` 按运行或打包需要生成，均已加入 Git 忽略规则。`data/` 保存个人内容，`assets/` 保存通用资源，`scripts/` 与 `deploy/` 分别承载命令工具和部署配置。Docker 中的运行代码、个人数据、认证和缓存统一位于 `/var/lib/travel-diary`，部署包中的 `scripts/` 只包含服务器管理工具，日常 npm 命令在应用容器内执行。

## 文档

全部文档索引见 [项目文档](doc/README.md)。
