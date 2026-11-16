# 共享门户部署

Travel Diary 继续独立保存数据、认证和备份。共享 Caddy 与 Portal 由单独的 Compose 项目管理，应用启动无需 Portal 管理后端。以下示例使用 `https://example.com:63445/diary/`，SakuraFrp 终止公网 TLS，转发 HTTP 到共享 Caddy。

## 配置约定

| 配置 | 默认值 | 作用 |
| --- | --- | --- |
| `TRAVEL_DEPLOYMENT_MODE` | `standalone` | `deploy.sh` 在 `portal` 模式自动叠加 `compose.portal.yaml` |
| `TRAVEL_BASE_PATH` / `server.basePath` | `/` | 公开路径，非根路径末尾斜杠自动规范化 |
| `TRAVEL_PUBLIC_ORIGIN` / `server.publicOrigin` | 空 | 完整 HTTPS Origin，可含端口。remote 模式作为唯一允许来源 |
| `TRAVEL_PORTAL_NETWORK` | `portal` | 预先创建的外部 Docker 网络 |
| `TRAVEL_PORTAL_ALIAS` | `travel-diary` | 共享网络中的唯一应用 DNS 别名 |
| `COMPOSE_PROJECT_NAME` | 沿用 Compose 推导值 | `init` 将当前解析结果固定到 `.env`，迁移必须沿用原项目名 |

公开路径支持 `/travel`、`/travel/log` 等形式，每段由 ASCII 字母、数字、下划线、短横线组成，最长 256 字符。拒绝空值、重复斜杠、点段、百分号编码、反斜杠、空白、查询和片段。网关配置使用无末尾斜杠的路径。

`TRAVEL_PUBLIC_ORIGIN` 示例为 `https://example.com:63445`，不能附带 `/`、路径、查询、片段或用户信息。默认 HTTPS 端口会规范化。未设置时，原有 `SITE_DOMAIN` 来源生成方式继续生效。`SITE_DOMAIN` 继续填写无协议、无端口的域名。`SITE_SCHEME` 描述公开入口，SakuraFrp 终止 TLS 时仍填 `https`。

## 全新部署

先按独立部署文档下载并校验目标 Release 部署包，解压到固定目录。离线服务器使用同架构离线附件，先完成校验与解压。以下命令在部署目录执行。

```bash
docker network create portal
cp .env.example .env
chmod 600 .env
# 编辑 .env，保持部署包已经固定的 TRAVEL_IMAGE
```

在 `.env` 设置以下内容，首次初始化保持 `local`。

```dotenv
SITE_DOMAIN=example.com
SITE_SCHEME=https
COMPOSE_PROJECT_NAME=travel-diary
TRAVEL_DEPLOYMENT_MODE=portal
TRAVEL_BASE_PATH=/diary
TRAVEL_PUBLIC_ORIGIN=https://example.com:63445
TRAVEL_PORTAL_NETWORK=portal
TRAVEL_PORTAL_ALIAS=travel-diary
TRAVEL_WRITE_MODE=local
```

```bash
# 在线安装
bash scripts/deploy.sh init
# 离线安装改用此命令，复用包内镜像，不获取自带 Caddy
# bash scripts/deploy.sh --offline init
# 初始化成功后如需远程编辑，将 .env 的 TRAVEL_WRITE_MODE 改为 remote
bash scripts/deploy.sh up
bash scripts/deploy.sh status
```

已复制 `.env` 的离线首次安装需先导入包内镜像，再执行初始化。

```bash
sha256sum --strict -c SHA256SUMS
docker load --input offline/images.tar
# 将 offline/manifest.env 中 TRAVEL_IMAGE、CADDY_IMAGE 填入 .env
# 设置 TRAVEL_OFFLINE=1，再运行 --offline init 和 --offline up
```

也可在未创建 `.env` 时通过环境变量完成离线初始化，安装器会校验清单、导入镜像并保存配置。

```bash
TRAVEL_DEPLOYMENT_MODE=portal TRAVEL_BASE_PATH=/diary \
TRAVEL_PUBLIC_ORIGIN=https://example.com:63445 \
bash scripts/deploy.sh --offline init example.com
```

`init` 交互设置密码，已有密码会保留。Portal 模式只启动 `app`，维护命令通过独立 `maintenance` 容器运行。所有生产命令保留持久卷。原有容器内 npm 运维命令继续可用。

手动 Compose 操作需要显式叠加覆盖文件，`.env` 中的部署模式由 `deploy.sh` 读取。

```bash
docker compose -f compose.yaml -f compose.portal.yaml up -d --no-build --wait app
docker compose -f compose.yaml -f compose.portal.yaml ps
# 离线时在以上两个 -f 之间增加 -f compose.offline.yaml，并使用 --pull never
```

## 共享 Caddy

复制仓库的 `deploy/Caddyfile.portal.example` 到共享网关目录。此模板使用 `handle_path` 剥离应用前缀，应用内部继续接收 `/api/...`、`/data/...` 和资源路径。模板的默认规则可直接用于 `/diary`，可通过网关环境变量更换路径和服务别名。[Caddy 官方前缀处理说明](https://caddyserver.com/docs/caddyfile/directives/handle_path)

共享网关的 Compose 示例保存到单独目录，Portal 文件放在该目录的 `portal/` 中。

```yaml
services:
  gateway:
    image: caddy:2-alpine
    restart: unless-stopped
    environment:
      TRAVEL_BASE_PATH: /diary
      TRAVEL_PORTAL_ALIAS: travel-diary
    ports:
      - "127.0.0.1:8080:80"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./portal:/srv/portal:ro
    networks: [portal]
networks:
  portal:
    external: true
    name: portal
```

```bash
# 在共享网关目录验证与启动
docker compose run --rm --no-deps gateway caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
docker compose up -d
# 在 Travel Diary 部署目录检查完整公开子路径
bash scripts/deploy.sh doctor
curl -f https://example.com:63445/diary/readyz
```

SakuraFrp 的目标为 `127.0.0.1:8080`。如果隧道客户端位于其他容器或主机，按实际网络设置受控可达地址。隧道和所有前置代理须原样保留 `Host: example.com:63445` 与浏览器的 `Origin: https://example.com:63445`。Caddy 明确保留 `{hostport}`，应用忽略客户端伪造的 `X-Forwarded-*`。应用容器的 9000 端口仅用于 Docker 内部通信。

模板精确重定向 `/diary` 到 `/diary/`，保留查询参数。浏览器继续处理 Hash 路由。`/diaryevil/` 不匹配 `/diary/*`，其他站点和根路径 `/api/...` 由独立路由处理。`admin off` 关闭示例网关的管理接口。新增 `/blog/*` 等应用时，在兜底 `handle` 前增加互斥规则。

应用基于可信 `TRAVEL_BASE_PATH` 生成目录 `Location` 和 `Set-Cookie Path=/diary/api`，无需响应头改写，不能再给响应添加相同前缀。前端相对资源、模块、API、媒体与缓存 URL 均从 `/diary/` 解析。共享网关须一次性剥离前缀，Node 不接收带公开前缀的请求。根路径部署仍使用 `Path=/api`。

模板的连接超时为 10 秒，等待响应头上限为 300 秒，流式正文沿用默认流转发。Node 上传请求最长 8 小时，停止等待最多 120 秒。隧道与前置代理需允许实际上传下载时长和大小，避免额外的短时限或缓冲限制。图片、视频 Range、字体和缩略图缓存直接经同一路由转发。

同域不同路径共享 Origin，Cookie Path 仅控制浏览器附带 Cookie 的范围。同源其他应用仍能向日记发送请求，必须信任同源应用。登录继续要求现有密码、会话、写入令牌与 HTTPS 来源校验。改变路径或重建容器后重新登录，旧会话失效。

## 从 Standalone 迁移

以下操作在原部署目录执行。迁移前先更新到本次兼容版本并完成原入口验证。

```bash
bash scripts/deploy.sh backup
# 将上一步输出的名称代入
bash scripts/deploy.sh verify travel-diary-实际备份名称
cp .env .env.before-portal
chmod 600 .env.before-portal
# 在改模式之前记录项目名、卷名和镜像
docker compose config --environment | sed -n 's/^COMPOSE_PROJECT_NAME=//p'
docker inspect "$(docker compose ps -q app)" --format '{{json .Mounts}}'
docker compose config --images
# 在切换配置前停止原自带网关，保留全部卷及 Caddy 状态
docker compose stop caddy app
docker network inspect portal >/dev/null 2>&1 || docker network create portal
```

编辑 `.env` 的 Portal 配置，`COMPOSE_PROJECT_NAME` 必须使用刚记录的原项目名。保留 `TRAVEL_IMAGE`、备份目录及其他旧配置。在共享网关配置对应路径后执行以下命令。

```bash
bash scripts/deploy.sh init
bash scripts/deploy.sh up
bash scripts/deploy.sh doctor
docker inspect "$(docker compose -f compose.yaml -f compose.portal.yaml ps -q app)" --format '{{json .Mounts}}'
```

核对前后 `/var/lib/travel-diary` 的卷名一致，再检查旧日记、媒体、登录和备份。请保持原部署目录或复制固定后的 `.env`，单独移动部署文件会影响 Compose 项目名推导。使用过自定义 `-p`、`COMPOSE_FILE` 或卷覆盖文件的部署须继续保留原设置。

## 更新、恢复与回滚

```bash
bash scripts/deploy.sh backup
bash scripts/deploy.sh verify travel-diary-实际备份名称
bash scripts/deploy.sh update v目标版本
bash scripts/deploy.sh rollback
bash scripts/deploy.sh restore travel-diary-实际备份名称
bash scripts/deploy.sh down
bash scripts/deploy.sh up
# 离线升级从新包导入已校验镜像，保留当前模式、项目名和入口
bash scripts/deploy.sh --offline update --bundle /srv/packages/新离线包目录
```

更新和回滚保留升级前备份与本地回退镜像，恢复操作需两次交互确认。Portal 模式的更新、停止与恢复只操作本项目应用，共享网络与外部网关继续运行。离线包仍携带 Standalone 所需 Caddy 镜像，Portal 不启动它。更新部署脚本和模板时使用新包对应文件，保留 `.env` 和原项目名。

回到 Standalone 时，先在 Portal 模式停止应用，再恢复保存的环境配置，沿用原项目名及镜像。共享网关的 `/diary` 路由由其管理员移除。

```bash
bash scripts/deploy.sh down
cp .env.before-portal .env
bash scripts/deploy.sh up
bash scripts/deploy.sh doctor
```

若还需要恢复迁移前数据，使用已验证的备份执行 `restore`。禁止对生产环境执行 `down -v`。镜像回退与数据恢复是两项独立操作，恢复前当前数据还会备份。

## 排查

| 现象 | 检查命令和方向 |
| --- | --- |
| 403 / 登录失败 | `bash scripts/deploy.sh logs`，核对 remote、HTTPS Origin、Host 及端口，预先设密，重新登录 |
| 404 / 资源跳到根路径 | 核对网关和应用的前缀一致，入口带末尾 `/`，仅剥离一次，路径匹配为 `/diary/*` |
| 502 | `docker network inspect portal`，核对网关及 app 都在共享网络、DNS 别名唯一、app 健康 |
| doctor 内部通过、公开失败 | 检查 DNS、SakuraFrp 目标端口、TLS 终止及服务器对公网入口的回流访问 |
| 登录后仍要求密码 | 检查浏览器 Cookie 的 Secure 和 Path，迁移或换密后重新登录，确认外部确为 HTTPS |
| 旧数据为空 | 先停止 app，比较迁移前卷名与 Compose 项目名，恢复原项目配置后再启动 |

`doctor` 会检查可写持久卷、非 root 用户、未发布的 9000 端口、内部就绪、共享网络 DNS 与公开前缀 `/readyz`。公网回流受限时会明确报告公开 URL 与失败原因，还需从外部客户端验证。

## 验证命令

在源码目录构建测试镜像并导出隔离演练所需的离线包。

```bash
npm test
docker build -t travel-diary:portal-verification .
TRAVEL_TEST_IMAGE=travel-diary:portal-verification npm run test:deployment
docker build -f tests/fixtures/Dockerfile.offline -t travel-diary:offline-test-tools .
node scripts/package-deployment.mjs --offline --local --tag portal-current --image travel-diary:portal-verification
node scripts/test-offline-deployment.mjs dist/travel-diary-offline-linux-amd64-portal-current.tar.gz
npm run test:portal -- dist/travel-diary-offline-linux-amd64-portal-current.tar.gz
```

ARM64 将包名中的 `amd64` 换为 `arm64`。Portal 演练在 `--network none` 的独立 Docker Engine 中运行共享网关、静态主页、其他应用与日记四个容器，使用临时项目、虚拟密码和独立卷。公网 HTTPS 终止后的请求通过 HTTP 转发，明确保留带端口 Host 和 HTTPS Origin。`doctor` 的公开 URL 在此隔离环境预期失败，并检查诊断中包含正确子路径。Standalone 离线演练使用内部 CA 与已有证书校验真实 HTTPS。

2026-11-16 的本机 Node 基线为 700 项通过，改造后为 708 项通过。已执行的 AMD64 Standalone 容器及断网 HTTPS 演练通过。新增媒体用例曾使用无法被 Chromium 解码的 PNG，已换为可解码夹具。HTTP 测试工具曾在 DELETE 中缺少 `Content-Length`，已补齐请求长度。这两项属于测试工具问题，修正后图片预览、删除、回收站恢复与 ZIP 导入导出均通过。

AMD64 Portal 完整演练已通过，覆盖旧卷迁移、认证、媒体、资料、回收站、备份恢复、在线与离线升级回滚、失败自动回退、停止重启和配置错误拒绝。全过程确认共享网关与其他应用容器标识保持一致且入口可用。在线管理分支采用本地 FROM 镜像构建，Portal 的公网镜像仓库拉取及真实 Release 发布尚未执行。

本机尚未验证实际 SakuraFrp 公网隧道、真实域名证书、移动浏览器及 ARM64。CI 已配置 AMD64 和 ARM64 的 Node、容器与 Portal 演练，运行结果以对应 Actions 记录为准。同源其他应用的可信程度及隧道上传时限需结合实际部署确认。
