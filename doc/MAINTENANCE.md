# 维护与发布指南

## 常用命令

```bash
npm start
npm test
npm run countries
node js/server.js --port 8080 --network
```

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

`tests/analytics.test.mjs` 关注纯函数统计，适合新增筛选、统计和排序能力时扩展。

`tests/location.test.mjs` 关注多国行政区命名、稳定地点键、城市国家和旧字段兼容。调整地点模型或新增国家规则时应优先扩展这里。

`tests/countries.test.mjs` 验证 `data/countries.json` 保持 249 个 ISO 3166-1 当前代码、代码唯一性、多语言名称、行政区回退和数据来源信息。

## 更新国家目录

国家目录以 Unicode CLDR 固定版本为名称来源，以 ISO 3166-1 为代码范围。更新步骤：

1. 在 `scripts/update-countries.mjs` 更新 `CLDR_VERSION`。
2. 查阅该 CLDR 版本发布说明，确认国家名称或区域代码变化。
3. 运行 `npm run countries`。
4. 检查生成差异，特别是新增、删除或更名的代码。
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
- 确认 `data/countries.json` 存在、是合法 JSON，且旅行记录的 `country_code` 能在目录中找到。

字体或背景缺失：

- 检查 `css/01-foundation.css` 或相关 CSS 分片中的 `../assets/...` 相对路径。
- 确认部署平台没有忽略大字体文件。

日记打不开：

- 检查该记录的 `desc_md` 是否存在。
- 检查 Markdown 文件名大小写是否与 JSON 完全一致。

照片不显示：

- 检查 `photo_folder` 和 `photos` 拼接后的路径是否存在。
- 检查图片文件名是否包含空格或大小写不一致。
