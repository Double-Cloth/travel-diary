# 项目文档

Travel Diary 是个人旅行手账：以行程、地点和 Markdown 日记组织内容，使用皮革封面、纸页和书签呈现。前端采用原生 HTML、CSS 和 JavaScript，无构建或安装依赖；通过随项目提供的 Node.js 服务浏览和保存记录、管理媒体、生成字体缓存和恢复备份。

## 文档索引

下表列出项目中的全部说明文档和 README。`data/travel-diary/` 下的 Markdown 是日记正文，属于个人内容，不在项目文档索引中。

| 文档 | 位置 | 内容 |
| --- | --- | --- |
| [项目文档](README.md)（本页） | `doc/README.md` | 文档总索引与阅读导航 |
| [根目录说明](../README.md) | `README.md` | 项目概览、全部依赖、启动与维护命令 |
| [内容维护指南](CONTENT_GUIDE.md) | `doc/CONTENT_GUIDE.md` | 日记、行程、媒体、草稿与数据管理 |
| [架构说明](ARCHITECTURE.md) | `doc/ARCHITECTURE.md` | 页面路由、模块职责、数据流与扩展约定 |
| [资产管理规范](ASSET_MANAGEMENT.md) | `doc/ASSET_MANAGEMENT.md` | 图片、字体、纹理、地点目录与资源维护 |
| [维护与部署指南](MAINTENANCE.md) | `doc/MAINTENANCE.md` | 运行环境、认证、部署、备份恢复与故障处理 |
| [本地字体构建工具](../assets/wasm/README.md) | `assets/wasm/README.md` | WASM 来源、许可证、更新与验证 |

个人内容放在 `data/`，通用资源放在 `assets/`，认证配置放在 `.secrets/`。日记和媒体通过服务读取；访问密码控制写入，不能限制日记阅读。离线使用需要本机服务器和完整本地资源，线上页面没有 Service Worker 离线缓存。
