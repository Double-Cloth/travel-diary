# Travel Diary · 旅行档案

一个可离线运行、可静态发布的个人旅行档案。它以路线、地点和日记整理旅途，并支持在浏览器中管理旅行记录、照片和个人数据备份。

## 快速开始

```bash
npm start
```

本机只需安装 Node.js，无需下载项目依赖。启动后默认打开 [http://localhost:9000](http://localhost:9000)；项目资源均保存在仓库内，可在断网状态下使用。

如果首次启动时还没有 `data/`，服务器会创建 `data/travel_data.json`、`data/travel-diary/`、`data/photos/`、`data/profile/` 和一个可替换的默认头像；缺少 `.secrets/` 时也会自动创建。首次点击任一需要写入的操作，页面会要求连续输入两次相同的 6 位数字密码并安全生成 `.secrets/auth.json`，无需运行命令。静态页面找不到旅行索引时也会进入可新增或导入的空档案界面，不会阻断其他页面。

指定端口时运行：

```bash
node js/server.js --port 8080
```

服务器监听范围和数据写入权限分别配置。默认 `--local --write-mode=local`，只监听回环地址且只允许 localhost / 回环地址写入。`--network` 只负责监听局域网，不会自动开放远程写入：

```bash
node js/server.js --network
```

需要让 HTTPS 反向代理后的域名写入时，必须先在本机页面完成首次设密，再显式启用 remote write mode 并声明精确的允许来源：

```bash
node js/server.js --local --write-mode=remote --allowed-origin=https://diary.example.com
```

浏览器始终通过当前站点的相对 URL 探测写入 API。remote 模式仅接受 `--allowed-origin` 白名单中的完整 HTTPS Origin（可重复指定），且请求 `Host` 必须与之精确匹配。应用不信任 `X-Forwarded-*`，反向代理应保留外部 `Host` 和 `Origin`。

反向代理与 Node 位于同一服务器时，推荐保持 `--local`，只让代理连接 Node；只有确实需要其他主机连接 Node 端口时才使用 `--network`。

访问密码保持为 6 位数字，页面首次设密会拒绝连续、重复和常见弱组合。只有 `.secrets/auth.json` 已损坏或需要强制恢复时，才在交互式终端运行 `npm run auth:set`；缺少配置时直接在本机页面创建。普通页面不会直接读取认证配置；只有通过认证的动态完整备份会携带 `.secrets/auth.json`。密码只以带随机盐的 `scrypt` 哈希保存，并被静态服务永久拒绝。全局连续失败 5 次会锁定 15 分钟，避免轮换 IP 或 Host 穷举；会话与当前哈希绑定，换密后旧会话立即失效。Cookie 使用 `HttpOnly`、`SameSite=Strict`，remote 模式一律增加 `Secure`。

remote write mode 仍默认关闭。当前项目按部署需要跟踪 `.secrets/auth.json`，但哈希并非加密，六位数字只有 100 万种组合；仓库必须设为私有，并限制克隆和 Actions 日志权限。公网部署除 HTTPS 白名单外，仍应在上游增加 VPN、Zero Trust 或等效的独立访问控制。若仓库曾公开，应清理 Git 历史并立即换密。

## 管理旅行记录

点击头部「＋」或旅行路径页的「新增旅行记录」即可开始整理内容：动态写入环境尚无密码时会要求创建并再次确认 6 位密码，已有密码时要求验证；明确的静态页面免密码打开只读编辑器。编辑器提供：

- 地点候选与空白字段补全；中国目的地会从内置省市区目录反查省份，旅行标识会自动生成，也可从最近 5 次已有行程中选择。
- 带语法高亮的 Markdown 源码，以及可直接编辑的预览。
- 多选、拖放和排序照片；保存时自动生成小写拼音路径与文件名。
- ZIP 草稿导入与导出，便于暂存或从只读页面转到可写站点保存。

具有服务器写入能力的页面可新增、修改和删除记录。日记详情提供「修改」「删除」入口；删除会移除记录及正文，保留照片文件。默认本机 localhost 可写；显式 remote 模式下，HTTPS 白名单中的同站点页面也可写。新增、修改、删除及全量数据导入导出统一先识别运行环境：检测到写入服务时必须验证密码；只有发布物中的专用静态只读标记才允许免密码进入只读编辑器，404、网络失败或异常响应不会降级放行。

个人主页的动态「数据备份」只在服务端验证后导出 `data/` 与 `.secrets/auth.json`，用于完整恢复旅行数据和访问密码。导入要求有效会话与写入令牌，并原子替换数据及认证配置；不含认证文件的旧备份会保留当前密码，成功后会注销旧会话。GitHub Pages 等静态部署不提供全部数据导入或导出。详细用法、字段定义和环境限制见 [内容维护指南](doc/CONTENT_GUIDE.md#页面编辑器)。

## 内容与资源

- `data/`：头像、旅行索引、Markdown 日记和照片等可公开个人内容。
- `.secrets/`：服务端认证哈希配置；由项目服务器永久禁止静态访问。
- `assets/`：国家目录、中国省市区目录、字体、页面图片和纹理等通用资源。
- `doc/`：内容维护、架构、资产与发布说明。

复用为自己的旅行档案时，从 [内容维护指南](doc/CONTENT_GUIDE.md#换成自己的旅行档案) 开始。

## 资源维护

重新生成完整 WOFF2 字体：

```bash
npm run fonts
```

仅在明确需要缩减字体体积时生成项目文字子集：

```bash
npm run fonts:subset
```

字体命令需要预先安装 `fonttools`，安装过程可能需要联网：

```bash
pip install "fonttools[woff]"
```

`npm run countries` 会从固定版本的 Unicode CLDR 更新国家目录；`npm run china-locations` 会从固定版本的 `cn-division` 更新中国省市区目录，两个命令均需要联网。普通启动不会运行字体或目录维护命令。

## 文档

按主题浏览 [项目文档索引](doc/README.md)。
