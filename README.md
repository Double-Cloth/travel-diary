# Travel Diary · 旅行档案

一个记录旅途、城市与回忆的个人旅行日记。

## 启动

```bash
npm start
```

只要本机已有 Node.js，即可在断网状态下启动，不需要先安装项目依赖。默认启动后打开 [http://localhost:9000](http://localhost:9000)。

页面使用的字体、图片、国家目录和旅行数据均保存在仓库内；`npm start` 不会下载资源或运行在线更新命令。

如要指定端口：

```bash
node js/server.js --port 8080
```

## 在页面中新增旅行记录

点击头部「＋」或旅行路径页「新增旅行记录」，编辑行程、地点、正文和照片配置。编辑器会根据当前国家、行政区、目的地和已有记录提供关联候选，并自动补全可可靠推断的空白地点字段；所有补全内容仍可修改。正文提供带 Markdown 语法高亮的源码与可编辑预览。旅行标识、自动正文路径、照片目录和新上传照片文件名统一生成小写拼音。照片可不限数量和文件大小地多选或拖放上传。在本机 `npm start` 打开的 localhost 页面中保存，将更新 `data/travel_data.json` 并创建 Markdown 日记，离线可用。

GitHub Pages 等静态页面不能写回仓库，会显示只读提示。可通过「导出草稿」下载 ZIP：`draft.json` 保存字段，上传图片作为独立文件存放，不会以内嵌 Base64 写入 JSON；之后可在本机「导入草稿」并保存。个人主页的「数据备份」还可以导出或导入整个 `data/` 目录。功能说明、字段定义和环境限制见 [内容维护指南](doc/CONTENT_GUIDE.md#页面编辑器)。

## 资源维护

默认将字体源文件完整压缩为 WOFF2：

```bash
npm run fonts
```

仅在明确需要按当前项目文字缩减字体体积时使用：

```bash
npm run fonts:subset
```

该维护命令需要预先安装 `fonttools`，安装过程可能需要联网：

```bash
pip install "fonttools[woff]"
```

`npm run countries` 会从固定版本的 Unicode CLDR 更新国家目录，同样属于需要联网的维护命令，不会在普通启动时执行。

## 文档

更多说明见 [项目文档](doc/README.md)。

复用为自己的旅行档案时，个人头像、旅行记录、日记和照片统一在 `data/` 中维护；通用国家目录位于 `assets/catalogs/countries.json`，字体和页面素材也保留在 `assets/`。具体步骤见 [内容维护指南](doc/CONTENT_GUIDE.md#换成自己的旅行档案)。
