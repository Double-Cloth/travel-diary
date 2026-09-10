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

点击头部的「＋」或首页「新增旅行记录」，填写日期、地点、标题和正文。在 `npm start` 打开的 localhost 页面中，「保存到项目文件」会真实更新 `data/travel_data.json` 并创建 Markdown 日记，断网也可保存，不需要安装依赖。

GitHub Pages 等静态页面不能写回仓库，会显示只读提示。可先「下载草稿」，再在本地页面「导入草稿」并保存；草稿下载不会新增站点记录。具体流程见 [内容维护指南](doc/CONTENT_GUIDE.md#在页面中新增推荐)。

## 资源维护

仅在正文字符或字体源文件发生变化时重新生成压缩字体：

```bash
npm run fonts
```

该维护命令需要预先安装 `fonttools`，安装过程可能需要联网：

```bash
pip install "fonttools[woff]"
```

`npm run countries` 会从固定版本的 Unicode CLDR 更新国家目录，同样属于需要联网的维护命令，不会在普通启动时执行。

## 文档

更多说明见 [项目文档](doc/README.md)。

复用为自己的旅行档案时，个人头像、旅行记录、日记和照片统一在 `data/` 中维护；通用国家目录位于 `assets/catalogs/countries.json`，字体和页面素材也保留在 `assets/`。具体步骤见 [内容维护指南](doc/CONTENT_GUIDE.md#换成自己的旅行档案)。
