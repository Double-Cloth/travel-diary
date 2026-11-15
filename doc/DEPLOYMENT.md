# Linux 服务器部署

## 支持环境

标准方案使用 Docker Engine、Docker Compose 2.24.4 或更新版本、Bash、`flock`、`awk`、`curl`、`tar`、`sha256sum` 和 Caddy。服务器直接拉取公共镜像 `ghcr.io/double-cloth/travel-diary`，支持 AMD64 与 ARM64，由 Docker 自动选择架构。部署文件来自 Release 附件，服务器无需安装 Node.js、npm、Git 或克隆源代码。镜像使用官方 `node:24-bookworm-slim`，应用进程为 UID/GID 1000。Caddy 使用 `caddy:2-alpine`。

部署前准备域名及 DNS，将 A/AAAA 指向服务器可达的公网入口。开放 TCP 80/443，HTTP/3 可额外开放 UDP 443。服务器应能访问镜像仓库和证书机构。确认磁盘足够容纳现有数据、备份和恢复暂存。

没有公网 IP 的内网设备需要端口映射、可达的隧道入口或 VPN。私网设备可以使用原生 Node.js 本地模式或 VPN 内访问。已有反向代理时，可以只启动 `app`，让代理通过 Docker 内部网络连接 `app:9000`，或在同机原生运行 Node.js 并绑定 `127.0.0.1`。已有代理负责 TLS，并原样传递外部 Host 和 Origin。根据实际入口配置域名和 HTTPS 来源，确认全部路径都交给 Node.js。

## 首次部署

```bash
version=v2.1.144
mkdir -p /srv/travel-diary
cd /srv/travel-diary
curl -fLO "https://github.com/Double-Cloth/travel-diary/releases/download/$version/travel-diary-deploy-$version.tar.gz"
curl -fLO "https://github.com/Double-Cloth/travel-diary/releases/download/$version/travel-diary-deploy-$version.tar.gz.sha256"
sha256sum -c "travel-diary-deploy-$version.tar.gz.sha256"
tar -xzf "travel-diary-deploy-$version.tar.gz"
bash scripts/deploy.sh init diary.example.com
```

选择已有 Release Tag 并将示例域名替换为自己的域名，部署账户需有目录写入权限及 Docker 使用权限。部署包仅含 `compose.yaml`、`.env.example`、管理脚本、Caddyfile、部署说明和镜像摘要 `IMAGE.txt`。`init` 仅在 `.env` 不存在时创建它，拉取对应版本镜像和 Caddy、初始化空站点，并在交互终端中输入两次六位数字密码。输入过程只显示星号。已有数据和认证配置会保留。再次运行 `init` 会复用配置和密码。

初始 `.env` 使用 `TRAVEL_WRITE_MODE=local`，远程浏览可用。需要远程编辑时，先完成设密，再将该值改为 `remote`。

```bash
bash scripts/deploy.sh up
bash scripts/deploy.sh status
bash scripts/deploy.sh doctor
```

浏览 `https://你的域名/`，检查页面、字体、个人资料与附件。`doctor` 检查生效配置、DNS、运行目录权限、容器状态、就绪接口和外部 HTTPS。DNS 结果仍需与服务器实际公网入口核对，防火墙和公网入站可达性需从外部网络验证。域名或证书尚未就绪时 HTTPS 检查会失败，可查看 Caddy 日志定位。

也可手动操作。

```bash
cp .env.example .env
# 编辑 .env 中的 SITE_DOMAIN，初次保持 local
docker compose pull app caddy
docker compose run --rm --no-deps app node /opt/travel-diary/scripts/set-auth-password.js --dir /var/lib/travel-diary
# 如需编辑，此时将 .env 的 TRAVEL_WRITE_MODE 改为 remote
docker compose up -d --no-build --wait
```

密码由交互命令直接写入卷中的 `.secrets/auth.json`。明文密码应仅通过交互终端输入。更换密码优先使用网页「访问安全」，强制重置可重复运行上面的设密命令。

## 配置

| `.env` 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `SITE_DOMAIN` | 需修改示例 | 小写完整域名，省略协议、端口及路径。 |
| `TRAVEL_WRITE_MODE` | `local` | 远程只读浏览，改为 `remote` 后允许白名单站点认证与写入。 |
| `TRAVEL_IMAGE` | `ghcr.io/double-cloth/travel-diary:latest` | 仓库示例默认跟踪稳定版，Release 部署包固定对应 Tag。也可填写 `ghcr.io/double-cloth/travel-diary@sha256:...` 固定摘要。 |
| `BACKUP_DIR` | `./backups` | 专用宿主机备份目录，建议设为项目外绝对路径。 |

Compose 仅发布 Caddy 端口。应用固定监听内部 `0.0.0.0:9000`，端口被占用时直接报错。容器入口根据 `SITE_DOMAIN` 自动设置唯一来源 `https://<域名>`，local 模式使用空来源数组。应用会在监听前核对 remote 所需的密码配置。应用内的 Host、Origin、会话、令牌与路径校验继续执行。

原生 Node.js 的服务配置优先级依次为 CLI、环境变量、本机 JSON、共享 JSON、内置默认值。每层配置的类型错误都会报错。

| Node.js 环境变量 | 格式 | 对应字段 |
| --- | --- | --- |
| `TRAVEL_LOCAL` | `true` / `false` | `server.local` |
| `TRAVEL_PORT` | 1～65535 的整数 | `server.port` |
| `TRAVEL_MAX_PORT_RETRIES` | 1～65535 的整数 | `server.maxPortRetries` |
| `TRAVEL_WRITE_MODE` | `local` / `remote` | `server.writeMode` |
| `TRAVEL_ALLOWED_ORIGINS` | JSON 字符串数组，如 `["https://diary.example.com"]` | `server.allowedOrigins` |
| `TRAVEL_MEDIA_PREVIEWS_ENABLED` | `true` / `false` | `mediaPreviews.enabled` |
| `TRAVEL_BROWSER_PATH` | 浏览器可执行文件或目录 | 沿用现有预览生成器的路径覆盖规则 |

修改 `.env` 后执行 `bash scripts/deploy.sh up` 重新创建受影响的服务。原生部署可用 `npm run config:check` 核对配置。

## 持久化与初始化

| 卷 | 容器目录 | 内容 |
| --- | --- | --- |
| `runtime` | `/var/lib/travel-diary` | `data/`、`.secrets/`、`.cache/`、数据锁、导入暂存、恢复回退目录及运行代码副本。 |
| `caddy_data` | Caddy 的 `/data` | TLS 证书和账户状态。 |
| `caddy_config` | Caddy 的 `/config` | Caddy 配置状态。 |

应用镜像在 `/opt/travel-diary` 保存程序与公共资产，构建上下文通过白名单排除真实日记、认证、缓存、备份和个人配置。服务启动时向运行卷同步程序与公共资产，随后复用现有初始化逻辑补齐缺失的数据结构。升级保留运行数据。

使用单个运行卷，是因为现有导入器需要对 `data/` 和 `.secrets/` 执行目录级原子重命名。挂载整个父目录能保持这些操作处于同一文件系统。数据锁和异常暂存同样持久化。避免分别挂载这两个子目录。

命名卷首次创建时继承镜像中 UID/GID 1000 的目录属主。手动改用宿主机绑定目录时，先准备好可由 1000 写入的普通目录。固定 Compose 项目名与目录位置，迁移项目目录时可显式指定 `COMPOSE_PROJECT_NAME`，核对将继续使用原有卷。

日常停止使用 `bash scripts/deploy.sh down`，重启使用 `docker compose restart`。保留卷是数据持久化的前提。`docker compose down -v` 会删除数据卷与证书卷，仅可用于已确认可销毁的隔离测试项目。

## 迁移已有日记

在原机器停止全部服务，在项目目录中执行以下命令，输出路径应位于项目之外。

```bash
node scripts/deployment-backup.js backup "/path/to/old/travel-diary" "/secure/travel-diary-migration"
node scripts/deployment-backup.js verify "/secure/travel-diary-migration"
```

此命令需要已有有效密码。迁移包同时包含数据、认证与回收站。通过安全渠道把整个 `travel-diary-migration` 目录复制到新机器 `.env` 的 `BACKUP_DIR` 下。在新站点完成 `init` 后执行以下命令。

```bash
bash scripts/deploy.sh verify travel-diary-migration
bash scripts/deploy.sh restore travel-diary-migration
```

恢复会要求两次交互确认，并为新站点当前状态创建备份。恢复后使用原站点密码重新登录。仓库中的个人日记需要主动采用上述流程迁移。

## 备份与校验

```bash
bash scripts/deploy.sh backup
# 使用终端输出的备份目录名
bash scripts/deploy.sh verify travel-diary-20261115T020000Z-12345
```

管理命令先停止应用，完成备份后恢复原先运行状态。备份失败时保持停机并保留产物供诊断，查看错误、磁盘和权限后再手动启动。Caddy 在停机窗口可能返回 502。备份目录使用独占创建，已有同名目录会报错。

每个备份包含以下文件。

- `data.zip` 复用现有 ZIP64 完整归档，保存 `data/` 和 `.secrets/auth.json`。
- `recycle-bin.zip` 独立保存 `.cache/recycle-bin/`，包含空回收站标记。
- `manifest.json` 保存两个归档的长度与 SHA-256。

生成后读取全部 ZIP 条目核对 CRC，恢复前再次核对长度、SHA-256 和 CRC。两个 ZIP 和清单应一起保管。数据 ZIP 可用于现有网页导入，回收站由运维恢复流程处理。字体与媒体预览缓存可重新生成。

备份目录属主为 UID/GID 1000、权限为 700，归档与清单权限为 600。工具会为专用 `BACKUP_DIR` 调整顶层属主和权限，运行备份及恢复的进程继续使用 UID 1000。需要宿主机管理员或对应 UID 访问该目录。备份含认证哈希和私人内容，应定期复制到离机或异地受保护存储。校验和用于检测损坏，导入来源应可信。

定时备份可由部署账户的 cron 执行，示例每天 03:15 备份。路径应替换为实际绝对路径，任务运行结果可在系统邮件或日志中检查。

```cron
15 3 * * * cd /srv/travel-diary && /usr/bin/bash scripts/deploy.sh backup
```

管理脚本通过 `flock` 串行化会修改服务状态的命令，遇到并行维护直接报错。工具保留全部历史备份，磁盘容量由操作者管理。

## 恢复与回退

```bash
bash scripts/deploy.sh restore travel-diary-20261115T020000Z-12345
```

先输入完整备份名称，再输入 `RESTORE`。工具校验备份、停止应用、备份当前状态，然后在运行卷独立暂存目录中调用现有导入器检查索引、正文、媒体路径与认证配置。全部内容准备好后才替换数据、认证和缓存目录。恢复会采用备份中的访问密码，完成后重新登录。

替换过程失败时尝试将已移动的目录归位。回退失败会保留暂存和原数据目录并报错，需保持停机按错误路径核对。成功后保留 `.travel-restore-rollback-*` 原目录，同时已有恢复前备份。检查内容、附件、回收站、密码及健康状态后，操作者可自行归档或清理这些特定的回退目录。

恢复后健康检查失败时保持现场，使用终端输出的恢复前备份再次执行 `restore` 回退。首次正式使用前，建议运行下面的虚拟数据容器测试完成演练。

## 升级

```bash
bash scripts/deploy.sh status
# 目标 Tag 以 Releases 页面实际发布的版本为准
bash scripts/deploy.sh update v2.1.144
# 也可传完整镜像引用或摘要
# bash scripts/deploy.sh update ghcr.io/double-cloth/travel-diary@sha256:...
```

`update` 先拉取目标镜像，下载失败时当前服务继续运行。随后为当前镜像创建 `travel-diary:rollback-<时间>` 标签、停止应用，使用升级前程序备份数据、认证和回收站，再检查新配置并等待新服务就绪。成功后将目标镜像原子写入 `.env`，把上一镜像标签保存到 `.env.previous-image`，并输出升级前备份名称。省略版本参数时使用当前 `.env` 的 `TRAVEL_IMAGE`，适用于已手动改为固定版本或 `latest` 的配置。

配置检查、启动或配置保存失败时，工具会自动重新创建旧镜像服务并将 `.env` 设回旧镜像。备份失败时保持停机以便排查。更新前先等待大型导入、导出和写入完成。更新操作保留运行卷和 Caddy 证书卷。

回滚到上次更新前的镜像。

```bash
bash scripts/deploy.sh rollback
# 也可重新拉取某个历史 Release
bash scripts/deploy.sh update v2.1.144
```

`rollback` 使用本机保留的上一镜像，执行当前状态备份、配置检查和健康检查，再同步 `.env`。回滚本身也记录切换前镜像，可再次切换。保留 `.env.previous-image` 指向的本地标签，清理镜像前核对回滚需求。更新部署管理文件时，先校验并解压新 Release 部署包到原目录，保留 `.env`、`.env.previous-image`、备份与相同 Compose 项目名，再执行 `update`。

镜像回滚保留当前数据。若新版改变索引、认证或回收站格式，旧程序可能无法读取新版数据，健康检查也无法覆盖所有业务格式差异。先查看 Release 的兼容性说明。此时应停止服务，选用能读取升级前备份的旧镜像，并恢复配套的升级前备份。可在 `.env` 设置旧版本后执行 `bash scripts/deploy.sh restore <升级前备份名称>`，恢复完成后由工具启动旧服务。备份之后新增或修改的内容会被替换，恢复前先保留当前状态备份。自动镜像回退失败时保持停机，按此流程恢复。

### 从源码构建

开发者在已有源码的机器上可显式启用构建覆盖文件。

```bash
export COMPOSE_FILE=compose.yaml:compose.build.yaml
export TRAVEL_BUILD=1
export TRAVEL_IMAGE=travel-diary:local
bash scripts/deploy.sh init diary.example.com
bash scripts/deploy.sh up
# 检出目标代码后重新构建并更新
bash scripts/deploy.sh update
```

运行 `rollback` 后应退出这些临时环境变量，后续使用 `.env` 已保存的镜像。日常服务器部署仅使用 `compose.yaml`。

## Release 与 GHCR 发布

维护者先提交并推送全部修改到 GitHub。确认 `package.json` 版本，例如 `2.1.144`，创建同名版本 Tag，可带 `v` 前缀。将发布说明写入本地文件，说明功能变化和数据格式兼容性，再执行以下命令。

```bash
gh release create v2.1.144 --target main --title v2.1.144 --notes-file release-notes.md
gh run list --workflow release.yml
gh run watch <运行编号> --exit-status
```

`.github/workflows/release.yml` 监听 `release.published`，草稿正式发布和预发布均会触发。它复用现有测试工作流，在原生 AMD64、ARM64 runner 上执行字体准备、全部 Node.js 测试、镜像构建和虚拟数据容器演练。任一测试失败，发布作业不会运行。发布作业用 `GITHUB_TOKEN` 及 `packages: write` 登录 GHCR，构建两个平台并在构建成功后推送完整版本清单。构建失败可能留下无版本标签的中间层，版本标签只指向完整的多架构清单。

镜像标签与 Release Tag 完全一致，例如 `v2.1.144`。正式稳定版本通过清单检查后同时更新 `latest`，预发布保持独立版本标签。Release 附加 `travel-diary-deploy-<Tag>.tar.gz` 及 SHA-256 校验文件，包内 `.env.example` 固定该 Tag，`IMAGE.txt` 记录本次镜像摘要。工作流发布所需权限为 `contents: write` 和 `packages: write`，无需添加长期凭据。

### 首次公开包设置

GitHub 首次创建 GHCR 包时默认设为 Private，公开仓库的包也需要单独设置可见性。首次成功发布后，维护者打开包设置，将 Visibility 改为 Public，并确认仓库 `Double-Cloth/travel-diary` 有 Actions 写入权限。该操作只需执行一次。随后在未登录 GHCR 的环境验证拉取与平台清单。

```bash
docker pull ghcr.io/double-cloth/travel-diary:v2.1.144
docker buildx imagetools inspect ghcr.io/double-cloth/travel-diary:v2.1.144
```

清单应包含 `linux/amd64` 和 `linux/arm64`。工作流还会生成证明清单，可能显示额外的 `unknown/unknown` 条目。包设置和认证行为见 [GitHub GHCR 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

### 发布失败与重试

通过 `gh run view <运行编号> --log-failed` 定位失败。临时网络或 runner 故障可使用 `gh run rerun <运行编号> --failed` 重试。若需修改代码，应修复、更新版本并创建新 Release，确保 Tag 对应代码与包版本一致。发布完整版本后保持该 Tag 指向的代码固定。部署包上传失败可以重跑发布作业，附件会更新为该次完整构建的结果。发布完成以 Actions 成功、附件齐全、双架构清单及匿名拉取均通过为准。

## 健康状态与停止

`GET /healthz` 返回进程存活状态，`GET /readyz` 检查基本数据入口和写权限，失败返回 503。响应只包含简短文本并禁止缓存。服务完成初始化和 remote 认证配置检查后才开始监听。就绪接口用于基础探测，完整内容和磁盘余量仍需运维检查。

SIGINT 和 SIGTERM 共用停止流程。收到信号后停止接受新连接，等待现有连接及异步提交、清理和回滚，最长 120 秒。Compose 给出 130 秒停止窗口。超过上限会明确报错并以失败状态退出，未完成的大型任务可能需要恢复。重启前应保留并检查卷中的锁及暂存目录，按 [维护指南](MAINTENANCE.md#写入故障恢复) 操作。

Compose 的 `unless-stopped` 策略可在进程异常退出和 Docker 重启后恢复服务。健康检查失败会标记 unhealthy，操作者可根据日志定位后重启。

## 容量、预览与常见故障

Caddy 将全部业务路径转发给 Node.js，保留 Host 和 Origin。代理使用流式传输，后端传输超时为 8 小时。配置中省略请求体容量限制，应用继续执行原有上传上限与连接空闲限制。若前面还有其他代理或 CDN，应允许完整备份 100 GiB、记录 ZIP 100 GiB + 16 MiB，以及相应的长时间传输。

导入过程中同时保留当前内容、上传 ZIP 和新解包内容。导入 60 GiB 未压缩备份时，除现有数据外至少预留约 120 GiB 及文件系统余量。运维恢复还会创建恢复前备份并保留旧目录，规划时需计入这些副本。

默认轻量镜像关闭后端浏览器预览生成。缺失预览由现有前端 Canvas 路径生成并回传缓存。已有缓存可持续复用。若需要后端预生成，可在原生环境安装已有 Chrome/Chromium，配置 `TRAVEL_BROWSER_PATH` 后执行批量预览命令，再迁移 `.cache/`。字体通过随镜像提供的 WASM 自动生成。

| 现象 | 排查 |
| --- | --- |
| Caddy 无法获得证书 | 核对 A/AAAA、TCP 80/443、公网入口、防火墙和 Caddy 日志。 |
| 认证或写入返回 403 | 核对 `remote`、实际 HTTPS 域名、Host/Origin 原样传递、会话与令牌。 |
| remote 启动失败 | 用交互命令初始化密码，检查来源及配置错误。 |
| 卷写入 EACCES | 核对 `/var/lib/travel-diary` 属主为 UID 1000，手工绑定目录权限应匹配。 |
| 端口占用 | 用 `docker compose ps` 及宿主机监听检查定位 80/443 冲突，复用已有代理时调整入口配置。 |
| 大型上传中断或磁盘不足 | 检查全部代理的上限、超时、应用日志及可用空间，先核对数据是否已提交。 |
| 备份后服务保持停止 | 修复备份报错后执行 `bash scripts/deploy.sh up`，保留不完整产物供核对。 |

```bash
docker compose logs --tail 100 app caddy
docker compose exec -T app node -e "fetch('http://127.0.0.1:9000/readyz').then(r=>console.log(r.status))"
```

六位数字密码仅保护写入。公开域名下的日记与媒体默认可读，阅读访问控制可在部署层使用独立认证、VPN 或 Zero Trust。镜像及代码发布前核对真实数据、凭据和备份的隔离。

## 本地验证

```bash
npm test
docker build -t travel-diary:verification .
npm run test:deployment
bash -n scripts/deploy.sh
sh -n deploy/entrypoint.sh
SITE_DOMAIN=diary.example.com docker compose config --quiet
git diff --check
```

容器测试使用唯一 Compose 项目、虚拟密码及日记、本地 HTTP Caddy 入口和含空格的临时备份路径，覆盖镜像隔离、非 root 权限、未设密拒绝 remote、Host/Origin、认证、编辑、头像上传、字体、SIGTERM、重建持久化和备份恢复。在 Linux 上还通过 Bash 管理入口演练双确认恢复、升级及升级失败后的镜像回退，需要 util-linux 中的 `script` 命令提供测试终端。测试结束仅清理自身创建的测试卷与镜像标签。公网 HTTPS 签发与实际公网写入需在真实域名部署后验证。

镜像标签及代理配置依据 [Node 官方镜像](https://hub.docker.com/_/node)、[Caddy reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) 和 [自动 HTTPS 文档](https://caddyserver.com/docs/automatic-https)。
