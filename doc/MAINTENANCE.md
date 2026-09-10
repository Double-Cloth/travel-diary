# 维护与发布指南

## 常用命令

```bash
npm start
npm test
npm run fonts
npm run countries
node js/server.js --port 8080 --network
```

`npm start` 和 `npm test` 可以离线运行。`npm run fonts` 需要本机已有 `pyftsubset`；`npm run countries` 会访问固定版本的 Unicode CLDR。两者都是显式维护命令，不属于启动流程。

## 新增记录的验证与故障恢复

`tests/record-store.test.mjs` 在临时目录中验证真实写盘、重复请求、并发冲突重试、字段校验、跨源拒绝、路径链接拦截、索引损坏和替换失败回滚，不写入仓库内的旅行内容。

发布前额外检查桌面头部和窄屏首页入口、Tab / Escape 操作、关闭后草稿保留、本地保存后刷新，以及静态托管的只读提示与草稿下载 / 导入流程。使用临时副本验证新增，避免把测试日记发布到个人档案。

如果保存报错：

- 核对启动的是本项目的 `npm start`，且使用 localhost 地址；通用静态服务器和局域网其他设备不能写入。
- 查看 `data/travel_data.json` 是否为合法数组、`data/` 是否可写、磁盘空间是否充足；写入路径不能使用符号链接或 junction。
- 如果提示存在写入锁，先等正在进行的保存结束。服务器异常退出后，先停止所有本项目服务器并备份 `data/`，检查 `.travel-write.lock`、`.travel-write-*.tmp` 及对应 Markdown，再移除遗留锁并重启。不要在仍有写入任务时删除锁。
- 若有孤立 Markdown，先核对内容再按内容指南手工补充索引，或备份并移走孤立文件后重试原草稿；不要盲目覆盖正文。临时索引只有经人工核对后才可用于恢复。

`.travel-write.lock` 和临时文件均被 Git 忽略。成功保存到本地后仍需提交与推送内容文件才能发布；页面不会持有 GitHub 凭据或代替用户推送。

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

## 测试说明

`tests/data.test.mjs` 实际执行数据加载和 Markdown 解析，覆盖无效记录、照片附件过滤、响应中断重试、链接转义和行内代码保真。必需日期损坏时会明确指出记录序号；单篇正文加载失败不会阻塞其他记录，也不会被“有笔记”筛选误计。

`tests/app.test.mjs` 覆盖记录身份冲突、搜索路由取消、翻页动画中断、照片索引和观察节点清理。测试通过 `tests/helpers/browser-modules.mjs` 加载浏览器模块，不需要更改项目模块配置或安装依赖。

`tests/server.test.mjs` 通过真实 HTTP 请求覆盖畸形 URL、路径穿越、符号链接越界、目录跳转、HEAD 请求及端口参数。测试使用临时目录和动态端口，结束后自动清理。

`tests/analytics.test.mjs` 关注纯函数统计，适合新增筛选、统计和排序能力时扩展。

`tests/location.test.mjs` 关注多国行政区命名、稳定地点键、城市国家和旧字段兼容。调整地点模型或新增国家规则时应优先扩展这里。

`tests/countries.test.mjs` 验证 `assets/catalogs/countries.json` 保持 249 个 ISO 3166-1 当前代码、代码唯一性、多语言名称、行政区回退和数据来源信息。

`tests/offline.test.mjs` 验证启动脚本不会执行下载或资产生成命令，HTML/CSS 引用均指向实际存在的本地资源，压缩字体随项目分发，运行时数据请求不会指向远程地址。

## 更新国家目录

国家目录以 Unicode CLDR 固定版本为名称来源，以 ISO 3166-1 为代码范围。更新步骤：

1. 在 `scripts/update-countries.mjs` 更新 `CLDR_VERSION`。
2. 查阅该 CLDR 版本发布说明，确认国家名称或区域代码变化。
3. 运行 `npm run countries`。
4. 检查 `assets/catalogs/countries.json` 的生成差异，特别是新增、删除或更名的代码；生成文件不应写入个人内容目录 `data/`。
5. 运行 `npm test` 并在浏览器检查国家筛选。

`tests/shell.test.mjs` 关注运行时外壳约束，例如：

- 页面不重新引入已删除的重复入口。
- 关键控件和样式类存在。
- `css/journal.css` 只作为样式入口并导入分层 CSS。
- 字体只使用项目本地字体。
- 开发服务器为 `.js` 和 `.mjs` 返回正确 MIME 类型。

## 清理原则

- 先确认入口引用，再删除文件。
- 不保留未被当前入口加载的“备用实现”。
- 历史计划保留在 `doc/superpowers/`，但不能作为当前结构依据。
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
