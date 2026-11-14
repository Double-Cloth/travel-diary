const fs = require('node:fs');
const path = require('node:path');

// 从入口遍历实际使用的模块和样式，让公共模块在浏览器中只加载一个版本。
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const check = process.argv.includes('--check');
const visited = new Set();
const outdated = [];
// ByteSource 同时由 Node 文件流和浏览器共享，固定 URL 保证 instanceof 的类身份一致。
const canonicalModules = new Set([path.join(root, 'js/zip-stream.mjs')]);

function sync(file) {
    if (visited.has(file)) return;
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    const references = path.extname(file) === '.html'
        ? /(['"])((?:js|css)\/[^'"?]+\.(?:js|css))(?:\?[^'"]*)?\1/g
        : /(['"])(\.{1,2}\/[^'"?]+\.(?:m?js|css))(?:\?[^'"]*)?\1/g;
    const updated = source.replace(references, (_match, quote, relative) => {
        const dependency = path.resolve(path.dirname(file), relative);
        if (!dependency.startsWith(root + path.sep)) throw new Error(`资源路径超出项目目录：${relative}`);
        if (!dependency.startsWith(path.join(root, '.cache') + path.sep)) sync(dependency);
        return `${quote}${relative}${canonicalModules.has(dependency) ? '' : `?v=${version}`}${quote}`;
    });
    if (source === updated) return;
    outdated.push(path.relative(root, file));
    if (!check) fs.writeFileSync(file, updated);
}

sync(path.join(root, 'index.html'));
if (check && outdated.length) {
    console.error(`浏览器资源版本不一致，请运行 npm run assets:version：\n${outdated.join('\n')}`);
    process.exitCode = 1;
} else {
    console.log(`浏览器资源版本 ${version}：已${check ? '检查' : '同步'} ${visited.size} 个文件。`);
}
