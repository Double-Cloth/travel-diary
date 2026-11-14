const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createHandler } = require('../js/server.js');
const { sourceForPreview } = require('../js/media-preview-store.js');

function collectMedia(records) {
    if (!Array.isArray(records)) throw new Error('旅行索引必须是数组。');
    const items = new Map();
    for (const record of records) {
        for (const type of ['photo', 'video']) {
            const folder = record[`${type}_folder`];
            if (!folder) continue;
            for (const name of record[`${type}s`] || []) {
                const source = `${folder}/${name}`;
                const preview = source.replace(/^data\/(photos|videos)\//, '/.cache/media-previews/$1/') + '.jpg';
                if (sourceForPreview(preview) !== source) throw new Error(`无效的媒体路径：${source}`);
                const encode = value => value.split('/').map(encodeURIComponent).join('/');
                items.set(source, { source: `/${encode(source)}`, preview: encode(preview), kind: type === 'video' ? 'video' : 'image' });
            }
        }
    }
    return [...items.values()];
}

async function findBrowser(explicit) {
    const candidates = explicit ? [explicit] : [
        ...[process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
            .filter(Boolean).flatMap(base => ['Microsoft/Edge/Application/msedge.exe', 'Google/Chrome/Application/chrome.exe'].map(file => path.join(base, file))),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ...(process.env.PATH || '').split(path.delimiter).flatMap(base => ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'].map(file => path.join(base, file)))
    ];
    for (const candidate of candidates) {
        try { if ((await fs.stat(candidate)).isFile()) return candidate; } catch { /* 继续查找本机已有浏览器。 */ }
    }
    throw new Error('未找到 Edge 或 Chrome。请通过 --browser 指定已有浏览器可执行文件路径。');
}

async function buildMediaPreviews(root, options = {}) {
    root = await fs.realpath(root);
    const encode = value => value.split('/').map(encodeURIComponent).join('/');
    const items = options.previews ? [...new Set(options.previews)].map(preview => {
        const source = sourceForPreview(preview);
        if (!source) throw new Error(`无效的媒体预览路径：${preview}`);
        return { source: `/${encode(source)}`, preview: encode(preview), kind: source.startsWith('data/videos/') ? 'video' : 'image' };
    }) : collectMedia(JSON.parse(await fs.readFile(path.join(root, 'data/travel_data.json'), 'utf8')));
    try {
        if (!options.previews && (await fs.stat(path.join(root, 'data/profile/profile-picture.png'))).isFile()) {
            items.push({ source: '/data/profile/profile-picture.png', preview: '/.cache/media-previews/profile/profile-picture.png.jpg', kind: 'image' });
        }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (options.skipMissing) {
        for (let index = items.length - 1; index >= 0; index--) {
            try { await fs.access(path.join(root, decodeURIComponent(items[index].source))); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                (options.log || console.log)(`跳过未随项目提供的原文件：${decodeURIComponent(items[index].source)}`);
                items.splice(index, 1);
            }
        }
    }
    const result = { generated: 0, cached: 0, failed: 0 };
    if (!items.length) return result;
    const browserPath = await findBrowser(options.browser || process.env.TRAVEL_BROWSER_PATH);
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'travel-preview-browser-'));
    const session = `/__media-preview-${randomBytes(16).toString('hex')}/`;
    // 生成任务使用原始缓存接口，避免内部请求再次触发后台生成。
    const handler = createHandler(root, { generateMediaPreviews: false });
    const log = options.log || console.log;
    let browser, timer, resolveDone, rejectDone, processed = 0;
    const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
    const heartbeat = () => {
        clearTimeout(timer);
        timer = setTimeout(() => rejectDone(new Error('浏览器超过 70 秒没有报告进度，已停止生成。')), 70000);
    };
    const server = http.createServer(async (req, res) => {
        try {
            if (req.url === session && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; img-src 'self'; media-src 'self'; connect-src 'self'; base-uri 'none'" });
                res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>生成媒体缩略图</title><script type="module" src="./batch.mjs"></script></html>');
            } else if (req.url === session + 'manifest' && req.method === 'GET') {
                res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(items));
            } else if ([session + 'batch.mjs', session + 'preview.mjs'].includes(req.url) && req.method === 'GET') {
                const file = req.url.endsWith('/batch.mjs') ? path.join(__dirname, 'media-preview-batch.mjs') : path.join(__dirname, '../js/media-preview.mjs');
                res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(await fs.readFile(file));
            } else if ([session + 'progress', session + 'error'].includes(req.url) && req.method === 'POST') {
                let body = '';
                for await (const chunk of req) {
                    body += chunk;
                    if (body.length > 16384) throw new Error('进度报告过大。');
                }
                if (req.url.endsWith('/error')) throw new Error(body);
                const report = JSON.parse(body);
                if (report.index !== processed || !Object.hasOwn(result, report.status)) throw new Error('生成进度无效。');
                result[report.status] += 1;
                processed += 1;
                log(`[${processed}/${items.length}] ${report.status === 'generated' ? '已生成' : report.status === 'cached' ? '缓存有效' : '失败'}：${decodeURIComponent(items[report.index].source)}${report.message ? `；${report.message}` : ''}`);
                res.writeHead(204); res.end();
                heartbeat();
                if (processed === items.length) resolveDone(result);
            } else if (/^\/(?:data\/(?:photos|videos|profile)\/|\.cache\/media-previews\/)/.test(req.url)) {
                await handler(req, res);
            } else { res.writeHead(404); res.end(); }
        } catch (error) {
            res.writeHead(500); res.end('生成任务失败。'); rejectDone(error);
        }
    });
    const cancel = () => rejectDone(new Error('已取消缩略图生成。'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        heartbeat();
        browser = spawn(browserPath, ['--headless', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
            `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}${session}`], { windowsHide: true, stdio: 'ignore' });
        browser.once('error', rejectDone);
        browser.once('exit', code => rejectDone(new Error(`浏览器提前退出（${code}）。`)));
        return await done;
    } finally {
        clearTimeout(timer);
        process.removeListener('SIGINT', cancel);
        process.removeListener('SIGTERM', cancel);
        if (browser && browser.exitCode === null && browser.pid) {
            await new Promise(resolve => { browser.once('exit', resolve); browser.kill(); });
        }
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        // 仅清理本命令在系统临时目录创建的独立浏览器配置，不接触用户配置。
        if (path.dirname(profile) === path.resolve(os.tmpdir()) && path.basename(profile).startsWith('travel-preview-browser-')) {
            await fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
        }
    }
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
        console.log('用法：npm run media:previews -- [--dir 项目目录] [--browser 浏览器路径] [--skip-missing]\n使用已有 Edge / Chrome 批量生成图片、视频和头像缩略图；有效缓存自动跳过。--skip-missing 仅跳过未随项目提供的原文件，解码或写入失败仍报错。');
        return;
    }
    const options = {};
    let root = path.resolve(__dirname, '..');
    while (args.length) {
        const arg = args.shift();
        if (arg === '--skip-missing') options.skipMissing = true;
        else if ((arg === '--dir' || arg === '--browser') && args.length && !args[0].startsWith('--')) {
            const value = args.shift();
            if (arg === '--dir') root = path.resolve(value); else options.browser = value;
        } else throw new Error(`未知参数或缺少参数值：${arg}`);
    }
    const result = await buildMediaPreviews(root, options);
    console.log(`缩略图生成完成：新生成 ${result.generated} 项，缓存有效 ${result.cached} 项，失败 ${result.failed} 项。`);
    if (result.failed) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { buildMediaPreviews, collectMedia, findBrowser };
