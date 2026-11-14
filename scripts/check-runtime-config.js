const fs = require('node:fs/promises');
const path = require('node:path');
const { parseArgs } = require('../js/server.js');
const { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, loadRuntimeConfig } = require('../js/runtime-config.js');
const { findBrowser } = require('./build-media-previews.js');

async function checkRuntimeConfig(argv = []) {
    const args = parseArgs(argv);
    const root = path.resolve(args.dir);
    if (!(await fs.stat(root)).isDirectory()) throw new Error(`项目目录无效：${root}`);
    const config = loadRuntimeConfig(root);
    const files = [];
    for (const name of [CONFIG_FILENAME, LOCAL_CONFIG_FILENAME]) {
        try {
            await fs.access(path.join(root, name));
            files.push(path.join(root, name));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    const selectedBrowser = process.env.TRAVEL_BROWSER_PATH || config.mediaPreviews.browserPath;
    let browserPath = '';
    let browserMessage = '';
    try {
        browserPath = await findBrowser(selectedBrowser);
    } catch (error) {
        if (selectedBrowser) throw error;
        browserMessage = '未自动找到 Edge / Chrome，可设置 mediaPreviews.browserPath。预览缺失时由页面生成并回传。';
    }
    return {
        root,
        configFiles: files,
        server: { ...config.server, port: args.port, local: args.local, writeMode: args.writeMode, allowedOrigins: args.allowedOrigins },
        mediaPreviews: config.mediaPreviews,
        browser: {
            source: process.env.TRAVEL_BROWSER_PATH ? 'TRAVEL_BROWSER_PATH' : config.mediaPreviews.browserPath ? 'mediaPreviews.browserPath' : '自动查找',
            resolvedPath: browserPath,
            message: browserMessage
        }
    };
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
        console.log('用法 npm run config:check -- [--dir 项目目录] [服务启动参数]\n检查共享和本机配置、显示最终生效值并查找浏览器。显式浏览器路径无效时退出码为 1。');
        return;
    }
    const result = await checkRuntimeConfig(argv);
    console.log('配置检查通过，最终生效值如下。');
    console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkRuntimeConfig };
