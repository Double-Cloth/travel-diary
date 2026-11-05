# 本地字体构建工具

本目录随 Git 分发，仅供 Node.js 字体构建与测试使用。页面仍加载 `assets/fonts/` 内的 WOFF2，不在浏览器加载这些 WASM。构建不解析 npm 包、不访问 `node_modules`、不发起网络请求，也不启动外部命令。

## 固定来源

| 文件 | 来源与用途 | 许可证 |
| --- | --- | --- |
| `harfbuzz-subset.wasm` | [harfbuzzjs 1.6.4](https://github.com/harfbuzz/harfbuzzjs/tree/3f162fa2c6ba68b40839fe2c11502a26632e20df) 发布包的 `dist/harfbuzz-subset.wasm`，原样保存；HarfBuzz 子集化。 | `harfbuzzjs-LICENSE.txt`、`harfbuzz-COPYING.txt` |
| `woff2-compress.wasm`、`woff2-compress.cjs` | [wawoff2 2.0.1](https://github.com/fontello/wawoff2/tree/2ba75100c9ec6031a5a1d32ddd1120409aa68573) 发布包的 `build/compress_binding.js`；Google WOFF2 编码与 Brotli 压缩。 | `wawoff2-LICENSE.txt`、`brotli-LICENSE.txt`、`emscripten-LICENSE.txt` |
| `woff2-decompress.wasm`、`woff2-decompress.cjs` | 同一发布包的 `build/decompress_binding.js`；测试中解码 WOFF2，核对字符与全部字形轮廓。 | 同上 |

`sources.json` 保存上游提交、发布包 URL、包的 SHA-512 integrity，以及本地 WASM 和加载器的 SHA-256。下载时已核对发布包 integrity；测试再次核对本地文件哈希。HarfBuzz、WOFF2 和 Brotli 的底层提交也固定记录在该文件中。加载代码由 `scripts/font-tools.mjs` 提供，不引入第三方包的 CLI 或依赖。

## 加载器的唯一改动

wawoff2 原发布包将 WASM 以 Base64 嵌入 JS。本仓库将该段二进制解码后原样保存为独立 `.wasm`，并将原加载器保存为 `.cjs`（项目使用 CommonJS）。原始赋值：

```js
wasmBinaryFile="data:application/octet-stream;base64,..."
```

替换为以下赋值，其中 `KIND` 分别为 `compress` 和 `decompress`：

```js
wasmBinaryFile=__dirname+"/woff2-KIND.wasm";wasmBinary=require("node:fs").readFileSync(wasmBinaryFile)
```

其余生成代码保持上游原样。目录内 `.gitattributes` 固定加载器为 LF 换行，避免 Windows 检出时改变 SHA-256。显式提供 `wasmBinary` 保证 Emscripten 从本地字节初始化，不使用 Node.js 的 `fetch`。HarfBuzz 子集模块没有导入项，直接用内置 `WebAssembly.instantiate` 加载并调用 `_initialize`。

## 更新与验证

维护时可联网下载 `sources.json` 指定的固定版本发布包，先核对包的 SHA-512，再提取上述文件；更新版本时重新核对上游许可证与底层提交。对 wawoff2 使用 `/wasmBinaryFile="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/` 提取 Base64，以 `Buffer.from(match[1], 'base64')` 写出 WASM，并按上文替换加载器赋值。最后更新 SHA-256，提交二进制、加载器、来源与许可证。

```bash
node scripts/build-fonts.mjs
node --test tests/build-fonts.test.mjs
npm test
```

构建要求 Node.js 20+。`--core` 只刷新首屏字体及 CSS；`--subset` 将完整字体输出改为项目文字子集，新增未收录字符时仍须重新生成。默认构建保留完整字体回退。

## 本次迁移的体积与兼容性

以下为相同 TTF 源文件的完整字体大小，单位为 bytes：

| 字体 | 迁移前 | Node.js + WASM |
| --- | ---: | ---: |
| Cormorant SC Bold | 145,980 | 114,288 |
| LXGW WenKai Mono Regular | 9,836,260 | 8,066,900 |
| LXGW WenKai Mono Medium | 10,587,544 | 9,029,184 |
| Source Code Pro Regular | 55,268 | 46,976 |
| Source Code Pro Bold | 55,168 | 46,900 |
| 合计 | 20,680,220 | 17,304,248 |

完整字体减少约 16.32%。WOFF2 编码器启用标准的无损轮廓变换，字节不要求与旧构建相同；解码后逐项比较全部点坐标、复合轮廓、hinting、cmap、度量和排版表。`head` 的校验和与压缩标志、`loca` 的字节偏移会随编码更新，失效的 DSIG 签名由编码器移除。

两种首屏字体原为 366,844 / 365,968 bytes；子集引擎切换及当前界面文字更新后约为 368 / 368 KB，字符覆盖未减少。CSS 路径、400 / 700 字重、`font-display: block`、内容哈希与按 `unicode-range` 加载完整字体的策略保持原样。

隔离测试复制构建脚本、WASM 和小型真实字体到临时项目，确保没有 `node_modules`，以绝对 Node 路径启动、清空 PATH，并禁用网络 API 和子进程 API；分别验证默认、`--core`、`--subset`，同时检查非 BMP 字符、动态数字、目录排除、完整回退、哈希刷新、重复构建及非法参数。
