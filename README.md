# Travel Diary · 旅行档案

一个可离线运行、可静态发布的个人旅行档案。它以路线、地点和日记整理旅途，并支持在浏览器中管理旅行记录、照片和个人数据备份。

## 快速开始

```bash
npm start
```

本机只需安装 Node.js，无需下载项目依赖。启动后默认打开 [http://localhost:9000](http://localhost:9000)；项目资源均保存在仓库内，可在断网状态下使用。

指定端口时运行：

```bash
node js/server.js --port 8080
```

服务器监听范围和数据写入权限分别配置。默认 `--local --write-mode=local`，只监听回环地址且只允许 localhost / 回环地址写入。`--network` 只负责监听局域网，不会自动开放远程写入：

```bash
node js/server.js --network
```

需要让局域网地址或反向代理后的域名写入时，必须显式启用 remote write mode：

```bash
npm run auth:set
node js/server.js --network --write-mode=remote
```

浏览器始终通过当前站点的相对 URL 探测写入 API，因此 `http://192.168.1.100:9000/`、`http://example.com/` 以及由 Nginx、Caddy、Apache 或 Cloudflare Tunnel 终止 TLS 的 `https://example.com/` 都可以在 remote 模式下写入。应用不信任 `X-Forwarded-*`，反向代理应保留外部 `Host`；`Origin` 必须与该 Host 属于同一 authority。

反向代理与 Node 位于同一服务器时，推荐用 `node js/server.js --local --write-mode=remote`，只让代理连接 Node；只有确实需要其他主机直接访问 Node 端口时才使用 `--network`。

访问口令只以带随机盐的 `scrypt` 哈希保存在 `.secrets/auth.json`，不再放入公开的 `data/`。项目服务器明确拒绝 `.secrets/` 及其目录链接的静态访问；登录由服务端完成，连续失败会被限速，成功后签发最长 8 小时的 `HttpOnly`、`SameSite=Strict` 会话，HTTPS 页面还会自动使用 `Secure` Cookie。仓库自带的旧 6 位凭据只为本机兼容，不能启动 remote write mode；部署前必须运行 `npm run auth:set` 设置至少 16 个字符的强口令。

remote write mode 仍默认关闭。公网部署必须使用 HTTPS，并建议继续在上游增加 VPN、Zero Trust、HTTP Authentication 或等效的第二层访问控制。若提交 `.secrets/auth.json`，仓库应限制访问；虽然其中没有明文密码，获得哈希的人仍可离线猜测弱口令。

## 管理旅行记录

点击头部「＋」或旅行路径页的「新增旅行记录」，输入服务器访问口令后即可开始编辑。编辑器提供：

- 地点候选与空白字段补全；中国目的地会从内置省市区目录反查省份，旅行标识会自动生成，也可从最近 5 次已有行程中选择。
- 带语法高亮的 Markdown 源码，以及可直接编辑的预览。
- 多选、拖放和排序照片；保存时自动生成小写拼音路径与文件名。
- ZIP 草稿导入与导出，便于暂存或从只读页面转到可写站点保存。

具有服务器写入能力的页面可新增、修改和删除记录。日记详情提供「修改」「删除」入口；删除会移除记录及正文，保留照片文件。默认本机 localhost 可写；显式 remote 模式下，同站点远程页面也可写。GitHub Pages 等静态页面会自动回退为只读，可编辑和导出草稿，但不能写回仓库。

个人主页的动态「数据备份」在服务端验证访问口令后导出整个 `data/` 与 `.secrets/auth.json`；认证配置只含哈希、盐和参数，不含明文口令。导入同样要求有效服务端会话与写入令牌，并原子替换数据和认证配置，成功后立即注销旧会话。静态部署无法安全验证口令，因此它的构建时 ZIP 只含公开的 `data/`，不能包含认证配置，也不能导入。详细用法、字段定义和环境限制见 [内容维护指南](doc/CONTENT_GUIDE.md#页面编辑器)。

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
