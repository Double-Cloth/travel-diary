# 离线部署

离线包同时包含 `compose.portal.yaml`、共享 Caddy 示例及门户部署文档。设置 `TRAVEL_DEPLOYMENT_MODE=portal` 后，管理脚本叠加离线与门户覆盖文件，仅管理应用，继续支持备份、恢复、离线包升级和镜像回滚。共享网关独立准备，`doctor` 会检查公开子路径并报告外部入口不可达的原因。[离线门户安装与迁移步骤](PORTAL_DEPLOYMENT.md)

离线包适用于无法访问互联网的 Linux 服务器。提前安装 Docker Engine、Docker Compose 插件和常见 Linux 工具：Bash、`flock`、`awk`、`sed`、`grep`、`tar`、`sha256sum`。Compose 需支持 `--wait`、`--pull never`、`pull_policy` 和 `config --format json`。服务器无需 Node.js、npm、Git 或镜像仓库账户。安装、运行、编辑、备份和升级均不访问 Docker Hub、GHCR 或其他外部服务。

## 选择与校验安装包

在可联网的机器上打开项目 Releases，选择目标 Release，并下载相同架构的包与对应 `.sha256` 文件。

| Docker 服务器架构 | Release 附件 |
| --- | --- |
| AMD64 / x86_64 | `travel-diary-offline-linux-amd64-<Tag>.tar.gz` |
| ARM64 / aarch64 | `travel-diary-offline-linux-arm64-<Tag>.tar.gz` |

以 Docker Engine 的架构为准，可用 `docker version --format '{{.Server.Os}}/{{.Server.Arch}}'` 查看。把两个文件传到服务器后执行以下命令，将包名替换为实际下载的文件名。

```bash
archive='下载的离线包文件名.tar.gz'
sha256sum -c "$archive.sha256"
mkdir -p /srv/travel-diary
tar -xzf "$archive" -C /srv/travel-diary
cd /srv/travel-diary
```

包内 `offline/images.tar` 使用 Docker 原生镜像归档，包含 Travel Diary、Caddy 的完整镜像层；`offline/manifest.env` 记录镜像标签、ID 和架构。`SHA256SUMS` 校验镜像和部署文件，安装及升级在导入前自动检查。外部 `.sha256` 校验整个压缩包。校验和用于发现传输或存储损坏，下载来源仍需可信。不要修改包内受校验的文件后再运行安装器；个人设置写入生成的 `.env`。

发布包采用文件白名单，应用镜像也通过独立的构建白名单排除个人日记、密码、证书、缓存和备份。安装时才创建空数据与密码配置，保存到 Docker 持久卷。

## 初始化与启动

为客户端准备内网 DNS 或 hosts 映射，让访问域名指向服务器内网地址。无需公网 DNS。也可使用 IPv4 地址作为入口。根据所选模式放行 TCP 80 或 443。安装账户应有 Docker 使用权限及目录写入权限。

以下三种模式任选一种。安装器校验文件、检查架构、导入镜像、创建 `.env`、初始化空数据、交互设置访问密码并启动服务。密码仅在终端输入，不写入命令参数、环境变量或发布包。初始为远程只读浏览。

### 内部 CA 的 HTTPS

```bash
bash install.sh diary.example.com internal
```

Caddy 在本地生成 CA 并为入口签发证书，无需外部证书机构。导出根证书：

```bash
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./travel-diary-root.crt
```

通过可信渠道分发根证书，将它导入访问设备的系统或浏览器信任库，再打开 `https://diary.example.com`。只分发 `root.crt`，不要导出或分发 CA 私钥。CA 状态保存在 `caddy_data` 卷；重建服务时保留该卷，避免重新签发 CA 后客户端失去信任。

### 已有证书的 HTTPS

```bash
mkdir -p deploy/certs
# 放入匹配入口域名的完整证书链 site.crt 和私钥 site.key
chmod 600 deploy/certs/site.key
bash install.sh diary.example.com certificate
```

证书可来自组织内部 CA 或提前取得的其他证书机构。Caddy 只读取这两个本地文件，不进行公网签发，离线模板同时关闭 OCSP stapling 刷新。客户端必须信任签发 CA，证书需包含访问域名或 IP 对应的 SAN。证书到期前自行更换文件并执行 `docker compose restart caddy`。证书目录只读挂载，不会进入镜像或安装包。相关行为见 [Caddy TLS 配置](https://caddyserver.com/docs/caddyfile/directives/tls) 和 [OCSP 选项](https://caddyserver.com/docs/caddyfile/options#ocsp-stapling)。

### HTTP 浏览

```bash
bash install.sh 192.168.1.10 http
```

打开 `http://192.168.1.10`。HTTP 支持只读浏览，项目现有认证及远程写入策略要求 HTTPS；需要编辑时，先选择上述 HTTPS 方案并配置客户端信任。不要在 HTTP 配置下开启 `remote`，启动检查会明确拒绝。

## 开启编辑与日常维护

HTTPS 入口验证通过后，将 `.env` 中 `TRAVEL_WRITE_MODE=local` 改为 `TRAVEL_WRITE_MODE=remote`，执行：

```bash
bash scripts/deploy.sh up
bash scripts/deploy.sh doctor
```

在浏览器输入安装时设置的密码即可新增、编辑日记和上传媒体。离线字体工具、地点目录及公共资源随镜像提供。`doctor` 在离线模式检查配置、权限、内部代理及就绪状态，不依赖外部 DNS；客户端还应验证域名解析、入口 HTTPS 和证书信任。

安装器将 `TRAVEL_OFFLINE=1` 写入 `.env`，后续管理命令自动使用离线模式。也可显式传入 `bash scripts/deploy.sh --offline <命令>`。所有服务禁止拉取镜像，启动禁止构建，维护容器也使用本机镜像。缺少镜像时直接报错。应用与维护容器位于 `internal` 网络，Caddy 另接入口网桥以发布服务器端口，运行不需要互联网连接。直接使用 Compose 管理服务时，显式叠加离线文件：

```bash
docker compose -f compose.yaml -f compose.offline.yaml up -d --no-build --pull never
```

备份、校验及双确认恢复与在线部署相同，操作说明见 [服务器部署指南](DEPLOYMENT.md#备份与校验)。密码只控制编辑权限；阅读访问限制可由内网、防火墙或额外的部署层认证提供。

## 离线升级和回滚

在联网机器下载同架构的新包及校验文件，传入服务器并校验。将新包解压到独立目录；保持现有部署目录、`.env`、卷、备份及 Compose 项目名不变。

```bash
# 在新包所在目录校验并解压
archive='新下载的离线包文件名.tar.gz'
sha256sum -c "$archive.sha256"
mkdir -p /srv/travel-diary-next
tar -xzf "$archive" -C /srv/travel-diary-next

# 回到原部署目录执行升级
cd /srv/travel-diary
bash scripts/deploy.sh --offline update --bundle /srv/travel-diary-next
bash scripts/deploy.sh doctor
# 回到上次切换前的应用镜像
bash scripts/deploy.sh rollback
```

升级先校验文件、架构与镜像 ID 并导入新镜像；失败时不停止正在运行的应用。随后复用既有升级逻辑：为旧应用镜像保留回滚标签、停止写入、备份数据和认证及回收站、验证新配置、等待服务就绪，成功后保存新镜像引用。配置检查或启动失败时自动切回旧镜像。也可先手动导入可信 Docker 镜像归档，再用 `--offline update <本地镜像引用>` 升级。

应用升级保持原 Caddy 镜像、证书及入口配置，避免影响已部署的代理。新包同时包含对应 Caddy 镜像；需要更新 Caddy 时，确认兼容性后将现有 `.env` 的 `CADDY_IMAGE` 改为新包 `offline/manifest.env` 中的值，再执行 `up`。需要更新管理脚本时，从已校验新包复制 `scripts/deploy.sh`、`scripts/offline-images.sh`、`compose*.yaml`、`install.sh` 及公共代理模板，保留 `.env`、证书、备份与镜像回滚记录；涉及配置变更时按 Release 说明迁移。

镜像回滚保留当前数据。数据格式不兼容时，需要恢复升级前备份；具体边界及步骤见 [恢复与回退](DEPLOYMENT.md#恢复与回退)。不要清理 `.env.previous-image` 指向的本地镜像，离线环境无法临时从仓库补回。

## 断网演练

CI 在两种原生架构上先准备测试工具及离线包，再启动 `--network none` 的独立 Docker Engine。该 Engine 与业务容器均无互联网路由，初始镜像库为空，全部业务镜像只能来自离线包。测试工具与虚拟数据不进入发布包。Release 上传离线附件前会再次验证实际发布包。

测试覆盖压缩包及包内校验、损坏文件和错误架构拒绝、导入、交互设密、HTTP 浏览、内部 CA 和已有证书的真实 HTTPS、证书信任校验、认证、编辑、字体生成、备份、升级、回滚、升级失败自动回退及双确认恢复，并检查缺失镜像时现有服务仍可访问。

开发者在联网的 Docker 环境中准备镜像后，可运行相同演练，无需修改宿主机防火墙或断开宿主机网络：

```bash
docker build -t travel-diary:verification .
caddy_image=$(sed -n 's/^CADDY_IMAGE=//p' .env.example)
docker pull "$caddy_image"
docker build -f tests/fixtures/Dockerfile.offline -t travel-diary:offline-test-tools .
node scripts/package-deployment.mjs --offline --local --tag verification --image travel-diary:verification
node scripts/test-offline-deployment.mjs dist/实际生成的离线包文件名.tar.gz
```

测试 Engine 需要 Docker 的 privileged 容器支持，结束后仅删除本次创建的隔离 Engine 及测试数据卷。
