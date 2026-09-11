# 维护与发布指南

## 常用命令

| 命令 | 用途 | 是否需要联网 |
| --- | --- | --- |
| `npm start` | 在 localhost 启动站点及本机数据服务。 | 否 |
| `npm test` | 运行全部 Node.js 测试。 | 否 |
| `npm run data:archive` | 将当前 `data/` 生成到 `dist/travel-diary-data.zip`。 | 否 |
| `npm run fonts` | 从 TTF 生成完整 WOFF2 字体。 | 否，但需预装 `fonttools[woff]` |
| `npm run fonts:subset` | 按项目文本生成 WOFF2 子集。 | 否，但需预装 `fonttools[woff]` |
| `npm run countries` | 从固定版本的 Unicode CLDR 更新国家目录。 | 是 |
| `node js/server.js --port 8080 --network` | 指定端口并允许局域网只读访问。 | 否 |

普通启动不会自动更新字体、国家目录或数据备份。局域网地址只能浏览和导出草稿，新增记录与全部数据导入仍限定在运行服务的本机 localhost 页面。

## 写入故障恢复

| 现象 | 检查项 |
| --- | --- |
| 编辑器显示只读模式 | 确认使用本项目的 `npm start` 和 localhost 地址；静态托管及局域网访问不支持写入。 |
| 密码界面无法输入 | 确认 `data/password.json` 存在、可读取，且 `password` 是 6 位数字字符串。 |
| 密码正确但无法继续 | 刷新页面后重试，并确认当前部署的 `data/password.json` 与预期一致。 |
| 正文路径无效 | 核对年份目录、旅行日期前缀、`.md` 扩展名及文件名字符。 |
| 照片读取失败 | 确认文件确实是 JPEG、PNG、GIF 或 WebP，且浏览器内存、磁盘空间充足；应用不另设张数或文件大小上限。 |
| 照片引用无效 | 核对 `photo_folder` 与各文件名的拼接结果、文件存在性和大小写。 |
| 保存失败 | 检查索引 JSON 格式、目录权限、磁盘空间及路径中的符号链接或 junction。 |
| 重复提交冲突 | 核对已有正文与草稿内容；相同路径仅接受内容完全一致的重试。 |
| 数据锁被占用 | 等待当前保存、导入或导出结束；若进程异常终止，按下述步骤恢复。 |
| 全部数据导入失败 | 确认 ZIP 来自本应用，且包含 `data/travel_data.json` 以及索引引用的全部正文和照片。 |

异常退出后的恢复步骤：

1. 停止所有本项目服务器，备份 `data/`。
2. 检查根目录 `.travel-data.lock`、`.travel-data-import-*`、`.travel-data-backup-*`，以及 `data/.travel-write-*.tmp`、旅行索引、对应 Markdown 文件和照片目录。
3. 对索引未引用的正文，核对后补充索引，或备份并移走文件后重试原草稿。未被索引引用的照片目录同样应先备份核对。临时索引仅在内容核验后用于恢复。
4. 确认没有活动数据操作后移除遗留锁；若存在备份目录，先核对当前 `data/` 完整性再决定保留哪份，随后重启服务器并核验记录。

数据锁、导入临时目录和导入回滚目录不纳入版本控制。本地保存与线上发布相互独立；发布通过提交、推送和 GitHub Pages 工作流完成。

## 发布前检查

1. 运行测试：

   ```bash
   npm test
   ```

2. 检查静态资源引用：

   ```bash
   rg -n "assets/|data/|css/|js/" index.html css js data doc README.md
   ```

3. 启动本地服务器：

   ```bash
   npm start
   ```

4. 在浏览器检查：

   - `#cover`
   - `#ledger`
   - `#archive`
   - 任意一条 `#entry?...`
   - 任意一个 `#place?...`
   - 国家、一级行政区和目的地三级筛选是否会依次收窄选项。
   - 一个旧版 `province/city` 链接是否会自动转换并保持结果。
   - 新增记录验证、地点补全、正文双视图、照片选择和草稿导入导出。
   - 本机保存提示是否可用，静态或局域网访问是否显示只读提示。

## 测试说明

| 范围 | 主要测试 |
| --- | --- |
| 应用状态、路由、筛选与统计 | `app.test.mjs`、`route-map.test.mjs`、`analytics.test.mjs`、`visits.test.mjs` |
| 地点模型与国家目录 | `location.test.mjs`、`countries.test.mjs`、`record-suggestions.test.mjs` |
| 记录校验、写入、草稿与照片 | `record-store.test.mjs`、`record-password.test.mjs`、`markdown-editor.test.mjs`、`photo-viewer-transform.test.mjs` |
| 全部数据 ZIP 导入导出 | `data-archive.test.mjs`、`data-archive-api.test.mjs` |
| 数据读取与 Markdown 渲染 | `data.test.mjs`、`content.test.mjs`、`performance.test.mjs` |
| 静态外壳、本机服务与离线约束 | `shell.test.mjs`、`server.test.mjs`、`offline.test.mjs`、`workflow.test.mjs` |

写入与导入测试均在临时目录中运行，覆盖并发冲突、路径越界、链接文件、重复提交和失败回滚，不会修改仓库中的个人数据。浏览器相关模块通过 `tests/helpers/browser-modules.mjs` 加载，无需改变项目模块配置或安装测试依赖。

## 更新国家目录

国家目录以 Unicode CLDR 固定版本为名称来源，以 ISO 3166-1 为代码范围。更新步骤：

1. 在 `scripts/update-countries.mjs` 更新 `CLDR_VERSION`。
2. 查阅该 CLDR 版本发布说明，确认国家名称或区域代码变化。
3. 运行 `npm run countries`。
4. 检查 `assets/catalogs/countries.json` 的生成差异，特别是新增、删除或更名的代码；生成文件不应写入个人内容目录 `data/`。
5. 运行 `npm test` 并在浏览器检查国家筛选。

## 清理原则

- 先确认入口引用，再删除文件。
- 不保留未被当前入口加载的“备用实现”。
- 删除文件后必须同步 README、专题文档和测试。
- 不为清理引入新依赖或构建步骤。

## 故障排查

页面空白：

- 检查浏览器控制台是否有模块加载失败。
- 确认 `index.html` 中 `js/app.js` 路径正确。
- 确认 `data/travel_data.json` 是合法 JSON 数组。
- 确认 `assets/catalogs/countries.json` 存在、是合法 JSON，且旅行记录的 `country_code` 能在目录中找到。

字体或背景缺失：

- 检查 `css/01-foundation.css` 或相关 CSS 分片中的 `../assets/...` 相对路径。
- 确认部署平台没有忽略大字体文件。

日记打不开：

- 检查该记录的 `desc_md` 是否存在。
- 检查 Markdown 文件名大小写是否与 JSON 完全一致。

照片不显示：

- 书脊头像缺失时，检查 `data/profile/profile-picture.png` 是否存在。
- 检查 `photo_folder` 和 `photos` 拼接后的路径是否存在。
- 检查图片文件名是否包含空格或大小写不一致。
