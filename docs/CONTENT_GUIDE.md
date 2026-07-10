# 内容维护指南

## 新增日记

1. 在 `data/travel-diary/` 新建 Markdown 文件。
2. 在 `data/travel_data.json` 添加一条记录。
3. 运行 `npm test`。
4. 启动 `npm start`，在浏览器检查首页、旅行路径和日记详情。

推荐文件名：

```text
YYYY-MM-DD-slug.md
```

示例：

```text
2026-07-11-suzhou.md
```

## 元数据字段

`data/travel_data.json` 是数组，每一项代表一篇旅行日记。

| 字段 | 类型 | 必需 | 说明 |
| --- | --- | --- | --- |
| `date` | string | 是 | 日期，格式为 `YYYY-MM-DD`。 |
| `country` | string | 是 | 国家或地区。 |
| `province` | string | 是 | 省份、直辖市、自治区或上级区域。 |
| `city` | string | 是 | 城市或具体目的地。 |
| `desc_md` | string | 是 | Markdown 正文路径，相对项目根目录。 |
| `photo_folder` | string | 否 | 照片目录，相对项目根目录。 |
| `photos` | string[] | 否 | 照片文件名列表，与 `photo_folder` 拼接成图片路径。 |

示例：

```json
{
  "date": "2026-07-11",
  "country": "中国",
  "province": "江苏省",
  "city": "苏州市",
  "desc_md": "data/travel-diary/2026-07-11-suzhou.md",
  "photo_folder": "data/photos/suzhou",
  "photos": ["canal.jpg", "garden.jpg"]
}
```

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
- 同一天多篇日记时，文件名 slug 必须不同。
- 运行 `npm test` 通过。
