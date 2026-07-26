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
