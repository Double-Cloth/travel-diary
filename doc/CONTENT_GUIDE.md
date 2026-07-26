# 内容维护指南

## 新增日记

1. 在 `data/travel-diary/YYYY/` 新建 Markdown 文件。
2. 在 `data/travel_data.json` 添加一条记录。
3. 运行 `npm test`。
4. 启动 `npm start`，在浏览器检查首页、旅行路径和日记详情。

推荐文件名：

```text
data/travel-diary/YYYY/YYYY-MM-DD-slug.md
```

示例：

```text
data/travel-diary/2026/2026-07-11-suzhou.md
```

## 元数据字段

`data/travel_data.json` 是数组，每一项代表一篇旅行日记。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 是 | 日期，格式为 `YYYY-MM-DD`。 |
| `country` | string | 是 | 面向读者显示的国家或地区名称。 |
| `country_code` | string | 是 | ISO 3166-1 alpha-2 两位代码，用作稳定的国家标识，例如 `CN`、`US`、`JP`。 |
| `admin_area` | string | 否 | 一级行政区名称。可表示州、省、大区、都道府县、自治区等；城市国家或不需要该层级时可以省略。 |
| `admin_area_type` | string | 否 | 一级行政区类型覆盖值，例如 `州`、`省`、`都`。常见国家会自动提供界面标签，只在需要更精确说明时填写。 |
| `locality` | string | 是 | 实际目的地，不限于城市，也可以是村镇、岛屿、景区或其他地点。 |
| `locality_type` | string | 否 | 目的地类型，例如 `城市`、`岛屿`、`国家公园`。 |
| `desc_md` | string | 是 | Markdown 正文路径，相对项目根目录。 |
| `photo_folder` | string | 否 | 照片目录，相对项目根目录。 |
| `photos` | string[] | 否 | 照片文件名列表，与 `photo_folder` 拼接成图片路径。 |

示例：

```json
{
  "date": "2026-07-11",
  "country": "中国",
  "country_code": "CN",
  "admin_area": "江苏省",
  "locality": "苏州市",
  "desc_md": "data/travel-diary/2026/2026-07-11-suzhou.md",
  "photo_folder": "data/photos/suzhou",
  "photos": ["canal.jpg", "garden.jpg"]
}
```

## 不同国家和特殊地区

一级行政区统一写入 `admin_area`，界面会根据 `country_code` 使用适合该国家的名称。例如美国显示“州 / 特区”，日本显示“都道府县”，加拿大显示“省 / 地区”；未配置的国家回退为“一级行政区”。

美国州：

```json
{
  "country": "美国",
  "country_code": "US",
  "admin_area": "California",
  "admin_area_type": "州",
  "locality": "San Francisco"
}
```

日本都道府县：

```json
{
  "country": "日本",
  "country_code": "JP",
  "admin_area": "東京都",
  "locality": "東京"
}
```

城市国家可以省略 `admin_area`：

```json
{
  "country": "新加坡",
  "country_code": "SG",
  "locality": "新加坡"
}
```

系统仍能读取旧内容中的 `province` 和 `city`，旧版 `province/city` 路由也会自动转换；新增内容应统一使用新字段。

## 国家目录

`data/countries.json` 是应用使用的独立国家目录，当前包含 ISO 3166-1 的 249 个国家、属地及特殊地理区域。每一项包含：

- `code`：ISO alpha-2，两位代码。
- `alpha3`：ISO alpha-3，三位代码。
- `numeric`：ISO 三位数字代码。
- `name_zh`、`name_en`：Unicode CLDR 提供的简体中文和英文名称。
- `aliases`：常用简称或名称变体，可用于旧内容兼容和国家识别。
- `admin_area_label`、`admin_area_option`：一级行政区在界面中的称谓。
- `admin_area_optional`：该国家或区域是否通常可以省略一级行政区。

旅行记录中的 `country_code` 必须能在该目录中找到。常见行政体系会显示具体称谓，例如“州 / 特区”“省 / 地区”“都道府县”“酋长国”；未单独配置的国家统一回退为“一级行政区”，不会错误地假设为省。

国家目录由 `scripts/update-countries.mjs` 生成。需要同步 Unicode CLDR 数据时：

```bash
npm run countries
npm test
```

生成脚本固定 CLDR 版本，避免每次安装或启动时访问外部网络。不要直接在运行时代码中新增国家表。

## Markdown 写法

正文建议以一级标题开头：

```markdown
# 苏州一日

## 平江路

雨后的石板路很安静，沿河的茶馆开得很早。

- 适合步行
- 适合拍照
- 傍晚灯光更好
```

当前解析器支持：

- `#` 到 `######` 标题。
- `- ` 无序列表。
- 段落和换行。
- 行内链接、粗体、斜体、删除线、标记、上标、下标和行内代码。

当前解析器不支持表格、代码块、HTML 块和嵌套列表；需要这些能力时，应先扩展 `js/data.js` 并补充测试。

## 照片

如果没有照片，保持：

```json
"photo_folder": "data/photos/suzhou",
"photos": []
```

如果添加照片，建议创建：

```text
data/photos/suzhou/
├── canal.jpg
└── garden.jpg
```

然后在记录中写：

```json
"photos": ["canal.jpg", "garden.jpg"]
```

图片文件名使用小写英文、数字和连字符，避免空格与中文文件名，便于部署到静态托管平台。

## 内容检查

提交前检查：

- `desc_md` 指向的 Markdown 文件存在。
- `photos` 中每个文件都存在于 `photo_folder`。
- 日期格式为 `YYYY-MM-DD`。
- `country_code` 是有效的两位大写代码。
- `locality` 已填写；`admin_area` 是否填写应以当地行政层级为准，不要为了满足层级而重复国家名。
- 同一天多篇日记时，文件名 slug 必须不同。
- 运行 `npm test` 通过。
