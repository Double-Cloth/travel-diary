# 架构说明

## 运行入口与页面

前端为原生 ES modules，入口是 `index.html`、`js/app.js` 和 `css/journal.css`。浏览不依赖 Node API；可选 `js/server.js` 提供静态资源、认证、记录写入和完整备份。项目没有运行时 npm 依赖，也不需要前端构建。

| Hash 路由 | 页面与职责 |
| --- | --- |
| `#cover` | 合盖封面与开本入口。 |
| `#preface` | 扉页、个人资料、日记工具箱、备份及访问安全。 |
| `#ledger` | 旅行路径、记录列表、搜索和多级筛选。 |
| `#archive` | 日记归档及地点统计。 |
| `#place?country=CN&area=...` | 地点档案及相关日记，参数按 URL 编码。 |
| `#entry?id=...` | 日记详情、相邻篇目与记录管理。 |
| `#photos?id=...` | 当前日记的图片、视频附件。 |

筛选与页面状态由 `app.js` 统一管理，旧 `province` / `city` 参数会转换为当前地点模型。不存在的记录、空列表、正文缺失和加载失败各自呈现可恢复状态；加载失败解除封面模式，使错误和重试入口可见。

## 模块边界

| 模块 | 职责 |
| --- | --- |
| `app.js` | 路由、页面渲染、筛选、动画、手机夹层和媒体查看器。 |
| `data.js`、`utils.js` | 索引与正文加载、缓存、受限 Markdown 渲染、转义和格式化。 |
| `location.mjs`、`analytics.mjs`、`visits.mjs`、`route-map.mjs` | 地点归一化、统计、行程去重和路线展示的纯逻辑。 |
| `record-editor.js`、`markdown-editor.js`、`record-suggestions.mjs` | 表单、正文双视图、地点补全和提交状态。 |
| `record-input.mjs`、`photo-uploads.mjs`、`slug.mjs` | 浏览器与 Node 共用的字段、媒体签名、路径和拼音命名校验。 |
| `draft-archive.mjs`、`zip-archive.mjs` | 草稿封装、未压缩 ZIP 与 CRC32 校验。 |
| `record-password.js`、`writer-capability.js` | 同源能力探测、首次设密、登录与换密交互。 |
| `record-delete-dialog.js`、`feedback-dialog.js`、`custom-select.js` | 删除确认、提示与原生选择框增强。 |
| `profile-picture.js`、`profile-owner.js`、`profile-owner-dialog.js` | 头像处理、署名读取与资料编辑。 |
| `data-transfer.js` | 网页完整备份导入、导出与清空交互。 |
| `server.js`、`record-store.js`、`auth.js`、`data-archive.js` | 静态服务、API、写入策略、认证、数据锁与恢复。 |
| `scripts/` | 密码恢复、备份导出、字体生成、固定版本地点目录更新。 |
| `js/vendor/pinyin-pro.mjs` | 随仓库分发的第三方拼音实现。 |

`data/` 存个人内容，`assets/catalogs/` 提供共享国家与中国省市区目录，`.secrets/` 仅供服务端认证和授权备份读取。字段与文件格式见 [内容指南](CONTENT_GUIDE.md#元数据与手工维护)。

## 读取与浏览器交互

索引先加载和校验，正文最多 8 个请求并发，单次请求超时为 20 秒。正文请求允许浏览器缓存，结果保持索引顺序；单篇失败显示提示并保留其他记录及地点搜索，不让一篇文件拖垮全站。署名读取失败回退默认值，头像从 `data-src` 加载。封面图片由可见封面的 CSS 背景触发加载，不做全路由预加载，避免直接打开日记或扉页时出现未使用预加载资源的警告。

Markdown 使用应用支持的有限语法，输出经过 HTML 转义与链接过滤；预览复用相同解析器，编辑后通过受限 DOM 序列化生成 Markdown。新增格式必须同步考虑展示、编辑与安全过滤。

桌面采用双页分工及独立滚动；不超过 760px 时转为连续阅读，路径筛选、扉页工具箱和归档概览使用可开关夹层。长连续文字允许换行，窄屏及触摸设备放大控件点击范围，短横屏压缩媒体工具间距。夹层和媒体查看器锁定背景交互、约束 Tab 焦点，关闭查看器恢复触发按钮焦点。跳转链接聚焦内容区；修饰键点击路由链接保留浏览器原生行为。

自定义选择框以原生 `select` 为数据来源，同步禁用状态并跳过禁用选项；方向键及 Home / End 可导航，菜单按可见视口限制尺寸。菜单关闭后停止布局更新。

翻页及开合动画在连续导航、关闭或窗口尺寸变化时清理副本与回调。启用 `prefers-reduced-motion` 时直接切换，动画期间背景内容使用 `inert` 防止穿透操作。

## 样式结构

`journal.css` 按编号顺序加载 11 个同目录分片，后加载的规则可覆盖前者；CSS 资产统一以 `../assets/` 引用。

| 分片 | 范围 |
| --- | --- |
| `01-foundation`、`02-shell` | 字体、变量、基础可访问性、书脊与纸页外壳。 |
| `03-cover-route`、`04-ledger`、`05-archive-place` | 路线、路径列表、归档及地点。 |
| `06-entry-sheet`、`07-responsive`、`08-custom-select` | 正文、事务对话框、基础适配和选择菜单。 |
| `09-book-experience`、`10-refined-ui`、`11-skeuomorphic-book` | 开合封面、视觉覆盖、拟物细节和最终屏幕适配。 |

改样式先确认实际生效的覆盖层，延续皮革、纸张、黄铜和手账排版。修改已带版本参数的浏览器资源时，同步入口和引用方的版本参数，避免静态托管沿用旧缓存。不要增加另一套页面入口或平行组件体系。

## 认证与写入

| API | 用途 |
| --- | --- |
| `/api/travel-auth`、`/api/travel-auth/setup` | 登录、换密、首次本机设密。 |
| `/api/travel-records` | 能力探测、创建、更新与删除。 |
| `/api/travel-profile` | 头像与署名写入。 |
| `/api/travel-data` | 完整备份导入导出与清空。 |

前端通过同源相对 URL 探测能力。静态发布物的 `api/travel-records` 提供 `travel-diary-static-v1` 标记，只有明确标记才打开免密码只读编辑器；404、超时、403 和异常响应均中止操作。动态能力 GET 在未登录或会话失效时返回 `200`、`authenticated: false`、空 `methods` 和 `AUTH_REQUIRED`，不泄露 token；正常打开密码窗口不会产生 `401` 控制台报错，实际未授权写入仍返回 `401`。前端仍接受旧服务的 `401` 探测响应。

写入请求同时校验 Host / Origin 策略、内存会话和 `X-Travel-Token`。local 模式只接受回环来源及本机 Host；remote 模式只接受配置的完整 HTTPS Origin 和对应 Host，不依赖 `X-Forwarded-*`。首次设密仅限 local 模式本机页面。认证配置保存随机盐与 scrypt 哈希，Cookie 为 `HttpOnly`、`SameSite=Strict`，remote 模式增加 `Secure`。详细部署限制见 [维护指南](MAINTENANCE.md#认证与部署边界)。

所有数据操作共用根目录 `.travel-data.lock`，锁内重读磁盘索引。新增独占创建正文，媒体写入完成后通过临时索引与 rename 提交；修改、删除先暂存原正文，失败时回滚。浏览器更新附带原始元数据与正文快照，在锁内比较，发生外部变更返回 409；同内容重试仍可识别为已保存。路径拒绝穿越、符号链接和 junction，媒体按实际签名识别。

完整备份包含 `data/` 与有效 `.secrets/auth.json`。导入先校验 ZIP 目录、范围、头信息、CRC32、路径、字段及正文，再暂存和替换；含认证文件时恢复备份密码，旧备份缺少时保留当前密码，成功后注销旧会话。ZIP 只支持未压缩存储格式，拒绝分卷、加密和不一致目录。

多个文件的操作不能保证断电时的跨文件事务。进程强制结束可能遗留锁、正文或备份目录，恢复时须先停服务并成对核对数据和认证配置。保存成功但前端重读失败会单独提示，避免误认为没有写入。

## 扩展原则

优先提取可独立测试的解析、统计和校验逻辑，保持单一数据来源与明确模块职责。新逻辑复用既有原生模块、对话框和样式；不为局部改善引入框架、运行时依赖或复杂抽象。
